/**
 * Plan Tool — MCP tool handler for creating, inspecting, modifying,
 * and executing multi-step plans.
 *
 * All state is read/written via the plan_executions and plan_steps DB tables.
 * Library pages are created on plan create and updated after state changes
 * as a rendered view, but execution NEVER reads from the Library page.
 */
import { db } from "../db";
import { eq, and, desc, gt, sql, type SQL } from "drizzle-orm";
import { planExecutions, planSteps } from "@shared/schema";
import {
  createPlanSessionLink,
  renderPlanProjection,
  unlinkPlanSession,
} from "../plan-service";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { createLogger } from "../log";
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

type ToolHandlerResult = { result: string; error?: boolean };

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
    getCurrentPrincipalOrSystem(),
    planScopeColumns,
    predicate,
  );
}
function writablePlan(predicate?: SQL): SQL {
  return combineWithWritableScope(
    getCurrentPrincipalOrSystem(),
    planScopeColumns,
    predicate,
  );
}
function visiblePlanStep(predicate?: SQL): SQL {
  return combineWithVisibleScope(
    getCurrentPrincipalOrSystem(),
    planStepScopeColumns,
    predicate,
  );
}
function writablePlanStep(predicate?: SQL): SQL {
  return combineWithWritableScope(
    getCurrentPrincipalOrSystem(),
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
        getCurrentPrincipalOrSystem(),
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
        getCurrentPrincipalOrSystem(),
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

  switch (action) {
    case "create":
      return handleCreate(args);
    case "get":
      return handleGet(args);
    case "associate_session":
      return handleAssociateSession(args);
    case "unlink_session":
      return handleUnlinkSession(args);
    case "list":
      return handleList(args);
    case "execute":
      return handleExecute(args);
    case "update_step":
      return handleUpdateStep(args);
    case "edit":
      return handleEdit(args);
    case "add_steps":
      return handleAddSteps(args);
    case "pause":
      return handlePause(args);
    case "resume":
      return handleResume(args);
    default:
      return {
        result: `Unknown plan action: "${action}". Available: create, get, associate_session, unlink_session, list, execute, update_step, edit, add_steps, pause, resume`,
        error: true,
      };
  }
}

// ─── Action Handlers ─────────────────────────────────────────────────

async function handleCreate(
  args: Record<string, any>,
): Promise<ToolHandlerResult> {
  const title = args.title as string;
  if (!title)
    return { result: "Missing required 'title' parameter.", error: true };

  const stepsInput = args.steps as Array<{
    title: string;
    instructions: string;
  }>;
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
      status: "pending" as const,
    })),
  };

  // Create Library page (rendered view)
  const pageContent = buildPlanPageContent(meta, stepsInput);
  const { createFiledLibraryPage } = await import("../library-save");
  const page = await createFiledLibraryPage({
    title: `Plan: ${title}`,
    markdown: pageContent,
    purpose: "plans",
    pageContext: "/plans",
    contentSummary: `Multi-step execution plan: ${title}`,
    tags: ["plan", "active"],
    createdBySessionId: sessionId,
  });

  // Insert into DB (source of truth)
  const ownerValues = ownedInsertValues(
    getCurrentPrincipalOrSystem(),
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
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), planStepScopeColumns),
      planId,
      position: i,
      title: stepsInput[i].title,
      instructions: stepsInput[i].instructions,
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
  const limit = Math.min(Number(args.limit) || 20, 50);

  const plans = await db
    .select()
    .from(planExecutions)
    .where(visiblePlan())
    .orderBy(desc(planExecutions.updatedAt))
    .limit(limit);

  if (plans.length === 0) {
    return { result: "No plans found." };
  }

  const statusIcon: Record<string, string> = {
    created: "📋",
    executing: "⏳",
    paused: "⏸️",
    needs_review: "👀",
    completed: "✅",
    completed_with_failures: "⚠️",
    failed: "❌",
    aborted: "🚫",
  };

  const lines: string[] = [];
  for (const p of plans) {
    const steps = await db
      .select()
      .from(planSteps)
      .where(visiblePlanStep(eq(planSteps.planId, p.id)));
    const resolved = steps.filter(isStepProgressed).length;
    const page = await getLibraryPage(p.pageId);
    const title = page?.title || "Untitled";
    const slug = page?.slug || "";
    lines.push(
      `${statusIcon[p.status] || "📋"} **${title}** (${p.id}) — ${resolved}/${steps.length} steps · ${p.status}${slug ? ` @page:${slug}` : ""}`,
    );
  }

  return { result: `**Plans** (${plans.length})\n\n${lines.join("\n")}` };
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

  if (
    plan.status !== "created" &&
    plan.status !== "paused" &&
    plan.status !== "needs_review"
  ) {
    return {
      result: `Plan status is "${plan.status}" — can only execute plans with status "created", "paused", or "needs_review". Use plan(action: "resume") for paused or review-pending plans.`,
      error: true,
    };
  }

  const sessionId = (args._sessionId as string) || plan.originSessionId;
  const planTitle = (page?.title || "Untitled Plan").replace(/^Plan:\s*/, "");

  const { executePlan } = await import("../plan-executor");

  if (!plan.blocking) {
    executePlan(planId, sessionId, planTitle, false).catch((err) => {
      log.error(
        `[${planId}] Background execution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return {
      result: `Plan **${planTitle}** started in background. You'll be notified on completion or failure.\n\nPlan DB ID: ${plan.id}\nPage ID: ${plan.pageId} @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
    };
  }

  const result = await executePlan(planId, sessionId, planTitle, true);

  const isComplete =
    result.status === "completed" ||
    result.status === ("completed_with_failures" as PlanStatus);
  if (isComplete) {
    return {
      result: `✅ Plan **${planTitle}** completed — ${result.completedSteps}/${result.totalSteps} steps in ${formatDuration(result.totalDuration)}. @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
    };
  } else if (result.status === "needs_review") {
    return {
      result: `👀 Plan **${planTitle}** needs review — ${result.completedSteps}/${result.totalSteps} steps executed. @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
    };
  } else if (result.status === "paused") {
    return {
      result: `⚠️ Plan **${planTitle}** paused — ${result.completedSteps}/${result.totalSteps} steps completed. ${result.error || ""}. Use plan(action: "resume", planId: "${planId}") to retry. @plan:${plan.id}${page ? ` @page:${page.slug}` : ""}`,
      error: true,
    };
  } else {
    return {
      result: `❌ Plan **${planTitle}** failed — ${result.error || "Unknown error"}. @plan:${resolvedPlanId}${page ? ` @page:${page.slug}` : ""}`,
      error: true,
    };
  }
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
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), planScopeColumns),
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
          getCurrentPrincipalOrSystem(),
          planStepScopeColumns,
        ),
        planId: meta.id,
        position: i,
        title: step.title,
        instructions: instructions.get(i) || `Execute step: ${step.title}`,
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
      result: `👀 Plan **${planTitle}** needs review. Use plan(action: "resume", planId: "${meta.id}") to approve and continue. @plan:${meta.id} @page:${page.slug}`,
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

  const setFields: Record<string, any> = { updatedAt: new Date() };
  const requestedStatus = args.status as string | undefined;
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
          getCurrentPrincipalOrSystem(),
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
      if (edit.status) {
        if (!validStatuses.has(edit.status)) {
          return {
            result: `Invalid status "${edit.status}" for step "${edit.stepId}". Use pending, completed, failed, skipped, blocked, or needs_review.`,
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

  const newSteps = args.newSteps as Array<{
    title: string;
    instructions: string;
  }>;
  if (!Array.isArray(newSteps) || newSteps.length === 0) {
    return { result: "Missing required 'newSteps' array.", error: true };
  }

  const resolved = await resolvePlanWithPage(planId);
  if (!resolved) return planNotFound(planId);
  const { plan, page } = resolved;
  const resolvedPlanId = plan.id;

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
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), planStepScopeColumns),
      planId: resolvedPlanId,
      position: insertAfterPosition + 1 + i,
      title: newSteps[i].title,
      instructions: newSteps[i].instructions,
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

  if (plan.status !== "paused" && plan.status !== "needs_review") {
    return {
      result: `Plan status is "${plan.status}" — can only resume paused or review-pending plans.`,
      error: true,
    };
  }

  const sessionId = (args._sessionId as string) || plan.originSessionId;
  const planTitle = (page?.title || "Untitled Plan").replace(/^Plan:\s*/, "");

  const { resumePlan } = await import("../plan-executor");

  if (!plan.blocking) {
    resumePlan(resolvedPlanId, sessionId, planTitle, false).catch((err) => {
      log.error(
        `[${resolvedPlanId}] Background resume failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return { result: `Plan **${planTitle}** resumed in background.` };
  }

  const result = await resumePlan(resolvedPlanId, sessionId, planTitle, true);

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
