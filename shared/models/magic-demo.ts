import { sql } from "drizzle-orm";
import { pgTable, serial, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const magicDemoSessionStatusSchema = z.enum(["created", "active", "completed", "failed", "abandoned"]);
export type MagicDemoSessionStatus = z.infer<typeof magicDemoSessionStatusSchema>;

export const magicDemoEventTypeSchema = z.enum([
  "diagnostic",
  "route",
  "dat",
  "voice",
  "vision",
  "lifecycle",
  "failure",
  "latency",
]);
export type MagicDemoEventType = z.infer<typeof magicDemoEventTypeSchema>;

export const magicDemoSessions = pgTable("magic_demo_sessions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id"),
  updatedByUserId: text("updated_by_user_id"),
  status: text("status").notNull().default("created"),
  deviceId: text("device_id"),
  appVersion: text("app_version"),
  buildNumber: text("build_number"),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, precision: 6 }),
  telemetry: jsonb("telemetry").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_magic_demo_sessions_user_created").on(table.userId, table.createdAt),
  index("idx_magic_demo_sessions_owner_created").on(table.ownerUserId, table.createdAt),
  index("idx_magic_demo_sessions_account_created").on(table.accountId, table.createdAt),
  index("idx_magic_demo_sessions_status").on(table.status),
]);

export const magicDemoSessionEvents = pgTable("magic_demo_session_events", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => magicDemoSessions.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id"),
  eventType: text("event_type").notNull(),
  eventName: text("event_name").notNull(),
  routeMetadata: jsonb("route_metadata"),
  datState: jsonb("dat_state"),
  voiceLifecycle: text("voice_lifecycle"),
  visionLifecycle: text("vision_lifecycle"),
  failureDetails: jsonb("failure_details"),
  latencyMs: integer("latency_ms"),
  telemetry: jsonb("telemetry").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_magic_demo_events_session_created").on(table.sessionId, table.createdAt),
  index("idx_magic_demo_events_owner_created").on(table.ownerUserId, table.createdAt),
  index("idx_magic_demo_events_account_created").on(table.accountId, table.createdAt),
  index("idx_magic_demo_events_type").on(table.eventType),
]);


export const magicDemoVisionFrames = pgTable("magic_demo_vision_frames", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: text("session_id").notNull().references(() => magicDemoSessions.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id"),
  source: text("source").notNull().default("dat_camera"),
  objectPath: text("object_path").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  format: text("format").notNull(),
  captureMode: text("capture_mode").notNull().default("still"),
  linkedUtteranceId: text("linked_utterance_id"),
  capturedAt: timestamp("captured_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  telemetry: jsonb("telemetry").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_magic_demo_vision_frames_session_created").on(table.sessionId, table.createdAt),
  index("idx_magic_demo_vision_frames_owner_created").on(table.ownerUserId, table.createdAt),
  index("idx_magic_demo_vision_frames_account_created").on(table.accountId, table.createdAt),
  index("idx_magic_demo_vision_frames_utterance").on(table.linkedUtteranceId),
]);

const telemetrySchema = z.record(z.unknown()).default({});
const optionalTelemetrySchema = z.record(z.unknown()).optional();

export const insertMagicDemoSessionSchema = createInsertSchema(magicDemoSessions).omit({
  id: true,
  userId: true,
  scope: true,
  ownerUserId: true,
  accountId: true,
  createdByUserId: true,
  updatedByUserId: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: magicDemoSessionStatusSchema.default("created"),
  deviceId: z.string().min(1).max(200).optional().nullable(),
  appVersion: z.string().min(1).max(80).optional().nullable(),
  buildNumber: z.string().min(1).max(80).optional().nullable(),
  telemetry: telemetrySchema,
});

export const updateMagicDemoSessionSchema = z.object({
  status: magicDemoSessionStatusSchema.optional(),
  deviceId: z.string().min(1).max(200).optional().nullable(),
  appVersion: z.string().min(1).max(80).optional().nullable(),
  buildNumber: z.string().min(1).max(80).optional().nullable(),
  endedAt: z.coerce.date().optional().nullable(),
  telemetry: optionalTelemetrySchema,
}).strict();

export const insertMagicDemoSessionEventSchema = createInsertSchema(magicDemoSessionEvents).omit({
  id: true,
  sessionId: true,
  ownerUserId: true,
  accountId: true,
  createdByUserId: true,
  createdAt: true,
}).extend({
  eventType: magicDemoEventTypeSchema,
  eventName: z.string().min(1).max(120),
  routeMetadata: z.record(z.unknown()).optional().nullable(),
  datState: z.record(z.unknown()).optional().nullable(),
  voiceLifecycle: z.string().min(1).max(80).optional().nullable(),
  visionLifecycle: z.string().min(1).max(80).optional().nullable(),
  failureDetails: z.record(z.unknown()).optional().nullable(),
  latencyMs: z.number().int().min(0).max(10 * 60 * 1000).optional().nullable(),
  telemetry: telemetrySchema,
  occurredAt: z.coerce.date().optional(),
});


export const insertMagicDemoVisionFrameSchema = createInsertSchema(magicDemoVisionFrames).omit({
  id: true,
  sessionId: true,
  ownerUserId: true,
  accountId: true,
  createdByUserId: true,
  objectPath: true,
  contentType: true,
  fileSize: true,
  createdAt: true,
}).extend({
  source: z.literal("dat_camera").default("dat_camera"),
  width: z.coerce.number().int().positive().max(10000).optional(),
  height: z.coerce.number().int().positive().max(10000).optional(),
  format: z.string().min(1).max(32).optional(),
  captureMode: z.string().min(1).max(80).default("still"),
  linkedUtteranceId: z.string().min(1).max(200).optional().nullable(),
  capturedAt: z.coerce.date().optional(),
  telemetry: telemetrySchema,
});

export type MagicDemoSession = typeof magicDemoSessions.$inferSelect;
export type InsertMagicDemoSession = z.infer<typeof insertMagicDemoSessionSchema>;
export type UpdateMagicDemoSession = z.infer<typeof updateMagicDemoSessionSchema>;
export type MagicDemoSessionEvent = typeof magicDemoSessionEvents.$inferSelect;
export type InsertMagicDemoSessionEvent = z.infer<typeof insertMagicDemoSessionEventSchema>;
export type MagicDemoVisionFrame = typeof magicDemoVisionFrames.$inferSelect;
export type InsertMagicDemoVisionFrame = z.infer<typeof insertMagicDemoVisionFrameSchema>;
