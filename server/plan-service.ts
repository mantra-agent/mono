import { randomUUID } from "crypto";
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { planExecutions, planSessionLinks, planStepAttempts, planSteps, type PlanExecutionRow, type PlanStepAttemptRow, type PlanStepRow } from "@shared/schema";
import { buildPlanPageContent, type PlanMeta, type PlanStatus, type PlanStep } from "./lib/plan-utils";

const log = createLogger("PlanService");

const planScopeColumns = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
const planStepScopeColumns = { ownerUserId: planSteps.ownerUserId, accountId: planSteps.accountId };
const planAttemptScopeColumns = { ownerUserId: planStepAttempts.ownerUserId, accountId: planStepAttempts.accountId };
const planLinkScopeColumns = { ownerUserId: planSessionLinks.ownerUserId, accountId: planSessionLinks.accountId };

function visiblePlan(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }
function writablePlan(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }
function visiblePlanStep(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planStepScopeColumns, predicate); }
function writablePlanStep(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planStepScopeColumns, predicate); }
function visiblePlanAttempt(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planAttemptScopeColumns, predicate); }
function writablePlanAttempt(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planAttemptScopeColumns, predicate); }
function writablePlanLink(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planLinkScopeColumns, predicate); }

export type PlanStepStatus = PlanStep["status"];
export type AttemptStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "needs_review" | "abandoned";

const VALID_STEP_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["running", "blocked", "needs_review", "completed", "failed", "skipped"],
  running: ["completed", "failed", "blocked", "needs_review"],
  failed: ["pending"],
  blocked: ["pending"],
  needs_review: ["pending"],
  completed: [],
  skipped: [],
};

export function assertPlanStepTransition(stepId: string, from: string, to: string, context: string): void {
  const allowed = VALID_STEP_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`[state] Invalid step transition ${from} → ${to} for step ${stepId} (${context})`);
  }
}

export async function resolvePlanByIdOrPage(planId: string): Promise<PlanExecutionRow | null> {
  const byId = await db.select().from(planExecutions).where(visiblePlan(eq(planExecutions.id, planId))).then(rows => rows[0]);
  if (byId) return byId;
  return db.select().from(planExecutions).where(visiblePlan(eq(planExecutions.pageId, planId))).then(rows => rows[0] ?? null);
}

export async function getPlanSteps(planId: string): Promise<PlanStepRow[]> {
  return db.select().from(planSteps).where(visiblePlanStep(eq(planSteps.planId, planId))).orderBy(planSteps.position);
}

export async function updatePlanStatus(planId: string, status: PlanStatus | string): Promise<void> {
  await db.update(planExecutions).set({ status, updatedAt: new Date() }).where(writablePlan(eq(planExecutions.id, planId)));
}

export async function transitionPlanStepStatus(
  planId: string,
  stepId: string,
  expectedStatus: string,
  nextStatus: string,
  fields: Partial<{
    sessionId: string | null;
    outcome: string | null;
    error: string | null;
    durationSeconds: number | null;
    startedAt: Date | null;
    completedAt: Date | null;
    totalAttempts: number;
  }>,
  context: string,
): Promise<void> {
  assertPlanStepTransition(stepId, expectedStatus, nextStatus, context);
  const updated = await db.update(planSteps)
    .set({ ...fields, status: nextStatus, updatedAt: new Date() })
    .where(writablePlanStep(and(eq(planSteps.planId, planId), eq(planSteps.id, stepId), eq(planSteps.status, expectedStatus))))
    .returning({ id: planSteps.id });
  if (updated.length === 0) {
    throw new Error(`[state] Step ${stepId} was not ${expectedStatus}; refused ${nextStatus} transition (${context})`);
  }
}

export async function updatePlanStepFields(
  planId: string,
  stepId: string,
  fields: Partial<typeof planSteps.$inferInsert>,
): Promise<void> {
  await db.update(planSteps).set({ ...fields, updatedAt: new Date() }).where(writablePlanStep(and(eq(planSteps.planId, planId), eq(planSteps.id, stepId))));
}

export const PLAN_EXECUTION_LEASE_MS = 2 * 60 * 1000;

