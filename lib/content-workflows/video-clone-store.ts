import "server-only";

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { z } from "zod/v4";
import { storageConfig } from "@/config/storage.config";
import {
  resolveActiveVideoProvider,
  resolveModelForProvider,
} from "@/lib/ai/video-provider";
import { db } from "@/lib/db";
import {
  backgroundJobTable,
  contentTemplateTable,
  creativeAssetFolderTable,
  creativeAssetTable,
  faceTable,
  renderAttemptTable,
} from "@/lib/db/schema";
import { getWorkerId, resumeRunInProcess } from "@/lib/jobs";
import { runPreflight } from "@/lib/preflight";
import { getPublicSignedUrl, getSignedUploadUrl } from "@/lib/storage";
import { getErrorMessage } from "@/lib/utils";
import type { analyzeVideoCloneTask } from "@/trigger/analyze-video-clone";
import type { generateVideoCloneTask } from "@/trigger/generate-video-clone";
import type { rewriteVideoCloneTask } from "@/trigger/rewrite-video-clone";
import { tasks, triggerTaskIds } from "@/trigger/shared";
import type { stitchVideoCloneTask } from "@/trigger/stitch-video-clone";
import {
  type generateVideoCloneInputSchema,
  keepsOriginal,
  MAX_VIDEO_CLONE_PRODUCTS,
  type RenderCuts,
  type rewriteVideoCloneInputSchema,
  settleDeadRenders,
  type VideoClone,
  type VideoCloneGeneration,
  type VideoCloneModel,
  type VideoClonePart,
  type VideoCloneTakeAnalysis,
  videoCloneRenders,
  videoCloneSourceName,
} from "./video-clone";

/**
 * Runs `fn` inside a Postgres transaction holding a `FOR UPDATE` row lock on the clone template,
 * eliminating positional `jsonb_set` races and concurrent overwrite hazards.
 */
export async function withLockedCloneTemplate<T>(
  templateId: string,
  fn: (
    video: VideoClone,
    row: { id: string; organizationId: string; name: string },
  ) => Promise<{ result: T; nextVideo?: VideoClone }>,
  organizationId?: string,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const whereClause = organizationId
      ? and(
          eq(contentTemplateTable.id, templateId),
          eq(contentTemplateTable.organizationId, organizationId),
        )
      : eq(contentTemplateTable.id, templateId);

    const rows = await tx
      .select({
        id: contentTemplateTable.id,
        organizationId: contentTemplateTable.organizationId,
        name: contentTemplateTable.name,
        structure: contentTemplateTable.structure,
      })
      .from(contentTemplateTable)
      .where(whereClause)
      .for("update");

    const row = rows[0];
    const video = row?.structure.video;
    if (!row || !video) return null;

    const { result, nextVideo } = await fn(structuredClone(video), {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
    });

    if (nextVideo) {
      await tx
        .update(contentTemplateTable)
        .set({
          structure: { ...row.structure, video: nextVideo },
        })
        .where(eq(contentTemplateTable.id, row.id));
    }

    return result;
  });
}

function preservePaidRender(
  current: VideoCloneGeneration | undefined,
  existingHistory: VideoCloneGeneration[] | undefined,
): VideoCloneGeneration[] | undefined {
  const list = [...(existingHistory ?? [])];
  if (
    current?.status === "done" &&
    current.videoUrl &&
    !list.some((item) => item.videoUrl === current.videoUrl)
  ) {
    list.push(current);
  }
  return list.length > 0 ? list : undefined;
}

function sanitizeGeneration(
  generation: VideoCloneGeneration,
): VideoCloneGeneration {
  return generation.error
    ? { ...generation, error: getErrorMessage(generation.error) }
    : generation;
}

/** Updates one take's generation by stable `takeIndex` under row lock, preserving prior paid renders. */
export async function setVideoCloneGenerationByIndex(
  templateId: string,
  takeIndex: number,
  generation: VideoCloneGeneration,
): Promise<boolean> {
  const safeGeneration = sanitizeGeneration(generation);
  const updated = await withLockedCloneTemplate(templateId, async (video) => {
    const take = video.takes.find((item) => item.index === takeIndex);
    if (!take) return { result: false };
    take.renders = preservePaidRender(take.generation, take.renders);
    take.generation = safeGeneration;
    return { result: true, nextVideo: video };
  });
  return updated ?? false;
}

/** Updates one shot's own generation by stable `(takeIndex, shot)` under row lock. */
export async function setVideoClonePartGenerationByShot(
  templateId: string,
  takeIndex: number,
  shot: number,
  generation: VideoCloneGeneration,
): Promise<boolean> {
  const safeGeneration = sanitizeGeneration(generation);
  const updated = await withLockedCloneTemplate(templateId, async (video) => {
    const take = video.takes.find((item) => item.index === takeIndex);
    const part = take?.parts.find((item) => item.shot === shot);
    if (!part) return { result: false };
    part.renders = preservePaidRender(part.generation, part.renders);
    part.generation = safeGeneration;
    return { result: true, nextVideo: video };
  });
  return updated ?? false;
}

