import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const contentStatusEnum = z.enum(["draft", "scheduled", "publishing", "published", "rejected", "failed"]);
export type ContentStatus = z.infer<typeof contentStatusEnum>;

export const contentPlatformEnum = z.enum(["x"]);
export type ContentPlatform = z.infer<typeof contentPlatformEnum>;

export const contentQueue = pgTable("content_queue", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  platform: text("platform").notNull().default("x"),
  content: text("content").notNull(),
  threadParts: jsonb("thread_parts").$type<string[] | null>(),
  status: text("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  platformPostId: text("platform_post_id"),
  platformUrl: text("platform_url"),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  rejectReason: text("reject_reason"),
  retryCount: integer("retry_count").notNull().default(0),
  calendarEventId: text("calendar_event_id"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_content_queue_status").on(table.status),
  index("idx_content_queue_scheduled").on(table.scheduledAt),
  index("idx_content_queue_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_content_queue_account").on(table.accountId),
]);

export const insertContentSchema = createInsertSchema(contentQueue).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  platformPostId: true,
  platformUrl: true,
  retryCount: true,
  calendarEventId: true,
});

export type ContentQueue = typeof contentQueue.$inferSelect;
export type InsertContent = z.infer<typeof insertContentSchema>;
