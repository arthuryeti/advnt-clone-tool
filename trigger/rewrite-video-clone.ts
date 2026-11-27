import type { z } from "zod/v4";
import { applyVideoCloneChanges } from "@/lib/ai/adapt-video-clone-prompts";
import { rewriteVideoCloneInputSchema } from "@/lib/content-workflows/video-clone";
import {
  applyAtomicRewritePlan,
  findProductImages,
  findVideoClone,
  requestVideoCloneStitch,
  setVideoCloneRewrite,
} from "@/lib/content-workflows/video-clone-store";
import { schemaTask } from "@/lib/jobs";
import { resolveStorageDownloadUrl } from "@/lib/storage";
import { getErrorMessage } from "@/lib/utils";
import { triggerTaskIds } from "./shared";

/**
 * Applies a toolbar change to a clone plan atomically inside a locked row transaction.
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

  await applyAtomicRewritePlan(plan.id, { takes, addition });

  const rewritten =
    addition?.takes.filter((take) =>
      plan.video.takes.some((item) => item.index === take.index),
    ) ?? [];
  const added =
    addition?.takes.filter((take) => !rewritten.includes(take)) ?? [];

  if (
    [...rewritten.map((take) => take.index), ...(addition?.removed ?? [])].some(
      (index) => plan.video.edit?.rendered.includes(index),
    )
  ) {
    await requestVideoCloneStitch(payload.organizationId, plan.id);
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
