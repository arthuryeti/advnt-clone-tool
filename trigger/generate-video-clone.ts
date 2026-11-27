import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { storageConfig } from "@/config/storage.config";
import { adaptVideoClonePrompts } from "@/lib/ai/adapt-video-clone-prompts";
import { ProviderError } from "@/lib/ai/errors";
import {
  resolveActiveVideoProvider,
  resolveModelForProvider,
} from "@/lib/ai/video-provider";
import {
  continuityFrames,
  generateVideoCloneInputSchema,
  keepsOriginal,
  numberVideoCloneProducts,
  renderPartSpans,
  sharesContinuity,
  type TakePromptReferences,
  type VideoCloneGeneration,
  type VideoClonePart,
  videoClonePartPrompt,
} from "@/lib/content-workflows/video-clone";
import {
  findAssetImages,
  findFaces,
  findProductImages,
  resolvePublicStorageReferenceUrl,
  setVideoCloneGenerationByIndex,
  setVideoClonePartGenerationByShot,
} from "@/lib/content-workflows/video-clone-store";
import { db } from "@/lib/db";
import { contentTemplateTable, renderAttemptTable } from "@/lib/db/schema";
import {
  createWaitpoint,
  getCurrentJobId,
  getWorkerId,
  schemaTask,
  waitForAttemptSignal,
} from "@/lib/jobs";
import {
  failRenderAttempt,
  reconcileRenderAttempt,
} from "@/lib/render-reconciler";
import { getObject, parseStorageObjectFromUrl, putObject } from "@/lib/storage";
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

/** Signed image URLs from the cast's faces and portraits, product folder, pins, and picked frames. */
type TakeReferences = {
  /** Character id -> the face or portrait that plays them. */
  cast: Map<string, string>;
  products: { name: string; url: string }[];
  /** Take index -> the numbers (`{{productN}}`) of the products pinned on it. */
  pinned: Map<number, number[]>;
  /** The frames the user picked off the timeline. */
  frames: string[];
};

/**
 * Renders the selected takes of a clone plan on the active video provider, each with its take's
 * model, or one part of one take alone (`shot`) to fit back into that take's render.
 * Durable across restarts: existing `render_attempts` for this job are reconciled without
 * re-submitting billable provider calls.
 */
