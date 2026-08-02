import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const runtimeResourcePools = [
  "realtime_agent",
  "interactive_agent",
  "background_agent",
  "short_worker",
  "isolated_execution",
] as const;
export type RuntimeResourcePool = typeof runtimeResourcePools[number];

export const runtimeRunPhases = ["pending", "leased", "running", "terminal"] as const;
export type RuntimeRunPhase = typeof runtimeRunPhases[number];

export const runtimeRunOutcomes = [
  "succeeded",
  "degraded",
  "blocked",
  "failed",
  "cancelled",
  "needs_review",
] as const;
export type RuntimeRunOutcome = typeof runtimeRunOutcomes[number];

export const runtimeAttributions = [
  "runtime",
  "provider",
  "producer",
  "handler",
  "authority",
  "external_dependency",
  "user",
  "system",
  "unknown",
] as const;
export type RuntimeAttribution = typeof runtimeAttributions[number];

export const runtimeAttemptPhases = ["leased", "running", "finished"] as const;
export type RuntimeAttemptPhase = typeof runtimeAttemptPhases[number];

export const runtimeAttemptResults = ["completed", "retry", "lost", "cancelled", "blocked"] as const;
export type RuntimeAttemptResult = typeof runtimeAttemptResults[number];

export const runtimeEventTypes = [
  "authorization",
  "mutation",
  "verification",
  "failure",
  "correction",
  "terminal_receipt",
] as const;
export type RuntimeEventType = typeof runtimeEventTypes[number];

export interface RuntimeBudgetV1 {
  maxWallClockMs: number;
  maxAttempts: number;
  maxSpendMicros: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxToolCalls: number | null;
  maxFanOut: number | null;
}

export interface RuntimeRetryPolicyV1 {
  version: 1;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableFailureClasses: string[];
}

export interface RuntimePoolCapacityV1 {
  limit: number;
  accountLimit: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  interactiveReserve: number;
}

export type RuntimeResourcePoolV1 = Exclude<RuntimeResourcePool, "realtime_agent">;

export interface RuntimeCapacityPolicyV1 {
  version: 1;
  globalLimit: number;
  accountHeadLimit: number;
  pools: Record<RuntimeResourcePoolV1, RuntimePoolCapacityV1>;
  accountOverrides: Record<string, Partial<Record<RuntimeResourcePoolV1, { limit: number }>>>;
}

export interface RuntimeCapacityPolicyV2 {
  version: 2;
  globalLimit: number;
  accountHeadLimit: number;
  accountScheduling: "work_conserving_fair_share";
  pools: Record<RuntimeResourcePool, RuntimePoolCapacityV1>;
  accountOverrides: Record<string, Partial<Record<RuntimeResourcePool, { limit: number }>>>;
}

export type RuntimeCapacityPolicy = RuntimeCapacityPolicyV1 | RuntimeCapacityPolicyV2;

export interface RuntimeReceiptV1 {
  version: 1;
  runId: string;
  accountId: string;
  kind: string;
  handler: { key: string; version: number };
  source: { type: string; id: string };
  idempotencyKey: string;
  causalParentRunId: string | null;
  resourcePool: RuntimeResourcePool;
  executorProfile: string;
  runAs: { actorType: "user" | "service"; subjectId: string };
  authorityPolicyVersionAtEnqueue: string;
  capacityPolicyVersion: number | null;
  inputRefHashes: string[];
  attemptCount: number;
  queueLatencyMs: number;
  executionLatencyMs: number | null;
  budget: RuntimeBudgetV1;
  measuredUsage: Record<string, number>;
  evidenceEventIds: string[];
  outputRefs: string[];
  verificationLevel: "none" | "self_reported" | "observed" | "verified";
  outcome: RuntimeRunOutcome;
  reasonCode: string;
  attribution: RuntimeAttribution;
  terminalAt: string;
  receiptHash: string;
}

