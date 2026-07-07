import { pgTable, serial, text, timestamp, real, integer, boolean, unique, index } from "drizzle-orm/pg-core";
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
  name: text("name").notNull().unique(),
  benefit: text("benefit"),
  risk: text("risk"),
  estimatedMinutes: integer("estimated_minutes"),
  estimatedCost: real("estimated_cost"),
  intervalDays: integer("interval_days").notNull().default(7),
  requirements: text("requirements"),
  category: text("category").notNull().default("weekly_ritual"),
  isDefault: boolean("is_default").notNull().default(false),
  linkedMetricType: text("linked_metric_type"),
  greatThreshold: real("great_threshold"),
  goodThreshold: real("good_threshold"),
  windowStart: integer("window_start"),
  windowEnd: integer("window_end"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_wellness_activities_owner").on(table.ownerUserId),
  index("idx_wellness_activities_principal_account").on(table.principalAccountId),
]);

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

export const DEFAULT_WELLNESS_ACTIVITIES = [
  { name: "Gratitude", benefit: "Positivity", risk: "Negativity bias", estimated_minutes: 5, estimated_cost: 0, interval_days: 1, category: "daily_practice" },
  { name: "Learning", benefit: "Reflection and growth", risk: "Autopilot without reflection", estimated_minutes: 5, estimated_cost: 0, interval_days: 1, category: "daily_practice" },
  { name: "Journaling", benefit: "Processing", risk: "Stagnation without reflection", estimated_minutes: 10, estimated_cost: 0, interval_days: 1, category: "daily_practice" },
  { name: "Meditation", benefit: "Focus", risk: "Rumination if unguided", estimated_minutes: 15, estimated_cost: 0, interval_days: 1, category: "daily_practice" },
  { name: "Reading", benefit: "Learning", risk: "Insomnia & eye strain", estimated_minutes: 30, estimated_cost: 0, interval_days: 1, category: "daily_practice" },
  { name: "Stretching", benefit: "Flexibility", risk: "Stiffness & chronic pain", estimated_minutes: 10, estimated_cost: 0, interval_days: 1, category: "daily_practice" },
  { name: "Workout", benefit: "Metabolism", risk: "Sarcopenia & metabolic decline", estimated_minutes: 45, estimated_cost: 0, interval_days: 3, category: "weekly_ritual" },
  { name: "Cardio", benefit: "Endurance", risk: "Cardiovascular disease risk", estimated_minutes: 30, estimated_cost: 0, interval_days: 4, category: "weekly_ritual" },
  { name: "Yoga", benefit: "Flexibility", risk: "Crunchy", estimated_minutes: 60, estimated_cost: 0, interval_days: 4, category: "weekly_ritual" },
  { name: "Cleaning", benefit: "Clarity", risk: "Clutter-related stress", estimated_minutes: 60, estimated_cost: 0, interval_days: 7, category: "weekly_ritual" },
  { name: "Cooking", benefit: "Nutrition", risk: "Poor diet choices", estimated_minutes: 60, estimated_cost: 50, interval_days: 7, category: "weekly_ritual" },
  { name: "Datenight", benefit: "Wellbeing", risk: "Isolation & loneliness", estimated_minutes: 60, estimated_cost: 0, interval_days: 7, category: "weekly_ritual" },
  { name: "Expression", benefit: "Actualization", risk: "Burnout without creative outlet", estimated_minutes: 60, estimated_cost: 0, interval_days: 7, category: "weekly_ritual" },
  { name: "Nature", benefit: "Stress Reduction", risk: "Nature deficit disorder", estimated_minutes: 60, estimated_cost: 0, interval_days: 14, category: "monthly_renewal" },
  { name: "Sunlight", benefit: "Relaxation", risk: "", estimated_minutes: 15, estimated_cost: 0, interval_days: 14, category: "monthly_renewal" },
  { name: "Dancing", benefit: "Flow", risk: "Crustiness", estimated_minutes: 60, estimated_cost: 0, interval_days: 30, category: "monthly_renewal" },
  { name: "Cleanse", benefit: "Health", risk: "Fat", estimated_minutes: 300, estimated_cost: 0, interval_days: 45, category: "quarterly_reset" },
  { name: "Haircut", benefit: "Appearance", risk: "", estimated_minutes: 60, estimated_cost: 0, interval_days: 45, category: "quarterly_reset" },
  { name: "Massage", benefit: "Tension Release", risk: "Chronic tension buildup", estimated_minutes: 60, estimated_cost: 80, interval_days: 45, category: "quarterly_reset" },
  { name: "Camping", benefit: "Connection", risk: "Disconnection", estimated_minutes: 1800, estimated_cost: 0, interval_days: 180, category: "annual_checkup" },
  { name: "Dentist", benefit: "Health", risk: "Dental complications", estimated_minutes: 60, estimated_cost: 100, interval_days: 360, category: "annual_checkup" },
  { name: "Ecstasis", benefit: "Actualization", risk: "Stagnation", estimated_minutes: 180, estimated_cost: 0, interval_days: 360, category: "annual_checkup" },
  { name: "Physical", benefit: "Health", risk: "Missed health signals", estimated_minutes: 60, estimated_cost: 50, interval_days: 360, category: "annual_checkup" },
] as const;
