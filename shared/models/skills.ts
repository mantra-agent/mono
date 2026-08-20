import { pgTable, text, varchar, serial, integer, timestamp, boolean, jsonb, real, index, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { personas } from "./cognition";
import type { ModKey } from "./mods";
import { sql } from "drizzle-orm";

export const skillAuthorities = ["full", "notify", "approve", "blocked"] as const;

export const sessionTypes = ["autonomous", "agent"] as const;
export type SessionType = typeof sessionTypes[number];
export type SkillAuthority = typeof skillAuthorities[number];

export const skillStatuses = ["active", "draft", "deprecated"] as const;
export type SkillStatus = typeof skillStatuses[number];

export const checklistKinds = ["judgment", "tool_invoked", "child_skill_invoked"] as const;
export type ChecklistKind = typeof checklistKinds[number];

export interface ChecklistItem {
  check: string;
  weight?: number;
  /** Evaluation kind. "judgment" (default) is scored by the LLM evaluator.
   * "tool_invoked" is deterministic: passes iff `tool` has at least one
   * successful invocation in the run's persisted tool calls. */
  kind?: ChecklistKind;
  /** Tool name for kind "tool_invoked". Validated against the unified tool
   * registry at the skills tool write boundary. */
  tool?: string;
  /** Optional action discriminator for kind "tool_invoked". When present, the
   * run must successfully invoke this exact tool action, not merely the tool. */
  action?: string;
  /** Skill name for kind "child_skill_invoked". The gate passes only when an
   * exact, freshly spawned child skill_run linked to this parent succeeds. */
  skill?: string;
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
  kind: z.enum(checklistKinds).optional(),
  tool: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  skill: z.string().min(1).optional(),
}).superRefine((item, ctx) => {
  if (item.kind === "tool_invoked" && typeof item.tool !== "string") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'checklist items with kind "tool_invoked" require a tool name' });
  }
  if (item.kind === "child_skill_invoked" && typeof item.skill !== "string") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'checklist items with kind "child_skill_invoked" require a skill name' });
  }
});

