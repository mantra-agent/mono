import type { Timer, TimerRun } from "@shared/models/timers";
import type { MemoryVnextSourceQueueRow } from "@shared/schema";
import type { Principal } from "../principal";
import { getCurrentPrincipal } from "../principal-context";
import { timerStorage } from "../file-storage/timers";
import {
  DEFAULT_RUNTIME_BUDGET_V1,
  DEFAULT_RUNTIME_RETRY_POLICY_V1,
  enqueueRuntimeRun,
  type EnqueueRuntimeRunInput,
} from "./runtime-storage";
import { runtimeHandlerRegistry, type RuntimeAttemptDecision, type RuntimeHandler } from "./runtime-handler";

const WEEKLY_IDEAS_HANDLER_KEY = "skill.execute.weekly_ideas";
const MEMORY_SOURCE_HANDLER_KEY = "memory.source.process";
const HANDLER_VERSION = 1;
const INPUT_SCHEMA_VERSION = 1;
const AUTHORITY_POLICY_VERSION = "proof-path-v1";
const HOUR_MS = 60 * 60 * 1000;

interface WeeklyIdeasInput {
  timerId: string;
  sourceSlot: string;
}

interface MemorySourceInput {
  queueId: number;
  sourceType: "session" | "library_page";
  sourceId: string;
  sourceVersion: string;
}

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { actorType: "user"; userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Runtime proof paths require an explicit user principal");
  }
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseBoundedString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return normalized;
}

function parseWeeklyIdeasInput(value: unknown): WeeklyIdeasInput {
  const input = parseObject(value, "Weekly Ideas input");
  return {
    timerId: parseBoundedString(input.timerId, "timerId", 100),
    sourceSlot: parseBoundedString(input.sourceSlot, "sourceSlot", 100),
  };
}

function parseMemorySourceInput(value: unknown): MemorySourceInput {
  const input = parseObject(value, "Memory source input");
  if (!Number.isInteger(input.queueId) || Number(input.queueId) < 1) throw new Error("queueId must be a positive integer");
  const sourceType = parseBoundedString(input.sourceType, "sourceType", 30);
  if (sourceType !== "session" && sourceType !== "library_page") throw new Error("sourceType is invalid");
  const sourceVersion = parseBoundedString(input.sourceVersion, "sourceVersion", 100);
  if (!Number.isFinite(new Date(sourceVersion).getTime())) throw new Error("sourceVersion must be an ISO timestamp");
  return {
    queueId: Number(input.queueId),
    sourceType,
    sourceId: parseBoundedString(input.sourceId, "sourceId", 500),
    sourceVersion,
  };
}

async function authorizeWeeklyIdeas(principal: Principal, input: WeeklyIdeasInput) {
  requireUserPrincipal(principal);
  const timer = await timerStorage.get(input.timerId);
  const allowed = Boolean(
    timer
    && timer.enabled
    && timer.scope === "user"
    && timer.ownerUserId === principal.userId
    && timer.accountId === principal.accountId
    && timer.type === "skill"
    && timer.systemKey === "weekly-ideas"
    && (timer.skillId === "ideate" || timer.skillId === "idea-generation"),
  );
  return { allowed, reasonCode: allowed ? "weekly_ideas_authorized" : "weekly_ideas_authority_revoked" };
}

