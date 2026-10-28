import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { storageConfig } from "@/config/storage.config";
import { adaptVideoClonePrompts } from "@/lib/ai/adapt-video-clone-prompts";
import { describeVideo } from "@/lib/ai/describe-video";
import { createKieTask, kieCallbackResultUrl } from "@/lib/ai/kie";
import {
  createRevanaGeneration,
  downloadRevanaVideo,
  getRevanaGeneration,
} from "@/lib/ai/revana";
import { createSumeVideoJob, sumeWebhookVideoUrl } from "@/lib/ai/sume";
import { getVideoProvider } from "@/lib/ai/video-provider";
import {
  buildVideoCloneInput,
  continuityFrames,
  DEFAULT_VIDEO_CLONE_MODEL,
  generateVideoCloneInputSchema,
  isAddedPart,
  keepsOriginal,
  numberVideoCloneProducts,
  renderPartSpans,
  round,
  sharesContinuity,
  VIDEO_CLONE_MODELS,
  type VideoClone,
  type VideoCloneGeneration,
  type VideoCloneModel,
  type VideoClonePart,
  type VideoProvider,
  videoClonePartPrompt,
} from "@/lib/content-workflows/video-clone";
import {
  clearVideoClonePartGenerations,
  findAssetImages,
  findFaces,
  findProductImages,
  setVideoCloneEdit,
  setVideoCloneGeneration,
  setVideoClonePartGeneration,
  startVideoCloneStitch,
} from "@/lib/content-workflows/video-clone-store";
import { db } from "@/lib/db";
import { contentTemplateTable } from "@/lib/db/schema";
import { logger, schemaTask, type WaitToken, wait } from "@/lib/jobs";
import {
  getObject,
  parseStorageObjectFromUrl,
  putObject,
  resolveStorageDownloadUrl,
} from "@/lib/storage";
import { downloadVideo } from "@/lib/storage/download-video";
import { getErrorMessage } from "@/lib/utils";
import {
  FFMPEG,
  FFPROBE,
  findSceneCuts,
  RENDER_CUT_SCORE,
  run,
} from "./run-command";
import { triggerTaskIds } from "./shared";

// The provider fetches the reference images itself, possibly after queueing a while.
const REFERENCE_URL_SECONDS = 24 * 60 * 60;
// Revana lets a route that's already running finish for up to 40 minutes.
const REVANA_TIMEOUT_MS = 45 * 60 * 1000;

/** Signed image URLs from the cast's faces and portraits, product folder, pins, and picked frames. */
type TakeReferences = {
  /** Character id → the face or portrait that plays them. */
  cast: Map<string, string>;
  products: { name: string; url: string }[];
  /** Take index → the numbers (`{{productN}}`) of the products pinned on it. */
  pinned: Map<number, number[]>;
  /** The frames the user picked off the timeline. */
  frames: string[];
};

/**
 * Renders the selected takes of a clone plan on the organization's video provider, each with its take's model, or one part of
 * one take alone (`shot`) to fit back into that take's render. A render references frames of the
 * renders it shares a look, set, or prop with.
 */
