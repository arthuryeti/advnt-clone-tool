import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import {
  createFace,
  deleteFace,
  listFaces,
} from "@/lib/content-workflows/video-clone-store";
import { WORKSPACE_ID } from "@/lib/db";
import { getErrorMessage } from "@/lib/utils";
import { createTRPCRouter, publicProcedure } from "@/trpc/init";

/** Faces that play characters in renders (the clone page's "Who plays who"). */
export const faceRouter = createTRPCRouter({
  list: publicProcedure.query(() => listFaces(WORKSPACE_ID)),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        storageKey: z.string(),
      }),
    )
    .mutation(({ input }) =>
      createFace(WORKSPACE_ID, input).catch((error: unknown) => {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: getErrorMessage(error),
        });
      }),
    ),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      if (!(await deleteFace(WORKSPACE_ID, input.id))) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Face not found." });
      }
      return { success: true };
    }),
});
