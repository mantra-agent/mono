import { pgTable, text, varchar, serial, integer, timestamp, boolean, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const skillAuthorities = ["full", "notify", "approve", "blocked"] as const;

export const sessionTypes = ["autonomous", "agent"] as const;
export type SessionType = typeof sessionTypes[number];
export type SkillAuthority = typeof skillAuthorities[number];

export const skillWriteCategories = ["read-only", "internal-data", "internal-control", "external", "destructive"] as const;
export type SkillWriteCategory = typeof skillWriteCategories[number];

export const skillStatuses = ["active", "draft", "deprecated"] as const;
export type SkillStatus = typeof skillStatuses[number];

export const skillInputTypes = ["task", "people", "memories", "events", "files", "project"] as const;
export type SkillInputType = typeof skillInputTypes[number];

export const skillCategories = ["memory", "thinking", "chat", "goals", "people", "projects", "strategy", "reflection", "development", "other"] as const;
export type SkillCategory = typeof skillCategories[number];

export interface ChecklistItem {
  check: string;
  weight?: number;
}

export interface CheckResult {
  check: string;
  passed: boolean;
  evidence: string;
}

export interface ComparativeResult {
  winner: "current" | "prior" | "tie";
  reason: string;
}

export const checklistItemSchema = z.object({
  check: z.string().min(1),
  weight: z.number().optional(),
});

export const skills = pgTable("skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 64 }).notNull().unique(),
  description: text("description").notNull(),

  category: text("category").notNull().default("other"),
  activity: text("activity").notNull().default("e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d"),

  authority: text("authority").notNull().default("full"),
  writeCategory: text("write_category").notNull().default("read-only"),

  allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`), // deprecated — no longer enforced; kept for DB compat
  inputs: text("inputs").array().notNull().default(sql`'{}'::text[]`),

  estimatedTokens: integer("estimated_tokens").notNull().default(0),
  estimatedDuration: text("estimated_duration").notNull().default("5min"),

  whenToUse: text("when_to_use").notNull(),
  process: text("process").notNull(),
  outputSpec: text("output_spec").notNull(),
  qualityCriteria: text("quality_criteria").notNull(), // deprecated — superseded by `checklist` JSONB column. Kept for backwards compatibility.
  budgetBehavior: text("budget_behavior"),

  checklist: jsonb("checklist").notNull().default(sql`'[]'::jsonb`),

  status: text("status").notNull().default("draft"),
  version: text("version").notNull().default("1.0"),
  author: text("author").notNull().default("user"),

  addToMemory: boolean("add_to_memory").notNull().default(true),
  pinnedToContext: boolean("pinned_to_context").notNull().default(false),
  customized: boolean("customized").notNull().default(false),
  scope: text("scope").notNull().default("global"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),

  sessionType: text("session_type"),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_skills_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_skills_account").on(table.accountId),
]);

// skillScores table removed — superseded by skill_runs. DB table retained for historical data.

export const skillRunStatuses = ["running", "succeeded", "failed", "yielded", "checkpoint"] as const;
export type SkillRunStatus = typeof skillRunStatuses[number];

export const skillRuns = pgTable("skill_runs", {
  id: serial("id").primaryKey(),
  skillName: varchar("skill_name", { length: 64 }).notNull(),
  sessionId: text("session_id").notNull().unique(),
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, precision: 6 }),
  durationMs: integer("duration_ms"),
  passRate: real("pass_rate"),
  checklistTotal: integer("checklist_total"),
  checklistPassed: integer("checklist_passed"),
  checklistResults: jsonb("checklist_results"),
  comparativeVsId: integer("comparative_vs_id"),
  comparativeWinner: text("comparative_winner"),
  comparativeReason: text("comparative_reason"),
  failureReason: text("failure_reason"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_skill_runs_owner_started").on(table.ownerUserId, table.startedAt),
  index("idx_skill_runs_account_started").on(table.accountId, table.startedAt),
]);

export type SkillRun = typeof skillRuns.$inferSelect;

export const skillReferences = pgTable("skill_references", {
  id: serial("id").primaryKey(),
  skillId: varchar("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
});

export const insertSkillSchema = createInsertSchema(skills).omit({
  id: true,
  successCount: true,
  failureCount: true,
  createdAt: true,
  updatedAt: true,
  allowedTools: true,
  customized: true,
}).extend({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, numbers, and hyphens only"),
  description: z.string().min(1).max(1024),
  category: z.string().default("other"),
  activity: z.string().default("e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d"),
  authority: z.enum(skillAuthorities),
  writeCategory: z.enum(skillWriteCategories),
  inputs: z.array(z.enum(skillInputTypes)).default([]),
  estimatedTokens: z.number().int().min(0).default(0),
  estimatedDuration: z.string().default("5min"),
  status: z.enum(skillStatuses).default("draft"),
  version: z.string().default("1.0"),
  author: z.string().default("user"),
  budgetBehavior: z.string().nullable().optional(),
  sessionType: z.enum(sessionTypes).nullable().optional(),
  checklist: z.array(checklistItemSchema).optional().default([]),
  references: z.array(z.object({
    name: z.string().min(1),
    content: z.string().min(1),
  })).optional().default([]),
});

export const skillFailureDismissals = pgTable("skill_failure_dismissals", {
  id: serial("id").primaryKey(),
  skillName: varchar("skill_name", { length: 64 }).notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("skill_failure_dismissals_skill_name_key").on(table.skillName),
  index("idx_skill_failure_dismissals_owner").on(table.skillName, table.ownerUserId),
  index("idx_skill_failure_dismissals_account").on(table.skillName, table.accountId),
]);

export type SkillFailureDismissal = typeof skillFailureDismissals.$inferSelect;

export const insertSkillReferenceSchema = createInsertSchema(skillReferences).omit({
  id: true,
});

export type Skill = typeof skills.$inferSelect;
export type SkillResponse = Omit<Skill, "allowedTools">;
export type SkillReference = typeof skillReferences.$inferSelect;
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type InsertSkillReference = z.infer<typeof insertSkillReferenceSchema>;

export interface SkillWithReferences extends SkillResponse {
  references: SkillReference[];
  trustScore: number;
}
