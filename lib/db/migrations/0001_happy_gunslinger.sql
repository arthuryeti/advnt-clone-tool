CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_waitpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"take_index" integer NOT NULL,
	"shot" integer DEFAULT -1 NOT NULL,
	"provider_id" text NOT NULL,
	"canonical_model_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'claiming' NOT NULL,
	"external_job_id" text,
	"provider_metadata" jsonb,
	"artifact_url" text,
	"stored_video_url" text,
	"prompt" text DEFAULT '' NOT NULL,
	"generation_base" jsonb NOT NULL,
	"error" text,
	"error_kind" text,
	"next_poll_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"worker_id" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_waitpoints" ADD CONSTRAINT "job_waitpoints_attempt_id_render_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."render_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_attempts" ADD CONSTRAINT "render_attempts_job_id_background_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."background_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_attempts" ADD CONSTRAINT "render_attempts_template_id_content_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."content_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_jobs_task_started_idx" ON "background_jobs" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "background_jobs_status_hb_idx" ON "background_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "background_jobs_template_idx" ON "background_jobs" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_waitpoints_attempt_uidx" ON "job_waitpoints" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "job_waitpoints_status_exp_idx" ON "job_waitpoints" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "render_attempts_idempotency_uidx" ON "render_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "render_attempts_active_target_uidx" ON "render_attempts" USING btree ("template_id","take_index","shot") WHERE "render_attempts"."status" IN ('claiming', 'submitting', 'submitted', 'ambiguous', 'downloading');--> statement-breakpoint
CREATE INDEX "render_attempts_job_idx" ON "render_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "render_attempts_poll_idx" ON "render_attempts" USING btree ("status","next_poll_at");