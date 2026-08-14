import type { SkillRun } from "@shared/models/skills";
import type { Timer, TimerRun, TimerRunStatus } from "@shared/models/timers";
import { responsibilityRuns, type MemoryVnextSourceQueueRow } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
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
const TIMER_SKILL_HANDLER_KEY = "skill.execute.timer";
const SKILL_EXECUTION_HANDLER_KEY = "skill.execute";
const MEMORY_SOURCE_HANDLER_KEY = "memory.source.process";
const PLAN_EXECUTION_HANDLER_KEY = "plan.execute";
const HANDLER_VERSION = 1;
const INPUT_SCHEMA_VERSION = 1;
const AUTHORITY_POLICY_VERSION = "proof-path-v1";
const HOUR_MS = 60 * 60 * 1000;

interface WeeklyIdeasInput {
  timerId: string;
  sourceSlot: string;
}

interface TimerSkillInput {
  timerId: string;
  timerRunId: string;
  skillId: string;
  prompt?: string;
}

interface SkillExecutionInput {
  skillId: string;
  preContext?: string;
  launchKey: string;
  spawnerTool: string;
}

interface PlanExecutionInput {
  planId: string;
  originSessionId: string;
  planTitle: string;
  launchKey: string;
  parentRuntimeRunId?: string;
}

