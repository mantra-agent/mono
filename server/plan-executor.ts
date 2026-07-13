/**
 * Plan Executor — server-side loop that executes plan steps sequentially,
 * spawning one child session per step and checkpointing progress to the
 * database after each step. The Library page is updated as a best-effort
 * rendered view but is never read for execution decisions.
 *
 * Structural invariants:
 * - Step state transitions are validated (see assertStepTransition)
 * - MonitorResult is a discriminated union on `status`
 * - All fallible operations inside the retry loop live inside try/catch
 * - Each function has a single responsibility
 */
import { db } from "./db";
import { eq, and, type SQL } from "drizzle-orm";
import { planExecutions, planSteps } from "@shared/schema";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope } from "./scoped-storage";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import {
  buildStepBrief,
  buildPlanPageContent,
  isStepResolved,
  isPlanDone,
  type PlanMeta,
  type PlanStep,
  type PlanStatus,
} from "./lib/plan-utils";
import {
  monitorChildSession,
  readFinalAssistantOutput,
  readChildFailureMessage,
  truncateOutput,
} from "./child-session-monitor";

const log = createLogger("PlanExecutor");

const planScopeColumns = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
const planStepScopeColumns = { ownerUserId: planSteps.ownerUserId, accountId: planSteps.accountId };
function visiblePlan(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }
function writablePlan(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }
function visiblePlanStep(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planStepScopeColumns, predicate); }
function writablePlanStep(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planStepScopeColumns, predicate); }


// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
const MAX_STEP_RETRIES = 3;

function createExecutionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Active plan tracking ────────────────────────────────────────────

const activePlans = new Map<string, { abortController: AbortController; pageId: string }>();

export function isExecuting(planId: string): boolean {
  return activePlans.has(planId);
}

export function getActivePlanIds(): string[] {
  return [...activePlans.keys()];
}

// ─── Step state machine (Violation #7) ───────────────────────────────

/** Valid step state transitions. Any transition not in this map is a bug. */
const VALID_STEP_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["running", "blocked", "needs_review"],
  running: ["completed", "failed", "blocked", "needs_review"],
  failed: ["pending"],   // only via resumePlan
  blocked: ["pending"],  // after external dependency is resolved
  needs_review: ["pending"], // after Ray review/response is supplied
  completed: [],         // terminal
  skipped: [],           // terminal
} as const;

function assertStepTransition(
  stepId: string,
  from: string,
  to: string,
  context: string,
): void {
  const allowed = VALID_STEP_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(
      `[state] Invalid step transition ${from} → ${to} for step ${stepId} (${context})`,
    );
  }
}

// MonitorResult + FailureReason are imported from child-session-monitor.ts

// ─── DB helpers ──────────────────────────────────────────────────────

async function getPlanFromDb(planId: string) {
  const rows = await db.select().from(planExecutions).where(visiblePlan(eq(planExecutions.id, planId)));
  if (rows[0]) return rows[0];
  const byPage = await db.select().from(planExecutions).where(visiblePlan(eq(planExecutions.pageId, planId)));
  return byPage[0] ?? null;
}

async function getStepsFromDb(planId: string) {
  return db.select().from(planSteps)
    .where(visiblePlanStep(eq(planSteps.planId, planId)))
    .orderBy(planSteps.position);
}

async function updatePlanStatus(planId: string, status: string) {
  await db.update(planExecutions)
    .set({ status, updatedAt: new Date() })
    .where(writablePlan(eq(planExecutions.id, planId)));
}

async function updateStepInDb(planId: string, stepId: string, fields: Partial<{
  status: string;
  sessionId: string | null;
  outcome: string | null;
  error: string | null;
  durationSeconds: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  totalAttempts: number;
}>) {
  await db.update(planSteps)
    .set({ ...fields, updatedAt: new Date() })
    .where(writablePlanStep(and(eq(planSteps.planId, planId), eq(planSteps.id, stepId))));
}

/**
 * Transition a step's status with validation.
 * Wraps updateStepInDb with state machine enforcement.
 */
async function transitionStep(
  planId: string,
  stepId: string,
  currentStatus: string,
  newStatus: string,
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
  assertStepTransition(stepId, currentStatus, newStatus, context);
  await updateStepInDb(planId, stepId, { ...fields, status: newStatus });
}

// ─── Library page rendering (best-effort side effect) ────────────────