export const skills = pgTable("skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  /** Stable machine identity (kebab). Never user-facing rename surface. */
  name: varchar("name", { length: 64 }).notNull(),
  /** Free human label. Null means fall back to `name`. */
  displayName: text("display_name"),
  description: text("description").notNull(),

  authority: text("authority").notNull().default("full"),

  allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`), // deprecated — no longer enforced; kept for DB compat

  whenToUse: text("when_to_use").notNull(),
  process: text("process").notNull(),
  outputSpec: text("output_spec").notNull(),
  qualityCriteria: text("quality_criteria").notNull(), // deprecated — superseded by `checklist` JSONB column. Kept for backwards compatibility.

  checklist: jsonb("checklist").notNull().default(sql`'[]'::jsonb`),

  // scoreThreshold: minimum checklist pass rate (0-1) below which a scored
  // "succeeded" run is reconciled to "degraded". Null = no gating. Deterministic
  // per-tool gating lives in checklist items with kind "tool_invoked" — the
  // checklist is the single quality-specification surface.
  scoreThreshold: real("score_threshold"),

  status: text("status").notNull().default("draft"),
  version: text("version").notNull().default("1.0"),

  addToMemory: boolean("add_to_memory").notNull().default(true),
  pinnedToContext: boolean("pinned_to_context").notNull().default(false),
  /** Freeze flag until updateState is projected; lattice cut 1 keeps both. */
  customized: boolean("customized").notNull().default(false),
  scope: text("scope").notNull().default("global"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  vaultId: text("vault_id"),
  /** Pinned Agent Instance mind owner; owner_user_id stays created_by. */
  instanceId: text("instance_id"),

  /** Same-name global template this user shadow follows (Persona templatePersonaId). */
  templateSkillId: varchar("template_skill_id"),
  baseRevisionId: text("base_revision_id"),
  currentRevisionId: text("current_revision_id"),
  /** following | customized | update_available | conflict | pinned_legacy */
  updateState: text("update_state").notNull().default("pinned_legacy"),

  sessionType: text("session_type"),
  personaId: integer("persona_id"),
  recommendedPersonaTemplateId: integer("recommended_persona_template_id").references(() => personas.id, { onDelete: "set null" }),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_skills_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_skills_account").on(table.accountId),
  index("idx_skills_instance").on(table.instanceId),
  index("idx_skills_template").on(table.templateSkillId),
  uniqueIndex("idx_skills_global_name_unique").on(table.name).where(sql`${table.scope} = 'global'`),
  uniqueIndex("idx_skills_owner_name_unique").on(table.ownerUserId, table.accountId, table.name).where(sql`${table.scope} = 'user'`),
]);

/**
 * Immutable Skill payload history (Persona persona_revisions mirror).
 * Skill identity IDs are UUID text, not serial ints.
 */
export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: text("id").primaryKey(),
    skillIdentityId: varchar("skill_identity_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // platform | user
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    /** Pinned Agent Instance mind owner for user revisions; platform rows stay null. */
    instanceId: text("instance_id"),
    parentRevisionId: text("parent_revision_id"),
    platformBaseRevisionId: text("platform_base_revision_id"),
    payload: jsonb("payload").notNull(),
    contentHash: text("content_hash").notNull(),
    changeSummary: text("change_summary").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_skill_revisions_identity_created").on(table.skillIdentityId, table.createdAt),
    index("idx_skill_revisions_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_skill_revisions_instance").on(table.instanceId),
    index("idx_skill_revisions_identity_hash").on(table.skillIdentityId, table.contentHash),
  ],
);

export type SkillRevision = typeof skillRevisions.$inferSelect;

// skillScores table removed — superseded by skill_runs. DB table retained for historical data.

export const skillRunStatuses = ["running", "succeeded", "degraded", "failed", "yielded", "checkpoint"] as const;
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
  parentSessionId: text("parent_session_id"),
  parentSkillRunId: integer("parent_skill_run_id"),
  parentToolCallId: text("parent_tool_call_id"),
  runtimeRunId: uuid("runtime_run_id"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  vaultId: text("vault_id"),
  /** Pinned Agent Instance mind owner; owner_user_id stays created_by. */
  instanceId: text("instance_id"),
}, (table) => [
  index("idx_skill_runs_owner_started").on(table.ownerUserId, table.startedAt),
  index("idx_skill_runs_account_started").on(table.accountId, table.startedAt),
  index("idx_skill_runs_instance").on(table.instanceId),
  index("idx_skill_runs_parent_lineage").on(table.parentSkillRunId, table.parentToolCallId, table.skillName),
  uniqueIndex("idx_skill_runs_runtime_run_unique").on(table.runtimeRunId).where(sql`${table.runtimeRunId} IS NOT NULL`),
]);

export type SkillRun = typeof skillRuns.$inferSelect;

export const skillReferences = pgTable("skill_references", {
  id: serial("id").primaryKey(),
  skillId: varchar("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
});

/**
 * Object-level insert shape. Keep this a ZodObject so consumers can `.omit` /
 * `.partial` / `.shape` at module load. Wrapping with `.superRefine` yields
 * ZodEffects, which has no `.omit` and crashed stage boot in skill-routes.
 */
export const insertSkillObjectSchema = createInsertSchema(skills).omit({
  id: true,
  successCount: true,
  failureCount: true,
  createdAt: true,
  updatedAt: true,
  allowedTools: true,
  customized: true,
  templateSkillId: true,
  baseRevisionId: true,
  currentRevisionId: true,
  updateState: true,
  instanceId: true,
}).extend({
  /** Stable machine id. Optional on create when displayName is provided — server mints a kebab slug. */
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, numbers, and hyphens only").optional(),
  /** Free human label — no kebab constraint. */
  displayName: z.string().min(1).max(200).nullable().optional(),
  description: z.string().min(1).max(1024),
  authority: z.enum(skillAuthorities).default("full"),
  status: z.enum(skillStatuses).default("draft"),
  version: z.string().default("1.0"),
  sessionType: z.enum(sessionTypes).nullable().optional(),
  whenToUse: z.string().optional().default(""),
  outputSpec: z.string().optional().default(""),
  addToMemory: z.boolean().optional().default(true),
  /** Leftover structural seed gates only; product quality is process-text review. */
  checklist: z.array(checklistItemSchema).optional().default([]),
  scoreThreshold: z.number().min(0).max(1).nullable().optional(),
  recommendedPersonaTemplateId: z.number().int().positive().nullable().optional(),
  references: z.array(z.object({
    name: z.string().min(1),
    content: z.string().min(1),
  })).optional().default([]),
});

/** Full create validation including name/displayName cross-field rule. */
export const insertSkillSchema = insertSkillObjectSchema.superRefine((value, ctx) => {
  if (!value.name && !(typeof value.displayName === "string" && value.displayName.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide a display name (or a stable machine name)",
      path: ["displayName"],
    });
  }
});

export const skillFailureDismissals = pgTable("skill_failure_dismissals", {
  id: serial("id").primaryKey(),
  skillName: varchar("skill_name", { length: 64 }).notNull(),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("skill_failure_dismissals_owner_name_key").on(table.ownerUserId, table.accountId, table.skillName),
  index("idx_skill_failure_dismissals_owner").on(table.skillName, table.ownerUserId),
  index("idx_skill_failure_dismissals_account").on(table.skillName, table.accountId),
]);

export type SkillFailureDismissal = typeof skillFailureDismissals.$inferSelect;

// Per-user persona overrides for skills. A row here means "when this user runs
// this skill, use this persona" — it takes precedence over the skill's global
// recommendedPersonaTemplateId. Persona IDs reference personas visible to the
// owning user (their copies or global templates).
export const skillPersonaPreferences = pgTable("skill_persona_preferences", {
  id: serial("id").primaryKey(),
  skillId: varchar("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  personaId: integer("persona_id").notNull().references(() => personas.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("skill_persona_preferences_skill_user_account_key").on(table.skillId, table.ownerUserId, table.accountId),
  index("idx_skill_persona_preferences_owner").on(table.ownerUserId),
  index("idx_skill_persona_preferences_account").on(table.accountId),
]);

export type SkillPersonaPreference = typeof skillPersonaPreferences.$inferSelect;

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
  /**
   * Management-read projection of the Mod that contributes this Skill.
   * Undeclared names (Core seeds and user-authored Skills) are `"core"`.
   * Owner identity lives in the Mod registry, not a Skill column.
   */
  sourceMod?: "core" | ModKey;
  /**
   * Skill Default Lattice read-enrichment (Persona parity). Present on
   * management reads; omitted on raw writes. `platformBaseline` is the current
   * platform-default payload this copy follows, `changedFields` are the named
   * fields this copy is locally ahead on, and `updateAvailable` is true when the
   * default advanced past this copy and their content still differs.
   */
  platformBaseline?: Record<string, unknown> | null;
  changedFields?: string[];
  updateAvailable?: boolean;
}
