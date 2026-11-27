import "server-only";

import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { storageConfig } from "@/config/storage.config";
import { ProviderError } from "@/lib/ai/errors";
import {
  getVideoProviderById,
  resolveVideoProviderContext,
} from "@/lib/ai/providers/video/registry";
import type { VideoWebhookOutcome } from "@/lib/ai/providers/video/types";
import { checkRenderMismatch } from "@/lib/content-workflows/check-render";
import type { VideoCloneGeneration } from "@/lib/content-workflows/video-clone";
import {
  clearVideoClonePartGenerationsByIndex,
  requestVideoCloneStitch,
  setVideoCloneGenerationByIndex,
  setVideoClonePartGenerationByShot,
  setVideoCloneRewrite,
} from "@/lib/content-workflows/video-clone-store";
import { db } from "@/lib/db";
import {
  backgroundJobTable,
  contentTemplateTable,
  jobWaitpointTable,
  renderAttemptTable,
} from "@/lib/db/schema";
import {
  emitAttemptSignal,
  getWorkerId,
  logger,
  markExpiredPendingWaitpoints,
  registerReconcileHandlers,
  resumeRunInProcess,
} from "@/lib/jobs";
import { putObject } from "@/lib/storage";
import { getErrorMessage } from "@/lib/utils";
import { triggerTaskIds } from "@/trigger/shared";

const DEFAULT_STALE_WORKER_MS = 45_000;
const DOWNLOAD_LEASE_MS = 3 * 60_000;

async function updateTemplateGenerationFromAttempt(
  attempt: typeof renderAttemptTable.$inferSelect,
  patch: Pick<
    VideoCloneGeneration,
    "status" | "videoUrl" | "error" | "mismatches"
  >,
) {
  const generation: VideoCloneGeneration = {
    ...attempt.generationBase,
    model: attempt.canonicalModelId,
    providerId: attempt.providerId,
    attemptId: attempt.id,
    prompt: attempt.prompt,
    ...patch,
    ...(patch.error ? { error: getErrorMessage(patch.error) } : {}),
  };
  if (attempt.shot === -1) {
    await setVideoCloneGenerationByIndex(
      attempt.templateId,
      attempt.takeIndex,
      generation,
    );
    if (patch.status === "done") {
      await clearVideoClonePartGenerationsByIndex(
        attempt.templateId,
        attempt.takeIndex,
      );
    }
  } else {
    await setVideoClonePartGenerationByShot(
      attempt.templateId,
      attempt.takeIndex,
      attempt.shot,
      generation,
    );
  }
}

/** Marks an attempt and its corresponding take/shot in `content_templates` as failed. */
export async function failRenderAttempt(
  attemptId: string,
  errorMessage: string,
  errorKind?: string,
): Promise<void> {
  const safeError = getErrorMessage(errorMessage);
  const [updated] = await db
    .update(renderAttemptTable)
    .set({
      status: "failed",
      error: safeError,
      errorKind: errorKind ?? null,
      leaseUntil: null,
      workerId: null,
    })
    .where(
      and(
        eq(renderAttemptTable.id, attemptId),
        inArray(renderAttemptTable.status, [
          "claiming",
          "submitting",
          "submitted",
          "ambiguous",
          "downloading",
        ]),
      ),
    )
    .returning();

  if (!updated) return;

  await db
    .update(jobWaitpointTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(jobWaitpointTable.attemptId, attemptId),
        eq(jobWaitpointTable.status, "pending"),
      ),
    )
    .catch(() => undefined);

  await updateTemplateGenerationFromAttempt(updated, {
    status: "failed",
    error: safeError,
  });
  emitAttemptSignal(attemptId);
}

/**
 * Downloads the artifact (unless already stored in S3 on a prior crashed run), optionally runs
 * mismatch verification, writes the template take/part, marks attempt `done`, and schedules a
 * coalesced edit stitch.
 */