export const generateVideoCloneTask = schemaTask({
  id: triggerTaskIds.generateVideoClone,
  schema: generateVideoCloneInputSchema,
  // Renders are paid and never retried; a failed take is retried with its Regenerate button instead.
  run: async (payload) => {
    const template = await db.query.contentTemplateTable.findFirst({
      where: and(
        eq(contentTemplateTable.id, payload.templateId),
        eq(contentTemplateTable.organizationId, payload.organizationId),
      ),
      columns: { id: true, structure: true },
    });
    const plan = template?.structure.video;
    if (!template || !plan) throw new Error("Clone plan not found.");
    const selected = plan.takes.flatMap((take, position) =>
      payload.takeIndexes.includes(take.index) ? [{ take, position }] : [],
    );
    // The redone part's position in its take (the one selected take).
    const redo =
      payload.shot === undefined
        ? undefined
        : selected[0]?.take.parts.findIndex(
            (part) => part.shot === payload.shot,
          );
    if (redo === -1) throw new Error("Unknown shot.");
    const creatorId = plan.vibe.characters.find(
      (character) => character.reference === "creator",
    )?.id;
    const base = {
      cast: payload.cast,
      changes: payload.changes,
      productFolder: payload.productFolder,
      startedAt: payload.startedAt,
    };
    const save = (position: number, generation: VideoCloneGeneration) =>
      redo === undefined
        ? setVideoCloneGeneration(template.id, position, generation)
        : setVideoClonePartGeneration(template.id, position, redo, generation);
    const fail = (position: number, error: unknown, prompt = "") =>
      save(position, {
        ...base,
        status: "failed",
        prompt,
        error: getErrorMessage(error) || "Generation failed.",
      });

    let references: TakeReferences;
    let prompts: Map<number, string>;
    let video: { provider: VideoProvider; apiKey: string };
    try {
      video = await getVideoProvider();
      references = await loadReferences(
        payload,
        selected.map(({ take }) => take),
      );
      // The plan's prompts already write the creator as a token; anyone else recast needs Opus.
      const recast = Object.keys(payload.cast).some((id) => id !== creatorId);
      prompts =
        payload.changes || references.products.length > 0 || recast
          ? await adaptVideoClonePrompts({
              plan,
              takeIndexes: selected.map(({ take }) => take.index),
              changes: payload.changes,
              cast: references.cast,
              products: references.products,
              pinned: references.pinned,
            })
          : new Map();
    } catch (error) {
      await Promise.all(selected.map(({ position }) => fail(position, error)));
      throw error;
    }

    // Renders a take can match for continuity: this run's, and other takes' made with the same
    // changes and cast (a render with another face or look would pull this one off). A redone
    // part matches its own take's render, whatever it was made with.
    const renders = new Map(
      plan.takes.flatMap((take) => {
        const { generation } = take;
        const cast = generation?.cast ?? {};
        const selectedTake = payload.takeIndexes.includes(take.index);
        return !keepsOriginal(take) &&
          generation?.status === "done" &&
          generation.videoUrl &&
          (selectedTake
            ? redo !== undefined
            : generation.changes === payload.changes &&
              Object.keys(cast).length === Object.keys(payload.cast).length &&
              Object.entries(payload.cast).every(
                ([id, account]) => cast[id] === account,
              ))
          ? [[take.index, generation.videoUrl] as const]
          : [];
      }),
    );
    // Takes rendered in this run: their earlier part renders are gone.
    const fresh = new Set<number>();
    const prefix = `video-clones/${payload.organizationId}/frames/${template.id}`;

    // Rounds: a take that shares a look, set, or prop with an earlier selected take waits for
    // its render, so it can reference a frame of it. The rest of a round renders in parallel.
    let pending = selected;
    let started = 0;
    while (pending.length > 0) {
      const ready = pending.filter(
        ({ take }) =>
          !pending.some(
            ({ take: other }) =>
              other.index < take.index &&
              sharesContinuity(take, other, plan.continuity),
          ),
      );
      pending = pending.filter((item) => !ready.includes(item));
      const jobs: {
        position: number;
        index: number;
        model: VideoCloneModel;
        prompt: string;
        render: Render;
      }[] = [];
      for (const { take, position } of ready) {
        const model = take.model ?? DEFAULT_VIDEO_CLONE_MODEL;
        let prompt = prompts.get(take.index) ?? take.analysis.prompt;
        try {
          const part = redo === undefined ? undefined : take.parts[redo];
          const seconds = part
            ? Math.round((part.takeEnd - part.takeStart) * 100) / 100
            : take.seconds;
          if (part && redo !== undefined) {
            const alone = videoClonePartPrompt(prompt, redo, seconds);
            if (!alone) {
              throw new Error(
                `Take ${take.index}'s prompt has no 'Part N' labels to find shot ${part.shot} in; render the whole take.`,
              );
            }
            prompt = alone;
          }
          // The redone part's own take comes first, so the part matches the shots around it.
          const sources = plan.takes
            .filter(
              (other) =>
                renders.has(other.index) &&
                (other.index !== take.index || part),
            )
            .sort(
              (a, b) =>
                Number(b.index === take.index) -
                  Number(a.index === take.index) || a.index - b.index,
            )
            .map((other) =>
              other.index === take.index
                ? {
                    ...other,
                    parts: other.parts.filter((item) => item !== part),
                  }
                : other,
            );
          const frames = continuityFrames(
            part ? [part] : take.parts,
            sources,
            // Plans analyzed before continuity was tracked: a redone part still matches its take.
            plan.continuity ??
              (part
                ? [
                    {
                      label: "the people's looks and the place",
                      shots: take.parts.map((item) => item.shot),
                    },
                  ]
                : []),
          );
          // The user's picked frames come first, then the earlier renders this one must match.
          const matches = [
            ...references.frames.map(
              (_, k) =>
                `{{frame${k + 1}}} is a frame from this video; its people (faces, hair, clothes), the place, and the light must look exactly as there.`,
            ),
            ...frames.map(
              (frame, k) =>
                `{{frame${references.frames.length + k + 1}}} is a frame from another shot of this video; ${frame.labels.join(", ")} must look exactly as there.`,
            ),
          ];
          if (matches.length > 0) {
            prompt = `${prompt}\n\nContinuity: ${matches.join(" ")}`;
          }
          const input = buildVideoCloneInput(
            { seconds, analysis: take.analysis },
            prompt,
            {
              creator: creatorId ? references.cast.get(creatorId) : undefined,
              cast: references.cast,
              products: references.products.map((product) => product.url),
              frames: [
                ...references.frames,
                ...(await Promise.all(
                  frames.map((frame) => {
                    const source = plan.takes.find(
                      (other) => other.index === frame.take,
                    );
                    const k =
                      source?.parts.findIndex(
                        (item) => item.shot === frame.shot,
                      ) ?? -1;
                    const own = source?.parts[k];
                    // A part redone alone plays its own render in the edit, unless its take was
                    // rendered again in this run.
                    return source &&
                      own?.generation?.status === "done" &&
                      own.generation.videoUrl &&
                      !fresh.has(source.index)
                      ? grabFrame(own.generation.videoUrl, prefix, {
                          seconds: own.takeEnd - own.takeStart,
                        })
                      : grabFrame(renders.get(frame.take) as string, prefix, {
                          parts: source?.parts ?? [],
                          position: k,
                        });
                  }),
                )),
              ],
              characters: plan.vibe.characters,
              product: plan.vibe.product,
            },
            model,
            video.provider,
          );
          prompt = input.prompt;
          const render = await startRender(video, model, input);
          await save(position, {
            ...base,
            model,
            status: "generating",
            prompt,
          });
          jobs.push({ position, index: take.index, model, prompt, render });
        } catch (error) {
          await fail(position, error, prompt);
        }
      }
      // The edit gets re-stitched once these land; the page keeps polling until it does.
      if (jobs.length > 0 && started === 0) {
        await setVideoCloneEdit(template.id, {
          videoUrl: plan.edit?.videoUrl,
          textVideoUrl: plan.edit?.textVideoUrl,
          rendered: plan.edit?.rendered ?? [],
          parts: plan.edit?.parts,
          startedAt: new Date().toISOString(),
          status: "stitching",
        });
      }
      started += jobs.length;

      // Waiting in order only delays bookkeeping; the run is suspended meanwhile.
      for (const job of jobs) {
        try {
          const { bytes } = await finishRender(video, job.render);
          // Providers delete results (KIE after 14 days); keep our own copy.
          const bucket = storageConfig.bucketNames.images;
          const name = `take-${String(job.index).padStart(2, "0")}${payload.shot === undefined ? "" : `-shot-${payload.shot}`}`;
          const path = `video-clones/${payload.organizationId}/generations/${template.id}/${name}-${crypto.randomUUID()}.mp4`;
          await putObject(path, bucket, bytes, "video/mp4");
          const videoUrl = `/storage/${bucket}/${path}`;
          const take = plan.takes[job.position];
          const mismatches =
            take &&
            (await checkRender(take, redo, bytes, payload.changes).catch(
              (error) => {
                logger.warn(`Couldn't check take ${job.index}'s render`, {
                  error: getErrorMessage(error),
                });
                return undefined;
              },
            ));
          await save(job.position, {
            ...base,
            model: job.model,
            status: "done",
            prompt: job.prompt,
            videoUrl,
            ...(mismatches ? { mismatches } : {}),
          });
          if (redo === undefined) {
            // Shots redone alone matched the take's previous render; this one replaces them.
            await clearVideoClonePartGenerations(
              template.id,
              job.position,
              plan.takes[job.position]?.parts.length ?? 0,
            );
            fresh.add(job.index);
            renders.set(job.index, videoUrl);
          }
        } catch (error) {
          await fail(job.position, error, job.prompt);
        }
      }
    }
    if (started > 0) {
      await startVideoCloneStitch(
        payload.organizationId,
        template.id,
        plan.edit,
      );
    }
    return { started, requested: selected.length };
  },
});

