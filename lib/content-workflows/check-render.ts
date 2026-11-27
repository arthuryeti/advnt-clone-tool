import "server-only";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { describeVideo } from "@/lib/ai/describe-video";
import {
  isAddedPart,
  renderPartSpans,
  round,
  type VideoClone,
  type VideoCloneGeneration,
  type VideoClonePart,
} from "@/lib/content-workflows/video-clone";
import { getObject, parseStorageObjectFromUrl } from "@/lib/storage";
import {
  FFMPEG,
  FFPROBE,
  findSceneCuts,
  RENDER_CUT_SCORE,
  run,
} from "@/trigger/run-command";

/**
 * Video-understanding model watches the original take (or the redone part) and its render,
 * returning parts staged differently. Undefined for takes added by user changes.
 */
export async function checkRenderMismatch(
  take: VideoClone["takes"][number],
  redoPosition: number | undefined,
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
    let at = 0;
    const source = take.parts.map((part) => {
      const start = at;
      at += Math.max(0, part.srcEnd - part.srcStart);
      return { start: round(start), end: round(at) };
    });
    const ours =
      redoPosition === undefined
        ? renderPartSpans(take.parts, {
            cuts: await findSceneCuts(rendered, RENDER_CUT_SCORE),
            duration,
          })
        : [];
    const checked = (
      redoPosition === undefined ? take.parts.map((_, k) => k) : [redoPosition]
    )
      .filter((k) => !isAddedPart(take.parts[k] as VideoClonePart))
      .map((k) => {
        const span = source[k] as { start: number; end: number };
        return redoPosition === undefined
          ? { k, original: span, ours: ours[k] }
          : {
              k,
              original: { start: 0, end: round(span.end - span.start) },
              ours: { start: 0, end: round(duration) },
            };
      });
    if (checked.length === 0) return undefined;
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
      await small(
        original,
        redoPosition === undefined ? undefined : source[redoPosition],
      ),
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
