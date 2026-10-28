import { createTRPCRouter } from "@/trpc/init";
import { faceRouter } from "./face-router";
import { videoCloneRouter } from "./video-clone-router";

export const appRouter = createTRPCRouter({
  videoClone: videoCloneRouter,
  face: faceRouter,
});

export type AppRouter = typeof appRouter;
