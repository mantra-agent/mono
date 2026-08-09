/**
 * Plan Tool — MCP tool handler for creating, inspecting, modifying,
 * and executing multi-step plans.
 *
 * All state is read/written via the plan_executions and plan_steps DB tables.
 * Library pages are created on plan create and updated after state changes
 * as a rendered view, but execution NEVER reads from the Library page.
 *
 * Step-status invariant:
 * - `needs_review` is an acceptance gate only (human verifies shipped work).
 * - Judgment / scope / design forks use the Question widget inside the child
 *   session. The child monitor keeps the step alive until the answer lands
 *   and the child finishes real work. A human answer never completes a step
 *   except through an explicit acceptance review.
 */
import { db } from "../db";
import { eq, and, desc, gt, inArray, sql, type SQL } from "drizzle-orm";
import { planExecutions, planSteps } from "@shared/schema";
import {
  createPlanSessionLink,
  getOpenPlanStepReview,
  getPlanStepAttemptByChildSession,
  renderPlanProjection,
  reportPlanStepNeedsReview,
  resolvePlanStepReview,
  unlinkPlanSession,
} from "../plan-service";
import { requireCurrentPrincipal } from "../principal-context";
import { isPlanReviewDecision, PLAN_REVIEW_REASON_MAX_LENGTH } from "@shared/plan-review";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { createLogger } from "../log";
import {
  inputFailure,
  permissionFailure,
  type ToolFailure,
} from "../tool-failure";
import { resolveExplicitPlanStepPersona, resolvePlanStepPersona, type PlanStepPersona } from "../plan-persona";
import {
  generatePlanId,
  generateStepId,
  buildPlanPageContent,
  formatPlanSummary,
  isStepResolved,
  isStepProgressed,
  isPlanDone,
  parsePlanFromContent,
  type PlanMeta,
  type PlanStep,
  type PlanStatus,
} from "../lib/plan-utils";

const log = createLogger("PlanTool");

type ToolHandlerResult = {
  result: string;
  error?: boolean;
  failure?: ToolFailure;
};

function classifyPlanResult(result: ToolHandlerResult): ToolHandlerResult {
  if (!result.error || result.failure) return result;
  const permissionRequired = result.result === "Plan creation requires an explicit user principal.";
  return {
    ...result,
    failure: permissionRequired
      ? permissionFailure("plan_principal_required")
      : inputFailure("plan_input_invalid"),
  };
}

const planScopeColumns = {
  ownerUserId: planExecutions.ownerUserId,
  accountId: planExecutions.accountId,
};
const planStepScopeColumns = {
  ownerUserId: planSteps.ownerUserId,
  accountId: planSteps.accountId,
};
function libraryScopeColumns(
  libraryPages: typeof import("@shared/models/info").libraryPages,
) {
  return {
    scope: libraryPages.scope,
    ownerUserId: libraryPages.ownerUserId,
    accountId: libraryPages.accountId,
    vaultId: libraryPages.vaultId,
  };
}
function visiblePlan(predicate?: SQL): SQL {
  return combineWithVisibleScope(
    requireCurrentPrincipal(),
    planScopeColumns,
    predicate,
  );
}
function writablePlan(predicate?: SQL): SQL {
  return combineWithWritableScope(
    requireCurrentPrincipal(),
    planScopeColumns,
    predicate,
  );
}
function visiblePlanStep(predicate?: SQL): SQL {
  return combineWithVisibleScope(
    requireCurrentPrincipal(),
    planStepScopeColumns,
    predicate,
  );
}
function writablePlanStep(predicate?: SQL): SQL {
  return combineWithWritableScope(
    requireCurrentPrincipal(),
    planStepScopeColumns,
    predicate,
  );
}

// ─── Library page helpers ────────────────────────────────────────────

async function getLibraryPage(pageId: string) {
  const { libraryPages } = await import("@shared/models/info");
  const scope = {
    scope: libraryPages.scope,
    ownerUserId: libraryPages.ownerUserId,
    accountId: libraryPages.accountId,
  };
  const byId = await db
    .select()
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        requireCurrentPrincipal(),
        scope,
        eq(libraryPages.id, pageId),
      ),
    );
  if (byId.length > 0) return byId[0];
  const bySlug = await db
    .select()
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        requireCurrentPrincipal(),
        scope,
        eq(libraryPages.slug, pageId),
      ),
    );
  return bySlug[0] || null;
}

// ─── Tool Handler ────────────────────────────────────────────────────

export async function handlePlan(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const action = args.action as string;

  let result: ToolHandlerResult;
  switch (action) {
    case "create":
      result = await handleCreate(args);
      break;
    case "get":
      result = await handleGet(args);
      break;
    case "associate_session":
      result = await handleAssociateSession(args);
      break;
    case "unlink_session":
      result = await handleUnlinkSession(args);
      break;
    case "list":
      result = await handleList(args);
      break;
    case "reconcile_library":
      result = await handleReconcileLibrary(args);
      break;
    case "execute":
      result = await handleExecute(args);
      break;
    case "update_step":
      result = await handleUpdateStep(args);
      break;
    case "edit":
      result = await handleEdit(args);
      break;
    case "add_steps":
      result = await handleAddSteps(args);
      break;
    case "pause":
      result = await handlePause(args);
      break;
    case "review":
      result = await handleReview(args);
      break;
    case "resume":
      result = await handleResume(args);
      break;
    default:
      result = {
        result: `Unknown plan action: "${action}". Available: create, get, associate_session, unlink_session, list, reconcile_library, execute, update_step, edit, add_steps, pause, review, resume`,
        error: true,
      };
  }
  return classifyPlanResult(result);
}