export const runtimeRuns = pgTable("runtime_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  handlerKey: text("handler_key").notNull(),
  handlerVersion: integer("handler_version").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  causalParentRunId: uuid("causal_parent_run_id"),
  runAsActorType: text("run_as_actor_type").notNull(),
  runAsSubjectId: text("run_as_subject_id").notNull(),
  resourcePool: text("resource_pool", { enum: runtimeResourcePools }).notNull(),
  executorProfile: text("executor_profile").notNull(),
  priority: integer("priority").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  inputSchemaVersion: integer("input_schema_version").notNull(),
  input: jsonb("input").$type<unknown>().notNull(),
  inputRefs: jsonb("input_refs").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  authorityPolicyVersionAtEnqueue: text("authority_policy_version_at_enqueue").notNull(),
  budget: jsonb("budget").$type<RuntimeBudgetV1>().notNull(),
  retryPolicy: jsonb("retry_policy").$type<RuntimeRetryPolicyV1>().notNull(),
  phase: text("phase", { enum: runtimeRunPhases }).notNull().default("pending"),
  outcome: text("outcome", { enum: runtimeRunOutcomes }),
  outcomeReasonCode: text("outcome_reason_code"),
  attribution: text("attribution", { enum: runtimeAttributions }),
  currentAttemptId: uuid("current_attempt_id"),
  receiptEventId: uuid("receipt_event_id"),
  cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
  cancellationReasonCode: text("cancellation_reason_code"),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("runtime_runs_account_kind_idempotency").on(table.accountId, table.kind, table.idempotencyKey),
  uniqueIndex("runtime_runs_account_id_unique").on(table.accountId, table.id),
  index("runtime_runs_dispatch_head").on(table.resourcePool, table.phase, table.availableAt, table.accountId),
  index("runtime_runs_owner_created").on(table.ownerUserId, table.accountId, table.createdAt),
  index("runtime_runs_parent").on(table.causalParentRunId),
  check("runtime_runs_user_scope_check", sql`${table.scope} = 'user'`),
  check("runtime_runs_handler_version_check", sql`${table.handlerVersion} > 0 AND ${table.inputSchemaVersion} > 0`),
  check("runtime_runs_priority_check", sql`${table.priority} BETWEEN -100 AND 100`),
  check("runtime_runs_deadline_check", sql`${table.deadlineAt} > ${table.createdAt}`),
  check("runtime_runs_run_as_check", sql`${table.runAsActorType} IN ('user', 'service')`),
  check("runtime_runs_phase_check", sql`${table.phase} IN ('pending', 'leased', 'running', 'terminal')`),
  check("runtime_runs_terminal_shape_check", sql`
    (${table.phase} = 'terminal'
      AND ${table.outcome} IS NOT NULL
      AND ${table.outcomeReasonCode} IS NOT NULL
      AND ${table.attribution} IS NOT NULL
      AND ${table.receiptEventId} IS NOT NULL
      AND ${table.terminalAt} IS NOT NULL)
    OR
    (${table.phase} <> 'terminal'
      AND ${table.outcome} IS NULL
      AND ${table.outcomeReasonCode} IS NULL
      AND ${table.attribution} IS NULL
      AND ${table.receiptEventId} IS NULL
      AND ${table.terminalAt} IS NULL)
  `),
  check("runtime_runs_attempt_shape_check", sql`
    (${table.phase} = 'pending' AND ${table.currentAttemptId} IS NULL)
    OR (${table.phase} IN ('leased', 'running') AND ${table.currentAttemptId} IS NOT NULL)
    OR (${table.phase} = 'terminal')
  `),
]);

