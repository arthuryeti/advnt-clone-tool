import { execFile } from "node:child_process";

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

/** Runs a binary; a failure carries its last stderr line. */
export function run(command: string, args: string[]) {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  execFile(
    command,
    args,
    { maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const reason = stderr.trim().split("\n").at(-1) || error.message;
      reject(new Error(`${command} failed: ${reason}`));
    },
  );
  return promise;
}

/** Times (seconds) where ffmpeg sees the picture change by more than `threshold` (0-1). */
export async function findSceneCuts(file: string, threshold: number) {
  const { stderr } = await run(FFMPEG, [
    "-hide_banner",
    "-i",
    file,
    "-an",
    "-vf",
    `scale=180:-2,select='gt(scene,${threshold})',metadata=print`,
    "-f",
    "null",
    "-",
  ]);
  return [...stderr.matchAll(/pts_time:([\d.]+)/gu)].map(
    (match) => Math.round(Number(match[1]) * 100) / 100,
  );
}

/** Scene score of a hard cut in one of our renders: Seedance's score 0.27-0.58 on 180px frames; nothing else in a render passed 0.1. */
export const RENDER_CUT_SCORE = 0.2;
