// Use createLogger for logging ONLY
import type { Express, Request, Response, RequestHandler } from "express";
import * as fsPromises from "fs/promises";
import { chatStorage } from "./storage";
import { storage } from "../../storage";
import { searchSessionSummaries, type SegmentChronologyEntry } from "../../chat-file-storage";
import type { SessionStreamEvent } from "../../session-manager";
import { projectAssistantDraft } from "../../assistant-draft-projection";
import { WORKSPACE_DIR } from "../../paths";
import { ACTIVITY_CHAT } from "../../job-profiles";
import { resolveModelCandidates, type ModelRoutingDecision } from "../../model-routing";
import { normalizeSessionModelTierOverride } from "../../session-model-tier-override";
import { agentExecutor } from "../../agent-executor";
import { assembleContext } from "../../agent-context";
import { renderContinuationCapsule } from "../../continuation-capsule";
import type { ContinuationCapsule } from "@shared/models/chat";
import { isCommittedContextMessage } from "../../compaction-snapshot";
import { getToolSchemas as getToolDefinitions } from "../../tool-registry";
import { executeTool } from "../../bridge-tools";
import type {
  ExecutorMessage,
  ToolDefinition,
  ContentBlock,
  ExecutorRunResult,
} from "../../agent-executor";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ObjectStorageService } from "../../object_storage/objectStorage";
import multer from "multer";
import {
  writeJournal,
  getActiveRunJournal,
  getSessionRunStatus,
  type JournalEntry,
} from "../../chat-journal";
import { documentStorage } from "../../memory/document-storage";
import { eventBus } from "../../event-bus";
import { sessionManager } from "../../session-manager";
// logApiCall import removed — inference recording is handled at the model-client boundary.
import { generateToolCallId } from "../../file-storage/utils";
import { formatMessageTimestamp, nowMessageTimestamp } from "../../timezone";
import { abortTrace } from "../../abort-trace";
import { deferStatusSaved } from "./abort-defer";
import { chatRunLifecycle, ChatRunInvalidatedError, type ChatRunLease } from "./run-lifecycle";
import { timerStorage } from "../../file-storage";
import { timerScheduler } from "../../timer-scheduler";
import { extractSessionReminderId } from "../../session-reminder-metadata";
import { getPrincipal } from "../../principal";
import { getPostgresErrorDetails } from "../../postgres-errors";
import { completeFtueSayHello } from "../../ftue-goals";
import type { Timer } from "@shared/models/timers";
import {
  parseVoiceFinalizationRequest,
  type VoiceFinalizationResponse,
} from "@shared/voice-finalization";

import {
  normalizePageContext,
  type SystemNotice,
  type ErrorSeverity,
  type MeetingBotStatus,
  type MeetingSessionMeta,
  type MessageSpeakerMeta,
  type QuestionResponseMeta,
  type QuestionCancellationMeta,
} from "@shared/models/chat";
import { getActiveQuestionToolCallId, type QuestionPrompt } from "@shared/question-prompt";
import { BOOT_ID, db } from "../../db";
import { and, eq, inArray, isNull, notInArray, sql as drizzleSql, type SQL } from "drizzle-orm";
import { combineWithVisibleScope } from "../../scoped-storage";
import { libraryPages } from "@shared/models/info";
import { planExecutions } from "@shared/schema";
import { agendaDefinitionStorage } from "../../agenda-storage";
import { instantiateAgendaDefinition } from "@shared/models/agendas";
import { createLogger } from "../../log";
import { requireAuth } from "../../auth";
import { getCurrentPrincipal, requireCurrentPrincipal, runWithPrincipal } from "../../principal-context";
import { resolveQuestionResponse } from "../../question-response";
import { emailDraftStorage } from "../../email-draft-storage";

const chatLog = createLogger("ChatStream");
const objectStorageService = new ObjectStorageService();
const planScopeColumns = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
function visiblePlan(predicate?: SQL): SQL { return combineWithVisibleScope(requireCurrentPrincipal(), planScopeColumns, predicate); }

function isLiveSessionStatus(session: { id: string }): boolean {
  return sessionManager.getSnapshot(session.id)?.runActive === true;
}

type SessionReminderState = { active: true; timerId: string; fireAt: string | null; nextBoot: boolean; nextBuild: boolean };

function getSessionReminderState(timer: Timer): SessionReminderState | null {
  if (timer.type !== "reminder" || !timer.enabled) return null;
  if (!extractSessionReminderId(timer.description ?? "")) return null;
  const schedule = timer.schedules[0];
  const nextBoot = !!schedule?.fireOnNextBoot;
  const nextBuild = !!schedule?.fireOnNextBuild;
  const nextRunTimes = timerScheduler.getNextRunTimes();
  return {
    active: true,
    timerId: timer.id,
    fireAt: nextBoot || nextBuild ? null : (schedule?.fireAt || nextRunTimes[timer.id] || null),
    nextBoot,
    nextBuild,
  };
}

async function getSessionReminderMap(): Promise<Map<string, SessionReminderState>> {
  const reminders = new Map<string, SessionReminderState>();
  const timers = await timerStorage.getAll();
  for (const timer of timers) {
    const state = getSessionReminderState(timer);
    if (!state) continue;
    const sessionId = extractSessionReminderId(timer.description);
    if (!sessionId) continue;
    reminders.set(sessionId, state);
  }
  return reminders;
}

// The lifecycle lease is the single authority for preparation, execution,
// persistence, and finalization. A newer accepted message replaces the lease.
export function getInFlightChatSessions(): Array<{
  sessionId: string;
  startedAt: number;
  sessionKey?: string;
  runId?: string;
}> {
  return chatRunLifecycle.list();
}

export function _annotateChatStreamRunId(sessionId: string, runId: string): void {
  chatRunLifecycle.annotateRunId(sessionId, runId);
}

// Throttle the orphan-warning log so it doesn't spam every 5-second poll.
// We log the first time we see a count, every time the count changes, and
// at most once per cooldown otherwise.
const ORPHAN_LOG_COOLDOWN_MS = 5 * 60 * 1000;
let lastOrphanCount = -1;
let lastOrphanLogAt = 0;
function logOrphanCountIfChanged(orphanCount: number): void {
  if (orphanCount === 0) {
    lastOrphanCount = 0;
    return;
  }
  const now = Date.now();
  if (
    orphanCount !== lastOrphanCount ||
    now - lastOrphanLogAt >= ORPHAN_LOG_COOLDOWN_MS
  ) {
    chatLog.warn(
      `[SessionTree] /api/sessions: ${orphanCount} child session(s) have a parentSessionId that no longer resolves — surfacing as parentMissing top-level`,
    );
    lastOrphanCount = orphanCount;
    lastOrphanLogAt = now;
  }
}

const PLAN_SESSION_QUERY_CHUNK_SIZE = 250;

/**
 * One chunked round-trip pair for /api/sessions plan badges.
 * Library pages supply hasPlan; plan_executions supply hasActivePlan + plan_review.
 * Sessions with an in-flight plan must stay active between child steps.
 */
async function getPlanBadgeSessionIds(sessionIds: string[]): Promise<{
  planSessionIds: Set<string>;
  executingPlanSessionIds: Set<string>;
  reviewPlanSessionIds: Set<string>;
}> {
  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  const planSessionIds = new Set<string>();
  const executingPlanSessionIds = new Set<string>();
  const reviewPlanSessionIds = new Set<string>();
  if (uniqueSessionIds.length === 0) {
    return { planSessionIds, executingPlanSessionIds, reviewPlanSessionIds };
  }

  for (let i = 0; i < uniqueSessionIds.length; i += PLAN_SESSION_QUERY_CHUNK_SIZE) {
    const chunk = uniqueSessionIds.slice(i, i + PLAN_SESSION_QUERY_CHUNK_SIZE);
    const [pages, planRows] = await Promise.all([
      db
        .select({ sessionId: libraryPages.createdBySessionId })
        .from(libraryPages)
        .where(
          and(
            inArray(libraryPages.createdBySessionId, chunk),
            drizzleSql`${libraryPages.tags} @> ARRAY['plan']::text[]`,
          ),
        ),
      db
        .select({
          sessionId: planExecutions.originSessionId,
          status: planExecutions.status,
        })
        .from(planExecutions)
        .where(
          visiblePlan(
            and(
              inArray(planExecutions.originSessionId, chunk),
              inArray(planExecutions.status, ["executing", "needs_review"]),
              isNull(planExecutions.archivedAt),
            ),
          ),
        ),
    ]);

    for (const page of pages) {
      if (page.sessionId) planSessionIds.add(page.sessionId);
    }
    for (const row of planRows) {
      if (!row.sessionId) continue;
      if (row.status === "executing") executingPlanSessionIds.add(row.sessionId);
      else if (row.status === "needs_review") reviewPlanSessionIds.add(row.sessionId);
    }
  }

  return { planSessionIds, executingPlanSessionIds, reviewPlanSessionIds };
}

const SENSITIVE_PATTERNS = [
  /api[_-]?key[=:]\s*\S+/gi,
  /token[=:]\s*\S+/gi,
  /secret[=:]\s*\S+/gi,
  /password[=:]\s*\S+/gi,
  /authorization[=:]\s*\S+/gi,
  /bearer\s+\S+/gi,
  /-----BEGIN\s[\s\S]*?-----END[^-]*-----/g,
];

function sanitizeErrorForUser(error: string): string {
  let sanitized = error.slice(0, 200);
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized;
}

function describeAbortReasonForUser(result: ExecutorRunResult): string | null {
  const durationMs = result.durationMs ?? undefined;
  const duration =
    durationMs != null
      ? `${(durationMs / 60000).toFixed(1)} minutes`
      : "unknown duration";
  const toolCallCount = result.toolCalls?.length ?? 0;
  const toolText =
    toolCallCount > 0
      ? ` after ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}`
      : "";

  switch (result.abortReason) {
    case "stream_idle_timeout":
      return `Timeout: the model provider stream stopped making progress (${duration}). This was not user-cancelled, and earlier tool activity remains valid.`;
    case "idle_timeout":
      return `Timeout: executor activity watchdog stopped the run after no stream/tool activity (${duration}). This was not user-cancelled.`;
    case "pipeline_timeout":
      return `Timeout: pipeline watchdog stopped the run after ${duration}${toolText}.`;
    case "run_time_limit":
      return `Execution time limit reached after ${duration}${toolText}. This was not a processing error or user cancellation.`;
    case "zombie_timeout":
      return `Executor activity watchdog stopped the run after ${duration}${toolText}. This was not a user cancellation.`;
    case "cancelled":
      return `Cancelled: an upstream controller stopped the run${toolText}. This may be a parent plan, stop action, superseding retry, or shutdown.`;
    case "superseded":
      return `Superseded: user sent a new message while the run was active${toolText}. A new run will start automatically.`;
    case "circuit_breaker":
      return `Stopped: repeated tool-failure guard stopped the run${toolText}.`;
    case "error":
      return "Stopped: the executor reported an internal processing error.";
    default:
      return null;
  }
}

function buildSystemNotice(result: ExecutorRunResult): SystemNotice {
  const durationMs = result.durationMs ?? undefined;
  const toolCallCount = result.toolCalls?.length ?? 0;
  const iterationsUsed = result.iterations;
  const rawError = result.error ? sanitizeErrorForUser(result.error) : "";

  // Determine severity: warnings for limit-type terminations, errors for failures
  let severity: ErrorSeverity = "error";
  let errorType = "something_went_wrong";
  let description = "Something went wrong during processing.";
  let actionHint = "Try sending your message again.";

  if (result.status === "degraded" && result.degradationReason === "empty_response_output_limit") {
    severity = "warning";
    errorType = "response_incomplete";
    description = "The response reached the model's output limit before any final text was produced. Earlier completed tool work remains saved.";
    actionHint = "Send another message and I'll continue from the last completed step.";
  } else if (result.status === "degraded" && result.degradationReason === "empty_response") {
    severity = "warning";
    errorType = "response_incomplete";
    description = "The model finished without returning any visible text. Earlier completed tool work remains saved.";
    actionHint = "Send another message and I'll continue from the last completed step.";
  } else if (result.status === "degraded" && result.degradationReason === "tool_failure_recovered") {
    // Non-retryable tool failure already synthesized a recovery assistant message.
    // Surface as a warning, not a hard error — work was preserved and the turn ended cleanly.
    severity = "warning";
    errorType = "processing_stopped";
    description = "A tool returned a non-retryable failure. Completed work before the failure was preserved.";
    actionHint = "Send another message with corrected input or permission and I'll continue.";
  } else if (
    result.status === "degraded" &&
    (result.degradationReason === "iteration_budget_exhausted" || result.degradationReason === "tool_call_budget_exhausted")
  ) {
    severity = "warning";
    errorType = "processing_stopped";
    description = result.degradationReason === "iteration_budget_exhausted"
      ? "This run reached its model-iteration budget. Completed work was preserved."
      : "This run reached its tool-call budget. No additional tool was executed, and completed work was preserved.";
    actionHint = "Send another message and I'll continue from the saved state.";
  } else if (result.abortReason) {
    switch (result.abortReason) {
      case "stream_idle_timeout":
        errorType = "response_interrupted";
        description = `The model provider stream stopped making progress${durationMs != null ? ` after ${(durationMs / 60000).toFixed(1)} minutes` : ""}. This was not user-cancelled, and earlier tool activity remains valid.`;
        actionHint =
          "Resume or send another message and I'll continue where I left off.";
        break;
      case "idle_timeout":
        errorType = "response_interrupted";
        description = `Executor activity watchdog stopped the run after no stream/tool activity${durationMs != null ? ` for ${(durationMs / 60000).toFixed(1)} minutes` : ""}. This was not user-cancelled.`;
        actionHint =
          "Resume or send another message and I'll continue where I left off.";
        break;
      case "pipeline_timeout":
        errorType = "response_interrupted";
        description = `Overall time limit reached${durationMs != null ? ` after ${(durationMs / 60000).toFixed(1)} minutes` : ""}${toolCallCount > 0 ? ` and ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}` : ""}.`;
        actionHint = "Send another message and I'll continue where I left off.";
        break;
      case "cancelled":
        severity = "warning";
        errorType = "user_stopped";
        description = "Response stopped by user.";
        actionHint = "Send a new message to continue.";
        break;
      case "superseded":
        // User sent a new message; the new run is starting automatically.
        // No notice needed — returning minimal warning so the old response
        // just ends quietly without an alarming banner.
        severity = "warning";
        errorType = "user_stopped";
        description = "";
        actionHint = "";
        break;
      case "error":
        errorType = "something_went_wrong";
        description = rawError
          ? `Processing error: ${rawError}`
          : "Something went wrong during processing.";
        actionHint = "Try sending your message again.";
        break;
      case "circuit_breaker":
        errorType = "processing_stopped";
        description = `Repeated tool-failure guard stopped the run${toolCallCount > 0 ? ` after ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}` : ""}.`;
        actionHint =
          "Retry from the last useful result, avoiding the repeated failing call.";
        break;
      case "run_time_limit":
        severity = "warning";
        errorType = "response_interrupted";
        description = `Execution time limit reached${durationMs != null ? ` after ${(durationMs / 60000).toFixed(1)} minutes` : ""}${toolCallCount > 0 ? ` and ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}` : ""}. The execution watchdog stopped the run. This was not a processing error or user cancellation.`;
        actionHint = "Send another message and I'll continue where I left off.";
        break;
      case "zombie_timeout":
        severity = "warning";
        errorType = "response_interrupted";
        description = `Executor activity watchdog stopped the run${durationMs != null ? ` after ${(durationMs / 60000).toFixed(1)} minutes` : ""}${toolCallCount > 0 ? ` and ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}` : ""}. This was not a processing error or user cancellation.`;
        actionHint = "Send another message and I'll continue where I left off.";
        break;
    }
  } else if (result.terminationReason) {
    switch (result.terminationReason) {
      case "yield_to_interactive":
        severity = "warning";
        errorType = "processing_stopped";
        description = "Paused to let you respond.";
        actionHint = "Reply when you're ready.";
        break;
      case "aborted":
        errorType = "response_interrupted";
        description = rawError
          ? `Response was interrupted: ${rawError}`
          : `Response was interrupted${durationMs != null ? ` after ${(durationMs / 60000).toFixed(1)} minutes` : ""}${toolCallCount > 0 ? ` and ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}` : ""}.`;
        actionHint = "Send another message to continue.";
        break;
      case "circuit_breaker":
        errorType = "processing_stopped";
        description = rawError
          ? `Safety limit triggered: ${rawError}`
          : "Safety limit triggered.";
        actionHint = "Send another message and I'll continue.";
        break;
      case "error":
        errorType = "something_went_wrong";
        description = rawError
          ? `Processing error: ${rawError}`
          : "Something went wrong during processing.";
        actionHint = "Try sending your message again.";
        break;
    }
  }

  return {
    severity,
    errorType,
    description,
    actionHint,
    terminationReason: result.terminationReason,
    abortReason: result.abortReason,
    degradationReason: result.degradationReason,
    lastStopReason: result.lastStopReason,
    iterationsUsed,
    durationMs,
    toolCallCount,
  };
}

function publishChatStreamEvent(
  sessionKey: string,
  sessionId: string,
  payload: Record<string, unknown>,
) {
  chatLog.verbose(() => `STREAM:PUBLISH type=${payload.type} session=${sessionId} key=${sessionKey}`);
  eventBus.publish({
    category: "chat",
    event: "chat.stream",
    payload: { ...payload, sessionKey, sessionId },
    sessionKey,
  });
}

