import { randomUUID } from "crypto";
import type { PlanStepPersona } from "./plan-persona";
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db, runWithDatabaseTransaction } from "./db";
import { createLogger } from "./log";
import { eventBus } from "./event-bus";
import { requireCurrentPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { planExecutions, planSessionLinks, planStepAttempts, planStepReviews, planSteps, type PlanExecutionRow, type PlanStepAttemptRow, type PlanStepReviewRow, type PlanStepRow } from "@shared/schema";
import { PLAN_REVIEW_REASON_MAX_LENGTH, PLAN_REVIEW_DETAIL_MAX_LENGTH, type PlanReviewDecision } from "@shared/plan-review";
import { buildPlanPageContent, isPlanDone, type PlanMeta, type PlanStatus, type PlanStep } from "./lib/plan-utils";

const log = createLogger("PlanService");

function publishPlanReviewSessionsChanged(sessionIds: Array<string | null | undefined>): void {
  const unique = Array.from(
    new Set(
      sessionIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    ),
  );
  if (unique.length === 0) return;
  // Session menu review badges derive from /api/sessions. Mirror email-draft
  // publish so open review tags clear as soon as the gate resolves.
  eventBus.publish({
    event: "data:sessions_changed",
    data: {
      reason: "plan_review_resolved",
      sessionIds: unique,
    },
  });
}

const planScopeColumns = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
const planStepScopeColumns = { ownerUserId: planSteps.ownerUserId, accountId: planSteps.accountId };
const planAttemptScopeColumns = { ownerUserId: planStepAttempts.ownerUserId, accountId: planStepAttempts.accountId };
const planReviewScopeColumns = { ownerUserId: planStepReviews.ownerUserId, accountId: planStepReviews.accountId };
const planLinkScopeColumns = { ownerUserId: planSessionLinks.ownerUserId, accountId: planSessionLinks.accountId };

function visiblePlan(predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), planScopeColumns, predicate); }
function writablePlan(predicate?: SQL): SQL { return combineWithWritableScope(requireCurrentPrincipal(), planScopeColumns, predicate); }
function visiblePlanStep(predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), planStepScopeColumns, predicate); }
function writablePlanStep(predicate?: SQL): SQL { return combineWithWritableScope(requireCurrentPrincipal(), planStepScopeColumns, predicate); }
function visiblePlanAttempt(predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), planAttemptScopeColumns, predicate); }
function writablePlanAttempt(predicate?: SQL): SQL { return combineWithWritableScope(requireCurrentPrincipal(), planAttemptScopeColumns, predicate); }
function visiblePlanReview(predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), planReviewScopeColumns, predicate); }
function writablePlanReview(predicate?: SQL): SQL { return combineWithWritableScope(requireCurrentPrincipal(), planReviewScopeColumns, predicate); }
function visiblePlanLink(predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), planLinkScopeColumns, predicate); }
function writablePlanLink(predicate?: SQL): SQL { return combineWithWritableScope(requireCurrentPrincipal(), planLinkScopeColumns, predicate); }

export type PlanStepStatus = PlanStep["status"];
export type AttemptStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "needs_review" | "abandoned";

const VALID_STEP_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["running", "blocked", "needs_review", "completed", "failed", "skipped"],
  running: ["completed", "failed", "blocked", "needs_review"],
  failed: ["pending"],
  blocked: ["pending"],
  // Approve completes, stop blocks, request_changes/retry return to pending.
  needs_review: ["pending", "completed", "blocked"],
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
  const updated = await db.update(planSteps)
    .set({ ...fields, updatedAt: new Date() })
    .where(writablePlanStep(and(
      eq(planSteps.planId, planId),
      eq(planSteps.id, stepId),
      fields.status === "needs_review" ? undefined : sql`${planSteps.status} <> 'needs_review'`,
    )))
    .returning({ id: planSteps.id });
  if (updated.length === 0) {
    throw new Error(`[state] Step ${stepId} has an open review gate or is no longer writable`);
  }
}

export const PLAN_EXECUTION_LEASE_MS = 2 * 60 * 1000;