type Render = { token: WaitToken } | { id: string };

/** Starts one render on the organization's provider. */
async function startRender(
  video: { provider: VideoProvider; apiKey: string },
  model: VideoCloneModel,
  input: Record<string, unknown>,
): Promise<Render> {
  if (video.provider === "revana") {
    const id = await createRevanaGeneration(
      { model: VIDEO_CLONE_MODELS[model].revanaId, input },
      video.apiKey,
    );
    return { id };
  }
  const token = wait.createToken({ timeoutSeconds: 30 * 60 });
  if (video.provider === "sume") {
    await createSumeVideoJob(
      {
        model: VIDEO_CLONE_MODELS[model].sumeId,
        input,
        webhookUrl: token.url,
      },
      video.apiKey,
    );
  } else {
    await createKieTask({ model, input, callBackUrl: token.url }, video.apiKey);
  }
  return { token };
}

/**
 * Waits for a render and downloads it. KIE and Sume POST to the token's URL (app/api/waitpoints);
 * Revana has no callback, so it's polled.
 */
async function finishRender(
  video: { provider: VideoProvider; apiKey: string },
  render: Render,
) {
  if ("token" in render) {
    const result = await wait.forToken<unknown>(render.token);
    if (!result.ok) {
      throw new Error("The render didn't finish within 30 minutes.");
    }
    return downloadVideo(
      video.provider === "sume"
        ? sumeWebhookVideoUrl(result.output)
        : kieCallbackResultUrl(result.output),
      "Rendered take",
    );
  }
  const deadline = Date.now() + REVANA_TIMEOUT_MS;
  for (;;) {
    const generation = await getRevanaGeneration(render.id, video.apiKey);
    if (generation?.status === "succeeded") {
      return downloadRevanaVideo(render.id, video.apiKey);
    }
    if (generation?.status === "failed") {
      throw new Error(
        generation.error?.message || "Revana couldn't render this take.",
      );
    }
    if (Date.now() > deadline) {
      throw new Error("The render didn't finish within 45 minutes.");
    }
    await wait.for({ seconds: 20 });
  }
}

