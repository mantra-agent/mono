import type { Express } from "express";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { eventBus } from "../event-bus";
import { fileTaskStorage } from "../file-storage/tasks";
import { logWellnessActivity } from "./wellness";
import {
  generateSimpleFeed,
  installSimpleFeedCacheInvalidation,
  invalidateSimpleFeedCache,
} from "../simple/generate-feed";
import { goalsService } from "../goals-service";
import { dismissPeopleSurface, snoozePeopleSurface } from "../simple/people-surface-state";
import { dismissBuildDeploymentHomeItem } from "../mods/build-deployment-home";
import { dismissReportedIssueHomeItem } from "../mods/reported-issue-home";
import { chatFileStorage } from "../chat-file-storage";
import { emailDraftStorage } from "../email-draft-storage";
import { updatePlanStatus } from "../plan-service";
import { db } from "../db";
import { planExecutions } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { combineWithWritableScope } from "../scoped-storage";
import type { GoalHorizon } from "@shared/models/goals";
import type { Principal } from "../principal";

const log = createLogger("SimpleRoutes");

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function periodToHorizon(period: string): GoalHorizon | null {
  if (period === "daily" || period === "next_day" || period === "today") return "today";
  if (period === "weekly" || period === "next_week" || period === "this_week") return "this_week";
  if (period === "monthly" || period === "next_month" || period === "this_month") return "this_month";
  if (period === "this_quarter") return "this_quarter";
  if (period === "this_year") return "this_year";
  if (period === "three_year") return "three_year";
  if (period === "ten_year") return "ten_year";
  if (period === "lifetime") return "lifetime";
  return null;
}

async function completePriority(payload: Record<string, unknown>) {
  const period = stringValue(payload.period);
  const date = stringValue(payload.date);
  const title = stringValue(payload.title);
  const priorityId = stringValue(payload.priorityId);
  const horizon = period ? periodToHorizon(period) : null;

  if (!period || !horizon || (!title && !priorityId)) {
    const missing = [!period && "period", !horizon && "valid period", !title && !priorityId && "title or priorityId"].filter(Boolean).join(", ");
    const err = new Error(`Missing priority completion fields: ${missing}`);
    (err as any).statusCode = 400;
    throw err;
  }

  // If we have a priorityId (goal ID), update directly
  if (priorityId) {
    const goal = await goalsService.get(priorityId);
    if (!goal) {
      const err = new Error("Priority not found");
      (err as any).statusCode = 404;
      throw err;
    }
    await goalsService.setStatus(priorityId, "achieved");
    eventBus.publish({ category: "goals", event: "goal:completed", payload: { goalId: priorityId, horizon } });
    return { ok: true, type: "priority", date, horizon, title: goal.shortName };
  }

  // Fallback: find by title in the period
  const result = await goalsService.markPriorityStatus(title!, "completed", horizon, date);
  if ("error" in result) {
    const err = new Error(result.error);
    (err as any).statusCode = 404;
    throw err;
  }

  eventBus.publish({ category: "goals", event: "goal:completed", payload: { goalId: result.updated.id, horizon } });
  return { ok: true, type: "priority", date, horizon, title: result.updated.shortName };
}

async function completeWellness(payload: Record<string, unknown>) {
  const activityId = numberValue(payload.activityId);
  if (!activityId) {
    const err = new Error("activityId is required");
    (err as any).statusCode = 400;
    throw err;
  }

  const result = await logWellnessActivity(activityId);
  if ("duplicate" in result) return { ok: true, type: "wellness", activityId, duplicate: true };
  return { ok: true, type: "wellness", activityId, logId: result.id };
}

async function completeTask(payload: Record<string, unknown>) {
  const taskId = numberValue(payload.taskId);
  if (!taskId) {
    const err = new Error("taskId is required");
    (err as any).statusCode = 400;
    throw err;
  }

  const task = await fileTaskStorage.updateTask(taskId, { status: "done" });
  if (!task) {
    const err = new Error(`Task ${taskId} not found`);
    (err as any).statusCode = 404;
    throw err;
  }

  return { ok: true, type: "task", taskId, title: task.title };
}

async function completeBuildDeployment(
  principal: Principal,
  payload: Record<string, unknown>,
) {
  const projectionId = stringValue(payload.projectionId);
  const reasonKey = stringValue(payload.reasonKey);
  if (!projectionId || !reasonKey) {
    const err = new Error("projectionId and reasonKey are required");
    (err as any).statusCode = 400;
    throw err;
  }
  const dismissed = await dismissBuildDeploymentHomeItem(principal, projectionId, reasonKey);
  if (!dismissed) {
    // Projection advanced, Build inactive, or feed race — not a server defect.
    // Treat as idempotent clear so Home check-circle races do not page ERRORS.
    return { ok: true, type: "build_deployment", projectionId, alreadyGone: true };
  }
  return { ok: true, type: "build_deployment", projectionId };
}