// ─── Action Handlers ─────────────────────────────────────────────────

async function handleCreate(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const title = args.title as string;
  if (!title)
    return { result: "Missing required 'title' parameter.", error: true };

  const principal = requireCurrentPrincipal();
  if (!principal.userId || !principal.accountId) {
    return { result: "Plan creation requires an explicit user principal.", error: true };
  }

  const rawStepsInput = args.steps as Array<{
    title: string;
    instructions: string;
    persona?: PlanStepPersona;
  }>;
  let stepsInput = rawStepsInput;
  if (Array.isArray(rawStepsInput)) {
    try {
      stepsInput = await Promise.all(rawStepsInput.map(async (step) => ({
        ...step,
        persona: (await resolvePlanStepPersona(
          step.persona,
          step.title || "",
          step.instructions || "",
        )).persona,
      })));
    } catch (error) {
      return {
        result: error instanceof Error ? error.message : "Could not resolve Plan step persona.",
        error: true,
      };
    }
  }
  if (!Array.isArray(stepsInput) || stepsInput.length === 0) {
    return {
      result:
        "Missing required 'steps' array. Provide at least one step with title and instructions.",
      error: true,
    };
  }

  for (let i = 0; i < stepsInput.length; i++) {
    const s = stepsInput[i];
    if (!s.title)
      return { result: `Step ${i + 1} missing 'title'.`, error: true };
    if (!s.instructions)
      return { result: `Step ${i + 1} missing 'instructions'.`, error: true };
    if (!s.persona)
      return { result: `Step ${i + 1} requires a selectable persona.`, error: true };
  }

  const sessionId = (args._sessionId as string) || "";
  const planId = generatePlanId();
  const blocking = typeof args.blocking === "boolean" ? args.blocking : false;

  // Build PlanMeta for Library page rendering
  const meta: PlanMeta = {
    id: planId,
    status: "created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    originSessionId: sessionId,
    goalId: args.goalId as string | undefined,
    projectId: args.projectId != null ? Number(args.projectId) : undefined,
    workspace: args.workspace as string | undefined,
    blocking,
    steps: stepsInput.map((s, i) => ({
      id: generateStepId(i),
      title: s.title,
      persona: s.persona,
      status: "pending" as const,
    })),
  };

  // Create Library page (rendered view)
  const pageContent = buildPlanPageContent(meta, stepsInput);
  const { createFiledLibraryPage } = await import("../library-save");
  const planVaultId = typeof args.vaultId === "string" && args.vaultId.trim()
    ? args.vaultId.trim()
    : principal.activeVaultId;
  if (!planVaultId) {
    return { result: "Choose the Plan's Vault before creating it.", error: true };
  }
  const page = await createFiledLibraryPage({
    title: `Plan: ${title}`,
    markdown: pageContent,
    canonicalFolder: "plans",
    explicitVaultId: planVaultId,
    tags: ["plan", "active"],
    createdBySessionId: sessionId,
  });

  // Insert into DB (source of truth)
  const ownerValues = ownedInsertValues(
    requireCurrentPrincipal(),
    planScopeColumns,
  );

  await db.insert(planExecutions).values({
    id: planId,
    ...ownerValues,
    pageId: page.id,
    status: "created",
    originSessionId: sessionId,
    blocking,
    workspace: args.workspace as string | undefined,
    goalId: args.goalId as string | undefined,
    projectId: args.projectId != null ? Number(args.projectId) : undefined,
  });

  for (let i = 0; i < stepsInput.length; i++) {
    await db.insert(planSteps).values({
      id: generateStepId(i),
      ...ownedInsertValues(requireCurrentPrincipal(), planStepScopeColumns),
      planId,
      position: i,
      title: stepsInput[i].title,
      instructions: stepsInput[i].instructions,
      persona: stepsInput[i].persona,
      status: "pending",
    });
  }

  await createPlanSessionLink(planId, sessionId);

  // Record session artifact
  try {
    const { recordSessionArtifact } = await import("../session-artifacts");
    recordSessionArtifact(sessionId, "library_page", page.slug, {
      title: page.title,
      pageId: page.id,
    });
  } catch {
    /* best effort */
  }

  log.log(
    `[${planId}] Created — ${stepsInput.length} steps, pageId=${page.id}, blocking=${blocking}`,
  );

  const stepList = meta.steps
    .map((s, i) => `  ${i + 1}. □ ${s.title}`)
    .join("\n");
  return {
    result: `Plan created: **${title}**\n\nPlan DB ID: ${planId}\nPage ID: ${page.id}\n${stepsInput.length} steps · ${blocking ? "blocking" : "non-blocking"}\n\n${stepList}\n\nCall plan(action: "execute", planId: "${planId}") to start execution, or plan(action: "edit", planId: "${planId}", ...) to revise it. @plan:${planId} @page:${page.slug}`,
  };
}

