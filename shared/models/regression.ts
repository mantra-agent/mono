import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { planExecutions, workflowRuns, workflowStageAttempts } from "../schema";
import { platformProductEnvironments } from "./platforms";

export const regressionRunStatuses = ["queued", "claimed", "planning", "executing", "completed", "partial", "failed", "skipped"] as const;
export const regressionResultStatuses = ["passed", "failed", "blocked"] as const;
export const regressionContractDispositions = ["enabled", "not_applicable"] as const;

export const regressionRunStatusSchema = z.enum(regressionRunStatuses);
export const regressionResultStatusSchema = z.enum(regressionResultStatuses);
export const regressionContractDispositionSchema = z.enum(regressionContractDispositions);

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const semanticTargetSchema = z.union([
  z.object({ by: z.literal("role"), role: boundedText(40), name: boundedText(200) }).strict(),
  z.object({ by: z.literal("test_id"), value: boundedText(200) }).strict(),
  z.object({ by: z.literal("label"), value: boundedText(200) }).strict(),
  z.object({ by: z.literal("placeholder"), value: boundedText(200) }).strict(),
]);

const relativePathSchema = z.string().trim().min(1).max(500)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), "Path must be same-origin and begin with one slash")
  .refine((value) => {
    try {
      const parsed = new URL(value, "https://regression.invalid");
      return parsed.origin === "https://regression.invalid" && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }, "Path must be a valid same-origin relative URL");

export const regressionScenarioStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), path: relativePathSchema }).strict(),
  z.object({ action: z.literal("click"), target: semanticTargetSchema }).strict(),
  z.object({ action: z.literal("fill"), target: semanticTargetSchema, value: z.string().max(2_000) }).strict(),
  z.object({ action: z.literal("press"), target: semanticTargetSchema.optional(), key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]) }).strict(),
  z.object({ action: z.literal("wait_for"), state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: boundedText(500) }).strict(),
    z.object({ kind: z.literal("element"), target: semanticTargetSchema, visible: z.boolean().default(true) }).strict(),
    z.object({ kind: z.literal("url"), path: relativePathSchema }).strict(),
  ]) }).strict(),
  z.object({ action: z.literal("assert_text"), text: boundedText(500), visible: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("assert_element"), target: semanticTargetSchema, visible: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("assert_url"), path: relativePathSchema }).strict(),
]);

export const issueRegressionContractInputSchema = z.object({
  disposition: regressionContractDispositionSchema.default("enabled"),
  exclusionReason: z.string().trim().max(1_000).nullable().optional(),
  environmentIds: z.array(z.number().int().positive()).max(20).default([]),
  routePath: relativePathSchema.nullable().optional(),
  steps: z.array(regressionScenarioStepSchema).max(15).default([]),
  expectedOutcome: z.string().trim().max(2_000).nullable().optional(),
  setupNotes: z.string().trim().max(2_000).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.disposition === "not_applicable" && !value.exclusionReason?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exclusionReason"], message: "not_applicable requires an explicit exclusion reason" });
  }
  if (value.disposition === "enabled") {
    if (!value.routePath) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["routePath"], message: "enabled contracts require routePath" });
    if (value.steps.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "enabled contracts require at least one scenario step" });
    if (!value.expectedOutcome?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedOutcome"], message: "enabled contracts require expectedOutcome" });
  }
});

export type RegressionScenarioStep = z.infer<typeof regressionScenarioStepSchema>;
export type IssueRegressionContractInput = z.infer<typeof issueRegressionContractInputSchema>;

