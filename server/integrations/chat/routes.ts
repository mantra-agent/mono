// Use createLogger for logging ONLY
import type { Express, Request, Response, RequestHandler } from "express";
import * as fsPromises from "fs/promises";
import { chatStorage } from "./storage";
import { storage } from "../../storage";
import type { SegmentChronologyEntry } from "../../chat-file-storage";
import type { SessionStreamEvent } from "../../session-manager";
import { WORKSPACE_DIR } from "../../paths";
import { ACTIVITY_CHAT } from "../../job-profiles";
import { resolveModelCandidates, type ModelRoutingDecision } from "../../model-routing";
import { normalizeSessionModelTierOverride } from "../../session-model-tier-override";
import { agentExecutor } from "../../agent-executor";
import { assembleContext } from "../../agent-context";
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
import { pipeline } from "node:stream/promises";
import {
  storageBackend,
} from "../../object_storage/s3-backend";
import { setObjectAclPolicy } from "../../object_storage/objectAcl";
import { vaultObjectKeyFromPrincipal } from "../../object_storage/vault-keys";
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
import { SESSION_REMINDER_PREFIX } from "../../routes/session-reminder";
import { getPrincipal } from "../../principal";
import { completeFtueSayHello } from "../../ftue-goals";
import type { Timer } from "@shared/models/timers";

import {
  normalizePageContext,
  type SystemNotice,
  type ErrorSeverity,
  type MeetingBotStatus,
  type MeetingSessionMeta,
  type MessageSpeakerMeta,
  type QuestionResponseMeta,
} from "@shared/models/chat";
import { BOOT_ID, db } from "../../db";
import { and, eq, inArray, isNull, notInArray, sql as drizzleSql, type SQL } from "drizzle-orm";
import { combineWithVisibleScope } from "../../scoped-storage";
import { libraryPages } from "@shared/models/info";
import { planExecutions } from "@shared/schema";
import { createLogger } from "../../log";
import { requireAuth } from "../../auth";
import { getCurrentPrincipalOrSystem } from "../../principal-context";
import { resolveQuestionResponse } from "../../question-response";

const chatLog = createLogger("ChatStream");
const planScopeColumns = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
function visiblePlan(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }

function isLiveSessionStatus(session: { status?: string }): boolean {
  return session.status === "streaming";
}

type SessionReminderState = { active: true; timerId: string; fireAt: string | null; nextBoot: boolean; nextBuild: boolean };

