import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { VideoClone } from "@/lib/content-workflows/video-clone";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** A clone plan: the shot-by-shot analysis, its takes, renders, and stitched edit (`structure.video`). */
export const contentTemplateTable = pgTable(
  "content_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Single tenant: always WORKSPACE_ID. Kept so plans can be scoped per team later. */
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    format: text("format").$type<"video">().notNull().default("video"),
    status: text("status")
      .$type<"ready" | "not_reproducible" | "archived">()
      .notNull()
      .default("ready"),
    structure: jsonb("structure").$type<{ video?: VideoClone }>().notNull(),
    ...timestamps,
  },
  (table) => [index("content_templates_org_idx").on(table.organizationId)],
);

/** A product: a named folder of photos. */
export const creativeAssetFolderTable = pgTable(
  "creative_asset_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("creative_asset_folders_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
  ],
);

/** An uploaded product photo, pinnable on takes. */
export const creativeAssetTable = pgTable("creative_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  folderId: uuid("folder_id").references(() => creativeAssetFolderTable.id, {
    onDelete: "set null",
  }),
  mediaType: text("media_type").$type<"image">().notNull().default("image"),
  name: text("name").notNull(),
  storageKey: text("storage_key"),
  url: text("url").notNull(),
  mimeType: text("mime_type").notNull().default("image/webp"),
  sizeBytes: integer("size_bytes"),
  ...timestamps,
});

/** A face that can play a character (the clone page's "Who plays who"). */
export const faceTable = pgTable("faces", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  name: text("name").notNull(),
  imageUrl: text("image_url").notNull(),
  ...timestamps,
});

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed";

/** Durable background job state persisted across container restarts. */
export const backgroundJobTable = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: text("task_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    templateId: uuid("template_id"),
    status: text("status")
      .$type<BackgroundJobStatus>()
      .notNull()
      .default("running"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    output: jsonb("output").$type<unknown>(),
    error: text("error"),
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("background_jobs_task_started_idx").on(table.taskId, table.startedAt),
    index("background_jobs_status_hb_idx").on(table.status, table.heartbeatAt),
    index("background_jobs_template_idx").on(table.templateId),
  ],
);

export type RenderAttemptStatus =
  | "claiming"
  | "submitting"
  | "submitted"
  | "ambiguous"
  | "downloading"
  | "done"
  | "failed";

export type RenderGenerationBase = {
  cast?: Record<string, string>;
  changes: string;
  productFolder?: string | null;
  startedAt: string;
};

/**
 * Durable per-take/shot render attempt tracking external job IDs, idempotency keys,
 * and leases so restarts and ambiguous submits never double-bill or strand takes.
 */
export const renderAttemptTable = pgTable(
  "render_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => backgroundJobTable.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => contentTemplateTable.id, { onDelete: "cascade" }),
    takeIndex: integer("take_index").notNull(),
    /** `-1` represents a whole-take render; non-negative integer represents the shot number. */
    shot: integer("shot").notNull().default(-1),
    providerId: text("provider_id").notNull(),
    canonicalModelId: text("canonical_model_id").notNull(),
    providerModelId: text("provider_model_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status")
      .$type<RenderAttemptStatus>()
      .notNull()
      .default("claiming"),
    externalJobId: text("external_job_id"),
    providerMetadata:
      jsonb("provider_metadata").$type<Record<string, unknown>>(),
    artifactUrl: text("artifact_url"),
    storedVideoUrl: text("stored_video_url"),
    prompt: text("prompt").notNull().default(""),
    generationBase: jsonb("generation_base")
      .$type<RenderGenerationBase>()
      .notNull(),
    error: text("error"),
    errorKind: text("error_kind"),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    workerId: text("worker_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("render_attempts_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("render_attempts_active_target_uidx")
      .on(table.templateId, table.takeIndex, table.shot)
      .where(
        sql`${table.status} IN ('claiming', 'submitting', 'submitted', 'ambiguous', 'downloading')`,
      ),
    index("render_attempts_job_idx").on(table.jobId),
    index("render_attempts_poll_idx").on(table.status, table.nextPollAt),
  ],
);

export type JobWaitpointStatus = "pending" | "completed" | "expired";

/**
 * Authenticated single-use webhook waitpoints stored in Postgres so callbacks survive
 * process restarts and reject forged or replayed requests.
 */
export const jobWaitpointTable = pgTable(
  "job_waitpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => renderAttemptTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    status: text("status")
      .$type<JobWaitpointStatus>()
      .notNull()
      .default("pending"),
    payload: jsonb("payload").$type<unknown>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("job_waitpoints_attempt_uidx").on(table.attemptId),
    index("job_waitpoints_status_exp_idx").on(table.status, table.expiresAt),
  ],
);
