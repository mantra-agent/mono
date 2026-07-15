/**
 * Voice session management — session map, CRUD, health watchdog,
 * DB reconciliation, turn locking, session resolution, and shared
 * session-scoped helpers (journal, events, diagnostics).
 *
 * This is the authoritative store for in-memory voice sessions.
 */
import { randomUUID } from "crypto";
import { writeSync as _bootWriteSync } from "fs";
import type { Response } from "express";
import { agentExecutor } from "../agent-executor";
import { ACTIVITY_VOICE } from "../job-profiles";
import { audienceForPrincipal, eventBus } from "../event-bus";
import { createLogger } from "../log";
import { writeJournal, nextSystemStepSeq } from "../chat-journal";
import { abortTrace } from "../abort-trace";
import type { VoiceSession, VoiceMessage, TurnContext } from "./types";

const log = createLogger("VoiceLlm");

// ── Session Map ──────────────────────────────────────────────────────────

export const sessions = new Map<string, VoiceSession>();

export function getSessionMap(): Map<string, VoiceSession> {
  return sessions;
}

// ── Constants ────────────────────────────────────────────────────────────

export const ABORT_WAIT_TIMEOUT_MS = 500;
const SESSION_HEALTH_INTERVAL_MS = 30_000;
const SESSION_QUIET_THRESHOLD_MS = 60_000;
const SESSION_DEAD_ZERO_TURNS_MS = 5 * 60 * 1000;
const SESSION_DEAD_ANY_TURNS_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SESSION_STALE_RECONNECT_MS = 180_000;
const BOOT_RECOVERY_PER_ROW_BUDGET_MS = 2000;

// ── Session Helpers ──────────────────────────────────────────────────────

export function voiceSessionKey(session: VoiceSession): string {
  return session.chatSessionKey || `voice:${session.id}`;
}

export function voiceSessionId(session: VoiceSession): string {
  return session.chatSessionId || session.id;
}

export function isSessionInflight(s: VoiceSession): boolean {
  return !!(s.inflightAbort && s.inflightTurn > 0);
}

export function getActiveVoiceRunCount(): number {
  return agentExecutor.countActiveVoiceRuns(ACTIVITY_VOICE);
}

// ── Journal & Event Helpers ──────────────────────────────────────────────

