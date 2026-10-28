import type { z } from "zod/v4";
import { applyVideoCloneChanges } from "@/lib/ai/adapt-video-clone-prompts";
import { rewriteVideoCloneInputSchema } from "@/lib/content-workflows/video-clone";
import {
  addVideoCloneTakesToPlan,
  findProductImages,
  findVideoClone,
  setVideoCloneRewrite,
  setVideoCloneTakeTiming,
  startVideoCloneStitch,
  updateVideoCloneTake,
} from "@/lib/content-workflows/video-clone-store";
import { schemaTask } from "@/lib/jobs";
import { resolveStorageDownloadUrl } from "@/lib/storage";
import { getErrorMessage } from "@/lib/utils";
import { triggerTaskIds } from "./shared";

/**
 * Applies a toolbar change to a clone plan (applyVideoCloneChanges): rewritten prompts, lines,
 * and timing, the takes it adds, and the added takes it writes again. A script grown by minutes
 * takes minutes, so it runs in the background and the page follows `structure.video.rewrite`.
 * Nothing renders. Never retried: a failure shows on the page instead.
 */
export const rewriteVideoCloneTask = schemaTask({
  id: triggerTaskIds.rewriteVideoClone,
  schema: rewriteVideoCloneInputSchema,
  run: async (payload) => {
    const base = {
      changes: payload.changes,
      productFolder: payload.productFolder,
      startedAt: payload.startedAt,
    };
    try {
      const result = await rewriteVideoClone(payload);
      await setVideoCloneRewrite(payload.templateId, {
        ...base,
        ...result,
        status: "done",
      });
      return result;
    } catch (error) {
      await setVideoCloneRewrite(payload.templateId, {
        ...base,
        status: "failed",
        error: getErrorMessage(error) || "Couldn't apply the change.",
      });
      throw error;
    }
  },
});

async function rewriteVideoClone(
  payload: z.infer<typeof rewriteVideoCloneInputSchema>,
) {
  const plan = await findVideoClone(payload.organizationId, payload.templateId);
  if (!plan) throw new Error("Clone plan not found.");
  const folder = payload.productFolder
    ? await findProductImages(payload.organizationId, payload.productFolder)
    : { images: [] };
  if ("error" in folder) throw new Error(folder.error);
  const product = {
    images: await Promise.all(
      folder.images.map(async ({ name, url }) => ({
        name,
        url: await resolveStorageDownloadUrl(url),
      })),
    ),
  };
  const { summary, takes, addition } = await applyVideoCloneChanges({
    plan: plan.video,
    changes: payload.changes,
    product,
  });
  // Merged-away takes shift the positions renders write to: never while one runs.
  if (addition?.removed.length) {
    const now = await findVideoClone(payload.organizationId, plan.id);
    if (
      now?.video.takes.some((take) =>
        [take.generation, ...take.parts.map((part) => part.generation)].some(
          (generation) => generation?.status === "generating",
        ),
      )
    ) {
      throw new Error(
        "This change merges takes; wait for the renders to finish, then submit it again.",
      );
    }
  }
  // ponytail: one write per changed take; a plan has a handful.
  for (const { index, prompt, dialogue, parts } of takes) {
    const result = await updateVideoCloneTake(payload.organizationId, {
      templateId: plan.id,
      takeIndex: index,
      prompt,
      dialogue: dialogue ?? undefined,
    });
    if ("error" in result) throw new Error(result.error);
    // Positions hold: takes are only appended meanwhile (removing one waits for this).
    if (parts) {
      await setVideoCloneTakeTiming(
        plan.id,
        plan.video.takes.findIndex((take) => take.index === index),
        parts,
      );
    }
  }
  // Takes written again replace theirs, render included.
  const rewritten =
    addition?.takes.filter((take) =>
      plan.video.takes.some((item) => item.index === take.index),
    ) ?? [];
  const added =
    addition?.takes.filter((take) => !rewritten.includes(take)) ?? [];
  if (addition) {
    await addVideoCloneTakesToPlan(plan.id, plan.video.takes, addition);
  }
  if (
    [...rewritten.map((take) => take.index), ...(addition?.removed ?? [])].some(
      (index) => plan.video.edit?.rendered.includes(index),
    )
  ) {
    await startVideoCloneStitch(
      payload.organizationId,
      plan.id,
      plan.video.edit,
    );
  }
  return {
    summary,
    changed: [...takes, ...rewritten].map(({ index }) => index),
    linesChanged:
      rewritten.length > 0 || takes.some(({ dialogue }) => dialogue !== null),
    retimed: takes.flatMap(({ index, parts }) => (parts ? [index] : [])),
    added: added.map(({ index }) => index),
    addedSeconds: added.reduce((sum, take) => sum + take.seconds, 0),
  };
}