/**
 * A JPEG from the middle of one part of a stored render, stored under `prefix`, as a URL Revana
 * can fetch. In a take's render the part is found through the render's own cuts; a part's own
 * render is all that part.
 */
async function grabFrame(
  videoUrl: string,
  prefix: string,
  part: { parts: VideoClonePart[]; position: number } | { seconds: number },
) {
  const stored = parseStorageObjectFromUrl(videoUrl);
  if (!stored) throw new Error(`${videoUrl} isn't in our storage.`);
  const dir = await mkdtemp(join(tmpdir(), "clone-frame-"));
  try {
    const video = join(dir, "render.mp4");
    const image = join(dir, "frame.jpg");
    await writeFile(video, await getObject(stored.path, stored.bucket));
    let at = 0;
    if ("seconds" in part) {
      at = part.seconds / 2;
    } else {
      // The last part plays to the render's end; an infinite end would seek ffmpeg to "Infinity".
      const { stdout } = await run(FFPROBE, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        video,
      ]);
      const span = renderPartSpans(part.parts, {
        cuts: await findSceneCuts(video, RENDER_CUT_SCORE),
        duration: Number(stdout),
      })[part.position];
      at = span ? (span.start + span.end) / 2 : 0;
    }
    await run(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(at),
      "-i",
      video,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      image,
    ]);
    const bucket = storageConfig.bucketNames.images;
    const path = `${prefix}/${crypto.randomUUID()}.jpg`;
    await putObject(path, bucket, await readFile(image), "image/jpeg");
    return resolveStorageDownloadUrl(
      `/storage/${bucket}/${path}`,
      REFERENCE_URL_SECONDS,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Gemini watches the original take (or the redone part) and its render, and returns the parts
 * the render stages differently: another action, camera side, or listener. Recast people, our
 * product, the look, and the requested changes don't count. Undefined for a take changes added:
 * it has no original.
 */
async function checkRender(
  take: VideoClone["takes"][number],
  redo: number | undefined,
  render: Uint8Array,
  changes: string,
): Promise<VideoCloneGeneration["mismatches"]> {
  const stored = take.videoUrl && parseStorageObjectFromUrl(take.videoUrl);
  if (!stored) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "clone-check-"));
  try {
    const original = join(dir, "original.mp4");
    const rendered = join(dir, "render.mp4");
    await writeFile(original, await getObject(stored.path, stored.bucket));
    await writeFile(rendered, render);
    const { stdout } = await run(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      rendered,
    ]);
    const duration = Number(stdout);
    // The take's clip of the original is its parts back to back, at their source lengths.
    let at = 0;
    const source = take.parts.map((part) => {
      const start = at;
      at += Math.max(0, part.srcEnd - part.srcStart);
      return { start: round(start), end: round(at) };
    });
    const ours =
      redo === undefined
        ? renderPartSpans(take.parts, {
            cuts: await findSceneCuts(rendered, RENDER_CUT_SCORE),
            duration,
          })
        : [];
    const checked = (redo === undefined ? take.parts.map((_, k) => k) : [redo])
      .filter((k) => !isAddedPart(take.parts[k] as VideoClonePart))
      .map((k) => {
        const span = source[k] as { start: number; end: number };
        // A redone part is its own render, and its piece of the original from 0.
        return redo === undefined
          ? { k, original: span, ours: ours[k] }
          : {
              k,
              original: { start: 0, end: round(span.end - span.start) },
              ours: { start: 0, end: round(duration) },
            };
      });
    if (checked.length === 0) return undefined;
    // 360p keeps both files well under Gemini's inline cap.
    const small = async (
      file: string,
      trim?: { start: number; end: number },
    ) => {
      const out = `${file}.360.mp4`;
      await run(FFMPEG, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...(trim
          ? ["-ss", String(trim.start), "-t", String(trim.end - trim.start)]
          : []),
        "-i",
        file,
        "-vf",
        "scale=-2:360",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "32",
        "-c:a",
        "aac",
        "-b:a",
        "48k",
        "-ac",
        "1",
        out,
      ]);
      return out;
    };
    const files = [
      await small(original, redo === undefined ? undefined : source[redo]),
      await small(rendered),
    ];
    const { parts } = await describeVideo({
      file: files,
      schema: z.object({
        parts: z.array(
          z.object({
            part: z.number().int(),
            matches: z.boolean(),
            issue: z.string(),
          }),
        ),
      }),
      prompt: `The first video is the original; the second is our AI re-creation of it, which should stage every part the same way. Part N of one is part N of the other:
${checked.map((item, n) => `Part ${n + 1}: original ${item.original.start}-${item.original.end}s, ours ${item.ours?.start ?? "?"}-${item.ours?.end ?? "?"}s`).join("\n")}

Expected differences, never mismatches: other faces and people (we recast them), outfits, our product in place of theirs, the look (color, grain, lighting), small timing and pacing shifts, on-screen text${changes ? `, and whatever these requested changes ask for: "${changes}"` : ""}.
For each part, matches=false only when ours stages the moment differently in a way a viewer would notice: another action, who is in frame or where they are, where the camera stands and which way it faces, who a line is said to and how (face to face, off-screen, on a phone), or a prop the moment needs. issue: one short sentence on what the original does that ours doesn't, e.g. "He hands her the keys face to face; ours has him toss them across the room."; empty when it matches.`,
    });
    return parts.flatMap((verdict) => {
      const k = checked[verdict.part - 1]?.k;
      const part = k === undefined ? undefined : take.parts[k];
      return !verdict.matches && part
        ? [{ shot: part.shot, issue: verdict.issue.trim() }]
        : [];
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The cast's faces, the frames the user picked, and the folder's and
 * the takes' pinned product images.
 */
async function loadReferences(
  payload: {
    organizationId: string;
    cast: Record<string, string>;
    productFolder: string | null;
    frames: string[];
  },
  takes: { index: number; products?: string[] }[],
): Promise<TakeReferences> {
  const found = payload.productFolder
    ? await findProductImages(payload.organizationId, payload.productFolder)
    : { images: [] };
  if ("error" in found) throw new Error(found.error);
  const pins = await findAssetImages(payload.organizationId, [
    ...new Set(takes.flatMap((take) => take.products ?? [])),
  ]);
  const numbered = numberVideoCloneProducts(found.images, pins, takes);
  const { pinned } = numbered;
  const products = await Promise.all(
    numbered.products.map(async ({ name, url }) => ({
      name,
      url: await resolveStorageDownloadUrl(url, REFERENCE_URL_SECONDS),
    })),
  );
  const faceIds = [...new Set(Object.values(payload.cast))];
  const faces = await findFaces(payload.organizationId, faceIds);
  if (faces.length !== faceIds.length) {
    throw new Error("Face not found.");
  }
  // One signed URL per face, so a face playing two characters stays one reference image.
  const signed = new Map(
    await Promise.all(
      faces.map(({ id, imageUrl }) =>
        resolveStorageDownloadUrl(imageUrl, REFERENCE_URL_SECONDS).then(
          (url) => [id, url] as const,
        ),
      ),
    ),
  );
  const cast = new Map(
    Object.entries(payload.cast).flatMap(([characterId, faceId]) => {
      const url = signed.get(faceId);
      return url ? [[characterId, url] as const] : [];
    }),
  );
  return {
    cast,
    products,
    pinned,
    frames: await Promise.all(
      payload.frames.map((url) =>
        resolveStorageDownloadUrl(url, REFERENCE_URL_SECONDS),
      ),
    ),
  };
}