async function completeReportedIssue(
  principal: Principal,
  homeItemId: string | null,
  payload: Record<string, unknown>,
) {
  const issueId = numberValue(payload.issueId);
  const reasonKey = stringValue(payload.reasonKey);
  if (!issueId || !reasonKey) {
    const err = new Error("issueId and reasonKey are required");
    (err as any).statusCode = 400;
    throw err;
  }
  if (homeItemId && homeItemId !== `reported-issue-${issueId}`) {
    const err = new Error("Home item identity does not match reported Issue");
    (err as any).statusCode = 400;
    throw err;
  }
  const dismissed = await dismissReportedIssueHomeItem(principal, issueId, reasonKey);
  if (!dismissed) {
    // Build/permission gate or concurrent clear — client race, not ERRORS.
    return { ok: true, type: "reported_issue", issueId, alreadyGone: true };
  }
  return { ok: true, type: "reported_issue", issueId };
}

/**
 * Home INBOX check-circle clear for Session Menu REVIEW rows.
 * Clears the owning producers so the session leaves REVIEW:
 * undismissed system notices, active questions, needs_review plans (paused),
 * and unsent session-linked email drafts (discarded).
 */
async function completeSessionReview(
  principal: Principal,
  homeItemId: string | null,
  payload: Record<string, unknown>,
) {
  const sessionId = stringValue(payload.sessionId);
  if (!sessionId) {
    const err = new Error("sessionId is required");
    (err as any).statusCode = 400;
    throw err;
  }
  if (homeItemId && homeItemId !== `session-review-${sessionId}`) {
    const err = new Error("Home item identity does not match session review");
    (err as any).statusCode = 400;
    throw err;
  }
  if (principal.actorType !== "user") {
    const err = new Error("Session review clear requires an authenticated user");
    (err as any).statusCode = 403;
    throw err;
  }

  const session = await chatFileStorage.getSession(sessionId);
  if (!session) {
    const err = new Error("Session not found");
    (err as any).statusCode = 404;
    throw err;
  }

  const notices = await chatFileStorage.dismissAllSystemNotices(sessionId);
  const question = await chatFileStorage.recordQuestionCancellation(
    sessionId,
    "user_cancelled",
  );

  const planScopeColumns = {
    ownerUserId: planExecutions.ownerUserId,
    accountId: planExecutions.accountId,
  };
  const planRows = await db
    .select({ id: planExecutions.id })
    .from(planExecutions)
    .where(
      combineWithWritableScope(
        principal,
        planScopeColumns,
        and(
          eq(planExecutions.originSessionId, sessionId),
          eq(planExecutions.status, "needs_review"),
          isNull(planExecutions.archivedAt),
        ),
      ),
    );
  let plansPaused = 0;
  for (const row of planRows) {
    await updatePlanStatus(row.id, "paused");
    plansPaused += 1;
  }

  const draftIds = await emailDraftStorage.listDraftIdsBySession(principal, sessionId);
  let draftsDiscarded = 0;
  for (const draftId of draftIds) {
    const discarded = await emailDraftStorage.discard(principal, draftId);
    if (discarded) draftsDiscarded += 1;
  }

  const clearedSomething =
    notices.dismissed > 0
    || question.outcome === "cancelled"
    || plansPaused > 0
    || draftsDiscarded > 0
    || Boolean(session.errorSeverity)
    || Boolean(session.awaitingQuestionResponse);

  if (!clearedSomething) {
    // Idempotent clear: row may already be gone after a concurrent resolve.
    return {
      ok: true,
      type: "session_review",
      sessionId,
      noticesDismissed: notices.dismissed,
      questionCancelled: false,
      plansPaused,
      draftsDiscarded,
    };
  }

  return {
    ok: true,
    type: "session_review",
    sessionId,
    noticesDismissed: notices.dismissed,
    questionCancelled: question.outcome === "cancelled",
    plansPaused,
    draftsDiscarded,
  };
}