export const runtimeAttempts = pgTable("runtime_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  accountId: text("account_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  resourcePool: text("resource_pool", { enum: runtimeResourcePools }).notNull(),
  leaseEpoch: integer("lease_epoch").notNull(),
  leaseTokenHash: text("lease_token_hash").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  workerId: text("worker_id").notNull(),
  executorProfile: text("executor_profile").notNull(),
  capacityPolicyVersion: integer("capacity_policy_version").notNull(),
  phase: text("phase", { enum: runtimeAttemptPhases }).notNull().default("leased"),
  result: text("result", { enum: runtimeAttemptResults }),
  failureClass: text("failure_class"),
  reasonCode: text("reason_code"),
  attribution: text("attribution", { enum: runtimeAttributions }),
  usageSummary: jsonb("usage_summary").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  leasedAt: timestamp("leased_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
}, (table) => [
  uniqueIndex("runtime_attempts_run_number_unique").on(table.runId, table.attemptNumber),
  uniqueIndex("runtime_attempts_run_epoch_unique").on(table.runId, table.leaseEpoch),
  uniqueIndex("runtime_attempts_account_run_id_unique").on(table.accountId, table.runId, table.id),
  index("runtime_attempts_active_capacity").on(table.resourcePool, table.phase, table.leaseExpiresAt),
  index("runtime_attempts_account_active").on(table.accountId, table.resourcePool, table.phase, table.leaseExpiresAt),
  index("runtime_attempts_run_leased").on(table.runId, table.leasedAt),
  check("runtime_attempts_user_scope_check", sql`${table.scope} = 'user'`),
  check("runtime_attempts_number_check", sql`${table.attemptNumber} > 0 AND ${table.leaseEpoch} > 0`),
  check("runtime_attempts_token_hash_check", sql`${table.leaseTokenHash} ~ '^[0-9a-f]{64}$'`),
  check("runtime_attempts_phase_check", sql`${table.phase} IN ('leased', 'running', 'finished')`),
  check("runtime_attempts_finished_shape_check", sql`
    (${table.phase} = 'finished' AND ${table.result} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)
    OR (${table.phase} <> 'finished' AND ${table.result} IS NULL AND ${table.finishedAt} IS NULL)
  `),
]);

export const runtimeRunEvents = pgTable("runtime_run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  attemptId: uuid("attempt_id"),
  accountId: text("account_id").notNull(),
  eventType: text("event_type", { enum: runtimeEventTypes }).notNull(),
  reasonCode: text("reason_code"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  payloadHash: text("payload_hash").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
}, (table) => [
  uniqueIndex("runtime_run_events_terminal_receipt_unique").on(table.runId).where(sql`${table.eventType} = 'terminal_receipt'`),
  uniqueIndex("runtime_run_events_account_run_id_unique").on(table.accountId, table.runId, table.id),
  index("runtime_run_events_run_time").on(table.runId, table.occurredAt),
  index("runtime_run_events_attempt_time").on(table.attemptId, table.occurredAt),
  index("runtime_run_events_owner_time").on(table.ownerUserId, table.accountId, table.occurredAt),
  check("runtime_run_events_user_scope_check", sql`${table.scope} = 'user'`),
  check("runtime_run_events_type_check", sql`${table.eventType} IN ('authorization','mutation','verification','failure','correction','terminal_receipt')`),
  check("runtime_run_events_hash_check", sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
]);

export const runtimeCapacityPolicies = pgTable("runtime_capacity_policies", {
  version: integer("version").primaryKey(),
  policy: jsonb("policy").$type<RuntimeCapacityPolicy>().notNull(),
  policyHash: text("policy_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("runtime_capacity_policies_version_check", sql`${table.version} > 0`),
  check("runtime_capacity_policies_hash_check", sql`${table.policyHash} ~ '^[0-9a-f]{64}$'`),
  check("runtime_capacity_policies_shape_check", sql`jsonb_typeof(${table.policy}) = 'object'`),
]);

export type RuntimeRunRow = typeof runtimeRuns.$inferSelect;
export type RuntimeAttemptRow = typeof runtimeAttempts.$inferSelect;
export type RuntimeRunEventRow = typeof runtimeRunEvents.$inferSelect;
export type RuntimeCapacityPolicyRow = typeof runtimeCapacityPolicies.$inferSelect;
