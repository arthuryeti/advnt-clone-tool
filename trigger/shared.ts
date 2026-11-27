import { startRun, type Task } from "@/lib/jobs";

export const triggerTaskIds = {
  analyzeVideoClone: "analyze-video-clone",
  generateVideoClone: "generate-video-clone",
  stitchVideoClone: "stitch-video-clone",
  rewriteVideoClone: "rewrite-video-clone",
} as const;

type TaskId = (typeof triggerTaskIds)[keyof typeof triggerTaskIds];

// Loaded on first trigger: the tasks import the store, which triggers them.
const loaders: Record<TaskId, () => Promise<Task>> = {
  "analyze-video-clone": () =>
    import("./analyze-video-clone").then((m) => m.analyzeVideoCloneTask),
  "generate-video-clone": () =>
    import("./generate-video-clone").then((m) => m.generateVideoCloneTask),
  "stitch-video-clone": () =>
    import("./stitch-video-clone").then((m) => m.stitchVideoCloneTask),
  "rewrite-video-clone": () =>
    import("./rewrite-video-clone").then((m) => m.rewriteVideoCloneTask),
};

export const tasks = {
  /** Starts a durable Postgres-backed background task in this process. */
  trigger: async <T extends Task>(
    id: TaskId,
    payload: Parameters<T["run"]>[0],
    options?: {
      organizationId?: string;
      templateId?: string | null;
      status?: "running" | "queued";
    },
  ) => startRun(await loaders[id](), payload, options),
};