async function renderPlanToLibraryPage(planId: string): Promise<void> {
  try {
    const plan = await getPlanFromDb(planId);
    if (!plan) return;
    const steps = await getStepsFromDb(planId);

    const meta: PlanMeta = {
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

    const stepInstructions = steps.map(s => ({
      title: s.title,
      instructions: s.instructions || `Execute step: ${s.title}`,
    }));

    const content = buildPlanPageContent(meta, stepInstructions);
    await updateLibraryPageContent(plan.pageId, content);
  } catch (err) {
    log.warn(`Failed to render plan ${planId} to Library page: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function updateLibraryPageContent(pageId: string, content: string) {
  const { libraryPages } = await import("@shared/models/info");
  const { syncContentFields } = await import("@shared/markdown-tiptap");
  const synced = syncContentFields({ markdown: content });
  await db.update(libraryPages).set({
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    updatedAt: new Date(),
  }).where(eq(libraryPages.id, pageId));
}

// ─── WebSocket event helpers ─────────────────────────────────────────

function publishPlanEvent(event: string, payload: Record<string, unknown>) {
  eventBus.publish({ category: "agent", event, payload });
}

// ─── Core execution loop ─────────────────────────────────────────────

export interface PlanExecutionResult {
  planId: string;
  status: PlanStatus;
  completedSteps: number;
  totalSteps: number;
  totalDuration: number;
  error?: string;
}

export type PlanResumeReadiness =
  | { ready: true; planId: string; status: "paused"; recovered: boolean; totalSteps: number }
  | { ready: false; planId: string; status: PlanStatus; recovered: boolean; totalSteps: number; error: string };

/**
 * Execute a plan from its current state. Resumes from the next pending step.
 * Reads and writes all state from the DB. Library page is updated as a side effect.
 *
 * (Violation #2 fix: decomposed into orchestrator + executeStep)
 */
export async function executePlan(
  planId: string,
  originSessionId: string,
  planTitle: string,
  blocking: boolean = true,
): Promise<PlanExecutionResult> {
  const plan = await getPlanFromDb(planId);
  if (!plan) {
    return { planId, status: "failed", completedSteps: 0, totalSteps: 0, totalDuration: 0, error: "Plan not found in DB" };
  }

  // Normalize planId to the internal DB ID (caller may have passed a page UUID)
  planId = plan.id;

  if (activePlans.has(planId)) {
    const steps = await getStepsFromDb(planId);
    return { planId, status: plan.status as PlanStatus, completedSteps: 0, totalSteps: steps.length, totalDuration: 0, error: "Plan is already executing" };
  }

  const abortController = new AbortController();
  activePlans.set(planId, { abortController, pageId: plan.pageId });

  let steps = await getStepsFromDb(planId);
  const executionId = createExecutionId();
  log.log(`[${planId}] Starting execution ${executionId} — ${steps.length} steps, blocking=${blocking}`);

  await updatePlanStatus(planId, "executing");
  await renderPlanToLibraryPage(planId);

  publishPlanEvent("plan.started", { planId, pageId: plan.pageId, title: planTitle, stepCount: steps.length });

  const priorOutcomes: Array<{ title: string; outcome: string }> = [];
  let totalDuration = 0;
  let completedCount = 0;

  // Collect prior outcomes from already-resolved steps
  for (const step of steps) {
    if (isStepResolved(step)) {
      if (step.outcome) {
        priorOutcomes.push({ title: step.title, outcome: step.outcome });
      }
      completedCount++;
      totalDuration += step.durationSeconds || 0;
    }
  }

  const { agentExecutor } = await import("./agent-executor");
  // Disable the hard cap for the parent run — plan execution legitimately runs
  // for hours while children do the work. The idle threshold + child heartbeats
  // still catch genuinely stuck plans.
  agentExecutor.setRunHardCap(originSessionId, 0);

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Gate: stop execution at review/block boundaries
      if (step.status === "needs_review" || step.status === "blocked") {
        log.log(`[${planId}] Step ${i + 1} is ${step.status} — pausing execution for review`);
        await updatePlanStatus(planId, "paused");
        await renderPlanToLibraryPage(planId);
        await notifyOriginSession(originSessionId, planId, planTitle, step, step.status);
        publishPlanEvent("plan.paused", { planId, stepId: step.id, reason: step.status });
        break;
      }

      if (step.status !== "pending") continue;

      if (abortController.signal.aborted) {
        log.log(`[${planId}] Execution aborted at step ${i + 1}`);
        await updatePlanStatus(planId, "paused");
        await renderPlanToLibraryPage(planId);
        publishPlanEvent("plan.paused", { planId, stepId: step.id, reason: "user_paused" });
        break;
      }

      // Re-read steps to pick up any dynamic additions
      steps = await getStepsFromDb(planId);
      const currentStep = steps[i];

      // Gate after re-read: check if step was changed to review/block while we were executing prior steps
      if (currentStep && (currentStep.status === "needs_review" || currentStep.status === "blocked")) {
        log.log(`[${planId}] Step ${i + 1} is ${currentStep.status} (detected after re-read) — pausing execution for review`);
        await updatePlanStatus(planId, "paused");
        await renderPlanToLibraryPage(planId);
        await notifyOriginSession(originSessionId, planId, planTitle, currentStep, currentStep.status);
        publishPlanEvent("plan.paused", { planId, stepId: currentStep.id, reason: currentStep.status });
        break;
      }

      if (!currentStep || currentStep.status !== "pending") continue;

      const stepResult = await executeStep({
        planId,
        plan,
        step: currentStep,
        stepIndex: i,
        totalSteps: steps.length,
        planTitle,
        originSessionId,
        executionId,
        abortSignal: abortController.signal,
        priorOutcomes,
      });

      // Keep the parent run's zombie idle timer fresh between steps.
      agentExecutor.heartbeatRunBySessionId(originSessionId);

      if (stepResult.status === "completed") {
        completedCount++;
        totalDuration += stepResult.duration;
        priorOutcomes.push({ title: currentStep.title, outcome: stepResult.outcome });
        const nextPendingStep = steps.slice(i + 1).find((candidate) => candidate.status === "pending");
        if (nextPendingStep) {
          const progressLines = steps.map((st, idx) => {
            const icon = idx <= i ? "✅" : idx === nextPendingStep.position ? "▶️" : "⬜";
            return `- ${icon} Step ${idx + 1}: ${st.title}`;
          }).join("\n");
          const outcomeText = stepResult.outcome ? `${stepResult.outcome.replace(/\n+$/, "")} ` : "";
          await notifyPlanProgress(
            originSessionId,
            planId,
            `${outcomeText}Step ${i + 1} complete. Moving on to Step ${nextPendingStep.position + 1}.\n\n${progressLines}`,
          );
        }
      } else if (stepResult.status === "halted") {
        totalDuration += stepResult.duration;
        await updatePlanStatus(planId, "paused");
        await renderPlanToLibraryPage(planId);
        await notifyOriginSession(originSessionId, planId, planTitle, currentStep, stepResult.stepStatus);
        publishPlanEvent("plan.paused", { planId, stepId: currentStep.id, reason: stepResult.stepStatus });
        activePlans.delete(planId);
        return {
          planId, status: "paused", completedSteps: completedCount,
          totalSteps: steps.length, totalDuration,
        };
      } else {
        // Step exhausted retries — plan is paused
        totalDuration += stepResult.duration;
        await notifyOriginSession(originSessionId, planId, planTitle, currentStep, "failed");
        activePlans.delete(planId);
        return {
          planId, status: "paused", completedSteps: completedCount,
          totalSteps: steps.length, totalDuration,
          error: stepResult.error,
        };
      }
    }

    // Check if all steps are done
    const finalSteps = await getStepsFromDb(planId);
    if (isPlanDone(finalSteps)) {
      const anyFailed = finalSteps.some(s => s.status === "failed");
      const finalStatus = anyFailed ? "completed_with_failures" : "completed";
      await updatePlanStatus(planId, finalStatus);
      await renderPlanToLibraryPage(planId);

      publishPlanEvent("plan.completed", {
        planId, title: planTitle, totalDuration,
        stepCount: finalSteps.length, completedSteps: completedCount,
      });
      log.log(`[${planId}] Plan ${finalStatus} — ${completedCount}/${finalSteps.length} steps in ${totalDuration}s`);

      const durationStr = totalDuration < 60
        ? `${Math.round(totalDuration)}s`
        : `${Math.floor(totalDuration / 60)}m ${Math.round(totalDuration % 60)}s`;
      const stepSummaryLines = finalSteps.map((st, i) => {
        const icon = st.status === "completed" ? "✅" : st.status === "failed" ? "❌" : st.status === "skipped" ? "⏭️" : "⬜";
        return `- ${icon} Step ${i + 1}: ${st.title}`;
      }).join("\n");
      const completionMsg = anyFailed
        ? `⚠️ Plan **${planTitle}** finished with failures — ${completedCount}/${finalSteps.length} steps passed in ${durationStr}.\n\n${stepSummaryLines}`
        : `✅ Plan **${planTitle}** completed — ${completedCount}/${finalSteps.length} steps in ${durationStr}.\n\n${stepSummaryLines}`;
      await notifyPlanProgress(originSessionId, planId, completionMsg);

      activePlans.delete(planId);
      return {
        planId, status: finalStatus as PlanStatus,
        completedSteps: completedCount, totalSteps: finalSteps.length, totalDuration,
      };
    }

    activePlans.delete(planId);
    const currentPlan = await getPlanFromDb(planId);
    return {
      planId, status: (currentPlan?.status || "paused") as PlanStatus,
      completedSteps: completedCount, totalSteps: finalSteps.length, totalDuration,
    };
  } catch (err) {
    log.error(`[${planId}] Executor crashed: ${err instanceof Error ? err.message : String(err)}`);
    try { await updatePlanStatus(planId, "failed"); } catch { /* best effort */ }
    try { await renderPlanToLibraryPage(planId); } catch { /* best effort */ }
    activePlans.delete(planId);
    const allSteps = await getStepsFromDb(planId).catch(() => []);
    return {
      planId, status: "failed", completedSteps: completedCount,
      totalSteps: allSteps.length, totalDuration,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Single step execution with retries (Violation #2 fix) ───────────

interface ExecuteStepInput {
  planId: string;
  plan: { workspaceDir: string | null };
  step: { id: string; title: string; status: string; instructions: string | null; timeoutMinutes: number | null; totalAttempts: number | null };
  stepIndex: number;
  totalSteps: number;
  planTitle: string;
  originSessionId: string;
  executionId: string;
  abortSignal: AbortSignal;
  priorOutcomes: Array<{ title: string; outcome: string }>;
}

type ExecuteStepResult =
  | { status: "completed"; duration: number; outcome: string }
  | { status: "halted"; duration: number; stepStatus: "blocked" | "needs_review"; outcome?: string }
  | { status: "failed"; duration: number; error: string };

/**
 * Execute a single step with retry logic. All DB writes and fallible
 * operations are inside the try/catch. (Violation #1 fix)
 */
async function executeStep(input: ExecuteStepInput): Promise<ExecuteStepResult> {
  const { planId, plan, step, stepIndex, totalSteps, planTitle, originSessionId, executionId, abortSignal, priorOutcomes } = input;
  const stepInstructions = step.instructions || `Execute step: ${step.title}`;
  const maxRetries = MAX_STEP_RETRIES;
  let attemptCount = step.totalAttempts ?? 0;
  let lastDuration = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check abort signal before each attempt (not just between steps)
    if (abortSignal?.aborted) {
      log.log(`[${planId}] Step ${stepIndex + 1} abort detected before attempt ${attempt} — stopping retries`);
      return await failStepFinal(planId, step, stepIndex, lastDuration, null,
        "Plan execution was aborted", attemptCount);
    }

    attemptCount++;
    const stepStart = Date.now();

    try {
      log.log(`[${planId}] Step ${stepIndex + 1}/${totalSteps}: ${step.title} (attempt ${attempt}/${maxRetries})`);

      const brief = buildStepBrief(
        planTitle, { id: step.id, title: step.title, status: "running" },
        stepIndex, totalSteps, stepInstructions, priorOutcomes, plan.workspaceDir ?? undefined,
      );

      const idleTimeoutMs = (step.timeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60 * 1000;

      const { spawnChildSession } = await import("./sessions/tree");

      const spawnResult = spawnChildSession(originSessionId, {
        spawnReason: `plan:${planId}:run-${executionId}:${step.id}:attempt-${attemptCount}`,
        spawnerTool: "plan-executor",
        spawnerSkillRun: `plan:${planId}`,
        preContext: brief,
        waitForCompletion: false,
        titleOverride: `Step ${stepIndex + 1}: ${step.title}`,
        admissionTier: "realtime",
        lineageId: originSessionId,
      });

      const { sessionId: childSessionId } = await spawnResult;
      log.log(`[${planId}] Step ${stepIndex + 1} spawned session ${childSessionId}`);

      // A step is not "running" until its child session exists and is persisted.
      // This prevents Resume from seeing a running-with-no-child wedge if spawn fails.
      await transitionStep(
        planId, step.id, "pending", "running",
        { startedAt: new Date(), totalAttempts: attemptCount, error: null, sessionId: childSessionId },
        `attempt ${attempt}/${maxRetries} child persisted`,
      );
      await renderPlanToLibraryPage(planId);

      if (attempt === 1) {
        publishPlanEvent("plan.step.started", {
          planId, stepId: step.id, stepTitle: step.title,
          stepIndex, totalSteps, sessionId: childSessionId,
        });
      }

      // ── Monitor child session ──
      const result = await monitorChildSession(childSessionId, idleTimeoutMs, abortSignal, originSessionId);
      lastDuration = Math.round((Date.now() - stepStart) / 1000);

      // ── Handle result by discriminant (Violation #3 fix) ──
      switch (result.status) {
        case "completed": {
          const persistedStep = (await getStepsFromDb(planId)).find((candidate) => candidate.id === step.id);
          if (persistedStep?.status === "blocked" || persistedStep?.status === "needs_review") {
            log.log(`[${planId}] Step ${stepIndex + 1} ended with externally reported ${persistedStep.status}`);
            await renderPlanToLibraryPage(planId);
            return {
              status: "halted",
              duration: lastDuration,
              stepStatus: persistedStep.status,
              outcome: persistedStep.outcome ?? undefined,
            };
          }

          const outcome = truncateOutcome(result.output || "Completed successfully");
          await transitionStep(
            planId, step.id, "running", "completed",
            { completedAt: new Date(), durationSeconds: lastDuration, sessionId: childSessionId, outcome },
            "monitor returned completed",
          );
          await renderPlanToLibraryPage(planId);

          publishPlanEvent("plan.step.completed", {
            planId, stepId: step.id, stepTitle: step.title,
            stepIndex, outcome, duration: lastDuration, sessionId: childSessionId,
          });
          log.log(`[${planId}] Step ${stepIndex + 1} completed in ${lastDuration}s (attempt ${attempt})`);
          return { status: "completed", duration: lastDuration, outcome };
        }

        case "idle_timeout": {
          // Distinct log for idle timeout (Violation #5 fix)
          const errorMsg = `${result.message}. This was not user-cancelled.`;
          log.warn(`[${planId}] Step ${stepIndex + 1} idle_timeout: ${errorMsg}`);

          if (attempt < maxRetries) {
            log.warn(`[${planId}] Step ${stepIndex + 1} retrying after idle_timeout (attempt ${attempt}/${maxRetries})`);
            // Reset step to pending for retry, but first close the abandoned child
            // session so the retry attempt cannot leave an active duplicate.
            await closeAbandonedChildSessionBlock(originSessionId, childSessionId, errorMsg, lastDuration);
            await transitionStep(planId, step.id, "running", "failed",
              { error: errorMsg, completedAt: new Date(), durationSeconds: lastDuration, sessionId: childSessionId },
              "idle_timeout retry reset",
            );
            await transitionStep(planId, step.id, "failed", "pending",
              { error: null, sessionId: null, durationSeconds: null, startedAt: null, completedAt: null },
              "retry after idle_timeout",
            );
            publishPlanEvent("plan.step.retrying", {
              planId, stepId: step.id, stepTitle: step.title,
              stepIndex, attempt, maxRetries, error: errorMsg, reason: "idle_timeout",
            });
            await notifyPlanProgress(originSessionId, planId, `Failure on Step ${stepIndex + 1}: ${truncateOutcome(errorMsg, 180)}. Reattempting...`);
            continue;
          }

          return await failStepFinal(planId, step, stepIndex, lastDuration, childSessionId,
            `${errorMsg} (failed after ${maxRetries} attempts)`, attemptCount);
        }

        case "failed": {
          // Distinct log per failure reason (Violation #5 fix)
          log.warn(`[${planId}] Step ${stepIndex + 1} failed [${result.reason}]: ${result.message}`);

          // aborted is non-retryable — user explicitly paused
          if (result.reason === "aborted") {
            return await failStepFinal(planId, step, stepIndex, lastDuration, childSessionId,
              result.message, attemptCount);
          }

          if (attempt < maxRetries) {
            log.warn(`[${planId}] Step ${stepIndex + 1} retrying after ${result.reason} (attempt ${attempt}/${maxRetries})`);
            await closeAbandonedChildSessionBlock(originSessionId, childSessionId, result.message, lastDuration);
            await transitionStep(planId, step.id, "running", "failed",
              { error: result.message, completedAt: new Date(), durationSeconds: lastDuration, sessionId: childSessionId },
              `${result.reason} retry reset`,
            );
            await transitionStep(planId, step.id, "failed", "pending",
              { error: null, sessionId: null, durationSeconds: null, startedAt: null, completedAt: null },
              `retry after ${result.reason}`,
            );
            publishPlanEvent("plan.step.retrying", {
              planId, stepId: step.id, stepTitle: step.title,
              stepIndex, attempt, maxRetries, error: result.message, reason: result.reason,
            });
            await notifyPlanProgress(originSessionId, planId, `Failure on Step ${stepIndex + 1}: ${truncateOutcome(result.message, 180)}. Reattempting...`);
            continue;
          }

          return await failStepFinal(planId, step, stepIndex, lastDuration, childSessionId,
            `${result.message} (failed after ${maxRetries} attempts)`, attemptCount);
        }
      }
    } catch (err) {
      // Spawn or DB error (Violation #1 fix — everything is now inside try/catch)
      lastDuration = Math.round((Date.now() - stepStart) / 1000);
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`[${planId}] Step ${stepIndex + 1} crashed [spawn_or_db_error]: ${errorMsg}`);

      if (attempt < maxRetries) {
        log.warn(`[${planId}] Step ${stepIndex + 1} retrying after crash (attempt ${attempt}/${maxRetries})`);
        // Best-effort: try to reset the step for retry
        try {
          await updateStepInDb(planId, step.id, {
            status: "pending", error: null, sessionId: null,
            durationSeconds: null, startedAt: null, completedAt: null,
          });
        } catch (resetErr) {
          log.error(`[${planId}] Failed to reset step for retry: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`);
        }
        await notifyPlanProgress(originSessionId, planId, `Failure on Step ${stepIndex + 1}: ${truncateOutcome(errorMsg, 180)}. Reattempting...`);
        continue;
      }

      return await failStepFinal(planId, step, stepIndex, lastDuration, null,
        `${errorMsg} (crashed after ${maxRetries} attempts)`, attemptCount);
    }
  }

  // Should never reach here, but safety net
  return { status: "failed", duration: lastDuration, error: `Step "${step.title}" exhausted retries without resolution` };
}

/**
 * Mark a step as permanently failed, pause the plan, and emit events.
 */

async function closeAbandonedChildSessionBlock(
  parentSessionId: string,
  childSessionId: string | null | undefined,
  error: string,
  durationSeconds?: number | null,
): Promise<void> {
  if (!childSessionId) return;

  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    await chatFileStorage.setEndReason(childSessionId, error).catch(() => undefined);
    await chatFileStorage.updateSessionStatus(childSessionId, "failed");
  } catch (err) {
    log.warn(
      `[child-block] Failed to mark abandoned child session ${childSessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parentSessionId) return;

  try {
    const { onChildSessionCompleted } = await import("./sessions/child-block-lifecycle");
    await onChildSessionCompleted(parentSessionId, childSessionId, {
      status: "failed",
      error,
      durationMs: typeof durationSeconds === "number" ? durationSeconds * 1000 : undefined,
    });
  } catch (err) {
    log.warn(
      `[child-block] Failed to close abandoned child block ${childSessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const { updateSpawnStatus } = await import("./sessions/tree");
    await updateSpawnStatus(childSessionId, "failed");
  } catch (err) {
    log.warn(
      `[child-block] Failed to mark abandoned spawn ${childSessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function failStepFinal(
  planId: string,
  step: { id: string; title: string; status: string },
  stepIndex: number,
  duration: number,
  sessionId: string | null,
  error: string,
  attemptCount: number,
): Promise<ExecuteStepResult> {
  await closeAbandonedChildSessionBlock(
    (await getPlanFromDb(planId))?.originSessionId ?? "",
    sessionId,
    error,
    duration,
  );

  // Step may be in running or pending state after a crash — handle both
  try {
    await updateStepInDb(planId, step.id, {
      status: "failed",
      completedAt: new Date(),
      durationSeconds: duration,
      sessionId,
      error,
    });
  } catch (dbErr) {
    log.error(`[${planId}] Failed to mark step as failed in DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
  }

  await updatePlanStatus(planId, "paused");
  await renderPlanToLibraryPage(planId);

  publishPlanEvent("plan.step.failed", {
    planId, stepId: step.id, stepTitle: step.title, stepIndex, error, sessionId, attempts: attemptCount,
  });
  publishPlanEvent("plan.paused", { planId, stepId: step.id, reason: "step_failed", error });
  log.warn(`[${planId}] Step ${stepIndex + 1} failed permanently: ${error}`);

  return { status: "failed", duration, error: `Step "${step.title}" failed: ${error}` };
}

/**
 * Pause an executing plan.
 */
export function pausePlan(planId: string): boolean {
  const active = activePlans.get(planId);
  if (!active) return false;
  active.abortController.abort();
  return true;
}

/**
 * Resume a paused plan by re-entering the execution loop.
 * Uses validated state transitions (Violation #7 fix).
 */
export async function preparePlanForResume(planId: string): Promise<PlanResumeReadiness> {
  const plan = await getPlanFromDb(planId);
  if (!plan) {
    return { ready: false, planId, status: "failed", recovered: false, totalSteps: 0, error: "Plan not found in DB" };
  }

  planId = plan.id;
  let currentStatus = plan.status as PlanStatus;
  let recovered = false;

  if (activePlans.has(planId)) {
    const steps = await getStepsFromDb(planId);
    return {
      ready: false, planId, status: currentStatus, recovered, totalSteps: steps.length,
      error: "Plan is already executing",
    };
  }

  if (currentStatus === "executing") {
    recovered = await recoverInterruptedPlan(planId);
    const refreshed = await getPlanFromDb(planId);
    currentStatus = (refreshed?.status || currentStatus) as PlanStatus;
  }

  const steps = await getStepsFromDb(planId);
  if (currentStatus !== "paused") {
    return {
      ready: false, planId, status: currentStatus, recovered, totalSteps: steps.length,
      error: `Plan status is "${currentStatus}", not paused`,
    };
  }

  // Resume resets only the first non-resolved step that is in a retryable state.
  // Subsequent needs_review/blocked gates are preserved so the executor stops again.
  let firstGateResolved = false;
  for (const step of steps) {
    if (step.status === "failed") {
      await closeAbandonedChildSessionBlock(
        plan.originSessionId,
        step.sessionId,
        step.error || "Reset by resumePlan",
        step.durationSeconds,
      );
      await transitionStep(planId, step.id, "failed", "pending", {
        error: null, sessionId: null, durationSeconds: null,
        startedAt: null, completedAt: null,
      }, "resumePlan reset");
    } else if (step.status === "blocked" || step.status === "needs_review") {
      if (!firstGateResolved) {
        // Resolve only the first gate — the user is approving this one
        await transitionStep(planId, step.id, step.status, "pending", {
          error: null, durationSeconds: null, startedAt: null, completedAt: null,
        }, "resumePlan review/block resolved");
        firstGateResolved = true;
      }
      // Leave subsequent gates intact — executor will stop at them
    } else if (step.status === "running") {
      await closeAbandonedChildSessionBlock(
        plan.originSessionId,
        step.sessionId,
        "Reset by resumePlan",
        step.durationSeconds,
      );
      await transitionStep(planId, step.id, "running", "failed", {
        error: "Reset by resumePlan", completedAt: new Date(),
      }, "resumePlan running→failed");
      await transitionStep(planId, step.id, "failed", "pending", {
        error: null, sessionId: null, durationSeconds: null,
        startedAt: null, completedAt: null,
      }, "resumePlan failed→pending");
    }
  }

  await renderPlanToLibraryPage(planId);
  return { ready: true, planId, status: "paused", recovered, totalSteps: steps.length };
}

/**
 * Resume a paused plan by re-entering the execution loop.
 * Uses validated state transitions and first reconciles stale executing state.
 */
export async function resumePlan(
  planId: string,
  originSessionId: string,
  planTitle: string,
  blocking: boolean = true,
): Promise<PlanExecutionResult> {
  const readiness = await preparePlanForResume(planId);
  if (!readiness.ready) {
    return {
      planId: readiness.planId, status: readiness.status, completedSteps: 0,
      totalSteps: readiness.totalSteps, totalDuration: 0, error: readiness.error,
    };
  }

  return executePlan(readiness.planId, originSessionId, planTitle, blocking);
}

// ─── Crash Recovery ──────────────────────────────────────────────────

async function recoverInterruptedPlan(planId: string): Promise<boolean> {
  const plan = await getPlanFromDb(planId);
  if (!plan || plan.status !== "executing") return false;

  const steps = await getStepsFromDb(plan.id);
  let changed = false;

  for (const step of steps) {
    if (step.status !== "running") continue;

    if (step.sessionId) {
      try {
        const { chatFileStorage } = await import("./chat-file-storage");
        const session = await chatFileStorage.getSession(step.sessionId);
        const sessionStatus = (session as { status?: string } | null)?.status;

        if (sessionStatus === "saved") {
          const output = await readFinalAssistantOutput(step.sessionId);
          const duration = step.startedAt
            ? Math.round((Date.now() - new Date(step.startedAt).getTime()) / 1000)
            : null;
          await updateStepInDb(plan.id, step.id, {
            status: "completed",
            outcome: output?.slice(0, 500) || "Completed (recovered)",
            completedAt: new Date(),
            durationSeconds: duration,
          });
          log.log(`[recovery] Plan ${plan.id} step ${step.id} — recovered as completed`);
        } else {
          const error = "Interrupted while marked executing; child did not resolve";
          await closeAbandonedChildSessionBlock(plan.originSessionId, step.sessionId, error, step.durationSeconds);
          await updateStepInDb(plan.id, step.id, {
            status: "failed",
            error,
            completedAt: new Date(),
          });
        }
      } catch {
        const error = "Interrupted while marked executing; child could not be inspected";
        await closeAbandonedChildSessionBlock(plan.originSessionId, step.sessionId, error, step.durationSeconds);
        await updateStepInDb(plan.id, step.id, {
          status: "failed",
          error,
          completedAt: new Date(),
        });
      }
    } else {
      await updateStepInDb(plan.id, step.id, {
        status: "failed",
        error: "Interrupted while marked running before child session was persisted",
        completedAt: new Date(),
      });
    }
    changed = true;
  }

  const updatedSteps = await getStepsFromDb(plan.id);
  if (isPlanDone(updatedSteps)) {
    const anyFailed = updatedSteps.some(s => s.status === "failed");
    await updatePlanStatus(plan.id, anyFailed ? "completed_with_failures" : "completed");
    log.log(`[recovery] Plan ${plan.id} — ${anyFailed ? "completed_with_failures" : "completed"}`);
  } else {
    await updatePlanStatus(plan.id, "paused");
    log.log(`[recovery] Plan ${plan.id} — paused after interrupted execution`);
  }

  await renderPlanToLibraryPage(plan.id);
  return changed;
}

/**
 * Scan for plans that were executing when the server crashed.
 */
export async function recoverInterruptedPlans(): Promise<number> {
  try {
    const executing = await db.select().from(planExecutions)
      .where(visiblePlan(eq(planExecutions.status, "executing")));

    let recovered = 0;
    for (const plan of executing) {
      if (await recoverInterruptedPlan(plan.id)) {
        recovered++;
      }
    }

    if (recovered > 0) {
      log.log(`[recovery] Recovered ${recovered} interrupted plan(s)`);
    }

    return recovered;
  } catch (err) {
    log.error(`[recovery] Failed to scan for interrupted plans: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

// monitorChildSession, readFinalAssistantOutput, readChildFailureMessage,
// and truncateOutput are imported from ./child-session-monitor

// Plan-local alias for backward compat with call sites using old name
const truncateOutcome = truncateOutput;


async function notifyPlanProgress(
  originSessionId: string,
  planId: string,
  message: string,
): Promise<void> {
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    await chatFileStorage.createMessage(originSessionId, "assistant", message, undefined, undefined, "plan-executor");
    // Notify connected clients so the message appears live
    const { eventBus } = await import("./event-bus");
    eventBus.publish({
      category: "chat",
      event: "data:session_messages_changed",
      payload: { sessionId: originSessionId, source: "plan-progress", planId },
    });
  } catch (err) {
    log.warn(`[${planId}] Failed to write plan progress message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function notifyOriginSession(
  originSessionId: string,
  planId: string,
  planTitle: string,
  step: { title: string; error?: string | null } | null,
  event: "failed" | "crashed" | "completed" | "needs_review" | "blocked",
): Promise<void> {
  try {
    const { chatFileStorage } = await import("./chat-file-storage");

    let msg: string;
    if (event === "completed") {
      msg = `Plan completed: **${planTitle}** — all steps passed.`;
    } else if (event === "needs_review" && step) {
      msg = `⏸️ Plan **${planTitle}** paused at step "${step.title}" — step requires review before execution. Use plan(action: "resume") to approve and continue.`;
    } else if (event === "blocked" && step) {
      msg = `⏸️ Plan **${planTitle}** paused at step "${step.title}" — step is blocked. Resolve the blocker, then use plan(action: "resume") to continue.`;
    } else if (step) {
      msg = `⚠️ Plan **${planTitle}** paused at step "${step.title}": ${step.error || "Unknown error"}. Use plan(action: "resume") to retry, or plan(action: "get") to inspect.`;
    } else {
      return;
    }

    await chatFileStorage.createCrossSessionMessage(
      originSessionId,
      originSessionId,
      msg,
      "parent",
    );
  } catch (err) {
    log.warn(`[${planId}] Failed to notify origin session: ${err instanceof Error ? err.message : String(err)}`);
  }
}