export async function claimPlanExecution(
  planId: string,
  owner: string,
  leaseMs = PLAN_EXECUTION_LEASE_MS,
  staleOwner?: string | null,
): Promise<{ claimed: true; leaseId: string; expiresAt: Date } | { claimed: false }> {
  const leaseId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const rows = await db.update(planExecutions)
    .set({ executionLeaseId: leaseId, executionLeaseOwner: owner, executionLeaseExpiresAt: expiresAt, executionClaimedAt: now, updatedAt: now })
    .where(writablePlan(and(
      eq(planExecutions.id, planId),
      or(
        isNull(planExecutions.executionLeaseExpiresAt),
        lt(planExecutions.executionLeaseExpiresAt, now),
        staleOwner ? eq(planExecutions.executionLeaseOwner, staleOwner) : undefined,
      ),
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
    ...ownedInsertValues(requireCurrentPrincipal(), planLinkScopeColumns),
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

export async function setPlanSessionPinned(planId: string, sessionId: string, pinned: boolean): Promise<boolean> {
  const principal = requireCurrentPrincipal();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plan-session-pin:${principal.accountId}:${sessionId}`}))`);
    const link = await tx.select({ id: planSessionLinks.id })
      .from(planSessionLinks)
      .where(visiblePlanLink(and(
        eq(planSessionLinks.planId, planId),
        eq(planSessionLinks.sessionId, sessionId),
        isNull(planSessionLinks.unlinkedAt),
      )))
      .then((rows) => rows[0]);
    if (!link) return false;

    const now = new Date();
    if (pinned) {
      await tx.update(planSessionLinks)
        .set({ pinnedAt: null, updatedAt: now })
        .where(writablePlanLink(and(
          eq(planSessionLinks.sessionId, sessionId),
          isNull(planSessionLinks.unlinkedAt),
        )));
    }
    await tx.update(planSessionLinks)
      .set({ pinnedAt: pinned ? now : null, updatedAt: now })
      .where(writablePlanLink(eq(planSessionLinks.id, link.id)));
    return true;
  });
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
    ...ownedInsertValues(requireCurrentPrincipal(), planAttemptScopeColumns),
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

export async function getPlanStepAttemptByChildSession(
  planId: string,
  stepId: string,
  childSessionId: string,
): Promise<PlanStepAttemptRow | null> {
  const rows = await db.select().from(planStepAttempts).where(visiblePlanAttempt(and(
    eq(planStepAttempts.planId, planId),
    eq(planStepAttempts.stepId, stepId),
    eq(planStepAttempts.childSessionId, childSessionId),
  )));
  return rows[0] ?? null;
}

export async function getLatestPlanStepReview(planId: string, stepId: string): Promise<PlanStepReviewRow | null> {
  const rows = await db.select().from(planStepReviews)
    .where(visiblePlanReview(and(eq(planStepReviews.planId, planId), eq(planStepReviews.stepId, stepId))))
    .orderBy(desc(planStepReviews.openedAt), desc(planStepReviews.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOpenPlanStepReview(planId: string, stepId: string): Promise<PlanStepReviewRow | null> {
  const rows = await db.select().from(planStepReviews)
    .where(visiblePlanReview(and(
      eq(planStepReviews.planId, planId),
      eq(planStepReviews.stepId, stepId),
      eq(planStepReviews.status, "open"),
    )))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ensure a needs_review step has a durable open review the UI can submit.
 * Orphaned gates (step needs_review, no open review row) make Submit a silent no-op.
 */
export async function ensureOpenPlanStepReview(params: {
  planId: string;
  stepId: string;
  prompt?: string | null;
  detail?: string | null;
  openedBySessionId?: string | null;
  attemptId?: number | null;
}): Promise<PlanStepReviewRow> {
  const existing = await getOpenPlanStepReview(params.planId, params.stepId);
  if (existing) return existing;

  const now = new Date();
  const prompt = (params.prompt?.trim() || "Review required").slice(0, PLAN_REVIEW_REASON_MAX_LENGTH);
  const detail = params.detail?.trim()
    ? params.detail.trim().slice(0, PLAN_REVIEW_DETAIL_MAX_LENGTH)
    : null;

  const [created] = await db.insert(planStepReviews).values({
    ...ownedInsertValues(requireCurrentPrincipal(), planReviewScopeColumns),
    planId: params.planId,
    stepId: params.stepId,
    attemptId: params.attemptId ?? null,
    status: "open",
    prompt,
    detail,
    openedBySessionId: params.openedBySessionId ?? null,
    openedAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();

  if (!created) {
    const raced = await getOpenPlanStepReview(params.planId, params.stepId);
    if (raced) return raced;
    throw new Error(`Failed to open plan review for ${params.planId}/${params.stepId}`);
  }

  log.warn(
    `[${params.planId}] Healed orphaned needs_review gate on step ${params.stepId} by opening review ${created.id}`,
  );
  return created;
}

export async function reportPlanStepNeedsReview(params: {
  planId: string;
  stepId: string;
  childSessionId: string;
  prompt: string;
  detail?: string | null;
  outcome?: string | null;
}): Promise<PlanStepReviewRow> {
  const principal = requireCurrentPrincipal();
  if (!principal.userId || !principal.accountId || principal.actorType !== "user") {
    throw new Error("Plan review gates require the owning user principal");
  }
  const prompt = params.prompt.trim().slice(0, PLAN_REVIEW_REASON_MAX_LENGTH);
  if (!prompt) throw new Error("Review prompt is required");
  const detail = params.detail?.trim().slice(0, PLAN_REVIEW_DETAIL_MAX_LENGTH) || null;

  return db.transaction(async (tx) => {
    const [plan] = await tx.select().from(planExecutions)
      .where(visiblePlan(eq(planExecutions.id, params.planId)))
      .limit(1)
      .for("update");
    if (!plan || plan.status !== "executing") {
      throw new Error(`Plan ${params.planId} is no longer executing`);
    }

    const [step] = await tx.select().from(planSteps)
      .where(visiblePlanStep(and(
        eq(planSteps.planId, params.planId),
        eq(planSteps.id, params.stepId),
      )))
      .limit(1)
      .for("update");
    if (!step) throw new Error(`Plan step not found: ${params.stepId}`);
    if (step.status !== "running" || step.sessionId !== params.childSessionId) {
      throw new Error(`Step ${params.stepId} is no longer owned by child ${params.childSessionId}`);
    }

    const [attempt] = await tx.select().from(planStepAttempts)
      .where(visiblePlanAttempt(and(
        eq(planStepAttempts.planId, params.planId),
        eq(planStepAttempts.stepId, params.stepId),
        eq(planStepAttempts.childSessionId, params.childSessionId),
      )))
      .orderBy(desc(planStepAttempts.attemptNumber))
      .limit(1)
      .for("update");
    if (!attempt || attempt.status !== "running") {
      throw new Error(`Active Plan attempt not found for child ${params.childSessionId}`);
    }

    const now = new Date();
    const outcome = params.outcome?.trim().slice(0, PLAN_REVIEW_REASON_MAX_LENGTH) || prompt;
    const stepUpdated = await tx.update(planSteps).set({
      status: "needs_review",
      outcome,
      error: null,
      durationSeconds: step.startedAt
        ? Math.max(0, Math.round((now.getTime() - step.startedAt.getTime()) / 1_000))
        : step.durationSeconds,
      completedAt: now,
      updatedAt: now,
    }).where(writablePlanStep(and(
      eq(planSteps.planId, params.planId),
      eq(planSteps.id, params.stepId),
      eq(planSteps.status, "running"),
      eq(planSteps.sessionId, params.childSessionId),
    ))).returning({ id: planSteps.id });
    if (stepUpdated.length === 0) throw new Error(`Step ${params.stepId} lost active ownership before review opened`);

    const attemptUpdated = await tx.update(planStepAttempts).set({
      status: "needs_review",
      outcome,
      error: null,
      durationSeconds: step.startedAt
        ? Math.max(0, Math.round((now.getTime() - step.startedAt.getTime()) / 1_000))
        : step.durationSeconds,
      completedAt: now,
      updatedAt: now,
    }).where(writablePlanAttempt(and(
      eq(planStepAttempts.id, attempt.id),
      eq(planStepAttempts.planId, params.planId),
      eq(planStepAttempts.stepId, params.stepId),
      eq(planStepAttempts.status, "running"),
      eq(planStepAttempts.childSessionId, params.childSessionId),
    ))).returning({ id: planStepAttempts.id });
    if (attemptUpdated.length === 0) throw new Error(`Attempt ${attempt.id} lost active ownership before review opened`);

    const [inserted] = await tx.insert(planStepReviews).values({
      ...ownedInsertValues(requireCurrentPrincipal(), planReviewScopeColumns),
      planId: params.planId,
      stepId: params.stepId,
      attemptId: attempt.id,
      status: "open",
      prompt,
      detail,
      openedBySessionId: params.childSessionId,
      openedAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();

    let review = inserted;
    if (!review) {
      const [existing] = await tx.select().from(planStepReviews).where(visiblePlanReview(and(
        eq(planStepReviews.planId, params.planId),
        eq(planStepReviews.stepId, params.stepId),
        eq(planStepReviews.status, "open"),
      ))).limit(1);
      if (!existing) throw new Error(`Open review could not be created for step ${params.stepId}`);
      review = existing;
    }

    const planUpdated = await tx.update(planExecutions).set({
      status: "needs_review",
      updatedAt: now,
    }).where(writablePlan(and(
      eq(planExecutions.id, params.planId),
      eq(planExecutions.status, "executing"),
    ))).returning({ id: planExecutions.id });
    if (planUpdated.length === 0) throw new Error(`Plan ${params.planId} could not enter review state`);

    return review;
  });
}

export interface ResolvePlanStepReviewResult {
  planId: string;
  stepId: string;
  decision: PlanReviewDecision;
  planStatus: PlanStatus;
  shouldExecute: boolean;
  originSessionId?: string | null;
  openedBySessionId?: string | null;
  resolvedBySessionId?: string | null;
  stepSessionId?: string | null;
}

export async function resolvePlanStepReview(params: {
  planId: string;
  stepId: string;
  reviewId: number;
  decision: PlanReviewDecision;
  reason?: string | null;
  source: "ui" | "later_human_turn";
  resolvedBySessionId?: string | null;
}): Promise<ResolvePlanStepReviewResult> {
  const principal = requireCurrentPrincipal();
  if (!principal.userId || !principal.accountId || principal.actorType !== "user") {
    throw new Error("Plan review requires an authenticated human principal");
  }
  const reason = params.reason?.trim().slice(0, PLAN_REVIEW_REASON_MAX_LENGTH) || null;
  if (params.decision === "request_changes" && !reason) {
    throw new Error("Request changes requires a reason");
  }

  const result = await db.transaction(async (tx) => {
    const [plan] = await tx.select().from(planExecutions)
      .where(visiblePlan(and(
        eq(planExecutions.id, params.planId),
        eq(planExecutions.status, "needs_review"),
      )))
      .limit(1)
      .for("update");
    if (!plan) throw new Error("Plan is no longer awaiting this review decision");

    const [review] = await tx.select().from(planStepReviews)
      .where(visiblePlanReview(and(
        eq(planStepReviews.id, params.reviewId),
        eq(planStepReviews.planId, params.planId),
        eq(planStepReviews.stepId, params.stepId),
      )))
      .limit(1)
      .for("update");
    if (!review) throw new Error("Plan review not found");
    if (review.status !== "open") throw new Error("Plan review has already been resolved");

    const [step] = await tx.select().from(planSteps)
      .where(visiblePlanStep(and(
        eq(planSteps.planId, params.planId),
        eq(planSteps.id, params.stepId),
      )))
      .limit(1)
      .for("update");
    if (!step || step.status !== "needs_review") {
      throw new Error(`Plan step is not awaiting review`);
    }

    const now = new Date();
    const reviewUpdated = await tx.update(planStepReviews).set({
      status: "resolved",
      decision: params.decision,
      decisionReason: reason,
      resolvedByUserId: principal.userId,
      resolvedBySessionId: params.resolvedBySessionId ?? null,
      resolutionSource: params.source,
      resolvedAt: now,
      updatedAt: now,
    }).where(writablePlanReview(and(eq(planStepReviews.id, review.id), eq(planStepReviews.status, "open"))))
      .returning({ id: planStepReviews.id });
    if (reviewUpdated.length === 0) throw new Error("Plan review resolution lost ownership");

    if (review.attemptId) {
      const attemptUpdated = await tx.update(planStepAttempts).set({
        status: params.decision === "approve" ? "completed" : params.decision === "stop" ? "blocked" : "failed",
        error: params.decision === "approve" ? null : reason,
        completedAt: now,
        updatedAt: now,
      }).where(writablePlanAttempt(and(
        eq(planStepAttempts.id, review.attemptId),
        eq(planStepAttempts.planId, params.planId),
        eq(planStepAttempts.stepId, params.stepId),
        eq(planStepAttempts.status, "needs_review"),
      ))).returning({ id: planStepAttempts.id });
      if (attemptUpdated.length === 0) throw new Error("Plan review attempt is no longer awaiting this decision");
    }

    const nextStepStatus = params.decision === "approve"
      ? "completed"
      : params.decision === "stop"
        ? "blocked"
        : "pending";
    // Keep the transition table authoritative even though this path updates
    // directly; reject illegal target statuses before write.
    assertPlanStepTransition(params.stepId, step.status, nextStepStatus, "resolvePlanStepReview");
    const stepPatch: Partial<typeof planSteps.$inferInsert> = {
      status: nextStepStatus,
      error: params.decision === "approve" ? null : reason,
      updatedAt: now,
    };
    if (nextStepStatus === "completed" || nextStepStatus === "blocked") {
      stepPatch.completedAt = now;
    }
    if (nextStepStatus === "pending") {
      stepPatch.sessionId = null;
      stepPatch.durationSeconds = null;
      stepPatch.startedAt = null;
      stepPatch.completedAt = null;
    }
    // Gate identity is the open review row + step needs_review status.
    // Do not require step.sessionId === openedBySessionId — that desyncs under
    // recovery/resume and makes Submit fail forever while the card still shows.
    const stepUpdated = await tx.update(planSteps).set(stepPatch).where(writablePlanStep(and(
      eq(planSteps.planId, params.planId),
      eq(planSteps.id, params.stepId),
      eq(planSteps.status, "needs_review"),
    ))).returning({ id: planSteps.id });
    if (stepUpdated.length === 0) throw new Error("Plan review step is no longer awaiting this decision");

    const steps = await tx.select().from(planSteps)
      .where(visiblePlanStep(eq(planSteps.planId, params.planId)))
      .orderBy(planSteps.position);
    const planStatus: PlanStatus = params.decision === "stop"
      ? "aborted"
      : isPlanDone(steps)
        ? "completed"
        : "paused";
    const planUpdated = await tx.update(planExecutions).set({ status: planStatus, updatedAt: now })
      .where(writablePlan(and(
        eq(planExecutions.id, params.planId),
        eq(planExecutions.status, "needs_review"),
      )))
      .returning({ id: planExecutions.id, originSessionId: planExecutions.originSessionId });
    if (planUpdated.length === 0) throw new Error("Plan is no longer awaiting this review decision");

    return {
      planId: params.planId,
      stepId: params.stepId,
      decision: params.decision,
      planStatus,
      shouldExecute: params.decision !== "stop" && planStatus !== "completed",
      originSessionId: planUpdated[0]?.originSessionId ?? plan.originSessionId ?? null,
      openedBySessionId: review.openedBySessionId ?? null,
      resolvedBySessionId: params.resolvedBySessionId ?? null,
      stepSessionId: step.sessionId ?? null,
    };
  });

  await renderPlanProjection(result.planId).catch((error) => {
    log.warn(
      `[${result.planId}] Review decision committed but Plan projection refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  publishPlanReviewSessionsChanged([
    result.originSessionId,
    result.openedBySessionId,
    result.resolvedBySessionId,
    result.stepSessionId,
  ]);
  return result;
}

export type CompletePlanStepAttemptOutcome =
  | { outcome: "transitioned" }
  | { outcome: "reconciled_existing" };

export type FailInterruptedPlanStepOutcome =
  | { outcome: "transitioned" }
  | { outcome: "already_terminal" };

export async function failInterruptedPlanStep(params: {
  planId: string;
  stepId: string;
  attemptNumber: number | null;
  childSessionId: string | null;
  error: string;
  durationSeconds: number | null;
  completedAt: Date;
}): Promise<FailInterruptedPlanStepOutcome> {
  return db.transaction(async (tx) => {
    const transitioned = await tx.update(planSteps)
      .set({
        status: "failed",
        error: params.error,
        durationSeconds: params.durationSeconds,
        completedAt: params.completedAt,
        updatedAt: params.completedAt,
      })
      .where(writablePlanStep(and(
        eq(planSteps.planId, params.planId),
        eq(planSteps.id, params.stepId),
        eq(planSteps.status, "running"),
        params.childSessionId
          ? eq(planSteps.sessionId, params.childSessionId)
          : isNull(planSteps.sessionId),
      )))
      .returning({ id: planSteps.id });

    if (transitioned.length === 0) {
      const current = await tx.select({ status: planSteps.status })
        .from(planSteps)
        .where(visiblePlanStep(and(eq(planSteps.planId, params.planId), eq(planSteps.id, params.stepId))))
        .then(rows => rows[0]);
      if (!current || current.status === "running") {
        throw new Error(`[state] Interrupted step ${params.stepId} lost recovery ownership`);
      }
      return { outcome: "already_terminal" };
    }

    if (params.attemptNumber !== null) {
      const attemptRows = await tx.update(planStepAttempts)
        .set({
          status: "abandoned",
          error: params.error,
          durationSeconds: params.durationSeconds,
          completedAt: params.completedAt,
          updatedAt: params.completedAt,
        })
        .where(writablePlanAttempt(and(
          eq(planStepAttempts.planId, params.planId),
          eq(planStepAttempts.stepId, params.stepId),
          eq(planStepAttempts.attemptNumber, params.attemptNumber),
          eq(planStepAttempts.status, "running"),
          params.childSessionId
            ? eq(planStepAttempts.childSessionId, params.childSessionId)
            : isNull(planStepAttempts.childSessionId),
        )))
        .returning({ id: planStepAttempts.id });
      if (attemptRows.length === 0) {
        throw new Error(`[state] Interrupted attempt ${params.attemptNumber} for step ${params.stepId} lost recovery ownership`);
      }
    }

    return { outcome: "transitioned" };
  });
}

export async function completePlanStepAttempt(params: {
  planId: string;
  stepId: string;
  attemptNumber: number;
  childSessionId: string;
  outcome: string;
  durationSeconds: number;
  completedAt: Date;
}): Promise<CompletePlanStepAttemptOutcome> {
  return db.transaction(async (tx) => {
    const stepPatch = {
      status: "completed",
      sessionId: params.childSessionId,
      outcome: params.outcome,
      error: null,
      durationSeconds: params.durationSeconds,
      completedAt: params.completedAt,
      updatedAt: params.completedAt,
    } as const;

    const transitioned = await tx.update(planSteps)
      .set(stepPatch)
      .where(writablePlanStep(and(
        eq(planSteps.planId, params.planId),
        eq(planSteps.id, params.stepId),
        eq(planSteps.status, "running"),
        eq(planSteps.sessionId, params.childSessionId),
      )))
      .returning({ id: planSteps.id });

    let result: CompletePlanStepAttemptOutcome = { outcome: "transitioned" };
    if (transitioned.length === 0) {
      const current = await tx.select({ status: planSteps.status, sessionId: planSteps.sessionId })
        .from(planSteps)
        .where(visiblePlanStep(and(eq(planSteps.planId, params.planId), eq(planSteps.id, params.stepId))))
        .then(rows => rows[0]);
      if (!current || current.status !== "completed" || current.sessionId !== params.childSessionId) {
        throw new Error(
          `[state] Step ${params.stepId} completion conflicted with status=${current?.status ?? "missing"} ` +
          `session=${current?.sessionId ?? "none"}; expected running/completed owned by ${params.childSessionId}`,
        );
      }
      await tx.update(planSteps)
        .set(stepPatch)
        .where(writablePlanStep(and(
          eq(planSteps.planId, params.planId),
          eq(planSteps.id, params.stepId),
          eq(planSteps.status, "completed"),
          eq(planSteps.sessionId, params.childSessionId),
        )));
      result = { outcome: "reconciled_existing" };
    }

    const attemptPatch: Partial<typeof planStepAttempts.$inferInsert> = {
      status: "completed",
      childSessionId: params.childSessionId,
      outcome: params.outcome,
      error: null,
      durationSeconds: params.durationSeconds,
      completedAt: params.completedAt,
      updatedAt: params.completedAt,
    };
    const attemptRows = await tx.update(planStepAttempts)
      .set(attemptPatch)
      .where(writablePlanAttempt(and(
        eq(planStepAttempts.planId, params.planId),
        eq(planStepAttempts.stepId, params.stepId),
        eq(planStepAttempts.attemptNumber, params.attemptNumber),
        eq(planStepAttempts.childSessionId, params.childSessionId),
      )))
      .returning({ id: planStepAttempts.id });
    if (attemptRows.length === 0) {
      throw new Error(
        `[state] Attempt ${params.attemptNumber} for step ${params.stepId} is not owned by child ${params.childSessionId}`,
      );
    }

    return result;
  });
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
      persona: s.persona as PlanStepPersona | undefined,
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
    const principal = requireCurrentPrincipal();
    await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
      const [page] = await tx.update(libraryPages).set({
        content: synced.content,
        plainTextContent: synced.plainTextContent,
        updatedAt: new Date(),
      }).where(combineWithWritableScope(principal, libraryScope, eq(libraryPages.id, plan.pageId))).returning();
      if (!page) return;
      const { indexLibraryPageReferences } = await import("./library-reference-index");
      await indexLibraryPageReferences(principal, page);
    }));
  } catch (err) {
    log.warn(`Failed to render plan ${planId} projection: ${err instanceof Error ? err.message : String(err)}`);
  }
}