function getSessionReminderState(timer: Timer): SessionReminderState | null {
  if (timer.type !== "reminder" || !timer.enabled) return null;
  if (!timer.description?.startsWith(SESSION_REMINDER_PREFIX)) return null;
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
    const sessionId = timer.description.slice(SESSION_REMINDER_PREFIX.length);
    if (sessionId) reminders.set(sessionId, state);
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

async function getPlanSessionIdsForSessions(sessionIds: string[]): Promise<Set<string>> {
  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  const planSessionIds = new Set<string>();
  if (uniqueSessionIds.length === 0) return planSessionIds;

  for (let i = 0; i < uniqueSessionIds.length; i += PLAN_SESSION_QUERY_CHUNK_SIZE) {
    const chunk = uniqueSessionIds.slice(i, i + PLAN_SESSION_QUERY_CHUNK_SIZE);
    const pages = await db
      .select({ sessionId: libraryPages.createdBySessionId })
      .from(libraryPages)
      .where(
        and(
          inArray(libraryPages.createdBySessionId, chunk),
          drizzleSql`${libraryPages.tags} @> ARRAY['plan']::text[]`,
        ),
      );

    for (const page of pages) {
      if (page.sessionId) planSessionIds.add(page.sessionId);
    }
  }

  return planSessionIds;
}

/**
 * Sessions with a plan currently executing. A session with an in-flight plan
 * must render as active even in the gap between plan steps, when no child
 * session is streaming yet.
 */
async function getExecutingPlanSessionIdsForSessions(sessionIds: string[]): Promise<Set<string>> {
  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  const executingSessionIds = new Set<string>();
  if (uniqueSessionIds.length === 0) return executingSessionIds;

  for (let i = 0; i < uniqueSessionIds.length; i += PLAN_SESSION_QUERY_CHUNK_SIZE) {
    const chunk = uniqueSessionIds.slice(i, i + PLAN_SESSION_QUERY_CHUNK_SIZE);
    const rows = await db
      .select({ sessionId: planExecutions.originSessionId })
      .from(planExecutions)
      .where(
        and(
          inArray(planExecutions.originSessionId, chunk),
          eq(planExecutions.status, "executing"),
          isNull(planExecutions.archivedAt),
        ),
      );

    for (const row of rows) {
      if (row.sessionId) executingSessionIds.add(row.sessionId);
    }
  }

  return executingSessionIds;
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
    case "idle_timeout":
      return `Timeout: executor stream idle-timeout watchdog stopped the run after no stream/tool activity (${duration}). This was not user-cancelled.`;
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

  if (result.abortReason) {
    switch (result.abortReason) {
      case "idle_timeout":
        errorType = "response_interrupted";
        description = `Idle-timeout watchdog stopped the run after no executor stream/tool activity${durationMs != null ? ` for ${(durationMs / 60000).toFixed(1)} minutes` : ""}. This was not user-cancelled.`;
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
    nextMeetingAudio,
    outputMediaSession,
    registerMeetingVisualizerTransport,
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
    const audio = await nextMeetingAudio(sessionId);
    if (!audio) return res.status(204).end();

    res.status(200);
    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "none");
    try {
      await pipeline(audio.stream, res);
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
  app.get("/api/sessions", async (req: Request, res: Response) => {
    try {
      const [all, reminderMap] = await Promise.all([
        chatStorage.getAllSessions(),
        getSessionReminderMap(),
      ]);
      // /api/sessions is the canonical session index. It must return every
      // persisted chat session regardless of lifecycle status; clients can
      // choose how to render saved, streaming, idle, failed, or future states.
      const visible = all;
      const allIds = new Set(all.map((s) => s.id));
      const visibleIds = allIds;
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
      const [planSessionIds, executingPlanSessionIds] = await Promise.all([
        getPlanSessionIdsForSessions(filteredIds),
        getExecutingPlanSessionIdsForSessions(filteredIds),
      ]);

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

      const sessions = filtered.map((s) => ({
        ...s,
        status: s.status === "streaming" && !isLiveSessionStatus(s) ? "saved" : s.status,
        directChildCount: childCounts.get(s.id) || 0,
        parentMissing: !!s.parentSessionId && !allIds.has(s.parentSessionId),
        hasPlan: planSessionIds.has(s.id),
        hasActivePlan: executingPlanSessionIds.has(s.id),
        hasActiveDescendant: activeDescendantIds.has(s.id),
        reminder: reminderMap.get(s.id) || { active: false },
      }));
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
      const session = await chatStorage.getSession(id);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      const TERMINAL_PLAN_STATUSES = ["completed", "completed_with_failures", "failed", "aborted"];
      const [messages, activePlan] = await Promise.all([
        chatStorage.getMessagesBySession(id),
        db.select({
          id: planExecutions.id,
          pageId: planExecutions.pageId,
          status: planExecutions.status,
        })
        .from(planExecutions)
        .where(visiblePlan(and(
          eq(planExecutions.originSessionId, id),
          notInArray(planExecutions.status, TERMINAL_PLAN_STATUSES),
        )))
        .orderBy(planExecutions.createdAt)
        .limit(1)
        .then(r => r[0] || null),
      ]);
      res.json({ ...session, messages, activePlan });
    } catch (error) {
      chatLog.error("Error fetching session:", error);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

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
      await chatStorage.setHasUnreadResult(id, false);
      await chatStorage.setErrorSeverity(id, null);
      res.json({ ok: true });
    } catch (error) {
      chatLog.error("Error marking session as read:", error);
      res.status(500).json({ error: "Failed to mark session as read" });
    }
  });

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

            // Upload to R2 for persistence across deploys
            let objectPath: string | undefined;
            try {
              const objectId = randomUUID();
              const suffix = ext || "";
              const principal = getPrincipal(req);
              const key = vaultObjectKeyFromPrincipal(principal, "uploads", `${objectId}${suffix}`);
              const fileBuffer = fs.readFileSync(f.path);
              await storageBackend.putObject(key, fileBuffer, {
                contentType: f.mimetype || "application/octet-stream",
              });
              await setObjectAclPolicy(key, {
                owner: req.session.userId || "system",
                visibility: "public",
                vaultId: principal?.activeVaultId ?? undefined,
              });
              objectPath = `/objects/uploads/${objectId}${suffix}`;
              chatLog.log(
                `[Upload] R2 OK: name="${f.originalname}" key=${key} objectPath=${objectPath}`,
              );
            } catch (err) {
              chatLog.error(
                `[Upload] R2 upload failed for ${f.originalname}, falling back to local path:`,
                err,
              );
            }

            // Clean up local temp file (R2 has the durable copy now)
            try {
              await fsPromises.unlink(f.path);
            } catch {}

            return {
              name: f.originalname,
              path: objectPath || `uploads/${f.filename}`,
              size: f.size,
              isText,
              content,
            };
          }),
        );

        res.json({ files: uploaded });
      } catch (error) {
        chatLog.error("File upload error:", error);
        res.status(500).json({ error: "Upload failed" });
      }
    },
  );

  function estimateExecutorMessageTokens(msg: ExecutorMessage): number {
    if (typeof msg.content === "string")
      return Math.ceil(msg.content.length / 3.5);
    if (Array.isArray(msg.content)) {
      return msg.content.reduce((sum, block) => {
        const text =
          block.text ||
          block.thinking ||
          block.content ||
          JSON.stringify(block.input || {});
        return sum + Math.ceil((text?.length || 0) / 3.5);
      }, 0);
    }
    return 0;
  }

  function estimateExecutorMessagesTokens(messages: ExecutorMessage[]): number {
    return messages.reduce(
      (sum, msg) => sum + estimateExecutorMessageTokens(msg),
      0,
    );
  }

  function compactHistoricalToolResultForExecutor(value: unknown): string {
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

    if (content.length <= 500) return content;
    const lines = content.split("\n").length;
    return `[Compacted historical tool result: ${lines} lines, ${content.length.toLocaleString()} chars] ${content.slice(0, 200)}...`;
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

  async function buildChatHistory(
    sessionId: string,
    enrichedContent: string,
    resolvedModel?: string,
    onProgress?: (
      step: string,
      status: "started" | "done",
      elapsedMs?: number,
    ) => void,
    currentMessageIds?: string[],
  ): Promise<{
    messages: ExecutorMessage[];
    conversationHistory: ConversationHistoryMessage[];
    enrichedContent: string;
    toolDefs: ToolDefinition[];
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
        (m) => !(m.role === "assistant" && m.assistantState === "streaming"),
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

    let durableCompactionAttempted = false;
    let durableCompactionApplied = false;
    let preRunConversationTokens = 0;
    let preRunCompactionThreshold = 0;

    try {
      const endTokens = beginSubStep("ctx_history_tokens");
      const { runBetweenTurnCompaction, estimateTokens } =
        await import("../../agent-context");
      const { getContextWindow } = await import("../../model-registry");
      const bareModel = (resolvedModel || "").includes("/")
        ? (resolvedModel || "").split("/").slice(1).join("/")
        : resolvedModel || "";
      const contextWindow = getContextWindow(bareModel);
      const convBudget = Math.floor(contextWindow * 0.5);
      const estimateConversationTokens = () =>
        conversationHistory.reduce((sum, m: any) => {
          let tokens =
            sum +
            estimateTokens(m.content || "") +
            (m.thinking ? estimateTokens(m.thinking) : 0);
          if (Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
              if (typeof tc.result === "string")
                tokens += estimateTokens(tc.result);
              else if (tc.result != null)
                tokens += estimateTokens(JSON.stringify(tc.result));
            }
          }
          return tokens;
        }, 0);

      preRunConversationTokens = estimateConversationTokens();
      preRunCompactionThreshold = Math.floor(convBudget * 0.6);
      durableCompactionAttempted =
        preRunConversationTokens > preRunCompactionThreshold;
      endTokens();

      if (durableCompactionAttempted) {
        const endRepair = beginSubStep("ctx_history_repair");
        const repair = await chatStorage.repairOversizedContextPayloads(
          sessionId,
          { maxInlineTokens: 200, reason: "pre_run_context_pressure" },
        );
        if (repair.repaired) {
          chatLog.warn(
            `durableContextRepair applied sessionId=${sessionId} payloads=${repair.payloadsRepaired} tokens=${repair.tokensBefore}->${repair.tokensAfter}`,
          );
          existingMessages = await chatStorage.getMessagesBySession(sessionId);
          rebuildConversationHistory(existingMessages);
          preRunConversationTokens = estimateConversationTokens();
          durableCompactionAttempted =
            preRunConversationTokens > preRunCompactionThreshold;
        }
        endRepair();
      }

      const endCompaction = durableCompactionAttempted
        ? beginSubStep("ctx_history_compact")
        : undefined;
      const compacted = durableCompactionAttempted
        ? await runBetweenTurnCompaction(
            sessionId,
            conversationHistory,
            convBudget,
          )
        : false;
      durableCompactionApplied = compacted;
      if (compacted) {
        chatLog.log(
          `betweenTurnCompaction ran, reloading messages sessionId=${sessionId}`,
        );
        existingMessages = await chatStorage.getMessagesBySession(sessionId);
        rebuildConversationHistory(existingMessages);
        chatLog.log(
          `betweenTurnCompaction reloaded ${conversationHistory.length} messages sessionId=${sessionId}`,
        );
      }
      endCompaction?.();
    } catch (compactErr: unknown) {
      // Close any sub-step left open by the failure so the diagnostic timeline stays coherent.
      openSubStep?.();
      chatLog.warn(
        `betweenTurnCompaction failed (non-fatal) sessionId=${sessionId}: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
      );
    }

    onProgress?.("ctx_history", "done", Date.now() - histStart);

    const { filterToolSchemasForAuthority } = await import("../../agent-authority");
    const allToolDefs = filterToolSchemasForAuthority(getToolDefinitions(), { origin: "interactive", sessionId });
    const toolDefs: ToolDefinition[] = allToolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    chatLog.log(
      `tools loaded count=${allToolDefs.length} sessionId=${sessionId}`,
    );

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
      toolDefinitions: allToolDefs.map((t) => ({
        name: t.name,
        description: t.description,
      })),
      model: resolvedModel,
      sessionId,
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
            compactHistoricalToolResultForExecutor(rawResultContent);
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
    const contextLimit = Math.floor(contextWindow * 0.9);
    const executorStage1Threshold = Math.floor(contextLimit * 0.65);
    const fullPreExecutorTokens = estimateExecutorMessagesTokens(messages);
    const toolResultCount = messages.reduce((sum, msg) => {
      if (!Array.isArray(msg.content)) return sum;
      return (
        sum + msg.content.filter((block) => block.type === "tool_result").length
      );
    }, 0);

    if (fullPreExecutorTokens > executorStage1Threshold) {
      durableCompactionAttempted = true;
      chatLog.warn(
        `fullPreExecutorContextPressure sessionId=${sessionId} tokens=${fullPreExecutorTokens} threshold=${executorStage1Threshold}; repairing persisted tool payloads before executor`,
      );
      const repair = await chatStorage.repairOversizedContextPayloads(
        sessionId,
        { maxInlineTokens: 200, reason: "full_pre_executor_context_pressure" },
      );
      if (repair.repaired) {
        chatLog.warn(
          `fullPreExecutorContextRepair applied sessionId=${sessionId} payloads=${repair.payloadsRepaired} tokens=${repair.tokensBefore}->${repair.tokensAfter}`,
        );
        return buildChatHistory(
          sessionId,
          enrichedContent,
          resolvedModel,
          onProgress,
          currentMessageIds,
        );
      }
    }

    chatLog.log(
      `historyRebuilt messageCount=${messages.length} preExecutorTokens=${fullPreExecutorTokens} threshold=${executorStage1Threshold} toolResults=${toolResultCount} sessionId=${sessionId}`,
    );
    return {
      messages,
      conversationHistory,
      enrichedContent,
      toolDefs,
      contextPressure: {
        preRunTokens: fullPreExecutorTokens,
        threshold: executorStage1Threshold,
        durableCompactionAttempted,
        durableCompactionApplied,
        contextTokens: fullPreExecutorTokens,
        messageCount: messages.length,
        toolCount: toolResultCount,
        contextWindow,
        contextLimit,
      },
    };
  }

  async function executeChatAgent(
    sessionKey: string,
    sessionId: string,
    messages: ExecutorMessage[],
    toolDefs: ToolDefinition[],
    routingDecision: ModelRoutingDecision,
    contextPressure?: {
      preRunTokens: number;
      threshold: number;
      durableCompactionAttempted: boolean;
      durableCompactionApplied: boolean;
    },
    onEvent?: Parameters<typeof agentExecutor.run>[0]["onEvent"],
    routingTier?: string,
    diagnosticTurnId?: string,
    refreshAfterPersonaSwitch?: Parameters<typeof agentExecutor.run>[0]["refreshAfterPersonaSwitch"],
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
        sideEffectOnly: toolResult.sideEffectOnly,
        continuation: personaChanged ? "persona_switch" as const : toolResult.continuation,
      };
    };

    return agentExecutor.run({
      sessionKey,
      sessionId,
      messages,
      tools: toolDefs,
      toolExecutor,
      activity: ACTIVITY_CHAT,
      routingDecision,
      routingTier,
      contextPressure,
      onEvent,
      diagnosticTurnId,
      refreshAfterPersonaSwitch,
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
  ) {
    const lease = acceptedLease ?? chatRunLifecycle.begin(sessionId, sessionKey);
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
        runGeneration = sessionManager.registerSession(sessionId, sessionKey, "text");
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
    let assistantDraftContent = "";
    let assistantDraftThinking = "";
    let assistantDraftCheckpointPending: NodeJS.Timeout | null = null;
    let settlement: { status: "completed" | "failed"; assistantMessageId?: string; error?: string } | null = null;

    const diagnosticRunId = `pre-run-${lease.generation}-${randomUUID().slice(0, 8)}`;
    const diagnosticTurnId = `system-turn-${diagnosticRunId}`;
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
    };

    try {
      chatRunLifecycle.assertCurrent(lease);

      // The diagnostic turn is the root of every stage, including bootstrap
      // orientation. DO NOT emit live during pre-executor phase; emit atomically
      // after context assembly completes. This ensures the entire tree arrives
      // in one event, so parent-child relationships are always resolvable.
      // publishChatStreamEvent(sessionKey, sessionId, { type: "run_start", runId: diagnosticRunId });
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
              ? `fallback · ${orientation.personaName || "Default"}${orientation.fallbackReason ? ` · ${orientation.fallbackReason}` : ""}`
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
        runId: diagnosticRunId,
      });
      journal("model_info", {
        model: chatModel,
        autoTier: selectedAutoTier || undefined,
        persona: assistantDraft?.persona,
      });
      chatRunLifecycle.assertCurrent(lease);
      let assistantDraftLastCheckpoint = 0;

      const checkpointAssistantDraft = (force = false) => {
        if (!assistantDraft) return;
        const now = Date.now();
        if (!force && now - assistantDraftLastCheckpoint < 1000) {
          if (!assistantDraftCheckpointPending) {
            assistantDraftCheckpointPending = setTimeout(() => {
              assistantDraftCheckpointPending = null;
              checkpointAssistantDraft(true);
            }, 1000);
            if (assistantDraftCheckpointPending.unref)
              assistantDraftCheckpointPending.unref();
          }
          return;
        }
        assistantDraftLastCheckpoint = now;
        chatStorage
          .updateAssistantDraft(sessionId, assistantDraft.id, {
            content: assistantDraftContent,
            thinking: assistantDraftThinking || undefined,
          })
          .catch((err) =>
            chatLog.warn(
              `assistant draft checkpoint failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      };

      const contextRootId = `system-context_assembly-${lease.generation}`;
      const contextStartedAt = Date.now();
      const contextSpans = new Map<string, { id: string; startedAt: number; parentId?: string }>();
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

      const {
        messages,
        conversationHistory,
        enrichedContent,
        toolDefs,
        contextPressure,
      } = await buildChatHistory(
        sessionId,
        content,
        chatModel,
        onCtxProgress,
        currentMessageIds,
      );
      chatRunLifecycle.assertCurrent(lease);
      const contextEndedAt = Date.now();
      const contextElapsedMs = contextEndedAt - contextStartedAt;
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

        const refreshedContext = await assembleContext({
          profile: "chat",
          conversationHistory,
          toolDefinitions: getToolDefinitions().map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
          model: routingDecision.modelString,
          sessionId,
          currentMessage: enrichedContent,
          meetingContext,
        });
        const { resolveSessionPersonaSnapshot } = await import("../../session-persona");
        const persona = await resolveSessionPersonaSnapshot(sessionId);
        if (assistantDraft && persona) {
          assistantDraft = await chatStorage.updateAssistantDraft(sessionId, assistantDraft.id, {
            model: routingDecision.modelString,
            persona,
          });
        }
        chatRunLifecycle.assertCurrent(lease);
        return {
          routingDecision,
          systemPrompt: refreshedContext.systemPrompt,
          persona,
        };
      };

      const result = await executeChatAgent(
        sessionKey,
        sessionId,
        messages,
        toolDefs,
        resolvedRoutingDecision,
        contextPressure,
        (event) => {
          if (event.type === "delta") {
            assistantDraftContent += event.content || "";
            checkpointAssistantDraft();
          } else if (event.type === "thinking") {
            assistantDraftThinking += event.content || "";
            checkpointAssistantDraft();
          }
          if (sayAloud && event.type === "tool_call") {
            if (event.toolCallId) visualizerToolCalls.add(event.toolCallId);
            setMeetingVisualizerState(sessionId, "tool", "tool_call");
          } else if (sayAloud && event.type === "tool_result") {
            if (event.toolCallId) visualizerToolCalls.delete(event.toolCallId);
            if (visualizerToolCalls.size === 0) clearMeetingVisualizerState(sessionId, "tool");
          }
        },
        chatRoutingTier,
        diagnosticTurnId,
        refreshAfterPersonaSwitch,
      );
      if (assistantDraftCheckpointPending) {
        clearTimeout(assistantDraftCheckpointPending);
        assistantDraftCheckpointPending = null;
      }
      if (assistantDraft) {
        await chatStorage
          .updateAssistantDraft(sessionId, assistantDraft.id, {
            content: assistantDraftContent,
            thinking: assistantDraftThinking || undefined,
          })
          .catch((err) =>
            chatLog.warn(
              `assistant draft final checkpoint failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
      chatLog.log(
        `executor DONE sessionId=${sessionId} contentLen=${result.content?.length || 0} terminationReason=${result.terminationReason || "unknown"} abortReason=${result.abortReason || "none"} durationMs=${result.durationMs ?? "?"} iterations=${result.iterations}`,
      );
      chatRunLifecycle.assertCurrent(lease);
      settleDiagnosticTurn("done");

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

      if (responseContent.trim() === "" && !isSuperseded) {
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
          parts.push(
            "This can happen when the session context grew too large.",
          );
        }
        if (errorDetail) {
          parts.push(`Cause: ${errorDetail}`);
        }
        parts.push(
          result.abortReason
            ? "Send another message and I'll continue from the last completed step."
            : "Try rephrasing your question or starting a new session.",
        );
        responseContent = parts.join(" ");
      }

      // Build and persist a system_notice for non-complete terminations
      // Skip for superseded runs — the new run starts automatically, no notice needed
      let systemNotice: SystemNotice | undefined;
      if (result.status === "failed" && result.abortReason !== "superseded") {
        systemNotice = buildSystemNotice(result);
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
            status: string;
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
          status: tc.error ? "error" : "done",
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
      chatLog.log(
        `saving message sessionId=${sessionId} thinkingLen=${persistedThinking?.length || 0} toolCallsCount=${persistedToolCalls?.length || 0} contentLen=${responseContent.length} systemSteps=${mergedSystemSteps.length}`,
      );

      const msg = assistantDraft
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
            segmentChronology: persistedChronology,
            assistantState:
              result.status === "succeeded" ? "complete" : "failed",
          })
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
          );

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

      const conv = await chatStorage.getSession(sessionId);
      if (conv && conv.status !== "saved") {
        await chatStorage.saveSession(sessionId, conv.title);

        // Session status is the durable completion authority. Finalize the live
        // stream at the same boundary so the transcript Thinking affordance and
        // Stop button cannot remain active while the Session Menu already shows
        // the turn as complete. The finally-block call remains as a safety net
        // and SessionManager finalization is idempotent.
        try {
          const { sessionManager } = await import("../../session-manager");
          sessionManager.finalizeSession(sessionId, runGeneration);
        } catch (finErr) {
          chatLog.debug(
            `sessionManager.finalizeSession after save skipped: ${finErr instanceof Error ? finErr.message : String(finErr)}`,
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
          chatLog.log(
            `meeting speech scheduled sessionId=${sessionId} resultStatus=${result.status} terminationReason=${result.terminationReason || "unknown"} contentLen=${responseContent.length}`,
          );
          import("../../meeting/output-media")
            .then(({ speakMeetingResponse }) => speakMeetingResponse(sessionId, responseContent))
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
      settlement = {
        status: result.status === "succeeded" ? "completed" : "failed",
        assistantMessageId: msg!.id,
        ...(result.status === "succeeded" ? {} : { error: result.error || result.terminationReason || "executor_failed" }),
      };
      } // end if (!isSuperseded)
    } catch (error: unknown) {
      if (error instanceof ChatRunInvalidatedError) {
        settleDiagnosticTurn("error", error.reason);
        chatLog.log(
          `${error.reason} before settlement sessionId=${sessionId} generation=${lease.generation}`,
        );
        if (assistantDraftCheckpointPending) clearTimeout(assistantDraftCheckpointPending);
        if (assistantDraft) {
          await chatStorage.deleteMessage(sessionId, assistantDraft.id).catch((deleteErr) =>
            chatLog.warn(`superseded draft delete failed sessionId=${sessionId}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`),
          );
        }
        settlement = { status: "failed", error: error.reason };
        return;
      }
      settleDiagnosticTurn("error", "processing error");
      chatLog.error(
        `executor error sessionId=${sessionId}: ${(error instanceof Error ? error.message : String(error)) || error}`,
      );
      // Emit exactly one terminal event so the client never gets stuck on persistence failures.
      // `error` is itself terminal — do not also emit `done`.
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

        // Persist any partial assistant content if available (system steps, chronology)
        const crashSystemSteps = preSteps.length > 0 ? preSteps : undefined;
        const crashChronology =
          preChronology.length > 0 ? preChronology : undefined;
        if (typeof assistantDraft !== "undefined" && assistantDraft) {
          await chatStorage.updateAssistantDraft(sessionId, assistantDraft.id, {
            content:
              assistantDraftContent ||
              "Response interrupted by an error before completion.",
            thinking: assistantDraftThinking || undefined,
            model: chatModel,
            systemSteps: crashSystemSteps,
            segmentChronology: crashChronology,
            assistantState: "failed",
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
      if (sayAloud) {
        clearMeetingVisualizerState(sessionId, "tool");
        clearMeetingVisualizerState(sessionId, "turn");
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
          sessionManager.finalizeSession(sessionId, runGeneration);
        } catch (finErr) {
          chatLog.debug(
            `sessionManager.finalizeSession skipped: ${finErr instanceof Error ? finErr.message : String(finErr)}`,
          );
        }
      }
    }
  }

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
        } = req.body;
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
        }
        if (!isGreeting && clientTurnId) {
          const acceptance = await chatStorage.createUserMessageOnce(
            sessionId,
            acceptedContent,
            clientTurnId,
            msgPageContext,
            acceptedQuestionResponse,
          );
          if (acceptance.outcome === "session_not_found") {
            return res.status(404).json({ error: "Session not found" });
          }
          if (acceptance.outcome === "question_already_answered") {
            return res.status(409).json({ error: "This question has already been answered." });
          }
          if (acceptance.outcome === "duplicate") {
            chatLog.warn(`duplicate message replay ignored sessionId=${sessionId} clientTurnId=${clientTurnId}`);
            return res.status(session.status === "streaming" ? 202 : 200).json({
              duplicate: true,
              sessionKey: session.sessionKey || `dashboard:${sessionId}`,
              sessionId,
              status: session.status,
              queued: session.status === "streaming",
            });
          }
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
            await completeFtueSayHello(principal as typeof principal & { userId: string; accountId: string });
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

        let runGeneration: number | undefined;
        try {
          const { sessionManager } = await import("../../session-manager");
          runGeneration = sessionManager.registerSession(sessionId, sessionKey, "text");
        } catch (regErr) {
          chatLog.warn(
            `sessionManager.registerSession failed: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
          );
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
          runGeneration,
          acceptedLease,
        ).catch((err) => {
          if (err instanceof ChatRunInvalidatedError) {
            chatLog.log(`processChatStream ${err.reason} sessionId=${sessionId} generation=${err.generation}`);
            return;
          }
          chatLog.error("processChatStream error:", err);
        });
      } catch (error) {
        if (acceptedLease) chatRunLifecycle.finish(acceptedLease);
        if (error instanceof ChatRunInvalidatedError) {
          chatLog.log(`message acceptance ${error.reason} sessionId=${sessionId} generation=${error.generation}`);
          if (!res.headersSent) res.status(202).json({ queued: true, superseded: true });
          return;
        }
        chatLog.error("Error sending message:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to send message" });
        }
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
      source: "recall_participant_audio" | "recall_transcript_webhook";
      fallback: boolean;
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

    // Speaker attribution against the session's participant roster
    const resolution = await resolveSpeaker(
      sessionId,
      {
        speakerKey: event.speaker?.key,
        label: event.speakerLabel,
        email: event.speaker?.email,
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
    const transcriptAcceptance = await chatStorage.createMeetingUserMessage(
      sessionId,
      event.text,
      resolution.speaker,
      sourceTurnId,
    );
    if (transcriptAcceptance.outcome === "session_not_found") {
      return { ok: false, status: 404, error: "Meeting session disappeared during transcript persistence" };
    }
    const persistedMessage = transcriptAcceptance.message;
    // Provider retries must cross the queue boundary again. Queue enrollment is
    // idempotent on sourceTurnId, so a crash between these two durable writes
    // repairs itself on replay instead of stranding a transcript-only turn.
    if (transcriptAcceptance.outcome === "created") {
      publishChatStreamEvent(sessionKey, sessionId, {
        type: "user_message",
        content: event.text,
        sessionId,
        title: session.title || undefined,
      });
    }

    const { appendMeetingTurnFragment } = await import("../../meeting/turn-queue");
    const assembled = await appendMeetingTurnFragment({
      sessionId,
      sessionKey,
      speakerKey: resolution.speaker.key || resolution.speaker.personId || resolution.speaker.label.toLowerCase(),
      speakerLabel: resolution.speaker.label,
      participationMode: event.participationMode,
      executionAffinityBootId: event.executionAffinityBootId,
      text: event.text,
      sourceTurnId,
      sourceMessageId: persistedMessage.id,
    });
    chatLog.debug(
      `meeting turn buffered sessionId=${sessionId} turnId=${assembled.id} revision=${assembled.revision} fragments=${assembled.sourceTurnIds.length} readyAt=${assembled.readyAt.toISOString()}`,
    );
    meetingTurnCoordinator.schedule();

    return {
      ok: true,
      sessionId,
      sessionKey,
      speaker: resolution.speaker,
      queued: true,
    };
  }

  // External audio transports reuse the same durable turn intake. Phone
  // playback remains transport-owned, so the queue worker speaks only through
  // the registered callback for that live connection.
  const { registerPhoneRoutes } = await import("../../phone/routes");
  registerPhoneRoutes(app, {
    ingestPhoneTurn: async (event) => {
      meetingTurnCoordinator.registerPhoneResponse(event.sessionId, event.onResponse);
      const result = await ingestMeetingEvent({
        sessionId: event.sessionId,
        speakerLabel: event.speakerLabel,
        text: event.text,
        participationMode: "always",
        executionAffinityBootId: BOOT_ID,
      });
      return result;
    },
    releasePhoneTurn: (sessionId) => meetingTurnCoordinator.unregisterPhoneResponse(sessionId),
  });

  // Recall.ai webhook receiver — registered with the canonical ingest path.
  const { registerRecallRoutes } = await import("../../routes/recall");
  registerRecallRoutes(app, { ingestMeetingEvent });
  const { registerMeetingSTTAudioTransport } = await import("../../meeting/stt");
  app.locals.recallMeetingAudioUpgrade = registerMeetingSTTAudioTransport({ ingestMeetingEvent });

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
      abortTrace("route_error", { sessionId, error: msg, routeStartAt });
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
    async (req: Request, res: Response) => {
      try {
        const chatSessionId = req.params.id as string;
        const voiceSessionId = req.body?.sessionId as string | undefined;
        const errorMessage = req.body?.errorMessage as string | undefined;
        const rawSystemSteps = req.body?.systemSteps as
          | Array<{ name: string; status: "done" | "error"; detail?: string }>
          | undefined;
        const session = await chatStorage.getSession(chatSessionId);
        if (!session) {
          return res.status(404).json({ error: "Session not found" });
        }

        const { chatFileStorage } = await import("../../chat-file-storage");

        if (errorMessage) {
          try {
            await chatFileStorage.createMessage(
              chatSessionId,
              "assistant",
              errorMessage,
              undefined,
              undefined,
              undefined,
              rawSystemSteps,
            );
            chatLog.log(
              `VoiceFinalize persisted error message chatSessionId=${chatSessionId} error="${errorMessage.slice(0, 80)}" systemSteps=${rawSystemSteps?.length || 0}`,
            );
          } catch (errPersist: unknown) {
            const msg =
              errPersist instanceof Error
                ? errPersist.message
                : String(errPersist);
            chatLog.warn(
              `VoiceFinalize: failed to persist error message: ${msg}`,
            );
          }
        } else if (rawSystemSteps && rawSystemSteps.length > 0) {
          try {
            const messages =
              await chatFileStorage.getMessagesBySession(chatSessionId);
            const lastAssistant = [...messages]
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistant) {
              const existingSteps = lastAssistant.systemSteps || [];
              const existingKeys = new Set(
                existingSteps.map((s) => `${s.name}:${s.detail}`),
              );
              const deduped = rawSystemSteps.filter(
                (s) => !existingKeys.has(`${s.name}:${s.detail}`),
              );
              if (deduped.length === 0) {
                chatLog.log(
                  `VoiceFinalize systemSteps already present (retry dedup) chatSessionId=${chatSessionId}`,
                );
              } else {
                const mergedSteps = [...existingSteps, ...deduped];
                await chatFileStorage.updateMessageSystemSteps(
                  lastAssistant.id,
                  chatSessionId,
                  mergedSteps,
                );
                chatLog.log(
                  `VoiceFinalize merged systemSteps onto last assistant message chatSessionId=${chatSessionId} messageId=${lastAssistant.id} steps=${mergedSteps.length}`,
                );
              }
            } else {
              await chatFileStorage.createMessage(
                chatSessionId,
                "assistant",
                "",
                undefined,
                undefined,
                undefined,
                rawSystemSteps,
              );
              chatLog.log(
                `VoiceFinalize created assistant message for systemSteps chatSessionId=${chatSessionId} steps=${rawSystemSteps.length}`,
              );
            }
          } catch (errSteps: unknown) {
            const msg =
              errSteps instanceof Error ? errSteps.message : String(errSteps);
            chatLog.warn(
              `VoiceFinalize: failed to persist system steps: ${msg}`,
            );
          }
        }

        if (session.status !== "saved") {
          await chatStorage.saveSession(
            chatSessionId,
            session.title || "Voice Chat",
          );
          chatLog.log(
            `VoiceFinalize saved chatSessionId=${chatSessionId} title="${session.title}"`,
          );
        }

        if (voiceSessionId) {
          storage
            .endVoiceSessionActive(voiceSessionId, "complete", {
              kind: "user",
              principal: req.principal!,
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              chatLog.warn(
                `VoiceFinalize: failed to mark voice_session_active complete voiceSessionId=${voiceSessionId}: ${msg}`,
              );
            });
        }

        res.json({ finalized: true });
      } catch (error) {
        chatLog.error("VoiceFinalize error:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to finalize voice session" });
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