async function handleGet(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  // Try DB first (by plan ID, then by page UUID)
  let plan = await db
    .select()
    .from(planExecutions)
    .where(visiblePlan(eq(planExecutions.id, planId)))
    .then((r) => r[0]);
  if (!plan)
    plan = await db
      .select()
      .from(planExecutions)
      .where(visiblePlan(eq(planExecutions.pageId, planId)))
      .then((r) => r[0]);

  // Try resolving as a Library page slug → page UUID → planExecutions.pageId
  if (!plan) {
    const resolvedPage = await getLibraryPage(planId);
    if (resolvedPage) {
      plan = await db
        .select()
        .from(planExecutions)
        .where(visiblePlan(eq(planExecutions.pageId, resolvedPage.id)))
        .then((r) => r[0]);
    }
  }

  if (plan) {
    const steps = await db
      .select()
      .from(planSteps)
      .where(visiblePlanStep(eq(planSteps.planId, plan.id)))
      .orderBy(planSteps.position);

    const meta: PlanMeta = dbRowsToMeta(plan, steps);
    const page = await getLibraryPage(plan.pageId);
    const title = page?.title?.replace(/^Plan:\s*/, "") || "Untitled Plan";
    const summary = formatPlanSummary(meta, title);
    return {
      result: `${summary}\n\nPlan DB ID: ${plan.id}\nPage ID: ${page?.id ?? plan.pageId} @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
    };
  }

  // Fallback: try as a Library page ID for legacy YAML plans
  const page = await getLibraryPage(planId);
  if (!page) return { result: `Plan "${planId}" not found.`, error: true };

  const content = page.plainTextContent || "";
  const parsed = parsePlanFromContent(content);
  if (!parsed)
    return {
      result: `Page "${planId}" does not contain valid plan data.`,
      error: true,
    };

  const summary = formatPlanSummary(parsed.meta, page.title || "Untitled Plan");
  return {
    result: `${summary}\n\n(Legacy YAML plan) Page: ${page.id} @page:${page.slug}`,
  };
}

async function handleAssociateSession(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const sessionId = args._sessionId as string | undefined;
  if (!sessionId)
    return {
      result:
        "No active session context is available to associate with this plan.",
      error: true,
    };

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);

  const { plan, page } = resolved;
  await createPlanSessionLink(plan.id, sessionId);
  const { recordSessionArtifact } = await import("../session-artifacts");
  await recordSessionArtifact(sessionId, "library_page", page.slug, {
    title: page.title,
    pageId: page.id,
    planId: plan.id,
  });

  log.log(`[${plan.id}] Associated page ${page.id} with session ${sessionId}`);

  return {
    result: `Associated plan **${page.title.replace(/^Plan:\s*/, "")}** with this session.\n\nPlan DB ID: ${plan.id}\nPage ID: ${page.id} @plan:${plan.id} @page:${page.slug}`,
  };
}

async function handleUnlinkSession(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const sessionId =
    (args.sessionId as string | undefined) ||
    (args._sessionId as string | undefined);
  if (!sessionId)
    return {
      result:
        "No session context is available to unlink from this plan. Provide sessionId or run from the linked session.",
      error: true,
    };

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;

  if (plan.status === "executing") {
    return {
      result: "Cannot unlink a running plan from a session — pause it first.",
      error: true,
    };
  }

  const unlinked = await unlinkPlanSession(plan.id, sessionId);
  if (unlinked === 0) {
    return {
      result: `Plan **${page.title.replace(/^Plan:\s*/, "")}** is not linked to session ${sessionId}.`,
      error: true,
    };
  }

  log.log(`[${plan.id}] Unlinked from session ${sessionId}`);

  return {
    result: `Unlinked plan **${page.title.replace(/^Plan:\s*/, "")}** from this session. The plan page and execution history were preserved.\n\nPlan DB ID: ${plan.id}\nPage ID: ${page.id} @plan:${plan.id} @page:${page.slug}`,
  };
}

async function handleList(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 20), 100));
  const offset = Math.max(0, Math.min(Math.floor(Number(args.offset) || 0), 100_000));
  const [totalRow] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(planExecutions)
    .where(visiblePlan());
  const total = Number(totalRow?.total ?? 0);
  const plans = await db
    .select()
    .from(planExecutions)
    .where(visiblePlan())
    .orderBy(desc(planExecutions.updatedAt), desc(planExecutions.id))
    .limit(limit)
    .offset(offset);

  const planIds = plans.map(plan => plan.id);
  const pageIds = plans.map(plan => plan.pageId);
  const steps = planIds.length === 0 ? [] : await db
    .select()
    .from(planSteps)
    .where(visiblePlanStep(inArray(planSteps.planId, planIds)));
  const { libraryPages } = await import("@shared/models/info");
  const pages = pageIds.length === 0 ? [] : await db
    .select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug })
    .from(libraryPages)
    .where(combineWithVisibleScope(
      requireCurrentPrincipal(),
      libraryScopeColumns(libraryPages),
      inArray(libraryPages.id, pageIds),
    ));
  const stepsByPlan = new Map<string, typeof steps>();
  for (const step of steps) {
    const current = stepsByPlan.get(step.planId) ?? [];
    current.push(step);
    stepsByPlan.set(step.planId, current);
  }
  const pagesById = new Map(pages.map(page => [page.id, page]));
  const items = plans.map(plan => {
    const planStepsForRow = stepsByPlan.get(plan.id) ?? [];
    const page = pagesById.get(plan.pageId);
    return {
      planId: plan.id,
      libraryPageId: plan.pageId,
      libraryPageSlug: page?.slug ?? null,
      title: page?.title ?? null,
      status: plan.status,
      resolvedSteps: planStepsForRow.filter(isStepProgressed).length,
      totalSteps: planStepsForRow.length,
      updatedAt: plan.updatedAt.toISOString(),
    };
  });

  return {
    result: JSON.stringify({
      outcome: "listed",
      pagination: { limit, offset, total, hasMore: offset + items.length < total },
      plans: items,
    }, null, 2),
  };
}

async function handleReconcileLibrary(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const mode = args.mode === "apply" ? "apply" : "preview";
  if (args.mode !== undefined && args.mode !== "preview" && args.mode !== "apply") {
    return { result: "Invalid mode. Use preview or apply.", error: true };
  }
  const { reconcilePlanLibraryPlacement } = await import("../plan-library-reconciliation");
  const result = await reconcilePlanLibraryPlacement({
    principal: requireCurrentPrincipal(),
    mode,
    limit: args.limit,
    offset: args.offset,
  });
  return { result: JSON.stringify(result, null, 2) };
}

async function handleExecute(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const inputPlanId = args.planId as string;
  if (!inputPlanId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const resolved = await resolvePlanWithPage(inputPlanId);
  if (!resolved) {
    // Legacy fallback: try as page ID/slug
    return handleExecuteLegacy(args);
  }
  const { plan, page } = resolved;
  const planId = plan.id;

  if (plan.status === "needs_review") {
    return {
      result: `Plan status is "needs_review" — execution cannot bypass the open human gate. Use plan(action: "review") only after a later human turn, or use the review widget.`,
      error: true,
    };
  }
  if (plan.status !== "created" && plan.status !== "paused") {
    return {
      result: `Plan status is "${plan.status}" — can only execute plans with status "created" or "paused".`,
      error: true,
    };
  }

  const sessionId = (args._sessionId as string) || plan.originSessionId;
  const planTitle = (page?.title || "Untitled Plan").replace(/^Plan:\s*/, "");

  const authority = args._authorityContext as import("../agent-authority").AgentAuthorityContext | undefined;
  if (authority?.runtimeRunId && authority.runtimeAttemptId) {
    const principal = requireCurrentPrincipal();
    const { enqueuePlanExecutionRuntimeRun } = await import("../runtime/proof-path-handlers");
    const handoff = await enqueuePlanExecutionRuntimeRun(principal, {
      planId,
      originSessionId: sessionId,
      planTitle,
      launchKey: `nested/${authority.runtimeRunId}/${String(args._toolCallId || planId)}`,
      parentRuntimeRunId: authority.runtimeRunId,
    });
    return {
      result: `Plan **${planTitle}** accepted for independent Runtime execution.\n\nPlan DB ID: ${plan.id}\nRuntime Run ID: ${handoff.run.id}\nPage ID: ${plan.pageId} @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
    };
  }

  const principal = requireCurrentPrincipal();
  const { enqueuePlanExecutionRuntimeRun } = await import("../runtime/proof-path-handlers");
  const launched = await enqueuePlanExecutionRuntimeRun(principal, {
    planId,
    originSessionId: sessionId,
    planTitle,
    launchKey: `tool/${sessionId}/${String(args._toolCallId || planId)}`,
  });
  return {
    result: `Plan **${planTitle}** accepted for Runtime execution.\n\nPlan DB ID: ${plan.id}\nRuntime Run ID: ${launched.run.id}\nPage ID: ${plan.pageId} @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
  };

}

/** Legacy execute path for YAML-backed plans created before the DB migration. */
async function handleExecuteLegacy(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  const page = await getLibraryPage(planId);
  if (!page) return { result: `Plan "${planId}" not found.`, error: true };

  const content = page.plainTextContent || "";
  const parsed = parsePlanFromContent(content);
  if (!parsed)
    return {
      result: `Page "${planId}" does not contain valid plan data.`,
      error: true,
    };

  // Migrate legacy plan to DB on first execute
  const { meta } = parsed;
  const sessionId = (args._sessionId as string) || meta.originSessionId;

  await db
    .insert(planExecutions)
    .values({
      id: meta.id,
      ...ownedInsertValues(requireCurrentPrincipal(), planScopeColumns),
      pageId: page.id,
      status: meta.status,
      originSessionId: meta.originSessionId,
      blocking: meta.blocking,
      workspace: meta.workspace,
      workspaceDir: meta.workspaceDir,
      goalId: meta.goalId,
      projectId: meta.projectId,
    })
    .onConflictDoNothing();

  const { extractStepInstructions } = await import("../lib/plan-utils");
  const instructions = extractStepInstructions(parsed.body);
  for (let i = 0; i < meta.steps.length; i++) {
    const step = meta.steps[i];
    await db
      .insert(planSteps)
      .values({
        id: step.id,
        ...ownedInsertValues(
          requireCurrentPrincipal(),
          planStepScopeColumns,
        ),
        planId: meta.id,
        position: i,
        title: step.title,
        instructions: instructions.get(i) || `Execute step: ${step.title}`,
        persona: step.persona,
        status: step.status,
        sessionId: step.sessionId,
        outcome: step.outcome,
        error: step.error,
        durationSeconds: step.duration,
        startedAt: step.startedAt ? new Date(step.startedAt) : null,
        completedAt: step.completedAt ? new Date(step.completedAt) : null,
      })
      .onConflictDoNothing();
  }

  log.log(`[${meta.id}] Migrated legacy plan to DB from page ${page.id}`);

  // Now execute via DB path
  const planTitle = (page.title || "Untitled Plan").replace(/^Plan:\s*/, "");
  const { executePlan } = await import("../plan-executor");

  if (!meta.blocking) {
    executePlan(meta.id, sessionId, planTitle, false).catch((err) => {
      log.error(
        `[${meta.id}] Background execution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return {
      result: `Plan **${planTitle}** started in background (migrated from legacy).`,
    };
  }

  const result = await executePlan(meta.id, sessionId, planTitle, true);
  const isLegacyComplete =
    result.status === "completed" ||
    result.status === "completed_with_failures";
  if (isLegacyComplete) {
    return {
      result: `✅ Plan **${planTitle}** completed — ${result.completedSteps}/${result.totalSteps} steps in ${formatDuration(result.totalDuration)}. @plan:${meta.id} @page:${page.slug}`,
    };
  } else if (result.status === "needs_review") {
    return {
      result: `👀 Plan **${planTitle}** needs review. Use the Plan review card or wait for a later human turn before plan(action: "review"). @plan:${meta.id} @page:${page.slug}`,
    };
  } else if (result.status === "paused") {
    return {
      result: `⚠️ Plan **${planTitle}** paused — ${result.error || ""}. Use plan(action: "resume", planId: "${meta.id}") to retry. @plan:${meta.id} @page:${page.slug}`,
      error: true,
    };
  } else {
    return {
      result: `❌ Plan **${planTitle}** failed — ${result.error || "Unknown error"}. @plan:${meta.id} @page:${page.slug}`,
      error: true,
    };
  }
}