/** Restores every part of a take to play the take's render while preserving prior part renders. */
export async function clearVideoClonePartGenerationsByIndex(
  templateId: string,
  takeIndex: number,
): Promise<void> {
  await withLockedCloneTemplate(templateId, async (video) => {
    const take = video.takes.find((item) => item.index === takeIndex);
    if (!take) return { result: undefined };
    for (const part of take.parts) {
      part.renders = preservePaidRender(part.generation, part.renders);
      delete part.generation;
      delete part.takeRender;
    }
    return { result: undefined, nextVideo: video };
  });
}

export async function setVideoCloneBurnText(
  organizationId: string,
  templateId: string,
  burnText: boolean,
): Promise<boolean> {
  const updated = await withLockedCloneTemplate(
    templateId,
    async (video) => {
      video.burnText = burnText;
      return { result: true, nextVideo: video };
    },
    organizationId,
  );
  return updated ?? false;
}

export async function setVideoCloneRewrite(
  templateId: string,
  rewrite: NonNullable<VideoClone["rewrite"]>,
): Promise<void> {
  const safeRewrite = rewrite.error
    ? { ...rewrite, error: getErrorMessage(rewrite.error) }
    : rewrite;
  await withLockedCloneTemplate(templateId, async (video) => {
    video.rewrite = safeRewrite;
    return { result: undefined, nextVideo: video };
  });
}

/**
 * Applies all rewritten takes, retimed parts, and added/removed takes in ONE atomic locked
 * transaction so parallel renders can never drift or lose changes.
 */
export async function applyAtomicRewritePlan(
  templateId: string,
  input: {
    takes: {
      index: number;
      prompt: string;
      dialogue: VideoCloneTakeAnalysis["dialogue"] | null;
      parts: VideoClonePart[] | null;
    }[];
    addition: {
      takes: VideoClone["takes"];
      story: number[];
      continuity?: VideoClone["continuity"];
      removed: number[];
    } | null;
  },
): Promise<void> {
  await withLockedCloneTemplate(templateId, async (video) => {
    if (input.addition?.removed.length) {
      const activeRendering = video.takes.some((take) =>
        [take.generation, ...take.parts.map((part) => part.generation)].some(
          (generation) => generation?.status === "generating",
        ),
      );
      if (activeRendering) {
        throw new Error(
          "This change merges takes; wait for the renders to finish, then submit it again.",
        );
      }
    }

    for (const patch of input.takes) {
      const existing = video.takes.find((item) => item.index === patch.index);
      if (!existing) continue;
      existing.analysis = {
        ...existing.analysis,
        prompt: patch.prompt,
        dialogue: patch.dialogue ?? existing.analysis.dialogue,
      };
      if (patch.parts) {
        existing.parts = patch.parts;
        existing.seconds = patch.parts.at(-1)?.takeEnd ?? existing.seconds;
      }
    }

    if (input.addition) {
      const removedSet = new Set(input.addition.removed);
      for (const addedTake of input.addition.takes) {
        const idx = video.takes.findIndex(
          (item) => item.index === addedTake.index,
        );
        if (idx >= 0) {
          const prev = video.takes[idx];
          video.takes[idx] = {
            ...addedTake,
            model: prev?.model,
            products: prev?.products,
          };
        } else {
          video.takes.push(addedTake);
        }
      }
      if (removedSet.size > 0) {
        video.takes = video.takes.filter((item) => !removedSet.has(item.index));
      }
      video.story = input.addition.story;
      if (input.addition.continuity) {
        video.continuity = input.addition.continuity;
      }
    }

    return { result: undefined, nextVideo: video };
  });
}

/**
 * Marks `edit.status = "stitching"` with an incremented monotonic `revision`, and ensures at most
 * one running and one coalesced queued `stitch-video-clone` job exist per template.
 */
