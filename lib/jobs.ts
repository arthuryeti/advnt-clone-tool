import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { z } from "zod/v4";
import { getVideoProviderById } from "@/lib/ai/providers/video/registry";
import type { VideoWebhookOutcome } from "@/lib/ai/providers/video/types";
import { db } from "@/lib/db";
import {
  type BackgroundJobStatus,
  backgroundJobTable,
  type JobWaitpointStatus,
  jobWaitpointTable,
  renderAttemptTable,
} from "@/lib/db/schema";
import { getSiteUrl } from "@/lib/env";
import { redactObject, redactSecrets } from "@/lib/security/redact";
import { getErrorMessage } from "@/lib/utils";

export type Task<S extends z.ZodType = z.ZodType, O = unknown> = {
  id: string;
  schema: S;
  run: (payload: z.output<S>) => Promise<O>;
};

export type RunRecord = {
  id: string;
  taskId: string;
  organizationId: string;
  templateId: string | null;
  payload: unknown;
  status: BackgroundJobStatus;
  metadata: Record<string, unknown>;
  output?: unknown;
  error?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
};

type JobContext = {
  jobId: string;
  metadata: Record<string, unknown>;
};

const currentJob = new AsyncLocalStorage<JobContext>();
const attemptEmitter = new EventEmitter();
attemptEmitter.setMaxListeners(200);

const globalForJobs = globalThis as typeof globalThis & {
  workerId?: string;
  reconcileTimer?: ReturnType<typeof setInterval>;
  reconcileHandler?: (() => Promise<unknown>) | null;
  attemptReconcileHandler?: ((attemptId: string) => Promise<unknown>) | null;
  activeReconcilePromise?: Promise<unknown> | null;
  waitpointStoreOverride?: WaitpointStore | null;
};

export function getWorkerId(): string {
  if (!globalForJobs.workerId) {
    globalForJobs.workerId = `worker-${process.pid}-${randomBytes(4).toString("hex")}`;
  }
  return globalForJobs.workerId;
}

export function setWorkerIdForTests(id: string): void {
  globalForJobs.workerId = id;
}

export function getCurrentJobId(): string | undefined {
  return currentJob.getStore()?.jobId;
}

export function registerReconcileHandlers(handlers: {
  reconcileAll: () => Promise<unknown>;
  reconcileAttempt: (attemptId: string) => Promise<unknown>;
}): void {
  globalForJobs.reconcileHandler = handlers.reconcileAll;
  globalForJobs.attemptReconcileHandler = handlers.reconcileAttempt;
}

export function hashWaitpointSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function timingSafeHexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function emitAttemptSignal(attemptId: string): void {
  attemptEmitter.emit(attemptId);
}

export function waitForAttemptSignal(
  attemptId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onSignal = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      attemptEmitter.off(attemptId, onSignal);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      attemptEmitter.off(attemptId, onSignal);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    attemptEmitter.on(attemptId, onSignal);
  });
}

export const schemaTask = <S extends z.ZodType, O>(task: Task<S, O>) => task;

const HEARTBEAT_INTERVAL_MS = 10_000;

