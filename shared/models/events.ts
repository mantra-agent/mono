import { pgTable, serial, text, timestamp, jsonb, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const systemEvents = pgTable("system_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull(),
  bootId: text("boot_id"),
  category: text("category").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").default({}),
  runId: text("run_id"),
  sessionKey: text("session_key"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_sys_events_category").on(table.category),
  index("idx_sys_events_event").on(table.event),
  index("idx_sys_events_created_at").on(table.createdAt),
  index("idx_sys_events_run_id").on(table.runId),
]);

export const systemHooks = pgTable("system_hooks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  eventPattern: text("event_pattern").notNull(),
  condition: jsonb("condition"),
  actionType: text("action_type").notNull(),
  actionConfig: jsonb("action_config").notNull(),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  maxFirings: integer("max_firings"),
  createdBy: text("created_by").notNull().default("user"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_system_hooks_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_system_hooks_account").on(table.accountId),
]);

export const systemHookExecutions = pgTable("system_hook_executions", {
  id: serial("id").primaryKey(),
  hookId: integer("hook_id").notNull(),
  eventDbId: integer("event_db_id"),
  actionType: text("action_type").notNull(),
  actionConfigResolved: jsonb("action_config_resolved"),
  status: text("status").notNull().default("dispatched"),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_hook_exec_hook_created").on(table.hookId, table.createdAt),
  index("idx_hook_exec_created").on(table.createdAt),
]);

export const insertSystemEventSchema = createInsertSchema(systemEvents).omit({
  id: true,
  createdAt: true,
});

export const insertSystemHookSchema = createInsertSchema(systemHooks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSystemHookExecutionSchema = createInsertSchema(systemHookExecutions).omit({
  id: true,
  createdAt: true,
});

export type SystemEvent = typeof systemEvents.$inferSelect;
export type InsertSystemEvent = z.infer<typeof insertSystemEventSchema>;
export type SystemHook = typeof systemHooks.$inferSelect;
export type InsertSystemHook = z.infer<typeof insertSystemHookSchema>;
export type SystemHookExecution = typeof systemHookExecutions.$inferSelect;
export type InsertSystemHookExecution = z.infer<typeof insertSystemHookExecutionSchema>;
