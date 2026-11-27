import "server-only";

/**
 * Simple in-process semaphore supporting dynamic runtime concurrency limits so analysis jobs,
 * ffmpeg/ffprobe subprocesses, and parallel LLM calls never exhaust single-container CPU/RAM.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly getLimit: () => number;

  constructor(limit: number | (() => number)) {
    this.getLimit = typeof limit === "function" ? limit : () => limit;
  }

  private limit(): number {
    const raw = this.getLimit();
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit()) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const analyzeJobLimiter = new Semaphore(() =>
  envPositiveInt("MAX_CONCURRENT_ANALYSES", 2),
);
export const ffmpegLimiter = new Semaphore(() =>
  envPositiveInt("MAX_CONCURRENT_FFMPEG", 2),
);
export const llmAnalysisLimiter = new Semaphore(() =>
  envPositiveInt("MAX_CONCURRENT_LLM_CALLS", 3),
);
