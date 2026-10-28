import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { storageConfig } from "@/config/storage.config";
import {
  keepsOriginal,
  type RenderCuts,
  type VideoClone,
  videoCloneEditClips,
  videoCloneEditSources,
  videoCloneTextOverlays,
} from "@/lib/content-workflows/video-clone";
import {
  addVideoCloneRenderCuts,
  setVideoCloneEdit,
} from "@/lib/content-workflows/video-clone-store";
import { db } from "@/lib/db";
import { contentTemplateTable } from "@/lib/db/schema";
import { schemaTask } from "@/lib/jobs";
import { renderTextLayersImage } from "@/lib/post/render-slide-text-overlay";
import { createDefaultSlideTextLayer } from "@/lib/post/text-layers";
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

const FPS = 30;
/** Where on-screen text sits: high in the frame, like video overlay posts' "top". */
const TEXT_Y = 0.2;
const ffprobeSchema = z.object({
  format: z.object({ duration: z.coerce.number() }),
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    )
    .default([]),
});

/**
 * Cuts the plan's renders into one video in story order: every part from its own render when it
 * was redone alone, else from the take render picked for it or its take's render, following that
 * render's own cuts. Takes not rendered yet keep the source's footage; added ones are left out
 * until rendered. Returns the mp4's path inside `dir`, the same cut with the takes' on-screen text
 * burned in when they have any (`textFile`), where each part plays in it, and every render's cuts
 * and length by file.
 */
export async function stitchVideoCloneEdit(
  plan: VideoClone,
  dir: string,
): Promise<{
  file: string;
  textFile?: string;
  parts: NonNullable<NonNullable<VideoClone["edit"]>["parts"]>;
  renderCuts: Record<string, RenderCuts>;
}> {
  const download = async (url: string, name: string) => {
    const stored = parseStorageObjectFromUrl(url);
    if (!stored) throw new Error(`${url} isn't in our storage.`);
    const file = join(dir, name);
    await writeFile(file, await getObject(stored.path, stored.bucket));
    return file;
  };
  const files: string[] = [];
  /** Render URL → its ffmpeg input number: a file several parts play downloads once. */
  const inputs = new Map<string, number>();
  const sources = videoCloneEditSources(plan);
  for (const url of new Set([
    ...sources.takes.values(),
    ...sources.redone.values(),
    ...sources.picked.values(),
  ])) {
    inputs.set(url, files.length);
    files.push(await download(url, `render-${files.length}.mp4`));
  }
  const sourceInput = files.length;
  // Only takes of the original have footage to fall back on.
  if (
    plan.takes.some((take) => !sources.takes.has(take.index) && take.videoUrl)
  ) {
    files.push(await download(plan.sourceVideoUrl, "source.mp4"));
  }

  const probes = await Promise.all(
    files.map(async (file) => {
      const { stdout } = await run(FFPROBE, [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
        file,
      ]);
      const { format, streams } = ffprobeSchema.parse(JSON.parse(stdout));
      return {
        duration: format.duration,
        video: streams.find((stream) => stream.codec_type === "video"),
        hasAudio: streams.some((stream) => stream.codec_type === "audio"),
      };
    }),
  );
  // The first render sets the frame; source footage is scaled and padded into it.
  const width = probes[0]?.video?.width;
  const height = probes[0]?.video?.height;
  if (!width || !height) throw new Error("A render has no video stream.");
  // Each take render's cuts are found once and kept (renderCuts); a part's own render plays whole.
  const cutting = new Set([
    ...sources.takes.values(),
    ...sources.picked.values(),
  ]);
  const renderCuts = Object.fromEntries(
    await Promise.all(
      [...inputs].map(async ([url, n]) => {
        const kept = plan.renderCuts?.[url];
        if (kept) return [url, kept] as const;
        const cuts = cutting.has(url)
          ? await findSceneCuts(files[n] as string, RENDER_CUT_SCORE)
          : [];
        return [url, { cuts, duration: probes[n]?.duration ?? 0 }] as const;
      }),
    ),
  );
  const segments = videoCloneEditClips(
    plan,
    (url, planned) => renderCuts[url] ?? planned,
  );

  // Each part is cut to its own file, one ffmpeg at a time: one graph holding every part's
  // minterpolate (~290 bytes a pixel each) plus the frames queued for concat ran out of memory
  // (14 parts of a 480p take: 2.2 GB, past medium-1x).
  const audioFormat =
    "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  const list: string[] = [];
  for (const [i, { src, start, end }] of segments.entries()) {
    const input =
      (src === undefined ? undefined : inputs.get(src)) ?? sourceInput;
    // A whole number of frames with its sound just as long, so the joined parts stay in sync.
    const frames = Math.max(1, Math.round((end - start) * FPS));
    const length = frames / FPS;
    const part = `part-${i}.mkv`;
    await run(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(start),
      "-t",
      String(end - start),
      "-i",
      files[input] as string,
      "-filter_complex",
      [
        // Seedance renders 24fps; fps=30 alone repeats every 4th frame (judder), so minterpolate makes the missing ones.
        // minterpolate drops its last 1-2 frames: fps fills them and tpad/trim pin the part's frame count.
        // ponytail: CPU motion interpolation (~1.3x realtime here); a GPU RIFE pass if faces/hands warp.
        `[0:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,fps=${FPS},tpad=stop=-1:stop_mode=clone,trim=end_frame=${frames},format=yuv420p[v]`,
        // Silent clips (takes without lines) still need audio so the joined sound stays in sync.
        probes[input]?.hasAudio
          ? `[0:a]asetpts=PTS-STARTPTS,${audioFormat},apad=whole_dur=${length},atrim=duration=${length}[a]`
          : `anullsrc=r=44100:cl=stereo,atrim=duration=${length},${audioFormat}[a]`,
      ].join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
      // Near-lossless: the edit is encoded from these once more below.
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "10",
      "-c:a",
      "pcm_s16le",
      join(dir, part),
    ]);
    list.push(`file '${part}'`);
  }
  const parts = join(dir, "parts.txt");
  await writeFile(parts, list.join("\n"));
  // The text plays over a copy of the cut: frames for picking stills stay clean.
  const overlays = videoCloneTextOverlays(plan.takes, segments);
  const images = await Promise.all(
    overlays.map(async ({ text }, i) => {
      const image = join(dir, `text-${i}.png`);
      await writeFile(
        image,
        renderTextLayersImage({
          width,
          height,
          textLayers: [createDefaultSlideTextLayer(text, { y: TEXT_Y })],
        }),
      );
      return image;
    }),
  );
  const output = join(dir, "edit.mp4");
  const textFile = overlays.length > 0 ? join(dir, "edit-text.mp4") : undefined;
  const encode = (video: string, audio: string, file: string) => [
    "-map",
    video,
    "-map",
    audio,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    file,
  ];
  await run(FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-i",
    parts,
    ...images.flatMap((image) => ["-i", image]),
    ...(textFile
      ? [
          "-filter_complex",
          [
            "[0:v]split[v0][t0]",
            ...overlays.map(
              ({ start, end }, i) =>
                `[t${i}][${1 + i}:v]overlay=enable='between(t,${start},${end})'[t${i + 1}]`,
            ),
            "[0:a]asplit[a0][ta]",
          ].join(";"),
          ...encode("[v0]", "[a0]", output),
          ...encode(`[t${overlays.length}]`, "[ta]", textFile),
        ]
      : encode("0:v", "0:a", output)),
  ]);
  return {
    file: output,
    textFile,
    parts: segments.map(({ part, editStart, editEnd }) => ({
      shot: part.shot,
      srcStart: part.srcStart,
      srcEnd: part.srcEnd,
      start: editStart,
      end: editEnd,
    })),
    renderCuts,
  };
}

