import crypto from "crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  runtimeAttempts,
  runtimeCapacityPolicies,
  runtimeRunEvents,
  runtimeRuns,
  type RuntimeAttemptRow,
  type RuntimeAttribution,
  type RuntimeBudgetV1,
  type RuntimeCapacityPolicy,
  type RuntimeCapacityPolicyV1,
  type RuntimeCapacityPolicyV2,
  type RuntimePoolCapacityV1,
  type RuntimeReceiptV1,
  type RuntimeResourcePool,
  type RuntimeRunOutcome,
  type RuntimeRunRow,
  type RuntimeRetryPolicyV1,
} from "@shared/models/runtime";
import { transactionalOutbox } from "@shared/models/outbox";
import { normalizeProtocolAddress } from "@shared/life-addressing";
import { users } from "@shared/schema";
import {
  acquireAdvisoryTransactionLock,
  ADVISORY_LOCK_NS,
  db,
  runWithDatabaseTransaction,
  type DrizzleTx,
} from "../db";
import { createLogger } from "../log";
import { createNamedSystemPrincipal, createUserSessionPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { appendTransactionalOutboxEvent } from "../transactional-outbox";
import {
  runtimeHandlerRegistry,
  type RuntimeAttemptDecision,
  type RuntimeExecutorProfile,
  type RuntimeFence,
  type RuntimeHandler,
} from "./runtime-handler";
import { LEGACY_CAPACITY_HANDLER_KEY } from "./legacy-capacity-handler";

const log = createLogger("RuntimeKernel");
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_REFERENCE_COUNT = 100;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const MAX_EVIDENCE_EVENTS_PER_RECEIPT = 100;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_OUTPUT_REFERENCES = 100;
const DEFAULT_ACCOUNT_HEAD_LIMIT = 50;
export const DEFAULT_PROTECTED_ACCOUNT_SHARE = 2;

const runScope = { scope: runtimeRuns.scope, ownerUserId: runtimeRuns.ownerUserId, accountId: runtimeRuns.accountId };
const attemptScope = { scope: runtimeAttempts.scope, ownerUserId: runtimeAttempts.ownerUserId, accountId: runtimeAttempts.accountId };
const eventScope = { scope: runtimeRunEvents.scope, ownerUserId: runtimeRunEvents.ownerUserId, accountId: runtimeRunEvents.accountId };
const outboxScope = { scope: transactionalOutbox.scope, ownerUserId: transactionalOutbox.ownerUserId, accountId: transactionalOutbox.accountId };

export const DEFAULT_RUNTIME_BUDGET_V1: RuntimeBudgetV1 = {
  maxWallClockMs: 15 * 60 * 1000,
  maxAttempts: 3,
  maxSpendMicros: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxToolCalls: null,
  maxFanOut: 20,
};

export const DEFAULT_RUNTIME_RETRY_POLICY_V1: RuntimeRetryPolicyV1 = {
  version: 1,
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60 * 1000,
  retryableFailureClasses: ["transient_database", "transient_network", "provider_transient", "lease_lost", "safe_timeout", "handler_transient"],
};

export const DEFAULT_RUNTIME_CAPACITY_POLICY_V1: RuntimeCapacityPolicyV1 = {
  version: 1,
  globalLimit: 20,
  accountHeadLimit: DEFAULT_ACCOUNT_HEAD_LIMIT,
  pools: {
    interactive_agent: { limit: 4, accountLimit: 2, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 2 },
    background_agent: { limit: 10, accountLimit: 2, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 0 },
    short_worker: { limit: 6, accountLimit: 4, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 0 },
    isolated_execution: { limit: 2, accountLimit: 1, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 0 },
  },
  accountOverrides: {},
};

export const DEFAULT_RUNTIME_CAPACITY_POLICY_V2: RuntimeCapacityPolicyV2 = {
  version: 2,
  globalLimit: 20,
  accountHeadLimit: DEFAULT_ACCOUNT_HEAD_LIMIT,
  accountScheduling: "work_conserving_fair_share",
  pools: {
    realtime_agent: { limit: 20, accountLimit: DEFAULT_PROTECTED_ACCOUNT_SHARE, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 0 },
    interactive_agent: { limit: 14, accountLimit: DEFAULT_PROTECTED_ACCOUNT_SHARE, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 0 },
    background_agent: { limit: 6, accountLimit: DEFAULT_PROTECTED_ACCOUNT_SHARE, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 14 },
    short_worker: { limit: 6, accountLimit: DEFAULT_PROTECTED_ACCOUNT_SHARE, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 14 },
    isolated_execution: { limit: 2, accountLimit: 1, leaseSeconds: 60, heartbeatSeconds: 15, interactiveReserve: 14 },
  },
  accountOverrides: {},
};

export const DEFAULT_RUNTIME_CAPACITY_POLICY: RuntimeCapacityPolicy = DEFAULT_RUNTIME_CAPACITY_POLICY_V2;

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { actorType: "user"; userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Runtime operations require an explicit user principal");
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function boundedText(value: string, label: string, max = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw Object.assign(new Error(`${label} must be 1-${max} characters`), { status: 400 });
  return normalized;
}

function boundedReasonCode(value: string): string {
  const normalized = boundedText(value, "reasonCode", 120);
  if (!/^[a-z][a-z0-9_.-]*$/.test(normalized)) throw Object.assign(new Error("reasonCode must be a stable lowercase identifier"), { status: 400 });
  return normalized;
}

function boundedJson<T>(value: T, maxBytes: number, label: string): T {
  const bytes = Buffer.byteLength(stableJson(value), "utf8");
  if (bytes > maxBytes) throw Object.assign(new Error(`${label} exceeds ${maxBytes} bytes`), { status: 400 });
  return value;
}

function normalizeReferences(input: readonly string[], label: string, max = MAX_REFERENCE_COUNT): string[] {
  if (input.length > max) throw Object.assign(new Error(`${label} exceeds ${max} references`), { status: 400 });
  return [...new Set(input.map((value) => {
    const normalized = normalizeProtocolAddress(value);
    if (normalized.outcome !== "valid") throw Object.assign(new Error(`${label} contains an invalid canonical reference`), { status: 400 });
    return normalized.address;
  }))];
}

function scopeVisible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, runScope, predicate);
}

function scopeWritable(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, runScope, predicate);
}

function attemptVisible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, attemptScope, predicate);
}

function attemptWritable(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, attemptScope, predicate);
}

function eventVisible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, eventScope, predicate);
}

function outboxVisible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, outboxScope, predicate);
}

function fenceTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

async function restoreRunPrincipal(run: RuntimeRunRow): Promise<Principal & { actorType: "user"; userId: string; accountId: string }> {
  if (run.runAsActorType !== "user" || run.runAsSubjectId !== run.ownerUserId) {
    throw Object.assign(new Error("Runtime authority subject cannot be restored"), { code: "authority_subject_missing" });
  }
  const [user] = await db.select().from(users).where(eq(users.id, run.runAsSubjectId)).limit(1);
  if (!user) throw Object.assign(new Error("Runtime authority subject cannot be restored"), { code: "authority_subject_missing" });
  const principal = await createUserSessionPrincipal(user);
  requireUserPrincipal(principal);
  if (principal.accountId !== run.accountId) {
    throw Object.assign(new Error("Runtime authority account changed"), { code: "authority_account_mismatch" });
  }
  return principal;
}

export interface EnqueueRuntimeRunInput {
  kind: string;
  handler: { key: string; version: number };
  source: { type: string; id: string };
  idempotencyKey: string;
  causalParentRunId?: string | null;
  priority?: number;
  availableAt?: Date;
  deadlineAt: Date;
  inputSchemaVersion: number;
  input: unknown;
  inputRefs?: string[];
  authorityPolicyVersionAtEnqueue: string;
  budget?: RuntimeBudgetV1;
  retryPolicy?: RuntimeRetryPolicyV1;
}

