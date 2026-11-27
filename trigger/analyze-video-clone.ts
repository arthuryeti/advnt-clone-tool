import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { storageConfig } from "@/config/storage.config";
import { describeVideo } from "@/lib/ai/describe-video";
import { analyzeJobLimiter, llmAnalysisLimiter } from "@/lib/concurrency";
import {
  analyzeVideoCloneInputSchema,
  buildTakes,
  hasTooManyCuts,
  renderSeconds,
  round,
  shotsFromCuts,
  stageVideoClonePrompt,
  type VideoClone,
  type VideoCloneContinuity,
  type VideoCloneVibe,
  videoCloneContinuitySchema,
  videoCloneTakeAnalysisSchema,
  videoCloneVerdict,
  videoCloneVibeSchema,
} from "@/lib/content-workflows/video-clone";
import { db } from "@/lib/db";
import { contentTemplateTable } from "@/lib/db/schema";
import { metadata, schemaTask } from "@/lib/jobs";
import { getObject, parseStorageObjectFromUrl, putObject } from "@/lib/storage";
import { FFMPEG, FFPROBE, findSceneCuts, run } from "./run-command";
import { triggerTaskIds } from "./shared";

// Knob: lower = more cut candidates for Gemini to vet. 0.3 missed a real angle change at 0.26.
const SCENE_THRESHOLD = 0.25;
// Each analysis pass sends one inline file; 3 minutes at 360p stays well under inline caps.
const PART_SECONDS = 180;

const setProgress = async (label: string, progress: number) => {
  metadata.set("videoClone", { label, progress });
  await metadata.flush();
};

async function storeVideo(file: string, path: string): Promise<string> {
  const bucket = storageConfig.bucketNames.images;
  await putObject(path, bucket, await readFile(file), "video/mp4");
  return `/storage/${bucket}/${path}`;
}

