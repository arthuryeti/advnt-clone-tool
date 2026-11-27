import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { reviseVideoCloneTakePrompt } from "@/lib/ai/adapt-video-clone-prompts";
import { getPublicVideoProviderInfo } from "@/lib/ai/video-provider";
import {
  generateVideoCloneInputSchema,
  MAX_VIDEO_CLONE_PRODUCTS,
  rewriteVideoCloneInputSchema,
  sayVideoCloneLines,
  videoCloneTakeEditSchema,
  videoCloneUrlSchema,
} from "@/lib/content-workflows/video-clone";
import {
  addVideoCloneProduct,
  deleteVideoClone,
  findVideoClone,
  listVideoCloneProductOptions,
  listVideoClones,
  pickVideoCloneRender,
  prepareVideoCloneUpload,
  removeVideoCloneTake,
  setVideoCloneBurnText,
  startVideoClone,
  startVideoCloneRender,
  startVideoCloneRewrite,
  updateVideoCloneTake,
} from "@/lib/content-workflows/video-clone-store";
import { WORKSPACE_ID } from "@/lib/db";
import { listRuns } from "@/lib/jobs";
import { runPreflight } from "@/lib/preflight";
import { getErrorMessage } from "@/lib/utils";
import { triggerTaskIds } from "@/trigger/shared";
import { createTRPCRouter, publicProcedure } from "@/trpc/init";

// Source videos up to 50 MB.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const badRequest = (error: unknown) =>
  new TRPCError({ code: "BAD_REQUEST", message: getErrorMessage(error) });

