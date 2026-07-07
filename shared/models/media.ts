import { pgTable, text, integer, real, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Media Items — unified registry of all uploaded, generated, and rendered media
// ---------------------------------------------------------------------------

export const mediaTypeEnum = z.enum(["video", "image", "audio"]);
export type MediaType = z.infer<typeof mediaTypeEnum>;

export const mediaSourceEnum = z.enum(["upload", "generated", "render"]);
export type MediaSource = z.infer<typeof mediaSourceEnum>;

export const mediaItems = pgTable("media_items", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  mediaType: text("media_type").notNull(),       // video | image | audio
  source: text("source").notNull(),               // upload | generated | render
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  updatedByUserId: text("updated_by_user_id"),
  objectPath: text("object_path").notNull(),
  thumbPath: text("thumb_path"),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),                  // bytes
  width: integer("width"),                         // pixels (null for audio)
  height: integer("height"),                       // pixels (null for audio)
  duration: real("duration"),                      // seconds (null for images)
  metadata: jsonb("metadata"),                     // extensible (codec, prompt, etc.)
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_media_items_object_path").on(table.objectPath),
  index("idx_media_items_type").on(table.mediaType),
  index("idx_media_items_created").on(table.createdAt),
  index("idx_media_items_source").on(table.source),
  index("idx_media_items_owner_created").on(table.ownerUserId, table.createdAt),
  index("idx_media_items_account_created").on(table.accountId, table.createdAt),
]);

export const insertMediaItemSchema = createInsertSchema(mediaItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MediaItem = typeof mediaItems.$inferSelect;
export type InsertMediaItem = z.infer<typeof insertMediaItemSchema>;

// ---------------------------------------------------------------------------
// Render Jobs — async FFmpeg stitch job tracking
// ---------------------------------------------------------------------------

export const renderStatusEnum = z.enum(["pending", "running", "complete", "failed"]);
export type RenderStatus = z.infer<typeof renderStatusEnum>;

export const renderJobs = pgTable("render_jobs", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  status: text("status").notNull().default("pending"),
  progress: integer("progress").notNull().default(0),       // 0-100
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  updatedByUserId: text("updated_by_user_id"),
  clipIds: text("clip_ids").array().notNull(),               // ordered media_item IDs
  outputResolution: text("output_resolution"),               // 'original' | '720p' | '1080p'
  totalDuration: real("total_duration"),                     // pre-computed seconds
  outputMediaId: text("output_media_id"),                    // FK to media_items on completion
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_render_jobs_status").on(table.status),
  index("idx_render_jobs_owner_created").on(table.ownerUserId, table.createdAt),
  index("idx_render_jobs_account_created").on(table.accountId, table.createdAt),
]);

export const insertRenderJobSchema = createInsertSchema(renderJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type RenderJob = typeof renderJobs.$inferSelect;
export type InsertRenderJob = z.infer<typeof insertRenderJobSchema>;
