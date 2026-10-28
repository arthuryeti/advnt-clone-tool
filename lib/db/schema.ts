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
