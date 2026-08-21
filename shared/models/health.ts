import { pgTable, serial, text, timestamp, real, integer, boolean, unique, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const healthMetrics = pgTable("health_metrics", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  metricType: text("metric_type").notNull(),
  value: real("value").notNull(),
  unit: text("unit").notNull(),
  source: text("source").default("apple_health"),
  date: text("date").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("health_metrics_type_date_value_source_unique").on(table.metricType, table.date, table.value, table.source),
  index("idx_health_metrics_owner").on(table.ownerUserId),
  index("idx_health_metrics_principal_account").on(table.principalAccountId),
]);

export const insertHealthMetricSchema = createInsertSchema(healthMetrics).omit({ id: true, recordedAt: true });
export type HealthMetric = typeof healthMetrics.$inferSelect;
export type InsertHealthMetric = z.infer<typeof insertHealthMetricSchema>;

export const wellnessActivities = pgTable("wellness_activities", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  name: text("name").notNull(),
  benefit: text("benefit"),
  risk: text("risk"),
  intervalDays: integer("interval_days").notNull().default(7),
  category: text("category").notNull().default("weekly_ritual"),
  isDefault: boolean("is_default").notNull().default(false),
  defaultTemplateId: integer("default_template_id"),
  appliedTemplateRevision: text("applied_template_revision"),
  defaultUpdateState: text("default_update_state"),
  linkedMetricType: text("linked_metric_type"),
  greatThreshold: real("great_threshold"),
  goodThreshold: real("good_threshold"),
  windowStart: integer("window_start"),
  windowEnd: integer("window_end"),
  launchKind: text("launch_kind"),
  launchTarget: text("launch_target"),
  completionSource: text("completion_source"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_wellness_activities_owner").on(table.ownerUserId),
  index("idx_wellness_activities_principal_account").on(table.principalAccountId),
  unique("wellness_activities_owner_name_unique").on(table.ownerUserId, table.principalAccountId, table.name),
  unique("wellness_activities_owner_template_unique").on(table.ownerUserId, table.principalAccountId, table.defaultTemplateId),
]);

export const wellnessActivityTemplates = pgTable("wellness_activity_templates", {
  id: serial("id").primaryKey(),
  stableKey: text("stable_key").notNull().unique(),
  name: text("name").notNull(),
  revision: text("revision").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  publishedByUserId: text("published_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});
export type WellnessActivityTemplate = typeof wellnessActivityTemplates.$inferSelect;

export const insertWellnessActivitySchema = createInsertSchema(wellnessActivities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
});
export type WellnessActivity = typeof wellnessActivities.$inferSelect;
export type InsertWellnessActivity = z.infer<typeof insertWellnessActivitySchema>;

export const wellnessLogs = pgTable("wellness_logs", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  activityId: integer("activity_id").notNull(),
  notes: text("notes"),
  tier: text("tier"),
  metricValue: real("metric_value"),
  completedAt: timestamp("completed_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_wellness_logs_owner").on(table.ownerUserId),
  index("idx_wellness_logs_principal_account").on(table.principalAccountId),
]);

export const insertWellnessLogSchema = createInsertSchema(wellnessLogs).omit({
  id: true,
}).extend({
  completedAt: z.string().datetime().optional(),
});
export type WellnessLog = typeof wellnessLogs.$inferSelect;
export type InsertWellnessLog = z.infer<typeof insertWellnessLogSchema>;

export interface ActivityTrends {
  currentStreak: number;
  longestStreak: number;
  rate30d: number | null;
  rate90d: number | null;
  completionMap: Record<string, boolean>;
  totalCompletions: number;
}

export const gratitudeEntries = pgTable("gratitude_entries", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  content: text("content").notNull(),
  date: text("date").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_gratitude_entries_owner").on(table.ownerUserId),
  index("idx_gratitude_entries_principal_account").on(table.principalAccountId),
]);

export const insertGratitudeEntrySchema = createInsertSchema(gratitudeEntries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type GratitudeEntry = typeof gratitudeEntries.$inferSelect;
export type InsertGratitudeEntry = z.infer<typeof insertGratitudeEntrySchema>;

export const learningEntries = pgTable("learning_entries", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  content: text("content").notNull(),
  date: text("date").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_learning_entries_owner").on(table.ownerUserId),
  index("idx_learning_entries_principal_account").on(table.principalAccountId),
]);

export const insertLearningEntrySchema = createInsertSchema(learningEntries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type LearningEntry = typeof learningEntries.$inferSelect;
export type InsertLearningEntry = z.infer<typeof insertLearningEntrySchema>;


export const reflectionEntries = pgTable("reflection_entries", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  content: text("content").notNull(),
  date: text("date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  unique("reflection_entries_owner_account_date_unique").on(table.ownerUserId, table.principalAccountId, table.date),
  index("idx_reflection_entries_owner").on(table.ownerUserId),
  index("idx_reflection_entries_principal_account").on(table.principalAccountId),
]);

export const insertReflectionEntrySchema = createInsertSchema(reflectionEntries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ReflectionEntry = typeof reflectionEntries.$inferSelect;
export type InsertReflectionEntry = z.infer<typeof insertReflectionEntrySchema>;

/** Platform Wellness catalog definitions. Local principal-owned copies are reconciled from these rows. */
export const DEFAULT_WELLNESS_ACTIVITIES = [
  {
    stable_key: "steps",
    name: "Steps",
    benefit: "Daily walking improves mood, energy, and long-term health — even modest step counts beat long sitting.",
    interval_days: 1,
    category: "daily_practice",
    linked_metric_type: "steps",
    great_threshold: 10000,
    good_threshold: 5000,
  },
  {
    stable_key: "reading",
    name: "Reading",
    benefit: "Regular reading sharpens focus and builds cognitive reserve; sustained readers show slower age-related decline on standard cognitive tests.",
    interval_days: 1,
    category: "daily_practice",
  },
  {
    stable_key: "intentions",
    name: "Intentions",
    benefit: "A few concrete morning aims shrink the day to what matters — less overwhelm, more end-of-day satisfaction.",
    interval_days: 1,
    category: "daily_practice",
    launch_kind: "skill",
    launch_target: "Set Daily Goals",
    completion_source: "today_goal_mutated",
  },
] as const;