export async function requestVideoCloneStitch(
  organizationId: string,
  templateId: string,
): Promise<number> {
  const revision = await withLockedCloneTemplate(
    templateId,
    async (video) => {
      const nextRevision = (video.edit?.revision ?? 0) + 1;
      video.edit = {
        videoUrl: video.edit?.videoUrl,
        textVideoUrl: video.edit?.textVideoUrl,
        rendered: video.edit?.rendered ?? [],
        parts: video.edit?.parts,
        startedAt: new Date().toISOString(),
        status: "stitching",
        revision: nextRevision,
      };
      return { result: nextRevision, nextVideo: video };
    },
    organizationId,
  );
  if (revision === null) return 0;

  const jobIdToStart = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
    );
    const activeStitches = await tx
      .select({
        id: backgroundJobTable.id,
        status: backgroundJobTable.status,
      })
      .from(backgroundJobTable)
      .where(
        and(
          eq(backgroundJobTable.taskId, triggerTaskIds.stitchVideoClone),
          eq(backgroundJobTable.templateId, templateId),
          inArray(backgroundJobTable.status, ["running", "queued"]),
        ),
      );

    const hasRunning = activeStitches.some((job) => job.status === "running");
    const hasQueued = activeStitches.some((job) => job.status === "queued");
    if (!hasRunning) {
      const [inserted] = await tx
        .insert(backgroundJobTable)
        .values({
          taskId: triggerTaskIds.stitchVideoClone,
          organizationId,
          templateId,
          status: "running",
          payload: { organizationId, templateId },
          metadata: {},
          workerId: getWorkerId(),
          heartbeatAt: new Date(),
          startedAt: new Date(),
        })
        .returning({ id: backgroundJobTable.id });
      return inserted?.id ?? null;
    }
    if (!hasQueued) {
      await tx.insert(backgroundJobTable).values({
        taskId: triggerTaskIds.stitchVideoClone,
        organizationId,
        templateId,
        status: "queued",
        payload: { organizationId, templateId },
        metadata: {},
        workerId: null,
        heartbeatAt: new Date(),
        startedAt: new Date(),
      });
    }
    return null;
  });

  if (jobIdToStart) {
    const { stitchVideoCloneTask } = await import(
      "@/trigger/stitch-video-clone"
    );
    void resumeRunInProcess(jobIdToStart, stitchVideoCloneTask, {
      organizationId,
      templateId,
    });
  }

  return revision;
}

/** Backwards-compatible wrapper used by rewrite/pick/remove callers. */
export async function startVideoCloneStitch(
  organizationId: string,
  templateId: string,
  _previous?: VideoClone["edit"],
): Promise<void> {
  await requestVideoCloneStitch(organizationId, templateId);
}

/**
 * Commits a finished or failed stitch ONLY if `edit.revision` still matches `targetRevision`,
 * preventing an older stitch finishing late from overwriting a newer edit.
 */
export async function commitVideoCloneEdit(
  templateId: string,
  targetRevision: number,
  editPatch: NonNullable<VideoClone["edit"]>,
  renderCuts?: Record<string, RenderCuts>,
): Promise<{ committed: boolean; currentRevision: number }> {
  const safePatch = editPatch.error
    ? { ...editPatch, error: getErrorMessage(editPatch.error) }
    : editPatch;
  const result = await withLockedCloneTemplate(templateId, async (video) => {
    if (renderCuts && Object.keys(renderCuts).length > 0) {
      video.renderCuts = { ...(video.renderCuts ?? {}), ...renderCuts };
    }
    const currentRevision = video.edit?.revision ?? 0;
    if (currentRevision !== targetRevision) {
      return {
        result: { committed: false, currentRevision },
        nextVideo: renderCuts ? video : undefined,
      };
    }
    video.edit = {
      ...safePatch,
      revision: targetRevision,
    };
    return {
      result: { committed: true, currentRevision },
      nextVideo: video,
    };
  });
  return result ?? { committed: false, currentRevision: 0 };
}

/** Atomically claims the next queued `stitch-video-clone` job for a template, if any. */
export async function claimNextQueuedStitchJob(templateId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
    );
    const candidates = await tx
      .select()
      .from(backgroundJobTable)
      .where(
        and(
          eq(backgroundJobTable.taskId, triggerTaskIds.stitchVideoClone),
          eq(backgroundJobTable.templateId, templateId),
          eq(backgroundJobTable.status, "queued"),
        ),
      )
      .orderBy(asc(backgroundJobTable.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    const next = candidates[0];
    if (!next) return null;

    const [claimed] = await tx
      .update(backgroundJobTable)
      .set({
        status: "running",
        workerId: getWorkerId(),
        heartbeatAt: new Date(),
        startedAt: new Date(),
      })
      .where(eq(backgroundJobTable.id, next.id))
      .returning();

    return claimed ?? null;
  });
}

// A rewrite still "rewriting" after this died without saying so; another may start.
const REWRITE_STALE_MS = 15 * 60 * 1000;