export function registerHomeRoutes(app: Express) {
  installSimpleFeedCacheInvalidation();

  app.get("/api/home/feed", requireAuth, async (req, res) => {
    try {
      const refresh = req.query.refresh === "true";
      const useModel = req.query.model === "true";
      const accountId = req.principal?.accountId || "";
      const feed = await generateSimpleFeed({ refresh, useModel, accountId });
      res.json(feed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`GET /api/home/feed failed: ${message}`);
      res.status(500).json({ error: message, operation: "get_home_feed" });
    }
  });

  app.patch("/api/home/people/:personId/surface", requireAuth, async (req, res) => {
    const personId = stringValue(req.params.personId);
    const action = stringValue(req.body?.action);
    try {
      if (!personId) return res.status(400).json({ error: "personId is required" });
      if (action === "dismiss") {
        const reasonKey = stringValue(req.body?.reasonKey);
        if (!reasonKey) return res.status(400).json({ error: "reasonKey is required" });
        const state = await dismissPeopleSurface(personId, reasonKey);
        invalidateSimpleFeedCache(req.principal?.accountId || undefined);
        return res.json({ ok: true, personId, state });
      }
      if (action === "snooze") {
        const reasonKey = stringValue(req.body?.reasonKey);
        const rawUntil = stringValue(req.body?.snoozedUntil);
        if (!reasonKey) return res.status(400).json({ error: "reasonKey is required" });
        if (!rawUntil) return res.status(400).json({ error: "snoozedUntil is required" });
        const snoozedUntil = new Date(rawUntil);
        if (Number.isNaN(snoozedUntil.getTime())) return res.status(400).json({ error: "Invalid snoozedUntil" });
        const state = await snoozePeopleSurface(personId, reasonKey, snoozedUntil);
        invalidateSimpleFeedCache(req.principal?.accountId || undefined);
        return res.json({ ok: true, personId, state });
      }
      return res.status(400).json({ error: "action must be dismiss or snooze" });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
      log.error(`PATCH /api/home/people/${personId}/surface failed: ${message}`);
      res.status(status).json({ error: message, operation: "update_home_people_surface" });
    }
  });

  app.post("/api/home/items/:id/complete", requireAuth, async (req, res) => {
    try {
      const sourceType = stringValue(req.body?.sourceType);
      const payload = (req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {}) as Record<string, unknown>;
      const homeItemId = stringValue(req.params.id);
      const buildProjectionId = stringValue(payload.projectionId);
      if (payload.kind === "build_deployment" && (!homeItemId || !buildProjectionId || homeItemId !== `build-deployment-${buildProjectionId}`)) {
        return res.status(400).json({ error: "Home item identity does not match Build deployment projection" });
      }
      if (payload.kind === "session_review") {
        const sessionId = stringValue(payload.sessionId);
        if (!homeItemId || !sessionId || homeItemId !== `session-review-${sessionId}`) {
          return res.status(400).json({ error: "Home item identity does not match session review" });
        }
      }
      if (payload.kind === "reported_issue") {
        const issueId = numberValue(payload.issueId);
        if (!homeItemId || !issueId || homeItemId !== `reported-issue-${issueId}`) {
          return res.status(400).json({ error: "Home item identity does not match reported Issue" });
        }
      }
      const isBuildDeploymentComplete =
        (sourceType === "build" || sourceType === "artifact")
        && payload.kind === "build_deployment"
        && Boolean(req.principal);
      const isSessionReviewComplete =
        sourceType === "session"
        && payload.kind === "session_review"
        && Boolean(req.principal);
      const isReportedIssueComplete =
        sourceType === "issue"
        && payload.kind === "reported_issue"
        && Boolean(req.principal);
      const result = sourceType === "wellness"
        ? await completeWellness(payload)
        : sourceType === "priority" || sourceType === "goal"
          ? await completePriority(payload)
          : sourceType === "task"
            ? await completeTask(payload)
            : isBuildDeploymentComplete
              ? await completeBuildDeployment(req.principal!, payload)
              : isSessionReviewComplete
                ? await completeSessionReview(req.principal!, homeItemId, payload)
                : isReportedIssueComplete
                  ? await completeReportedIssue(req.principal!, homeItemId, payload)
                  : null;

      if (!result) return res.status(400).json({ error: "Unsupported Home completion source" });
      // Complete mutates Home producers (dismissals, task/goal/wellness status,
      // session review). Client onSettled refetches /api/home/feed without
      // refresh=true, so the process-local same-day cache must drop here or
      // optimistic check-circle clears bounce back from a stale feed.
      invalidateSimpleFeedCache(req.principal?.accountId || undefined);
      res.json(result);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
      // 4xx is caller/input or gone state (stale feed, missing fields) — warn only.
      // 5xx remains error so real producer failures still page ERRORS.
      if (status >= 400 && status < 500) {
        log.warn(`POST /api/home/items/${req.params.id}/complete failed: ${message}`);
      } else {
        log.error(`POST /api/home/items/${req.params.id}/complete failed: ${message}`);
      }
      res.status(status).json({ error: message, operation: "complete_home_item" });
    }
  });
}