export const analyzeVideoCloneTask = schemaTask({
  id: triggerTaskIds.analyzeVideoClone,
  schema: analyzeVideoCloneInputSchema,
  run: (payload) =>
    analyzeJobLimiter.run(async () => {
      const dir = await mkdtemp(join(tmpdir(), "video-clone-"));
      try {
        return await analyzeVideoClone(payload, dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
});

async function analyzeVideoClone(
  payload: z.infer<typeof analyzeVideoCloneInputSchema>,
  dir: string,
) {
  const prefix = `video-clones/${payload.organizationId}/${crypto.randomUUID()}`;
  const source = join(dir, "source.mp4");

  // 1. Source: an upload already in storage, or a TikTok/Instagram link via yt-dlp.
  await setProgress("Downloading video", 5);
  const stored = parseStorageObjectFromUrl(payload.sourceUrl);
  let sourceVideoUrl = payload.sourceUrl;
  if (stored) {
    await writeFile(source, await getObject(stored.path, stored.bucket));
  } else {
    await run("yt-dlp", [
      "--quiet",
      "--no-warnings",
      "--no-playlist",
      "--socket-timeout",
      "30",
      "--max-filesize",
      "100M",
      "--format",
      "b[ext=mp4]/bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "--output",
      source,
      "--",
      payload.sourceUrl,
    ]).catch((error: Error) => {
      throw new Error(`Couldn't download this post. ${error.message}`);
    });
    sourceVideoUrl = await storeVideo(source, `${prefix}/source.mp4`);
  }

  const probe = await run(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    source,
  ]);
  const media = JSON.parse(probe.stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  const duration = Number(media.format?.duration);
  const hasAudio = Boolean(
    media.streams?.some((stream) => stream.codec_type === "audio"),
  );
  if (!media.streams?.some((stream) => stream.codec_type === "video")) {
    throw new Error("This post has no video.");
  }
  if (!(duration > 0)) throw new Error("Couldn't read this video's length.");

  // 2. Cut candidates: ffmpeg is frame-accurate; video-understanding model vets them next.
  await setProgress("Finding cuts", 15);
  const candidates = await findSceneCuts(source, SCENE_THRESHOLD);

  // 3. The video at 360p, in parts: style, characters, transcript, and which candidates are real cuts.
  const count = Math.ceil(duration / PART_SECONDS);
  const parts: { start: number; end: number; file: string; note: string }[] =
    [];
  for (let k = 0; k < count; k++) {
    const start = round((k * duration) / count);
    const end = round(((k + 1) * duration) / count);
    const file = join(dir, `small-${k}.mp4`);
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
      source,
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
      file,
    ]);
    parts.push({
      start,
      end,
      file,
      note:
        count > 1
          ? `This file is part ${k + 1} of ${count} of the video: the original's ${Math.round(start)}-${Math.round(end)}s. Every time is from the start of this file.\n`
          : "",
    });
  }

  let merged: VideoCloneVibe | undefined;
  const cuts: { time: number; real: boolean }[] = [];
  for (const [k, part] of parts.entries()) {
    await setProgress(
      count > 1 ? `Watching the video ${k + 1}/${count}` : "Watching the video",
      25,
    );
    const earlier = merged;
    const partCandidates = candidates
      .filter((time) => time >= part.start && time < part.end)
      .map((time) => round(time - part.start));
    const watched = await llmAnalysisLimiter.run(() =>
      describeVideo({
        file: part.file,
        schema: videoCloneVibeSchema.extend({
          cuts: z.array(
            z.object({
              time: z.number(),
              real: z
                .boolean()
                .describe(
                  "true = change of camera shot/angle/scene; false = change inside the same shot",
                ),
              reason: z.string(),
            }),
          ),
        }),
        prompt: `You are analyzing a short-form social video (TikTok/Reels, ${Math.round(duration)}s) so we can re-create it shot by shot with an AI video model, swapping in our own creator and product.
${part.note && `\n${part.note}`}${
  earlier
    ? `
The earlier parts were described as below. Keep every character's id, reference, and description, and add people who first appear here. Keep the hook. Update the other fields to cover the video so far. Transcribe this part only.
${JSON.stringify({ ...earlier, transcript: undefined }, null, 1)}
`
    : ""
}
Describe the overall format, style, and the recurring people. Give every recurring person a stable id and a detailed visual description we can reuse verbatim in every shot prompt so they stay consistent. Mark the single main on-camera person whose role our creator will take as reference "creator" (or none if there is no such person).

Transcribe all speech with start/end seconds and the speaker id.

ffmpeg scene detection proposed these cut times (seconds): ${partCandidates.join(", ") || "none"}.
For each candidate return real=true only if the camera shot, angle, or scene changes. Return real=false for changes inside one continuous shot: a screen recording scrolling, graphics/caption changes, fast motion, or a flash. Return one entry per candidate, same order.`,
      }),
    );
    const { cuts: partCuts, ...vibe } = watched;
    cuts.push(
      ...partCuts.map((cut) => ({
        ...cut,
        time: round(cut.time + part.start),
      })),
    );
    const transcript = vibe.transcript.map((line) => ({
      ...line,
      start: round(Math.min(line.start + part.start, part.end)),
      end: round(Math.min(line.end + part.start, part.end)),
    }));
    merged = earlier
      ? {
          ...vibe,
          hook: earlier.hook,
          characters: [
            ...earlier.characters,
            ...vibe.characters.filter(
              (character) =>
                !earlier.characters.some((known) => known.id === character.id),
            ),
          ],
          transcript: [...earlier.transcript, ...transcript],
        }
      : { ...vibe, transcript };
  }
  const vibe = merged as VideoCloneVibe;
  const shots = shotsFromCuts(
    cuts.filter((cut) => cut.real).map((cut) => cut.time),
    duration,
  );

  // 4. Scenes and continuity.
  const scenes: VideoClone["scenes"] = [];
  const continuity: VideoCloneContinuity = [];
  const sceneOf = new Map<number, string>();
  for (const [k, part] of parts.entries()) {
    await setProgress(
      count > 1 ? `Grouping scenes ${k + 1}/${count}` : "Grouping scenes",
      40,
    );
    const partShots = shots.filter(
      (shot) =>
        (shot.start + shot.end) / 2 >= part.start &&
        (shot.start + shot.end) / 2 < part.end,
    );
    if (!partShots.length) continue;
    const sceneMap = await llmAnalysisLimiter.run(() =>
      describeVideo({
        file: part.file,
        schema: z.object({
          scenes: z.array(
            z.object({
              id: z.string(),
              location: z.string(),
              cast: z.string(),
            }),
          ),
          shots: z.array(
            z.object({ i: z.number().int(), sceneId: z.string() }),
          ),
          continuity: z.array(videoCloneContinuitySchema.element.required()),
        }),
        prompt: `${part.note}This video is cut into these shots (seconds): ${JSON.stringify(partShots.map((shot) => ({ i: shot.index, start: round(Math.max(0, shot.start - part.start)), end: round(Math.min(part.end, shot.end) - part.start) })))}
Videos often cut back to the same scene. Group the shots into scenes. A scene = one location at one moment in time: shot-reverse-shot, close-ups, and angles on different people taking part in the same conversation or action are ONE scene, even when each shot frames only some of them. Start a new scene only when the location changes, or when the same place is shown at another time (different outfits, day vs night). Return a scene catalog (cast = everyone in the scene, on screen or not), then every shot's sceneId.

Then list the continuity: everything that must look the same each time it shows, because separately generated shots will otherwise drift. Each person's look (face, hair, makeup, outfit, accessories) as one entry per look: a person who changes outfit gets a new entry from that shot on. Each location or set. Each recurring prop, vehicle, or animal. Give each a short label, every shot showing it, and its best shot: the one where it's seen most clearly and completely (a person facing the camera with their whole outfit in frame, the widest view of a place); a reference frame for every other shot is taken from it. Leave out what shows in one shot only.${
          scenes.length
            ? `

The earlier parts found these scenes: ${JSON.stringify(scenes)}
and this continuity: ${JSON.stringify(continuity.map((element) => element.label))}
When a shot here returns to one of those scenes or shows one of those things, reuse its id or label exactly (it counts even if it shows in one shot here).`
            : ""
        }`,
      }),
    );
    for (const scene of sceneMap.scenes) {
      if (!scenes.some((known) => known.id === scene.id)) scenes.push(scene);
    }
    for (const shot of sceneMap.shots) sceneOf.set(shot.i, shot.sceneId);
    for (const element of sceneMap.continuity) {
      const known = continuity.find((item) => item.label === element.label);
      if (!known) continuity.push(element);
      else {
        known.shots.push(
          ...element.shots.filter((shot) => !known.shots.includes(shot)),
        );
      }
    }
  }
  const planned = buildTakes(shots, (index) => sceneOf.get(index));

  // 5. Cut each take clip one at a time.
  await setProgress(`Cutting ${planned.length} takes`, 50);
  const clips: { file: string; videoUrl: string }[] = [];
  for (const take of planned) {
    const file = join(dir, `take-${take.index}.mp4`);
    const trims = take.parts.flatMap((part, k) => [
      `[0:v]trim=${part.srcStart}:${part.srcEnd},setpts=PTS-STARTPTS[v${k}]`,
      ...(hasAudio
        ? [
            `[0:a]atrim=${part.srcStart}:${part.srcEnd},asetpts=PTS-STARTPTS[a${k}]`,
          ]
        : []),
    ]);
    const inputs = take.parts
      .map((_, k) => (hasAudio ? `[v${k}][a${k}]` : `[v${k}]`))
      .join("");
    const audio = hasAudio ? "[a]" : "";
    await run(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-filter_complex",
      `${trims.join(";")};${inputs}concat=n=${take.parts.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${audio};[vc]scale=-2:'min(960,ih)'[v]`,
      "-map",
      "[v]",
      ...(hasAudio ? ["-map", "[a]", "-c:a", "aac"] : []),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-movflags",
      "+faststart",
      file,
    ]);
    const videoUrl = await storeVideo(
      file,
      `${prefix}/take-${String(take.index).padStart(2, "0")}.mp4`,
    );
    clips.push({ file, videoUrl });
  }

  // 6. Per take (concurrency-bounded): description, difficulty, and multi-part prompt.
  let written = 0;
  await setProgress(`Writing prompts 0/${planned.length}`, 55);
  const vibeContext = JSON.stringify(vibe, null, 1);
  const takes = await Promise.all(
    planned.map((take, i) =>
      llmAnalysisLimiter.run(async () => {
        const clip = clips[i] as (typeof clips)[number];
        const partList = take.parts
          .map(
            (part, k) =>
              `Part ${k + 1} (${part.takeStart}-${part.takeEnd}s) = original ${part.srcStart}-${part.srcEnd}s`,
          )
          .join("\n");
        const { staging, ...analysis } = await describeVideo({
          file: clip.file,
          schema: z.object({
            staging: z
              .array(
                z.object({
                  part: z.number().int().describe("part number, from 1"),
                  camera: z
                    .string()
                    .describe(
                      "where the camera physically stands and which way it faces, e.g. 'in the hallway, facing the front door'; not the framing",
                    ),
                  saidTo: z
                    .string()
                    .describe(
                      "who this part's lines are said to and where they are, e.g. 'the waiter standing at their table' or 'someone on the phone'; people as the prompt writes them ({{creator}}, or a few words of their look), never an id; empty when no one speaks",
                    ),
                }),
              )
              .describe("one entry per part, in order"),
            ...videoCloneTakeAnalysisSchema.shape,
          }),
          prompt: `This clip is take ${take.index}/${planned.length} (${take.seconds}s) of a video we are re-creating with an AI text+reference-image video model.

Whole-video analysis (use these character ids and copy their descriptions verbatim for consistency):
${vibeContext}

${
  take.parts.length > 1
    ? `The clip joins ${take.parts.length} parts of the original video at hard cuts:
${partList}
After generation we split the take at those cuts and put each part back at its original place in the edit. So write ONE prompt that generates the parts in this order, each labeled with its time range ("Part 1 (0-5.9s): ... Hard cut. Part 2 (5.9-12.1s): ..."). Every part boundary must be a visible hard cut; if two parts share a camera setup, change the framing (e.g. medium, then tighter) so the cut can be detected.

`
    : ""
}Analyze this clip, transcribe its exact dialogue, then write the prompt that re-creates it exactly.

Prompt rules:
- Vertical 9:16, in the visual style above (its era, camera, color, grain). Describe framing, camera movement, setting, lighting, and the action beat by beat.
- staging: for every part, where the camera stands and who its lines are said to, even when that person is out of frame. We add it after each part's label, so it's in the prompt.
- The generation will be ${renderSeconds(take.seconds)}s long; the action must fit in the first ${take.seconds}s (we trim the rest).
- The person with reference "creator" must be written as {{creator}}; identity comes from a reference image, so do not describe their face or hair. Do describe their outfit and accessories every time they appear, in the same words as the vibe's description for as long as they wear it: takes are generated separately, and an outfit left vague gets reinvented in every take.
- Write the product as {{product}} (it comes from a reference image). Never mention the original brand names.
- Other people: paste their full description from the vibe each time.
- Include every spoken line in quotes with who says it, so the model generates the speech and lip-sync.
- No on-screen text, captions, subtitles, logos, or UI overlays in the generated video.

Difficulty rubric. Judge what happens INSIDE each part. Ignore the cuts between parts (we add those; code checks cut density) and wardrobe or costume detail (easy to describe).
- manual: screen recordings, app/website UI, text or logos as the subject, end cards and graphics, a specific real product's exact packaging.
- hard: hands manipulating small objects or the product (peeling, unwrapping, assembling), complex physics (sports, riding, animals, pouring liquids, fabric), crowds, one person talking non-stop for over ~10s, exact choreography, whip pans or complex camera moves.
- easy: talking heads and street interviews (short lines, several speakers is fine), simple handheld or static shots, walking, scenery, simple b-roll.`,
        });
        analysis.prompt = stageVideoClonePrompt(analysis.prompt, staging);
        if (analysis.difficulty === "easy" && hasTooManyCuts(take)) {
          analysis.difficulty = "hard";
          analysis.difficultyReason = `${take.parts.length} shots in ${take.seconds}s`;
        }
        written += 1;
        await setProgress(
          `Writing prompts ${written}/${planned.length}`,
          55 + Math.round((written / planned.length) * 40),
        );
        return { ...take, videoUrl: clip.videoUrl, analysis };
      }),
    ),
  );

  await setProgress("Saving", 97);
  const verdict = videoCloneVerdict(takes);
  const video: VideoClone = {
    sourceUrl: payload.sourceUrl,
    sourceVideoUrl,
    durationSeconds: Math.round(duration * 100) / 100,
    vibe,
    scenes,
    continuity,
    takes,
    verdict,
  };
  const [template] = await db
    .insert(contentTemplateTable)
    .values({
      organizationId: payload.organizationId,
      name: payload.name,
      description: vibe.summary,
      status: verdict === "skip" ? "not_reproducible" : "ready",
      structure: { video },
    })
    .returning({ id: contentTemplateTable.id });
  if (!template) throw new Error("Could not save the clone plan.");

  await setProgress("Done", 100);
  return { templateId: template.id };
}