export async function claimPlanExecution(
  planId: string,
  owner: string,
  leaseMs = PLAN_EXECUTION_LEASE_MS,
): Promise<{ claimed: true; leaseId: string; expiresAt: Date } | { claimed: false }> {
  const leaseId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const rows = await db.update(planExecutions)
    .set({ executionLeaseId: leaseId, executionLeaseOwner: owner, executionLeaseExpiresAt: expiresAt, executionClaimedAt: now, updatedAt: now })
    .where(writablePlan(and(
      eq(planExecutions.id, planId),
      or(isNull(planExecutions.executionLeaseExpiresAt), lt(planExecutions.executionLeaseExpiresAt, now)),
    )))
    .returning({ id: planExecutions.id });
  return rows.length ? { claimed: true, leaseId, expiresAt } : { claimed: false };
}

export async function renewPlanExecution(
  planId: string,
  leaseId: string,
  leaseMs = PLAN_EXECUTION_LEASE_MS,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const rows = await db.update(planExecutions)
    .set({ executionLeaseExpiresAt: expiresAt, updatedAt: now })
    .where(writablePlan(and(
      eq(planExecutions.id, planId),
      eq(planExecutions.executionLeaseId, leaseId),
    )))
    .returning({ id: planExecutions.id });
  return rows.length > 0;
}

export async function releasePlanExecution(planId: string, leaseId: string): Promise<void> {
  await db.update(planExecutions)
    .set({ executionLeaseId: null, executionLeaseOwner: null, executionLeaseExpiresAt: null, updatedAt: new Date() })
    .where(writablePlan(and(eq(planExecutions.id, planId), eq(planExecutions.executionLeaseId, leaseId))));
}

export async function createPlanSessionLink(planId: string, sessionId: string, anchorMessageId?: string | null): Promise<void> {
  await db.insert(planSessionLinks).values({
    ...ownedInsertValues(getCurrentPrincipalOrSystem(), planLinkScopeColumns),
    planId,
    sessionId,
    anchorMessageId: anchorMessageId ?? null,
  }).onConflictDoNothing();
}

export async function unlinkPlanSession(planId: string, sessionId: string): Promise<number> {
  const rows = await db.update(planSessionLinks)
    .set({ unlinkedAt: new Date(), updatedAt: new Date() })
    .where(writablePlanLink(and(eq(planSessionLinks.planId, planId), eq(planSessionLinks.sessionId, sessionId), isNull(planSessionLinks.unlinkedAt))))
    .returning({ id: planSessionLinks.id });
  return rows.length;
}

export async function createPlanStepAttempt(params: {
  planId: string;
  stepId: string;
  attemptNumber: number;
  childSessionId?: string | null;
  status?: AttemptStatus;
  startedAt?: Date | null;
}): Promise<number | null> {
  const rows = await db.insert(planStepAttempts).values({
    ...ownedInsertValues(getCurrentPrincipalOrSystem(), planAttemptScopeColumns),
    planId: params.planId,
    stepId: params.stepId,
    attemptNumber: params.attemptNumber,
    childSessionId: params.childSessionId ?? null,
    status: params.status ?? "pending",
    startedAt: params.startedAt ?? null,
  }).onConflictDoUpdate({
    target: [planStepAttempts.planId, planStepAttempts.stepId, planStepAttempts.attemptNumber],
    set: {
      childSessionId: params.childSessionId ?? null,
      status: params.status ?? "pending",
      startedAt: params.startedAt ?? null,
      updatedAt: new Date(),
    },
  }).returning({ id: planStepAttempts.id });
  return rows[0]?.id ?? null;
}

export async function updatePlanStepAttempt(params: {
  planId: string;
  stepId: string;
  attemptNumber: number;
  status: AttemptStatus;
  childSessionId?: string | null;
  outcome?: string | null;
  error?: string | null;
  durationSeconds?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}): Promise<void> {
  const patch: Partial<typeof planStepAttempts.$inferInsert> = {
    status: params.status,
    updatedAt: new Date(),
  };
  if (Object.prototype.hasOwnProperty.call(params, "childSessionId")) patch.childSessionId = params.childSessionId ?? null;
  if (Object.prototype.hasOwnProperty.call(params, "outcome")) patch.outcome = params.outcome ?? null;
  if (Object.prototype.hasOwnProperty.call(params, "error")) patch.error = params.error ?? null;
  if (Object.prototype.hasOwnProperty.call(params, "durationSeconds")) patch.durationSeconds = params.durationSeconds ?? null;
  if (Object.prototype.hasOwnProperty.call(params, "startedAt")) patch.startedAt = params.startedAt ?? null;
  if (Object.prototype.hasOwnProperty.call(params, "completedAt")) patch.completedAt = params.completedAt ?? null;

  await db.update(planStepAttempts).set(patch).where(writablePlanAttempt(and(
    eq(planStepAttempts.planId, params.planId),
    eq(planStepAttempts.stepId, params.stepId),
    eq(planStepAttempts.attemptNumber, params.attemptNumber),
  )));
}