async function handleUpdateStep(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  const stepId = args.stepId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };
  if (!stepId)
    return { result: "Missing required 'stepId' parameter.", error: true };

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;
  const resolvedPlanId = plan.id;

  const step = await db
    .select()
    .from(planSteps)
    .where(visiblePlanStep(eq(planSteps.planId, resolvedPlanId)))
    .then((rows) => rows.find((r) => r.id === stepId));
  if (!step)
    return { result: `Step "${stepId}" not found in plan.`, error: true };
  if (plan.status === "needs_review" && step.status !== "needs_review") {
    return {
      result: "This Plan has an open human review gate. Other step mutations are blocked until it is resolved.",
      error: true,
    };
  }

  const setFields: Record<string, any> = { updatedAt: new Date() };
  const requestedStatus = args.status as string | undefined;
  const callerSessionId = typeof args._sessionId === "string" ? args._sessionId : "";
  const callerAttempt = callerSessionId
    ? await getPlanStepAttemptByChildSession(resolvedPlanId, stepId, callerSessionId)
    : null;
  if (callerAttempt) {
    const isCurrentAttempt = step.status === "running" && step.sessionId === callerSessionId;
    const isGateReport = requestedStatus === "blocked" || requestedStatus === "needs_review";
    if (!isCurrentAttempt || !isGateReport) {
      log.warn(
        `[${resolvedPlanId}] Ignored ${requestedStatus || "field-only"} update from managed child ` +
        `${callerSessionId} for ${stepId}; parent executor owns terminal step state`,
      );
      return {
        result: isCurrentAttempt
          ? `Step "${step.title}" is managed by the parent executor. End this child session when complete; the executor will record completion automatically. Use blocked for external blockers. Use needs_review only for acceptance of shipped work — judgment/scope forks use the Question widget so you can continue after the answer.`
          : `Attempt ${callerAttempt.attemptNumber} is no longer the active owner of step "${step.title}". No plan state was changed.`,
      };
    }
    if (requestedStatus === "needs_review") {
      const reviewPrompt = typeof args.outcome === "string" && args.outcome.trim()
        ? args.outcome.trim()
        : typeof args.error === "string" && args.error.trim()
          ? args.error.trim()
          : "Review the completed step before the Plan continues.";
      const reviewDetail = typeof args.reviewDetail === "string" && args.reviewDetail.trim()
        ? args.reviewDetail.trim()
        : null;
      const review = await reportPlanStepNeedsReview({
        planId: resolvedPlanId,
        stepId,
        childSessionId: callerSessionId,
        prompt: reviewPrompt,
        detail: reviewDetail,
        outcome: typeof args.outcome === "string" ? args.outcome : null,
      });
      const latestPlan = await db.select().from(planExecutions)
        .where(visiblePlan(eq(planExecutions.id, resolvedPlanId)))
        .then((rows) => rows[0]);
      if (latestPlan) await refreshPlanPage(latestPlan, page);
      return {
        result: `Step "${step.title}" is awaiting human acceptance review (review ${review.id}). End this child session; the parent executor will stop at the gate. For judgment/scope questions, use the Question widget instead so you can continue after the answer.`,
      };
    }
  }
  if (step.status === "needs_review") {
    return {
      result: "This step has an open human review gate. Resolve it with plan(action: \"review\") or the review widget; update_step cannot change it.",
      error: true,
    };
  }
  if (requestedStatus === "needs_review" && !callerAttempt) {
    return {
      result: "Only the active managed step child may open a needs-review gate. Human decisions use plan(action: \"review\").",
      error: true,
    };
  }
  if (requestedStatus) {
    const validStatuses = new Set([
      "pending",
      "completed",
      "failed",
      "skipped",
      "blocked",
      "needs_review",
    ]);
    if (!validStatuses.has(requestedStatus)) {
      return {
        result: `Invalid status "${requestedStatus}". Use pending, completed, failed, skipped, blocked, or needs_review.`,
        error: true,
      };
    }
    setFields.status = requestedStatus;
  }
  if (args.outcome) setFields.outcome = args.outcome;
  if (args.error) setFields.error = args.error;

  await db
    .update(planSteps)
    .set(setFields)
    .where(
      writablePlanStep(
        and(eq(planSteps.planId, resolvedPlanId), eq(planSteps.id, stepId)),
      ),
    );

  // Check if plan is now done
  const allSteps = await db
    .select()
    .from(planSteps)
    .where(visiblePlanStep(eq(planSteps.planId, resolvedPlanId)));
  let autoCompleted = false;
  if (isPlanDone(allSteps)) {
    const anyFailed = allSteps.some((s) => s.status === "failed");
    const newStatus = anyFailed ? "completed_with_failures" : "completed";
    await db
      .update(planExecutions)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(writablePlan(eq(planExecutions.id, resolvedPlanId)));
    autoCompleted = true;
  }

  const latestPlanForRefresh = await db
    .select()
    .from(planExecutions)
    .where(visiblePlan(eq(planExecutions.id, resolvedPlanId)))
    .then((r) => r[0]);
  await refreshPlanPage(latestPlanForRefresh || plan, page);

  return {
    result: `Step "${step.title}" updated: status=${args.status || step.status}${args.outcome ? `, outcome="${(args.outcome as string).slice(0, 100)}"` : ""}${autoCompleted ? ". ✅ Plan auto-completed (all steps done)." : ""}`,
  };
}