export async function startVideoCloneRewrite(
  input: Omit<z.infer<typeof rewriteVideoCloneInputSchema>, "startedAt">,
  options: { skipPreflight?: boolean } = {},
): Promise<{ startedAt: string } | { error: string }> {
  if (!options.skipPreflight) {
    const preflight = await runPreflight({ scope: "rewrite" });
    if (!preflight.ok) {
      return {
        error:
          preflight.checks.find((c) => !c.ok)?.details ??
          "Preflight check failed.",
      };
    }
  }
  const plan = await findVideoClone(input.organizationId, input.templateId);
  if (!plan) return { error: "Clone plan not found." };
  const running = plan.video.rewrite;
  if (
    running?.status === "rewriting" &&
    Date.now() - Date.parse(running.startedAt) < REWRITE_STALE_MS
  ) {
    return { error: "A change is still being applied; wait for it to finish." };
  }
  if (input.productFolder) {
    const found = await findProductImages(
      input.organizationId,
      input.productFolder,
    );
    if ("error" in found) return found;
  }
  const rewrite = {
    status: "rewriting" as const,
    changes: input.changes,
    productFolder: input.productFolder,
    startedAt: new Date().toISOString(),
  };
  await setVideoCloneRewrite(plan.id, rewrite);
  try {
    await tasks.trigger<typeof rewriteVideoCloneTask>(
      triggerTaskIds.rewriteVideoClone,
      { ...input, startedAt: rewrite.startedAt },
    );
    return { startedAt: rewrite.startedAt };
  } catch (error) {
    await setVideoCloneRewrite(plan.id, {
      ...rewrite,
      status: "failed",
      error: getErrorMessage(error) || "Couldn't start applying the change.",
    });
    throw error;
  }
}

/** Edits one take's prompt, dialogue, pinned products, model, or whether it keeps the original footage. */
export async function updateVideoCloneTake(
  organizationId: string,
  input: {
    templateId: string;
    takeIndex: number;
    prompt?: string;
    dialogue?: VideoCloneTakeAnalysis["dialogue"];
    products?: string[];
    model?: VideoCloneModel;
    keepOriginal?: boolean;
  },
) {
  let canonicalModel: string | undefined;
  if (input.model) {
    try {
      const { provider } = resolveActiveVideoProvider();
      canonicalModel = resolveModelForProvider(provider, input.model).id;
    } catch (error) {
      return { error: getErrorMessage(error) };
    }
  }

  let validatedProducts: string[] | undefined;
  if (input.products) {
    validatedProducts = [...new Set(input.products)];
    const images = await findAssetImages(organizationId, validatedProducts);
    if (images.length !== validatedProducts.length) {
      return { error: "Products must be images from Assets." };
    }
  }

  type UpdateTakeOutcome =
    | { error: string }
    | {
        take: VideoClone["takes"][number];
        previous: VideoClone["takes"][number];
        needsStitch: boolean;
      };

  const outcome = await withLockedCloneTemplate<UpdateTakeOutcome>(
    input.templateId,
    async (video) => {
      const take = video.takes.find((item) => item.index === input.takeIndex);
      if (!take) return { result: { error: "Unknown take." as const } };
      if (input.keepOriginal && !take.videoUrl) {
        return {
          result: {
            error: `Take ${take.index} was added by your changes; it has no original footage to keep.`,
          },
        };
      }
      const previous = structuredClone(take);
      if (canonicalModel) take.model = canonicalModel;
      if (input.keepOriginal !== undefined) {
        take.keepOriginal = input.keepOriginal;
      }
      if (validatedProducts) take.products = validatedProducts;
      if (input.prompt !== undefined || input.dialogue !== undefined) {
        take.analysis = {
          ...take.analysis,
          prompt: input.prompt ?? take.analysis.prompt,
          dialogue: input.dialogue ?? take.analysis.dialogue,
        };
      }
      const needsStitch =
        keepsOriginal(take) !== keepsOriginal(previous) &&
        previous.generation?.status === "done";
      return {
        result: { take: structuredClone(take), previous, needsStitch },
        nextVideo: video,
      };
    },
    organizationId,
  );

  if (!outcome) return { error: "Clone plan not found." };
  if ("error" in outcome) return outcome;
  if (outcome.needsStitch) {
    await requestVideoCloneStitch(organizationId, input.templateId);
  }
  return { take: outcome.take, previous: outcome.previous };
}