export async function getLatestPlanStepAttempt(planId: string, stepId: string): Promise<PlanStepAttemptRow | null> {
  const rows = await db.select().from(planStepAttempts)
    .where(visiblePlanAttempt(and(eq(planStepAttempts.planId, planId), eq(planStepAttempts.stepId, stepId))))
    .orderBy(planStepAttempts.attemptNumber);
  return rows[rows.length - 1] ?? null;
}

function planRowsToMeta(plan: PlanExecutionRow, steps: PlanStepRow[]): PlanMeta {
  return {
    id: plan.id,
    status: plan.status as PlanStatus,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    originSessionId: plan.originSessionId,
    goalId: plan.goalId ?? undefined,
    projectId: plan.projectId ?? undefined,
    workspace: plan.workspace ?? undefined,
    workspaceDir: plan.workspaceDir ?? undefined,
    blocking: plan.blocking,
    steps: steps.map(s => ({
      id: s.id,
      title: s.title,
      status: s.status as PlanStep["status"],
      duration: s.durationSeconds ?? undefined,
      sessionId: s.sessionId ?? undefined,
      outcome: s.outcome ?? undefined,
      error: s.error ?? undefined,
      startedAt: s.startedAt?.toISOString(),
      completedAt: s.completedAt?.toISOString(),
    })),
  };
}

function formatAttemptDuration(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return ` · ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return ` · ${minutes}m ${remaining}s`;
}

async function getRunHistoryMarkdown(planId: string, stepTitles: Map<string, string>): Promise<string> {
  const attempts = await db.select().from(planStepAttempts)
    .where(visiblePlanAttempt(eq(planStepAttempts.planId, planId)))
    .orderBy(planStepAttempts.id);
  if (attempts.length === 0) return "";
  const sections = ["## Run History"];
  for (const attempt of attempts) {
    const sessionRef = attempt.childSessionId ? `@session:${attempt.childSessionId}` : "No child session";
    const duration = formatAttemptDuration(attempt.durationSeconds);
    const title = stepTitles.get(attempt.stepId) ?? attempt.stepId;
    sections.push(`\n### ${title} · Attempt ${attempt.attemptNumber}\n${sessionRef} · ${attempt.status}${duration}\n\n${attempt.outcome || attempt.error || "No outcome recorded yet."}`);
  }
  return sections.join("\n");
}

export async function renderPlanProjection(planId: string): Promise<void> {
  try {
    const plan = await resolvePlanByIdOrPage(planId);
    if (!plan) return;
    const steps = await getPlanSteps(plan.id);
    const stepInstructions = steps.map(s => ({ title: s.title, instructions: s.instructions || `Execute step: ${s.title}` }));
    const stepTitles = new Map(steps.map((s, index) => [s.id, `Step ${index + 1}: ${s.title}`]));
    const runHistory = await getRunHistoryMarkdown(plan.id, stepTitles);
    const content = [buildPlanPageContent(planRowsToMeta(plan, steps), stepInstructions), runHistory].filter(Boolean).join("\n\n");

    const { libraryPages } = await import("@shared/models/info");
    const { syncContentFields } = await import("@shared/markdown-tiptap");
    const synced = syncContentFields({ markdown: content });
    const libraryScope = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };
    await db.update(libraryPages).set({
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      updatedAt: new Date(),
    }).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), libraryScope, eq(libraryPages.id, plan.pageId)));
  } catch (err) {
    log.warn(`Failed to render plan ${planId} projection: ${err instanceof Error ? err.message : String(err)}`);
  }
}