/** Stitches the plan's current renders into `structure.video.edit`; the render task starts it after each run. */
export const stitchVideoCloneTask = schemaTask({
  id: triggerTaskIds.stitchVideoClone,
  schema: z.object({
    organizationId: z.string().uuid(),
    templateId: z.string().uuid(),
  }),
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
    const rendered = plan.takes
      .filter(
        (take) =>
          !keepsOriginal(take) &&
          take.generation?.status === "done" &&
          take.generation.videoUrl,
      )
      .map((take) => take.index);
    // Keep the last edit watchable if this one fails.
    const previous = {
      videoUrl: plan.edit?.videoUrl,
      textVideoUrl: plan.edit?.textVideoUrl,
      rendered: plan.edit?.rendered ?? [],
      parts: plan.edit?.parts,
    };
    const startedAt = new Date().toISOString();
    if (rendered.length === 0) {
      // Every take is the original again: no edit to watch.
      await setVideoCloneEdit(template.id, {
        status: "done",
        rendered: [],
        startedAt,
      });
      return { stitched: false };
    }
    // ponytail: two runs finishing together each stitch what they saw; the last write wins.
    const dir = await mkdtemp(join(tmpdir(), "video-clone-edit-"));
    try {
      const { file, textFile, parts, renderCuts } = await stitchVideoCloneEdit(
        plan,
        dir,
      );
      // The page previews with these from now on: the same cuts as this edit.
      await addVideoCloneRenderCuts(template.id, renderCuts);
      const bucket = storageConfig.bucketNames.images;
      const store = async (mp4: string, name: string) => {
        const path = `video-clones/${payload.organizationId}/generations/${template.id}/${name}-${crypto.randomUUID()}.mp4`;
        await putObject(path, bucket, await readFile(mp4), "video/mp4");
        return `/storage/${bucket}/${path}`;
      };
      await setVideoCloneEdit(template.id, {
        status: "done",
        videoUrl: await store(file, "edit"),
        textVideoUrl: textFile && (await store(textFile, "edit-text")),
        rendered,
        parts,
        startedAt,
      });
      return { stitched: true };
    } catch (error) {
      await setVideoCloneEdit(template.id, {
        ...previous,
        status: "failed",
        error: getErrorMessage(error) || "Couldn't stitch the takes.",
        startedAt,
      });
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