export async function finalizeRenderAttempt(
  attemptId: string,
  input: { artifactUrl?: string } = {},
): Promise<"done" | "failed" | "skipped"> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + DOWNLOAD_LEASE_MS);

  const [claimed] = await db
    .update(renderAttemptTable)
    .set({
      status: "downloading",
      workerId: getWorkerId(),
      leaseUntil,
      ...(input.artifactUrl ? { artifactUrl: input.artifactUrl } : {}),
    })
    .where(
      and(
        eq(renderAttemptTable.id, attemptId),
        inArray(renderAttemptTable.status, [
          "submitting",
          "submitted",
          "ambiguous",
          "downloading",
        ]),
        or(
          sql`${renderAttemptTable.status} <> 'downloading'`,
          sql`${renderAttemptTable.leaseUntil} IS NULL`,
          lt(renderAttemptTable.leaseUntil, now),
        ),
      ),
    )
    .returning();

  if (!claimed) {
    return "skipped";
  }

  try {
    const provider = getVideoProviderById(claimed.providerId);
    const ctx = resolveVideoProviderContext(provider);

    let videoUrl = claimed.storedVideoUrl ?? undefined;
    let downloadedBytes: Uint8Array | undefined;

    if (!videoUrl) {
      const artifactUrl = input.artifactUrl ?? claimed.artifactUrl ?? undefined;
      const downloaded = await provider.downloadArtifact(ctx, {
        artifactUrl,
        externalJobId: claimed.externalJobId ?? undefined,
      });
      downloadedBytes = downloaded.bytes;

      const bucket = storageConfig.bucketNames.images;
      const name = `take-${String(claimed.takeIndex).padStart(2, "0")}${claimed.shot === -1 ? "" : `-shot-${claimed.shot}`}`;
      const path = `video-clones/${claimed.organizationId}/generations/${claimed.templateId}/${name}-${crypto.randomUUID()}.mp4`;
      await putObject(path, bucket, downloaded.bytes, "video/mp4");
      videoUrl = `/storage/${bucket}/${path}`;

      // Checkpoint S3 URL before mismatch check / template update so a crash never re-downloads.
      await db
        .update(renderAttemptTable)
        .set({ storedVideoUrl: videoUrl })
        .where(eq(renderAttemptTable.id, claimed.id));
    }

    let mismatches: VideoCloneGeneration["mismatches"];
    if (downloadedBytes) {
      const template = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, claimed.templateId),
        columns: { structure: true },
      });
      const take = template?.structure.video?.takes.find(
        (item) => item.index === claimed.takeIndex,
      );
      const redoPos =
        claimed.shot === -1
          ? undefined
          : take?.parts.findIndex((item) => item.shot === claimed.shot);
      if (take && (redoPos === undefined || redoPos >= 0)) {
        mismatches = await checkRenderMismatch(
          take,
          redoPos,
          downloadedBytes,
          claimed.generationBase.changes,
        ).catch((error) => {
          logger.warn(`Couldn't check take ${claimed.takeIndex}'s render`, {
            error: getErrorMessage(error),
          });
          return undefined;
        });
      }
    }

    await updateTemplateGenerationFromAttempt(claimed, {
      status: "done",
      videoUrl,
      ...(mismatches ? { mismatches } : {}),
    });

    await db
      .update(renderAttemptTable)
      .set({
        status: "done",
        storedVideoUrl: videoUrl,
        leaseUntil: null,
        error: null,
        errorKind: null,
      })
      .where(eq(renderAttemptTable.id, claimed.id));

    await requestVideoCloneStitch(claimed.organizationId, claimed.templateId);
    emitAttemptSignal(attemptId);
    return "done";
  } catch (error) {
    const safeError = getErrorMessage(error);
    await failRenderAttempt(claimed.id, safeError);
    return "failed";
  }
}

