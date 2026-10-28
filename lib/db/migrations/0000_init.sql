CREATE TABLE "content_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"format" text DEFAULT 'video' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"structure" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_asset_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"folder_id" uuid,
	"media_type" text DEFAULT 'image' NOT NULL,
	"name" text NOT NULL,
	"storage_key" text,
	"url" text NOT NULL,
	"mime_type" text DEFAULT 'image/webp' NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"image_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_folder_id_creative_asset_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."creative_asset_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_templates_org_idx" ON "content_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creative_asset_folders_org_name_unique" ON "creative_asset_folders" USING btree ("organization_id","name");