/** Puts a finished render back in the edit and re-stitches, inside a locked row transaction. */
export async function pickVideoCloneRender(
  organizationId: string,
  input: {
    templateId: string;
    takeIndex: number;
    shot?: number;
    videoUrl: string;
  },
) {
  type PickRenderOutcome =
    | { error: string }
    | { picked: boolean; needsStitch: boolean };

  const outcome = await withLockedCloneTemplate<PickRenderOutcome>(
    input.templateId,
    async (video) => {
      const take = video.takes.find((item) => item.index === input.takeIndex);
      if (!take) return { result: { error: "Unknown take." as const } };

      if (
        [take.generation, ...take.parts.map((part) => part.generation)].some(
          (generation) => generation?.status === "generating",
        )
      ) {
        return {
          result: {
            error: `Take ${take.index} is rendering; pick a version once it's done.`,
          },
        };
      }

      const current =
        take.generation?.status === "done"
          ? take.generation.videoUrl
          : undefined;
      const fromTake = videoCloneRenders(take).find(
        (render) => render.videoUrl === input.videoUrl,
      );

      if (input.shot === undefined) {
        if (!fromTake) return { result: { error: "Unknown render." as const } };
        const picks = take.parts.some(
          (part) => part.takeRender || part.generation?.status === "done",
        );
        if (fromTake.videoUrl === current && !picks) {
          return { result: { picked: false, needsStitch: false } };
        }
        take.renders = preservePaidRender(take.generation, take.renders);
        take.generation = fromTake;
        for (const part of take.parts) {
          part.renders = preservePaidRender(part.generation, part.renders);
          delete part.generation;
          delete part.takeRender;
        }
      } else {
        const part = take.parts.find((item) => item.shot === input.shot);
        if (!part) return { result: { error: "Unknown shot." as const } };
        const own = videoCloneRenders(part).find(
          (render) => render.videoUrl === input.videoUrl,
        );
        if (!own && !fromTake) {
          return { result: { error: "Unknown render." as const } };
        }
        const playing =
          part.generation?.status === "done"
            ? part.generation.videoUrl
            : (part.takeRender ?? current);
        if (playing === input.videoUrl) {
          return { result: { picked: false, needsStitch: false } };
        }
        part.renders = preservePaidRender(part.generation, part.renders);
        if (own) {
          part.generation = own;
          delete part.takeRender;
        } else {
          delete part.generation;
          if (input.videoUrl === current) {
            delete part.takeRender;
          } else {
            part.takeRender = input.videoUrl;
          }
        }
      }

      return {
        result: { picked: true, needsStitch: !keepsOriginal(take) },
        nextVideo: video,
      };
    },
    organizationId,
  );

  if (!outcome) return { error: "Clone plan not found." };
  if ("error" in outcome) return outcome;
  if (outcome.needsStitch) {
    await requestVideoCloneStitch(organizationId, input.templateId);
  }
  return { picked: outcome.picked };
}

/**
 * Removes a take that changes added, and its shots from the story and continuity.
 */
export async function removeVideoCloneTake(
  organizationId: string,
  templateId: string,
  takeIndex: number,
) {
  type RemoveTakeOutcome =
    | { error: string }
    | { removed: number; needsStitch: boolean };

  const outcome = await withLockedCloneTemplate<RemoveTakeOutcome>(
    templateId,
    async (video) => {
      const take = video.takes.find((item) => item.index === takeIndex);
      if (!take) return { result: { error: "Unknown take." as const } };
      if (take.videoUrl) {
        return {
          result: {
            error: "Only takes your changes added can be removed." as const,
          },
        };
      }
      if (
        video.rewrite?.status === "rewriting" ||
        video.takes.some((item) =>
          [item.generation, ...item.parts.map((part) => part.generation)].some(
            (generation) => generation?.status === "generating",
          ),
        )
      ) {
        return {
          result: {
            error:
              "Wait for the renders and changes to finish, then remove it." as const,
          },
        };
      }

      const shots = new Set(take.parts.map((part) => part.shot));
      video.takes = video.takes.filter((item) => item.index !== takeIndex);
      if (video.story) {
        video.story = video.story.filter((shot) => !shots.has(shot));
      }
      if (video.continuity) {
        video.continuity = video.continuity.map((element) => ({
          ...element,
          shots: element.shots.filter((shot) => !shots.has(shot)),
        }));
      }
      const needsStitch = Boolean(video.edit?.rendered.includes(takeIndex));
      return {
        result: { removed: takeIndex, needsStitch },
        nextVideo: video,
      };
    },
    organizationId,
  );

  if (!outcome) return { error: "Clone plan not found." };
  if ("error" in outcome) return outcome;
  if (outcome.needsStitch) {
    await requestVideoCloneStitch(organizationId, templateId);
  }
  return { removed: outcome.removed };
}

export async function deleteVideoClone(
  organizationId: string,
  templateId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(contentTemplateTable)
    .where(
      and(
        eq(contentTemplateTable.id, templateId),
        eq(contentTemplateTable.organizationId, organizationId),
        eq(contentTemplateTable.format, "video"),
        sql`${contentTemplateTable.structure}->'video' is not null`,
      ),
    )
    .returning({ id: contentTemplateTable.id });
  return deleted.length > 0;
}