/** Reconciles a single render attempt from waitpoint state, polling, or expiration. */
export async function reconcileRenderAttempt(
  attemptId: string,
  options: { forcePoll?: boolean } = {},
): Promise<void> {
  const attempt = await db.query.renderAttemptTable.findFirst({
    where: eq(renderAttemptTable.id, attemptId),
  });
  if (!attempt) return;
  if (attempt.status === "done" || attempt.status === "failed") {
    emitAttemptSignal(attempt.id);
    return;
  }

  const waitpoint = await db.query.jobWaitpointTable.findFirst({
    where: eq(jobWaitpointTable.attemptId, attempt.id),
  });
  if (waitpoint?.status === "completed" && waitpoint.payload != null) {
    const provider = getVideoProviderById(attempt.providerId);
    let outcome: VideoWebhookOutcome;
    try {
      outcome = provider.parseWebhook(waitpoint.payload);
    } catch (error) {
      await failRenderAttempt(attempt.id, getErrorMessage(error));
      return;
    }
    if (outcome.state === "failed") {
      await failRenderAttempt(attempt.id, outcome.error);
      return;
    }
    await finalizeRenderAttempt(attempt.id, {
      artifactUrl: outcome.artifactUrl,
    });
    return;
  }

  const now = new Date();
  if (attempt.status === "downloading") {
    if (!attempt.leaseUntil || attempt.leaseUntil <= now) {
      await finalizeRenderAttempt(attempt.id);
    }
    return;
  }

  const provider = getVideoProviderById(attempt.providerId);
  const canPoll =
    provider.capabilities.supportsPolling && Boolean(attempt.externalJobId);

  if (attempt.expiresAt <= now) {
    // One last poll before declaring expiry so a completed render isn't abandoned.
    if (canPoll && attempt.externalJobId) {
      try {
        const ctx = resolveVideoProviderContext(provider);
        const status = await provider.getStatus(ctx, {
          externalJobId: attempt.externalJobId,
          providerModelId: attempt.providerModelId,
          providerMetadata: attempt.providerMetadata ?? undefined,
        });
        if (status.state === "succeeded") {
          await finalizeRenderAttempt(attempt.id, {
            artifactUrl: status.artifactUrl,
          });
          return;
        }
        if (status.state === "failed") {
          await failRenderAttempt(attempt.id, status.error);
          return;
        }
      } catch {
        // Fall through to timeout failure.
      }
    }
    await failRenderAttempt(
      attempt.id,
      attempt.status === "ambiguous"
        ? "Render submission status remained ambiguous and timed out."
        : "The render timed out without finishing.",
      attempt.status === "ambiguous" ? "ambiguous_submit" : "transient",
    );
    return;
  }

  if (
    canPoll &&
    attempt.externalJobId &&
    (attempt.status === "submitted" || attempt.status === "ambiguous") &&
    (options.forcePoll || !attempt.nextPollAt || attempt.nextPollAt <= now)
  ) {
    await db
      .update(renderAttemptTable)
      .set({
        nextPollAt: new Date(Date.now() + provider.capabilities.pollIntervalMs),
      })
      .where(eq(renderAttemptTable.id, attempt.id));

    try {
      const ctx = resolveVideoProviderContext(provider);
      const status = await provider.getStatus(ctx, {
        externalJobId: attempt.externalJobId,
        providerModelId: attempt.providerModelId,
        providerMetadata: attempt.providerMetadata ?? undefined,
      });
      if (status.state === "succeeded") {
        await finalizeRenderAttempt(attempt.id, {
          artifactUrl: status.artifactUrl,
        });
      } else if (status.state === "failed") {
        await failRenderAttempt(attempt.id, status.error);
      }
    } catch (error) {
      if (
        error instanceof ProviderError &&
        !error.retryable &&
        error.kind !== "ambiguous_submit"
      ) {
        await failRenderAttempt(attempt.id, error.message, error.kind);
        return;
      }
      // Transient/429 errors keep polling; terminal status failures stop the attempt.
      logger.warn("Render status poll failed", {
        attemptId: attempt.id,
        error: getErrorMessage(error),
      });
    }
  }
}

/**
 * Reconciles all interrupted workers, in-flight renders, queued stitches, and any orphaned
 * `"generating"` rows after a process crash or dropped webhook.
 */