async function executeWeeklyIdeas(
  context: Parameters<RuntimeHandler<WeeklyIdeasInput>["execute"]>[0],
  input: WeeklyIdeasInput,
): Promise<RuntimeAttemptDecision> {
  const { storage } = await import("../storage");
  const existing = await storage.getSkillRunByRuntimeRunId(context.fence.runId);
  if (existing) {
    if (existing.status === "succeeded" || existing.status === "degraded" || existing.status === "failed") {
      return {
        kind: "complete",
        outcome: existing.status,
        reasonCode: `weekly_ideas_skill_${existing.status}`,
        attribution: "handler",
        outputRefs: [`@session:${existing.sessionId}`],
        verificationLevel: "observed",
      };
    }
    return {
      kind: "complete",
      outcome: "needs_review",
      reasonCode: "weekly_ideas_prior_attempt_unsettled",
      attribution: "unknown",
      outputRefs: [`@session:${existing.sessionId}`],
      verificationLevel: "observed",
    };
  }
  const { executeAutonomousSkillRun } = await import("../autonomous-skill-runner");
  const result = await executeAutonomousSkillRun("ideate", {
    coordinationKey: `runtime:${context.fence.runId}`,
    sessionKeyOverride: `runtime:${context.fence.runId}`,
    runtimeFence: { runId: context.fence.runId, attemptId: context.fence.attemptId },
  });
  if (!result) {
    return {
      kind: "retry",
      failureClass: "transient_runtime_coordination",
      reasonCode: "weekly_ideas_coordination_busy",
      attribution: "runtime",
      retryAt: new Date(Date.now() + 60_000),
    };
  }
  const outputRefs = [`@session:${result.sessionId}`];
  await context.appendEvidence({
    eventType: "verification",
    reasonCode: "weekly_ideas_skill_run_observed",
    payload: { sessionId: result.sessionId, skillStatus: result.status, sourceSlot: input.sourceSlot },
  });
  if (result.status === "succeeded") {
    return { kind: "complete", outcome: "succeeded", reasonCode: "weekly_ideas_completed", attribution: "handler", outputRefs, verificationLevel: "observed" };
  }
  if (result.status === "degraded") {
    return { kind: "complete", outcome: "degraded", reasonCode: "weekly_ideas_degraded", attribution: "handler", outputRefs, verificationLevel: "observed" };
  }
  if (result.status === "yielded") {
    return {
      kind: "retry",
      failureClass: "transient_runtime_coordination",
      reasonCode: "weekly_ideas_yielded",
      attribution: "runtime",
      retryAt: new Date(Date.now() + 60_000),
    };
  }
  return { kind: "complete", outcome: "failed", reasonCode: "weekly_ideas_failed", attribution: "handler", outputRefs, verificationLevel: "observed" };
}

async function authorizeMemorySource(principal: Principal, input: MemorySourceInput) {
  requireUserPrincipal(principal);
  const { getSourceQueueRow } = await import("../memory/vnext-source-queue");
  const row = await getSourceQueueRow(input.queueId, principal);
  const allowed = Boolean(
    row
    && row.ownerUserId === principal.userId
    && row.accountId === principal.accountId
    && row.sourceType === input.sourceType
    && row.sourceId === input.sourceId
    && row.lastModifiedAt.toISOString() === input.sourceVersion,
  );
  return { allowed, reasonCode: allowed ? "memory_source_authorized" : "memory_source_authority_revoked" };
}

async function executeMemorySource(
  context: Parameters<RuntimeHandler<MemorySourceInput>["execute"]>[0],
  input: MemorySourceInput,
): Promise<RuntimeAttemptDecision> {
  const principal = getCurrentPrincipal();
  if (!principal) throw new Error("Memory source handler lost its restored principal");
  const sourceVersion = new Date(input.sourceVersion);
  const { claimSourceForRuntime } = await import("../memory/vnext-source-queue");
  const row = await claimSourceForRuntime(input.queueId, sourceVersion, context.fence, principal);
  if (!row) {
    return { kind: "complete", outcome: "cancelled", reasonCode: "memory_source_superseded", attribution: "producer", outputRefs: [], verificationLevel: "observed" };
  }
  const { memoryVnextClaimStorage } = await import("../memory/vnext-claim-storage");
  const backfill = await memoryVnextClaimStorage.backfillMissingActiveEmbeddings(25);
  if (backfill.errors > 0) {
    return {
      kind: "retry",
      failureClass: "transient_database",
      reasonCode: "memory_embedding_backfill_incomplete",
      attribution: "handler",
      retryAt: new Date(Date.now() + 60_000),
    };
  }
  const { processSourceForRuntime } = await import("../memory/vnext-source-poller");
  const result = await processSourceForRuntime(row, context.fence, principal);
  await context.appendEvidence({
    eventType: "verification",
    reasonCode: "memory_source_processed",
    payload: {
      queueId: row.id,
      sourceType: row.sourceType,
      created: result.created,
      reinforced: result.reinforced,
      skipped: result.skipped,
    },
  });
  return { kind: "complete", outcome: "succeeded", reasonCode: "memory_source_completed", attribution: "handler", outputRefs: [], verificationLevel: "verified" };
}