async function handleEdit(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;
  const resolvedPlanId = plan.id;
  if (plan.status === "needs_review") {
    return {
      result: "This Plan has an open human review gate. Resolve it before editing Plan or step state.",
      error: true,
    };
  }

  const setPlan: Record<string, any> = { updatedAt: new Date() };
  if (typeof args.blocking === "boolean") setPlan.blocking = args.blocking;
  if (args.workspace !== undefined) setPlan.workspace = args.workspace || null;
  if (args.goalId !== undefined) setPlan.goalId = args.goalId || null;
  if (args.projectId !== undefined)
    setPlan.projectId = args.projectId == null ? null : Number(args.projectId);

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title) {
    const { libraryPages } = await import("@shared/models/info");
    await db
      .update(libraryPages)
      .set({
        title: title.startsWith("Plan:") ? title : `Plan: ${title}`,
        updatedAt: new Date(),
      })
      .where(
        combineWithWritableScope(
          requireCurrentPrincipal(),
          libraryScopeColumns(libraryPages),
          eq(libraryPages.id, page.id),
        ),
      );
  }

  const hasPlanFields = Object.keys(setPlan).length > 1;
  if (hasPlanFields) {
    await db
      .update(planExecutions)
      .set(setPlan)
      .where(writablePlan(eq(planExecutions.id, resolvedPlanId)));
  }

  const stepEdits = args.stepEdits as
    | Array<{
        stepId: string;
        title?: string;
        instructions?: string;
        persona?: PlanStepPersona;
        status?: string;
      }>
    | undefined;
  let editedSteps = 0;
  if (Array.isArray(stepEdits)) {
    const validStatuses = new Set([
      "pending",
      "completed",
      "failed",
      "skipped",
      "blocked",
      "needs_review",
    ]);
    for (const edit of stepEdits) {
      if (!edit?.stepId) continue;
      const setStep: Record<string, any> = { updatedAt: new Date() };
      if (typeof edit.title === "string" && edit.title.trim())
        setStep.title = edit.title.trim();
      if (typeof edit.instructions === "string")
        setStep.instructions = edit.instructions;
      if (edit.persona !== undefined) {
        try {
          setStep.persona = await resolveExplicitPlanStepPersona(edit.persona);
        } catch (error) {
          return {
            result: error instanceof Error ? error.message : `Invalid persona for step "${edit.stepId}".`,
            error: true,
          };
        }
      }
      if (edit.status) {
        if (!validStatuses.has(edit.status)) {
          return {
            result: `Invalid status "${edit.status}" for step "${edit.stepId}". Use pending, completed, failed, skipped, blocked, or needs_review.`,
            error: true,
          };
        }
        if (edit.status === "needs_review") {
          return {
            result: `Step "${edit.stepId}" can enter needs_review only from its active managed child attempt.`,
            error: true,
          };
        }
        const existingStep = await db.select({ status: planSteps.status })
          .from(planSteps)
          .where(visiblePlanStep(and(eq(planSteps.planId, resolvedPlanId), eq(planSteps.id, edit.stepId))))
          .then((rows) => rows[0]);
        if (existingStep?.status === "needs_review") {
          return {
            result: `Step "${edit.stepId}" has an open review gate. Resolve it through plan(action: "review") or the review widget.`,
            error: true,
          };
        }
        setStep.status = edit.status;
      }
      if (Object.keys(setStep).length > 1) {
        await db
          .update(planSteps)
          .set(setStep)
          .where(
            writablePlanStep(
              and(
                eq(planSteps.planId, resolvedPlanId),
                eq(planSteps.id, edit.stepId),
              ),
            ),
          );
        editedSteps++;
      }
    }
  }

  const latestPlan = await db
    .select()
    .from(planExecutions)
    .where(visiblePlan(eq(planExecutions.id, resolvedPlanId)))
    .then((r) => r[0]);
  if (latestPlan) await refreshPlanPage(latestPlan, page);

  if (!title && !hasPlanFields && editedSteps === 0) {
    return {
      result:
        "No plan edits supplied. Use title, blocking, workspace, goalId, projectId, or stepEdits.",
      error: true,
    };
  }

  const bits = [
    title ? "title" : "",
    hasPlanFields ? "metadata" : "",
    editedSteps ? `${editedSteps} step(s)` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    result: `Edited plan **${(title || page.title).replace(/^Plan:\s*/, "")}**: ${bits}.\n\nPlan DB ID: ${resolvedPlanId}\nPage ID: ${page.id} @plan:${resolvedPlanId} @page:${page.slug}`,
  };
}