interface MemorySourceInput {
  queueId: number;
  sourceType: "session" | "library_page" | "drive_file";
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

function mapRuntimeOutcomeToTimerStatus(outcome: import("@shared/models/runtime").RuntimeRunOutcome): TimerRunStatus {
  if (outcome === "succeeded") return "success";
  if (outcome === "degraded" || outcome === "needs_review") return "degraded";
  return "error";
}

function parseTimerSkillInput(value: unknown): TimerSkillInput {
  const input = parseObject(value, "Timer Skill input");
  const prompt = typeof input.prompt === "string" && input.prompt.trim()
    ? parseBoundedString(input.prompt, "prompt", 40_000)
    : undefined;
  return {
    timerId: parseBoundedString(input.timerId, "timerId", 100),
    timerRunId: parseBoundedString(input.timerRunId, "timerRunId", 160),
    skillId: parseBoundedString(input.skillId, "skillId", 100),
    prompt,
  };
}

function parseSkillExecutionInput(value: unknown): SkillExecutionInput {
  const input = parseObject(value, "Skill execution input");
  const preContext = typeof input.preContext === "string" && input.preContext.trim()
    ? parseBoundedString(input.preContext, "preContext", 40_000)
    : undefined;
  return {
    skillId: parseBoundedString(input.skillId, "skillId", 160),
    preContext,
    launchKey: parseBoundedString(input.launchKey, "launchKey", 300),
    spawnerTool: parseBoundedString(input.spawnerTool, "spawnerTool", 160),
  };
}

function parsePlanExecutionInput(value: unknown): PlanExecutionInput {
  const input = parseObject(value, "Plan execution input");
  return {
    planId: parseBoundedString(input.planId, "planId", 160),
    originSessionId: parseBoundedString(input.originSessionId, "originSessionId", 160),
    planTitle: parseBoundedString(input.planTitle, "planTitle", 300),
    launchKey: parseBoundedString(input.launchKey, "launchKey", 300),
    parentRuntimeRunId: typeof input.parentRuntimeRunId === "string" && input.parentRuntimeRunId.trim()
      ? parseBoundedString(input.parentRuntimeRunId, "parentRuntimeRunId", 160)
      : undefined,
  };
}

function parseMemorySourceInput(value: unknown): MemorySourceInput {
  const input = parseObject(value, "Memory source input");
  if (!Number.isInteger(input.queueId) || Number(input.queueId) < 1) throw new Error("queueId must be a positive integer");
  const sourceType = parseBoundedString(input.sourceType, "sourceType", 30);
  if (sourceType !== "session" && sourceType !== "library_page" && sourceType !== "drive_file") {
    throw new Error("sourceType is invalid");
  }
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

async function authorizeTimerSkill(principal: Principal, input: TimerSkillInput) {
  requireUserPrincipal(principal);
  const { timerStorage } = await import("../file-storage");
  const timer = await timerStorage.getByIdOrName(input.timerId);
  const allowed = Boolean(
    timer
    && timer.enabled
    && timer.type === "skill"
    && timer.skillId === input.skillId
    && timer.ownerUserId === principal.userId
    && timer.accountId === principal.accountId,
  );
  return { allowed, reasonCode: allowed ? "timer_skill_authorized" : "timer_skill_authority_revoked" };
}

function terminalSkillRunResult(skillId: string, skillRun: SkillRun | null): RuntimeAttemptDecision | null {
  if (!skillRun || !["succeeded", "degraded", "failed", "yielded"].includes(skillRun.status)) return null;
  const outputRefs = skillRun.sessionId ? [`@session:${skillRun.sessionId}`] : [];
  const outcome = skillRun.status === "succeeded"
    ? "succeeded"
    : skillRun.status === "degraded"
      ? "degraded"
      : skillRun.status === "yielded"
        ? "cancelled"
        : "failed";
  return {
    kind: "complete",
    outcome,
    reasonCode: `timer_skill_${skillId}_${outcome}`,
    attribution: "handler",
    outputRefs,
    verificationLevel: "observed",
  };
}

async function executeTimerSkill(
  context: Parameters<RuntimeHandler<TimerSkillInput>["execute"]>[0],
  input: TimerSkillInput,
): Promise<RuntimeAttemptDecision> {
  const { storage } = await import("../storage");
  const existing = terminalSkillRunResult(input.skillId, await storage.getSkillRunByRuntimeRunId(context.fence.runId));
  if (existing) return existing;

  const { executeAutonomousSkillRun } = await import("../autonomous-skill-runner");
  const result = await executeAutonomousSkillRun(input.skillId, {
    preContext: input.prompt,
    coordinationKey: `runtime:${context.fence.runId}`,
    runtimeFence: { runId: context.fence.runId, attemptId: context.fence.attemptId },
    signal: context.signal,
  });
  if (!result) {
    return {
      kind: "retry",
      failureClass: "transient_runtime_coordination",
      reasonCode: "timer_skill_coordination_busy",
      attribution: "runtime",
      retryAt: new Date(Date.now() + 60_000),
    };
  }

  const outputRefs = [`@session:${result.sessionId}`];
  await context.appendEvidence({
    eventType: "verification",
    reasonCode: "timer_skill_run_observed",
    payload: { timerId: input.timerId, timerRunId: input.timerRunId, skillId: input.skillId, sessionId: result.sessionId, skillStatus: result.status },
  });
  if (result.status === "yielded") {
    return {
      kind: "complete",
      outcome: "cancelled",
      reasonCode: "timer_skill_yielded_to_interactive",
      attribution: "runtime",
      outputRefs,
      verificationLevel: "observed",
    };
  }
  const outcome = result.status === "succeeded" ? "succeeded" : result.status === "degraded" ? "degraded" : "failed";
  return {
    kind: "complete",
    outcome,
    reasonCode: `timer_skill_${input.skillId}_${outcome}`,
    attribution: "handler",
    outputRefs,
    verificationLevel: "observed",
  };
}

async function authorizeSkillExecution(principal: Principal, input: SkillExecutionInput) {
  requireUserPrincipal(principal);
  const { storage } = await import("../storage");
  const skill = await storage.getSkill(input.skillId) ?? await storage.getSkillByName(input.skillId);
  const allowed = Boolean(skill && skill.status === "active");
  return { allowed, reasonCode: allowed ? "skill_execution_authorized" : "skill_execution_authority_revoked" };
}

async function executeSkillRuntime(
  context: Parameters<RuntimeHandler<SkillExecutionInput>["execute"]>[0],
  input: SkillExecutionInput,
): Promise<RuntimeAttemptDecision> {
  const { storage } = await import("../storage");
  const existing = terminalSkillRunResult(input.skillId, await storage.getSkillRunByRuntimeRunId(context.fence.runId));
  if (existing) return existing;
  const { executeAutonomousSkillRun } = await import("../autonomous-skill-runner");
  const result = await executeAutonomousSkillRun(input.skillId, {
    preContext: input.preContext,
    coordinationKey: `runtime:${context.fence.runId}`,
    sessionKeyOverride: `runtime:${context.fence.runId}`,
    spawnerTool: input.spawnerTool,
    runtimeFence: { runId: context.fence.runId, attemptId: context.fence.attemptId },
    signal: context.signal,
  });
  if (!result) {
    return {
      kind: "retry",
      failureClass: "transient_runtime_coordination",
      reasonCode: "skill_execution_coordination_busy",
      attribution: "runtime",
      retryAt: new Date(Date.now() + 60_000),
    };
  }
  const outputRefs = [`@session:${result.sessionId}`];
  await context.appendEvidence({
    eventType: "verification",
    reasonCode: "skill_execution_observed",
    payload: { skillId: input.skillId, launchKey: input.launchKey, sessionId: result.sessionId, skillStatus: result.status },
  });
  if (result.status === "yielded") {
    return { kind: "complete", outcome: "cancelled", reasonCode: "skill_execution_yielded", attribution: "runtime", outputRefs, verificationLevel: "observed" };
  }
  const outcome = result.status === "succeeded" ? "succeeded" : result.status === "degraded" ? "degraded" : "failed";
  return { kind: "complete", outcome, reasonCode: `skill_execution_${outcome}`, attribution: "handler", outputRefs, verificationLevel: "observed" };
}

async function authorizePlanExecution(principal: Principal, input: PlanExecutionInput) {
  requireUserPrincipal(principal);
  const { resolvePlanByIdOrPage } = await import("../plan-service");
  const plan = await resolvePlanByIdOrPage(input.planId);
  const allowed = Boolean(
    plan
    && plan.id === input.planId
    && plan.originSessionId === input.originSessionId
    && (plan.status === "created" || plan.status === "paused" || plan.status === "executing")
    && plan.ownerUserId === principal.userId
    && plan.accountId === principal.accountId,
  );
  return { allowed, reasonCode: allowed ? "plan_execution_authorized" : "plan_execution_authority_revoked" };
}

async function executePlanRuntime(
  context: Parameters<RuntimeHandler<PlanExecutionInput>["execute"]>[0],
  input: PlanExecutionInput,
): Promise<RuntimeAttemptDecision> {
  const { executePlan } = await import("../plan-executor");
  const result = await executePlan(input.planId, input.originSessionId, input.planTitle, true, context.signal);
  const outputRefs = [`@plan:${input.planId}`];
  await context.appendEvidence({
    eventType: "verification",
    reasonCode: "plan_execution_observed",
    payload: {
      planId: input.planId,
      parentRuntimeRunId: input.parentRuntimeRunId ?? null,
      status: result.status,
      completedSteps: result.completedSteps,
      totalSteps: result.totalSteps,
    },
  });
  if (context.signal.aborted) {
    return { kind: "complete", outcome: "cancelled", reasonCode: "plan_execution_cancelled", attribution: "runtime", outputRefs, verificationLevel: "observed" };
  }
  if (result.status === "completed" || result.status === "completed_with_failures") {
    return { kind: "complete", outcome: result.status === "completed" ? "succeeded" : "degraded", reasonCode: `plan_execution_${result.status}`, attribution: "handler", outputRefs, verificationLevel: "observed" };
  }
  if (result.status === "needs_review") {
    return { kind: "complete", outcome: "needs_review", reasonCode: "plan_execution_needs_review", attribution: "handler", outputRefs, verificationLevel: "observed" };
  }
  if (result.status === "paused") {
    return { kind: "complete", outcome: "degraded", reasonCode: "plan_execution_paused", attribution: "handler", outputRefs, verificationLevel: "observed" };
  }
  return { kind: "complete", outcome: "failed", reasonCode: "plan_execution_failed", attribution: "handler", outputRefs, verificationLevel: "observed" };
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
  runtimeHandlerRegistry.register<TimerSkillInput>({
    key: TIMER_SKILL_HANDLER_KEY,
    version: HANDLER_VERSION,
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    inputSchema: { parse: parseTimerSkillInput },
    resourcePool: "background_agent",
    executorProfile: "in_process_trusted",
    requiredCapabilities: ["skill:execute", "timer:skill"],
    authorize: authorizeTimerSkill,
    execute: executeTimerSkill,
    async projectTerminal({ tx, principal, run, input, receipt }) {
      // Source Timer rows are owned by the Runtime run identity. The named
      // runtime-authority-recovery system principal may terminalize when the
      // owning user principal can no longer be restored (archived/suspended/
      // deleted accounts). Never invent user authority; only project from the
      // immutable run owner/account fence.
      if (principal.actorType === "user") {
        requireUserPrincipal(principal);
        if (principal.userId !== run.ownerUserId || principal.accountId !== run.accountId) {
          throw new Error("Timer Runtime terminal projection principal/run mismatch");
        }
      } else if (principal.actorType !== "system" || principal.jobName !== "runtime-authority-recovery") {
        throw new Error("Timer Runtime terminal projection requires owning user or runtime-authority-recovery");
      }
      if (!run.ownerUserId || !run.accountId) {
        throw new Error("Timer Runtime terminal projection missing run owner identity");
      }
      const status = mapRuntimeOutcomeToTimerStatus(receipt.outcome);
      const error = status === "success" ? null : receipt.reasonCode;
      const completedAt = new Date(receipt.terminalAt);
      const updated = await tx.update(responsibilityRuns).set({
        status,
        completedAt,
        error,
        metadata: sql`coalesce(${responsibilityRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({
          runtimeRunId: receipt.runId,
          runtimeReceiptHash: receipt.receiptHash,
          runtimeOutcome: receipt.outcome,
          runtimeReasonCode: receipt.reasonCode,
          runtimeVerificationLevel: receipt.verificationLevel,
        })}::jsonb`,
      }).where(and(
        eq(responsibilityRuns.runId, input.timerRunId),
        eq(responsibilityRuns.responsibilityId, input.timerId),
        eq(responsibilityRuns.ownerUserId, run.ownerUserId),
        eq(responsibilityRuns.accountId, run.accountId),
      )).returning({ runId: responsibilityRuns.runId });
      if (updated.length !== 1) {
        throw new Error(`Timer Runtime terminal projection could not resolve source run ${input.timerRunId}`);
      }
    },
  });
  runtimeHandlerRegistry.register<SkillExecutionInput>({
    key: SKILL_EXECUTION_HANDLER_KEY,
    version: HANDLER_VERSION,
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    inputSchema: { parse: parseSkillExecutionInput },
    resourcePool: "background_agent",
    executorProfile: "in_process_trusted",
    requiredCapabilities: ["skill:execute"],
    authorize: authorizeSkillExecution,
    execute: executeSkillRuntime,
  });
  runtimeHandlerRegistry.register<PlanExecutionInput>({
    key: PLAN_EXECUTION_HANDLER_KEY,
    version: HANDLER_VERSION,
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    inputSchema: { parse: parsePlanExecutionInput },
    resourcePool: "background_agent",
    executorProfile: "in_process_trusted",
    requiredCapabilities: ["plan:execute"],
    authorize: authorizePlanExecution,
    execute: executePlanRuntime,
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

export async function enqueueTimerSkillRuntimeRun(
  principal: Principal,
  timer: Timer,
  timerRun: TimerRun,
  skillId: string,
  prompt?: string,
) {
  requireUserPrincipal(principal);
  return enqueueRuntimeRun(principal, {
    kind: "timer.skill",
    handler: { key: TIMER_SKILL_HANDLER_KEY, version: HANDLER_VERSION },
    source: { type: "timer", id: timer.id },
    idempotencyKey: `timer-skill/${timerRun.id}`,
    deadlineAt: new Date(Date.now() + 4 * HOUR_MS),
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    input: { timerId: timer.id, timerRunId: timerRun.id, skillId, prompt },
    inputRefs: [],
    authorityPolicyVersionAtEnqueue: AUTHORITY_POLICY_VERSION,
    budget: runtimeBudget(3 * 60 * 60 * 1000),
    retryPolicy: runtimeRetryPolicy(),
  });
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

export async function enqueueSkillExecutionRuntimeRun(
  principal: Principal,
  input: SkillExecutionInput,
) {
  requireUserPrincipal(principal);
  return enqueueRuntimeRun(principal, {
    kind: "skill.execution",
    handler: { key: SKILL_EXECUTION_HANDLER_KEY, version: HANDLER_VERSION },
    source: { type: "skill", id: input.skillId },
    idempotencyKey: `skill-execution/${input.launchKey}`,
    deadlineAt: new Date(Date.now() + 4 * HOUR_MS),
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    input,
    inputRefs: [],
    authorityPolicyVersionAtEnqueue: AUTHORITY_POLICY_VERSION,
    budget: runtimeBudget(3 * HOUR_MS),
    retryPolicy: runtimeRetryPolicy(),
  });
}

export async function enqueuePlanExecutionRuntimeRun(
  principal: Principal,
  input: PlanExecutionInput,
) {
  requireUserPrincipal(principal);
  return enqueueRuntimeRun(principal, {
    kind: "plan.execution",
    handler: { key: PLAN_EXECUTION_HANDLER_KEY, version: HANDLER_VERSION },
    source: { type: "plan", id: input.planId },
    idempotencyKey: `plan-execution/${input.launchKey}`,
    deadlineAt: new Date(Date.now() + 24 * HOUR_MS),
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    input,
    inputRefs: [`@plan:${input.planId}`, `@session:${input.originSessionId}`],
    authorityPolicyVersionAtEnqueue: AUTHORITY_POLICY_VERSION,
    budget: runtimeBudget(12 * HOUR_MS),
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