export async function registerChatRoutes(app: Express): Promise<void> {
  const {
    clearMeetingVisualizerState,
    interruptMeetingSpeech,
    outputMediaSession,
    registerMeetingVisualizerTransport,
    sendNextMeetingAudio,
    setMeetingVisualizerState,
    syncMeetingVisualizerBotStatus,
  } = await import("../../meeting/output-media");
  app.locals.meetingVisualizerUpgrade = registerMeetingVisualizerTransport();
  app.get("/api/meeting-output/:token", (req, res) => {
    if (!outputMediaSession(req.params.token as string)) return res.status(401).send("Invalid or expired meeting output token");
    res.redirect(307, `/visualizer?token=${encodeURIComponent(req.params.token as string)}`);
  });
  app.get("/api/meeting-output/:token/audio", async (req, res) => {
    const sessionId = outputMediaSession(req.params.token as string);
    if (!sessionId) return res.status(401).end();
    const requestAbort = new AbortController();
    res.once("close", () => requestAbort.abort());
    try {
      await sendNextMeetingAudio(sessionId, res, requestAbort.signal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (req.destroyed || res.destroyed) {
        chatLog.warn(`meeting audio client disconnected sessionId=${sessionId}: ${detail}`);
        return;
      }
      chatLog.error(`meeting audio stream failed sessionId=${sessionId}: ${detail}`);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error instanceof Error ? error : new Error(detail));
    }
  });
  app.use(["/api/sessions", "/api/chat"], requireAuth);
  app.get("/api/sessions/search", async (req: Request, res: Response) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!query) return res.json([]);
      if (query.length > 500) {
        return res.status(400).json({ error: "Search query is too long" });
      }

      const matches = await searchSessionSummaries(query, 24 * 30, 100);
      const sessions = await chatStorage.getSessions(matches.map((match) => match.id));
      const rankById = new Map(matches.map((match, index) => [match.id, index]));
      sessions.sort(
        (left, right) =>
          (rankById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (rankById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
      res.json(sessions);
    } catch (error) {
      chatLog.error("Error searching sessions:", error);
      res.status(500).json({ error: "Failed to search sessions" });
    }
  });

  app.get("/api/sessions", async (req: Request, res: Response) => {
    try {
      const reminderMap = await getSessionReminderMap();
      const view = typeof req.query.view === "string" ? req.query.view : "all";
      const supportedView = view === "primary" || view === "past" || view === "snooze" || view === "archive"
        ? view
        : null;
      const snoozedSessionIds = [...reminderMap.keys()];
      const all = supportedView
        ? await chatStorage.getSessionsForView(supportedView, snoozedSessionIds)
        : await chatStorage.getAllSessions();
      const principal = req.principal;
      if (!principal) return res.status(401).json({ error: "Not authenticated" });
      const emailReviewKindsBySession = await emailDraftStorage.getPendingReviewKindsBySession(
        principal,
        all.map((session) => session.id),
      );
      // The session menu loads its immediately useful working set first, then
      // requests collapsed historical sections on disclosure. Keep the
      // unqualified route as the full canonical index for non-menu consumers.
      // View-specific reads are already filtered and bounded by chat storage.
      // The unqualified route remains the full canonical session index.
      const visible = all;
      const allIds = new Set(all.map((s) => s.id));
      const visibleIds = new Set(visible.map((s) => s.id));
      const childCounts = new Map<string, number>();
      let orphanCount = 0;
      for (const s of visible) {
        if (s.parentSessionId && allIds.has(s.parentSessionId)) {
          // Count under the parent for sidebar badging only when the parent
          // is itself visible — otherwise the count would attach to a
          // non-rendered parent.
          if (visibleIds.has(s.parentSessionId)) {
            childCounts.set(
              s.parentSessionId,
              (childCounts.get(s.parentSessionId) || 0) + 1,
            );
          }
        } else if (s.parentSessionId) {
          orphanCount++;
        }
      }
      logOrphanCountIfChanged(orphanCount);
      const topLevelOnly =
        req.query.topLevel === "true" || req.query.topLevel === "1";
      const filtered = topLevelOnly
        ? visible.filter(
            (s) => !s.parentSessionId || !allIds.has(s.parentSessionId),
          )
        : visible;
      // Detect plans only for sessions returned by this request. The previous
      // implementation scanned every plan-tagged Library page on each sidebar
      // poll, which saturated the DB pool after the session-management deploy.
      const filteredIds = filtered.map((s) => s.id);
      const { planSessionIds, executingPlanSessionIds, reviewPlanSessionIds } =
        await getPlanBadgeSessionIds(filteredIds);

      // Compute which sessions have active (streaming) descendants
      // Walk the tree bottom-up: if a session is streaming, mark all ancestors
      const activeDescendantIds = new Set<string>();
      const streamingIds = new Set(
        visible.filter(isLiveSessionStatus).map((s) => s.id),
      );
      const parentMap = new Map<string, string>();
      for (const s of visible) {
        if (s.parentSessionId && allIds.has(s.parentSessionId)) {
          parentMap.set(s.id, s.parentSessionId);
        }
      }
      for (const streamId of streamingIds) {
        let cursor = parentMap.get(streamId);
        while (cursor) {
          if (activeDescendantIds.has(cursor)) break; // already propagated
          activeDescendantIds.add(cursor);
          cursor = parentMap.get(cursor);
        }
      }

      // System-notice error/warning REVIEW is an operator diagnostic, not an
      // ordinary user attention. Only principals holding system:read see the
      // error/warning rows (or the underlying errorSeverity the client falls
      // back to); everyone still sees question/plan/email review normally.
      const canSeeSystemAttention = principal.permissions.includes("system:read");
      const sessions = filtered.map((s) => {
        const reviewKinds = [
          ...(s.awaitingQuestionResponse ? (["question"] as const) : []),
          ...(reviewPlanSessionIds.has(s.id) ? (["plan_review"] as const) : []),
          ...(emailReviewKindsBySession.get(s.id) ?? []),
          // errorSeverity is the durable undismissed system-notice flag. Opening
          // the session must not clear it; only explicit notice dismiss does.
          ...(canSeeSystemAttention && s.errorSeverity === "error"
            ? (["error"] as const)
            : []),
          ...(canSeeSystemAttention &&
          (s.errorSeverity === "warning" || s.errorSeverity === "warn")
            ? (["warning"] as const)
            : []),
        ];
        return {
          ...s,
          // Hide the raw severity flag from non-admins so the client REVIEW
          // fallback and title coloring cannot resurface it.
          errorSeverity: canSeeSystemAttention ? s.errorSeverity : null,
          awaitingReview: reviewKinds.length > 0 || undefined,
          reviewKinds: reviewKinds.length > 0 ? Array.from(new Set(reviewKinds)) : undefined,
          status: s.status === "streaming" && !isLiveSessionStatus(s) ? "saved" : s.status,
          directChildCount: childCounts.get(s.id) || 0,
          parentMissing: !!s.parentSessionId && !allIds.has(s.parentSessionId),
          hasPlan: planSessionIds.has(s.id),
          hasActivePlan: executingPlanSessionIds.has(s.id),
          hasActiveDescendant: activeDescendantIds.has(s.id),
          reminder: reminderMap.get(s.id) || { active: false },
        };
      });
      res.json(sessions);
    } catch (error) {
      chatLog.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  app.get("/api/sessions/:id/children", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const all = await chatStorage.getAllSessions();
      // Child listing follows /api/sessions: return all persisted children,
      // not only sessions in saved/streaming display states.
      const visible = all;
      const visibleIds = new Set(visible.map((s) => s.id));
      const childCounts = new Map<string, number>();
      for (const s of visible) {
        if (s.parentSessionId && visibleIds.has(s.parentSessionId)) {
          childCounts.set(
            s.parentSessionId,
            (childCounts.get(s.parentSessionId) || 0) + 1,
          );
        }
      }
      // Child expansion must stay cheap. The top-level session index owns
      // global decorations such as plan badges; fetching a single child list
      // should not rescan library_pages for every expanded node.

      // Compute active descendants among children
      const allIds = new Set(visible.map((s) => s.id));
      const activeDescendantIds = new Set<string>();
      const streamingIds = new Set(
        visible.filter(isLiveSessionStatus).map((s) => s.id),
      );
      const parentMap = new Map<string, string>();
      for (const s of visible) {
        if (s.parentSessionId && allIds.has(s.parentSessionId)) {
          parentMap.set(s.id, s.parentSessionId);
        }
      }
      for (const streamId of streamingIds) {
        let cursor = parentMap.get(streamId);
        while (cursor) {
          if (activeDescendantIds.has(cursor)) break;
          activeDescendantIds.add(cursor);
          cursor = parentMap.get(cursor);
        }
      }

      const children = visible
        .filter((s) => s.parentSessionId === id)
        .map((s) => ({
          ...s,
          status: s.status === "streaming" && !isLiveSessionStatus(s) ? "saved" : s.status,
          directChildCount: childCounts.get(s.id) || 0,
          parentMissing: false,
          hasActiveDescendant: activeDescendantIds.has(s.id),
        }));
      res.json(children);
    } catch (error) {
      chatLog.error("Error fetching session children:", error);
      res.status(500).json({ error: "Failed to fetch session children" });
    }
  });

  app.post(
    "/api/sessions/:id/spawn-child",
    async (req: Request, res: Response) => {
      try {
        const parentId = req.params.id as string;
        const parent = await chatStorage.getSession(parentId);
        if (!parent) {
          return res.status(404).json({ error: "Parent session not found" });
        }
        const { recordSpawn } = await import("../../sessions/tree");
        const { DEFAULT_ACTIVITY_ROUTING } = await import("../../job-profiles");
        const defaultTier = DEFAULT_ACTIVITY_ROUTING.chat || "high";
        const childTitle = `Child of ${parent.title || "Untitled"}`;
        const result = await recordSpawn(
          parentId,
          { spawnReason: "ui:spawn-child", spawnerTool: "ui", triggerType: "spawn", triggerId: parentId, triggerName: childTitle },
          async () => {
            const session = await chatStorage.createSession(
              childTitle,
              `dashboard:${randomUUID().slice(0, 8)}`,
              defaultTier,
              { sessionType: "user" as const, provenance: { triggerType: "spawn", triggerId: parentId, triggerName: childTitle } },
            );
            return { sessionId: session.id, session };
          },
        );
        if (result.reused) {
          const existing = await chatStorage.getSession(result.sessionId);
          return res.status(200).json(existing);
        }
        res.status(201).json((result as any).session);
      } catch (error) {
        chatLog.error("Error spawning child session:", error);
        res.status(500).json({ error: "Failed to spawn child session" });
      }
    },
  );

  app.post("/api/sessions/:id/vault", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const vaultId = typeof req.body?.vaultId === "string" ? req.body.vaultId.trim() : "";
      if (!vaultId) {
        return res.status(400).json({ error: "vaultId is required" });
      }
      const session = await chatStorage.moveSessionToVault(id, vaultId);
      res.json(session);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) {
        const statusError = error as { status: number; message: string };
        return res.status(statusError.status).json({ error: statusError.message });
      }
      chatLog.error("Error moving session to Vault:", error);
      res.status(500).json({ error: "Failed to move session to Vault" });
    }
  });

  app.post("/api/sessions/:id/move", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      const rawTarget = (req.body ?? {}).newParentId;
      const newParentId =
        typeof rawTarget === "string" && rawTarget.trim().length > 0
          ? rawTarget.trim()
          : null;
      if (newParentId === id) {
        return res
          .status(400)
          .json({ error: "Cannot move a session under itself" });
      }
      if (!newParentId) {
        await chatStorage.clearParentSessionId(id);
      } else {
        const target = await chatStorage.getSession(newParentId);
        if (!target) {
          return res.status(404).json({ error: "Target session not found" });
        }
        // Cycle prevention: the new parent must not live inside the moved
        // session's own subtree. Descendants keep their linkage; root/depth
        // are recomputed from session_tree ancestry on read.
        const all = await chatStorage.getAllSessions();
        const childrenByParent = new Map<string, string[]>();
        for (const s of all) {
          if (!s.parentSessionId) continue;
          const list = childrenByParent.get(s.parentSessionId) ?? [];
          list.push(s.id);
          childrenByParent.set(s.parentSessionId, list);
        }
        const descendants = new Set<string>();
        const pending = [...(childrenByParent.get(id) ?? [])];
        while (pending.length > 0) {
          const next = pending.pop()!;
          if (descendants.has(next)) continue;
          descendants.add(next);
          pending.push(...(childrenByParent.get(next) ?? []));
        }
        if (descendants.has(newParentId)) {
          return res
            .status(400)
            .json({ error: "Cannot move a session under its own descendant" });
        }
        await chatStorage.setParentSessionId(id, newParentId, {
          spawnReason: "ui:move",
          spawnerTool: "ui",
        });
      }
      chatLog.info(
        `Moved session ${id} from parent=${session.parentSessionId || "-"} to parent=${newParentId || "root"}`,
      );
      const updated = await chatStorage.getSession(id);
      res.json(updated);
    } catch (error) {
      chatLog.error("Error moving session:", error);
      res.status(500).json({ error: "Failed to move session" });
    }
  });

  app.get("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const snapshot = await chatStorage.getSessionSnapshot(id);
      if (!snapshot) {
        return res.status(404).json({ error: "Session not found" });
      }
      const { session, messages } = snapshot;
      const assistantMessageIds = messages
        .filter((message) => message.role === "assistant" && message.assistantState === "settled")
        .map((message) => message.id);
      const { getCompletedTurnSummaryMap } = await import("../../historical-continuity");
      const turnSummaryByMessageId = await getCompletedTurnSummaryMap(id, assistantMessageIds);
      const projectedMessages = messages.map((message) => ({
        ...message,
        historicalSummary: turnSummaryByMessageId.get(message.id),
      }));
      const TERMINAL_PLAN_STATUSES = ["completed", "completed_with_failures", "failed", "aborted"];
      const planProjection = {
        id: planExecutions.id,
        pageId: planExecutions.pageId,
        status: planExecutions.status,
      };
      const [activePlan, reviewPlan] = await Promise.all([
        db.select(planProjection)
          .from(planExecutions)
          .where(visiblePlan(and(
            eq(planExecutions.originSessionId, id),
            notInArray(planExecutions.status, TERMINAL_PLAN_STATUSES),
          )))
          .orderBy(planExecutions.createdAt)
          .limit(1)
          .then(rows => rows[0] ?? null),
        db.select(planProjection)
          .from(planExecutions)
          .where(visiblePlan(and(
            eq(planExecutions.originSessionId, id),
            eq(planExecutions.status, "needs_review"),
          )))
          .orderBy(planExecutions.createdAt)
          .limit(1)
          .then(rows => rows[0] ?? null),
      ]);
      res.json({ ...session, messages: projectedMessages, activePlan, reviewPlan });
    } catch (error) {
      chatLog.error("Error fetching session:", error);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.get(
    "/api/sessions/:id/compactions/:markerId/messages",
    async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      const markerId = req.params.markerId as string;
      try {
        const principal = getPrincipal(req);
        if (!principal) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        const messages = await chatStorage.getMessagesBySession(sessionId);
        const marker = messages.find(
          (message) =>
            message.id === markerId &&
            message.model === "compaction-marker" &&
            message.compaction?.archiveRefId,
        );
        if (!marker?.compaction?.archiveRefId) {
          return res.status(404).json({ error: "Earlier conversation unavailable" });
        }

        const [{ loadPublicCompactionMessages }, { readVisibleIndexedContent }] =
          await Promise.all([
            import("../../compaction-archive"),
            import("../../content-indexer"),
          ]);
        const archivedMessages = await loadPublicCompactionMessages(
          marker.compaction.archiveRefId,
          async (refId) => {
            const result = await readVisibleIndexedContent({
              id: refId,
              sourceType: "compaction",
            });
            return result?.content ?? null;
          },
        );

        res.setHeader("Cache-Control", "private, no-store");
        return res.status(200).json({ messages: archivedMessages });
      } catch (error) {
        const unavailable =
          error instanceof Error &&
          error.name === "CompactionArchiveUnavailableError";
        if (unavailable) {
          chatLog.warn(
            `compaction transcript unavailable sessionId=${sessionId} markerId=${markerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return res.status(404).json({ error: "Earlier conversation unavailable" });
        }
        chatLog.error(
          `compaction transcript failed sessionId=${sessionId} markerId=${markerId}:`,
          error,
        );
        return res.status(500).json({ error: "Failed to load earlier conversation" });
      }
    },
  );

  app.get(
    "/api/sessions/:id/compactions/:markerId/download",
    async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      const markerId = req.params.markerId as string;
      try {
        const principal = getPrincipal(req);
        if (!principal) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        const messages = await chatStorage.getMessagesBySession(sessionId);
        const marker = messages.find(
          (message) =>
            message.id === markerId &&
            message.model === "compaction-marker" &&
            message.compaction?.archiveRefId,
        );
        if (
          !marker?.compaction?.archiveRefId ||
          marker.compaction.archiveDownloadable !== true
        ) {
          return res.status(404).json({ error: "Compaction archive not available for download" });
        }
        const archiveRefId = marker.compaction.archiveRefId;

        const [{ renderCompactionTranscript }, { readVisibleIndexedContent }] =
          await Promise.all([
            import("../../compaction-archive"),
            import("../../content-indexer"),
          ]);
        const transcript = await renderCompactionTranscript(
          archiveRefId,
          async (refId) => {
            const result = await readVisibleIndexedContent({
              id: refId,
              sourceType: "compaction",
            });
            return result?.content ?? null;
          },
        );
        const safeTitle = (session.title || "session")
          .normalize("NFKD")
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80)
          .toLowerCase() || "session";
        const createdAt = marker.compaction?.createdAt || marker.createdAt;
        const document = [
          `# ${session.title || "Session conversation"}`,
          "",
          `Original conversation preserved before compaction on ${createdAt}.`,
          "",
          transcript,
          "",
        ].join("\n");

        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeTitle}-compacted-conversation.md"`,
        );
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(200).send(document);
      } catch (error) {
        const unavailable =
          error instanceof Error &&
          error.name === "CompactionArchiveUnavailableError";
        if (unavailable) {
          chatLog.warn(
            `compaction download unavailable sessionId=${sessionId} markerId=${markerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return res.status(404).json({ error: "Compaction archive unavailable" });
        }
        chatLog.error(
          `compaction download failed sessionId=${sessionId} markerId=${markerId}:`,
          error,
        );
        return res.status(500).json({ error: "Failed to download conversation" });
      }
    },
  );

  app.get("/api/sessions/:id/details", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const treeRow = await import("../../sessions/tree")
        .then((m) => m.getSessionTreeRow(id))
        .catch(() => null);
      const parentSessionId = session.parentSessionId || treeRow?.parentSessionId || undefined;
      const spawnReason = session.spawnReason || treeRow?.spawnReason || undefined;

      // Resolve parent/root titles in parallel
      const [
        parentSession,
        rootSession,
        artifacts,
        costResult,
        skillRunResult,
      ] = await Promise.all([
        parentSessionId
          ? chatStorage
              .getSession(parentSessionId)
              .catch(() => undefined)
          : Promise.resolve(undefined),
        session.rootSessionId && session.rootSessionId !== session.id
          ? chatStorage.getSession(session.rootSessionId).catch(() => undefined)
          : Promise.resolve(undefined),
        import("../../session-artifacts")
          .then((m) => m.getArtifactsBySession(id))
          .catch(() => []),
        import("../../file-storage/api-calls")
          .then((m) =>
            m.fileApiCallStorage.getTokenUsageByChatSession(
              id,
              session.sessionKey,
            ),
          )
          .catch(() => null),
        (async () => {
          try {
            const { db } = await import("../../db");
            const { skillRuns } = await import("@shared/models/skills");
            const { eq } = await import("drizzle-orm");
            const rows = await db
              .select()
              .from(skillRuns)
              .where(eq(skillRuns.sessionId, id))
              .limit(1);
            return rows[0] || null;
          } catch {
            return null;
          }
        })(),
      ]);

      res.json({
        session,
        provenance: {
          triggerType: session.triggerType || "unknown",
          triggerId: session.triggerId,
          triggerName: session.triggerName,
          parentSessionId,
          parentTitle: parentSession?.title,
          rootSessionId: session.rootSessionId,
          rootTitle: rootSession?.title,
          depth: session.depth ?? 0,
          spawnReason,
        },
        artifacts: (artifacts as any[]).map((a: any) => ({
          type: a.artifactType,
          id: a.artifactId,
          metadata: a.metadata,
          createdAt: a.createdAt,
        })),
        cost: costResult
          ? {
              calls: costResult.calls,
              totalTokensIn: costResult.inputTokens,
              totalTokensOut: costResult.outputTokens,
              totalTokens: costResult.totalTokens,
              totalCost: costResult.cost,
            }
          : null,
        skillRun: skillRunResult
          ? {
              skillName: (skillRunResult as any).skillName,
              status: (skillRunResult as any).status,
              passRate: (skillRunResult as any).passRate,
              durationMs: (skillRunResult as any).durationMs,
            }
          : null,
      });
    } catch (error) {
      chatLog.error("Error fetching session details:", error);
      res.status(500).json({ error: "Failed to fetch session details" });
    }
  });

  app.post("/api/sessions", async (req: Request, res: Response) => {
    try {
      const {
        title,
        sessionKey: customSessionKey,
        sessionType,
        pageContext,
        personaName,
      } = req.body;
      const sessionKey =
        customSessionKey || `dashboard:${randomUUID().slice(0, 8)}`;
      const modelTier = normalizeSessionModelTierOverride(req.body?.modelTier);
      const allowedTypes = new Set(["user", "agent", "autonomous", "focus"]);
      const safeSessionType =
        typeof sessionType === "string" && allowedTypes.has(sessionType)
          ? (sessionType as "user" | "agent" | "autonomous" | "focus")
          : undefined;
      const safePageContext = normalizePageContext(pageContext);
      let initialPersonaId: number | null = null;
      if (typeof personaName === "string" && personaName.trim()) {
        const { personaStorage } = await import("../../file-storage/persona-storage");
        const persona = await personaStorage.getByName(personaName.trim());
        if (!persona) {
          res.status(400).json({ error: `Persona not found: ${personaName}` });
          return;
        }
        initialPersonaId = persona.id;
      }
      const session = await chatStorage.createSession(
        title || "New Session",
        sessionKey,
        modelTier || undefined,
        {
          sessionType: safeSessionType,
          pageContext: safePageContext,
          provenance: { triggerType: "user" },
          personaId: initialPersonaId,
        },
      );
      res.status(201).json(session);

      import("../../context-builder")
        .then(({ preWarmContextCaches }) => {
          preWarmContextCaches().catch((err) =>
            chatLog.warn("Context pre-warm failed:", err),
          );
        })
        .catch((err) => chatLog.warn("Context pre-warm import failed:", err));
    } catch (error) {
      chatLog.error("Error creating session:", error);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  app.patch(
    "/api/sessions/:id/context",
    async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        const body = req.body || {};
        const incoming =
          body &&
          typeof body === "object" &&
          body.pageContext &&
          typeof body.pageContext === "object"
            ? body.pageContext
            : body;
        const pageContext = normalizePageContext(incoming);
        if (!pageContext) {
          return res
            .status(400)
            .json({ error: "pageContext.route is required" });
        }
        const session = await chatStorage.getSession(id);
        if (!session)
          return res.status(404).json({ error: "Session not found" });
        await chatStorage.updatePageContext(id, pageContext);
        res.json({ ok: true, pageContext });
      } catch (error) {
        chatLog.error("Error updating session pageContext:", error);
        res.status(500).json({ error: "Failed to update page context" });
      }
    },
  );

  app.patch("/api/sessions/:id/read", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      // Mark-read clears only the unread badge. errorSeverity remains until the
      // human dismisses the system notice, so REVIEW + title/icon state persist.
      await chatStorage.setHasUnreadResult(id, false);
      res.json({ ok: true });
    } catch (error) {
      chatLog.error("Error marking session as read:", error);
      res.status(500).json({ error: "Failed to mark session as read" });
    }
  });

  // Session pin is personal user state. Keep it on /api/sessions so API policy
  // classifies it as personal; the legacy /api/gateway attention route is admin-class.
  app.patch("/api/sessions/:id/attention", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const rawPinned = req.body?.isPinned ?? req.body?.needsAttention;
      if (typeof rawPinned !== "boolean") {
        return res.status(400).json({ error: "isPinned (boolean) is required" });
      }
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      await chatStorage.setSessionPinned(id, rawPinned);
      res.json({ ok: true, isPinned: rawPinned });
    } catch (error) {
      chatLog.error("Error toggling session pin:", error);
      res.status(500).json({ error: "Failed to toggle session pin" });
    }
  });

  // Session-scoped persona pin is the same personal mutation class as attention.
  app.patch("/api/sessions/:id/persona", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, "personaId")) {
        return res.status(400).json({ error: "personaId is required (a number to pin, or null for Auto)" });
      }
      const raw = req.body.personaId;
      const personaId = raw === null ? null : Number(raw);
      if (personaId !== null && (!Number.isInteger(personaId) || personaId <= 0)) {
        return res.status(400).json({ error: "personaId must be a positive integer or null" });
      }
      if (personaId !== null) {
        const { personaStorage } = await import("../../file-storage/persona-storage");
        const persona = await personaStorage.get(personaId);
        if (!persona) {
          return res.status(404).json({ error: "Persona not found" });
        }
      }
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      const updated = await chatStorage.setSessionPersonaPin(id, personaId);
      if (!updated) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ ok: true, personaId, pinned: personaId !== null });
    } catch (error) {
      chatLog.error("Error updating session persona pin:", error);
      res.status(500).json({ error: "Failed to update session persona pin" });
    }
  });

  app.post(
    "/api/sessions/:id/notices/:messageId/dismiss",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;
        const messageId = req.params.messageId as string;
        if (!sessionId || !messageId) {
          return res.status(400).json({ error: "sessionId and messageId are required" });
        }
        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        const dismissed = await chatStorage.dismissSystemNotice(sessionId, messageId);
        if (!dismissed) {
          return res.status(404).json({ error: "System notice not found" });
        }
        const updated = await chatStorage.getSession(sessionId);
        res.json({
          ok: true,
          errorSeverity: updated?.errorSeverity ?? null,
        });
      } catch (error) {
        chatLog.error("Error dismissing system notice:", error);
        res.status(500).json({ error: "Failed to dismiss system notice" });
      }
    },
  );

  app.patch("/api/sessions/:id/archive", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      const shouldArchive = req.body?.archived !== false;
      if (shouldArchive) {
        await chatStorage.archiveSession(id);
      } else {
        await chatStorage.unarchiveSession(id);
      }
      const updated = await chatStorage.getSession(id);
      res.json({ ok: true, session: updated });
    } catch (error) {
      chatLog.error("Error toggling session archive state:", error);
      res.status(500).json({ error: "Failed to toggle session archive state" });
    }
  });

  app.patch("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { title } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      // Manual renames are title-only mutations. Do not route them through
      // saveSession(), which finalizes the session and clears streaming state.
      await chatStorage.updateSessionTitle(id, title.trim(), { source: "manual" });
      const renamed = await chatStorage.getSession(id);
      res.json(renamed ?? { ...session, title: title.trim(), manualTitle: true });
    } catch (error) {
      chatLog.error("Error updating session:", error);
      res.status(500).json({ error: "Failed to update session" });
    }
  });

  // Per-session git write override toggle (admin-controlled)
  app.patch(
    "/api/sessions/:id/git-write-override",
    async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        const { enabled } = req.body;
        if (typeof enabled !== "boolean") {
          return res
            .status(400)
            .json({ error: "enabled (boolean) is required" });
        }
        const session = await chatStorage.getSession(id);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        await chatStorage.setGitWriteOverride(id, enabled);
        chatLog.log(`git-write-override sessionId=${id} enabled=${enabled}`);
        res.json({ ok: true, gitWriteOverride: enabled });
      } catch (error) {
        chatLog.error("Error setting git write override:", error);
        res.status(500).json({ error: "Failed to set git write override" });
      }
    },
  );

  app.delete(
    "/api/sessions/:parentId/child-blocks/:childId",
    async (req: Request, res: Response) => {
      try {
        const parentId = req.params.parentId as string;
        const childId = req.params.childId as string;
        const parent = await chatStorage.getSession(parentId);
        if (!parent) {
          return res.status(404).json({ error: "Parent session not found" });
        }

        const { deleteChildSessionBlock } =
          await import("../../sessions/child-block-lifecycle");
        await deleteChildSessionBlock(parentId, childId);
        const result = await chatStorage.deleteSession(childId);
        res.json(result);
      } catch (error) {
        chatLog.error("Error deleting child session block:", error);
        res.status(500).json({ error: "Failed to delete child session block" });
      }
    },
  );

  app.delete("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const result = await chatStorage.deleteSession(id);
      res.json(result);
    } catch (error) {
      chatLog.error("Error deleting session:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  const uploadsDir = path.join(WORKSPACE_DIR, "uploads");
  await fs.promises.mkdir(uploadsDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        const base = path
          .basename(file.originalname, ext)
          .replace(/[^a-zA-Z0-9_-]/g, "_");
        cb(null, `${base}-${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  app.get("/api/workspace/raw", async (req: Request, res: Response) => {
    try {
      const relativePath = req.query.path as string;
      if (!relativePath) {
        return res.status(400).json({ error: "File path is required" });
      }
      const normalized = path
        .normalize(relativePath)
        .replace(/^(\.\.[/\\])+/, "");
      const filePath = path.resolve(path.join(WORKSPACE_DIR, normalized));
      if (!filePath.startsWith(path.resolve(WORKSPACE_DIR))) {
        return res.status(403).json({ error: "Access denied" });
      }
      try {
        await fsPromises.access(filePath);
      } catch {
        chatLog.error(
          `[workspace/raw] File not found: ${filePath} (query: ${relativePath})`,
        );
        return res.status(404).json({ error: "File not found" });
      }
      res.sendFile(filePath, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) {
          res.status(404).json({ error: "File not found" });
        }
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to serve file" });
    }
  });

  app.post(
    "/api/chat/upload",
    upload.array("files", 10),
    async (req: Request, res: Response) => {
      try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No files uploaded" });
        }

        const TEXT_EXTS = new Set([
          ".txt",
          ".md",
          ".json",
          ".csv",
          ".log",
          ".yml",
          ".yaml",
          ".xml",
          ".html",
          ".css",
          ".js",
          ".ts",
          ".tsx",
          ".jsx",
          ".py",
          ".sh",
          ".env",
          ".toml",
          ".ini",
          ".cfg",
          ".sql",
        ]);

        const uploaded = await Promise.all(
          files.map(async (f) => {
            const ext = path.extname(f.originalname).toLowerCase();
            const isText = TEXT_EXTS.has(ext);
            let content: string | undefined;
            if (isText && f.size < 500_000) {
              try {
                content = await fsPromises.readFile(f.path, "utf-8");
              } catch (err) {
                chatLog.warn("file read failed", f.path, err);
              }
            }

            const principal = getPrincipal(req);
            if (!principal?.userId || !principal.accountId) {
              throw new Error("User principal required for attachment persistence");
            }

            try {
              const fileBuffer = await fsPromises.readFile(f.path);
              const uploadedObject = await objectStorageService.uploadObjectEntity(fileBuffer, {
                extension: ext || undefined,
                contentType: f.mimetype || "application/octet-stream",
                category: "uploads",
                principal,
                acl: {
                  owner: principal.userId,
                  ownerUserId: principal.userId,
                  accountId: principal.accountId,
                  createdByUserId: principal.userId,
                  scope: "user",
                  visibility: "private",
                },
              });
              const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null;
              const { registerUploadResource } = await import("../../upload-resource-service");
              await runWithPrincipal(principal, () => registerUploadResource({
                objectPath: uploadedObject.objectPath,
                name: f.originalname,
                mimeType: f.mimetype || "application/octet-stream",
                sessionId,
              }));
              chatLog.info("chat upload persisted and registered", {
                objectPath: uploadedObject.objectPath,
                sessionId,
              });
              return {
                name: f.originalname,
                path: uploadedObject.objectPath,
                size: f.size,
                isText,
                content,
              };
            } finally {
              try {
                await fsPromises.unlink(f.path);
              } catch (cleanupError) {
                chatLog.warn(
                  `[Upload] temp cleanup failed: name="${f.originalname}" error=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                );
              }
            }
          }),
        );

        res.json({ files: uploaded });
      } catch (error) {
        chatLog.error("File upload error:", error);
        res.status(500).json({ error: "Upload failed" });
      }
    },
  );

  function historicalToolResultForExecutor(value: unknown): string {
    const content = typeof value === "string" ? value : "";
    if (!content) return "";

    if (
      content.includes("**Tool Output Archived**") &&
      content.includes("[ref:")
    ) {
      const lines = content.split("\n");
      const refLine = lines.find(
        (line) =>
          line.includes("**Tool Output Archived**") && line.includes("[ref:"),
      );
      const toolLine = lines.find((line) => line.startsWith("Tool:"));
      const sizeLine = lines.find((line) => line.startsWith("Size:"));
      const sectionsLine = lines.find((line) => line.startsWith("Sections:"));
      return [
        refLine,
        toolLine,
        sizeLine,
        sectionsLine,
        "Preview omitted from model context; use indexed_content/read_section if needed.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    return content;
  }

  type ConversationHistoryMessage = {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: any[];
    thinking?: string;
    publicRole?: "user" | "assistant";
    capsule?: import("@shared/models/chat").ContinuationCapsule;
    archiveRefId?: string;
    archiveDownloadable?: boolean;
  };

  async function resolveAuthorityToolDefinitions(sessionId: string): Promise<ToolDefinition[]> {
    const { filterToolSchemasForAuthority } = await import("../../agent-authority");
    const { requireCurrentPrincipal } = await import("../../principal-context");
    const { filterModToolSchemas } = await import("../../mods/mod-access");
    const authorityTools = filterToolSchemasForAuthority(getToolDefinitions(), {
      origin: "interactive",
      sessionId,
    });
    const modScopedTools = await filterModToolSchemas(requireCurrentPrincipal(), authorityTools);
    return modScopedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async function resolveInteractiveToolSet(sessionId: string): Promise<{
    definitions: ToolDefinition[];
    authorityCount: number;
    personaName: string;
    bundleCount: number;
  }> {
    const authorityDefinitions = await resolveAuthorityToolDefinitions(sessionId);
    const { filterToolsForPersonaBundle } = await import("../../tool-registry");
    const { resolveSessionPersonaComposition } = await import("../../session-persona");
    const { persona, toolBundle } = await resolveSessionPersonaComposition(sessionId, { persistFallback: false });
    return {
      definitions: filterToolsForPersonaBundle(authorityDefinitions, toolBundle),
      authorityCount: authorityDefinitions.length,
      personaName: persona?.name ?? "none",
      bundleCount: toolBundle?.length ?? 0,
    };
  }

  /**
   * Detect short user turns that approve a prior proposal ("do it", "yes — ship 1 and 2").
   * Sets the durable approved_to_execute stance so later runs (including this one after
   * any restart) do not re-derive act-vs-answer from transcript prose.
   */
  function detectExecutionApproval(raw: string): { reason: string; objectiveHint?: string } | null {
    const text = (raw || "").trim();
    if (!text) return null;
    // Long messages are usually new instructions, not pure approvals.
    if (text.length > 400) return null;
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    const approvalPatterns: Array<{ re: RegExp; reason: string }> = [
      { re: /^(yes|yep|yeah|yup)\b[.!]?\s*(please)?\s*[.—–-]?\s*(do it|ship it|build it|implement( it)?|go ahead|proceed)?[.!]?$/i, reason: "affirmative approval" },
      { re: /^(do it|ship it|build it|implement( it)?|go ahead|proceed|execute|just do it)\b[.!]?$/i, reason: "imperative approval" },
      { re: /^(please )?(continue|keep going|finish( it)?)\b[.!]?$/i, reason: "continue approval" },
      { re: /^(do|ship|implement|build)\s+(\d+(\s*(and|,|\&)\s*\d+)*)\b/i, reason: "numbered-item approval" },
      { re: /^(lgtm|approved|ship it|send it)\b[.!]?$/i, reason: "explicit ship approval" },
    ];
    for (const { re, reason } of approvalPatterns) {
      if (re.test(normalized) || re.test(text)) {
        return { reason, objectiveHint: text.slice(0, 280) };
      }
    }
    // "do 1 and 2" / "please continue" with trailing clarification still counts
    // when the leading clause is an approval imperative.
    if (/^(yes[,.]?\s+)?(do|ship|implement|build)\s+\d+/i.test(normalized)) {
      return { reason: "numbered-item approval with detail", objectiveHint: text.slice(0, 280) };
    }
    if (/^(please\s+)?continue\b/i.test(normalized) && text.length < 200) {
      return { reason: "continue approval with detail", objectiveHint: text.slice(0, 280) };
    }
    return null;
  }

  async function buildChatHistory(
    sessionId: string,
    enrichedContent: string,
    resolvedModel: string | undefined,
    hardInputLimit: number,
    onProgress?: (
      step: string,
      status: "started" | "done",
      elapsedMs?: number,
    ) => void,
    currentMessageIds?: string[],
    callerGeneration?: number,
    contextBuildId?: string,
    onCompactionActivity?: (update: import("../../agent-context").CompactionActivityUpdate) => void,
    /**
     * Set after a full-input between-turn compact so the one re-entry does not
     * fire again. Production callers omit this.
     */
    betweenTurnPass?: {
      attempted: boolean;
      applied: boolean;
    },
  ): Promise<{
    messages: ExecutorMessage[];
    conversationHistory: ConversationHistoryMessage[];
    enrichedContent: string;
    toolDefs: ToolDefinition[];
    authorityStubTools?: ToolDefinition[];
    contextPressure: {
      preRunTokens: number;
      threshold: number;
      durableCompactionAttempted: boolean;
      durableCompactionApplied: boolean;
      contextTokens?: number;
      messageCount?: number;
      toolCount?: number;
      contextWindow?: number;
      contextLimit?: number;
    };
  }> {
    onProgress?.("ctx_history", "started");
    const histStart = Date.now();
    // Sub-step tracker: exposes DB load, token estimation, payload repair, and
    // between-turn compaction as independent diagnostic rows under ctx_history.
    let openSubStep: (() => void) | undefined;
    const beginSubStep = (name: string): (() => void) => {
      onProgress?.(name, "started");
      const subStart = Date.now();
      const end = () => {
        openSubStep = undefined;
        onProgress?.(name, "done", Date.now() - subStart);
      };
      openSubStep = end;
      return end;
    };
    const endLoad = beginSubStep("ctx_history_load");
    chatLog.log(`loadHistory START sessionId=${sessionId}`);
    let existingMessages = await chatStorage.getMessagesBySession(sessionId);
    if (currentMessageIds?.length) {
      const boundary = existingMessages.reduce(
        (latest, message, index) => currentMessageIds.includes(message.id) ? Math.max(latest, index) : latest,
        -1,
      );
      if (boundary >= 0) existingMessages = existingMessages.slice(0, boundary + 1);
    }
    chatLog.log(
      `loadHistory DONE messageCount=${existingMessages.length} elapsed=${Date.now() - histStart}ms sessionId=${sessionId}`,
    );

    const conversationHistory: ConversationHistoryMessage[] = [];

    const tsPrefix = (createdAt: unknown): string => {
      const d =
        createdAt instanceof Date
          ? createdAt
          : typeof createdAt === "string"
            ? new Date(createdAt)
            : new Date();
      const safe = isNaN(d.getTime()) ? new Date() : d;
      return formatMessageTimestamp(safe);
    };

    const rebuildConversationHistory = (
      sourceMessages: typeof existingMessages,
    ) => {
      conversationHistory.length = 0;
      const durableHistoryMessages = sourceMessages.filter(
        isCommittedContextMessage,
      );
      const sourceLastUserIdx = durableHistoryMessages.reduce(
        (acc, m, i) => (m.role === "user" ? i : acc),
        -1,
      );
      for (let i = 0; i < durableHistoryMessages.length; i++) {
        const msg = durableHistoryMessages[i];
        const baseContent = msg.content || "";
        const attributedContent =
          msg.role === "user" && msg.speaker?.label?.trim()
            ? `[${msg.speaker.label.trim()}] ${baseContent}`
            : baseContent;
        const isCurrentMessage = currentMessageIds?.length
          ? currentMessageIds.includes(msg.id)
          : i === sourceLastUserIdx
            && (baseContent === enrichedContent
              || attributedContent === enrichedContent);
        if (isCurrentMessage) {
          chatLog.log(
            `excluding last user message from history (will be appended separately) idx=${i} sessionId=${sessionId}`,
          );
          continue;
        }
        const prefix = tsPrefix(msg.createdAt);
        const locationNote =
          msg.role === "user" && msg.pageContext?.route
            ? ` [page: ${msg.pageContext.pageTitle || msg.pageContext.route}${msg.pageContext.tab ? ` > ${msg.pageContext.tab}` : ""}]`
            : "";
        const stamped = `${prefix}${locationNote} ${attributedContent}`;
        if (msg.role === "user" || msg.role === "assistant") {
          conversationHistory.push({
            role: msg.role as "user" | "assistant",
            content: stamped,
            thinking: msg.thinking || undefined,
            toolCalls: (msg.toolCalls || undefined) as any,
            publicRole: msg.role as "user" | "assistant",
          });
        } else if (msg.role === "system_prompt") {
          conversationHistory.push({ role: "user", content: stamped });
        } else if (msg.role === "system" && msg.model === "compaction-marker") {
          conversationHistory.push({
            role: "system",
            content: stamped,
            capsule: msg.compaction?.capsule,
            archiveRefId: msg.compaction?.archiveRefId,
            archiveDownloadable: msg.compaction?.archiveDownloadable,
          });
        }
      }
    };

    rebuildConversationHistory(existingMessages);
    endLoad();

    // Between-turn fire runs after full next-input assembly (system + history +
    // tools) further below — history-only pre-check deleted.
    let durableCompactionAttempted = betweenTurnPass?.attempted ?? false;
    let durableCompactionApplied = betweenTurnPass?.applied ?? false;

    onProgress?.("ctx_history", "done", Date.now() - histStart);

    // Authority decides what this session may call; persona configuration chooses
    // the initial working set. Long-tail schemas remain loadable through tools.get.
    const interactiveToolSet = await resolveInteractiveToolSet(sessionId);
    const toolDefs = interactiveToolSet.definitions;
    let authorityStubTools: ToolDefinition[] | undefined;
    try {
      const authorityDefinitions = await resolveAuthorityToolDefinitions(sessionId);
      const hydratedNames = new Set(toolDefs.map((tool) => tool.name));
      authorityStubTools = authorityDefinitions.filter((def) => !hydratedNames.has(def.name));
    } catch (err) {
      chatLog.log(
        `autohydrate: failed to resolve authority stub tools sessionId=${sessionId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    chatLog.log(
      `tools loaded count=${toolDefs.length} authorityCount=${interactiveToolSet.authorityCount} stubCount=${authorityStubTools?.length ?? 0} persona=${interactiveToolSet.personaName} bundle=${interactiveToolSet.bundleCount} sessionId=${sessionId}`,
    );

    // --- Supersession / approval handoff ---
    // Carry executionStance + objective across abort boundaries so the replacement
    // run does not re-infer act-vs-answer from unstructured transcript.
    const approvalSignal = detectExecutionApproval(enrichedContent);
    if (approvalSignal) {
      agentExecutor.reinforceSessionStance(sessionId, {
        latestUserInstruction: enrichedContent.trim(),
        objective: approvalSignal.objectiveHint,
        stanceReason: approvalSignal.reason,
      });
      chatLog.info(
        `execution stance reinforced sessionId=${sessionId} reason=${approvalSignal.reason}`,
      );
    }
    const handoff = agentExecutor.takeSessionHandoff(sessionId);
    if (handoff?.capsule) {
      const capsuleContent = `[Working Context Capsule]\n\n${renderContinuationCapsule(handoff.capsule)}`;
      // Inject immediately before the newest user turn so the model sees stance
      // as live working context, not buried history.
      const lastUserIdx = (() => {
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
          if (conversationHistory[i].role === "user") return i;
        }
        return conversationHistory.length;
      })();

      // Zero-progress coalesce: the aborted run never produced output, so fold its
      // request into this turn rather than treating the follow-up as a cold restart.
      if (
        !handoff.hadProgress
        && handoff.priorRequestContent
        && conversationHistory[lastUserIdx]?.role === "user"
      ) {
        const current = conversationHistory[lastUserIdx].content || "";
        const prior = handoff.priorRequestContent.trim();
        if (prior && !current.includes(prior.slice(0, Math.min(80, prior.length)))) {
          conversationHistory[lastUserIdx] = {
            ...conversationHistory[lastUserIdx],
            content: [
              "[Prior turn — interrupted before any model output; treat as one continuous mission]",
              prior,
              "",
              "[Current follow-up]",
              current,
            ].join("\n"),
          };
          chatLog.info(
            `zero-progress coalesce applied sessionId=${sessionId} priorLen=${prior.length} currentLen=${current.length}`,
          );
        }
      }

      conversationHistory.splice(lastUserIdx, 0, {
        role: "system",
        content: capsuleContent,
        model: "compaction-marker",
        capsule: handoff.capsule,
      });
      chatLog.info(
        `supersession handoff injected sessionId=${sessionId} stance=${handoff.capsule.executionStance ?? "none"} hadProgress=${handoff.hadProgress}`,
      );
    }

    const contextBuildStart = Date.now();
    chatLog.log(`contextAssembly START sessionId=${sessionId}`);
    const session = await chatStorage.getSession(sessionId);
    let meetingContext: string | undefined;
    if (session?.type === "meeting" && session.meeting) {
      try {
        const { buildMeetingContextPacket, renderMeetingContextPacket } = await import("../../meeting/context-packet");
        const packet = await buildMeetingContextPacket(session.meeting);
        meetingContext = packet ? renderMeetingContextPacket(packet) : undefined;
      } catch (err) {
        chatLog.warn(`meetingContext degraded sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const context = await assembleContext({
      profile: "chat",
      conversationHistory,
      toolDefinitions: toolDefs.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      model: resolvedModel,
      sessionId,
      contextBuildId,
      currentMessage: enrichedContent,
      meetingContext,
      onProgress,
    });
    chatLog.log(
      `contextAssembly DONE elapsed=${Date.now() - contextBuildStart}ms systemPromptLen=${context.systemPrompt.length} messagesCount=${context.messages.length} sessionId=${sessionId}`,
    );

    const messages: ExecutorMessage[] = [
      { role: "system", content: context.systemPrompt },
    ];

    type ToolCallRecord = {
      toolCallId: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      result?: string;
      error?: boolean | string;
    };
    const globalToolCallMap = new Map<string, ToolCallRecord>();
    let mergeCount = 0;

    for (const msg of context.messages) {
      const rawMsg = msg as unknown as Record<string, unknown>;
      const toolCalls = rawMsg.toolCalls as
        | Array<{
            toolCallId?: string;
            toolName: string;
            arguments?: Record<string, unknown>;
            result?: string;
            error?: boolean | string;
            failureKind?: import("@shared/tool-failure").ToolFailureKind;
            failureCode?: string;
          }>
        | undefined;
      if (msg.role === "assistant" && toolCalls) {
        const msgId = (rawMsg.id as string) || "unknown";
        for (const tc of toolCalls) {
          if (!tc.toolName || !tc.toolCallId) continue;
          const existing = globalToolCallMap.get(tc.toolCallId);
          if (existing) {
            mergeCount++;
            if (
              tc.arguments &&
              Object.keys(tc.arguments).length > 0 &&
              (!existing.arguments ||
                Object.keys(existing.arguments).length === 0)
            ) {
              existing.arguments = tc.arguments;
            }
            if (tc.result && !existing.result) {
              existing.result = tc.result;
            }
            if (tc.error && !existing.error) {
              existing.error = tc.error;
            }
            if (tc.failureKind && !existing.failureKind) {
              existing.failureKind = tc.failureKind;
            }
            if (tc.failureCode && !existing.failureCode) {
              existing.failureCode = tc.failureCode;
            }
            chatLog.warn(
              `merged duplicate toolCallId=${tc.toolCallId} name=${tc.toolName} fromMsgId=${msgId} sessionId=${sessionId}`,
            );
          } else {
            globalToolCallMap.set(tc.toolCallId, {
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              arguments: tc.arguments,
              result: tc.result,
              error: tc.error,
              ...(tc.failureKind ? { failureKind: tc.failureKind } : {}),
              ...(tc.failureCode ? { failureCode: tc.failureCode } : {}),
            });
          }
        }
      }
    }
    if (mergeCount > 0)
      chatLog.warn(
        `deduplicated ${mergeCount} split tool call records across messages sessionId=${sessionId}`,
      );

    const seenToolCallIds = new Set<string>();

    for (const msg of context.messages) {
      const rawMsg = msg as unknown as Record<string, unknown>;
      const toolCalls = rawMsg.toolCalls as
        | Array<{
            toolCallId?: string;
            toolName: string;
            arguments?: Record<string, unknown>;
            result?: string;
            error?: boolean | string;
          }>
        | undefined;
      const msgId = (rawMsg.id as string) || "unknown";

      if (msg.role === "assistant" && toolCalls && toolCalls.length > 0) {
        const contentBlocks: ContentBlock[] = [];
        if (msg.content)
          contentBlocks.push({ type: "text", text: msg.content });
        const toolResultBlocks: ContentBlock[] = [];
        let skipped = 0;
        for (const tc of toolCalls) {
          if (!tc.toolName) {
            skipped++;
            continue;
          }
          const tcId = tc.toolCallId || generateToolCallId("hist");
          if (seenToolCallIds.has(tcId)) {
            chatLog.debug(
              `skipping already-emitted toolCallId=${tcId} name=${tc.toolName} msgId=${msgId} sessionId=${sessionId}`,
            );
            continue;
          }
          seenToolCallIds.add(tcId);

          const merged = tc.toolCallId
            ? globalToolCallMap.get(tc.toolCallId)
            : undefined;
          const source = merged || tc;

          let safeInput: Record<string, unknown> = {};
          try {
            safeInput =
              source.arguments && typeof source.arguments === "object"
                ? { ...source.arguments }
                : {};
            // Strip voice middleware artifacts that leak into persisted tool calls
            delete safeInput._toolCallId;
            JSON.stringify(safeInput);
          } catch {
            safeInput = { _serialization_error: true };
          }
          const rawResultContent =
            typeof source.result === "string" ? source.result : "";
          const resultContent =
            historicalToolResultForExecutor(rawResultContent);
          contentBlocks.push({
            type: "tool_use",
            id: tcId,
            name: source.toolName,
            input: safeInput,
          });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tcId,
            content: resultContent,
            is_error: !!source.error,
          });
          chatLog.debug(
            `reconstructed tool_use name=${source.toolName} id=${tcId} msgId=${msgId} inputKeys=${Object.keys(safeInput).join(",")} resultLen=${rawResultContent.length}->${resultContent.length}${merged ? " (merged)" : ""}`,
          );
        }
        if (contentBlocks.length > (msg.content ? 1 : 0)) {
          messages.push({ role: "assistant", content: contentBlocks });
          messages.push({ role: "tool_result", content: toolResultBlocks });
        } else if (msg.content) {
          messages.push({ role: "assistant", content: msg.content });
        }
        if (skipped > 0)
          chatLog.warn(
            `skipped ${skipped} tool calls with missing toolName in history sessionId=${sessionId}`,
          );
      } else {
        messages.push({
          role: msg.role as "system" | "user" | "assistant" | "tool_result",
          content: msg.content,
        });
      }
    }

    messages.push({
      role: "user",
      content: `${nowMessageTimestamp()} ${enrichedContent}`,
    });

    const { getContextWindow } = await import("../../model-registry");
    const bareModel = (resolvedModel || "").includes("/")
      ? (resolvedModel || "").split("/").slice(1).join("/")
      : resolvedModel || "";
    const contextWindow = getContextWindow(bareModel);
    const {
      applyTokenEstimateCalibration,
      estimateMessagesInputTokens,
      estimateToolDefinitionTokens,
      getContextPressureThresholds,
    } = await import("../../context-budget");
    const toolDefinitionTokens = estimateToolDefinitionTokens([
      ...toolDefs,
      ...(authorityStubTools || []),
    ]);
    const betweenTurnThreshold = getContextPressureThresholds(hardInputLimit).betweenTurnHistoryReset;
    // One truthful measurand: the exact rebuilt messages passed to the executor,
    // plus the tool definitions sent with them. No provider-view simulation.
    const rawPreExecutorTokens =
      estimateMessagesInputTokens(messages) + toolDefinitionTokens;
    const fullPreExecutorTokens = await applyTokenEstimateCalibration(
      bareModel,
      rawPreExecutorTokens,
    );
    const toolResultCount = messages.reduce((sum, msg) => {
      if (!Array.isArray(msg.content)) return sum;
      return (
        sum + msg.content.filter((block) => block.type === "tool_result").length
      );
    }, 0);

    // Full next-input threshold = 30% of the hard input limit. One shot only
    // (betweenTurnPass set after compact). Landing is min-viable live context
    // inside runBetweenTurnCompaction — no history keep-budget.
    if (!betweenTurnPass && fullPreExecutorTokens > betweenTurnThreshold) {
      durableCompactionAttempted = true;
      const endCompaction = beginSubStep("ctx_history_compact");
      try {
        const { runBetweenTurnCompaction } = await import("../../agent-context");
        const compacted = await runBetweenTurnCompaction(
          sessionId,
          conversationHistory,
          hardInputLimit,
          callerGeneration,
          onCompactionActivity,
          fullPreExecutorTokens,
        );
        durableCompactionApplied =
          compacted.outcome === "compacted" ||
          (compacted.outcome === "joined" &&
            compacted.terminalOutcome === "compacted");
        if (durableCompactionApplied) {
          chatLog.log(
            `betweenTurnCompaction outcome sessionId=${sessionId} action=between_turn_history_reset ` +
            `tokensBefore=${fullPreExecutorTokens} threshold=${betweenTurnThreshold} outcome=applied; ` +
            `rebuilding after min-viable land`,
          );
          endCompaction();
          return buildChatHistory(
            sessionId,
            enrichedContent,
            resolvedModel,
            hardInputLimit,
            onProgress,
            currentMessageIds,
            callerGeneration,
            contextBuildId,
            onCompactionActivity,
            { attempted: true, applied: true },
          );
        }
        const outcomeReason =
          "reason" in compacted && compacted.reason
            ? ` reason=${compacted.reason}`
            : "";
        const operationId =
          "operationId" in compacted && compacted.operationId
            ? ` operationId=${compacted.operationId}`
            : "";
        const outcomeLog =
          compacted.outcome === "failed" || compacted.outcome === "archive_failed"
            ? chatLog.warn.bind(chatLog)
            : chatLog.log.bind(chatLog);
        outcomeLog(
          `betweenTurnCompaction outcome sessionId=${sessionId} action=between_turn_history_reset ` +
            `tokensBefore=${fullPreExecutorTokens} threshold=${betweenTurnThreshold} ` +
            `outcome=${compacted.outcome}${outcomeReason}${operationId}`,
        );
        endCompaction();
      } catch (compactErr: unknown) {
        endCompaction();
        chatLog.warn(
          `betweenTurnCompaction failed (non-fatal) sessionId=${sessionId}: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
        );
      }
    }

    chatLog.log(
      `historyRebuilt messageCount=${messages.length} preExecutorTokens=${fullPreExecutorTokens} betweenTurn=${betweenTurnThreshold} hardInput=${hardInputLimit} window=${contextWindow} toolSchemaTokens=${toolDefinitionTokens} toolResults=${toolResultCount} measurand=raw_input sessionId=${sessionId}`,
    );
    return {
      messages,
      conversationHistory,
      enrichedContent,
      toolDefs,
      authorityStubTools,
      contextPressure: {
        preRunTokens: fullPreExecutorTokens,
        threshold: betweenTurnThreshold,
        durableCompactionAttempted,
        durableCompactionApplied,
        contextTokens: fullPreExecutorTokens,
        messageCount: messages.length,
        toolCount: toolResultCount,
        contextWindow,
        contextLimit: hardInputLimit,
      },
    };
  }

  async function executeChatAgent(
    sessionKey: string,
    sessionId: string,
    messages: ExecutorMessage[],
    toolDefs: ToolDefinition[],
    authorityStubTools: ToolDefinition[] | undefined,
    routingDecision: ModelRoutingDecision,
    contextPressure?: {
      preRunTokens: number;
      threshold: number;
      durableCompactionAttempted: boolean;
      durableCompactionApplied: boolean;
    },
    onEvent?: Parameters<typeof agentExecutor.run>[0]["onEvent"],
    routingTier?: string,
    runId?: string,
    diagnosticTurnId?: string,
    refreshAfterPersonaSwitch?: Parameters<typeof agentExecutor.run>[0]["refreshAfterPersonaSwitch"],
    refreshToolSchema?: Parameters<typeof agentExecutor.run>[0]["refreshToolSchema"],
    clientId?: string,
  ): Promise<ExecutorRunResult> {
    const toolExecutor = async (name: string, args: Record<string, any>) => {
      const shouldTrackPersonaChange = name === "orient" && typeof args.persona !== "undefined";
      const previousPersonaId = shouldTrackPersonaChange
        ? (await chatStorage.getSession(sessionId))?.personaId
        : undefined;
      const toolCallId = generateToolCallId();
      const toolResult = await executeTool(name, toolCallId, args, {
        sessionKey,
        sessionId,
        clientId,
        authority: { origin: "interactive" },
      });
      const nextPersonaId = shouldTrackPersonaChange && !toolResult.error
        ? (await chatStorage.getSession(sessionId))?.personaId
        : undefined;
      const personaChanged =
        shouldTrackPersonaChange &&
        !toolResult.error &&
        nextPersonaId != null &&
        nextPersonaId !== previousPersonaId;
      return {
        result: toolResult.result,
        error: toolResult.error,
        failure: toolResult.failure,
        sideEffectOnly: toolResult.sideEffectOnly,
        continuation: personaChanged ? "persona_switch" as const : toolResult.continuation,
      };
    };

    return agentExecutor.run({
      sessionKey,
      sessionId,
      runId,
      messages,
      tools: toolDefs,
      authorityStubTools,
      toolExecutor,
      activity: ACTIVITY_CHAT,
      routingDecision,
      routingTier,
      contextPressure,
      onEvent,
      diagnosticTurnId,
      refreshAfterPersonaSwitch,
      refreshToolSchema,
    });
  }

  async function processChatStream(
    sessionKey: string,
    sessionId: string,
    content: string,
    resolvedModel?: string,
    autoTier?: string | null,
    modelSelectionMs?: number,
    sayAloud = false,
    onResponse?: (content: string) => Promise<void> | void,
    registeredRunGeneration?: number,
    acceptedLease?: ChatRunLease,
    currentMessageIds?: string[],
    onSettled?: (result: {
      status: "completed" | "failed";
      assistantMessageId?: string;
      error?: string;
    }) => Promise<void> | void,
    clientId?: string,
    acceptedTurnId?: string,
  ) {
    const lease = acceptedLease ?? chatRunLifecycle.begin(sessionId, sessionKey);
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const turnId = acceptedTurnId || `turn-${sessionId}-${lease.generation}`;
    const assistantAttemptId = `${runId}-attempt-1`;
    if (sayAloud) setMeetingVisualizerState(sessionId, "turn", "thinking");
    const visualizerToolCalls = new Set<string>();
    let selectedAutoTier = autoTier;
    let selectionElapsedMs = modelSelectionMs;
    let chatRoutingDecision: ModelRoutingDecision | undefined;
    let chatModel = resolvedModel || "unresolved";
    let chatRoutingTier: ModelRoutingDecision["tier"] | undefined;

    // Every execution enters through this boundary, including interrupt re-triggers.
    // HTTP/meeting callers may pre-register so pre-executor events are visible;
    // direct callers install their runtime here before publishing any run events.
    let runGeneration = registeredRunGeneration;
    if (runGeneration === undefined) {
      try {
        runGeneration = sessionManager.registerSession(sessionId, sessionKey, "text", {
          runId,
          turnId,
          assistantAttemptId,
        });
      } catch (regErr) {
        chatLog.warn(
          `processChatStream runtime registration failed sessionId=${sessionId}: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
        );
      }
    }

    // Pre-executor system steps (model selection, context building) happen before
    // the executor runs. We collect them here and prepend to the executor's result.
    const preSteps: Array<{
      id?: string;
      name: string;
      status: "done" | "error";
      elapsedMs?: number;
      detail?: string;
      parentId?: string;
      startedAt?: number;
      endedAt?: number;
      selfTimeMs?: number;
      metadata?: Record<string, unknown>;
      timingKind?: "span" | "milestone";
      diagnosticVisibility?: "default" | "raw" | "hidden";
      childMode?: "serial" | "parallel";
      occurredAt?: number;
    }> = [];
    const preChronology: SegmentChronologyEntry[] = [];

    // Initialize turn step at index 0 so it's the root of the tree.
    // It will be updated to "done" status when execution settles.
    const turnStepInitial = {
      id: "", // Will be set after diagnosticTurnId is generated
      name: "turn",
      status: "started" as const,
      startedAt: 0, // Will be set to turnStartedAt
    };
    preSteps.push(turnStepInitial);
    preChronology.push({ s: "system", i: 0 });

    const journal = (
      type: JournalEntry["type"],
      extra: Partial<JournalEntry> = {},
    ) => {
      writeJournal({
        ts: Date.now(),
        type,
        sessionKey,
        sessionId,
        source: "agent",
        ...extra,
      });
    };

    let assistantDraft: Awaited<
      ReturnType<typeof chatStorage.createAssistantDraft>
    > = null;
    let assistantDraftMessageId: string | undefined;
    let settlement: { status: "completed" | "failed"; assistantMessageId?: string; error?: string } | null = null;
    let terminalDurableRevision: number | undefined;
    let terminalPersistenceEndedAt: number | undefined;
    let executorSettled = false;
    let persistFailedAfterSuccess = false;

    // This identity began before runtime registration. The executor and
    // terminal persist reuse it; streaming progress is SessionManager-only.
    const diagnosticTurnId = `system-turn-${runId}`;
    const turnStartedAt = Date.now();
    // Update the pre-initialized turn step with actual IDs and timing
    turnStepInitial.id = diagnosticTurnId;
    turnStepInitial.startedAt = turnStartedAt;
    let diagnosticTurnSettled = false;
    let turnStepIndex: number | undefined;
    const settleDiagnosticTurn = (status: "done" | "error", detail?: string) => {
      if (diagnosticTurnSettled) return;
      diagnosticTurnSettled = true;
      const turnEndedAt = Date.now();
      const turnElapsedMs = turnEndedAt - turnStartedAt;
      // Resolve the live Turn root through the canonical reducer.
      sessionManager.applyEvent(sessionId, {
        type: "system_step",
        step: "turn",
        stepId: diagnosticTurnId,
        status,
        elapsedMs: turnElapsedMs,
        detail,
        startedAt: turnStartedAt,
        endedAt: turnEndedAt,
      });
      // Also update the turn step in preSteps in case it's referenced later
      if (preSteps[0]?.id === diagnosticTurnId) {
        preSteps[0].status = status;
        preSteps[0].elapsedMs = turnElapsedMs;
        preSteps[0].endedAt = turnEndedAt;
        if (detail) preSteps[0].detail = detail;
      }
      if (terminalPersistenceEndedAt != null) {
        eventBus.publish({
          category: "agent",
          event: "agent.stage_timing",
          payload: {
            runId,
            sessionId,
            stage: "finalization",
            outcome: status === "done" ? "succeeded" : "failed",
            durationMs: Math.max(0, turnEndedAt - terminalPersistenceEndedAt),
            source: "chat",
          },
          runId,
          sessionKey,
        });
      }
    };

    try {
      chatRunLifecycle.assertCurrent(lease);

      // The diagnostic turn is the root of every stage, including bootstrap
      // orientation. DO NOT emit live during pre-executor phase; emit atomically
      // after context assembly completes. This ensures the entire tree arrives
      // in one event, so parent-child relationships are always resolvable.
      sessionManager.applyEvent(sessionId, {
        type: "run_start",
        runId,
        turnId,
        assistantAttemptId,
      });
      // publishChatStreamEvent(sessionKey, sessionId, {
      //   type: "system_step",
      //   step: "turn",
      //   stepId: diagnosticTurnId,
      //   status: "started",
      //   startedAt: turnStartedAt,
      // });

      // Orientation bootstrap: unoriented sessions get a fixed-template
      // fast-tier routing call BEFORE model selection, so persona (and
      // therefore tier) is correct for the main turn. No-op when the
      // session already has a real title.
      // NOTE: Do not publishChatStreamEvent here. Steps are accumulated in
      // preSteps and emitted atomically after context assembly.
      try {
        const { ensureSessionOriented } = await import("../../orientation-bootstrap");
        const orientStartedAt = Date.now();
        const orientationStepId = `system-orientation-${lease.generation}-${orientStartedAt}`;
        // NOT emitting start: publishChatStreamEvent(sessionKey, sessionId, {...})
        const llmStepId = `system-orientation_llm_call-${lease.generation}-${orientStartedAt}`;
        const orientation = await ensureSessionOriented({
          sessionId,
          sessionKey,
          userMessage: content,
        });
        const orientEndedAt = Date.now();
        const orientElapsedMs = orientEndedAt - orientStartedAt;
        const orientDetail = orientation.applied
          ? `${orientation.title} · ${orientation.personaName}`
          : orientation.skipped === "already-oriented"
            ? "already oriented"
            : orientation.fallback
              ? `fallback · ${orientation.personaName || "Unoriented"}${orientation.fallbackReason ? ` · ${orientation.fallbackReason}` : ""}`
              : "skipped";
        // NOT emitting end: publishChatStreamEvent(sessionKey, sessionId, {...})
        if (orientation.skipped !== "already-oriented") {
          const orientationStepIndex = preSteps.length;
          preSteps.push({
            id: orientationStepId,
            name: "orientation",
            status: "done",
            elapsedMs: orientElapsedMs,
            detail: orientDetail,
            parentId: diagnosticTurnId,
            startedAt: orientStartedAt,
            endedAt: orientEndedAt,
          });
          preChronology.push({ s: "system", i: orientationStepIndex });
          if (orientation.llm) {
            const prepareStepIndex = preSteps.length;
            preSteps.push({
              id: `${orientationStepId}-prepare`,
              name: "orientation_prepare",
              status: "done",
              elapsedMs: Math.max(0, orientation.llm.startedAt - orientStartedAt),
              detail: "session · personas · connector",
              parentId: orientationStepId,
              startedAt: orientStartedAt,
              endedAt: orientation.llm.startedAt,
            });
            preChronology.push({ s: "system", i: prepareStepIndex });

            const llmDetail = `${orientation.llm.personaName} · ${orientation.llm.model} · ${orientation.llm.provider}${orientation.llm.tier ? ` · tier=${orientation.llm.tier}` : ""}`;
            const llmStepIndex = preSteps.length;
            preSteps.push({
              id: llmStepId,
              name: "orientation_llm_call",
              status: "done",
              elapsedMs: orientation.llm.elapsedMs,
              detail: llmDetail,
              parentId: orientationStepId,
              startedAt: orientation.llm.startedAt,
              endedAt: orientation.llm.endedAt,
              metadata: { llm: orientation.llm },
            });
            preChronology.push({ s: "system", i: llmStepIndex });

            const timing = orientation.llm.timing;
            if (timing) {
              const providerStart = timing.providerStartedAt ?? orientation.llm.startedAt;
              const requestSent = timing.requestSentAt ?? providerStart;
              const firstEvent = timing.firstEventAt ?? requestSent;
              const firstText = timing.firstTextAt ?? firstEvent;
              const providerEnd = timing.providerEndedAt ?? orientation.llm.endedAt;
              const phaseSteps = [
                {
                  suffix: "dispatch",
                  name: "llm_request_sent",
                  startedAt: providerStart,
                  endedAt: requestSent,
                  detail: `pool ${timing.poolEligible ? (timing.poolHit ? "hit" : "miss") : "ineligible"} · acquire ${timing.poolAcquireMs ?? 0}ms`,
                },
                {
                  suffix: "provider",
                  name: "llm_wait_provider",
                  startedAt: requestSent,
                  endedAt: firstEvent,
                  detail: `${timing.firstEventType || "first event"}`,
                },
                {
                  suffix: "first-token",
                  name: "llm_wait_first_token",
                  startedAt: firstEvent,
                  endedAt: firstText,
                  detail: `${timing.totalTtftMs ?? firstText - providerStart}ms TTFT`,
                },
                {
                  suffix: "receive",
                  name: "llm_receive_stream",
                  startedAt: firstText,
                  endedAt: providerEnd,
                  detail: `${orientation.llm.usage?.completionTokens ?? "?"} output tokens`,
                },
                {
                  suffix: "finalize",
                  name: "llm_finalize",
                  startedAt: providerEnd,
                  endedAt: orientation.llm.endedAt,
                  detail: "usage · audit · JSON",
                },
              ];
              for (const phase of phaseSteps) {
                const phaseIndex = preSteps.length;
                preSteps.push({
                  id: `${llmStepId}-${phase.suffix}`,
                  name: phase.name,
                  status: "done",
                  elapsedMs: Math.max(0, phase.endedAt - phase.startedAt),
                  detail: phase.detail,
                  parentId: llmStepId,
                  startedAt: phase.startedAt,
                  endedAt: phase.endedAt,
                });
                preChronology.push({ s: "system", i: phaseIndex });
              }
            }

            const applyStepIndex = preSteps.length;
            preSteps.push({
              id: `${orientationStepId}-apply`,
              name: "orientation_apply",
              status: "done",
              elapsedMs: Math.max(0, orientEndedAt - orientation.llm.endedAt),
              detail: orientation.personaPreserved
                ? "title · topics · persona preserved · context"
                : "title · topics · persona assigned · context",
              parentId: orientationStepId,
              startedAt: orientation.llm.endedAt,
              endedAt: orientEndedAt,
            });
            preChronology.push({ s: "system", i: applyStepIndex });
          }
        }
        chatRunLifecycle.assertCurrent(lease);
      } catch (orientErr) {
        if (!chatRunLifecycle.isCurrent(lease)) throw orientErr;
        chatLog.warn(
          `orientation bootstrap errored (non-fatal) sessionId=${sessionId}: ${orientErr instanceof Error ? orientErr.message : String(orientErr)}`,
        );
      }

      let modelSelectionStepId: string | undefined;
      let selectionStartedAt: number | undefined;
      let selectionEndedAt: number | undefined;
      if (resolvedModel) {
        chatRoutingDecision = (await resolveModelCandidates(ACTIVITY_CHAT, {
          model: resolvedModel,
          overrideReason: "chat caller requested explicit model override",
        }))[0];
      } else {
        selectionStartedAt = Date.now();
        modelSelectionStepId = `system-model_selection-${lease.generation}-${selectionStartedAt}`;
        // NOT emitting start: publishChatStreamEvent(sessionKey, sessionId, {...})
        const sessionForRouting = await chatStorage.getSession(sessionId);
        const sessionTierOverride = normalizeSessionModelTierOverride(sessionForRouting?.modelTier);
        chatRoutingDecision = (await resolveModelCandidates(
          ACTIVITY_CHAT,
          sessionTierOverride
            ? { semanticTierOverride: sessionTierOverride, overrideReason: "session model tier override", sessionId }
            : { sessionId },
        ))[0];
        chatRunLifecycle.assertCurrent(lease);
        selectedAutoTier = chatRoutingDecision.tier;
        selectionEndedAt = Date.now();
        selectionElapsedMs = selectionEndedAt - selectionStartedAt;
        // NOT emitting end: publishChatStreamEvent(sessionKey, sessionId, {...})
      }
      chatModel = chatRoutingDecision.modelString;
      chatRoutingTier = chatRoutingDecision.tier;
      if (selectionElapsedMs !== undefined) {
        const modelSelectionStepIndex = preSteps.length;
        preSteps.push({
          id: modelSelectionStepId,
          name: "model_selection",
          status: "done",
          elapsedMs: selectionElapsedMs,
          detail: selectedAutoTier || chatModel,
          parentId: diagnosticTurnId,
          startedAt: selectionStartedAt,
          endedAt: selectionEndedAt,
        });
        preChronology.push({ s: "system", i: modelSelectionStepIndex });
      }
      chatLog.log(
        `start sessionId=${sessionId} session=${sessionKey} model=${chatModel} generation=${lease.generation}`,
      );

      assistantDraft = await chatStorage.createAssistantDraft(sessionId, {
        model: chatModel,
        runId,
        turnId,
      });
      assistantDraftMessageId = assistantDraft?.id;
      chatRunLifecycle.assertCurrent(lease);

      const contextRootId = `system-context_assembly-${lease.generation}`;
      const contextStartedAt = Date.now();
      const contextSpans = new Map<string, { id: string; startedAt: number; parentId?: string }>();
      const compactionSpans = new Map<string, { startedAt: number; terminalRecorded: boolean }>();
      const onCompactionActivity = (
        update: import("../../agent-context").CompactionActivityUpdate,
      ) => {
        const stepId = `operation-${update.operationId}`;
        const existing = compactionSpans.get(update.operationId);
        const startedAt = existing?.startedAt ?? Date.now();
        if (!existing) {
          compactionSpans.set(update.operationId, {
            startedAt,
            terminalRecorded: false,
          });
        }
        const endedAt = update.status === "active" ? undefined : Date.now();
        sessionManager.applyEvent(sessionId, {
          type: "system_step",
          step: "session_compaction",
          stepId,
          status: update.status,
          startedAt,
          endedAt,
        });
        if (update.status === "active" || existing?.terminalRecorded) return;
        const index = preSteps.length;
        preSteps.push({
          id: `system-session_compaction-${stepId}`,
          name: "session_compaction",
          status: update.status,
          elapsedMs: Math.max(0, (endedAt ?? startedAt) - startedAt),
          startedAt,
          endedAt,
        });
        preChronology.push({ s: "system", i: index });
        compactionSpans.set(update.operationId, {
          startedAt,
          terminalRecorded: true,
        });
      };
      const contextParentFor = (step: string): string | undefined => {
        if (step === "context_assembly") return undefined;
        if (step.startsWith("ctx_history_") && step !== "ctx_history") {
          return contextSpans.get("ctx_history")?.id;
        }
        return contextRootId;
      };
      // NOT emitting context start: publishChatStreamEvent(sessionKey, sessionId, {...})

      const onCtxProgress = (
        step: string,
        status: "started" | "done",
        elapsedMs?: number,
      ) => {
        if (!chatRunLifecycle.isCurrent(lease)) return;
        if (status === "started") {
          const startedAt = Date.now();
          const id = `system-${step}-${lease.generation}-${startedAt}`;
          const parentId = contextParentFor(step);
          contextSpans.set(step, { id, startedAt, parentId });
          // NOT emitting progress start: publishChatStreamEvent(sessionKey, sessionId, {...})
          return;
        }
        const endedAt = Date.now();
        const span = contextSpans.get(step);
        if (span) contextSpans.delete(step);
        const id = span?.id || `system-${step}-${lease.generation}-${endedAt}`;
        const startedAt = span?.startedAt ?? endedAt - (elapsedMs || 0);
        const parentId = span?.parentId ?? contextParentFor(step);
        // NOT emitting progress end: publishChatStreamEvent(sessionKey, sessionId, {...})
        const idx = preSteps.length;
        preSteps.push({ id, name: step, status: "done", elapsedMs, parentId, startedAt, endedAt });
        preChronology.push({ s: "system", i: idx });
      };

      const budgetModel = chatModel.includes("/")
        ? chatModel.split("/").slice(1).join("/")
        : chatModel;
      const { getContextWindow, getMaxOutputTokens } = await import("../../model-registry");
      const { getContextRequestBudget } = await import("../../context-budget");
      const configuredMaxOutput = (
        chatRoutingDecision?.modelConfig as { maxOutputTokens?: number } | undefined
      )?.maxOutputTokens;
      const outputReserveIsExplicit =
        typeof configuredMaxOutput === "number" && configuredMaxOutput > 0;
      const historyBudget = getContextRequestBudget(
        getContextWindow(budgetModel),
        outputReserveIsExplicit ? configuredMaxOutput : getMaxOutputTokens(budgetModel),
        outputReserveIsExplicit,
      );
      const {
        messages,
        conversationHistory,
        enrichedContent,
        toolDefs,
        authorityStubTools,
        contextPressure,
      } = await buildChatHistory(
        sessionId,
        content,
        chatModel,
        historyBudget.hardInputLimit,
        onCtxProgress,
        currentMessageIds,
        lease.generation,
        runId,
        onCompactionActivity,
      );
      chatRunLifecycle.assertCurrent(lease);
      const contextEndedAt = Date.now();
      const contextElapsedMs = contextEndedAt - contextStartedAt;
      eventBus.publish({
        category: "agent",
        event: "agent.stage_timing",
        payload: {
          runId,
          sessionId,
          stage: "context_assembly",
          outcome: "succeeded",
          durationMs: contextElapsedMs,
          messageCount: messages.length,
          toolCount: toolDefs.length,
          source: "chat",
        },
        runId,
        sessionKey,
      });
      // NOT emitting end: publishChatStreamEvent(sessionKey, sessionId, {...})
      const contextStepIndex = preSteps.length;
      preSteps.push({
        id: contextRootId,
        name: "context_assembly",
        status: "done",
        elapsedMs: contextElapsedMs,
        parentId: diagnosticTurnId,
        startedAt: contextStartedAt,
        endedAt: contextEndedAt,
        childMode: "parallel",
      });
      preChronology.push({ s: "system", i: contextStepIndex });

      // Apply the complete pre-executor trace through one reducer transaction so
      // reconnecting and already-connected clients observe the same coherent tree.
      const preStepEvents: SessionStreamEvent[] = preSteps.map((step) => ({
        type: "system_step",
        step: step.name,
        status: step.status,
        elapsedMs: step.elapsedMs,
        detail: step.detail,
        stepId: step.id,
        parentId: step.parentId,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        selfTimeMs: step.selfTimeMs,
        timingKind: step.timingKind,
        diagnosticVisibility: step.diagnosticVisibility,
        childMode: step.childMode,
        occurredAt: step.occurredAt,
        metadata: step.metadata,
      }));
      sessionManager.applyEvents(sessionId, preStepEvents);

      chatLog.log(
        `executor START sessionId=${sessionId} messageCount=${messages.length} toolCount=${toolDefs.length}`,
      );
      const resolvedRoutingDecision = chatRoutingDecision;
      if (!resolvedRoutingDecision) {
        throw new Error("Chat routing decision was not resolved");
      }
      const refreshAfterPersonaSwitch: NonNullable<Parameters<typeof agentExecutor.run>[0]["refreshAfterPersonaSwitch"]> = async () => {
        chatRunLifecycle.assertCurrent(lease);
        const sessionForRouting = await chatStorage.getSession(sessionId);
        const sessionTierOverride = normalizeSessionModelTierOverride(sessionForRouting?.modelTier);
        const routingDecision = (await resolveModelCandidates(
          ACTIVITY_CHAT,
          sessionTierOverride
            ? {
                semanticTierOverride: sessionTierOverride,
                overrideReason: "session model tier override",
                sessionId,
              }
            : { sessionId },
        ))[0];

        let meetingContext: string | undefined;
        if (sessionForRouting?.type === "meeting" && sessionForRouting.meeting) {
          try {
            const { buildMeetingContextPacket, renderMeetingContextPacket } = await import("../../meeting/context-packet");
            const packet = await buildMeetingContextPacket(sessionForRouting.meeting);
            meetingContext = packet ? renderMeetingContextPacket(packet) : undefined;
          } catch (err) {
            chatLog.warn(`persona switch meeting context degraded sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const refreshedToolSet = await resolveInteractiveToolSet(sessionId);
        const refreshedContext = await assembleContext({
          profile: "chat",
          conversationHistory,
          toolDefinitions: refreshedToolSet.definitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
          model: routingDecision.modelString,
          sessionId,
          contextBuildId: `${runId}:persona-refresh`,
          currentMessage: enrichedContent,
          meetingContext,
        });
        const { resolveSessionPersonaSnapshot } = await import("../../session-persona");
        const persona = await resolveSessionPersonaSnapshot(sessionId);
        if (assistantDraft && persona) {
          const updatedDraft = await chatStorage.updateAssistantDraft(sessionId, assistantDraft.id, {
            model: routingDecision.modelString,
            persona,
          });
          assistantDraft = updatedDraft?.message ?? null;
        }
        chatRunLifecycle.assertCurrent(lease);
        return {
          routingDecision,
          systemPrompt: refreshedContext.systemPrompt,
          tools: refreshedToolSet.definitions,
          persona,
        };
      };

      const refreshToolSchema: NonNullable<Parameters<typeof agentExecutor.run>[0]["refreshToolSchema"]> = async (toolName) => {
        chatRunLifecycle.assertCurrent(lease);
        const authorityDefinitions = await resolveAuthorityToolDefinitions(sessionId);
        const schema = authorityDefinitions.find((tool) => tool.name === toolName) ?? null;
        chatLog.log(
          `tool schema hydration requested tool=${toolName} allowed=${!!schema} authorityCount=${authorityDefinitions.length} sessionId=${sessionId}`,
        );
        return schema;
      };

      const result = await executeChatAgent(
        sessionKey,
        sessionId,
        messages,
        toolDefs,
        authorityStubTools,
        resolvedRoutingDecision,
        contextPressure,
        (event) => {
          if (sayAloud && event.type === "tool_call") {
            if (event.toolCallId) visualizerToolCalls.add(event.toolCallId);
            setMeetingVisualizerState(sessionId, "tool", "tool_call");
          } else if (sayAloud && event.type === "tool_result") {
            if (event.toolCallId) visualizerToolCalls.delete(event.toolCallId);
            if (visualizerToolCalls.size === 0) clearMeetingVisualizerState(sessionId, "tool");
          }
        },
        chatRoutingTier,
        runId,
        diagnosticTurnId,
        refreshAfterPersonaSwitch,
        refreshToolSchema,
        clientId,
      );
      chatLog.log(
        `executor DONE sessionId=${sessionId} contentLen=${result.content?.length || 0} terminationReason=${result.terminationReason || "unknown"} abortReason=${result.abortReason || "none"} durationMs=${result.durationMs ?? "?"} iterations=${result.iterations}`,
      );
      chatRunLifecycle.assertCurrent(lease);
      settleDiagnosticTurn("done");
      executorSettled = true;

      const durationStr =
        result.durationMs != null
          ? `${(result.durationMs / 60000).toFixed(1)} minutes`
          : "unknown duration";
      const toolCallCount = result.toolCalls?.length ?? 0;
      const toolCountStr =
        toolCallCount > 0
          ? `${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}`
          : "";

      let responseContent = result.content || "";
      const isSuperseded = result.abortReason === "superseded";
      // Mission completed cleanly — drop sticky approved stance so the next
      // turn starts fresh rather than inheriting a finished mission.
      if (!isSuperseded && result.status !== "failed" && !result.abortReason) {
        agentExecutor.clearSessionHandoff(sessionId, "run_completed");
      }

      // Superseded runs: delete the assistant draft and skip the entire save
      // path. The draft was checkpointed with partial streamed content; leaving
      // it creates a ghost duplicate. The re-trigger in the finally block
      // creates a fresh assistant message for the new run.
      if (isSuperseded && assistantDraft) {
        chatLog.log(
          `superseded: deleting assistant draft ${assistantDraft.id} sessionId=${sessionId}`,
        );
        await chatStorage
          .deleteMessage(sessionId, assistantDraft.id)
          .catch((err) =>
            chatLog.warn(
              `superseded draft delete failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        assistantDraft = null;
        // Fall through to finally block which handles cleanup + re-trigger.
        // No message to save, no notice to create, no journal entry.
      }

      // Failed and degraded outcomes use the same canonical notice surface.
      // Superseded runs end quietly because their replacement begins automatically.
      let systemNotice: SystemNotice | undefined;
      if ((result.status === "failed" || result.status === "degraded") && result.abortReason !== "superseded") {
        systemNotice = buildSystemNotice(result);
      }

      // Only invent plain assistant text when there is no system_notice to own
      // the empty outcome. Degraded/failed empty turns render the notice widget.
      if (
        responseContent.trim() === "" &&
        !isSuperseded &&
        !systemNotice &&
        !result.intentionalStopReason
      ) {
        const parts = ["I wasn't able to generate a response."];
        const errorDetail = result.error
          ? sanitizeErrorForUser(result.error)
          : "";
        const abortDescription =
          result.status === "failed"
            ? describeAbortReasonForUser(result)
            : null;
        if (abortDescription) {
          parts.push(abortDescription);
        } else if (result.status === "failed") {
          parts.push(
            `Termination reason: ${(result.terminationReason || "unknown").replace(/_/g, " ")}.`,
          );
        } else {
          parts.push("The model completed without returning visible text.");
        }
        if (errorDetail) {
          parts.push(`Cause: ${errorDetail}`);
        }
        parts.push(
          result.abortReason
            ? "Send another message and I'll continue from the last completed step."
            : "Try rephrasing your question.",
        );
        responseContent = parts.join(" ");
      }

      const persistedThinking = result.thinking || undefined;

      // Build persisted tool calls from executor result (mapping executor format to storage format)
      let persistedToolCalls:
        | Array<{
            toolName: string;
            toolCallId: string;
            arguments?: Record<string, unknown>;
            result?: unknown;
            error?: string;
            failureKind?: import("@shared/tool-failure").ToolFailureKind;
            failureCode?: string;
            status: string;
            outcome: import("../../agent-executor").ToolOutcome;
            parentId?: string;
          }>
        | undefined;
      if (result.toolCalls && result.toolCalls.length > 0) {
        persistedToolCalls = result.toolCalls.map((tc, i) => ({
          toolName: tc.name,
          toolCallId: tc.id || `tc-${sessionId.slice(0, 8)}-${i}`,
          arguments: tc.args,
          result: tc.result,
          error:
            tc.error && typeof tc.error !== "boolean"
              ? String(tc.error)
              : undefined,
          ...(tc.failureKind ? { failureKind: tc.failureKind } : {}),
          ...(tc.failureCode ? { failureCode: tc.failureCode } : {}),
          status: tc.error ? "error" : "done",
          outcome: tc.outcome,
          parentId: tc.parentId,
        }));
        for (const tc of persistedToolCalls) {
          chatLog.debug(
            `preSave toolCall id=${tc.toolCallId} name=${tc.toolName} hasArgs=${!!(tc.arguments && Object.keys(tc.arguments).length > 0)} hasResult=${!!tc.result} status=${tc.status} sessionId=${sessionId}`,
          );
        }
      }

      // Merge pre-executor system steps with executor's system steps and chronology.
      // Pre-executor steps (model_selection, context building) precede executor steps.
      const executorSteps = result.systemSteps || [];
      const executorChronology = result.segmentChronology || [];

      // Reindex executor chronology system entries to account for prepended pre-steps
      const preStepCount = preSteps.length;
      const mergedSystemSteps = [...preSteps, ...executorSteps];
      const mergedChronology: SegmentChronologyEntry[] = [
        ...preChronology,
        ...executorChronology.map((entry) =>
          entry.s === "system"
            ? { ...entry, i: entry.i + preStepCount }
            : entry,
        ),
      ];

      const persistedSystemSteps =
        mergedSystemSteps.length > 0 ? mergedSystemSteps : undefined;
      const persistedChronology =
        mergedChronology.length > 0 ? mergedChronology : undefined;

      const usedModel = result.model || chatModel;
      const persistedRunUsage = result.runId
        ? await import("../../file-storage/api-calls")
            .then((m) =>
              m.fileApiCallStorage.getTokenUsageByRunId(result.runId!),
            )
            .catch(() => null)
        : null;
      const turnCost = persistedRunUsage?.cost ?? result.cost ?? 0;
      const turnApiCallCount =
        persistedRunUsage?.calls ??
        result.apiCallCount ??
        result.iterations ??
        1;
      const turnTokenUsage = {
        inputTokens:
          persistedRunUsage?.inputTokens ?? result.usage?.inputTokens ?? 0,
        outputTokens:
          persistedRunUsage?.outputTokens ?? result.usage?.outputTokens ?? 0,
        totalTokens:
          persistedRunUsage?.totalTokens ?? result.usage?.totalTokens ?? 0,
      };

      // Skip entire message persistence for superseded runs — draft already
      // deleted above, no message to save, no journal entry to create.
      if (!isSuperseded) {
      const persistenceStartedAt = Date.now();
      const lastRequestContextPressure =
        sessionManager.getSnapshot(sessionId)?.streamingContent.contextPressure ??
        undefined;
      // The stream snapshot describes the final provider request. Once the
      // assistant reply settles, add that newly carried message so the durable
      // ring describes the context retained for the next turn rather than the
      // request that just finished.
      let finalContextPressure = lastRequestContextPressure;
      if (lastRequestContextPressure && responseContent) {
        const {
          applyTokenEstimateCalibration,
          estimateMessagesInputTokens,
        } = await import("../../context-budget");
        const pressureModel = usedModel.includes("/")
          ? usedModel.split("/").slice(1).join("/")
          : usedModel;
        const carriedAssistantTokens = await applyTokenEstimateCalibration(
          pressureModel,
          estimateMessagesInputTokens([{ role: "assistant", content: responseContent }]),
        );
        finalContextPressure = {
          ...lastRequestContextPressure,
          inputTokens: lastRequestContextPressure.inputTokens + carriedAssistantTokens,
        };
      }
      chatLog.log(
        `saving message sessionId=${sessionId} thinkingLen=${persistedThinking?.length || 0} toolCallsCount=${persistedToolCalls?.length || 0} contentLen=${responseContent.length} systemSteps=${mergedSystemSteps.length}`,
      );

      const terminalDraftWrite = assistantDraft
        ? await chatStorage.updateAssistantDraft(sessionId, assistantDraft.id, {
            content: responseContent,
            thinking: persistedThinking,
            toolCalls: persistedToolCalls,
            model: usedModel,
            systemSteps: persistedSystemSteps,
            cost: turnCost,
            apiCallCount: turnApiCallCount,
            inputTokens: turnTokenUsage.inputTokens,
            outputTokens: turnTokenUsage.outputTokens,
            totalTokens: turnTokenUsage.totalTokens,
            contextPressure: finalContextPressure,
            segmentChronology: persistedChronology,
            assistantState:
              result.status === "succeeded" || result.status === "degraded" ? "complete" : "failed",
            sessionStatus:
              result.status === "succeeded" || result.status === "degraded" ? "saved" : "failed",
          })
        : null;
      const createdTerminalMessage = assistantDraft
        ? null
        : await chatStorage.createMessage(
            sessionId,
            "assistant",
            responseContent,
            persistedThinking,
            persistedToolCalls,
            usedModel,
            persistedSystemSteps,
            turnCost,
            turnApiCallCount,
            persistedChronology,
            undefined,
            undefined,
            turnTokenUsage,
            undefined,
            undefined,
            undefined,
            finalContextPressure,
          );
      const msg = terminalDraftWrite?.message ?? createdTerminalMessage;
      if (msg && (result.status === "succeeded" || result.status === "degraded")) {
        const continuityPrincipal = getCurrentPrincipal();
        const continuityStartedAt = Date.now();
        if (!continuityPrincipal || continuityPrincipal.actorType !== "user") {
          chatLog.error(
            `completed turn continuity skipped without user principal sessionId=${sessionId} assistantMessageId=${msg.id}`,
          );
        } else {
          void runWithPrincipal(continuityPrincipal, async () => {
            try {
              const continuitySession = await chatStorage.getSession(sessionId);
              const latestUser = [...(continuitySession?.messages || [])]
                .reverse()
                .find((message) => message.role === "user" && message.createdAt <= msg.createdAt);
              if (!continuitySession?.vaultId) {
                throw new Error("Completed turn has no canonical session Vault");
              }
              const { emitCompletedTurnSummary } = await import("../../historical-continuity");
              await emitCompletedTurnSummary({
                sessionId,
                vaultId: continuitySession.vaultId,
                assistantMessageId: msg.id,
                turnId,
                runId,
                completedAt: msg.createdAt,
                userContent: latestUser?.content || "",
                assistantContent: responseContent,
                toolCalls: (persistedToolCalls || []).map((toolCall) => ({
                  toolName: toolCall.toolName,
                  status: toolCall.status,
                  outcome: toolCall.outcome,
                  result: toolCall.result,
                  error: toolCall.error,
                })),
              });
              chatLog.info(
                `completed turn continuity finished sessionId=${sessionId} assistantMessageId=${msg.id} durationMs=${Date.now() - continuityStartedAt} blocking=false`,
              );
            } catch (continuityError) {
              chatLog.warn(
                `completed turn continuity failed sessionId=${sessionId} assistantMessageId=${msg.id} durationMs=${Date.now() - continuityStartedAt} blocking=false error=${continuityError instanceof Error ? continuityError.message : String(continuityError)}`,
              );
            }
          });
          chatLog.debug(
            `completed turn continuity started sessionId=${sessionId} assistantMessageId=${msg.id} blocking=false`,
          );
        }
      }
      if (terminalDraftWrite) {
        terminalDurableRevision = terminalDraftWrite.durableRevision;
      }
      terminalPersistenceEndedAt = Date.now();
      chatLog.debug(
        `assistant persistence committed sessionId=${sessionId} assistantMessageId=${msg?.id || "none"} durationMs=${terminalPersistenceEndedAt - persistenceStartedAt} blocking=true`,
      );
      eventBus.publish({
        category: "agent",
        event: "agent.stage_timing",
        payload: {
          runId,
          sessionId,
          stage: "persistence",
          outcome: "succeeded",
          durationMs: terminalPersistenceEndedAt - persistenceStartedAt,
          source: "chat",
        },
        runId,
        sessionKey,
      });

      if (persistedThinking && persistedThinking.length >= 50) {
        try {
          const { saveThought, makeThoughtHeader } =
            await import("../../thoughts");
          const header = makeThoughtHeader("thought");
          await saveThought(
            `${header}\n${persistedThinking}`,
            `chat:${sessionId}`,
            "thought",
          );
        } catch (thErr: unknown) {
          chatLog.error(
            `Failed to save thinking as observation: ${thErr instanceof Error ? thErr.message : String(thErr)}`,
          );
        }
      }

      await chatStorage
        .setHasUnreadResult(sessionId, true)
        .catch((err) =>
          chatLog.warn(`setHasUnreadResult failed sessionId=${sessionId}`, err),
        );

      // Persist system_notice as a separate message and set session error severity
      if (systemNotice) {
        try {
          await chatStorage.createMessage(
            sessionId,
            "system_notice",
            JSON.stringify(systemNotice),
          );
          await chatStorage.setErrorSeverity(sessionId, systemNotice.severity);
          journal("system_notice", {
            severity: systemNotice.severity,
            content: JSON.stringify(systemNotice),
          });
        } catch (noticeErr: unknown) {
          chatLog.warn(
            `failed to persist system_notice sessionId=${sessionId}: ${noticeErr instanceof Error ? noticeErr.message : String(noticeErr)}`,
          );
        }
      } else if (result.status === "succeeded") {
        // Clear stale error severity on successful completion (recovery)
        await chatStorage
          .setErrorSeverity(sessionId, null)
          .catch((err) =>
            chatLog.warn(
              `clearErrorSeverity failed sessionId=${sessionId}`,
              err,
            ),
          );
      }

      if (result.status === "succeeded" && responseContent.trim() && onResponse) {
        await onResponse(responseContent).catch((err) =>
          chatLog.error(`response callback failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      if (sayAloud && !isSuperseded && responseContent.trim()) {
        clearMeetingVisualizerState(sessionId, "tool");
        clearMeetingVisualizerState(sessionId, "turn");
        const currentSession = await chatStorage.getSession(sessionId);
        if (currentSession?.type === "meeting") {
          const speechRequestedAt = Date.now();
          chatLog.log(
            `meeting speech scheduled sessionId=${sessionId} runId=${runId} turnId=${turnId} assistantMessageId=${msg?.id || "none"} resultStatus=${result.status} terminationReason=${result.terminationReason || "unknown"} contentLen=${responseContent.length} postPersistenceMs=${terminalPersistenceEndedAt == null ? "unknown" : speechRequestedAt - terminalPersistenceEndedAt}`,
          );
          import("../../meeting/output-media")
            .then(({ speakMeetingResponse }) => speakMeetingResponse(sessionId, responseContent, {
              runId,
              turnId,
              assistantMessageId: msg?.id,
              requestedAt: speechRequestedAt,
            }))
            .catch((err) => chatLog.error(`say-aloud failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      const savedRunId =
        getSessionRunStatus(sessionId).currentRunId ?? undefined;
      journal("saved", {
        runId: savedRunId,
        messageId: msg!.id,
        fullResponse: result.content,
        thinking: persistedThinking,
        toolCalls: persistedToolCalls,
        terminationReason: result.terminationReason,
        iterationsUsed: result.iterations,
        cost: turnCost,
        apiCallCount: turnApiCallCount,
        inputTokens: turnTokenUsage.inputTokens,
        outputTokens: turnTokenUsage.outputTokens,
        totalTokens: turnTokenUsage.totalTokens,
      });
      const resultSettled = result.status === "succeeded" || result.status === "degraded";
      settlement = {
        status: resultSettled ? "completed" : "failed",
        assistantMessageId: msg!.id,
        ...(resultSettled ? {} : { error: result.error || result.terminationReason || "executor_failed" }),
      };
      } // end if (!isSuperseded)
    } catch (error: unknown) {
      if (error instanceof ChatRunInvalidatedError) {
        settleDiagnosticTurn("error", error.reason);
        chatLog.log(
          `${error.reason} before settlement sessionId=${sessionId} generation=${lease.generation}`,
        );
        if (assistantDraft) {
          await chatStorage.deleteMessage(sessionId, assistantDraft.id).catch((deleteErr) =>
            chatLog.warn(`superseded draft delete failed sessionId=${sessionId}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`),
          );
        }
        settlement = { status: "failed", error: error.reason };
        return;
      }
      if (executorSettled) {
        const rawError =
          (error instanceof Error ? error.message : String(error)) ||
          "unknown error";
        // Drizzle wraps query failures so error.message is only the SQL text
        // ("Failed query: update conversation_messages ..."); the real Postgres
        // cause and SQLSTATE live on error.cause. Unwrap it so the persist_failed
        // class is diagnosable by sessionId ↔ sqlstate instead of a truncated
        // SQL dump, and keep the raw query text out of the user-facing notice.
        const pgDetail = getPostgresErrorDetails(error);
        chatLog.warn(
          `persist failed after successful executor sessionId=${sessionId} sqlstate=${pgDetail.code} errorType=${pgDetail.errorType}: ${rawError}`,
        );
        const persistNotice: SystemNotice = {
          severity: "warning",
          errorType: "persist_failed",
          description:
            pgDetail.code !== "unknown"
              ? `The answer is ready, but saving it failed (database error ${pgDetail.code}).`
              : `The answer is ready, but saving it failed: ${sanitizeErrorForUser(rawError)}`,
          actionHint: "The live answer is still here. Retry if it disappears after refresh.",
        };
        await chatStorage
          .createMessage(sessionId, "system_notice", JSON.stringify(persistNotice))
          .catch((saveErr) =>
            chatLog.warn(
              `persist warning notice failed sessionId=${sessionId}: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
            ),
          );
        // Same contract as ordinary system notices: undismissed warning owns
        // Session Menu REVIEW / Home session_review until explicit dismiss.
        await chatStorage
          .setErrorSeverity(sessionId, "warning")
          .catch((sevErr) =>
            chatLog.warn(
              `persist warning severity failed sessionId=${sessionId}: ${sevErr instanceof Error ? sevErr.message : String(sevErr)}`,
            ),
          );
        journal("system_notice", {
          severity: "warning",
          content: JSON.stringify(persistNotice),
        });
        persistFailedAfterSuccess = true;
        settlement = { status: "completed" };
        return;
      }
      settleDiagnosticTurn("error", "processing error");
      chatLog.error(
        `executor error sessionId=${sessionId}: ${(error instanceof Error ? error.message : String(error)) || error}`,
      );
      journal("error", {
        error:
          (error instanceof Error ? error.message : String(error)) ||
          "Failed to process message",
      });

      try {
        const rawError =
          (error instanceof Error ? error.message : String(error)) ||
          "unknown error";
        const isOverloaded = rawError.includes("overloaded_error");

        // Persist any partial assistant content if available (system steps, chronology).
        // Draft content/thinking live on the session snapshot — never as free variables
        // in this catch scope (assistantDraftContent/Thinking were unbound and crashed
        // the error-save path on every executor failure).
        const crashSystemSteps = preSteps.length > 0 ? preSteps : undefined;
        const crashChronology =
          preChronology.length > 0 ? preChronology : undefined;
        const crashSnapshot = sessionManager.getSnapshot(sessionId);
        const crashProjection = crashSnapshot
          ? projectAssistantDraft(crashSnapshot.streamingContent)
          : null;
        if (typeof assistantDraft !== "undefined" && assistantDraft) {
          await chatStorage.updateAssistantDraft(sessionId, assistantDraft.id, {
            content:
              crashProjection?.content ||
              "Response interrupted by an error before completion.",
            thinking: crashProjection?.thinking || undefined,
            model: chatModel,
            systemSteps: crashSystemSteps,
            segmentChronology: crashChronology,
            assistantState: "failed",
            sessionStatus: "failed",
            assistantInterruptedAt: new Date().toISOString(),
          });
        } else if (crashSystemSteps) {
          await chatStorage.createMessage(
            sessionId,
            "assistant",
            "Response interrupted by an error before completion.",
            undefined,
            undefined,
            chatModel,
            crashSystemSteps,
            undefined,
            undefined,
            crashChronology,
          );
        }

        // Create a system_notice for the crash
        const crashNotice: SystemNotice = {
          severity: "error",
          errorType: isOverloaded ? "temporarily_busy" : "something_went_wrong",
          description: isOverloaded
            ? "The AI is temporarily busy."
            : `Processing error: ${sanitizeErrorForUser(rawError)}`,
          actionHint: isOverloaded
            ? "Try again in a moment."
            : "Try rephrasing or starting a new session.",
        };
        await chatStorage.createMessage(
          sessionId,
          "system_notice",
          JSON.stringify(crashNotice),
        );
        await chatStorage.setErrorSeverity(sessionId, "error");
        journal("system_notice", {
          severity: "error",
          content: JSON.stringify(crashNotice),
        });
      } catch (saveErr: unknown) {
        chatLog.error(
          `failed to save error message sessionId=${sessionId}: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        );
      }

      settlement = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };

      await chatStorage
        .updateSessionStatus(sessionId, "failed")
        .catch((err) =>
          chatLog.warn(
            `status update to failed failed sessionId=${sessionId}`,
            err,
          ),
        );
    } finally {
      // Release post-run settling gate and apply any deferred session.end /
      // set_status only after toolCalls have been (or failed to be) persisted.
      try {
        const { agentExecutor } = await import("../../agent-executor");
        const pending = agentExecutor.takePendingSessionEnd(sessionId);
        agentExecutor.endSessionSettling(sessionId);
        if (pending) {
          if (pending.status === "failed") {
            await chatStorage.setErrorSeverity(sessionId, "error").catch(() => undefined);
          }
          await chatStorage
            .updateSessionStatus(sessionId, pending.status, pending.summary)
            .catch((err) =>
              chatLog.warn(
                `deferred session status apply failed sessionId=${sessionId} status=${pending.status}`,
                err,
              ),
            );
          await chatStorage.setSessionPinned(sessionId, false).catch(() => undefined);
          agentExecutor.markAppliedSessionEnd(sessionId, pending);
          if (pending.status === "saved") {
            try {
              const { runDeferredPostRunVerify } = await import("../../autonomous-skill-runner");
              await runDeferredPostRunVerify(sessionId);
            } catch (e: unknown) {
              chatLog.warn(
                `deferred postRunVerify after pending end failed sessionId=${sessionId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          agentExecutor.clearAppliedSessionEnd(sessionId);
        }
      } catch (e: unknown) {
        chatLog.warn(
          `settling/pending-end cleanup failed sessionId=${sessionId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (sayAloud) {
        clearMeetingVisualizerState(sessionId, "tool");
        clearMeetingVisualizerState(sessionId, "turn");
      }
      if (assistantDraftMessageId && !persistFailedAfterSuccess) {
        const terminalState = settlement?.status === "completed"
          ? "complete"
          : lease.invalidatedBy
            ? "interrupted"
            : "failed";
        try {
          const terminalization = await chatStorage.terminalizeAssistantDraft(
            sessionId,
            assistantDraftMessageId,
            runId,
            terminalState,
            terminalState === "complete" ? undefined : new Date().toISOString(),
          );
          if (
            terminalDurableRevision === undefined &&
            "durableRevision" in terminalization
          ) {
            terminalDurableRevision = terminalization.durableRevision;
          }
          if (terminalization.outcome === "run_mismatch") {
            chatLog.error(
              `assistant draft terminalization ownership mismatch sessionId=${sessionId} messageId=${assistantDraftMessageId} expectedRunId=${runId} actualRunId=${terminalization.actualRunId || "none"}`,
            );
          } else if (
            terminalization.outcome === "not_found" &&
            !lease.invalidatedBy
          ) {
            chatLog.error(
              `assistant draft terminalization target missing sessionId=${sessionId} messageId=${assistantDraftMessageId} runId=${runId}`,
            );
          }
        } catch (terminalizationError) {
          chatLog.error(
            `assistant draft terminalization failed sessionId=${sessionId} messageId=${assistantDraftMessageId} runId=${runId}: ${terminalizationError instanceof Error ? terminalizationError.message : String(terminalizationError)}`,
          );
        }
      }
      if (onSettled) {
        await onSettled(settlement || { status: "failed", error: "run_did_not_settle" }).catch((error) =>
          chatLog.error(`stream settlement callback failed sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      const settledCurrent = chatRunLifecycle.finish(lease);
      chatLog.log(
        `stream cleanup sessionId=${sessionId} generation=${lease.generation} current=${settledCurrent}`,
      );
      if (settledCurrent) {
        try {
          const { sessionManager } = await import("../../session-manager");
          sessionManager.finalizeSession(sessionId, runGeneration, terminalDurableRevision);
        } catch (finErr) {
          chatLog.debug(
            `sessionManager.finalizeSession skipped: ${finErr instanceof Error ? finErr.message : String(finErr)}`,
          );
        }
      }
    }
  }

  const { registerSlackChatTurnRunner } = await import("../../slack/turn-service");
  registerSlackChatTurnRunner(async ({ sessionId, eventId, content, signal }) => {
    const session = await chatStorage.getSession(sessionId);
    if (!session) throw new Error("slack_session_unavailable");
    const sessionKey = session.sessionKey || `slack:${sessionId}`;
    const lease = chatRunLifecycle.begin(sessionId, sessionKey);
    const abortRun = () => { chatRunLifecycle.cancel(sessionId); };
    if (signal.aborted) {
      abortRun();
      throw new Error("slack_turn_deadline");
    }
    signal.addEventListener("abort", abortRun, { once: true });
    await chatStorage.updateSessionStatus(sessionId, "streaming").catch((err) =>
      chatLog.warn(`slack status update to streaming failed sessionId=${sessionId}`, err),
    );
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (status: "completed" | "failed", response?: string, error?: string) => {
          if (settled) return;
          settled = true;
          if (status === "completed" && response?.trim()) resolve(response);
          else reject(new Error(error || "slack_empty_response"));
        };
        processChatStream(
          sessionKey,
          sessionId,
          content,
          undefined,
          undefined,
          undefined,
          false,
          async (response) => { finish("completed", response); },
          undefined,
          lease,
          undefined,
          async (result) => {
            if (result.status === "completed") finish("completed", undefined, "slack_empty_response");
            else finish("failed", undefined, result.error || "slack_turn_failed");
          },
          undefined,
          `slack:${eventId}`,
        ).catch((error) => {
          if (error instanceof ChatRunInvalidatedError) {
            finish("failed", undefined, `slack_turn_${error.reason}`);
            return;
          }
          finish("failed", undefined, error instanceof Error ? error.message : "slack_turn_failed");
        });
      });
    } finally {
      signal.removeEventListener("abort", abortRun);
    }
  });

  app.post(
    "/api/sessions/:id/messages",
    async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      let acceptedLease: ChatRunLease | undefined;
      try {
        const {
          content,
          isGreeting,
          clientTurnId: rawClientTurnId,
          pageContext: incomingPageContext,
          questionResponse: incomingQuestionResponse,
          clientId: rawClientId,
        } = req.body;
        const clientId = typeof rawClientId === "string" && /^client-[a-zA-Z0-9-]{8,113}$/.test(rawClientId)
          ? rawClientId
          : undefined;
        const clientTurnId = typeof rawClientTurnId === "string" && rawClientTurnId.length <= 120
          ? rawClientTurnId
          : undefined;
        chatLog.log(
          `message start sessionId=${sessionId} contentLen=${content?.length || 0} isGreeting=${!!isGreeting}`,
        );

        if ((!content || typeof content !== "string") && !incomingQuestionResponse) {
          return res.status(400).json({ error: "Message content is required" });
        }

        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          chatLog.log(`session not found sessionId=${sessionId}`);
          return res.status(404).json({ error: "Session not found" });
        }

        const msgPageContext = incomingPageContext
          ? (normalizePageContext(incomingPageContext) ?? undefined)
          : undefined;
        let acceptedContent = typeof content === "string" ? content : "";
        let acceptedQuestionResponse: QuestionResponseMeta | undefined;
        let acceptedQuestionPrompt: QuestionPrompt | undefined;
        if (incomingQuestionResponse) {
          if (isGreeting) {
            return res.status(400).json({ error: "Greeting messages cannot answer questions." });
          }
          if (!clientTurnId) {
            return res.status(400).json({ error: "clientTurnId is required for question responses." });
          }
          const existingMessages = await chatStorage.getMessagesBySession(sessionId);
          const resolvedResponse = resolveQuestionResponse(existingMessages, incomingQuestionResponse);
          if (!resolvedResponse.ok) {
            return res.status(resolvedResponse.status).json({ error: resolvedResponse.error });
          }
          acceptedContent = resolvedResponse.content;
          acceptedQuestionResponse = resolvedResponse.response;
          acceptedQuestionPrompt = resolvedResponse.prompt;
        }
        // Answering in chat (a normal message, not a widget response) while an
        // inline question is still awaiting supersedes that question. Stamp a
        // cancellation marker on the superseding message so the widget resolves.
        let acceptedQuestionCancellation: QuestionCancellationMeta | undefined;
        if (!incomingQuestionResponse && !isGreeting && clientTurnId && acceptedContent.trim()) {
          const priorMessages = await chatStorage.getMessagesBySession(sessionId);
          const supersededToolCallId = getActiveQuestionToolCallId(priorMessages);
          if (supersededToolCallId) {
            acceptedQuestionCancellation = {
              questionToolCallId: supersededToolCallId,
              reason: "superseded_by_message",
            };
          }
        }
        let acceptedDecisionId: string | undefined;
        if (!isGreeting && clientTurnId) {
          const acceptance = await chatStorage.createUserMessageOnce(
            sessionId,
            acceptedContent,
            clientTurnId,
            msgPageContext,
            acceptedQuestionResponse,
            acceptedQuestionCancellation,
            acceptedQuestionPrompt,
          );
          if (acceptance.outcome === "session_not_found") {
            return res.status(404).json({ error: "Session not found" });
          }
          if (acceptance.outcome === "question_already_answered") {
            return res.status(409).json({
              error: "This question has already been answered.",
              ...(acceptance.decisionId ? { decisionId: acceptance.decisionId } : {}),
            });
          }
          if (acceptance.outcome === "duplicate") {
            chatLog.warn(`duplicate message replay ignored sessionId=${sessionId} clientTurnId=${clientTurnId}`);
            return res.status(session.status === "streaming" ? 202 : 200).json({
              duplicate: true,
              sessionKey: session.sessionKey || `dashboard:${sessionId}`,
              sessionId,
              status: session.status,
              queued: session.status === "streaming",
              ...(acceptance.decisionId ? { decisionId: acceptance.decisionId } : {}),
            });
          }
          acceptedDecisionId = acceptance.decisionId;
        }

        const wasInFlight =
          chatRunLifecycle.current(sessionId) !== undefined ||
          agentExecutor.hasActiveRunForSession(sessionId);
        acceptedLease = chatRunLifecycle.begin(sessionId, `dashboard:${sessionId}`);
        const abortCount = wasInFlight
          ? agentExecutor.abortByChatSessionId(sessionId, "superseded")
          : 0;

        // Detect voice→text transition for observability
        if (!isGreeting) {
          const existingMessages =
            await chatStorage.getMessagesBySession(sessionId);
          const hasVoiceHistory = existingMessages.some(
            (m) => m.model === "elevenlabs-voice",
          );
          if (hasVoiceHistory) {
            const voiceCount = existingMessages.filter(
              (m) => m.model === "elevenlabs-voice",
            ).length;
            chatLog.log(
              `voice→text transition detected sessionId=${sessionId} voiceMessages=${voiceCount}`,
            );
          }
        }

        const sessionKey = session.sessionKey || `dashboard:${sessionId}`;
        chatRunLifecycle.setSessionKey(acceptedLease, sessionKey);

        // User messages are durable facts even when a newer send supersedes their
        // response generation. Persist first; generation ownership gates only
        // preparation and response work.
        if (!isGreeting) {
          if (!clientTurnId) {
            await chatStorage.createMessage(
              sessionId,
              "user",
              acceptedContent,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              msgPageContext,
            );
          }
          const principal = getPrincipal(req);
          if (principal?.actorType === "user" && principal.userId && principal.accountId) {
            // Best-effort FTUE side effect — completeFtueSayHello already fails
            // soft, but keep acceptance isolated from any future throw.
            try {
              await completeFtueSayHello(principal as typeof principal & { userId: string; accountId: string });
            } catch (ftueErr) {
              const error = ftueErr instanceof Error ? ftueErr : new Error(String(ftueErr));
              if (!(error as Error & { code?: string }).code) {
                (error as Error & { code?: string }).code = "FTUE_SAY_HELLO_FAILED";
              }
              chatLog.warn("FTUE say-hello side effect failed", error, {
                operation: "complete_ftue_say_hello",
                sessionId,
              });
            }
          }
          publishChatStreamEvent(sessionKey, sessionId, {
            type: "user_message",
            content: acceptedContent,
            sessionId,
            title: session.title || undefined,
          });
        }

        chatRunLifecycle.assertCurrent(acceptedLease);

        // Only the newest generation may update session-level page context. The
        // message itself already carries its send-time context for history.
        if (incomingPageContext) {
          const freshPageContext = normalizePageContext(incomingPageContext);
          if (freshPageContext) {
            await chatStorage.updatePageContext(sessionId, freshPageContext).catch((err) =>
              chatLog.warn(`pageContext refresh failed sessionId=${sessionId}`, err),
            );
            chatRunLifecycle.assertCurrent(acceptedLease);
          }
        }

        await chatStorage.updateSessionStatus(sessionId, "streaming").catch((err) =>
          chatLog.warn(`status update to streaming failed sessionId=${sessionId}`, err),
        );
        if (wasInFlight) {
          await chatStorage.setErrorSeverity(sessionId, null).catch((err) =>
            chatLog.warn(`clear error severity on supersession failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }

        const streamStartedAt = Date.now();
        res.status(wasInFlight ? 202 : 200).json({
          sessionKey,
          sessionId,
          status: "streaming",
          queued: wasInFlight,
          interrupted: abortCount,
          streamStartedAt,
          ...(acceptedDecisionId ? { decisionId: acceptedDecisionId } : {}),
        });

        processChatStream(
          sessionKey,
          sessionId,
          acceptedContent,
          undefined,
          undefined,
          undefined,
          session.type === "meeting" && session.meeting?.botStatus === "live",
          undefined,
          undefined,
          acceptedLease,
          undefined,
          undefined,
          clientId,
          clientTurnId,
        ).catch((err) => {
          if (err instanceof ChatRunInvalidatedError) {
            chatLog.log(`processChatStream ${err.reason} sessionId=${sessionId} generation=${err.generation}`);
            return;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          if (!(error as Error & { code?: string }).code) {
            (error as Error & { code?: string }).code = "CHAT_STREAM_PROCESS_FAILED";
          }
          (error as Error & { operation?: string }).operation = "process_chat_stream";
          chatLog.error("processChatStream error", error, {
            operation: "process_chat_stream",
            sessionId,
          });
        });
      } catch (error) {
        if (acceptedLease) chatRunLifecycle.finish(acceptedLease);
        if (error instanceof ChatRunInvalidatedError) {
          chatLog.log(`message acceptance ${error.reason} sessionId=${sessionId} generation=${error.generation}`);
          if (!res.headersSent) res.status(202).json({ queued: true, superseded: true });
          return;
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!(normalized as Error & { code?: string }).code) {
          (normalized as Error & { code?: string }).code = "CHAT_SEND_MESSAGE_FAILED";
        }
        (normalized as Error & { operation?: string }).operation = "send_message";
        chatLog.error("Error sending message", normalized, {
          operation: "send_message",
          sessionId,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to send message" });
        }
      }
    },
  );

  // Instantiate a reusable agenda DEFINITION as this session's structured
  // SESSION AGENDA. Sibling of the messages route above: it reuses the exact
  // same principal-scoped `chatStorage.getSession` ownership check, so a
  // session the caller does not own fails closed as not-found. The agenda is
  // written only through the one canonical `setSessionAgenda` path; the route
  // trusts only `agendaId` and never accepts caller-supplied agenda items.
  app.post(
    "/api/sessions/:id/agenda",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;
        const rawAgendaId = req.body?.agendaId;
        const agendaId = typeof rawAgendaId === "string" ? rawAgendaId.trim() : "";
        if (!agendaId) {
          return res.status(400).json({ error: "agendaId is required" });
        }

        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }

        // Server-authoritative: resolve the definition through the
        // principal-scoped definition store, then instantiate a fresh all-open
        // Session snapshot. Instantiation logic is not duplicated here.
        const def = await agendaDefinitionStorage.get(agendaId);
        if (!def) {
          return res.status(404).json({ error: "Agenda not found" });
        }
        const agenda = instantiateAgendaDefinition(def);

        // Canonical session-agenda write path — the only way agenda state is
        // mutated on a session.
        const updated = await chatStorage.setSessionAgenda(sessionId, agenda.items);
        if (!updated) {
          return res.status(404).json({ error: "Session not found" });
        }

        chatLog.info(
          `session agenda instantiated sessionId=${sessionId} itemCount=${agenda.items.length}`,
        );
        res.json(updated);
      } catch (error) {
        chatLog.error("Error instantiating session agenda:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to set session agenda" });
        }
      }
    },
  );

  // Clear the runtime SESSION AGENDA. Sibling of the POST route above and uses
  // the same principal-scoped `chatStorage.getSession` ownership check, so a
  // session the caller does not own fails closed as not-found. Clearing is
  // written only through the one canonical `clearSessionAgenda` path and is
  // idempotent: clearing an already-empty agenda succeeds unchanged.
  app.delete(
    "/api/sessions/:id/agenda",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;

        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }

        const updated = await chatStorage.clearSessionAgenda(sessionId);
        if (!updated) {
          return res.status(404).json({ error: "Session not found" });
        }

        chatLog.info(`session agenda cleared sessionId=${sessionId}`);
        res.json(updated);
      } catch (error) {
        chatLog.error("Error clearing session agenda:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to clear session agenda" });
        }
      }
    },
  );

  app.post(
    "/api/sessions/:id/question/cancel",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;
        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }
        // Explicit dismiss records a terminal cancellation marker without a
        // message or a run. Idempotent: a no-op when nothing is awaiting.
        const result = await chatStorage.recordQuestionCancellation(sessionId, "user_cancelled");
        if (result.outcome === "session_not_found") {
          return res.status(404).json({ error: "Session not found" });
        }
        res.json({
          ok: true,
          cancelled: result.outcome === "cancelled",
          questionToolCallId: result.outcome === "cancelled" ? result.questionToolCallId : null,
        });
      } catch (error) {
        chatLog.error("Error cancelling question:", error);
        res.status(500).json({ error: "Failed to cancel question" });
      }
    },
  );

  app.post(
    "/api/sessions/:id/voice-transcript",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;
        const { transcript } = req.body;

        if (!Array.isArray(transcript) || transcript.length === 0) {
          return res
            .status(400)
            .json({ error: "Transcript array is required" });
        }

        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }

        for (const entry of transcript) {
          const role = entry.source === "ai" ? "assistant" : "user";
          await chatStorage.createMessage(sessionId, role, entry.message || "");
        }

        res.json({ saved: transcript.length });
      } catch (error) {
        chatLog.error("Error saving voice transcript:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to save voice transcript" });
        }
      }
    },
  );

  // M0/M1 meeting spine — canonical meeting ingest.
  // Single mutation path for meeting transcript lines and bot status updates.
  // Shared by the dev loopback transport and the Recall.ai webhook receiver.
  const { createMeetingTurnCoordinator } = await import("../../meeting/turn-coordinator");
  const meetingTurnCoordinator = createMeetingTurnCoordinator(async (request) => {
    await processChatStream(
      request.sessionKey,
      request.sessionId,
      request.content,
      undefined,
      undefined,
      undefined,
      request.sayAloud,
      request.onResponse,
      request.runGeneration,
      undefined,
      request.currentMessageIds,
      request.onSettled,
      undefined,
      request.turn.id,
    );
  });

  async function ingestMeetingEvent(event: {
    sessionId?: string;
    create?: {
      title?: string;
      platform?: string;
      botId?: string;
      meetingUrl?: string;
    };
    speakerLabel?: string;
    speaker?: {
      key?: string;
      email?: string;
      isHost?: boolean;
      transportParticipantId?: string;
      providerSpeakerId?: string;
      source?: "participant_metadata" | "machine_diarization" | "manual";
    };
    turnId?: string;
    text?: string;
    participationMode?: "contextual" | "always";
    executionAffinityBootId?: string;
    botStatus?: MeetingBotStatus;
    statusDetail?: string;
    stt?: {
      provider: string;
      model: string;
      source: "recall_participant_audio" | "recall_transcript_webhook" | "native_microphone";
      fallback: boolean;
      recognition?: import("@shared/models/chat").MessageRecognitionMeta;
    };
  }): Promise<
    | {
        ok: true;
        sessionId: string;
        sessionKey: string;
        speaker?: MessageSpeakerMeta;
        queued: boolean;
      }
    | { ok: false; status: number; error: string }
  > {
    const existingSession = event.sessionId
      ? await (await import("../../meeting/owner-principal"))
          .resolveMeetingTransportSession(event.sessionId)
      : null;
    if (event.sessionId && !existingSession) {
      return { ok: false, status: 404, error: "Session not found" };
    }
    if (existingSession && existingSession.type !== "meeting") {
      return { ok: false, status: 400, error: "Session is not a meeting session" };
    }
    if (existingSession?.meeting) {
      const { runWithMeetingOwnerPrincipal } = await import(
        "../../meeting/owner-principal"
      );
      return runWithMeetingOwnerPrincipal(existingSession.meeting, () =>
        ingestMeetingEventUnderPrincipal(event, existingSession),
      );
    }

    return ingestMeetingEventUnderPrincipal(event, null);
  }

  async function ingestMeetingEventUnderPrincipal(
    event: Parameters<typeof ingestMeetingEvent>[0],
    existingSession: Awaited<ReturnType<typeof chatStorage.getSession>>,
  ): ReturnType<typeof ingestMeetingEvent> {
    const { resolveSpeaker } = await import("../../meeting/speakers");

    // Existing sessions arrive here only after their durable owner principal
    // has been restored. New loopback sessions inherit the authenticated request.
    let session = existingSession;
    if (!session) {
      const meetingTitle = event.create?.title?.trim() || "Meeting";
      session = await chatStorage.createMeetingSession(meetingTitle, {
        title: meetingTitle,
        platform: event.create?.platform,
        participants: [],
        botStatus: event.botStatus || "live",
        botId: event.create?.botId,
        meetingUrl: event.create?.meetingUrl,
      });
      chatLog.log(
        `meeting ingest: created session ${session.id} title="${meetingTitle}" platform=${event.create?.platform || "-"}`,
      );
    }
    const sessionId = session.id;
    const sessionKey = session.sessionKey || `meeting:${sessionId}`;
    const meeting = session.meeting || {
      participants: [],
      botStatus: "live" as const,
    };

    if (event.stt) {
      // Canonical-source discriminant: sttSource + sttStatus are written
      // atomically by the same paths (participant-audio stream transitions and
      // this ingest boundary), so the gate reads only that pair instead of
      // reconciling separately-written recognition stream state.
      const activeRecognitionStreams = meeting.recognition?.streams.filter(
        (stream) => stream.status === "active" && stream.attribution !== "excluded",
      ) || [];
      const canonicalAudioActive = activeRecognitionStreams.length > 0;
      const sourceAudioActive = event.speaker?.transportParticipantId
        ? activeRecognitionStreams.some(
            (stream) => stream.transportParticipantId === event.speaker?.transportParticipantId,
          )
        : canonicalAudioActive;
      // A delayed Recall transcript webhook must not duplicate the active
      // participant-audio source. Degraded sources retain this replay-safe
      // fallback even when another source in the same meeting is active.
      if (event.stt.fallback && sourceAudioActive) {
        chatLog.debug(
          `meeting ingest: ignored transcript fallback while canonical STT active sessionId=${sessionId} provider=${event.stt.provider}`,
        );
        return { ok: true, sessionId, sessionKey, queued: false };
      }
      if (!event.stt.fallback || !canonicalAudioActive) {
        await chatStorage.updateMeetingMeta(sessionId, {
          sttProvider: event.stt.provider,
          sttModel: event.stt.model,
          sttSource: event.stt.source,
          sttFallback: event.stt.fallback,
          sttStatus: event.stt.fallback ? "fallback" : "active",
          sttStatusDetail: event.stt.fallback
            ? "Recall transcript webhook fallback active"
            : "Canonical participant audio STT active",
        });
      }
      chatLog.info(
        `meeting STT sessionId=${sessionId} provider=${event.stt.provider} model=${event.stt.model} source=${event.stt.source} fallback=${event.stt.fallback}`,
      );
    }

    // A persisted departure claim owns lifecycle until Recall confirms a
    // terminal state. Delayed joining/live events must not resurrect the bot.
    if (
      meeting.botStatus === "leaving" &&
      event.botStatus &&
      !["ended", "failed", "denied"].includes(event.botStatus)
    ) {
      chatLog.debug(
        `meeting ingest: ignored lifecycle regression while leaving sessionId=${sessionId} status=${event.botStatus}`,
      );
      return { ok: true, sessionId, sessionKey, queued: false };
    }

    // M2: fire end-of-meeting finalization exactly once on the ended
    // transition. The recap claim in storage is atomic, so duplicate end
    // events (e.g. Recall bot.call_ended + bot.done) are no-ops.
    const endedNow =
      event.botStatus === "ended" && meeting.botStatus !== "ended";
    const kickFinalization = () => {
      if (!endedNow) return;
      import("../../meeting/recap")
        .then(({ finalizeMeetingSession }) => finalizeMeetingSession(sessionId))
        .catch((err) =>
          chatLog.error(
            `meeting ingest: finalization kickoff failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    };

    // Status-only update (no transcript text)
    if (!event.text) {
      const patch: Partial<MeetingSessionMeta> = {};
      if (event.botStatus && event.botStatus !== meeting.botStatus) {
        patch.botStatus = event.botStatus;
        if (
          event.botStatus === "ended" ||
          event.botStatus === "failed" ||
          event.botStatus === "denied"
        ) {
          patch.endedAt = new Date().toISOString();
        }
      }
      if (event.statusDetail) patch.statusDetail = event.statusDetail;
      if (Object.keys(patch).length > 0) {
        await chatStorage.updateMeetingMeta(sessionId, patch);
        if (patch.botStatus) syncMeetingVisualizerBotStatus(sessionId, patch.botStatus);
        chatLog.log(
          `meeting ingest: status update sessionId=${sessionId} botStatus=${event.botStatus || "-"} detail=${event.statusDetail || "-"}`,
        );
      }
      kickFinalization();
      return { ok: true, sessionId, sessionKey, queued: false };
    }

    // Output audio re-enters Recall as the bot participant's transcript. It is
    // already represented by the canonical assistant message, so ingesting it
    // again would create a duplicate user-side echo and can recursively address
    // the agent. Drop it at the producer boundary.
    if (event.speakerLabel?.trim().toLowerCase() === "mantra agent") {
      chatLog.debug(`meeting ingest: ignored bot echo sessionId=${sessionId}`);
      return { ok: true, sessionId, sessionKey, queued: false };
    }

    // Barge-in: a human speaking preempts any in-flight agent speech at once,
    // mirroring the direct voice path's auto-cancel contract. The bot echo is
    // already dropped above, so any remaining text here is a real participant.
    // interruptMeetingSpeech is a cheap no-op when the agent is not speaking.
    if (interruptMeetingSpeech(sessionId, "meeting_participant_speech")) {
      chatLog.debug(
        `meeting barge-in: interrupted agent speech sessionId=${sessionId} speaker=${event.speakerLabel || "unknown"}`,
      );
    }

    // Speaker attribution against the session's participant roster
    const resolution = await resolveSpeaker(
      sessionId,
      {
        speakerKey: event.speaker?.key,
        label: event.speakerLabel,
        email: event.speaker?.email,
        isHost: event.speaker?.isHost,
        transportParticipantId: event.speaker?.transportParticipantId,
        providerSpeakerId: event.speaker?.providerSpeakerId,
        source: event.speaker?.source,
      },
    );
    if (event.botStatus && event.botStatus !== meeting.botStatus) {
      const updated = await chatStorage.updateMeetingMeta(sessionId, {
        botStatus: event.botStatus,
        ...(event.botStatus === "ended" ? { endedAt: new Date().toISOString() } : {}),
      });
      syncMeetingVisualizerBotStatus(sessionId, event.botStatus);
      if (updated) session = updated;
    }
    kickFinalization();

    const sourceTurnId = event.turnId || `${sessionId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const speakerKey = resolution.speaker.key
      || resolution.speaker.personId
      || resolution.speaker.label.toLowerCase();
    const transcriptAcceptance = await chatStorage.createMeetingUserMessage(
      sessionId,
      event.text,
      resolution.speaker,
      sourceTurnId,
      {
        sessionKey,
        speakerKey,
        speakerLabel: resolution.speaker.label,
        participationMode: event.participationMode,
        executionAffinityBootId: event.executionAffinityBootId,
      },
      event.stt?.recognition,
    );
    if (transcriptAcceptance.outcome === "session_not_found") {
      return { ok: false, status: 404, error: "Meeting session disappeared during transcript persistence" };
    }
    // Transcript acceptance and the pending enrollment receipt committed in one
    // transaction. Immediate processing minimizes latency; the coordinator can
    // replay the receipt after any process or database interruption.
    if (transcriptAcceptance.outcome === "created") {
      publishChatStreamEvent(sessionKey, sessionId, {
        type: "user_message",
        content: event.text,
        sessionId,
        title: session.title || undefined,
      });
    }

    const { processMeetingTurnEnrollment } = await import("../../meeting/turn-enrollment");
    const enrollment = await processMeetingTurnEnrollment(sessionId, sourceTurnId, event.text);
    if (enrollment.outcome === "enrolled") {
      const assembled = enrollment.turn;
      chatLog.debug(
        `meeting turn buffered sessionId=${sessionId} turnId=${assembled.id} revision=${assembled.revision} fragments=${assembled.sourceTurnIds.length} readyAt=${assembled.readyAt.toISOString()}`,
      );
    }
    meetingTurnCoordinator.schedule(enrollment.outcome === "enrolled" ? undefined : 25);

    return {
      ok: enrollment.outcome !== "failed",
      ...(enrollment.outcome === "failed"
        ? { status: 503, error: "Meeting transcript persisted but turn enrollment failed" }
        : {}),
      sessionId,
      sessionKey,
      speaker: resolution.speaker,
      queued: enrollment.outcome !== "failed",
    };
  }

  // Phone audio is provider-owned by ElevenLabs; Mantra retains the durable
  // Session, custom LLM, context, tools, ownership, and callback boundaries.
  const { registerPhoneRoutes } = await import("../../phone/routes");
  registerPhoneRoutes(app);

  // Recall.ai webhook receiver — registered with the canonical ingest path.
  const { registerRecallRoutes } = await import("../../routes/recall");
  registerRecallRoutes(app, { ingestMeetingEvent });
  const { registerMeetingSTTAudioTransport } = await import("../../meeting/stt");
  app.locals.recallMeetingAudioUpgrade = registerMeetingSTTAudioTransport({ ingestMeetingEvent });
  const { registerNativeMeetingAudioTransport } = await import("../../meeting/native-audio");
  app.locals.nativeMeetingAudioUpgrade = registerNativeMeetingAudioTransport({ ingestMeetingEvent });

  // M0 dev loopback transport — POST attributed transcript text into a
  // meeting session through the canonical ingest path.
  app.post("/api/dev/meeting/loopback", async (req: Request, res: Response) => {
    try {
      const {
        sessionId: incomingSessionId,
        title,
        platform,
        speaker: speakerLabel,
        text,
        botStatus,
      } = req.body || {};

      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "text is required" });
      }

      const result = await ingestMeetingEvent({
        sessionId:
          typeof incomingSessionId === "string" ? incomingSessionId : undefined,
        create: {
          title: typeof title === "string" ? title : undefined,
          platform: typeof platform === "string" ? platform : undefined,
        },
        speakerLabel:
          typeof speakerLabel === "string" ? speakerLabel : undefined,
        text,
        botStatus: typeof botStatus === "string" ? (botStatus as MeetingBotStatus) : undefined,
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      if (result.queued) {
        return res.status(202).json({
          sessionId: result.sessionId,
          sessionKey: result.sessionKey,
          speaker: result.speaker,
          queued: true,
        });
      }
      res.json({
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        speaker: result.speaker,
        status: "streaming",
        streamStartedAt: Date.now(),
      });
    } catch (error) {
      chatLog.error("Error in meeting loopback:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to process meeting loopback" });
      }
    }
  });


  app.post("/api/sessions/:id/abort", async (req: Request, res: Response) => {
    const routeStartAt = Date.now();
    const sessionId = req.params.id as string;
    abortTrace("route_enter", { sessionId, routeStartAt });
    try {
      const cancelledLease = chatRunLifecycle.cancel(sessionId);
      const count = agentExecutor.abortByChatSessionId(sessionId, "cancelled");
      const aborted = count > 0 || cancelledLease !== undefined;
      abortTrace("runs_signalled", { sessionId, count, routeStartAt });

      // Respond before any DB write; awaiting persistence here wedged the
      // route for 1669ms in the 2026-04-28 incident. See stop-wedge-rca.md.
      res.status(202).json({ aborted, count });
      abortTrace("route_exit", { sessionId, count, aborted, routeStartAt });

      if (aborted) {
        setImmediate(() => {
          void import("../../session-manager")
            .then(({ sessionManager }) => sessionManager.finalizeSession(sessionId))
            .catch((err) => chatLog.warn(`abort finalization failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`));
          deferStatusSaved(sessionId, routeStartAt);
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      abortTrace("route_error", { sessionId, error: msg, routeStartAt }, "error");
      chatLog.error("Error aborting session:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to abort session" });
      }
    }
  });

  app.get("/api/sessions/:id/journal", async (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    try {
      const { readJournalFile } = await import("../../chat-journal");
      const allEntries = await readJournalFile(sessionId);
      // Filter to current run only: find the last run_start and return everything after it.
      let startIdx = 0;
      for (let i = allEntries.length - 1; i >= 0; i--) {
        if (allEntries[i].type === "run_start") {
          startIdx = i;
          break;
        }
      }
      const entries = allEntries.slice(startIdx).sort((a, b) => a.ts - b.ts);
      res.json({ sessionId, entries });
    } catch {
      // No journal file or read error — return empty (not an error).
      res.json({ sessionId, entries: [] });
    }
  });

  app.get(
    "/api/sessions/:id/stream-state",
    async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      let entries = getActiveRunJournal(sessionId);
      let source = "memory";

      const hasExecutorRun = agentExecutor.hasActiveRunForSession(sessionId);
      const isInFlight = chatRunLifecycle.current(sessionId) !== undefined;

      if (entries.length === 0 && (hasExecutorRun || isInFlight)) {
        try {
          const { readJournalFile } = await import("../../chat-journal");
          const fileEntries = await readJournalFile(sessionId);
          if (fileEntries.length > 0) {
            entries = fileEntries.sort((a, b) => a.ts - b.ts);
            source = "persisted";
            chatLog.log(
              `stream-state fallback to file-based journal sessionId=${sessionId} entryCount=${entries.length}`,
            );
          }
        } catch (err) {
          chatLog.warn(
            `stream-state file-based fallback failed sessionId=${sessionId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Find the most recent run_start in the journal so we only consider terminals belonging to the current run.
      let lastRunStartIdx = -1;
      let lastRunStartRunId: string | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "run_start") {
          lastRunStartIdx = i;
          lastRunStartRunId = entries[i].runId;
          break;
        }
      }

      // Authoritative current-run status from in-memory run state (covers race where journal hasn't flushed terminal yet).
      const { getSessionRunStatus } = await import("../../chat-journal");
      const runStatus = getSessionRunStatus(sessionId);
      const currentRunId = runStatus.currentRunId ?? lastRunStartRunId ?? null;

      // Find the last terminal event scoped to the current run only.
      let lastTerminalEvent: {
        type: "done" | "error" | "saved";
        ts: number;
        runId?: string;
        messageId?: string;
        error?: string;
      } | null = null;
      for (let i = entries.length - 1; i >= Math.max(0, lastRunStartIdx); i--) {
        const e = entries[i];
        if (e.type === "done" || e.type === "error" || e.type === "saved") {
          // If we know a current runId, require runId match (ignore prior-run terminals).
          if (currentRunId && e.runId && e.runId !== currentRunId) continue;
          lastTerminalEvent = {
            type: e.type,
            ts: e.ts,
            runId: e.runId,
            messageId: e.messageId,
            error: e.error,
          };
          break;
        }
      }

      // Prefer in-memory run state's terminal entry if journal hasn't yet captured it.
      if (
        !lastTerminalEvent &&
        runStatus.lastTerminalEvent &&
        (!currentRunId ||
          !runStatus.lastTerminalEvent.runId ||
          runStatus.lastTerminalEvent.runId === currentRunId)
      ) {
        lastTerminalEvent = {
          type:
            runStatus.lastTerminalEvent.type === "aborted"
              ? "error"
              : runStatus.lastTerminalEvent.type,
          ts: runStatus.lastTerminalEvent.ts,
          runId: runStatus.lastTerminalEvent.runId ?? undefined,
          messageId: runStatus.lastTerminalEvent.messageId,
          error: runStatus.lastTerminalEvent.error,
        };
      }

      const currentRunTerminated =
        lastTerminalEvent !== null ||
        (runStatus.terminalEmitted &&
          (!currentRunId || runStatus.currentRunId === currentRunId));
      // Authoritative isActive: executor/in-flight says active AND current run has not terminated.
      const isActive = (hasExecutorRun || isInFlight) && !currentRunTerminated;

      chatLog.log(
        `stream-state sessionId=${sessionId} isActive=${isActive} hasExecutorRun=${hasExecutorRun} isInFlight=${isInFlight} currentRunId=${currentRunId || "none"} lastTerminal=${lastTerminalEvent?.type || "none"} source=${source} entryCount=${entries.length}`,
      );
      const mapped = entries.map((e) => ({
        type: e.type,
        ts: e.ts,
        content: e.content,
        toolName: e.toolName,
        toolCallId: e.toolCallId,
        arguments: e.arguments,
        result: e.result,
        error: e.error,
        runId: e.runId,
        messageId: e.messageId,
        model: e.model,
        autoTier: e.autoTier,
        sessionKey: e.sessionKey,
        sessionId: e.sessionId,
        step: e.step,
        status: e.status,
        elapsedMs: e.elapsedMs,
        detail: e.detail,
        stepId: e.stepId,
        seq: e.seq,
      }));
      res.json({
        sessionId,
        isActive,
        source,
        currentRunId,
        entries: mapped,
        lastTerminalEvent,
      });
    },
  );

  app.post(
    "/api/sessions/:id/voice-message",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;
        const { role, content } = req.body;

        if (!content || typeof content !== "string") {
          return res.status(400).json({ error: "Message content is required" });
        }
        if (role !== "user" && role !== "assistant") {
          return res
            .status(400)
            .json({ error: "Role must be 'user' or 'assistant'" });
        }

        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }

        const msg = await chatStorage.createMessage(
          sessionId,
          role,
          content,
          undefined,
          undefined,
          role === "assistant" ? "elevenlabs-voice" : undefined,
        );

        const voiceSessionKey = session.sessionKey || `voice:${sessionId}`;

        if (role === "user") {
          publishChatStreamEvent(voiceSessionKey, sessionId, {
            type: "user_message",
            content,
            sessionId,
            title: session.title || undefined,
            voice: true,
          });
        } else {
          publishChatStreamEvent(voiceSessionKey, sessionId, {
            type: "voice_xyz_response",
            content,
            sessionId,
            voice: true,
          });
        }

        res.json({ id: msg!.id });
      } catch (error) {
        chatLog.error("Error saving voice message:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to save voice message" });
        }
      }
    },
  );

  app.post(
    "/api/sessions/:id/voice-tool-call",
    async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.id as string;
        const { toolName, arguments: toolArgs, result, status } = req.body;

        if (!toolName) {
          return res.status(400).json({ error: "toolName is required" });
        }

        const session = await chatStorage.getSession(sessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }

        const toolCallId = generateToolCallId("voice-tc");
        const toolCalls = [
          {
            toolName,
            status: status || "done",
            toolCallId,
            arguments: toolArgs || {},
            result: result || "",
          },
        ];

        const msg = await chatStorage.createMessage(
          sessionId,
          "assistant",
          result || `Used ${toolName}`,
          undefined,
          toolCalls,
          "elevenlabs-voice",
        );

        if (toolName === "add_insight") {
          const voiceSessionKey = session.sessionKey || `voice:${sessionId}`;
          publishChatStreamEvent(voiceSessionKey, sessionId, {
            type: "voice_insight",
            content: result || toolArgs?.insight || "",
            sessionId,
            toolName,
            voice: true,
          });
        }

        res.json({ id: msg!.id });
      } catch (error) {
        chatLog.error("Error saving voice tool call:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to save voice tool call" });
        }
      }
    },
  );

  app.post(
    "/api/sessions/:id/voice-finalize",
    async (req: Request, res: Response<VoiceFinalizationResponse>) => {
      const chatSessionId = req.params.id as string;
      const parsed = parseVoiceFinalizationRequest(req.body);
      if (!parsed.ok) {
        return res.status(400).json({ outcome: "not_finalized", reason: "invalid_request" });
      }

      try {
        const session = await chatStorage.getSession(chatSessionId);
        if (!session) {
          return res.status(404).json({ outcome: "not_finalized", reason: "not_completable" });
        }

        const { finalizeVoiceSession } = await import("../../voice/finalize");
        const finalization = await finalizeVoiceSession({
          chatSessionId,
          voiceSessionId: parsed.value.sessionId,
          principal: req.principal!,
          title: session.title || "Voice Chat",
        });
        if (finalization.outcome === "not_finalized") {
          return res.status(409).json(finalization);
        }

        const { chatFileStorage } = await import("../../chat-file-storage");
        try {
          const annotations = await chatFileStorage.applyVoiceFinalizationAnnotations(
            chatSessionId,
            parsed.value.sessionId,
            {
              errorMessage: parsed.value.errorMessage,
              systemSteps: parsed.value.systemSteps,
            },
          );
          if (annotations.outcome === "session_not_found") {
            chatLog.warn(
              `VoiceFinalize durable chat disappeared after lease completion chatSessionId=${chatSessionId}`,
            );
            return res.status(500).json({ outcome: "unknown", reason: "internal_error" });
          }

          chatLog.log(
            `VoiceFinalize completed chatSessionId=${chatSessionId} voiceSessionId=${parsed.value.sessionId} replayed=${finalization.replayed} annotations=${annotations.outcome}`,
          );
          return res.status(200).json(finalization);
        } catch (annotationError) {
          chatLog.error("VoiceFinalize annotations failed after terminal session commit:", annotationError);
          return res.status(500).json({ outcome: "unknown", reason: "internal_error" });
        }
      } catch (error) {
        chatLog.error("VoiceFinalize error:", error);
        if (!res.headersSent) {
          return res.status(500).json({ outcome: "unknown", reason: "internal_error" });
        }
      }
    },
  );

  const diagLog = createLogger("ChatDiagnostic");
  app.post("/api/chat/diagnostic", (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (body && typeof body === "object" && body.event) {
        diagLog.log(`event=${body.event}`, body);
      }
    } catch (err) {
      diagLog.warn("parse error:", err);
    }
    res.status(204).end();
  });
}