async function handleAddSteps(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const rawNewSteps = args.newSteps as Array<{
    title: string;
    instructions: string;
    persona?: PlanStepPersona;
  }>;
  let newSteps = rawNewSteps;
  if (Array.isArray(rawNewSteps)) {
    try {
      newSteps = await Promise.all(rawNewSteps.map(async (step) => ({
        ...step,
        persona: (await resolvePlanStepPersona(
          step.persona,
          step.title || "",
          step.instructions || "",
        )).persona,
      })));
    } catch (error) {
      return {
        result: error instanceof Error ? error.message : "Could not resolve new Plan step persona.",
        error: true,
      };
    }
  }
  if (!Array.isArray(newSteps) || newSteps.length === 0) {
    return { result: "Missing required 'newSteps' array.", error: true };
  }
  for (let i = 0; i < newSteps.length; i++) {
    if (!newSteps[i]?.title || !newSteps[i]?.instructions)
      return { result: `New step ${i + 1} requires title and instructions.`, error: true };
    if (!newSteps[i].persona)
      return { result: `New step ${i + 1} requires a selectable persona.`, error: true };
  }

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;
  const resolvedPlanId = plan.id;
  if (plan.status === "needs_review") {
    return {
      result: "This Plan has an open human review gate. Resolve it before changing the execution graph.",
      error: true,
    };
  }

  const existingSteps = await db
    .select()
    .from(planSteps)
    .where(visiblePlanStep(eq(planSteps.planId, resolvedPlanId)))
    .orderBy(planSteps.position);
  const existingCount = existingSteps.length;

  // Determine insertion point
  let insertAfterPosition = existingCount - 1;
  if (args.afterStepId) {
    const afterStep = existingSteps.find((s) => s.id === args.afterStepId);
    if (afterStep) insertAfterPosition = afterStep.position;
  }

  if (insertAfterPosition < existingCount - 1) {
    await db
      .update(planSteps)
      .set({
        position: sql`${planSteps.position} + ${newSteps.length}`,
        updatedAt: new Date(),
      })
      .where(
        writablePlanStep(
          and(
            eq(planSteps.planId, resolvedPlanId),
            gt(planSteps.position, insertAfterPosition),
          ),
        ),
      );
  }

  for (let i = 0; i < newSteps.length; i++) {
    await db.insert(planSteps).values({
      id: generateStepId(existingCount + i),
      ...ownedInsertValues(requireCurrentPrincipal(), planStepScopeColumns),
      planId: resolvedPlanId,
      position: insertAfterPosition + 1 + i,
      title: newSteps[i].title,
      instructions: newSteps[i].instructions,
      persona: newSteps[i].persona,
      status: "pending",
    });
  }

  await refreshPlanPage(plan, page);

  log.log(
    `[${resolvedPlanId}] Added ${newSteps.length} steps (total now ${existingCount + newSteps.length})`,
  );

  return {
    result: `Added ${newSteps.length} step(s) to plan. Total steps: ${existingCount + newSteps.length}.\n\nNew steps:\n${newSteps.map((s, i) => `  ${existingCount + i + 1}. □ ${s.title}`).join("\n")}`,
  };
}

