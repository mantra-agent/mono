import { pgTable, text, timestamp, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const captureTypeEnum = z.enum(["task", "person_note", "memory", "idea", "reminder", "calendar"]);
export type CaptureType = z.infer<typeof captureTypeEnum>;

export const captureStatusEnum = z.enum(["pending", "processing", "routed", "failed", "manual"]);
export type CaptureStatus = z.infer<typeof captureStatusEnum>;

export const captures = pgTable("captures", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  rawText: text("raw_text").notNull(),
  typeHint: text("type_hint"),
  classifiedType: text("classified_type"),
  classificationConfidence: real("classification_confidence"),
  status: text("status").notNull().default("pending"),
  routedTo: text("routed_to"),
  routedRef: text("routed_ref"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true, precision: 6 }),
  userId: text("user_id").notNull().default("ray"),
}, (table) => [
  index("idx_captures_status").on(table.status),
  index("idx_captures_created").on(table.createdAt),
]);

export const insertCaptureSchema = createInsertSchema(captures).omit({
  id: true,
  createdAt: true,
  processedAt: true,
}).extend({
  rawText: z.string().min(1).max(2000),
  typeHint: captureTypeEnum.optional().nullable(),
  status: captureStatusEnum.default("pending"),
});

export type Capture = typeof captures.$inferSelect;
export type InsertCapture = z.infer<typeof insertCaptureSchema>;