export function writeVoiceJournal(
  session: VoiceSession,
  type: import("../chat-journal").JournalEntryType,
  extra?: Partial<import("../chat-journal").JournalEntry>,
): void {
  try {
    writeJournal({
      ts: Date.now(),
      type,
      sessionKey: voiceSessionKey(session),
      sessionId: voiceSessionId(session),
      source: "voice" as const,
      ...extra,
    });
  } catch (err: unknown) {
    log.warn(`voice journal write failed (${type}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function publishVoiceEvent(
  session: VoiceSession,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!session.chatSessionKey) return;
  eventBus.publish({
    category: "voice",
    event,
    payload: {
      sessionId: session.id,
      chatSessionId: session.chatSessionId,
      timestamp: Date.now(),
      ...payload,
    },
    sessionKey: session.chatSessionKey,
    audience: audienceForPrincipal(session.principal),
  });
}

// ── Diagnostics ──────────────────────────────────────────────────────────

const DIAGNOSTIC_WEBSOCKET_STEPS = new Set([
  "context_assembly", "llm_first_delta", "turn_complete",
  "res_close_premature", "req_close", "res_error",
  "content_dropped", "keepalive_dead",
  "concurrency_cap", "concurrency_cap_recovered", "concurrency_cap_failed",
  "turn_superseded", "zombie_blocked", "zombie_recovered", "zombie_failed",
  "db_pool_pressure", "prompt_size_warning", "orphan_response",
  "coalesce_truncation",
  "response_closed_abort", "dead_connection_abort", "coalesce_timer_dead",
  "sse_keepalive_dead", "turn_aborted", "turn_cancelled", "turn_error",
]);

export function publishVoiceDiagnostic(
  session: VoiceSession,
  stepName: string,
  detail?: string,
  extra?: Record<string, unknown>,
  ctx?: TurnContext,
): void {
  if (ctx?.aborted) return;

  const rawStatus = typeof extra?.status === "string" ? extra.status : "done";
  const persistStatus: "done" | "error" = rawStatus === "error" ? "error" : "done";
  const elapsedMs = typeof extra?.elapsedMs === "number" ? extra.elapsedMs : undefined;
  const fullName = `voice_${stepName}`;
  const journalStatus = rawStatus === "error" ? "error" : rawStatus === "active" ? "started" : "done";
  const turnId = ctx?.turnId;

  if (ctx) {
    const step = { name: fullName, status: persistStatus, elapsedMs, detail };
    ctx.systemSteps.push(step);
    ctx.segmentChronology.push({ s: "system", i: ctx.systemSteps.length - 1 });
  }

  writeVoiceJournal(session, "system_step", {
    step: fullName,
    status: journalStatus,
    elapsedMs,
    detail,
    seq: nextSystemStepSeq(),
    ...(turnId ? { turnId } : {}),
  });

  if (DIAGNOSTIC_WEBSOCKET_STEPS.has(stepName)) {
    publishVoiceEvent(session, "voice_diagnostic", {
      stepName: fullName,
      detail,
      status: rawStatus,
      elapsedMs,
      turn: typeof extra?.turn === "number" ? extra.turn : undefined,
    });
  }
}

/** Publish a lifecycle event through both canonical live projection paths. */
export async function publishVoiceLifecycleEvent(
  session: VoiceSession,
  event: "assistant_attempt_started" | "assistant_attempt_superseded" | "assistant_attempt_committed",
  payload: { turnId: string; assistantAttemptId: string; transcriptRevision: number; turn: number },
): Promise<void> {
  if (session.chatSessionId) {
    const { sessionManager } = await import("../session-manager");
    sessionManager.applyEvent(session.chatSessionId, { type: event, ...payload });
  }
  publishVoiceEvent(session, event, {
    voiceTurnId: payload.turnId,
    assistantAttemptId: payload.assistantAttemptId,
    transcriptRevision: payload.transcriptRevision,
    turn: payload.turn,
  });
}

// ── Turn Lock ────────────────────────────────────────────────────────────

const sessionTurnMutex = new Map<string, Promise<void>>();

export async function acquireSessionTurnLock(sessionId: string): Promise<() => void> {
  while (sessionTurnMutex.has(sessionId)) {
    await sessionTurnMutex.get(sessionId);
  }
  let releaseFn!: () => void;
  const lockPromise = new Promise<void>(resolve => { releaseFn = resolve; });
  sessionTurnMutex.set(sessionId, lockPromise);
  return () => {
    if (sessionTurnMutex.get(sessionId) === lockPromise) {
      sessionTurnMutex.delete(sessionId);
    }
    releaseFn();
  };
}

export function isSessionTurnLocked(sessionId: string): boolean {
  return sessionTurnMutex.has(sessionId);
}

// ── Inflight Tracing ─────────────────────────────────────────────────────

export function traceInflightDoneResolved(
  s: VoiceSession,
  site: string,
  turn: number,
  extra?: Record<string, unknown>,
): void {
  abortTrace("voice.inflightDoneResolved", {
    sessionId: s.id,
    sessionKey: s.chatSessionKey || s.chatSessionId,
    site,
    turn,
    ...(extra || {}),
  });
}

// ── Session Lifecycle ────────────────────────────────────────────────────

export function generateVoiceSessionId(): string {
  return `voice-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function createVoiceSession(
  chatSessionId?: string,
  preCachedSystemPrompt?: string,
  preGeneratedId?: string,
  chatSessionKey?: string,
  isReconnect?: boolean,
): VoiceSession {
  if (chatSessionId) {
    const recentDupes: Array<{ id: string; ageMs: number }> = [];
    const now = Date.now();
    for (const [, prev] of sessions) {
      if (prev.chatSessionId === chatSessionId) {
        const ageMs = now - prev.startedAt;
        if (ageMs < 2_000) recentDupes.push({ id: prev.id, ageMs });
      }
    }
    if (recentDupes.length > 0) {
      log.error(`[VoiceSession] DUPLICATE_START_DETECTED chatSessionId=${chatSessionId} recentSessions=${JSON.stringify(recentDupes)} — task-923 invariant violated`);
    }
  }

  const session: VoiceSession = {
    id: preGeneratedId || generateVoiceSessionId(),
    chatSessionId: chatSessionId || null,
    chatSessionKey: chatSessionKey || null,
    cachedSystemPrompt: preCachedSystemPrompt || null,
    cachedSystemPromptFocusKey: null,
    cachedAt: preCachedSystemPrompt ? Date.now() : 0,
    toolCalls: [],
    turnCount: 0,
    startedAt: Date.now(),
    ending: false,
    inflightAbort: null,
    inflightTurn: 0,
    inflightDone: null,
    inflightDoneResolve: null,
    inflightContextPromise: null,
    inflightContextFocusKey: null,
    lastDataDeliveryAt: Date.now(),
    inflightChunksDelivered: 0,
    totalSuccessfulTurns: 0,
    totalAbortedTurns: 0,
    longestDataGapMs: 0,
    disconnectReason: null,
    lastFiredUserContent: "",
    lastCallbackAt: Date.now(),
    isReconnect: !!isReconnect,
    historyInjected: false,
    recentCancellations: [],
    circuitBreakerActive: false,
    prefixContinuation: false,
    lastPersistedUserMessageId: null,
    lastPersistedUserTurnKey: null,
    lastPersistedUserOrdinal: null,
    pendingTranscriptUpdate: null,
    executorStarted: false,
    activeTurnNumber: 0,
    activeVoiceTurnId: null,
    activeVoiceUserOrdinal: null,
    activeTranscriptRevision: 0,
    activeAssistantAttemptId: null,
    principal: null,
  };
  sessions.set(session.id, session);
  log.log(`created session ${session.id} chatSessionId=${session.chatSessionId} preCached=${!!preCachedSystemPrompt} activeSessions=${sessions.size} ts=${new Date().toISOString()}`);
  return session;
}

export function touchVoiceSessionCallback(sessionId: string, source: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.lastCallbackAt = Date.now();
  log.debug(`touchVoiceSessionCallback session=${sessionId} source=${source}`);
}

export function touchVoiceSessionByChat(chatSessionId: string, source: string): void {
  for (const [, s] of sessions) {
    if (s.chatSessionId === chatSessionId) {
      s.lastCallbackAt = Date.now();
      log.debug(`touchVoiceSessionByChat chatSessionId=${chatSessionId} session=${s.id} source=${source}`);
    }
  }
}

export async function resumeVoiceSession(
  previousSessionId: string,
  newSessionId: string,
  chatSessionKey?: string,
): Promise<VoiceSession | null> {
  const prev = sessions.get(previousSessionId);
  if (!prev) {
    log.warn(`resumeVoiceSession: previous session ${previousSessionId} not found — cannot resume`);
    return null;
  }

  prev.activeTurnNumber = -1;

  if (prev.inflightAbort) {
    log.debug(`resumeVoiceSession: aborting inflight turn ${prev.inflightTurn} on previous session ${previousSessionId}`);
    const { waitMs } = await abortAndCleanupTurn(prev, 3000);
    log.debug(`resumeVoiceSession: abort cleanup done waitMs=${waitMs} session=${previousSessionId}`);
    publishVoiceDiagnostic(prev, "abort_cleanup", `Aborted inflight turn during reconnect (${waitMs}ms)`, { status: "done", elapsedMs: waitMs });
  }

  const killResult = agentExecutor.abortVoiceSession(
    prev.chatSessionId || "",
    voiceSessionKey(prev),
  );
  if (killResult.aborted) {
    log.debug(`resumeVoiceSession: killed executor runs on ${previousSessionId}: runsKilled=${killResult.runsKilled}`);
  }

  if (prev.chatSessionId) {
    publishVoiceDiagnostic(prev, "voice_reconnect", `Voice session reconnected (${previousSessionId} → ${newSessionId})`, { status: "done" });
    try {
      const { chatFileStorage } = await import("../chat-file-storage");
      await chatFileStorage.createMessage(
        prev.chatSessionId, "assistant", "",
        undefined, undefined, "elevenlabs-voice",
        [{ name: "voice_reconnect", status: "done" as const, detail: `Reconnected: ${previousSessionId} → ${newSessionId}` }],
      );
      log.debug(`resumeVoiceSession: voice_reconnect event persisted to DB session=${previousSessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`resumeVoiceSession: voice_reconnect persistence failed: ${msg}`);
    }
  }

  sessions.delete(previousSessionId);

  const resumed: VoiceSession = {
    ...prev,
    id: newSessionId,
    chatSessionKey: chatSessionKey || prev.chatSessionKey,
    ending: false,
    inflightAbort: null,
    inflightTurn: 0,
    inflightDone: null,
    inflightDoneResolve: null,
    inflightContextPromise: null,
    inflightContextFocusKey: null,
    inflightChunksDelivered: 0,
    lastDataDeliveryAt: Date.now(),
    lastCallbackAt: Date.now(),
    disconnectReason: null,
    isReconnect: true,
    historyInjected: false,
    cachedSystemPrompt: null,
    cachedSystemPromptFocusKey: null,
    cachedAt: 0,
    executorStarted: false,
    recentCancellations: [],
    circuitBreakerActive: false,
    prefixContinuation: false,
    lastPersistedUserMessageId: null,
    lastPersistedUserTurnKey: null,
    lastPersistedUserOrdinal: null,
    pendingTranscriptUpdate: null,
    activeTurnNumber: 0,
    toolCalls: [...prev.toolCalls],
  };

  sessions.set(newSessionId, resumed);
  log.debug(`resumeVoiceSession: ${previousSessionId}→${newSessionId} chatSessionId=${resumed.chatSessionId} turnCount=${resumed.turnCount} activeTurnNumber=${resumed.activeTurnNumber} toolCalls=${resumed.toolCalls.length} activeSessions=${sessions.size}`);
  return resumed;
}

export function getVoiceSession(sessionId: string): VoiceSession | null {
  return sessions.get(sessionId) || null;
}

export function findSessionForChat(chatSessionId: string): VoiceSession | null {
  let bestCached: VoiceSession | null = null;
  let bestAny: VoiceSession | null = null;
  for (const [, s] of sessions) {
    if (s.chatSessionId === chatSessionId) {
      if (s.cachedSystemPrompt && (!bestCached || s.startedAt > bestCached.startedAt)) {
        bestCached = s;
      }
      if (!bestAny || s.startedAt > bestAny.startedAt) {
        bestAny = s;
      }
    }
  }
  return bestCached || bestAny;
}

export function endSessionsForChat(
  chatSessionId: string,
  excludeSessionId?: string,
): { closed: number; closedIds: string[]; chatSessionKey: string | null } {
  let closed = 0;
  const closedIds: string[] = [];
  let chatSessionKey: string | null = null;
  for (const [id, s] of sessions) {
    if (s.chatSessionId === chatSessionId && id !== excludeSessionId) {
      log.debug(`closing stale session ${id} for chatSessionId=${chatSessionId} (replaced by ${excludeSessionId || "new"})`);
      if (!chatSessionKey) chatSessionKey = s.chatSessionKey;
      sessions.delete(id);
      closedIds.push(id);
      closed++;
    }
  }
  return { closed, closedIds, chatSessionKey };
}

export function endVoiceSession(sessionId: string, reason?: string): VoiceSession | null {
  import("../cli-sdk-adapter").then(({ cleanupVoiceWarmHandle }) => {
    cleanupVoiceWarmHandle(sessionId);
  }).catch(() => {});

  const session = sessions.get(sessionId);
  if (session) {
    if (reason && !session.disconnectReason) session.disconnectReason = reason;
    if (!session.disconnectReason) session.disconnectReason = session.ending ? "session_end" : "external";
    const elapsed = Date.now() - session.startedAt;
    log.log(`ending session ${session.id} turns=${session.turnCount} tools=${session.toolCalls.length} elapsed=${elapsed}ms reason=${session.disconnectReason} ts=${new Date().toISOString()}`);
    log.log(`SESSION_SUMMARY session=${session.id} totalTurns=${session.turnCount} successfulTurns=${session.totalSuccessfulTurns} abortedTurns=${session.totalAbortedTurns} totalTime=${elapsed}ms disconnectReason=${session.disconnectReason} longestDataGap=${session.longestDataGapMs}ms lastDataDeliveryAge=${Date.now() - session.lastDataDeliveryAt}ms`);
    sessions.delete(sessionId);
  }
  return session || null;
}

// ── Session.end Event Listener ───────────────────────────────────────────

eventBus.on("event", (busEvent: { event: string; payload: Record<string, unknown> }) => {
  if (busEvent.event !== "session.end") return;
  const { sessionId, chatSessionId } = busEvent.payload as { sessionId?: string; chatSessionId?: string };

  for (const [id, session] of sessions) {
    const match = (sessionId && id === sessionId) ||
      (chatSessionId && session.chatSessionId === chatSessionId);
    if (match) {
      log.debug(`session.end event received — tearing down voice session ${id} (chatSessionId=${session.chatSessionId})`);
      session.ending = true;
      session.disconnectReason = "session_end_event";
      endVoiceSession(id);
      return;
    }
  }
});

// ── Abort & Cleanup ──────────────────────────────────────────────────────

export async function abortAndCleanupTurn(
  session: VoiceSession,
  waitTimeoutMs: number = ABORT_WAIT_TIMEOUT_MS,
): Promise<{ aborted: boolean; waitMs: number }> {
  if (!session.inflightAbort) return { aborted: false, waitMs: 0 };

  abortTrace("voice.abortAndCleanupTurn.enter", {
    sessionId: session.id,
    sessionKey: session.chatSessionKey || session.chatSessionId,
    inflightTurn: session.inflightTurn,
  });
  session.inflightAbort.abort();
  let waitMs = 0;

  if (session.inflightDone) {
    const waitStart = Date.now();
    const timedOut = await Promise.race([
      session.inflightDone.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), waitTimeoutMs)),
    ]);
    waitMs = Date.now() - waitStart;

    if (timedOut) {
      log.warn(`abortAndCleanupTurn: inflight turn ${session.inflightTurn} did not exit within ${waitTimeoutMs}ms — force-killing session=${session.id}`);
      const killResult = agentExecutor.abortVoiceSession(
        session.chatSessionId || "",
        voiceSessionKey(session),
      );
      log.debug(`abortAndCleanupTurn: abortVoiceSession result: aborted=${killResult.aborted} runsKilled=${killResult.runsKilled} session=${session.id}`);
      if (session.inflightDoneResolve) {
        traceInflightDoneResolved(session, "abortAndCleanupTurn.timeout", session.inflightTurn);
        session.inflightDoneResolve();
      }
      session.inflightAbort = null;
      session.inflightTurn = 0;
      session.inflightDone = null;
      session.inflightDoneResolve = null;
    } else {
      log.debug(`abortAndCleanupTurn: inflight turn exited cleanly in ${waitMs}ms session=${session.id}`);
    }
  }

  abortTrace("voice.abortAndCleanupTurn.exit", {
    sessionId: session.id,
    sessionKey: session.chatSessionKey || session.chatSessionId,
    ms: waitMs,
  });
  return { aborted: true, waitMs };
}

// ── Force Kill ───────────────────────────────────────────────────────────

function forceKillSession(id: string, s: VoiceSession, reason: string): void {
  s.disconnectReason = reason;
  if (isSessionInflight(s)) {
    abortTrace("voice.forceKillSession", {
      sessionId: id,
      sessionKey: s.chatSessionKey || s.chatSessionId,
      reason,
      inflightTurn: s.inflightTurn,
    });
    log.warn(`[SessionHealth] ZOMBIE_KILL session=${id} reason=${reason} — aborting inflight turn=${s.inflightTurn}`);
    s.inflightAbort!.abort();
    agentExecutor.abortVoiceSession(
      s.chatSessionId || "",
      voiceSessionKey(s),
    );
    if (s.inflightDoneResolve) {
      traceInflightDoneResolved(s, "forceKillSession", s.inflightTurn);
      s.inflightDoneResolve();
    }
    s.inflightAbort = null;
    s.inflightTurn = 0;
    s.inflightDone = null;
    s.inflightDoneResolve = null;
  }
  sessions.delete(id);
}

// ── Boot Recovery Helpers ────────────────────────────────────────────────

function bootQuarantine(step: string, id: string, reason: string, elapsedMs: number): void {
  try {
    _bootWriteSync(2, `[BOOT_QUARANTINE] step=${step} id=${id} reason=${JSON.stringify(reason)} elapsedMs=${elapsedMs} ts=${new Date().toISOString()}\n`);
  } catch {}
}

async function withBootRowTimeout<T>(label: string, id: string, op: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string; elapsedMs: number }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: string; elapsedMs: number }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout", elapsedMs: Date.now() - start }), BOOT_RECOVERY_PER_ROW_BUDGET_MS);
  });
  try {
    const settled = op().then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - start }),
    );
    const result = await Promise.race([settled, timeout]);
    if (!result.ok) bootQuarantine(label, id, result.reason, result.elapsedMs);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── DB Reconciliation ────────────────────────────────────────────────────

export async function reconcileDbVoiceState(): Promise<void> {
  const { storage } = await import("../storage");
  const ownerBootId = eventBus.bootId;
  const dbSessions = await storage.getActiveVoiceSessions(ownerBootId);
  const dbSessionIds = new Set(dbSessions.map(s => s.sessionId));

  const GRACE_PERIOD_MS = 60_000;
  const now = Date.now();
  let completed = 0;
  let quarantined = 0;
  for (const [memId, memSession] of sessions) {
    if (!dbSessionIds.has(memId)) {
      const age = now - memSession.startedAt;
      if (age < GRACE_PERIOD_MS) {
        log.debug(`[Reconcile] in-memory session ${memId} has no DB record but is only ${age}ms old — skipping (grace period)`);
        continue;
      }
      log.warn(`[Reconcile] in-memory session ${memId} has no DB record (age=${Math.round(age / 1000)}s) — removing from memory (DB is authoritative)`);
      forceKillSession(memId, memSession, "no_db_record");
      completed++;
    }
  }

  for (const dbRow of dbSessions) {
    if (!sessions.has(dbRow.sessionId)) {
      log.warn(`[Reconcile] DB session ${dbRow.sessionId} not in memory (inflightTurn=${dbRow.inflightTurn}) — marking abandoned in DB`);
      const r = await withBootRowTimeout("reconcile.endVoiceSessionActive", dbRow.sessionId, () =>
        storage.endVoiceSessionActive(dbRow.sessionId, "abandoned"));
      if (r.ok) completed++; else quarantined++;
    } else {
      const memSession = sessions.get(dbRow.sessionId)!;
      const memInflight = memSession.inflightTurn || 0;
      if (dbRow.inflightTurn && dbRow.inflightTurn > 0 && memInflight === 0) {
        log.warn(`[Reconcile] DB says session ${dbRow.sessionId} has inflightTurn=${dbRow.inflightTurn} but memory says 0 — clearing stale DB inflight`);
        const r = await withBootRowTimeout("reconcile.clearVoiceSessionInflight", dbRow.sessionId, () =>
          storage.clearVoiceSessionInflight(dbRow.sessionId));
        if (r.ok) completed++; else quarantined++;
      } else {
        completed++;
      }
    }
  }

  const reconcileLevel = (dbSessions.length === 0 && sessions.size === 0) ? "debug" : "info";
  if (reconcileLevel === "debug") {
    log.debug(`[Reconcile] complete: dbActive=0 memActive=0 completed=${completed} quarantined=${quarantined}`);
  } else {
    log.log(`[Reconcile] complete: ownerBootId=${ownerBootId} dbActive=${dbSessions.length} memActive=${sessions.size} completed=${completed} quarantined=${quarantined}`);
  }
}

// ── Health Watchdog ──────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  const voiceRunCount = getActiveVoiceRunCount();
  log.debug(`[SessionHealth] SUMMARY activeSessions=${sessions.size} activeVoiceRuns=${voiceRunCount} ts=${new Date().toISOString()}`);

  for (const [id, s] of sessions) {
    const age = now - s.startedAt;
    const msSinceLastCallback = now - s.lastCallbackAt;
    const inflight = isSessionInflight(s);

    if (age > SESSION_MAX_AGE_MS) {
      log.debug(`[SessionHealth] EXPIRED session=${id} age=${Math.round(age / 1000)}s inflight=${inflight} — removing`);
      forceKillSession(id, s, "expired");
      continue;
    }

    const deadByZeroTurns = s.turnCount === 0
      && msSinceLastCallback > SESSION_DEAD_ZERO_TURNS_MS;
    const deadByAge = msSinceLastCallback > SESSION_DEAD_ANY_TURNS_MS;
    if (deadByZeroTurns || deadByAge) {
      log.warn(`[SessionHealth] DEAD session=${id} age=${Math.round(age / 1000)}s msSinceLastCallback=${msSinceLastCallback}ms turnCount=${s.turnCount} inflight=${inflight} — removing`);
      forceKillSession(id, s, deadByZeroTurns ? "dead_zero_turns" : "dead_by_age");
      continue;
    }

    if (msSinceLastCallback > SESSION_STALE_RECONNECT_MS && inflight) {
      log.warn(`[SessionHealth] STALE session=${id} age=${Math.round(age / 1000)}s msSinceLastCallback=${msSinceLastCallback}ms turnCount=${s.turnCount} inflight=true — publishing reconnect signal`);
      publishVoiceDiagnostic(s, "session_health", `Session stale (${Math.round(msSinceLastCallback / 1000)}s since last callback, inflight)`, { status: "error" });
      if (s.chatSessionKey) {
        eventBus.publish({
          category: "chat",
          event: "chat.stream",
          payload: {
            type: "voice_reconnect",
            sessionKey: s.chatSessionKey,
            sessionId: id,
            reason: "stale_session",
          },
          sessionKey: s.chatSessionKey,
        });
      }
    } else if (msSinceLastCallback > SESSION_QUIET_THRESHOLD_MS) {
      log.warn(`[SessionHealth] QUIET session=${id} age=${Math.round(age / 1000)}s msSinceLastCallback=${msSinceLastCallback}ms turnCount=${s.turnCount} ending=${s.ending} inflight=${inflight}`);
    } else {
      log.debug(`[SessionHealth] OK session=${id} age=${Math.round(age / 1000)}s msSinceLastCallback=${msSinceLastCallback}ms turnCount=${s.turnCount} inflight=${inflight}`);
    }
  }

  reconcileDbVoiceState().catch((err: unknown) => {
    log.warn(`[SessionHealth] DB reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, SESSION_HEALTH_INTERVAL_MS);

// ── Session Resolution ───────────────────────────────────────────────────

export async function resolveSession(
  sessionId: string | undefined,
  body: Record<string, unknown> | undefined,
  params: Record<string, string> | undefined,
): Promise<{ session: VoiceSession | null; sessionId: string | undefined }> {
  let session: VoiceSession | null = sessionId ? (sessions.get(sessionId) || null) : null;

  if (!session && !sessionId && sessions.size === 1) {
    const [onlyId, onlySession] = Array.from(sessions.entries())[0];
    log.debug(`memory-map resolved: only active session ${onlyId} mapSize=1`);
    session = onlySession;
    sessionId = onlyId;
  }

  if (!session && !sessionId && sessions.size > 1) {
    let best: VoiceSession | null = null;
    let bestId: string | undefined;
    for (const [id, s] of sessions) {
      if (!best || s.lastCallbackAt > best.lastCallbackAt) {
        best = s;
        bestId = id;
      }
    }
    if (best && bestId) {
      log.debug(`memory-map resolved: most recent of ${sessions.size} sessions — ${bestId}`);
      session = best;
      sessionId = bestId;
    }
  }

  if (!session && sessionId) {
    const paramConvId = typeof params?.chatSessionId === "string" ? params.chatSessionId : undefined;
    const bodyConvId = typeof body?.chatSessionId === "string" ? body.chatSessionId as string : undefined;
    const chatSessionId: string | undefined = paramConvId || bodyConvId;
    if (chatSessionId && chatSessionId !== "_") {
      log.warn(`session ${sessionId} not found — mapSize=${sessions.size} — reconstructing from chatSessionId=${chatSessionId}`);
      try {
        const { chatFileStorage } = await import("../chat-file-storage");
        const conv = await chatFileStorage.getSession(chatSessionId).catch(() => undefined);
        if (conv) {
          session = createVoiceSession(chatSessionId, undefined, sessionId, conv.sessionKey || undefined);
          log.debug(`session ${sessionId} reconstructed from DB — convId=${chatSessionId} chatSessionKey=${conv.sessionKey}`);
        }
      } catch (err: unknown) {
        log.warn(`session reconstruction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!session) {
    try {
      const { storage } = await import("../storage");
      const activeSessions = await storage.getActiveVoiceSessions(eventBus.bootId);
      if (activeSessions.length > 0) {
        const exactMatch = sessionId ? activeSessions.find(s => s.sessionId === sessionId) : undefined;
        const target = exactMatch || activeSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        log.debug(`DB fallback: found ${activeSessions.length} active session(s) in DB, ${exactMatch ? "exact match" : "using most recent"} sessionId=${target.sessionId} convId=${target.chatSessionId}`);
        session = sessions.get(target.sessionId) || null;
        if (!session && target.chatSessionId) {
          const { chatFileStorage } = await import("../chat-file-storage");
          const conv = await chatFileStorage.getSession(target.chatSessionId).catch(() => undefined);
          if (conv) {
            session = createVoiceSession(target.chatSessionId, undefined, target.sessionId, conv.sessionKey || undefined);
            log.debug(`DB fallback: reconstructed session ${target.sessionId} from DB row convId=${target.chatSessionId}`);
          }
        }
        if (!session) {
          session = createVoiceSession(target.chatSessionId || undefined, undefined, target.sessionId);
          log.debug(`DB fallback: created minimal session ${target.sessionId} (no chatSessionId or conversation not found)`);
        }
        sessionId = target.sessionId;
      }
    } catch (err: unknown) {
      log.warn(`DB session fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!session && sessions.size === 1) {
    const [onlyId, onlySession] = Array.from(sessions.entries())[0];
    log.debug(`single-session fallback: using only active session ${onlyId} (requested=${sessionId || "none"})`);
    session = onlySession;
    sessionId = onlyId;
  }

  if (!session && sessions.size === 0) {
    const POLL_INTERVAL = 200;
    const POLL_MAX = 3000;
    const pollStart = Date.now();
    log.debug(`wait-and-retry: no sessions in map, polling up to ${POLL_MAX}ms for session to appear`);
    while (Date.now() - pollStart < POLL_MAX) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      if (sessions.size > 0) {
        const [firstId, firstSession] = Array.from(sessions.entries())[0];
        log.debug(`wait-and-retry: session appeared after ${Date.now() - pollStart}ms — using ${firstId}`);
        session = firstSession;
        sessionId = firstId;
        break;
      }
    }
    if (!session) {
      log.warn(`wait-and-retry: no session appeared after ${Date.now() - pollStart}ms`);
    }
  }

  try {
    const resolvedKey = session?.chatSessionKey || `voice:${sessionId || "unknown"}`;
    const resolvedId = session?.chatSessionId || sessionId || "unknown";
    writeJournal({
      ts: Date.now(),
      type: session ? "tool_use_pause" : "error",
      sessionKey: resolvedKey,
      sessionId: resolvedId,
      source: "voice",
      content: session
        ? `voice_session_resolved: voiceSessionId=${sessionId} chatSessionId=${session.chatSessionId} mapSize=${sessions.size}`
        : `voice_session_resolved: FAILED sessionId=${sessionId || "none"} mapSize=${sessions.size}`,
      error: session ? undefined : `session resolution failed for sessionId=${sessionId || "none"}`,
    });
  } catch (journalErr: unknown) {
    log.warn(`voice journal write failed (voice_session_resolved): ${journalErr instanceof Error ? journalErr.message : String(journalErr)}`);
  }

  return { session, sessionId };
}