async function executeJobInBackground<S extends z.ZodType>(
  jobId: string,
  task: Task<S>,
  parsedPayload: z.output<S>,
  initialMetadata: Record<string, unknown> = {},
): Promise<void> {
  const context: JobContext = {
    jobId,
    metadata: { ...initialMetadata },
  };
  const timer = setInterval(() => {
    void db
      .update(backgroundJobTable)
      .set({ heartbeatAt: new Date(), workerId: getWorkerId() })
      .where(
        and(
          eq(backgroundJobTable.id, jobId),
          inArray(backgroundJobTable.status, ["running", "waiting"]),
        ),
      )
      .catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  try {
    const output = await currentJob.run(context, () => task.run(parsedPayload));
    await db
      .update(backgroundJobTable)
      .set({
        status: "done",
        metadata: context.metadata,
        output: output ?? null,
        error: null,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(eq(backgroundJobTable.id, jobId));
  } catch (error) {
    const safeMessage = getErrorMessage(error);
    await db
      .update(backgroundJobTable)
      .set({
        status: "failed",
        metadata: context.metadata,
        error: safeMessage,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(eq(backgroundJobTable.id, jobId))
      .catch(() => undefined);
    logger.error(`[${task.id}] run ${jobId} failed`, { error: safeMessage });
  } finally {
    clearInterval(timer);
  }
}

/** Starts a task in Postgres and runs it asynchronously in-process with heartbeats. */
export async function startRun<S extends z.ZodType>(
  task: Task<S>,
  payload: z.input<S>,
  options: {
    organizationId?: string;
    templateId?: string | null;
    status?: "running" | "queued";
  } = {},
): Promise<{ id: string }> {
  const parsed = task.schema.parse(payload);
  const payloadRecord =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  const organizationId =
    options.organizationId ??
    (typeof payloadRecord.organizationId === "string"
      ? payloadRecord.organizationId
      : "00000000-0000-4000-8000-000000000001");
  let templateId: string | null = null;
  if (options.templateId !== undefined) {
    templateId = options.templateId;
  } else if (typeof payloadRecord.templateId === "string") {
    templateId = payloadRecord.templateId;
  }
  const status = options.status ?? "running";

  const [job] = await db
    .insert(backgroundJobTable)
    .values({
      taskId: task.id,
      organizationId,
      templateId,
      status,
      payload: payloadRecord,
      metadata: {},
      workerId: status === "running" ? getWorkerId() : null,
      heartbeatAt: new Date(),
      startedAt: new Date(),
    })
    .returning({ id: backgroundJobTable.id });

  if (!job) {
    throw new Error(`Could not persist background job for ${task.id}.`);
  }

  if (status === "running") {
    void executeJobInBackground(job.id, task, parsed);
  }

  return { id: job.id };
}

/** Resumes an interrupted Postgres background job in this worker process. */
export function resumeRunInProcess<S extends z.ZodType>(
  jobId: string,
  task: Task<S>,
  rawPayload: unknown,
  existingMetadata: Record<string, unknown> = {},
): Promise<void> {
  const parsed = task.schema.parse(rawPayload);
  return executeJobInBackground(jobId, task, parsed, existingMetadata);
}

/** Runs of one task from Postgres, newest first. */
export async function listRuns(
  taskId: string,
  limit = 50,
): Promise<RunRecord[]> {
  const rows = await db
    .select()
    .from(backgroundJobTable)
    .where(eq(backgroundJobTable.taskId, taskId))
    .orderBy(desc(backgroundJobTable.startedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    organizationId: row.organizationId,
    templateId: row.templateId,
    payload: row.payload,
    status: row.status,
    metadata: row.metadata,
    output: row.output,
    error: row.error ? redactSecrets(row.error) : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

export const metadata = {
  set(key: string, value: unknown) {
    const ctx = currentJob.getStore();
    if (ctx) {
      ctx.metadata[key] = redactObject(value);
    }
  },
  async flush() {
    const ctx = currentJob.getStore();
    if (!ctx) return;
    await db
      .update(backgroundJobTable)
      .set({
        metadata: ctx.metadata,
        heartbeatAt: new Date(),
      })
      .where(eq(backgroundJobTable.id, ctx.jobId))
      .catch(() => undefined);
  },
};

export const wait = {
  for: ({ seconds }: { seconds: number }) => sleep(seconds * 1000),
};

export type WaitpointRecord = {
  id: string;
  attemptId: string;
  providerId: string;
  secretHash: string;
  status: JobWaitpointStatus;
  payload: unknown;
  expiresAt: Date;
  externalJobId: string | null;
};

export interface WaitpointStore {
  getById(id: string): Promise<WaitpointRecord | null>;
  markExpired(id: string): Promise<void>;
  consumePending(id: string, payload: unknown): Promise<boolean>;
  onConsumed?(attemptId: string, outcome: VideoWebhookOutcome): Promise<void>;
}

const postgresWaitpointStore: WaitpointStore = {
  async getById(id: string) {
    const rows = await db
      .select({
        id: jobWaitpointTable.id,
        attemptId: jobWaitpointTable.attemptId,
        providerId: jobWaitpointTable.providerId,
        secretHash: jobWaitpointTable.secretHash,
        status: jobWaitpointTable.status,
        payload: jobWaitpointTable.payload,
        expiresAt: jobWaitpointTable.expiresAt,
        externalJobId: renderAttemptTable.externalJobId,
      })
      .from(jobWaitpointTable)
      .innerJoin(
        renderAttemptTable,
        eq(renderAttemptTable.id, jobWaitpointTable.attemptId),
      )
      .where(eq(jobWaitpointTable.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async markExpired(id: string) {
    await db
      .update(jobWaitpointTable)
      .set({ status: "expired" })
      .where(
        and(
          eq(jobWaitpointTable.id, id),
          eq(jobWaitpointTable.status, "pending"),
        ),
      );
  },

  async consumePending(id: string, payload: unknown) {
    const updated = await db
      .update(jobWaitpointTable)
      .set({
        status: "completed",
        payload,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(jobWaitpointTable.id, id),
          eq(jobWaitpointTable.status, "pending"),
          sql`${jobWaitpointTable.expiresAt} > now()`,
        ),
      )
      .returning({ id: jobWaitpointTable.id });
    return updated.length > 0;
  },

  async onConsumed(attemptId: string) {
    emitAttemptSignal(attemptId);
    const handler = globalForJobs.attemptReconcileHandler;
    if (handler) {
      void handler(attemptId).catch((error) => {
        logger.error("Failed to reconcile waitpoint attempt", {
          attemptId,
          error: getErrorMessage(error),
        });
      });
    }
  },
};

export function setWaitpointStoreForTests(store: WaitpointStore | null): void {
  globalForJobs.waitpointStoreOverride = store;
}

/** Creates an authenticated single-use waitpoint row in Postgres and returns its callback URL. */
export async function createWaitpoint(options: {
  attemptId: string;
  providerId: string;
  timeoutMs: number;
}): Promise<{ id: string; url: string; expiresAt: Date }> {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashWaitpointSecret(secret);
  const expiresAt = new Date(Date.now() + options.timeoutMs);

  const [row] = await db
    .insert(jobWaitpointTable)
    .values({
      attemptId: options.attemptId,
      providerId: options.providerId,
      secretHash,
      status: "pending",
      expiresAt,
    })
    .returning({ id: jobWaitpointTable.id });

  if (!row) {
    throw new Error("Could not create waitpoint.");
  }

  return {
    id: row.id,
    url: `${getSiteUrl()}/api/waitpoints/${row.id}?token=${encodeURIComponent(secret)}`,
    expiresAt,
  };
}

export type ConsumeWaitpointResult =
  | { ok: true; status: 200; attemptId: string; outcome: VideoWebhookOutcome }
  | { ok: false; status: 400 | 401 | 404 | 409 | 410; message: string };

/**
 * Verifies waitpoint secret, optional provider signature, external job ID match, and
 * atomically consumes the waitpoint once.
 */
export async function consumeWaitpointWebhook(input: {
  id: string;
  secret: string | null;
  rawBody: string;
  body: unknown;
  request: Request;
  store?: WaitpointStore;
}): Promise<ConsumeWaitpointResult> {
  const store =
    input.store ??
    globalForJobs.waitpointStoreOverride ??
    postgresWaitpointStore;
  const record = await store.getById(input.id);
  if (!record) {
    return { ok: false, status: 404, message: "Unknown waitpoint token." };
  }

  if (!input.secret) {
    return { ok: false, status: 401, message: "Missing waitpoint secret." };
  }
  const providedHash = hashWaitpointSecret(input.secret);
  if (!timingSafeHexEquals(providedHash, record.secretHash)) {
    return { ok: false, status: 401, message: "Invalid waitpoint secret." };
  }

  const provider = getVideoProviderById(record.providerId);
  if (provider.verifyWebhookRequest) {
    const valid = await provider.verifyWebhookRequest(
      input.request,
      input.rawBody,
      {},
    );
    if (!valid) {
      return {
        ok: false,
        status: 401,
        message: "Webhook provider signature verification failed.",
      };
    }
  }

  if (record.status === "completed") {
    return {
      ok: false,
      status: 409,
      message: "Waitpoint already consumed.",
    };
  }
  if (record.status === "expired" || record.expiresAt.getTime() <= Date.now()) {
    await store.markExpired(record.id);
    return { ok: false, status: 410, message: "Waitpoint expired." };
  }

  let outcome: VideoWebhookOutcome;
  try {
    outcome = provider.parseWebhook(input.body);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      message: getErrorMessage(error) || "Invalid webhook payload.",
    };
  }

  if (
    outcome.externalJobId &&
    record.externalJobId &&
    outcome.externalJobId !== record.externalJobId
  ) {
    return {
      ok: false,
      status: 400,
      message: "Webhook job id does not match waitpoint attempt.",
    };
  }

  const consumed = await store.consumePending(record.id, input.body);
  if (!consumed) {
    return {
      ok: false,
      status: 409,
      message: "Waitpoint already consumed or expired.",
    };
  }

  if (store.onConsumed) {
    await store.onConsumed(record.attemptId, outcome);
  }
  return { ok: true, status: 200, attemptId: record.attemptId, outcome };
}

export function startJobReconciler(intervalMs = 10_000): void {
  if (globalForJobs.reconcileTimer) return;
  const tick = () => {
    const handler = globalForJobs.reconcileHandler;
    if (!handler || globalForJobs.activeReconcilePromise) return;
    const promise = handler()
      .catch((error) => {
        logger.error("Job reconciliation sweep failed", {
          error: getErrorMessage(error),
        });
      })
      .finally(() => {
        globalForJobs.activeReconcilePromise = null;
      });
    globalForJobs.activeReconcilePromise = promise;
  };
  void tick();
  globalForJobs.reconcileTimer = setInterval(tick, intervalMs);
  globalForJobs.reconcileTimer.unref?.();
}

export function stopJobReconciler(): void {
  if (globalForJobs.reconcileTimer) {
    clearInterval(globalForJobs.reconcileTimer);
    globalForJobs.reconcileTimer = undefined;
  }
}

export async function markExpiredPendingWaitpoints(): Promise<void> {
  await db
    .update(jobWaitpointTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(jobWaitpointTable.status, "pending"),
        lt(jobWaitpointTable.expiresAt, new Date()),
      ),
    );
}

export const logger = {
  info: (message: string, data?: unknown) =>
    console.info(
      redactSecrets(message),
      data === undefined ? "" : redactObject(data),
    ),
  warn: (message: string, data?: unknown) =>
    console.warn(
      redactSecrets(message),
      data === undefined ? "" : redactObject(data),
    ),
  error: (message: string, data?: unknown) =>
    console.error(
      redactSecrets(message),
      data === undefined ? "" : redactObject(data),
    ),
};