export async function reconcileInFlightWork(
  options: { staleWorkerMs?: number; forcePoll?: boolean } = {},
): Promise<{
  reconciledAttempts: number;
  resumedJobs: number;
  clearedOrphans: number;
}> {
  const staleMs = options.staleWorkerMs ?? DEFAULT_STALE_WORKER_MS;
  const staleCutoff = new Date(Date.now() - staleMs);
  const currentWorker = getWorkerId();

  await markExpiredPendingWaitpoints();

  // 1. Transition dead worker attempts left in claiming/submitting before they can block or double-submit.
  const staleWorkerJobs = await db
    .select({ id: backgroundJobTable.id })
    .from(backgroundJobTable)
    .where(
      and(
        inArray(backgroundJobTable.status, ["running", "waiting"]),
        lte(backgroundJobTable.heartbeatAt, staleCutoff),
        or(
          sql`${backgroundJobTable.workerId} IS NULL`,
          sql`${backgroundJobTable.workerId} <> ${currentWorker}`,
        ),
      ),
    );
  const deadJobIds = staleWorkerJobs.map((row) => row.id);

  if (deadJobIds.length > 0) {
    const deadClaiming = await db
      .select({ id: renderAttemptTable.id })
      .from(renderAttemptTable)
      .where(
        and(
          inArray(renderAttemptTable.jobId, deadJobIds),
          eq(renderAttemptTable.status, "claiming"),
        ),
      );
    for (const attempt of deadClaiming) {
      await failRenderAttempt(
        attempt.id,
        "Worker restarted before submitting the render.",
      );
    }

    await db
      .update(renderAttemptTable)
      .set({ status: "ambiguous" })
      .where(
        and(
          inArray(renderAttemptTable.jobId, deadJobIds),
          eq(renderAttemptTable.status, "submitting"),
        ),
      );
  }

  // 2. Reconcile active render attempts (completed waitpoints, due polls, expired attempts, expired leases).
  const activeAttempts = await db
    .select({
      id: renderAttemptTable.id,
      jobId: renderAttemptTable.jobId,
    })
    .from(renderAttemptTable)
    .where(
      inArray(renderAttemptTable.status, [
        "submitting",
        "submitted",
        "ambiguous",
        "downloading",
      ]),
    );

  const deadJobSet = new Set(deadJobIds);
  for (const attempt of activeAttempts) {
    await reconcileRenderAttempt(attempt.id, {
      forcePoll: options.forcePoll || deadJobSet.has(attempt.jobId),
    });
  }

  // 3. Reclaim interrupted jobs from dead workers.
  let resumedJobs = 0;
  for (const deadJob of staleWorkerJobs) {
    const [claimedJob] = await db
      .update(backgroundJobTable)
      .set({
        workerId: currentWorker,
        heartbeatAt: new Date(),
      })
      .where(
        and(
          eq(backgroundJobTable.id, deadJob.id),
          inArray(backgroundJobTable.status, ["running", "waiting"]),
          lte(backgroundJobTable.heartbeatAt, staleCutoff),
        ),
      )
      .returning();

    if (!claimedJob) continue;
    resumedJobs += 1;

    if (claimedJob.taskId === triggerTaskIds.generateVideoClone) {
      const { generateVideoCloneTask } = await import(
        "@/trigger/generate-video-clone"
      );
      void resumeRunInProcess(
        claimedJob.id,
        generateVideoCloneTask,
        claimedJob.payload,
        claimedJob.metadata,
      );
    } else if (claimedJob.taskId === triggerTaskIds.stitchVideoClone) {
      const { stitchVideoCloneTask } = await import(
        "@/trigger/stitch-video-clone"
      );
      void resumeRunInProcess(
        claimedJob.id,
        stitchVideoCloneTask,
        claimedJob.payload,
        claimedJob.metadata,
      );
    } else {
      await db
        .update(backgroundJobTable)
        .set({
          status: "failed",
          error: "Task interrupted by server restart.",
          finishedAt: new Date(),
        })
        .where(eq(backgroundJobTable.id, claimedJob.id));

      if (
        claimedJob.taskId === triggerTaskIds.rewriteVideoClone &&
        claimedJob.templateId
      ) {
        const payload = claimedJob.payload as {
          changes?: string;
          productFolder?: string | null;
          startedAt?: string;
        };
        await setVideoCloneRewrite(claimedJob.templateId, {
          status: "failed",
          changes: payload.changes ?? "",
          productFolder: payload.productFolder ?? null,
          startedAt: payload.startedAt ?? new Date().toISOString(),
          error: "Rewrite interrupted by server restart.",
        });
      }
    }
  }

  // 4. Sweep content_templates for orphaned "generating" takes/shots or "stitching" edits with no live job/attempt.
  let clearedOrphans = 0;
  const templates = await db
    .select({
      id: contentTemplateTable.id,
      structure: contentTemplateTable.structure,
    })
    .from(contentTemplateTable)
    .where(sql`${contentTemplateTable.structure}->'video' is not null`);

  for (const tpl of templates) {
    const video = tpl.structure.video;
    if (!video) continue;
    const hasGenerating = video.takes.some(
      (take) =>
        take.generation?.status === "generating" ||
        take.parts.some((part) => part.generation?.status === "generating"),
    );
    const hasStitching = video.edit?.status === "stitching";
    if (!hasGenerating && !hasStitching) continue;

    const liveAttempts = await db
      .select({
        takeIndex: renderAttemptTable.takeIndex,
        shot: renderAttemptTable.shot,
      })
      .from(renderAttemptTable)
      .where(
        and(
          eq(renderAttemptTable.templateId, tpl.id),
          inArray(renderAttemptTable.status, [
            "claiming",
            "submitting",
            "submitted",
            "ambiguous",
            "downloading",
          ]),
        ),
      );
    const liveJobs = await db
      .select({ taskId: backgroundJobTable.taskId })
      .from(backgroundJobTable)
      .where(
        and(
          eq(backgroundJobTable.templateId, tpl.id),
          inArray(backgroundJobTable.status, ["running", "waiting", "queued"]),
        ),
      );
    const hasLiveGenerateJob = liveJobs.some(
      (j) => j.taskId === triggerTaskIds.generateVideoClone,
    );
    const hasLiveStitchJob = liveJobs.some(
      (j) => j.taskId === triggerTaskIds.stitchVideoClone,
    );

    if (hasGenerating && !hasLiveGenerateJob) {
      const activeKeys = new Set(
        liveAttempts.map((item) => `${item.takeIndex}:${item.shot}`),
      );
      for (const take of video.takes) {
        if (
          take.generation?.status === "generating" &&
          !activeKeys.has(`${take.index}:-1`)
        ) {
          await setVideoCloneGenerationByIndex(tpl.id, take.index, {
            ...take.generation,
            status: "failed",
            error: "The render stopped without finishing.",
          });
          clearedOrphans += 1;
        }
        for (const part of take.parts) {
          if (
            part.generation?.status === "generating" &&
            !activeKeys.has(`${take.index}:${part.shot}`)
          ) {
            await setVideoClonePartGenerationByShot(
              tpl.id,
              take.index,
              part.shot,
              {
                ...part.generation,
                status: "failed",
                error: "The render stopped without finishing.",
              },
            );
            clearedOrphans += 1;
          }
        }
      }
    }

    if (
      hasStitching &&
      !hasLiveStitchJob &&
      !hasLiveGenerateJob &&
      liveAttempts.length === 0
    ) {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select({ structure: contentTemplateTable.structure })
          .from(contentTemplateTable)
          .where(eq(contentTemplateTable.id, tpl.id))
          .for("update");
        const current = rows[0]?.structure.video;
        if (current?.edit?.status === "stitching") {
          current.edit = {
            ...current.edit,
            status: "failed",
            error: "The stitch stopped without finishing.",
          };
          await tx
            .update(contentTemplateTable)
            .set({ structure: { ...rows[0]?.structure, video: current } })
            .where(eq(contentTemplateTable.id, tpl.id));
          clearedOrphans += 1;
        }
      });
    }
  }

  return {
    reconciledAttempts: activeAttempts.length,
    resumedJobs,
    clearedOrphans,
  };
}

registerReconcileHandlers({
  reconcileAll: () => reconcileInFlightWork(),
  reconcileAttempt: (attemptId) => reconcileRenderAttempt(attemptId),
});
