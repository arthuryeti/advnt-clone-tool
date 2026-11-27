import { spawn } from "node:child_process";
import { basename } from "node:path";
import { ffmpegLimiter } from "@/lib/concurrency";
import { redactSecrets } from "@/lib/security/redact";

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultTimeoutForCommand(command: string): number {
  const bin = basename(command).toLowerCase();
  if (bin.includes("ffprobe"))
    return envTimeoutMs("FFPROBE_TIMEOUT_MS", 30_000);
  if (bin.includes("yt-dlp")) return envTimeoutMs("YTDLP_TIMEOUT_MS", 180_000);
  return envTimeoutMs("FFMPEG_TIMEOUT_MS", 300_000);
}

export type RunCommandOptions = {
  timeoutMs?: number;
  skipConcurrencyLimit?: boolean;
};

/** Runs a binary with explicit timeout (SIGTERM -> SIGKILL) and concurrency capping. */
export function run(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const execute = () =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutForCommand(command);
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        reject(err);
      };

      const terminateChild = (reason: string) => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref?.();
        finishError(new Error(reason));
      };

      const timeoutTimer = setTimeout(() => {
        terminateChild(`${command} timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timeoutTimer.unref?.();

      const append = (chunks: Buffer[], chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_BUFFER_BYTES) {
          terminateChild(`${command} exceeded output buffer limit`);
          return;
        }
        chunks.push(chunk);
      };

      child.stdout?.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(stderrChunks, chunk));

      child.on("error", (error) => {
        finishError(
          new Error(`${command} failed: ${redactSecrets(error.message)}`),
        );
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const reason =
          redactSecrets(stderr.trim().split("\n").at(-1) ?? "") ||
          (signal ? `terminated by ${signal}` : `exited with code ${code}`);
        reject(new Error(`${command} failed: ${reason}`));
      });
    });

  return options.skipConcurrencyLimit ? execute() : ffmpegLimiter.run(execute);
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