export const videoCloneRouter = createTRPCRouter({
  /** The workspace's clone plans, newest first. */
  list: publicProcedure.query(() => listVideoClones(WORKSPACE_ID)),

  /** Durable analysis runs from Postgres: running, failed, or done (with the plan's id). */
  runs: publicProcedure.query(async () => {
    const rows = await listRuns(triggerTaskIds.analyzeVideoClone);
    return rows.map((run) => {
      const payload = run.payload as { name: string; sourceUrl: string };
      const progress = run.metadata.videoClone as
        | { label: string; progress: number }
        | undefined;
      const output = run.output as { templateId: string } | undefined;
      return {
        id: run.id,
        name: payload.name,
        sourceUrl: payload.sourceUrl,
        status: run.status,
        label: progress?.label ?? "Starting",
        progress: progress?.progress ?? 0,
        error: run.error ?? null,
        templateId: output?.templateId ?? null,
      };
    });
  }),

  /** Non-billable doctor/preflight check across configured providers, storage, and binaries. */
  preflight: publicProcedure.query(() =>
    runPreflight({ scope: "all", force: true }),
  ),

  /** A presigned upload for a source video (uploadVideoFile). */
  prepareVideoUpload: publicProcedure
    .input(
      z.object({
        extension: z.enum(["mov", "mp4", "webm"]),
        mimeType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
        sizeBytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
      }),
    )
    .mutation(({ input }) => prepareVideoCloneUpload(WORKSPACE_ID, input)),

  /** Starts analyzing a TikTok/Instagram link or an uploaded video into a clone plan. */
  start: publicProcedure
    .input(
      z.object({
        source: z.union([
          z.object({ url: videoCloneUrlSchema }),
          z.object({ storageKey: z.string() }),
        ]),
        name: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const { id } = await startVideoClone({
          ...input,
          organizationId: WORKSPACE_ID,
        });
        return { runId: id };
      } catch (error) {
        throw badRequest(error);
      }
    }),

  /** Active video provider capabilities, models, and per-second rates declared by the plugin. */
  provider: publicProcedure.query(() => getPublicVideoProviderInfo()),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const plan = await findVideoClone(WORKSPACE_ID, input.id);
      if (!plan) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Clone plan not found.",
        });
      }
      return { id: plan.id, name: plan.name, ...plan.video };
    }),

  /** Pinnable product photos, by product folder. */
  products: publicProcedure.query(() =>
    listVideoCloneProductOptions(WORKSPACE_ID),
  ),

  /** Photos uploaded together (uploadImageFile) become one product folder. */
  addProduct: publicProcedure
    .input(
      z.object({
        assets: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              storageKey: z.string(),
            }),
          )
          .min(1)
          .max(MAX_VIDEO_CLONE_PRODUCTS),
      }),
    )
    .mutation(({ input }) =>
      addVideoCloneProduct(WORKSPACE_ID, input.assets).catch(
        (error: unknown) => {
          throw badRequest(error);
        },
      ),
    ),

  /** Saves a take's prompt, script lines, pinned products, or model as given. */
  updateTake: publicProcedure
    .input(videoCloneTakeEditSchema)
    .mutation(async ({ input }) => {
      const result = await updateVideoCloneTake(WORKSPACE_ID, input);
      if ("error" in result) throw badRequest(result.error);
      return result.take;
    }),

  /** Puts a finished render back in the edit. */
  pickRender: publicProcedure
    .input(
      videoCloneTakeEditSchema
        .pick({ templateId: true, takeIndex: true })
        .extend({
          shot: z.number().int().optional(),
          videoUrl: z.string(),
        }),
    )
    .mutation(async ({ input }) => {
      const result = await pickVideoCloneRender(WORKSPACE_ID, input);
      if ("error" in result) throw badRequest(result.error);
      return result;
    }),

  /** Saves a take's edited lines, invoking the text provider only if needed. */
  reviseTake: publicProcedure
    .input(
      videoCloneTakeEditSchema
        .pick({ templateId: true, takeIndex: true })
        .extend({ dialogue: videoCloneTakeEditSchema.shape.dialogue.unwrap() }),
    )
    .mutation(async ({ input }) => {
      const plan = await findVideoClone(WORKSPACE_ID, input.templateId);
      const take = plan?.video.takes.find(
        (item) => item.index === input.takeIndex,
      );
      if (!plan || !take) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: plan ? "Unknown take." : "Clone plan not found.",
        });
      }
      const prompt = sayVideoCloneLines(
        take.analysis.prompt,
        take.analysis.dialogue,
        input.dialogue,
      );
      const revised =
        prompt === null
          ? await reviseVideoCloneTakePrompt({ ...input, plan: plan.video })
          : { prompt, dialogue: input.dialogue };
      const result = await updateVideoCloneTake(WORKSPACE_ID, {
        templateId: plan.id,
        takeIndex: input.takeIndex,
        ...revised,
      });
      if ("error" in result) throw badRequest(result.error);
      return result.take;
    }),

  /** Starts applying the toolbar's change in the background (rewrite-video-clone). */
  applyChanges: publicProcedure
    .input(
      rewriteVideoCloneInputSchema.omit({
        organizationId: true,
        startedAt: true,
      }),
    )
    .mutation(async ({ input }) => {
      const result = await startVideoCloneRewrite({
        ...input,
        organizationId: WORKSPACE_ID,
      });
      if ("error" in result) throw badRequest(result.error);
      return result;
    }),

  /** Removes a take that changes added. */
  removeTake: publicProcedure
    .input(videoCloneTakeEditSchema.pick({ templateId: true, takeIndex: true }))
    .mutation(async ({ input }) => {
      const result = await removeVideoCloneTake(
        WORKSPACE_ID,
        input.templateId,
        input.takeIndex,
      );
      if ("error" in result) throw badRequest(result.error);
      return result;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      if (!(await deleteVideoClone(WORKSPACE_ID, input.id))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Clone plan not found.",
        });
      }
      return { success: true };
    }),

  /** Burns the takes' on-screen text into Download, or not. */
  setBurnText: publicProcedure
    .input(z.object({ id: z.string().uuid(), burnText: z.boolean() }))
    .mutation(async ({ input }) => {
      if (
        !(await setVideoCloneBurnText(WORKSPACE_ID, input.id, input.burnText))
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Clone plan not found.",
        });
      }
      return { success: true };
    }),

  /** Renders takes on the active video provider; each take's status shows up in `get`. */
  generate: publicProcedure
    .input(
      generateVideoCloneInputSchema.omit({
        organizationId: true,
        startedAt: true,
      }),
    )
    .mutation(async ({ input }) => {
      const result = await startVideoCloneRender({
        ...input,
        organizationId: WORKSPACE_ID,
      });
      if ("error" in result) throw badRequest(result.error);
      return result;
    }),
});