export const findAssetImages = (organizationId: string, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : db
        .select({
          id: creativeAssetTable.id,
          name: creativeAssetTable.name,
          url: creativeAssetTable.url,
        })
        .from(creativeAssetTable)
        .where(
          and(
            eq(creativeAssetTable.organizationId, organizationId),
            inArray(creativeAssetTable.id, ids),
            eq(creativeAssetTable.mediaType, "image"),
          ),
        );

export const listVideoCloneProductOptions = (organizationId: string) =>
  db
    .select({
      id: creativeAssetTable.id,
      name: creativeAssetTable.name,
      url: creativeAssetTable.url,
      folder: creativeAssetFolderTable.name,
    })
    .from(creativeAssetTable)
    .innerJoin(
      creativeAssetFolderTable,
      eq(creativeAssetFolderTable.id, creativeAssetTable.folderId),
    )
    .where(
      and(
        eq(creativeAssetTable.organizationId, organizationId),
        eq(creativeAssetTable.mediaType, "image"),
      ),
    )
    .orderBy(
      asc(creativeAssetFolderTable.name),
      asc(creativeAssetTable.createdAt),
    );

export async function findVideoClone(
  organizationId: string,
  templateId: string,
) {
  const template = await db.query.contentTemplateTable.findFirst({
    where: and(
      eq(contentTemplateTable.id, templateId),
      eq(contentTemplateTable.organizationId, organizationId),
    ),
    columns: { id: true, name: true, structure: true },
  });
  const video = template?.structure.video;
  return template && video
    ? {
        id: template.id,
        name: template.name,
        video: settleDeadRenders(video),
      }
    : undefined;
}

export async function findProductImages(
  organizationId: string,
  folderName: string,
): Promise<{ images: { name: string; url: string }[] } | { error: string }> {
  const folders = await db
    .select({
      id: creativeAssetFolderTable.id,
      name: creativeAssetFolderTable.name,
    })
    .from(creativeAssetFolderTable)
    .where(eq(creativeAssetFolderTable.organizationId, organizationId));
  const folder = folders.find((candidate) => candidate.name === folderName);
  if (!folder) {
    const names = folders.map((candidate) => `"${candidate.name}"`).join(", ");
    return {
      error: `No gallery folder named "${folderName}". Folders: ${names || "none yet"}.`,
    };
  }
  const images = await db.query.creativeAssetTable.findMany({
    where: and(
      eq(creativeAssetTable.organizationId, organizationId),
      eq(creativeAssetTable.folderId, folder.id),
      eq(creativeAssetTable.mediaType, "image"),
    ),
    columns: { name: true, url: true },
    orderBy: [asc(creativeAssetTable.createdAt)],
  });
  if (images.length === 0) {
    return { error: `"${folderName}" has no images to use as products.` };
  }
  if (images.length > MAX_VIDEO_CLONE_PRODUCTS) {
    return {
      error: `"${folderName}" has ${images.length} images; keep up to ${MAX_VIDEO_CLONE_PRODUCTS} product photos in it.`,
    };
  }
  return { images };
}

/**
 * Validates provider, preflight, references, and atomic non-overlapping active-render guards,
 * marks the selected takes/shot `"generating"`, and launches `generateVideoCloneTask`.
 */
export async function startVideoCloneRender(
  input: Omit<z.infer<typeof generateVideoCloneInputSchema>, "startedAt">,
  options: { skipPreflight?: boolean } = {},
): Promise<{ runId: string } | { error: string }> {
  let provider: ReturnType<typeof resolveActiveVideoProvider>["provider"];
  try {
    provider = resolveActiveVideoProvider().provider;
  } catch (error) {
    return { error: getErrorMessage(error) };
  }

  if (!options.skipPreflight) {
    const preflight = await runPreflight({ scope: "render" });
    if (!preflight.ok) {
      return {
        error:
          preflight.checks.find((c) => !c.ok)?.details ??
          "Preflight check failed.",
      };
    }
  }

  const faceIds = [...new Set(Object.values(input.cast))];
  const faces = await findFaces(input.organizationId, faceIds);
  if (faces.length !== faceIds.length) {
    return { error: "Face not found." };
  }
  if (input.productFolder) {
    const products = await findProductImages(
      input.organizationId,
      input.productFolder,
    );
    if ("error" in products) return products;
  }

  const uploads = `/storage/${storageConfig.bucketNames.images}/creative-assets/uploads/`;
  if (
    input.frames.some(
      (url) =>
        !url.startsWith(uploads) ||
        !/^[0-9a-f-]{36}$/u.test(url.slice(uploads.length)),
    )
  ) {
    return { error: "Attach frames from the timeline." };
  }

  const startedAt = new Date().toISOString();
  const baseGeneration: VideoCloneGeneration = {
    prompt: "",
    cast: input.cast,
    changes: input.changes,
    productFolder: input.productFolder,
    startedAt,
    status: "generating",
  };

  // Atomic check-and-mark inside row lock + active render_attempts check.
  const lockedCheck = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: contentTemplateTable.id,
        structure: contentTemplateTable.structure,
      })
      .from(contentTemplateTable)
      .where(
        and(
          eq(contentTemplateTable.id, input.templateId),
          eq(contentTemplateTable.organizationId, input.organizationId),
        ),
      )
      .for("update");
    const row = rows[0];
    const video = row?.structure.video;
    if (!row || !video) {
      return { error: "Clone plan not found." as const };
    }

    const characters = new Set(video.vibe.characters.map(({ id }) => id));
    const unknown = Object.keys(input.cast).find((id) => !characters.has(id));
    if (unknown) {
      return {
        error: `No character "${unknown}" in this clone; its cast is ${[...characters].join(", ") || "empty"}.`,
      };
    }

    const selectedTakes = input.takeIndexes.map((idx) =>
      video.takes.find((take) => take.index === idx),
    );
    if (selectedTakes.some((take) => !take)) {
      return { error: "Unknown take." as const };
    }

    const validTakes = selectedTakes as VideoClone["takes"];
    const kept = validTakes.find((take) => keepsOriginal(take));
    if (kept) {
      return {
        error: `Take ${kept.index} keeps its original footage; pick a model for it to render it.`,
      };
    }

    for (const take of validTakes) {
      try {
        resolveModelForProvider(provider, take.model);
      } catch (error) {
        return { error: getErrorMessage(error) };
      }
    }

    if (input.shot !== undefined) {
      const first = validTakes[0];
      const part = first?.parts.find((item) => item.shot === input.shot);
      if (!first || validTakes.length !== 1 || !part) {
        return { error: "Pick one shot of one take." as const };
      }
      if (first.parts.length < 2) {
        return {
          error: `Take ${first.index} is a single shot; render the take instead.`,
        };
      }
      if (first.generation?.status !== "done") {
        return {
          error: `Render take ${first.index} first; a shot is redone to match its render.`,
        };
      }
    }

    const targetShot = input.shot ?? -1;
    const activeAttempts = await tx
      .select({ takeIndex: renderAttemptTable.takeIndex })
      .from(renderAttemptTable)
      .where(
        and(
          eq(renderAttemptTable.templateId, row.id),
          inArray(renderAttemptTable.takeIndex, input.takeIndexes),
          inArray(renderAttemptTable.status, [
            "claiming",
            "submitting",
            "submitted",
            "ambiguous",
            "downloading",
          ]),
          ...(input.shot !== undefined
            ? [inArray(renderAttemptTable.shot, [-1, targetShot])]
            : []),
        ),
      );
    if (activeAttempts.length > 0) {
      return {
        error: `Take ${activeAttempts[0]?.takeIndex} already has an active render in progress.`,
      };
    }

    const nextVideo = structuredClone(video);
    for (const takeIndex of input.takeIndexes) {
      const take = nextVideo.takes.find((item) => item.index === takeIndex);
      if (!take) continue;
      if (input.shot !== undefined) {
        const part = take.parts.find((item) => item.shot === input.shot);
        if (part) {
          if (part.generation?.status === "generating") {
            return {
              error: `Shot ${input.shot} of take ${takeIndex} is already rendering.`,
            };
          }
          part.renders = preservePaidRender(part.generation, part.renders);
          part.generation = { ...baseGeneration };
        }
      } else {
        if (
          take.generation?.status === "generating" ||
          take.parts.some((part) => part.generation?.status === "generating")
        ) {
          return {
            error: `Take ${takeIndex} is already rendering.`,
          };
        }
        take.renders = preservePaidRender(take.generation, take.renders);
        take.generation = { ...baseGeneration };
      }
    }

    await tx
      .update(contentTemplateTable)
      .set({ structure: { ...row.structure, video: nextVideo } })
      .where(eq(contentTemplateTable.id, row.id));

    return { ok: true as const };
  });

  if ("error" in lockedCheck && lockedCheck.error) {
    return { error: lockedCheck.error };
  }

  try {
    const handle = await tasks.trigger<typeof generateVideoCloneTask>(
      triggerTaskIds.generateVideoClone,
      { ...input, startedAt },
    );
    return { runId: handle.id };
  } catch (error) {
    const failedGeneration: VideoCloneGeneration = {
      ...baseGeneration,
      status: "failed",
      error: getErrorMessage(error) || "Couldn't start the render.",
    };
    await Promise.all(
      input.takeIndexes.map((takeIndex) =>
        input.shot !== undefined
          ? setVideoClonePartGenerationByShot(
              input.templateId,
              takeIndex,
              input.shot,
              failedGeneration,
            )
          : setVideoCloneGenerationByIndex(
              input.templateId,
              takeIndex,
              failedGeneration,
            ),
      ),
    );
    throw error;
  }
}