let registered = false;

export function registerRuntimeProofPathHandlers(): void {
  if (registered) return;
  registered = true;
  runtimeHandlerRegistry.register<WeeklyIdeasInput>({
    key: WEEKLY_IDEAS_HANDLER_KEY,
    version: HANDLER_VERSION,
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    inputSchema: { parse: parseWeeklyIdeasInput },
    resourcePool: "background_agent",
    executorProfile: "in_process_trusted",
    requiredCapabilities: ["skill:execute", "timer:weekly-ideas"],
    authorize: authorizeWeeklyIdeas,
    execute: executeWeeklyIdeas,
  });
  runtimeHandlerRegistry.register<MemorySourceInput>({
    key: MEMORY_SOURCE_HANDLER_KEY,
    version: HANDLER_VERSION,
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    inputSchema: { parse: parseMemorySourceInput },
    resourcePool: "short_worker",
    executorProfile: "in_process_trusted",
    requiredCapabilities: ["memory:source-process"],
    authorize: authorizeMemorySource,
    execute: executeMemorySource,
  });
}

function runtimeBudget(maxWallClockMs: number) {
  return { ...DEFAULT_RUNTIME_BUDGET_V1, maxWallClockMs };
}

function runtimeRetryPolicy(): EnqueueRuntimeRunInput["retryPolicy"] {
  return {
    ...DEFAULT_RUNTIME_RETRY_POLICY_V1,
    retryableFailureClasses: [
      ...DEFAULT_RUNTIME_RETRY_POLICY_V1.retryableFailureClasses,
      "transient_runtime_coordination",
    ],
  };
}

export async function enqueueWeeklyIdeasRuntimeRun(
  principal: Principal,
  timer: Timer,
  timerRun: TimerRun,
) {
  requireUserPrincipal(principal);
  const sourceSlot = timerRun.intendedFireAt ?? timerRun.startedAt;
  return enqueueRuntimeRun(principal, {
    kind: "timer.weekly_ideas",
    handler: { key: WEEKLY_IDEAS_HANDLER_KEY, version: HANDLER_VERSION },
    source: { type: "timer", id: timer.id },
    idempotencyKey: `timer/${timer.id}/slot/${sourceSlot}`,
    deadlineAt: new Date(Math.max(Date.now() + HOUR_MS, new Date(sourceSlot).getTime() + 24 * HOUR_MS)),
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    input: { timerId: timer.id, sourceSlot },
    inputRefs: [],
    authorityPolicyVersionAtEnqueue: AUTHORITY_POLICY_VERSION,
    budget: runtimeBudget(15 * 60 * 1000),
    retryPolicy: runtimeRetryPolicy(),
  });
}

export async function enqueueMemorySourceRuntimeRun(
  principal: Principal,
  row: MemoryVnextSourceQueueRow,
) {
  requireUserPrincipal(principal);
  const sourceVersion = row.lastModifiedAt.toISOString();
  return enqueueRuntimeRun(principal, {
    kind: "memory.source",
    handler: { key: MEMORY_SOURCE_HANDLER_KEY, version: HANDLER_VERSION },
    source: { type: row.sourceType, id: row.sourceId },
    idempotencyKey: `memory-source/${row.id}/version/${sourceVersion}`.replaceAll(":", "-"),
    deadlineAt: new Date(Date.now() + 6 * HOUR_MS),
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    input: { queueId: row.id, sourceType: row.sourceType, sourceId: row.sourceId, sourceVersion },
    inputRefs: [],
    authorityPolicyVersionAtEnqueue: AUTHORITY_POLICY_VERSION,
    budget: runtimeBudget(10 * 60 * 1000),
    retryPolicy: runtimeRetryPolicy(),
  });
}