export const generateVideoCloneTask = schemaTask({
  id: triggerTaskIds.generateVideoClone,
  schema: generateVideoCloneInputSchema,
  run: async (payload) => {
    const jobId = getCurrentJobId();
    if (!jobId) {
      throw new Error(
        "generateVideoCloneTask must run inside a background job.",
      );
    }

    const template = await db.query.contentTemplateTable.findFirst({
      where: and(
        eq(contentTemplateTable.id, payload.templateId),
        eq(contentTemplateTable.organizationId, payload.organizationId),
      ),
      columns: { id: true, structure: true },
    });
    const plan = template?.structure.video;
    if (!template || !plan) throw new Error("Clone plan not found.");

    const selected = plan.takes.flatMap((take) =>
      payload.takeIndexes.includes(take.index) ? [take] : [],
    );
    const redo =
      payload.shot === undefined
        ? undefined
        : selected[0]?.parts.findIndex((part) => part.shot === payload.shot);
    if (redo === -1) throw new Error("Unknown shot.");
    const targetShot = payload.shot ?? -1;

    const creatorId = plan.vibe.characters.find(
      (character) => character.reference === "creator",
    )?.id;
    const base = {
      cast: payload.cast,
      changes: payload.changes,
      productFolder: payload.productFolder,
      startedAt: payload.startedAt,
    };

    const failTake = (takeIndex: number, error: unknown, prompt = "") => {
      const generation: VideoCloneGeneration = {
        ...base,
        status: "failed",
        prompt,
        error: getErrorMessage(error) || "Generation failed.",
      };
      return payload.shot === undefined
        ? setVideoCloneGenerationByIndex(template.id, takeIndex, generation)
        : setVideoClonePartGenerationByShot(
            template.id,
            takeIndex,
            payload.shot,
            generation,
          );
    };

    const existingAttempts = await db
      .select()
      .from(renderAttemptTable)
      .where(eq(renderAttemptTable.jobId, jobId));

    let providerCtx: ReturnType<typeof resolveActiveVideoProvider>;
    let references: TakeReferences;
    let prompts: Map<number, string>;
    try {
      providerCtx = resolveActiveVideoProvider();
      references = await loadReferences(payload, selected);
      const recast = Object.keys(payload.cast).some((id) => id !== creatorId);
      const needsPrompts = selected.some(
        (take) =>
          !existingAttempts.some(
            (attempt) =>
              attempt.takeIndex === take.index && attempt.shot === targetShot,
          ),
      );
      prompts =
        needsPrompts &&
        (payload.changes || references.products.length > 0 || recast)
          ? await adaptVideoClonePrompts({
              plan,
              takeIndexes: selected.map((take) => take.index),
              changes: payload.changes,
              cast: references.cast,
              products: references.products,
              pinned: references.pinned,
            })
          : new Map();
    } catch (error) {
      await Promise.all(selected.map((take) => failTake(take.index, error)));
      throw error;
    }

    const { provider, ctx } = providerCtx;

    // Seed renders map from already-done takes (including attempts completed prior to restart).
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

    const fresh = new Set<number>();
    const prefix = `video-clones/${payload.organizationId}/frames/${template.id}`;
    let pending = selected;
    let started = 0;

    while (pending.length > 0) {
      const ready = pending.filter(
        (take) =>
          !pending.some(
            (other) =>
              other.index < take.index &&
              sharesContinuity(take, other, plan.continuity),
          ),
      );
      pending = pending.filter((item) => !ready.includes(item));

      const roundAttemptIds: { attemptId: string; takeIndex: number }[] = [];

      for (const take of ready) {
        const existing = existingAttempts.find(
          (item) => item.takeIndex === take.index && item.shot === targetShot,
        );
        if (existing) {
          if (existing.status === "done") {
            if (redo === undefined && existing.storedVideoUrl) {
              fresh.add(take.index);
              renders.set(take.index, existing.storedVideoUrl);
            }
            continue;
          }
          if (existing.status === "failed") {
            continue;
          }
          roundAttemptIds.push({
            attemptId: existing.id,
            takeIndex: take.index,
          });
          started += 1;
          continue;
        }

        const modelSpec = resolveModelForProvider(provider, take.model);
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

          const resolvedFrames = await Promise.all(
            frames.map((frame) => {
              const source = plan.takes.find(
                (other) => other.index === frame.take,
              );
              const k =
                source?.parts.findIndex((item) => item.shot === frame.shot) ??
                -1;
              const own = source?.parts[k];
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
          );

          const submitReferences: TakePromptReferences = {
            creator: creatorId ? references.cast.get(creatorId) : undefined,
            cast: references.cast,
            products: references.products.map((product) => product.url),
            frames: [...references.frames, ...resolvedFrames],
            characters: plan.vibe.characters,
            product: plan.vibe.product,
          };

          const idempotencyKey = crypto.randomUUID();
          const prepared = provider.prepareSubmission({
            model: modelSpec.id,
            prompt,
            seconds,
            hasDialogue: take.analysis.dialogue.length > 0,
            references: submitReferences,
            idempotencyKey,
          });
          prompt = prepared.renderedPrompt;

          const expiresAt = new Date(
            Date.now() + provider.capabilities.defaultTimeoutMs,
          );
          const [attempt] = await db
            .insert(renderAttemptTable)
            .values({
              jobId,
              organizationId: payload.organizationId,
              templateId: template.id,
              takeIndex: take.index,
              shot: targetShot,
              providerId: provider.id,
              canonicalModelId: modelSpec.id,
              providerModelId: modelSpec.providerModelId,
              idempotencyKey,
              status: "submitting",
              prompt,
              generationBase: base,
              nextPollAt: new Date(
                Date.now() + provider.capabilities.pollIntervalMs,
              ),
              expiresAt,
              workerId: getWorkerId(),
            })
            .returning();

          if (!attempt) {
            throw new Error("Could not create durable render attempt.");
          }

          let callbackUrl: string | undefined;
          if (provider.capabilities.supportsWebhook) {
            const waitpoint = await createWaitpoint({
              attemptId: attempt.id,
              providerId: provider.id,
              timeoutMs: provider.capabilities.defaultTimeoutMs,
            });
            callbackUrl = waitpoint.url;
          }

          try {
            const submitted = await provider.submit(ctx, {
              model: modelSpec.id,
              prompt,
              seconds,
              hasDialogue: take.analysis.dialogue.length > 0,
              references: submitReferences,
              idempotencyKey,
              callbackUrl,
            });

            await db
              .update(renderAttemptTable)
              .set({
                status: "submitted",
                externalJobId: submitted.externalJobId,
                providerMetadata: submitted.providerMetadata ?? null,
                prompt: submitted.renderedPrompt,
                nextPollAt: new Date(
                  Date.now() + provider.capabilities.pollIntervalMs,
                ),
              })
              .where(eq(renderAttemptTable.id, attempt.id));

            const generatingState: VideoCloneGeneration = {
              ...base,
              model: modelSpec.id,
              providerId: provider.id,
              attemptId: attempt.id,
              status: "generating",
              prompt: submitted.renderedPrompt,
            };
            if (payload.shot === undefined) {
              await setVideoCloneGenerationByIndex(
                template.id,
                take.index,
                generatingState,
              );
            } else {
              await setVideoClonePartGenerationByShot(
                template.id,
                take.index,
                payload.shot,
                generatingState,
              );
            }

            roundAttemptIds.push({
              attemptId: attempt.id,
              takeIndex: take.index,
            });
            started += 1;
          } catch (submitError) {
            if (
              submitError instanceof ProviderError &&
              submitError.kind === "ambiguous_submit"
            ) {
              // NEVER auto-resubmit an ambiguous submit: keep attempt active until webhook or expiry.
              await db
                .update(renderAttemptTable)
                .set({
                  status: "ambiguous",
                  errorKind: "ambiguous_submit",
                  error: submitError.message,
                })
                .where(eq(renderAttemptTable.id, attempt.id));
              roundAttemptIds.push({
                attemptId: attempt.id,
                takeIndex: take.index,
              });
              started += 1;
            } else {
              const kind =
                submitError instanceof ProviderError
                  ? submitError.kind
                  : undefined;
              await failRenderAttempt(
                attempt.id,
                getErrorMessage(submitError),
                kind,
              );
            }
          }
        } catch (error) {
          await failTake(take.index, error, prompt);
        }
      }

      const waitSliceMs = Math.min(5000, provider.capabilities.pollIntervalMs);
      for (const { attemptId, takeIndex } of roundAttemptIds) {
        for (;;) {
          await reconcileRenderAttempt(attemptId);
          const current = await db.query.renderAttemptTable.findFirst({
            where: eq(renderAttemptTable.id, attemptId),
            columns: { status: true, storedVideoUrl: true },
          });
          if (!current || current.status === "failed") {
            break;
          }
          if (current.status === "done") {
            if (redo === undefined && current.storedVideoUrl) {
              fresh.add(takeIndex);
              renders.set(takeIndex, current.storedVideoUrl);
            }
            break;
          }
          await waitForAttemptSignal(attemptId, waitSliceMs);
        }
      }
    }

    return { started, requested: selected.length };
  },
});

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
    return resolvePublicStorageReferenceUrl(
      `/storage/${bucket}/${path}`,
      REFERENCE_URL_SECONDS,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
      url: await resolvePublicStorageReferenceUrl(url, REFERENCE_URL_SECONDS),
    })),
  );
  const faceIds = [...new Set(Object.values(payload.cast))];
  const faces = await findFaces(payload.organizationId, faceIds);
  if (faces.length !== faceIds.length) {
    throw new Error("Face not found.");
  }
  const signed = new Map(
    await Promise.all(
      faces.map(({ id, imageUrl }) =>
        resolvePublicStorageReferenceUrl(imageUrl, REFERENCE_URL_SECONDS).then(
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
        resolvePublicStorageReferenceUrl(url, REFERENCE_URL_SECONDS),
      ),
    ),
  };
}