async function handlePause(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan } = resolved;
  const resolvedPlanId = plan.id;

  const { pausePlan, isExecuting } = await import("../plan-executor");
  if (isExecuting(resolvedPlanId)) {
    pausePlan(resolvedPlanId);
    return {
      result: `Plan pause requested. The current step will complete before pausing.`,
    };
  }

  if (plan.status === "executing") {
    await db
      .update(planExecutions)
      .set({ status: "paused", updatedAt: new Date() })
      .where(writablePlan(eq(planExecutions.id, resolvedPlanId)));
    return { result: `Plan paused.` };
  }

  return { result: `Plan is not executing (status: ${plan.status}).` };
}

async function hasLaterHumanTurn(sessionId: string, openedAt: Date): Promise<boolean> {
  if (!sessionId) return false;
  const { chatFileStorage } = await import("../chat-file-storage");
  const session = await chatFileStorage.getSession(sessionId).catch(() => null);
  const messages = (session as { messages?: Array<{ role?: string; createdAt?: string; visibility?: string }> } | null)?.messages ?? [];
  return messages.some((message) =>
    message.role === "user" &&
    message.visibility !== "diagnostic" &&
    typeof message.createdAt === "string" &&
    new Date(message.createdAt).getTime() > openedAt.getTime(),
  );
}