export async function enqueueRuntimeRun(
  principal: Principal,
  input: EnqueueRuntimeRunInput,
): Promise<{ run: RuntimeRunRow; disposition: "created" | "existing" }> {
  requireUserPrincipal(principal);
  const handler = runtimeHandlerRegistry.require(input.handler.key, input.handler.version);
  if (handler.inputSchemaVersion !== input.inputSchemaVersion) {
    throw Object.assign(new Error("Runtime input schema version does not match the handler contract"), { status: 409 });
  }
  const parsedInput = boundedJson(handler.inputSchema.parse(input.input), MAX_INPUT_BYTES, "input");
  const inputRefs = normalizeReferences(input.inputRefs ?? [], "inputRefs");
  const kind = boundedText(input.kind, "kind", 120);
  const sourceType = boundedText(input.source.type, "source.type", 120);
  const sourceId = boundedText(input.source.id, "source.id", 500);
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 500);
  const authorityPolicyVersion = boundedText(input.authorityPolicyVersionAtEnqueue, "authorityPolicyVersionAtEnqueue", 120);
  if (!(input.deadlineAt instanceof Date) || !Number.isFinite(input.deadlineAt.getTime()) || input.deadlineAt <= new Date()) {
    throw Object.assign(new Error("deadlineAt must be a future date"), { status: 400 });
  }
  const availableAt = input.availableAt ?? new Date();
  if (!(availableAt instanceof Date) || !Number.isFinite(availableAt.getTime())) throw Object.assign(new Error("availableAt must be a valid date"), { status: 400 });
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw Object.assign(new Error("priority must be an integer from -100 to 100"), { status: 400 });
  const budget = boundedJson(input.budget ?? DEFAULT_RUNTIME_BUDGET_V1, 8_192, "budget");
  const retryPolicy = boundedJson(input.retryPolicy ?? DEFAULT_RUNTIME_RETRY_POLICY_V1, 8_192, "retryPolicy");
  if (budget.maxAttempts !== retryPolicy.maxAttempts || budget.maxAttempts < 1 || budget.maxAttempts > 20) {
    throw Object.assign(new Error("Budget and retry policy must name the same bounded maxAttempts"), { status: 400 });
  }

  const authorization = await handler.authorize(principal, parsedInput);
  if (!authorization.allowed) {
    throw Object.assign(new Error("Runtime enqueue authorization denied"), { status: 403, code: boundedReasonCode(authorization.reasonCode) });
  }

  if (input.causalParentRunId) {
    const [parent] = await db.select({ id: runtimeRuns.id }).from(runtimeRuns)
      .where(scopeVisible(principal, eq(runtimeRuns.id, input.causalParentRunId))).limit(1);
    if (!parent) throw Object.assign(new Error("Causal parent is not visible in this account"), { status: 404 });
  }

  const requestShape = {
    kind,
    handler: { key: handler.key, version: handler.version },
    source: { type: sourceType, id: sourceId },
    idempotencyKey,
    causalParentRunId: input.causalParentRunId ?? null,
    runAs: { actorType: "user", subjectId: principal.userId },
    resourcePool: handler.resourcePool,
    executorProfile: handler.executorProfile,
    priority,
    availableAt: availableAt.toISOString(),
    deadlineAt: input.deadlineAt.toISOString(),
    inputSchemaVersion: input.inputSchemaVersion,
    input: parsedInput,
    inputRefs,
    authorityPolicyVersionAtEnqueue: authorityPolicyVersion,
    budget,
    retryPolicy,
  };
  const requestHash = hashValue(requestShape);
  const ownership = ownedInsertValues(principal, runScope);
  const inserted = await db.insert(runtimeRuns).values({
    kind,
    handlerKey: handler.key,
    handlerVersion: handler.version,
    sourceType,
    sourceId,
    idempotencyKey,
    requestHash,
    causalParentRunId: input.causalParentRunId ?? null,
    runAsActorType: "user",
    runAsSubjectId: principal.userId,
    resourcePool: handler.resourcePool,
    executorProfile: handler.executorProfile,
    priority,
    availableAt,
    deadlineAt: input.deadlineAt,
    inputSchemaVersion: input.inputSchemaVersion,
    input: parsedInput,
    inputRefs,
    authorityPolicyVersionAtEnqueue: authorityPolicyVersion,
    budget,
    retryPolicy,
    ...ownership,
    createdByUserId: principal.userId,
  }).onConflictDoNothing({ target: [runtimeRuns.accountId, runtimeRuns.kind, runtimeRuns.idempotencyKey] }).returning();

  if (inserted[0]) {
    log.info("runtime.run.enqueued", { runId: inserted[0].id, accountId: inserted[0].accountId, handler: `${handler.key}@${handler.version}`, resourcePool: handler.resourcePool });
    return { run: inserted[0], disposition: "created" };
  }
  const [existing] = await db.select().from(runtimeRuns).where(scopeVisible(principal, and(
    eq(runtimeRuns.kind, kind),
    eq(runtimeRuns.idempotencyKey, idempotencyKey),
  ))).limit(1);
  if (!existing) throw new Error("Runtime enqueue conflict did not resolve to a visible run");
  if (existing.requestHash !== requestHash) {
    throw Object.assign(new Error("Runtime idempotency key already names different input"), { status: 409 });
  }
  log.info("runtime.run.deduplicated", { runId: existing.id, accountId: existing.accountId, handler: `${handler.key}@${handler.version}`, resourcePool: handler.resourcePool });
  return { run: existing, disposition: "existing" };
}

async function currentCapacityPolicy(tx: DrizzleTx): Promise<{ version: number; policy: RuntimeCapacityPolicy }> {
  const [row] = await tx.select().from(runtimeCapacityPolicies).orderBy(desc(runtimeCapacityPolicies.version)).limit(1);
  if (!row) throw new Error("Runtime capacity policy is missing");
  const policy = row.policy as RuntimeCapacityPolicy;
  if ((policy.version !== 1 && policy.version !== 2) || policy.version !== row.version || !policy.pools) {
    throw new Error("Runtime capacity policy is invalid");
  }
  return { version: row.version, policy };
}

function requirePoolCapacity(
  policy: RuntimeCapacityPolicy,
  resourcePool: RuntimeResourcePool,
): RuntimePoolCapacityV1 {
  if (policy.version === 1) {
    if (resourcePool === "realtime_agent") {
      throw new Error("Runtime capacity policy v1 does not define pool realtime_agent");
    }
    return policy.pools[resourcePool];
  }
  return policy.pools[resourcePool];
}

function accountOverrideLimit(
  policy: RuntimeCapacityPolicy,
  accountId: string,
  resourcePool: RuntimeResourcePool,
): number | undefined {
  if (policy.version === 1) {
    if (resourcePool === "realtime_agent") return undefined;
    return policy.accountOverrides[accountId]?.[resourcePool]?.limit;
  }
  return policy.accountOverrides[accountId]?.[resourcePool]?.limit;
}

const GLOBAL_CAPACITY_LOCK_KEY = "__runtime_global_capacity__";

async function acquireCapacityLocks(tx: DrizzleTx, resourcePool: RuntimeResourcePool): Promise<void> {
  // Pool-local locks cannot protect a deployment-wide ceiling when two pools
  // claim concurrently. All admissions take the global lock first, then the
  // selected pool lock, in one deterministic order.
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.RUNTIME_POOL, GLOBAL_CAPACITY_LOCK_KEY);
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.RUNTIME_POOL, resourcePool);
}

export interface RuntimeCapacitySnapshot {
  policyVersion: number;
  globalLimit: number;
  globalActive: number;
  poolLimit: number;
  poolActive: number;
  accountLimit: number;
  accountActive: number;
  poolAccountLimit: number;
  poolAccountActive: number;
  interactiveReserve: number;
  interactiveActive: number;
  protectedInteractiveReserve: number;
}

export type RuntimeCapacitySaturationReason =
  | "global_saturated"
  | "pool_saturated"
  | "account_saturated"
  | "interactive_reserve_protected";

async function readWaitingReservedCapacity(tx: DrizzleTx): Promise<number> {
  const result = await tx.execute(sql`
    WITH pending_accounts AS (
      SELECT DISTINCT account_id
      FROM runtime_runs
      WHERE phase = 'pending'
        AND available_at <= CURRENT_TIMESTAMP
        AND deadline_at > CURRENT_TIMESTAMP
        AND cancellation_requested_at IS NULL
    ), active_accounts AS (
      SELECT account_id, COUNT(*)::int AS active_count
      FROM runtime_attempts
      WHERE phase IN ('leased','running')
        AND lease_expires_at > CURRENT_TIMESTAMP
      GROUP BY account_id
    )
    SELECT COALESCE(SUM(GREATEST(
      0,
      ${DEFAULT_PROTECTED_ACCOUNT_SHARE} - COALESCE(active.active_count, 0)
    )), 0)::int AS reserved_capacity
    FROM pending_accounts AS pending
    LEFT JOIN active_accounts AS active ON active.account_id = pending.account_id
  `);
  const row = (result.rows as Array<{ reserved_capacity: number | string }>)[0];
  return Number(row?.reserved_capacity ?? 0);
}

function accountCapacityLimits(
  policy: RuntimeCapacityPolicy,
  resourcePool: RuntimeResourcePool,
  accountId: string,
  accountActive: number,
  waitingReservedCapacity: number,
): { accountLimit: number; poolAccountLimit: number } {
  const poolPolicy = requirePoolCapacity(policy, resourcePool);
  const accountOverride = accountOverrideLimit(policy, accountId, resourcePool);
  const configuredAccountLimit = accountOverride ?? poolPolicy.accountLimit;
  if (policy.version === 1) {
    return { accountLimit: configuredAccountLimit, poolAccountLimit: configuredAccountLimit };
  }

  const accountReservedCapacity = Math.max(0, DEFAULT_PROTECTED_ACCOUNT_SHARE - accountActive);
  const peerReserve = Math.max(0, waitingReservedCapacity - accountReservedCapacity);
  const accountCeiling = accountOverride ?? policy.accountHeadLimit;
  return {
    accountLimit: Math.min(
      Math.max(DEFAULT_PROTECTED_ACCOUNT_SHARE, policy.globalLimit - peerReserve),
      accountCeiling,
    ),
    poolAccountLimit: accountCeiling,
  };
}