export async function listVideoClones(organizationId: string) {
  const templates = await db.query.contentTemplateTable.findMany({
    where: and(
      eq(contentTemplateTable.organizationId, organizationId),
      ne(contentTemplateTable.status, "archived"),
    ),
    columns: { id: true, name: true, structure: true, createdAt: true },
    orderBy: [desc(contentTemplateTable.createdAt)],
  });
  return templates.flatMap(({ id, name, structure, createdAt }) => {
    const video = structure.video;
    return video
      ? [
          {
            id,
            name,
            verdict: video.verdict,
            sourceUrl: video.sourceUrl,
            durationSeconds: video.durationSeconds,
            takes: video.takes.length,
            createdAt,
            editVideoUrl: video.edit?.videoUrl ?? null,
          },
        ]
      : [];
  });
}

export async function prepareVideoCloneUpload(
  organizationId: string,
  input: { extension: string; mimeType: string; sizeBytes: number },
) {
  const storageKey = `creative-assets/videos/${organizationId}/${crypto.randomUUID()}.${input.extension}`;
  const signedUrl = await getSignedUploadUrl(
    storageKey,
    storageConfig.bucketNames.images,
    input.mimeType,
    input.sizeBytes,
  );
  return { signedUrl, storageKey };
}

export async function startVideoClone(
  input: {
    organizationId: string;
    source: { url: string } | { storageKey: string };
    name?: string;
  },
  options: { skipPreflight?: boolean } = {},
): Promise<{ id: string }> {
  if (!options.skipPreflight) {
    const preflight = await runPreflight({ scope: "analyze" });
    if (!preflight.ok) {
      throw new Error(
        preflight.checks.find((c) => !c.ok)?.details ??
          "Preflight check failed.",
      );
    }
  }
  let sourceUrl: string;
  if ("url" in input.source) {
    sourceUrl = input.source.url;
  } else {
    const ownUpload = new RegExp(
      `^creative-assets/videos/${input.organizationId}/[0-9a-f-]+\\.(mp4|mov|webm)$`,
      "u",
    );
    if (!ownUpload.test(input.source.storageKey)) {
      throw new Error("Unknown upload.");
    }
    sourceUrl = `/storage/${storageConfig.bucketNames.images}/${input.source.storageKey}`;
  }
  const name =
    input.name?.trim() ||
    ("url" in input.source
      ? videoCloneSourceName(sourceUrl)
      : "Uploaded video");
  return tasks.trigger<typeof analyzeVideoCloneTask>(
    triggerTaskIds.analyzeVideoClone,
    {
      organizationId: input.organizationId,
      sourceUrl,
      name: name.slice(0, 200),
    },
  );
}