async function handleReview(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  const stepId = args.stepId as string;
  if (!planId) return { result: "Missing required 'planId' parameter.", error: true };
  if (!stepId) return { result: "Missing required 'stepId' parameter.", error: true };
  if (!isPlanReviewDecision(args.decision)) {
    return { result: "Invalid review decision. Use approve, request_changes, retry, or stop.", error: true };
  }
  const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, PLAN_REVIEW_REASON_MAX_LENGTH) : "";
  if (args.decision === "request_changes" && !reason) {
    return { result: "Request changes requires a reason.", error: true };
  }

  const authority = args._authorityContext as { origin?: string } | undefined;
  const callerSessionId = typeof args._sessionId === "string" ? args._sessionId : "";
  if (!callerSessionId || (authority?.origin !== "interactive" && authority?.origin !== "voice")) {
    return { result: "Plan review requires a later human turn or the review widget.", error: true };
  }

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;
  if (plan.originSessionId !== callerSessionId) {
    return { result: "Plan review through chat must come from the Plan's originating human conversation. Use the review widget instead.", error: true };
  }
  if (plan.status !== "needs_review") {
    return { result: `Plan status is "${plan.status}" — no review gate is open.`, error: true };
  }
  const review = await getOpenPlanStepReview(plan.id, stepId);
  if (!review) return { result: `Step "${stepId}" has no open review gate.`, error: true };
  if (!(await hasLaterHumanTurn(callerSessionId, review.openedAt))) {
    return { result: "This gate can be resolved only after a human sends a new message after the review opened. Use the review widget or ask the human to respond.", error: true };
  }

  const decision = await resolvePlanStepReview({
    planId: plan.id,
    stepId,
    reviewId: review.id,
    decision: args.decision,
    reason,
    source: "later_human_turn",
    resolvedBySessionId: callerSessionId,
  });

  if (!decision.shouldExecute) {
    return {
      result: decision.planStatus === "completed"
        ? `✅ Plan **${page.title.replace(/^Plan:\s*/, "")}** completed after review. @plan:${plan.id} @page:${page.slug}`
        : decision.planStatus === "aborted"
          ? `Plan **${page.title.replace(/^Plan:\s*/, "")}** was stopped by human review. @plan:${plan.id} @page:${page.slug}`
          : `Plan **${page.title.replace(/^Plan:\s*/, "")}** remains paused after the review decision. @plan:${plan.id} @page:${page.slug}`,
    };
  }

  const planTitle = page.title.replace(/^Plan:\s*/, "") || "Untitled Plan";
  const { resumePlan } = await import("../plan-executor");
  if (!plan.blocking) {
    resumePlan(plan.id, plan.originSessionId, planTitle, false).catch((err) => {
      log.error(`[${plan.id}] Background post-review execution failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { result: `Plan **${planTitle}** review recorded; execution resumed in background. @plan:${plan.id} @page:${page.slug}` };
  }

  const result = await resumePlan(plan.id, plan.originSessionId, planTitle, true);
  return {
    result: result.status === "completed" || result.status === "completed_with_failures"
      ? `✅ Plan **${planTitle}** completed — ${result.completedSteps}/${result.totalSteps} steps. @plan:${plan.id} @page:${page.slug}`
      : result.status === "needs_review"
        ? `👀 Plan **${planTitle}** reached another review gate. @plan:${plan.id} @page:${page.slug}`
        : `Plan **${planTitle}** is ${result.status}. ${result.error || ""} @plan:${plan.id} @page:${page.slug}`,
    error: result.status === "failed",
  };
}

async function handleResume(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const planId = args.planId as string;
  if (!planId)
    return { result: "Missing required 'planId' parameter.", error: true };

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;
  const resolvedPlanId = plan.id;

  if (plan.status === "needs_review") {
    return {
      result: `Plan **${page.title.replace(/^Plan:\s*/, "")}** is awaiting a human review decision. Use plan(action: "review", planId: "${resolvedPlanId}", stepId: "<stepId>", decision: "approve|request_changes|retry|stop") only after a later human turn, or use the review widget.`,
      error: true,
    };
  }
  if (plan.status !== "paused") {
    return {
      result: `Plan status is "${plan.status}" — can only resume paused plans.`,
      error: true,
    };
  }

  const planTitle = (page?.title || "Untitled Plan").replace(/^Plan:\s*/, "");

  const { resumePlan } = await import("../plan-executor");

  if (!plan.blocking) {
    resumePlan(resolvedPlanId, plan.originSessionId, planTitle, false).catch((err) => {
      log.error(
        `[${resolvedPlanId}] Background resume failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return { result: `Plan **${planTitle}** resumed in background.` };
  }

  const result = await resumePlan(resolvedPlanId, plan.originSessionId, planTitle, true);

  const isResumeComplete =
    result.status === "completed" ||
    result.status === "completed_with_failures";
  if (isResumeComplete) {
    return {
      result: `✅ Plan **${planTitle}** completed — ${result.completedSteps}/${result.totalSteps} steps. @plan:${resolvedPlanId}${page ? ` @page:${page.slug}` : ""}`,
    };
  } else if (result.status === "needs_review") {
    return {
      result: `👀 Plan **${planTitle}** still needs review. @plan:${resolvedPlanId}${page ? ` @page:${page.slug}` : ""}`,
    };
  } else if (result.status === "paused") {
    return {
      result: `⚠️ Plan **${planTitle}** paused again — ${result.error || ""}. @plan:${resolvedPlanId}${page ? ` @page:${page.slug}` : ""}`,
      error: true,
    };
  } else {
    return {
      result: `❌ Plan **${planTitle}** failed — ${result.error || "Unknown error"}. @plan:${resolvedPlanId}${page ? ` @page:${page.slug}` : ""}`,
      error: true,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function resolvePlanWithPage(planId: string) {
  let plan = await db
    .select()
    .from(planExecutions)
    .where(visiblePlan(eq(planExecutions.id, planId)))
    .then((r) => r[0]);
  if (!plan)
    plan = await db
      .select()
      .from(planExecutions)
      .where(visiblePlan(eq(planExecutions.pageId, planId)))
      .then((r) => r[0]);

  let page = plan ? await getLibraryPage(plan.pageId) : null;

  if (!plan) {
    const resolvedPage = await getLibraryPage(planId);
    if (resolvedPage) {
      plan = await db
        .select()
        .from(planExecutions)
        .where(visiblePlan(eq(planExecutions.pageId, resolvedPage.id)))
        .then((r) => r[0]);
      page = plan ? resolvedPage : null;
    }
  }

  if (!plan || !page) return null;
  return { plan, page };
}

function planNotFound(input: string): ToolHandlerResult {
  return {
    result: `Plan "${input}" not found. Use plan(action: "list") to find the active Plan DB ID. Plan actions accept Plan DB ID, Library page ID, or page slug; if a page slug is ambiguous or stale, use the Plan DB ID shown by plan(action: "get") or plan(action: "list").`,
    error: true,
  };
}

async function refreshPlanPage(
  plan: typeof planExecutions.$inferSelect,
  _page: Awaited<ReturnType<typeof getLibraryPage>>,
): Promise<void> {
  await renderPlanProjection(plan.id);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${mins}m`;
}

function dbRowsToMeta(
  plan: typeof planExecutions.$inferSelect,
  steps: Array<typeof planSteps.$inferSelect>,
): PlanMeta {
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
    steps: steps.map((s) => ({
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