async function readCapacitySnapshot(
  tx: DrizzleTx,
  policyVersion: number,
  policy: RuntimeCapacityPolicy,
  resourcePool: RuntimeResourcePool,
  accountId: string,
  protectWaitingPeers = true,
  knownWaitingReservedCapacity?: number,
): Promise<RuntimeCapacitySnapshot> {
  const result = await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE phase IN ('leased','running') AND lease_expires_at > CURRENT_TIMESTAMP)::int AS global_active,
      COUNT(*) FILTER (WHERE resource_pool = ${resourcePool} AND phase IN ('leased','running') AND lease_expires_at > CURRENT_TIMESTAMP)::int AS pool_active,
      COUNT(*) FILTER (WHERE account_id = ${accountId} AND phase IN ('leased','running') AND lease_expires_at > CURRENT_TIMESTAMP)::int AS global_account_active,
      COUNT(*) FILTER (WHERE account_id = ${accountId} AND resource_pool = ${resourcePool} AND phase IN ('leased','running') AND lease_expires_at > CURRENT_TIMESTAMP)::int AS pool_account_active,
      COUNT(*) FILTER (WHERE resource_pool IN ('realtime_agent', 'interactive_agent') AND phase IN ('leased','running') AND lease_expires_at > CURRENT_TIMESTAMP)::int AS interactive_active
    FROM runtime_attempts
  `);
  const row = (result.rows as Array<{
    global_active: number | string;
    pool_active: number | string;
    global_account_active: number | string;
    pool_account_active: number | string;
    interactive_active: number | string;
  }>)[0];
  const poolPolicy = requirePoolCapacity(policy, resourcePool);
  const interactiveReserve = requirePoolCapacity(policy, "background_agent").interactiveReserve;
  const interactiveActive = Number(row?.interactive_active ?? 0);
  const waitingReservedCapacity = policy.version === 2 && protectWaitingPeers
    ? knownWaitingReservedCapacity ?? await readWaitingReservedCapacity(tx)
    : 0;
  const { accountLimit, poolAccountLimit } = accountCapacityLimits(
    policy,
    resourcePool,
    accountId,
    Number(row?.global_account_active ?? 0),
    waitingReservedCapacity,
  );
  return {
    policyVersion,
    globalLimit: policy.globalLimit,
    globalActive: Number(row?.global_active ?? 0),
    poolLimit: poolPolicy.limit,
    poolActive: Number(row?.pool_active ?? 0),
    accountLimit,
    accountActive: Number(row?.global_account_active ?? 0),
    poolAccountLimit,
    poolAccountActive: Number(row?.pool_account_active ?? 0),
    interactiveReserve,
    interactiveActive,
    protectedInteractiveReserve: Math.max(0, interactiveReserve - interactiveActive),
  };
}

function saturationReason(
  resourcePool: RuntimeResourcePool,
  snapshot: RuntimeCapacitySnapshot,
): RuntimeCapacitySaturationReason | null {
  if (snapshot.poolActive >= snapshot.poolLimit) return "pool_saturated";
  if (snapshot.accountActive >= snapshot.accountLimit || snapshot.poolAccountActive >= snapshot.poolAccountLimit) {
    return "account_saturated";
  }
  if (snapshot.globalActive >= snapshot.globalLimit) return "global_saturated";
  if (
    resourcePool !== "realtime_agent" && resourcePool !== "interactive_agent" &&
    snapshot.globalActive >= snapshot.globalLimit - snapshot.protectedInteractiveReserve
  ) {
    return "interactive_reserve_protected";
  }
  return null;
}

export interface LegacyRuntimeCapacityLease {
  run: RuntimeRunRow;
  attempt: RuntimeAttemptRow;
  fence: RuntimeFence;
  snapshot: RuntimeCapacitySnapshot;
}

interface LegacyRuntimeCapacityRequestInput {
  externalRunId: string;
  admissionRequestId: string;
  resourcePool: RuntimeResourcePool;
  sourceType: string;
  activity?: string;
  deadlineAt: Date;
  workerId: string;
}

function validateLegacyRuntimeCapacityInput(input: LegacyRuntimeCapacityRequestInput): {
  externalRunId: string;
  admissionRequestId: string;
  sourceType: string;
  workerId: string;
} {
  const externalRunId = boundedText(input.externalRunId, "externalRunId", 200);
  const admissionRequestId = boundedText(input.admissionRequestId, "admissionRequestId", 200);
  const sourceType = boundedText(input.sourceType, "sourceType", 120);
  const workerId = boundedText(input.workerId, "workerId", 200);
  if (!(input.deadlineAt instanceof Date) || !Number.isFinite(input.deadlineAt.getTime()) || input.deadlineAt <= new Date()) {
    throw Object.assign(new Error("deadlineAt must be a future date"), { status: 400 });
  }
  return { externalRunId, admissionRequestId, sourceType, workerId };
}

async function ensureLegacyRuntimeCapacityRun(
  tx: DrizzleTx,
  principal: Principal & { actorType: "user"; userId: string; accountId: string },
  input: LegacyRuntimeCapacityRequestInput,
): Promise<RuntimeRunRow> {
  const { externalRunId, admissionRequestId, sourceType } = validateLegacyRuntimeCapacityInput(input);
  const now = new Date();
  const idempotencyKey = `legacy-capacity/${admissionRequestId}`;
  const budget: RuntimeBudgetV1 = {
    ...DEFAULT_RUNTIME_BUDGET_V1,
    maxWallClockMs: Math.max(1, input.deadlineAt.getTime() - now.getTime()),
    maxAttempts: 1,
  };
  const retryPolicy: RuntimeRetryPolicyV1 = {
    ...DEFAULT_RUNTIME_RETRY_POLICY_V1,
    maxAttempts: 1,
    retryableFailureClasses: [],
  };
  const requestShape = {
    compatibility: true,
    externalRunId,
    admissionRequestId,
    sourceType,
    activity: input.activity?.slice(0, 120) ?? null,
    resourcePool: input.resourcePool,
    idempotencyKey,
  };
  const ownership = ownedInsertValues(principal, runScope);
  const inserted = await tx.insert(runtimeRuns).values({
    kind: LEGACY_CAPACITY_HANDLER_KEY,
    handlerKey: LEGACY_CAPACITY_HANDLER_KEY,
    handlerVersion: 1,
    sourceType,
    sourceId: externalRunId,
    idempotencyKey,
    requestHash: hashValue(requestShape),
    runAsActorType: "user",
    runAsSubjectId: principal.userId,
    resourcePool: input.resourcePool,
    executorProfile: input.resourcePool === "isolated_execution" ? "isolated_browser" : "in_process_trusted",
    priority: 0,
    availableAt: now,
    deadlineAt: input.deadlineAt,
    inputSchemaVersion: 1,
    input: requestShape,
    inputRefs: [],
    authorityPolicyVersionAtEnqueue: "legacy-facade-v1",
    budget,
    retryPolicy,
    ...ownership,
    createdByUserId: principal.userId,
  }).onConflictDoNothing({ target: [runtimeRuns.accountId, runtimeRuns.kind, runtimeRuns.idempotencyKey] }).returning();
  const [run] = inserted.length > 0
    ? inserted
    : await tx.select().from(runtimeRuns).where(and(
        eq(runtimeRuns.accountId, principal.accountId),
        eq(runtimeRuns.kind, LEGACY_CAPACITY_HANDLER_KEY),
        eq(runtimeRuns.idempotencyKey, idempotencyKey),
      )).limit(1).for("update");
  if (!run) throw new Error("Legacy runtime capacity run creation failed");
  if (run.phase !== "pending" || run.currentAttemptId) {
    throw Object.assign(new Error("Legacy runtime capacity request is no longer pending"), { code: "legacy_capacity_not_pending" });
  }
  return run;
}

export async function acquireLegacyRuntimeCapacity(
  principal: Principal,
  input: LegacyRuntimeCapacityRequestInput,
): Promise<
  | { disposition: "acquired"; lease: LegacyRuntimeCapacityLease }
  | { disposition: "saturated"; reason: RuntimeCapacitySaturationReason; snapshot: RuntimeCapacitySnapshot }
> {
  requireUserPrincipal(principal);
  const { sourceType, workerId } = validateLegacyRuntimeCapacityInput(input);

  return runWithPrincipal(principal, () => db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const run = await ensureLegacyRuntimeCapacityRun(tx, principal, input);
    await acquireCapacityLocks(tx, input.resourcePool);
    const now = new Date();
    const { version: policyVersion, policy } = await currentCapacityPolicy(tx);
    const poolPolicy = requirePoolCapacity(policy, input.resourcePool);
    const snapshot = await readCapacitySnapshot(
      tx,
      policyVersion,
      policy,
      input.resourcePool,
      principal.accountId,
    );
    const reason = saturationReason(input.resourcePool, snapshot);
    if (reason) {
      log.debug("runtime.capacity.saturated", {
        accountId: principal.accountId,
        resourcePool: input.resourcePool,
        reasonCode: reason,
        ...snapshot,
      });
      return { disposition: "saturated" as const, reason, snapshot };
    }

    const leaseToken = crypto.randomBytes(32).toString("base64url");

    const leaseExpiresAt = new Date(now.getTime() + poolPolicy.leaseSeconds * 1000);
    const [attempt] = await tx.insert(runtimeAttempts).values({
      runId: run.id,
      accountId: run.accountId,
      attemptNumber: 1,
      resourcePool: input.resourcePool,
      leaseEpoch: 1,
      leaseTokenHash: fenceTokenHash(leaseToken),
      leaseExpiresAt,
      workerId,
      executorProfile: run.executorProfile,
      capacityPolicyVersion: policyVersion,
      phase: "running",
      startedAt: now,
      lastHeartbeatAt: now,
      scope: "user",
      ownerUserId: principal.userId,
      createdByUserId: principal.userId,
    }).returning();
    if (!attempt) throw new Error("Legacy runtime capacity attempt creation failed");
    const [runningRun] = await tx.update(runtimeRuns).set({
      phase: "running",
      currentAttemptId: attempt.id,
      updatedAt: now,
    }).where(and(
      eq(runtimeRuns.id, run.id),
      eq(runtimeRuns.phase, "pending"),
      isNull(runtimeRuns.currentAttemptId),
      isNull(runtimeRuns.cancellationRequestedAt),
    )).returning();
    if (!runningRun) throw Object.assign(new Error("Legacy runtime capacity request is no longer pending"), { code: "legacy_capacity_not_pending" });

    const fence = {
      accountId: principal.accountId,
      runId: runningRun.id,
      attemptId: attempt.id,
      leaseEpoch: 1,
      leaseToken,
    };
    log.info("runtime.legacy_facade.acquired", {
      runId: runningRun.id,
      attemptId: attempt.id,
      accountId: principal.accountId,
      resourcePool: input.resourcePool,
      sourceType,
      policyVersion,
      globalActive: snapshot.globalActive + 1,
      poolActive: snapshot.poolActive + 1,
      accountActive: snapshot.accountActive + 1,
    });
    return {
      disposition: "acquired" as const,
      lease: { run: runningRun, attempt, fence, snapshot },
    };
  })));
}

interface AccountHeadRow {
  id: string;
  account_id: string;
  owner_user_id: string;
  handler_key: string;
  handler_version: number;
  executor_profile: string;
  active_count: number | string;
  pool_active_count: number | string;
  last_claim_at: Date | string | null;
}

export async function claimNextRuntimeRun(
  resourcePool: RuntimeResourcePool,
  workerIdInput: string,
): Promise<{ run: RuntimeRunRow; attempt: RuntimeAttemptRow; fence: RuntimeFence } | null> {
  const workerId = boundedText(workerIdInput, "workerId", 200);
  return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireCapacityLocks(tx, resourcePool);
    const { version: policyVersion, policy } = await currentCapacityPolicy(tx);
    const poolPolicy = requirePoolCapacity(policy, resourcePool);
    if (poolPolicy.limit < 1) return null;

    await tx.execute(sql`
      WITH expired AS (
        UPDATE runtime_attempts
        SET phase = 'finished', result = 'lost', failure_class = 'lease_lost',
            reason_code = 'lease_expired', attribution = 'runtime', finished_at = CURRENT_TIMESTAMP
        WHERE resource_pool = ${resourcePool}
          AND phase IN ('leased', 'running')
          AND lease_expires_at <= CURRENT_TIMESTAMP
          AND run_id IN (
            SELECT id FROM runtime_runs WHERE handler_key <> ${LEGACY_CAPACITY_HANDLER_KEY}
          )
        RETURNING id, run_id
      )
      UPDATE runtime_runs AS run
      SET phase = 'pending', current_attempt_id = NULL, available_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      FROM expired
      WHERE run.id = expired.run_id
        AND run.current_attempt_id = expired.id
        AND run.phase IN ('leased', 'running')
        AND run.deadline_at > CURRENT_TIMESTAMP
    `);

    // Candidate selection below determines the account, but global and pool
    // saturation can be decided now. Non-interactive pools may not consume the
    // still-unused interactive reserve.
    const globalSnapshot = await readCapacitySnapshot(tx, policyVersion, policy, resourcePool, "__candidate__", false);
    const globalReason = saturationReason(resourcePool, {
      ...globalSnapshot,
      accountActive: 0,
      accountLimit: Number.MAX_SAFE_INTEGER,
    });
    if (globalReason && globalReason !== "account_saturated") {
      log.debug("runtime.dispatch.budget_blocked", {
        resourcePool,
        policyVersion,
        reasonCode: globalReason,
        ...globalSnapshot,
      });
      return null;
    }

    const headLimit = Math.max(1, Math.min(policy.accountHeadLimit || DEFAULT_ACCOUNT_HEAD_LIMIT, 50));
    const candidatesResult = await tx.execute(sql`
      WITH account_heads AS (
        SELECT DISTINCT ON (run.account_id)
          run.id, run.account_id, run.owner_user_id, run.handler_key, run.handler_version,
          run.executor_profile, run.deadline_at, run.priority, run.available_at, run.created_at
        FROM runtime_runs AS run
        WHERE run.resource_pool = ${resourcePool}
          AND run.handler_key <> ${LEGACY_CAPACITY_HANDLER_KEY}
          AND run.phase = 'pending'
          AND run.available_at <= CURRENT_TIMESTAMP
          AND run.deadline_at > CURRENT_TIMESTAMP
          AND run.cancellation_requested_at IS NULL
        ORDER BY run.account_id, run.deadline_at ASC, run.priority DESC, run.available_at ASC, run.id ASC
      ), active_accounts AS (
        SELECT account_id, COUNT(*)::int AS active_count
        FROM runtime_attempts
        WHERE phase IN ('leased','running')
          AND lease_expires_at > CURRENT_TIMESTAMP
        GROUP BY account_id
      ), active_pool_accounts AS (
        SELECT account_id, COUNT(*)::int AS pool_active_count
        FROM runtime_attempts
        WHERE resource_pool = ${resourcePool}
          AND phase IN ('leased','running')
          AND lease_expires_at > CURRENT_TIMESTAMP
        GROUP BY account_id
      ), last_claim AS (
        SELECT account_id, MAX(leased_at) AS last_claim_at
        FROM runtime_attempts
        WHERE resource_pool = ${resourcePool}
        GROUP BY account_id
      )
      SELECT head.*,
             COALESCE(active.active_count, 0)::int AS active_count,
             COALESCE(active_pool.pool_active_count, 0)::int AS pool_active_count,
             last_claim.last_claim_at
      FROM account_heads AS head
      LEFT JOIN active_accounts AS active ON active.account_id = head.account_id
      LEFT JOIN active_pool_accounts AS active_pool ON active_pool.account_id = head.account_id
      LEFT JOIN last_claim ON last_claim.account_id = head.account_id
      ORDER BY COALESCE(active.active_count, 0) ASC, last_claim.last_claim_at ASC NULLS FIRST, head.deadline_at ASC, head.priority DESC, head.available_at ASC, head.id ASC
      LIMIT ${headLimit}
    `);
    const candidates = candidatesResult.rows as AccountHeadRow[];
    const waitingReservedCapacity = policy.version === 2
      ? await readWaitingReservedCapacity(tx)
      : 0;
    const selected = candidates.find((candidate) => {
      const limits = accountCapacityLimits(
        policy,
        resourcePool,
        candidate.account_id,
        Number(candidate.active_count),
        waitingReservedCapacity,
      );
      return Number(candidate.active_count) < limits.accountLimit
        && Number(candidate.pool_active_count) < limits.poolAccountLimit;
    });
    if (!selected) {
      if (candidates.length > 0) {
        log.debug("runtime.dispatch.budget_blocked", {
          resourcePool,
          policyVersion,
          reasonCode: "account_saturated",
          eligibleAccountCount: candidates.length,
        });
      }
      return null;
    }

    const [run] = await tx.select().from(runtimeRuns).where(and(
      eq(runtimeRuns.id, selected.id),
      eq(runtimeRuns.phase, "pending"),
      sql`${runtimeRuns.handlerKey} <> ${LEGACY_CAPACITY_HANDLER_KEY}`,
    )).limit(1);
    if (!run) return null;
    const handler = runtimeHandlerRegistry.get(run.handlerKey, run.handlerVersion);
    if (!handler || handler.executorProfile !== run.executorProfile || handler.resourcePool !== run.resourcePool) {
      const recoveryPrincipal = createNamedSystemPrincipal("runtime-authority-recovery");
      const terminal = await terminalizeInTransaction(tx, recoveryPrincipal, run, null, {
        outcome: "blocked",
        reasonCode: "handler_version_unavailable",
        attribution: "runtime",
        outputRefs: [],
        verificationLevel: "observed",
      });
      log.warn("runtime.dispatch.handler_unavailable", {
        runId: terminal.run.id,
        accountId: terminal.run.accountId,
        handler: `${run.handlerKey}@${run.handlerVersion}`,
        resourcePool,
      });
      return null;
    }

    const [attemptCounter] = await tx.select({ total: count(runtimeAttempts.id) }).from(runtimeAttempts).where(eq(runtimeAttempts.runId, run.id));
    const attemptNumber = Number(attemptCounter?.total ?? 0) + 1;

    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const leaseEpoch = attemptNumber;
    const leaseExpiresAt = new Date(Date.now() + poolPolicy.leaseSeconds * 1000);
    const attemptOwnership = { scope: "user", ownerUserId: run.ownerUserId, createdByUserId: run.createdByUserId } as const;
    const [attempt] = await tx.insert(runtimeAttempts).values({
      runId: run.id,
      accountId: run.accountId,
      attemptNumber,
      resourcePool,
      leaseEpoch,
      leaseTokenHash: fenceTokenHash(leaseToken),
      leaseExpiresAt,
      workerId,
      executorProfile: run.executorProfile,
      capacityPolicyVersion: policyVersion,
      ...attemptOwnership,
    }).returning();
    if (!attempt) throw new Error("Runtime attempt lease creation failed");
    const [leasedRun] = await tx.update(runtimeRuns).set({ phase: "leased", currentAttemptId: attempt.id, updatedAt: new Date() })
      .where(and(eq(runtimeRuns.id, run.id), eq(runtimeRuns.phase, "pending"), isNull(runtimeRuns.currentAttemptId))).returning();
    if (!leasedRun) throw new Error("Runtime run claim changed concurrently under pool lock");
    log.info("runtime.attempt.leased", { runId: run.id, attemptId: attempt.id, accountId: run.accountId, handler: `${run.handlerKey}@${run.handlerVersion}`, resourcePool, policyVersion });
    return {
      run: leasedRun,
      attempt,
      fence: { accountId: run.accountId, runId: run.id, attemptId: attempt.id, leaseEpoch, leaseToken },
    };
  }));
}

async function loadFencedAttempt(tx: DrizzleTx, fence: RuntimeFence, phases: Array<"leased" | "running">): Promise<{ run: RuntimeRunRow; attempt: RuntimeAttemptRow }> {
  const [attempt] = await tx.select().from(runtimeAttempts).where(and(
    eq(runtimeAttempts.id, fence.attemptId),
    eq(runtimeAttempts.runId, fence.runId),
    eq(runtimeAttempts.accountId, fence.accountId),
    eq(runtimeAttempts.leaseEpoch, fence.leaseEpoch),
    eq(runtimeAttempts.leaseTokenHash, fenceTokenHash(fence.leaseToken)),
    inArray(runtimeAttempts.phase, phases),
    gt(runtimeAttempts.leaseExpiresAt, new Date()),
  )).limit(1);
  if (!attempt) throw Object.assign(new Error("Runtime lease fence is stale or expired"), { status: 409, code: "stale_fence" });
  const [run] = await tx.select().from(runtimeRuns).where(and(
    eq(runtimeRuns.id, fence.runId),
    eq(runtimeRuns.accountId, fence.accountId),
    eq(runtimeRuns.currentAttemptId, fence.attemptId),
    inArray(runtimeRuns.phase, phases),
  )).limit(1);
  if (!run) throw Object.assign(new Error("Runtime run fence is stale"), { status: 409, code: "stale_fence" });
  return { run, attempt };
}

async function appendEventInTransaction(
  tx: DrizzleTx,
  run: RuntimeRunRow,
  input: {
    attemptId?: string | null;
    eventType: "authorization" | "mutation" | "verification" | "failure" | "correction";
    reasonCode?: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const payload = boundedJson(input.payload, MAX_EVIDENCE_BYTES, "evidence payload");
  const [event] = await tx.insert(runtimeRunEvents).values({
    runId: run.id,
    attemptId: input.attemptId ?? null,
    accountId: run.accountId,
    eventType: input.eventType,
    reasonCode: input.reasonCode ? boundedReasonCode(input.reasonCode) : null,
    payload,
    payloadHash: hashValue(payload),
    scope: "user",
    ownerUserId: run.ownerUserId,
    createdByUserId: run.createdByUserId,
  }).returning({ id: runtimeRunEvents.id });
  if (!event) throw new Error("Runtime evidence append failed");
  return event.id;
}

export interface StartedRuntimeAttempt {
  run: RuntimeRunRow;
  attempt: RuntimeAttemptRow;
  principal: Principal & { actorType: "user"; userId: string; accountId: string };
  handler: RuntimeHandler<unknown>;
  input: unknown;
  fence: RuntimeFence;
}

export async function startRuntimeAttempt(
  fence: RuntimeFence,
  executorProfile: RuntimeExecutorProfile,
): Promise<StartedRuntimeAttempt> {
  const snapshot = await db.transaction(async (tx) => loadFencedAttempt(tx, fence, ["leased"]));
  const handler = runtimeHandlerRegistry.require(snapshot.run.handlerKey, snapshot.run.handlerVersion);
  if (handler.executorProfile !== executorProfile || snapshot.run.executorProfile !== executorProfile) {
    throw Object.assign(new Error("Executor profile does not satisfy the handler contract"), { status: 409, code: "executor_profile_mismatch" });
  }
  let principal: Principal & { actorType: "user"; userId: string; accountId: string };
  let authorization: Awaited<ReturnType<RuntimeHandler<unknown>["authorize"]>>;
  let parsedInput: unknown;
  try {
    principal = await restoreRunPrincipal(snapshot.run);
    parsedInput = handler.inputSchema.parse(snapshot.run.input);
    authorization = await runWithPrincipal(principal, () => handler.authorize(principal, parsedInput));
  } catch (error) {
    // Prefer structured AccountLifecycleError codes (account_archived /
    // account_suspended) over the generic fallback so thrashing runs leave a
    // truthful blocked reason instead of authority_subject_missing.
    const reasonCode = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "authority_subject_missing";
    const recoveryPrincipal = createNamedSystemPrincipal("runtime-authority-recovery");
    await terminalizeWithoutDecision(recoveryPrincipal, snapshot.run.id, snapshot.attempt.id, {
      outcome: "blocked",
      reasonCode: boundedReasonCode(reasonCode),
      attribution: "authority",
      outputRefs: [],
      verificationLevel: "observed",
    });
    throw error;
  }
  if (!authorization.allowed) {
    const reasonCode = boundedReasonCode(authorization.reasonCode || "authority_revoked");
    await terminalizeWithoutDecision(principal, snapshot.run.id, snapshot.attempt.id, {
      outcome: "blocked",
      reasonCode,
      attribution: "authority",
      outputRefs: [],
      verificationLevel: "observed",
    });
    throw Object.assign(new Error("Runtime attempt authorization denied"), { status: 403, code: reasonCode });
  }

  const started = await db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const current = await loadFencedAttempt(tx, fence, ["leased"]);
    await appendEventInTransaction(tx, current.run, {
      attemptId: current.attempt.id,
      eventType: "authorization",
      reasonCode: boundedReasonCode(authorization.reasonCode || "authorized"),
      payload: { allowed: true, decisionRef: authorization.decisionRef ?? null, handler: `${handler.key}@${handler.version}` },
    });
    const now = new Date();
    const [attempt] = await tx.update(runtimeAttempts).set({ phase: "running", startedAt: now, lastHeartbeatAt: now })
      .where(and(eq(runtimeAttempts.id, current.attempt.id), eq(runtimeAttempts.phase, "leased"))).returning();
    const [run] = await tx.update(runtimeRuns).set({ phase: "running", updatedAt: now })
      .where(and(eq(runtimeRuns.id, current.run.id), eq(runtimeRuns.phase, "leased"), eq(runtimeRuns.currentAttemptId, current.attempt.id))).returning();
    if (!attempt || !run) throw Object.assign(new Error("Runtime start fence changed concurrently"), { status: 409, code: "stale_fence" });
    return { run, attempt };
  }));
  log.info("runtime.attempt.started", { runId: started.run.id, attemptId: started.attempt.id, accountId: started.run.accountId, handler: `${handler.key}@${handler.version}`, resourcePool: started.run.resourcePool });
  return { ...started, principal, handler, input: parsedInput, fence };
}

export async function heartbeatRuntimeAttempt(
  fence: RuntimeFence,
  usageDelta: Record<string, number> = {},
): Promise<{ leaseExpiresAt: Date; cancellationRequested: boolean }> {
  boundedJson(usageDelta, 4_096, "usageDelta");
  for (const [key, value] of Object.entries(usageDelta)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !Number.isFinite(value) || value < 0) throw Object.assign(new Error("usageDelta must contain non-negative bounded counters"), { status: 400 });
  }
  return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const current = await loadFencedAttempt(tx, fence, ["running"]);
    const { policy } = await currentCapacityPolicy(tx);
    const leaseSeconds = requirePoolCapacity(policy, current.attempt.resourcePool).leaseSeconds;
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
    const usage = { ...(current.attempt.usageSummary ?? {}) } as Record<string, number>;
    for (const [key, value] of Object.entries(usageDelta)) usage[key] = (usage[key] ?? 0) + value;
    const [updated] = await tx.update(runtimeAttempts).set({
      leaseExpiresAt,
      lastHeartbeatAt: new Date(),
      usageSummary: usage,
    }).where(and(eq(runtimeAttempts.id, current.attempt.id), eq(runtimeAttempts.phase, "running"))).returning();
    if (!updated) throw Object.assign(new Error("Runtime heartbeat fence changed concurrently"), { status: 409, code: "stale_fence" });
    log.debug("runtime.attempt.heartbeat", { runId: current.run.id, attemptId: current.attempt.id, accountId: current.run.accountId, resourcePool: current.run.resourcePool });
    return { leaseExpiresAt, cancellationRequested: current.run.cancellationRequestedAt !== null };
  }));
}

export async function appendRuntimeEvidence(
  fence: RuntimeFence,
  input: {
    eventType: "mutation" | "verification" | "failure" | "correction";
    reasonCode?: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const current = await loadFencedAttempt(tx, fence, ["running"]);
    return appendEventInTransaction(tx, current.run, { ...input, attemptId: current.attempt.id });
  }));
}

export async function cancelLegacyRuntimeCapacityRequest(
  principal: Principal,
  admissionRequestId: string,
  reasonCode: string,
): Promise<void> {
  requireUserPrincipal(principal);
  const boundedRequestId = boundedText(admissionRequestId, "admissionRequestId", 200);
  const idempotencyKey = `legacy-capacity/${boundedRequestId}`;
  await runWithPrincipal(principal, () => db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const [run] = await tx.select().from(runtimeRuns).where(runWritable(principal, and(
      eq(runtimeRuns.kind, LEGACY_CAPACITY_HANDLER_KEY),
      eq(runtimeRuns.idempotencyKey, idempotencyKey),
    ))).limit(1).for("update");
    if (!run || run.phase !== "pending") return;
    const boundedReason = boundedText(reasonCode, "reasonCode", 160);
    await tx.delete(runtimeRuns).where(and(eq(runtimeRuns.id, run.id), eq(runtimeRuns.phase, "pending")));
    log.debug("runtime.legacy_capacity.request_cancelled", {
      externalRunId: run.sourceId,
      admissionRequestId: boundedRequestId,
      resourcePool: run.resourcePool,
      reasonCode: boundedReason,
    });
  })));
}

export async function releaseLegacyRuntimeCapacity(
  principal: Principal,
  fence: RuntimeFence,
  input: {
    outcome?: "succeeded" | "failed" | "cancelled";
    reasonCode?: string;
    attribution?: RuntimeAttribution;
  } = {},
): Promise<void> {
  requireUserPrincipal(principal);
  if (principal.accountId !== fence.accountId) {
    throw Object.assign(new Error("Runtime fence account mismatch"), { status: 403 });
  }
  const outcome = input.outcome ?? "succeeded";
  const reasonCode = input.reasonCode ?? "legacy_capacity_released";
  // Release is idempotent for a façade handle. This matters when a nested
  // failure settles the lease before its outer finally block runs.
  const existing = await getRuntimeRun(principal, fence.runId);
  if (existing?.phase === "terminal") return;
  const result = await resolveRuntimeAttempt(principal, fence, {
    kind: "complete",
    outcome,
    reasonCode,
    attribution: input.attribution ?? (outcome === "succeeded" ? "system" : "runtime"),
    outputRefs: [],
    verificationLevel: "observed",
  });
  log.info("runtime.legacy_facade.released", {
    runId: fence.runId,
    attemptId: fence.attemptId,
    accountId: fence.accountId,
    outcome,
    reasonCode,
    phase: result.phase,
  });
}

async function buildReceipt(
  tx: DrizzleTx,
  run: RuntimeRunRow,
  attempt: RuntimeAttemptRow | null,
  decision: {
    outcome: RuntimeRunOutcome;
    reasonCode: string;
    attribution: RuntimeAttribution;
    outputRefs: string[];
    verificationLevel: RuntimeReceiptV1["verificationLevel"];
  },
): Promise<RuntimeReceiptV1> {
  const [attemptCount] = await tx.select({ total: count(runtimeAttempts.id) }).from(runtimeAttempts).where(eq(runtimeAttempts.runId, run.id));
  const evidence = await tx.select({ id: runtimeRunEvents.id }).from(runtimeRunEvents)
    .where(and(eq(runtimeRunEvents.runId, run.id), sql`${runtimeRunEvents.eventType} <> 'terminal_receipt'`))
    .orderBy(asc(runtimeRunEvents.occurredAt), asc(runtimeRunEvents.id))
    .limit(MAX_EVIDENCE_EVENTS_PER_RECEIPT);
  const terminalAt = new Date();
  const executionStartedAt = attempt?.startedAt ?? attempt?.leasedAt ?? null;
  const executionLatencyMs = executionStartedAt ? Math.max(0, terminalAt.getTime() - executionStartedAt.getTime()) : null;
  const receiptWithoutHash = {
    version: 1 as const,
    runId: run.id,
    accountId: run.accountId,
    kind: run.kind,
    handler: { key: run.handlerKey, version: run.handlerVersion },
    source: { type: run.sourceType, id: run.sourceId },
    idempotencyKey: run.idempotencyKey,
    causalParentRunId: run.causalParentRunId,
    resourcePool: run.resourcePool,
    executorProfile: run.executorProfile,
    runAs: { actorType: run.runAsActorType as "user" | "service", subjectId: run.runAsSubjectId },
    authorityPolicyVersionAtEnqueue: run.authorityPolicyVersionAtEnqueue,
    capacityPolicyVersion: attempt?.capacityPolicyVersion ?? null,
    inputRefHashes: (run.inputRefs as string[]).map((ref) => hashValue(ref)),
    attemptCount: Number(attemptCount?.total ?? 0),
    queueLatencyMs: Math.max(0, (attempt?.leasedAt ?? terminalAt).getTime() - run.createdAt.getTime()),
    executionLatencyMs,
    budget: run.budget as RuntimeBudgetV1,
    measuredUsage: (attempt?.usageSummary ?? {}) as Record<string, number>,
    evidenceEventIds: evidence.map((row) => row.id),
    outputRefs: normalizeReferences(decision.outputRefs, "outputRefs", MAX_OUTPUT_REFERENCES),
    verificationLevel: decision.verificationLevel,
    outcome: decision.outcome,
    reasonCode: boundedReasonCode(decision.reasonCode),
    attribution: decision.attribution,
    terminalAt: terminalAt.toISOString(),
  };
  return { ...receiptWithoutHash, receiptHash: hashValue(receiptWithoutHash) };
}

async function terminalizeInTransaction(
  tx: DrizzleTx,
  principal: Principal,
  run: RuntimeRunRow,
  attempt: RuntimeAttemptRow | null,
  decision: {
    outcome: RuntimeRunOutcome;
    reasonCode: string;
    attribution: RuntimeAttribution;
    outputRefs: string[];
    verificationLevel: RuntimeReceiptV1["verificationLevel"];
  },
): Promise<{ run: RuntimeRunRow; receipt: RuntimeReceiptV1 }> {
  if (run.phase === "terminal") {
    const existing = await getRuntimeReceipt(principal, run.id);
    if (!existing) throw new Error("Terminal runtime run is missing its receipt");
    return { run, receipt: existing };
  }
  const receipt = await buildReceipt(tx, run, attempt, decision);
  // Legacy capacity leases are pure admission handles — no registered RuntimeHandler,
  // no input projection, no side effects beyond the terminal receipt itself. Requiring
  // a handler here turns every release/expire/reclaim into release_failed and leaks slots.
  if (run.handlerKey !== LEGACY_CAPACITY_HANDLER_KEY) {
    const handler = runtimeHandlerRegistry.require(run.handlerKey, run.handlerVersion);
    const parsedInput = handler.inputSchema.parse(run.input);
    if (handler.projectTerminal) {
      await handler.projectTerminal({
        tx,
        principal,
        run,
        input: parsedInput,
        receipt,
      });
    }
  }
  const receiptEventId = crypto.randomUUID();
  await tx.insert(runtimeRunEvents).values({
    id: receiptEventId,
    runId: run.id,
    attemptId: attempt?.id ?? null,
    accountId: run.accountId,
    eventType: "terminal_receipt",
    reasonCode: receipt.reasonCode,
    payload: boundedJson(receipt as unknown as Record<string, unknown>, MAX_RECEIPT_BYTES, "terminal receipt"),
    payloadHash: receipt.receiptHash,
    scope: "user",
    ownerUserId: run.ownerUserId,
    createdByUserId: run.createdByUserId,
  });
  const terminalAt = new Date(receipt.terminalAt);
  if (attempt && attempt.phase !== "finished") {
    await tx.update(runtimeAttempts).set({
      phase: "finished",
      result: decision.outcome === "cancelled" ? "cancelled" : decision.outcome === "blocked" ? "blocked" : "completed",
      reasonCode: receipt.reasonCode,
      attribution: decision.attribution,
      finishedAt: terminalAt,
    }).where(and(eq(runtimeAttempts.id, attempt.id), inArray(runtimeAttempts.phase, ["leased", "running"])));
  }
  const terminalPredicate = principal.actorType === "user"
    ? and(eq(runtimeRuns.id, run.id), eq(runtimeRuns.accountId, principal.accountId!), sql`${runtimeRuns.phase} <> 'terminal'`)
    : and(eq(runtimeRuns.id, run.id), eq(runtimeRuns.accountId, run.accountId), eq(runtimeRuns.ownerUserId, run.ownerUserId), sql`${runtimeRuns.phase} <> 'terminal'`);
  const [terminalRun] = await tx.update(runtimeRuns).set({
    phase: "terminal",
    outcome: decision.outcome,
    outcomeReasonCode: receipt.reasonCode,
    attribution: decision.attribution,
    receiptEventId,
    terminalAt,
    updatedAt: terminalAt,
  }).where(terminalPredicate).returning();
  if (!terminalRun) throw Object.assign(new Error("Runtime terminalization changed concurrently"), { status: 409 });
  await appendTransactionalOutboxEvent(tx, principal, { userId: run.ownerUserId, accountId: run.accountId }, {
    eventType: "runtime.run.terminalized",
    aggregateType: "runtime_run",
    aggregateId: run.id,
    idempotencyKey: `runtime.run.terminalized/${run.id}`,
    payload: { receiptId: receiptEventId, accountId: run.accountId, handlerKey: run.handlerKey, receiptVersion: receipt.version },
  });
  return { run: terminalRun, receipt };
}

async function terminalizeWithoutDecision(
  principal: Principal,
  runId: string,
  attemptId: string | null,
  decision: {
    outcome: RuntimeRunOutcome;
    reasonCode: string;
    attribution: RuntimeAttribution;
    outputRefs: string[];
    verificationLevel: RuntimeReceiptV1["verificationLevel"];
  },
): Promise<{ run: RuntimeRunRow; receipt: RuntimeReceiptV1 }> {
  return runWithPrincipal(principal, () => db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.RUNTIME_RUN, `${principal.accountId ?? "system"}:${runId}`);
    const [run] = await tx.select().from(runtimeRuns).where(scopeWritable(principal, eq(runtimeRuns.id, runId))).limit(1);
    if (!run) throw Object.assign(new Error("Runtime run not found or not writable"), { status: 404 });
    const [attempt] = attemptId
      ? await tx.select().from(runtimeAttempts).where(attemptWritable(principal, and(eq(runtimeAttempts.id, attemptId), eq(runtimeAttempts.runId, run.id)))).limit(1)
      : [undefined];
    return terminalizeInTransaction(tx, principal, run, attempt ?? null, decision);
  })));
}

export async function resolveRuntimeAttempt(
  principal: Principal,
  fence: RuntimeFence,
  decision: RuntimeAttemptDecision,
): Promise<{ phase: "pending" | "terminal"; run: RuntimeRunRow; receipt?: RuntimeReceiptV1 }> {
  requireUserPrincipal(principal);
  if (principal.accountId !== fence.accountId) throw Object.assign(new Error("Runtime fence account mismatch"), { status: 403 });
  return runWithPrincipal(principal, () => db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.RUNTIME_RUN, `${principal.accountId}:${fence.runId}`);
    const current = await loadFencedAttempt(tx, fence, ["leased", "running"]);
    const executionStartedAt = current.attempt.startedAt ?? current.attempt.leasedAt;
    const elapsedMs = Math.max(0, Date.now() - executionStartedAt.getTime());
    const maxWallClockMs = (current.run.budget as RuntimeBudgetV1).maxWallClockMs;
    if (elapsedMs > maxWallClockMs) {
      const terminal = await terminalizeInTransaction(tx, principal, current.run, current.attempt, {
        outcome: "blocked",
        reasonCode: "wall_clock_budget_exhausted",
        attribution: "runtime",
        outputRefs: [],
        verificationLevel: "observed",
      });
      log.info("runtime.run.terminalized", { runId: terminal.run.id, attemptId: current.attempt.id, accountId: terminal.run.accountId, handler: `${terminal.run.handlerKey}@${terminal.run.handlerVersion}`, resourcePool: terminal.run.resourcePool, outcome: "blocked", reasonCode: "wall_clock_budget_exhausted" });
      return { phase: "terminal" as const, ...terminal };
    }
    if (decision.kind === "retry") {
      const retryAt = decision.retryAt;
      if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime()) || retryAt <= new Date() || retryAt >= current.run.deadlineAt) {
        throw Object.assign(new Error("retryAt must be in the future and before the run deadline"), { status: 400 });
      }
      const retryPolicy = current.run.retryPolicy as RuntimeRetryPolicyV1;
      if (!retryPolicy.retryableFailureClasses.includes(decision.failureClass)) {
        throw Object.assign(new Error("Failure class is not retryable by the run policy"), { status: 400 });
      }
      if (current.attempt.attemptNumber >= retryPolicy.maxAttempts) {
        const terminalReasonCode = decision.reasonCode === "handler_exception"
          ? "retry_policy_exhausted"
          : decision.reasonCode;
        const terminal = await terminalizeInTransaction(tx, principal, current.run, current.attempt, {
          outcome: "failed",
          reasonCode: terminalReasonCode,
          attribution: decision.attribution,
          outputRefs: [],
          verificationLevel: "observed",
        });
        log.info("runtime.run.terminalized", { runId: terminal.run.id, attemptId: current.attempt.id, accountId: terminal.run.accountId, handler: `${terminal.run.handlerKey}@${terminal.run.handlerVersion}`, resourcePool: terminal.run.resourcePool, outcome: "failed", reasonCode: terminalReasonCode, retryExhausted: true });
        return { phase: "terminal" as const, ...terminal };
      }
      await tx.update(runtimeAttempts).set({
        phase: "finished",
        result: "retry",
        failureClass: boundedText(decision.failureClass, "failureClass", 120),
        reasonCode: boundedReasonCode(decision.reasonCode),
        attribution: decision.attribution,
        finishedAt: new Date(),
      }).where(eq(runtimeAttempts.id, current.attempt.id));
      const [pending] = await tx.update(runtimeRuns).set({ phase: "pending", currentAttemptId: null, availableAt: retryAt, updatedAt: new Date() })
        .where(and(eq(runtimeRuns.id, current.run.id), eq(runtimeRuns.currentAttemptId, current.attempt.id))).returning();
      if (!pending) throw Object.assign(new Error("Runtime retry fence changed concurrently"), { status: 409, code: "stale_fence" });
      log.info("runtime.run.retry_scheduled", { runId: pending.id, attemptId: current.attempt.id, accountId: pending.accountId, handler: `${pending.handlerKey}@${pending.handlerVersion}`, resourcePool: pending.resourcePool, reasonCode: decision.reasonCode });
      return { phase: "pending" as const, run: pending };
    }
    const terminal = await terminalizeInTransaction(tx, principal, current.run, current.attempt, decision);
    log.info("runtime.run.terminalized", { runId: terminal.run.id, attemptId: current.attempt.id, accountId: terminal.run.accountId, handler: `${terminal.run.handlerKey}@${terminal.run.handlerVersion}`, resourcePool: terminal.run.resourcePool, outcome: decision.outcome, reasonCode: decision.reasonCode });
    return { phase: "terminal" as const, ...terminal };
  })));
}

export async function requestRuntimeCancellation(
  principal: Principal,
  runIdInput: string,
  reasonCodeInput: string,
): Promise<RuntimeRunRow> {
  requireUserPrincipal(principal);
  const runId = boundedText(runIdInput, "runId", 100);
  const reasonCode = boundedReasonCode(reasonCodeInput);
  const result = await runWithPrincipal(principal, () => db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.RUNTIME_RUN, `${principal.accountId}:${runId}`);
    const [run] = await tx.select().from(runtimeRuns).where(scopeWritable(principal, eq(runtimeRuns.id, runId))).limit(1);
    if (!run) throw Object.assign(new Error("Runtime run not found"), { status: 404 });
    if (run.phase === "terminal") return run;
    if (run.phase === "running") {
      const [updated] = await tx.update(runtimeRuns).set({ cancellationRequestedAt: new Date(), cancellationReasonCode: reasonCode, updatedAt: new Date() })
        .where(scopeWritable(principal, and(eq(runtimeRuns.id, run.id), eq(runtimeRuns.phase, "running")))).returning();
      if (!updated) throw Object.assign(new Error("Runtime cancellation changed concurrently"), { status: 409 });
      return updated;
    }
    const [attempt] = run.currentAttemptId
      ? await tx.select().from(runtimeAttempts).where(attemptWritable(principal, eq(runtimeAttempts.id, run.currentAttemptId))).limit(1)
      : [undefined];
    const terminal = await terminalizeInTransaction(tx, principal, run, attempt ?? null, {
      outcome: "cancelled",
      reasonCode,
      attribution: "user",
      outputRefs: [],
      verificationLevel: "observed",
    });
    return terminal.run;
  })));
  log.info("runtime.run.cancel_requested", { runId: result.id, accountId: result.accountId, handler: `${result.handlerKey}@${result.handlerVersion}`, resourcePool: result.resourcePool, reasonCode });
  return result;
}

export async function getRuntimeRun(principal: Principal, runIdInput: string): Promise<RuntimeRunRow | null> {
  requireUserPrincipal(principal);
  const runId = boundedText(runIdInput, "runId", 100);
  const [run] = await db.select().from(runtimeRuns).where(scopeVisible(principal, eq(runtimeRuns.id, runId))).limit(1);
  return run ?? null;
}

export async function getRuntimeReceipt(principal: Principal, runIdInput: string): Promise<RuntimeReceiptV1 | null> {
  requireUserPrincipal(principal);
  const runId = boundedText(runIdInput, "runId", 100);
  const [run] = await db.select({ id: runtimeRuns.id, receiptEventId: runtimeRuns.receiptEventId })
    .from(runtimeRuns).where(scopeVisible(principal, eq(runtimeRuns.id, runId))).limit(1);
  if (!run?.receiptEventId) return null;
  const [event] = await db.select({ payload: runtimeRunEvents.payload }).from(runtimeRunEvents)
    .where(eventVisible(principal, and(eq(runtimeRunEvents.id, run.receiptEventId), eq(runtimeRunEvents.runId, run.id), eq(runtimeRunEvents.eventType, "terminal_receipt")))).limit(1);
  return (event?.payload as unknown as RuntimeReceiptV1 | undefined) ?? null;
}

export interface RuntimeRunDiagnosticsSummary {
  id: string;
  kind: string;
  handler: { key: string; version: number };
  source: { type: string; id: string };
  idempotencyKey: string;
  resourcePool: RuntimeResourcePool;
  executorProfile: string;
  authorityPolicyVersionAtEnqueue: string;
  phase: RuntimeRunRow["phase"];
  outcome: RuntimeRunRow["outcome"];
  outcomeReasonCode: string | null;
  attribution: RuntimeRunRow["attribution"];
  currentAttemptId: string | null;
  receiptEventId: string | null;
  availableAt: string;
  deadlineAt: string;
  cancellationRequestedAt: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeDiagnosticsFilters {
  limit?: number;
  kind?: string;
  handlerKey?: string;
  sourceType?: string;
  sourceId?: string;
  phase?: RuntimeRunRow["phase"];
}

export interface RuntimeRunDiagnostics {
  run: RuntimeRunDiagnosticsSummary;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    resourcePool: RuntimeResourcePool;
    leaseEpoch: number;
    capacityPolicyVersion: number;
    phase: RuntimeAttemptRow["phase"];
    result: RuntimeAttemptRow["result"];
    failureClass: string | null;
    reasonCode: string | null;
    attribution: RuntimeAttemptRow["attribution"];
    usageSummary: Record<string, number>;
    leasedAt: string;
    startedAt: string | null;
    lastHeartbeatAt: string | null;
    leaseExpiresAt: string;
    finishedAt: string | null;
  }>;
  events: Array<{
    id: string;
    attemptId: string | null;
    eventType: string;
    reasonCode: string | null;
    payloadHash: string;
    occurredAt: string;
  }>;
  receipt: (Omit<RuntimeReceiptV1, "accountId" | "runAs"> & { runAsActorType: RuntimeReceiptV1["runAs"]["actorType"] }) | null;
  terminalOutbox: {
    id: string;
    eventType: string;
    idempotencyKey: string;
    availableAt: string;
    publishedAt: string | null;
    deliveryAttempts: number;
    lastErrorCode: string | null;
    createdAt: string;
  } | null;
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function projectRuntimeRunDiagnosticsSummary(run: RuntimeRunRow): RuntimeRunDiagnosticsSummary {
  return {
    id: run.id,
    kind: run.kind,
    handler: { key: run.handlerKey, version: run.handlerVersion },
    source: { type: run.sourceType, id: run.sourceId },
    idempotencyKey: run.idempotencyKey,
    resourcePool: run.resourcePool,
    executorProfile: run.executorProfile,
    authorityPolicyVersionAtEnqueue: run.authorityPolicyVersionAtEnqueue,
    phase: run.phase,
    outcome: run.outcome,
    outcomeReasonCode: run.outcomeReasonCode,
    attribution: run.attribution,
    currentAttemptId: run.currentAttemptId,
    receiptEventId: run.receiptEventId,
    availableAt: run.availableAt.toISOString(),
    deadlineAt: run.deadlineAt.toISOString(),
    cancellationRequestedAt: toIso(run.cancellationRequestedAt),
    terminalAt: toIso(run.terminalAt),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function listRuntimeRunDiagnostics(
  principal: Principal,
  filters: RuntimeDiagnosticsFilters = {},
): Promise<RuntimeRunDiagnosticsSummary[]> {
  requireUserPrincipal(principal);
  const limit = filters.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw Object.assign(new Error("limit must be an integer from 1 to 50"), { status: 400 });
  }
  const predicates: SQL[] = [];
  if (filters.kind) predicates.push(eq(runtimeRuns.kind, boundedText(filters.kind, "kind", 120)));
  if (filters.handlerKey) predicates.push(eq(runtimeRuns.handlerKey, boundedText(filters.handlerKey, "handlerKey", 120)));
  if (filters.sourceType) predicates.push(eq(runtimeRuns.sourceType, boundedText(filters.sourceType, "sourceType", 120)));
  if (filters.sourceId) predicates.push(eq(runtimeRuns.sourceId, boundedText(filters.sourceId, "sourceId", 500)));
  if (filters.phase) predicates.push(eq(runtimeRuns.phase, filters.phase));
  const rows = await db.select().from(runtimeRuns)
    .where(scopeVisible(principal, predicates.length > 0 ? and(...predicates) : undefined))
    .orderBy(desc(runtimeRuns.createdAt), desc(runtimeRuns.id))
    .limit(limit);
  return rows.map(projectRuntimeRunDiagnosticsSummary);
}

async function listRuntimeAttemptDiagnostics(
  principal: Principal,
  runId: string,
): Promise<RuntimeRunDiagnostics["attempts"]> {
  const rows = await db.select({
    id: runtimeAttempts.id,
    attemptNumber: runtimeAttempts.attemptNumber,
    resourcePool: runtimeAttempts.resourcePool,
    leaseEpoch: runtimeAttempts.leaseEpoch,
    capacityPolicyVersion: runtimeAttempts.capacityPolicyVersion,
    phase: runtimeAttempts.phase,
    result: runtimeAttempts.result,
    failureClass: runtimeAttempts.failureClass,
    reasonCode: runtimeAttempts.reasonCode,
    attribution: runtimeAttempts.attribution,
    usageSummary: runtimeAttempts.usageSummary,
    leasedAt: runtimeAttempts.leasedAt,
    startedAt: runtimeAttempts.startedAt,
    lastHeartbeatAt: runtimeAttempts.lastHeartbeatAt,
    leaseExpiresAt: runtimeAttempts.leaseExpiresAt,
    finishedAt: runtimeAttempts.finishedAt,
  }).from(runtimeAttempts)
    .where(attemptVisible(principal, eq(runtimeAttempts.runId, runId)))
    .orderBy(asc(runtimeAttempts.attemptNumber))
    .limit(20);
  return rows.map((attempt) => ({
    ...attempt,
    leasedAt: attempt.leasedAt.toISOString(),
    startedAt: toIso(attempt.startedAt),
    lastHeartbeatAt: toIso(attempt.lastHeartbeatAt),
    leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
    finishedAt: toIso(attempt.finishedAt),
  }));
}

async function listRuntimeEventDiagnostics(
  principal: Principal,
  runId: string,
): Promise<RuntimeRunDiagnostics["events"]> {
  const rows = await db.select({
    id: runtimeRunEvents.id,
    attemptId: runtimeRunEvents.attemptId,
    eventType: runtimeRunEvents.eventType,
    reasonCode: runtimeRunEvents.reasonCode,
    payloadHash: runtimeRunEvents.payloadHash,
    occurredAt: runtimeRunEvents.occurredAt,
  }).from(runtimeRunEvents)
    .where(eventVisible(principal, eq(runtimeRunEvents.runId, runId)))
    .orderBy(asc(runtimeRunEvents.occurredAt), asc(runtimeRunEvents.id))
    .limit(MAX_EVIDENCE_EVENTS_PER_RECEIPT + 1);
  return rows.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() }));
}

async function getRuntimeOutboxDiagnostics(
  principal: Principal,
  runId: string,
): Promise<RuntimeRunDiagnostics["terminalOutbox"]> {
  const [row] = await db.select({
    id: transactionalOutbox.id,
    eventType: transactionalOutbox.eventType,
    idempotencyKey: transactionalOutbox.idempotencyKey,
    availableAt: transactionalOutbox.availableAt,
    publishedAt: transactionalOutbox.publishedAt,
    deliveryAttempts: transactionalOutbox.deliveryAttempts,
    lastErrorCode: transactionalOutbox.lastErrorCode,
    createdAt: transactionalOutbox.createdAt,
  }).from(transactionalOutbox)
    .where(outboxVisible(principal, and(
      eq(transactionalOutbox.aggregateType, "runtime_run"),
      eq(transactionalOutbox.aggregateId, runId),
      eq(transactionalOutbox.eventType, "runtime.run.terminalized"),
    )))
    .orderBy(desc(transactionalOutbox.createdAt))
    .limit(1);
  return row ? {
    ...row,
    availableAt: row.availableAt.toISOString(),
    publishedAt: toIso(row.publishedAt),
    createdAt: row.createdAt.toISOString(),
  } : null;
}

function projectRuntimeReceiptDiagnostics(
  receipt: RuntimeReceiptV1 | null,
): RuntimeRunDiagnostics["receipt"] {
  if (!receipt) return null;
  const { accountId: _accountId, runAs, ...proof } = receipt;
  return { ...proof, runAsActorType: runAs.actorType };
}

export async function getRuntimeRunDiagnostics(
  principal: Principal,
  runIdInput: string,
): Promise<RuntimeRunDiagnostics | null> {
  requireUserPrincipal(principal);
  const runId = boundedText(runIdInput, "runId", 100);
  const [run] = await db.select().from(runtimeRuns)
    .where(scopeVisible(principal, eq(runtimeRuns.id, runId)))
    .limit(1);
  if (!run) return null;
  const [attempts, events, receipt, terminalOutbox] = await Promise.all([
    listRuntimeAttemptDiagnostics(principal, run.id),
    listRuntimeEventDiagnostics(principal, run.id),
    getRuntimeReceipt(principal, run.id),
    getRuntimeOutboxDiagnostics(principal, run.id),
  ]);
  return {
    run: projectRuntimeRunDiagnosticsSummary(run),
    attempts,
    events,
    receipt: projectRuntimeReceiptDiagnostics(receipt),
    terminalOutbox,
  };
}
