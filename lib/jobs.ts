import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod/v4";
import { env } from "@/lib/env";
import { getErrorMessage } from "@/lib/utils";

/**
 * In-process background jobs: the Trigger.dev calls the clone tasks used (schemaTask,
 * tasks.trigger, metadata, wait), run inside the Next.js server. Needs a long-lived Node process
 * (`next start`, Docker); serverless functions would kill runs mid-render.
 * ponytail: runs live in memory; a restart drops running jobs (their takes settle as failed,
 * settleDeadRenders) and forgets finished ones. Move to a queue (Trigger.dev, BullMQ) when
 * several app instances or restarts mid-render matter.
 */

export type Task<S extends z.ZodType = z.ZodType, O = unknown> = {
  id: string;
  schema: S;
  run: (payload: z.output<S>) => Promise<O>;
};

export type Run = {
  id: string;
  taskId: string;
  payload: unknown;
  status: "running" | "done" | "failed";
  /** What the task reported with metadata.set (e.g. analysis progress). */
  metadata: Record<string, unknown>;
  output?: unknown;
  error?: string;
  startedAt: Date;
};

const state = globalThis as typeof globalThis & {
  jobRuns?: Map<string, Run>;
  jobTokens?: Map<string, (output: unknown) => void>;
};
const runs = (state.jobRuns ??= new Map<string, Run>());
const tokens = (state.jobTokens ??= new Map<
  string,
  (output: unknown) => void
>());
const current = new AsyncLocalStorage<Run>();

export const schemaTask = <S extends z.ZodType, O>(task: Task<S, O>) => task;

/** Starts a task in the background; the payload is validated first, like Trigger.dev's. */
export function startRun<S extends z.ZodType>(
  task: Task<S>,
  payload: z.input<S>,
): { id: string } {
  const parsed = task.schema.parse(payload);
  const run: Run = {
    id: crypto.randomUUID(),
    taskId: task.id,
    payload: parsed,
    status: "running",
    metadata: {},
    startedAt: new Date(),
  };
  runs.set(run.id, run);
  void current
    .run(run, () => task.run(parsed))
    .then(
      (output) => {
        run.status = "done";
        run.output = output;
      },
      (error: unknown) => {
        run.status = "failed";
        run.error = getErrorMessage(error);
        console.error(`[${task.id}] run ${run.id} failed`, error);
      },
    );
  return { id: run.id };
}

/** Runs of one task, newest first. */
export const listRuns = (taskId: string) =>
  [...runs.values()]
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

export const metadata = {
  set(key: string, value: unknown) {
    const run = current.getStore();
    if (run) run.metadata[key] = value;
  },
  flush: async () => {},
};
type TokenResult<T = unknown> = { ok: true; output: T } | { ok: false };

/** A provider callback being waited for: `url` takes its POST, `promise` settles with it or a timeout. */
export type WaitToken = {
  id: string;
  url: string;
  promise: Promise<TokenResult>;
};

export const wait = {
  for: ({ seconds }: { seconds: number }) => sleep(seconds * 1000),

  /** A URL a provider POSTs its result to (app/api/waitpoints/[id]); forToken waits for it. */
  createToken({ timeoutSeconds }: { timeoutSeconds: number }): WaitToken {
    const id = crypto.randomUUID();
    const { promise, resolve } = Promise.withResolvers<TokenResult>();
    const timer = setTimeout(() => {
      tokens.delete(id);
      resolve({ ok: false });
    }, timeoutSeconds * 1000);
    tokens.set(id, (output) => {
      clearTimeout(timer);
      tokens.delete(id);
      resolve({ ok: true, output });
    });
    return {
      id,
      url: `${env.NEXT_PUBLIC_SITE_URL}/api/waitpoints/${id}`,
      promise,
    };
  },

  forToken: <T>(token: WaitToken) => token.promise as Promise<TokenResult<T>>,
};

/** Completes a waiting token with a provider's callback body; false when unknown or timed out. */
export function completeToken(id: string, output: unknown): boolean {
  const resolve = tokens.get(id);
  resolve?.(output);
  return Boolean(resolve);
}

export const logger = {
  info: (message: string, data?: unknown) => console.info(message, data ?? ""),
  warn: (message: string, data?: unknown) => console.warn(message, data ?? ""),
  error: (message: string, data?: unknown) =>
    console.error(message, data ?? ""),
};