const isUploadedImage = (storageKey: string) =>
  /^creative-assets\/uploads\/[0-9a-f-]{36}$/u.test(storageKey);

export async function addVideoCloneProduct(
  organizationId: string,
  assets: { name: string; storageKey: string }[],
): Promise<{ folder: string }> {
  if (!assets.every(({ storageKey }) => isUploadedImage(storageKey))) {
    throw new Error("Upload the photos first.");
  }
  const base =
    assets[0]?.name
      .replace(/\.[^.]*$/u, "")
      .trim()
      .slice(0, 70) || "Product";
  const taken = new Set(
    (
      await db
        .select({ name: creativeAssetFolderTable.name })
        .from(creativeAssetFolderTable)
        .where(eq(creativeAssetFolderTable.organizationId, organizationId))
    ).map(({ name }) => name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
  await db.transaction(async (tx) => {
    const [folder] = await tx
      .insert(creativeAssetFolderTable)
      .values({ organizationId, name })
      .returning({ id: creativeAssetFolderTable.id });
    if (!folder) throw new Error("Couldn't save the product.");
    await tx.insert(creativeAssetTable).values(
      assets.map(({ name: fileName, storageKey }) => ({
        organizationId,
        folderId: folder.id,
        name: fileName,
        storageKey,
        url: `/storage/${storageConfig.bucketNames.images}/${storageKey}`,
      })),
    );
  });
  return { folder: name };
}

export const listFaces = (organizationId: string) =>
  db
    .select({
      id: faceTable.id,
      name: faceTable.name,
      imageUrl: faceTable.imageUrl,
    })
    .from(faceTable)
    .where(eq(faceTable.organizationId, organizationId))
    .orderBy(asc(faceTable.createdAt));

export const findFaces = (organizationId: string, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : db
        .select({ id: faceTable.id, imageUrl: faceTable.imageUrl })
        .from(faceTable)
        .where(
          and(
            eq(faceTable.organizationId, organizationId),
            inArray(faceTable.id, ids),
          ),
        );

export async function createFace(
  organizationId: string,
  input: { name: string; storageKey: string },
): Promise<{ id: string }> {
  if (!isUploadedImage(input.storageKey)) {
    throw new Error("Upload the photo first.");
  }
  const [face] = await db
    .insert(faceTable)
    .values({
      organizationId,
      name: input.name,
      imageUrl: `/storage/${storageConfig.bucketNames.images}/${input.storageKey}`,
    })
    .returning({ id: faceTable.id });
  if (!face) throw new Error("Couldn't save the face.");
  return face;
}

export async function deleteFace(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(faceTable)
    .where(
      and(eq(faceTable.id, id), eq(faceTable.organizationId, organizationId)),
    )
    .returning({ id: faceTable.id });
  return deleted.length > 0;
}

/** Signs a `/storage/<bucket>/<path>` URL using `S3_PUBLIC_ENDPOINT` for remote video generators. */
export async function resolvePublicStorageReferenceUrl(
  url: string,
  expiresInSeconds: number,
): Promise<string> {
  if (!url?.startsWith("/storage/")) return url;
  const [, bucket, ...parts] = url.split("/").filter(Boolean);
  if (!bucket || parts.length === 0) return url;
  return getPublicSignedUrl(parts.join("/"), bucket, expiresInSeconds);
}