export const regressionRuns = pgTable("regression_runs", {
  id: text("id").primaryKey(),
  triggerKey: text("trigger_key").notNull(),
  environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "restrict" }),
  acceptedDeploymentId: text("accepted_deployment_id").notNull(),
  acceptedRevision: text("accepted_revision").notNull(),
  sourceWorkflowRunId: text("source_workflow_run_id").references(() => workflowRuns.id, { onDelete: "set null" }),
  acceptanceAttemptId: integer("acceptance_attempt_id").references(() => workflowStageAttempts.id, { onDelete: "set null" }),
  lifecycleSnapshot: jsonb("lifecycle_snapshot").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("queued"),
  skillSessionId: text("skill_session_id"),
  planId: text("plan_id").references(() => planExecutions.id, { onDelete: "set null" }),
  candidateSnapshot: jsonb("candidate_snapshot"),
  failureContext: jsonb("failure_context"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("regression_runs_scope_check", sql`${table.scope} = 'user'`),
  check("regression_runs_status_check", sql`${table.status} IN ('queued','claimed','planning','executing','completed','partial','failed','skipped')`),
  uniqueIndex("regression_runs_owner_trigger_key").on(table.ownerUserId, table.accountId, table.triggerKey),
  uniqueIndex("regression_runs_plan_unique").on(table.planId).where(sql`${table.planId} IS NOT NULL`),
  index("regression_runs_due_status").on(table.status, table.dueAt),
  index("regression_runs_owner_created").on(table.ownerUserId, table.createdAt),
  index("regression_runs_environment_created").on(table.environmentId, table.createdAt),
]);

export const issueRegressionContracts = pgTable("issue_regression_contracts", {
  id: serial("id").primaryKey(),
  issueId: bigint("issue_id", { mode: "number" }).notNull(),
  disposition: text("disposition").notNull().default("enabled"),
  exclusionReason: text("exclusion_reason"),
  environmentIds: jsonb("environment_ids").$type<number[]>().notNull().default([]),
  routePath: text("route_path"),
  steps: jsonb("steps").$type<RegressionScenarioStep[]>().notNull().default([]),
  expectedOutcome: text("expected_outcome"),
  setupNotes: text("setup_notes"),
  version: integer("version").notNull().default(1),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("issue_regression_contracts_scope_check", sql`${table.scope} = 'user'`),
  check("issue_regression_contracts_disposition_check", sql`${table.disposition} IN ('enabled','not_applicable')`),
  check("issue_regression_contracts_exclusion_check", sql`${table.disposition} <> 'not_applicable' OR length(trim(${table.exclusionReason})) > 0`),
  uniqueIndex("issue_regression_contracts_owner_issue_key").on(table.ownerUserId, table.accountId, table.issueId),
  index("issue_regression_contracts_issue").on(table.issueId),
  index("issue_regression_contracts_owner_updated").on(table.ownerUserId, table.updatedAt),
]);

export const issueRegressionResults = pgTable("issue_regression_results", {
  id: serial("id").primaryKey(),
  regressionRunId: text("regression_run_id").notNull().references(() => regressionRuns.id, { onDelete: "restrict" }),
  issueId: bigint("issue_id", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  reasonCode: text("reason_code").notNull(),
  planId: text("plan_id").references(() => planExecutions.id, { onDelete: "set null" }),
  planStepId: text("plan_step_id"),
  environmentId: integer("environment_id").notNull().references(() => platformProductEnvironments.id, { onDelete: "restrict" }),
  deploymentId: text("deployment_id").notNull(),
  revision: text("revision").notNull(),
  sessionId: text("session_id"),
  contractVersion: integer("contract_version"),
  summary: text("summary").notNull(),
  actionTrace: jsonb("action_trace").notNull().default([]),
  assertions: jsonb("assertions").notNull().default([]),
  screenshots: jsonb("screenshots").notNull().default([]),
  browserEvidence: jsonb("browser_evidence").notNull().default({}),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("issue_regression_results_scope_check", sql`${table.scope} = 'user'`),
  check("issue_regression_results_status_check", sql`${table.status} IN ('passed','failed','blocked')`),
  uniqueIndex("issue_regression_results_run_issue_key").on(table.ownerUserId, table.accountId, table.regressionRunId, table.issueId),
  index("issue_regression_results_run_created").on(table.regressionRunId, table.createdAt),
  index("issue_regression_results_issue_created").on(table.issueId, table.createdAt),
]);

export type RegressionRun = typeof regressionRuns.$inferSelect;
export type IssueRegressionContract = typeof issueRegressionContracts.$inferSelect;
export type IssueRegressionResult = typeof issueRegressionResults.$inferSelect;
