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
  claimNextQueuedStitchJob,
  commitVideoCloneEdit,
} from "@/lib/content-workflows/video-clone-store";
import { db } from "@/lib/db";
import { backgroundJobTable, contentTemplateTable } from "@/lib/db/schema";
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
 * Cuts the plan's renders into one video in story order.
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
  const width = probes[0]?.video?.width;
  const height = probes[0]?.video?.height;
  if (!width || !height) throw new Error("A render has no video stream.");
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

  const audioFormat =
    "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  const list: string[] = [];
  for (const [i, { src, start, end }] of segments.entries()) {
    const input =
      (src === undefined ? undefined : inputs.get(src)) ?? sourceInput;
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
        // ponytail: CPU motion interpolation (~1.3x realtime here); a GPU RIFE pass if faces/hands warp.
        `[0:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,fps=${FPS},tpad=stop=-1:stop_mode=clone,trim=end_frame=${frames},format=yuv420p[v]`,
        probes[input]?.hasAudio
          ? `[0:a]asetpts=PTS-STARTPTS,${audioFormat},apad=whole_dur=${length},atrim=duration=${length}[a]`
          : `anullsrc=r=44100:cl=stereo,atrim=duration=${length},${audioFormat}[a]`,
      ].join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
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

async function runOneStitchPass(payload: {
  organizationId: string;
  templateId: string;
}): Promise<{ stitched: boolean }> {
  const template = await db.query.contentTemplateTable.findFirst({
    where: and(
      eq(contentTemplateTable.id, payload.templateId),
      eq(contentTemplateTable.organizationId, payload.organizationId),
    ),
    columns: { id: true, structure: true },
  });
  const plan = template?.structure.video;
  if (!template || !plan) throw new Error("Clone plan not found.");
  const targetRevision = plan.edit?.revision ?? 0;

  const rendered = plan.takes
    .filter(
      (take) =>
        !keepsOriginal(take) &&
        take.generation?.status === "done" &&
        take.generation.videoUrl,
    )
    .map((take) => take.index);

  const previous = {
    videoUrl: plan.edit?.videoUrl,
    textVideoUrl: plan.edit?.textVideoUrl,
    rendered: plan.edit?.rendered ?? [],
    parts: plan.edit?.parts,
  };
  const startedAt = new Date().toISOString();

  if (rendered.length === 0) {
    await commitVideoCloneEdit(template.id, targetRevision, {
      status: "done",
      rendered: [],
      startedAt,
    });
    return { stitched: false };
  }

  const dir = await mkdtemp(join(tmpdir(), "video-clone-edit-"));
  try {
    const { file, textFile, parts, renderCuts } = await stitchVideoCloneEdit(
      plan,
      dir,
    );
    const bucket = storageConfig.bucketNames.images;
    const store = async (mp4: string, name: string) => {
      const path = `video-clones/${payload.organizationId}/generations/${template.id}/${name}-${crypto.randomUUID()}.mp4`;
      await putObject(path, bucket, await readFile(mp4), "video/mp4");
      return `/storage/${bucket}/${path}`;
    };
    const videoUrl = await store(file, "edit");
    const textVideoUrl = textFile
      ? await store(textFile, "edit-text")
      : undefined;

    await commitVideoCloneEdit(
      template.id,
      targetRevision,
      {
        status: "done",
        videoUrl,
        textVideoUrl,
        rendered,
        parts,
        startedAt,
      },
      renderCuts,
    );
    return { stitched: true };
  } catch (error) {
    await commitVideoCloneEdit(template.id, targetRevision, {
      ...previous,
      status: "failed",
      error: getErrorMessage(error) || "Couldn't stitch the takes.",
      startedAt,
    });
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Stitches the plan's current renders into `structure.video.edit` using monotonic revision checks,
 * draining any queued follow-up stitch serialized behind it.
 */
export const stitchVideoCloneTask = schemaTask({
  id: triggerTaskIds.stitchVideoClone,
  schema: z.object({
    organizationId: z.string().uuid(),
    templateId: z.string().uuid(),
  }),
  run: async (payload) => {
    const firstResult = await runOneStitchPass(payload);

    // Drain any coalesced queued stitch requested while this pass ran.
    for (;;) {
      const nextJob = await claimNextQueuedStitchJob(payload.templateId);
      if (!nextJob) break;
      try {
        const nextPayload = nextJob.payload as {
          organizationId: string;
          templateId: string;
        };
        const out = await runOneStitchPass(nextPayload);
        await db
          .update(backgroundJobTable)
          .set({
            status: "done",
            output: out,
            finishedAt: new Date(),
            heartbeatAt: new Date(),
          })
          .where(eq(backgroundJobTable.id, nextJob.id));
      } catch (error) {
        await db
          .update(backgroundJobTable)
          .set({
            status: "failed",
            error: getErrorMessage(error),
            finishedAt: new Date(),
            heartbeatAt: new Date(),
          })
          .where(eq(backgroundJobTable.id, nextJob.id));
      }
    }

    return firstResult;
  },
});
