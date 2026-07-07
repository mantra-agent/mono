/**
 * Voice-LLM orchestration layer.
 *
 * This file is the main entry point for the voice custom-LLM pipeline.
 * All domain logic has been decomposed into voice/ submodules:
 *   - voice/utils.ts          — text helpers, URL resolution
 *   - voice/session.ts        — session CRUD, health watchdog, turn locking
 *   - voice/sse.ts            — SSE stream primitives, orphan handling, lifecycle
 *   - voice/persistence.ts    — turn data persistence
 *   - voice/prompt.ts         — system prompt, conversation messages, tool list
 *   - voice/circuit-breaker.ts — circuit breaker, concurrency cap
 *   - voice/pipeline-log.ts   — pipeline stage logging, forensics
 *   - voice/turn-io.ts        — coalescing, backpressure, keepalive, stream chunks
 *   - voice/turn-handlers.ts  — success/abort/error handlers, executor phase
 *
 * This file retains only the orchestration functions:
 *   - handleCustomLLM()       — main entry point (session resolution + coalesce/cascade)
 *   - executeVoiceTurn()      — per-turn setup (abort, lock, circuit breaker, message build)
 *   - executeVoiceTurnBody()  — per-turn body (prompt, SSE init, executor, result handling)
 */
import type { Request, Response } from "express";
import { agentExecutor } from "./agent-executor";
import { createLogger } from "./log";
import { writeJournal } from "./chat-journal";
import { runWithPrincipal } from "./principal-context";

// ── Voice submodules ──────────────────────────────────────────────
import type { VoiceSession, VoiceMessage, VoiceToolCall, TurnContext } from "./voice/types";
import { createTurnContext } from "./voice/turn-context";

import {
  isWordLevelPrefixContinuation,
  contentHash,
  getPublicBaseUrl,
} from "./voice/utils";

import {
  getSessionMap,
  getActiveVoiceRunCount,
  voiceSessionKey,
  isSessionInflight,
  writeVoiceJournal,
  publishVoiceEvent,
  publishVoiceDiagnostic,
  traceInflightDoneResolved,
  createVoiceSession,
  getVoiceSession,
  findSessionForChat,
  endVoiceSession,
  endSessionsForChat,
  resumeVoiceSession,
  generateVoiceSessionId,
  touchVoiceSessionCallback,
  touchVoiceSessionByChat,
  reconcileDbVoiceState,
  resolveSession,
  acquireSessionTurnLock,
  isSessionTurnLocked,
  ABORT_WAIT_TIMEOUT_MS,
} from "./voice/session";

import {
  buildSSEChunk,
  isResponseAlive,
  sendSSEComment,
  initSSEStream,
  sendBriefAck,
  closeSSEWithError,
  sendErrorResponse,
  sendOrphanResponse,
  setupSSELifecycle,
} from "./voice/sse";

import { getVoiceUserOrdinal, getVoiceUserTurnKey, persistUserMessage } from "./voice/persistence";

import {
  buildChatContinuationSection,
  getSystemPrompt,
  getVoiceTools,
  buildConversationMessages,
  resolvePromptAndMessages,
  buildExecutorMessages,
} from "./voice/prompt";

import {
  checkCircuitBreaker,
  checkVoiceConcurrencyCap,
  hasActiveExecutorRun,
  waitForBlockerToClear,
  CB_MAX_RETRIES,
} from "./voice/circuit-breaker";

import { logPipelineStage, logTurnForensics } from "./voice/pipeline-log";
import { getCascadeTimeoutMs, createTurnIOHandlers, createStreamChunkHandler } from "./voice/turn-io";
import {
  handleSuccessfulTurn,
  handleAbortedTurn,
  handleTurnError,
  runExecutorPhase,
} from "./voice/turn-handlers";
import { persistVoiceErrorMessage } from "./voice/persistence";

// ── Backward-compat re-exports (external consumers import from voice-llm) ──
export type { VoiceSession, VoiceMessage, VoiceToolCall, TurnContext };
export {
  createVoiceSession,
  getVoiceSession,
  findSessionForChat,
  endVoiceSession,
  endSessionsForChat,
  resumeVoiceSession,
  generateVoiceSessionId,
  touchVoiceSessionCallback,
  touchVoiceSessionByChat,
  reconcileDbVoiceState,
  buildChatContinuationSection,
  getPublicBaseUrl,
};

const log = createLogger("VoiceLlm");

// ── Constants ─────────────────────────────────────────────────────
const PRE_CONTEXT_KEEPALIVE_INTERVAL_MS = 5_000;

// ══════════════════════════════════════════════════════════════════
// ORCHESTRATION
// ══════════════════════════════════════════════════════════════════

export async function handleCustomLLM(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown> | undefined;
  const bodyKeys = body ? Object.keys(body) : [];
  const paramSessionId = typeof req.params?.sessionId === "string" ? req.params.sessionId : undefined;
  const bodySessionId = typeof body?.sessionId === "string" ? body.sessionId as string : undefined;
  let sessionId: string | undefined = paramSessionId || bodySessionId;

  log.debug(`LLM callback entry — path=${req.path} paramSessionId=${paramSessionId || "none"} bodySessionId=${bodySessionId || "none"} bodyKeys=[${bodyKeys.join(",")}] mapSize=${getSessionMap().size}`);

  const resolved = await resolveSession(sessionId, body, req.params as Record<string, string>);
  let session = resolved.session;
  sessionId = resolved.sessionId;

  if (!session) {
    sendOrphanResponse(res, sessionId);
    return;
  }

  writeVoiceJournal(session, "tool_use_pause", {
    content: `voice_callback_received: path=${req.path} voiceSessionId=${session.id} turn=${session.turnCount + 1} mapSize=${getSessionMap().size}`,
  });

  const msSinceLastCallback = Date.now() - session.lastCallbackAt;
  session.lastCallbackAt = Date.now();

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    log.warn(`rejected: no messages array in body keys=${JSON.stringify(Object.keys(req.body || {}))}`);
    res.status(400).json({ error: "Invalid request: messages array required" });
    return;
  }

  const userMsgs = messages.filter((m: VoiceMessage) => m.role === "user");
  const lastUserContent = (userMsgs[userMsgs.length - 1]?.content || "").trim();
  const lastUserHash = contentHash(lastUserContent);
  const roleCounts = (messages as VoiceMessage[]).reduce((acc: Record<string, number>, m: VoiceMessage) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {});

  log.debug(`[TurnBoundary] callback arrived session=${sessionId} msSinceLastCallback=${msSinceLastCallback} turnCount=${session.turnCount} userMsgCount=${userMsgs.length} lastUserHash=${lastUserHash} roleCounts=${JSON.stringify(roleCounts)} lastUser="${lastUserContent.slice(0, 200)}" ts=${new Date().toISOString()}`);

  const callbackArrivalAt = Date.now();
  const prevFired = session.lastFiredUserContent;
  session.lastFiredUserContent = lastUserContent;
  const isPrefixContinuation = isWordLevelPrefixContinuation(prevFired, lastUserContent);
  if (isPrefixContinuation) {
    log.debug(`[TurnBoundary] prefix continuation of previous turn session=${sessionId} prevLen=${prevFired.length} newLen=${lastUserContent.length} — treating as seamless continuation`);
    session.prefixContinuation = true;

    if (session.inflightAbort && session.inflightTurn > 0) {
      const prefixDiff = lastUserContent.slice(prevFired.length);
      const lockHeld = isSessionTurnLocked(session.id);
      const executorAlreadyStarted = session.executorStarted;
      log.debug(`[TurnCoalesce] COALESCED callback — inflight turn=${session.inflightTurn} chunksDelivered=${session.inflightChunksDelivered} executorStarted=${executorAlreadyStarted} lockHeld=${lockHeld} prefixDiff="${prefixDiff.slice(0, 100)}" session=${sessionId}`);

      publishVoiceDiagnostic(session, "coalesce_detected", `User continued speaking — merging transcript (${prevFired.length}→${lastUserContent.length} chars)`, { turn: session.turnCount, status: "done" });

      if (lastUserContent && session.chatSessionId) {
        try {
          await persistUserMessage(session, messages as Array<{ role: string; content: string }>, session.turnCount, new Date().toISOString());
          log.debug(`[TurnCoalesce] COALESCE_PERSIST — upserted extended transcript to DB session=${sessionId}`);
        } catch (persistErr: unknown) {
          const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
          log.warn(`[TurnCoalesce] COALESCE_PERSIST failed: ${msg} session=${sessionId}`);
          publishVoiceDiagnostic(session, "coalesce_persist_failed", `Failed to persist extended transcript: ${msg}`, { turn: session.turnCount, status: "error" });
        }
      }

      if (lastUserContent) {
        publishVoiceEvent(session, "voice_user_transcript", {
            text: lastUserContent,
            turn: session.turnCount,
            turnKey: getVoiceUserTurnKey(session, getVoiceUserOrdinal(messages as Array<{ role: string; content: string }>)),
            update: true,
          });
      }

      if (executorAlreadyStarted) {
        log.debug(`[TurnCoalesce] COALESCE_ABORT — executor already started, aborting inflight turn ${session.inflightTurn} to restart with full transcript session=${sessionId}`);
        publishVoiceDiagnostic(session, "coalesce_abort_restart", `Aborting response to incomplete transcript — restarting with full message`, { turn: session.turnCount, status: "done" });

        const releaseLock = await acquireSessionTurnLock(session.id);
        try {
          session.pendingTranscriptUpdate = null;
          session.prefixContinuation = true;
        } finally {
          releaseLock();
        }
      } else {
        const releaseLock = await acquireSessionTurnLock(session.id);
        try {
          session.pendingTranscriptUpdate = messages;
        } finally {
          releaseLock();
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const chatId = `chatcmpl-coalesced-${sessionId}`;
        const created = Math.floor(Date.now() / 1000);
        const finish = buildSSEChunk(chatId, created, "", "stop");
        try { res.write(finish); res.write("data: [DONE]\n\n"); } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); log.warn(`SSE_WRITE_FAILED location=turn_coalesce session=${sessionId} error=${msg}`); }
        res.end();
        return;
      }
    }
  } else {
    session.prefixContinuation = false;
  }

  const isCascadeRetry = !isPrefixContinuation
    && lastUserContent === prevFired
    && lastUserContent.length > 0
    && session.inflightAbort !== null
    && session.inflightTurn > 0
    && !session.inflightAbort.signal.aborted;

  if (isCascadeRetry) {
    log.warn(`[CascadeRetry] CASCADE_RETRY_DETECTED session=${sessionId} inflightTurn=${session.inflightTurn} userHash=${lastUserHash} content="${lastUserContent.slice(0, 80)}" — NOT aborting in-flight turn, serving keepalive until real turn completes`);
    publishVoiceDiagnostic(session, "cascade_retry", `ElevenLabs cascade retry detected — waiting for inflight turn ${session.inflightTurn}`, { turn: session.turnCount, status: "done" });
    session.lastFiredUserContent = prevFired;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (res.socket) res.socket.setNoDelay(true);
    sendSSEComment(res, "keepalive", sessionId);

    const retryKeepaliveTimer = setInterval(() => {
      if (!isResponseAlive(res)) {
        clearInterval(retryKeepaliveTimer);
        log.warn(`[CascadeRetry] KEEPALIVE_STOPPED response_dead session=${sessionId}`);
        return;
      }
      sendSSEComment(res, "keepalive", sessionId);
    }, PRE_CONTEXT_KEEPALIVE_INTERVAL_MS);

    const inflightDone = session.inflightDone;
    const maxRetryWaitMs = getCascadeTimeoutMs() * 3;
    const retryTimeout = new Promise<void>(resolve => setTimeout(resolve, maxRetryWaitMs));

    (inflightDone ? Promise.race([inflightDone, retryTimeout]) : retryTimeout).then(() => {
      clearInterval(retryKeepaliveTimer);
      if (isResponseAlive(res)) {
        const chatId = `chatcmpl-cascade-retry-${sessionId}`;
        const created = Math.floor(Date.now() / 1000);
        try {
          res.write(buildSSEChunk(chatId, created, "", "stop"));
          res.write("data: [DONE]\n\n");
        } catch (e: any) { log.warn(`SSE_WRITE_FAILED location=cascade_retry_close session=${sessionId} error=${e?.message}`); }
        res.end();
      }
      log.debug(`[CascadeRetry] CASCADE_RETRY_CLOSED session=${sessionId} — retry response terminated`);
    }).catch((err: any) => {
      clearInterval(retryKeepaliveTimer);
      log.warn(`[CascadeRetry] CASCADE_RETRY_ERROR session=${sessionId}: ${err?.message || String(err)}`);
      try { if (isResponseAlive(res)) res.end(); } catch (e: any) { log.warn(`SSE_WRITE_FAILED location=cascade_retry_cleanup session=${sessionId} error=${e?.message}`); }
    });
    return;
  }

  if (lastUserContent) {
    publishVoiceEvent(session, "voice_user_transcript", {
      text: lastUserContent,
      turn: session.turnCount,
      turnKey: getVoiceUserTurnKey(session, getVoiceUserOrdinal(messages as Array<{ role: string; content: string }>)),
      update: isPrefixContinuation,
    });
  }

  const turnRunner = () => executeVoiceTurn(req, res, session, callbackArrivalAt);
  const turnPromise = session.principal
    ? runWithPrincipal(session.principal, turnRunner)
    : turnRunner();
  turnPromise.catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`UNCAUGHT_TURN_ERROR session=${sessionId} err=${JSON.stringify(err, Object.getOwnPropertyNames(err))} headersSent=${res.headersSent} writableEnded=${res.writableEnded} destroyed=${res.destroyed}`);
    publishVoiceDiagnostic(session, "turn_error", `Uncaught turn error: ${errMsg}`, { status: "error", turn: session.turnCount });
    try {
      if (!res.headersSent) {
        log.warn(`UNCAUGHT_NON_SSE session=${sessionId} — responding with JSON 500 instead of SSE`);
        res.status(500).json({ error: "Internal voice processing error" });
      } else if (!res.writableEnded) {
        try { res.write("data: [DONE]\n\n"); } catch (e: any) { log.warn(`SSE_WRITE_FAILED location=uncaught_turn_error session=${sessionId} error=${e?.message}`); }
        res.end();
      }
    } catch (cleanupErr: any) {
      log.error(`response cleanup failed session=${sessionId}: ${cleanupErr.message}`);
    }
  });
}

async function executeVoiceTurn(req: Request, res: Response, session: VoiceSession, callbackArrivalAt?: number): Promise<void> {
  const pipelineStart = callbackArrivalAt || Date.now();
  const { messages } = req.body;

  session.turnCount++;
  const currentTurn = session.turnCount;
  const userMsgs = messages.filter((m: VoiceMessage) => m.role === "user");
  const lastUserContentFull = (userMsgs[userMsgs.length - 1]?.content || "").trim() || "(none)";
  const lastUserContent = lastUserContentFull.slice(0, 200);
  const sinceLastDataDelivery = Date.now() - session.lastDataDeliveryAt;
  log.debug(`turn ${currentTurn} START session=${session.id} messages=${messages.length} userMsgs=${userMsgs.length} lastUser="${lastUserContent}" sessionAge=${Date.now() - session.startedAt}ms voiceRuns=${getActiveVoiceRunCount()} sinceLastDataDelivery=${sinceLastDataDelivery}ms`);

  // Register with server-authoritative SessionManager (migration: both paths active)
  if (session.chatSessionId) {
    try {
      const { sessionManager } = await import("./session-manager");
      const voiceSessionKey = session.chatSessionKey || session.chatSessionId;
      sessionManager.registerSession(session.chatSessionId, voiceSessionKey, "voice");
    } catch (regErr) {
      log.debug(`sessionManager.registerSession skipped: ${regErr instanceof Error ? regErr.message : String(regErr)}`);
    }
  }
  publishVoiceDiagnostic(session, "turn_boundary", `Turn ${currentTurn}: "${lastUserContent.slice(0, 40)}…"`, { turn: currentTurn });
  log.debug(`turn ${currentTurn} TURN_PIPELINE stage=callback_arrival elapsed=0ms session=${session.id}`);

  const { withQueryAttributionAsync, pool } = await import("./db");

  log.debug(
    `turn ${currentTurn} DB_POOL total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount} session=${session.id}`
  );
  if (pool.waitingCount > 3) {
    log.warn(
      `turn ${currentTurn} DB_POOL_PRESSURE waiting=${pool.waitingCount} — voice turn may stall on DB access session=${session.id}`
    );
    publishVoiceDiagnostic(session, "db_pool_pressure", `DB pool pressure (waiting=${pool.waitingCount})`, { turn: currentTurn, status: "error" });
  }

  await withQueryAttributionAsync("voice", async () => {
    let hadInflight = false;
    let pendingInflightDone: Promise<void> | null = null;

    {
      const lockAcquireStart = Date.now();
      log.debug(`turn ${currentTurn} TURN_PIPELINE stage=ownership_lock_start elapsed=${lockAcquireStart - pipelineStart}ms session=${session.id}`);
      const releaseLock = await acquireSessionTurnLock(session.id);
      log.debug(`turn ${currentTurn} TURN_PIPELINE stage=ownership_lock_acquired elapsed=${Date.now() - pipelineStart}ms lockWait=${Date.now() - lockAcquireStart}ms session=${session.id}`);
      try {
        hadInflight = !!(session.inflightAbort && session.inflightTurn < currentTurn);
        if (hadInflight && session.inflightAbort) {
          log.debug(`turn ${currentTurn} TURN_PIPELINE stage=abort_old_turn elapsed=${Date.now() - pipelineStart}ms oldTurn=${session.inflightTurn} session=${session.id}`);
          session.inflightAbort.abort();
          pendingInflightDone = session.inflightDone;
        }
        session.activeTurnNumber = currentTurn;
      } finally {
        releaseLock();
      }
    }

    if (pendingInflightDone) {
      log.debug(`turn ${currentTurn} TURN_PIPELINE stage=inflight_wait_start elapsed=${Date.now() - pipelineStart}ms session=${session.id}`);
      publishVoiceDiagnostic(session, "abort_wait", `Waiting for previous turn to exit`, { turn: currentTurn, status: "active" });
      const waitStart = Date.now();
      const timedOut = await Promise.race([
        pendingInflightDone.then(() => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(true), ABORT_WAIT_TIMEOUT_MS)),
      ]);
      const waitMs = Date.now() - waitStart;
      publishVoiceDiagnostic(session, "abort_wait", `Previous turn ${timedOut ? "force-killed" : "exited"} (${waitMs}ms)`, { turn: currentTurn, status: timedOut ? "error" : "done", elapsedMs: waitMs });
      if (timedOut) {
        log.warn(`turn ${currentTurn} old turn did NOT exit within ${ABORT_WAIT_TIMEOUT_MS}ms — force-killing session=${session.id}`);
        const killResult = agentExecutor.abortVoiceSession(
          session.chatSessionId || "",
          voiceSessionKey(session),
        );
        log.debug(`turn ${currentTurn} abortVoiceSession result: aborted=${killResult.aborted} runsKilled=${killResult.runsKilled} session=${session.id}`);
        if (session.inflightDoneResolve) {
          traceInflightDoneResolved(session, "newTurnPreemption", currentTurn);
          session.inflightDoneResolve();
        }
        session.inflightAbort = null;
        session.inflightTurn = 0;
        session.inflightDone = null;
        session.inflightDoneResolve = null;
        const stillActive = hasActiveExecutorRun(session);
        if (stillActive) {
          log.warn(`turn ${currentTurn} ZOMBIE_BLOCKED — attempting inline recovery session=${session.id}`);
          publishVoiceDiagnostic(session, "zombie_blocked", `Zombie blocked — attempting recovery`, { turn: currentTurn, status: "active" });
          sendBriefAck(res, `chatcmpl-${session.id}-${currentTurn}`, Math.floor(Date.now() / 1000), { closeResponse: false, reason: "zombie_blocked" });
          const cleared = await waitForBlockerToClear(session, currentTurn, "zombie_blocked");
          if (!cleared) {
            log.error(`turn ${currentTurn} ZOMBIE_BLOCKED — recovery failed session=${session.id}`);
            publishVoiceDiagnostic(session, "zombie_failed", `Zombie blocked — recovery failed`, { turn: currentTurn, status: "error" });
            closeSSEWithError(res, session, currentTurn, "I'm having trouble processing right now. Could you try again?");
            persistVoiceErrorMessage(session, "Voice processing was blocked by a stuck operation. Please try again.").catch((e: unknown) => log.debug(`persistVoiceErrorMessage failed session=${session.id}: ${e instanceof Error ? e.message : String(e)}`));
            writeVoiceJournal(session, "error", { error: `voice_circuit_breaker: turn=${currentTurn} reason=zombie_blocked — recovery failed after ${CB_MAX_RETRIES} retries` });
            return;
          }
          log.debug(`turn ${currentTurn} ZOMBIE_RECOVERED — proceeding session=${session.id}`);
          publishVoiceDiagnostic(session, "zombie_recovered", `Zombie blocked — recovered`, { turn: currentTurn });
        }
      } else {
        log.debug(`turn ${currentTurn} old turn exited cleanly in ${waitMs}ms session=${session.id}`);
      }
      log.debug(`turn ${currentTurn} TURN_PIPELINE stage=inflight_wait_done elapsed=${Date.now() - pipelineStart}ms session=${session.id}`);
    }
    if (hadInflight && !session.prefixContinuation) {
      session.recentCancellations.push(Date.now());
    }

    log.debug(`turn ${currentTurn} TURN_PIPELINE stage=build_messages_start elapsed=${Date.now() - pipelineStart}ms session=${session.id}`);
    let conversationMessages = await buildConversationMessages(messages, session, currentTurn);
    log.debug(`turn ${currentTurn} TURN_PIPELINE stage=build_messages_done elapsed=${Date.now() - pipelineStart}ms msgCount=${conversationMessages.length} session=${session.id}`);

    if (conversationMessages.length === 0) {
      log.warn(`turn ${currentTurn} no user messages after filtering, skipping`);
      if (res.headersSent) { closeSSEWithError(res, session, currentTurn, ""); } else { res.status(200).end(); }
      return;
    }

    log.debug(`turn ${currentTurn} TURN_PIPELINE stage=persist_transcript_start elapsed=${Date.now() - pipelineStart}ms session=${session.id}`);
    await persistUserMessage(session, conversationMessages, currentTurn, new Date(session.lastCallbackAt).toISOString());
    log.debug(`turn ${currentTurn} TURN_PIPELINE stage=persist_transcript_done elapsed=${Date.now() - pipelineStart}ms session=${session.id}`);

    if (checkCircuitBreaker(session, currentTurn)) {
      log.warn(`turn ${currentTurn} CIRCUIT_BREAKER — attempting inline recovery session=${session.id}`);
      publishVoiceDiagnostic(session, "circuit_breaker", `Circuit breaker triggered — waiting for recovery`, { turn: currentTurn, status: "active" });
      if (!res.headersSent) sendBriefAck(res, `chatcmpl-${session.id}-${currentTurn}`, Math.floor(Date.now() / 1000), { closeResponse: false, reason: "circuit_breaker" });
      const cleared = await waitForBlockerToClear(session, currentTurn, "circuit_breaker");
      if (!cleared) {
        publishVoiceDiagnostic(session, "circuit_breaker", `Circuit breaker recovery failed`, { turn: currentTurn, status: "error" });
        closeSSEWithError(res, session, currentTurn, "I need a moment. Could you say that again?");
        persistVoiceErrorMessage(session, "Voice processing was throttled by the circuit breaker. Please try again.").catch((e: unknown) => log.debug(`persistVoiceErrorMessage failed session=${session.id}: ${e instanceof Error ? e.message : String(e)}`));
        writeVoiceJournal(session, "error", { error: `voice_circuit_breaker: turn=${currentTurn} reason=circuit_breaker — recovery failed` });
        return;
      }
      publishVoiceDiagnostic(session, "circuit_breaker", `Circuit breaker cleared`, { turn: currentTurn });
      log.debug(`turn ${currentTurn} CIRCUIT_BREAKER_RECOVERED — proceeding with turn session=${session.id}`);
    }

    if (checkVoiceConcurrencyCap()) {
      log.warn(`turn ${currentTurn} CONCURRENCY_CAP — attempting inline recovery session=${session.id}`);
      publishVoiceDiagnostic(session, "concurrency_cap", `Concurrency cap hit — waiting for recovery`, { turn: currentTurn, status: "active" });
      if (!res.headersSent) sendBriefAck(res, `chatcmpl-${session.id}-${currentTurn}`, Math.floor(Date.now() / 1000), { closeResponse: false, reason: "concurrency_cap" });
      const cleared = await waitForBlockerToClear(session, currentTurn, "concurrency_cap");
      if (!cleared) {
        publishVoiceDiagnostic(session, "concurrency_cap_failed", `Concurrency cap recovery failed`, { turn: currentTurn, status: "error" });
        closeSSEWithError(res, session, currentTurn, "Too many active conversations right now. Please try again shortly.");
        persistVoiceErrorMessage(session, "Voice processing hit the concurrency limit. Please try again.").catch((e: unknown) => log.debug(`persistVoiceErrorMessage failed session=${session.id}: ${e instanceof Error ? e.message : String(e)}`));
        writeVoiceJournal(session, "error", { error: `voice_circuit_breaker: turn=${currentTurn} reason=concurrency_cap — recovery failed` });
        return;
      }
      log.debug(`turn ${currentTurn} CONCURRENCY_RECOVERED — proceeding with turn session=${session.id}`);
      publishVoiceDiagnostic(session, "concurrency_cap_recovered", `Concurrency cap cleared`, { turn: currentTurn });
    }

    if (session.activeTurnNumber !== currentTurn) {
      log.warn(`turn ${currentTurn} SUPERSEDED by turn ${session.activeTurnNumber} during setup — aborting session=${session.id}`);
      publishVoiceDiagnostic(session, "turn_superseded", `Turn ${currentTurn} superseded by turn ${session.activeTurnNumber}`, { turn: currentTurn, status: "error" });
      if (res.headersSent) { closeSSEWithError(res, session, currentTurn, ""); } else { res.status(200).end(); }
      return;
    }

    {
      const lockAcquireStart = Date.now();
      log.debug(`turn ${currentTurn} TURN_PIPELINE stage=register_lock_start elapsed=${lockAcquireStart - pipelineStart}ms session=${session.id}`);
      const releaseLock = await acquireSessionTurnLock(session.id);
      log.debug(`turn ${currentTurn} TURN_PIPELINE stage=register_lock_acquired elapsed=${Date.now() - pipelineStart}ms lockWait=${Date.now() - lockAcquireStart}ms session=${session.id}`);

      let turnAbort: AbortController;
      let ctx: TurnContext;
      let resolveDone: () => void = () => {};

      try {
        if (session.activeTurnNumber !== currentTurn) {
          log.warn(`turn ${currentTurn} SUPERSEDED at registration by turn ${session.activeTurnNumber} — aborting session=${session.id}`);
          publishVoiceDiagnostic(session, "turn_superseded", `Turn ${currentTurn} superseded by turn ${session.activeTurnNumber} at registration`, { turn: currentTurn, status: "error" });
          if (res.headersSent) { closeSSEWithError(res, session, currentTurn, ""); } else { res.status(200).end(); }
          return;
        }
        turnAbort = new AbortController();
        ctx = createTurnContext(session, turnAbort);
        ctx.systemSteps.push({ name: "voice_turn_boundary", status: "done", detail: `Turn ${currentTurn}` });
        ctx.segmentChronology.push({ s: "system", i: ctx.systemSteps.length - 1 });
        session.inflightAbort = turnAbort;
        session.inflightTurn = currentTurn;
        session.inflightChunksDelivered = 0;
        session.executorStarted = false;
        session.inflightDone = new Promise<void>((resolve) => { resolveDone = resolve; });
        session.inflightDoneResolve = resolveDone;
        log.debug(`turn ${currentTurn} INFLIGHT_REGISTERED session=${session.id} — releasing turn lock`);
        for (const s of [
          "callback_arrival",
          "ownership_lock_start",
          "ownership_lock_acquired",
          "build_messages_start",
          "build_messages_done",
          "persist_transcript_start",
          "persist_transcript_done",
          "register_lock_start",
          "register_lock_acquired",
        ]) ctx.pipelineStagesEmitted.add(s);
        logPipelineStage(ctx, session, "inflight_registered", pipelineStart);
      } finally {
        releaseLock();
      }

      await executeVoiceTurnBody(req, res, session, messages, conversationMessages, currentTurn, turnAbort!, resolveDone, pipelineStart, ctx!);
    }
  }, `turn-${currentTurn}`);
}

async function executeVoiceTurnBody(
  req: Request, res: Response, session: VoiceSession,
  messages: VoiceMessage[], inputConversationMessages: Array<{ role: string; content: string }>,
  currentTurn: number, turnAbort: AbortController, resolveDone: () => void,
  pipelineStart?: number, ctx?: TurnContext,
): Promise<void> {
  let conversationMessages = inputConversationMessages;
  const _pipelineStart = pipelineStart || Date.now();
  import("./storage").then(({ storage }) =>
    storage.updateVoiceSessionInflight(session.id, currentTurn)
      .then(() => log.debug(`turn ${currentTurn} DB_INFLIGHT_SET session=${session.id}`))
      .catch((dbErr: unknown) => log.warn(`turn ${currentTurn} DB_INFLIGHT_SET failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`))
  ).catch((importErr: unknown) => log.warn(`turn ${currentTurn} DB_INFLIGHT_SET import failed: ${importErr instanceof Error ? importErr.message : String(importErr)}`));
  if (!ctx) ctx = createTurnContext(session, turnAbort);
  logPipelineStage(ctx, session, "context_prompt_start", _pipelineStart);

  publishVoiceDiagnostic(session, "context_assembly", "Building system prompt…", { turn: currentTurn, status: "active" }, ctx);

  const io = createTurnIOHandlers(res, ctx, session, currentTurn);
  const { trackedWrite, stopFillerTimer, flushCoalesceBuffer, startKeepaliveTimer } = io;

  setupSSELifecycle(req, res, session, ctx, trackedWrite, flushCoalesceBuffer, stopFillerTimer, turnAbort, getCascadeTimeoutMs);

  try {
    if (turnAbort.signal.aborted) {
      log.debug(`turn ${currentTurn} already aborted before start session=${session.id}`);
      if (res.headersSent) { res.end(); } else { res.status(200).end(); }
      return;
    }

    const resolved = await resolvePromptAndMessages(session, conversationMessages, currentTurn, _pipelineStart, ctx, res, turnAbort);
    const { systemPrompt, systemPromptBytes } = resolved;
    conversationMessages = resolved.finalMessages;

    const executorMessages = buildExecutorMessages(systemPrompt, conversationMessages);
    const tools = getVoiceTools();

    initSSEStream(res, ctx, trackedWrite, _pipelineStart, currentTurn, session.id);
    startKeepaliveTimer();
    session.executorStarted = true;
    logPipelineStage(ctx, session, "executor_start", _pipelineStart);

    const sendChunk = createStreamChunkHandler(res, ctx, session, currentTurn, flushCoalesceBuffer);

    const { result, thinkingFilter } = await runExecutorPhase(
      session, ctx, currentTurn, executorMessages, tools, turnAbort,
      _pipelineStart, systemPromptBytes, sendChunk, flushCoalesceBuffer,
      stopFillerTimer, res, trackedWrite,
    );

    if (turnAbort.signal.aborted) {
      await handleAbortedTurn(session, ctx, currentTurn, trackedWrite, res);
      return;
    }

    thinkingFilter.finalize();
    await handleSuccessfulTurn(session, ctx, result, conversationMessages, currentTurn, systemPromptBytes, thinkingFilter, trackedWrite, flushCoalesceBuffer);
    res.end();

  } catch (err: unknown) {
    await handleTurnError(err instanceof Error ? err : new Error(String(err)), session, ctx, currentTurn, turnAbort, trackedWrite, res, resolveDone);
  } finally {
    // Finalize server-authoritative SessionManager (migration: both paths active)
    if (session.chatSessionId) {
      try {
        const { sessionManager } = await import("./session-manager");
        sessionManager.finalizeSession(session.chatSessionId);
      } catch (finErr) {
        log.debug(`sessionManager.finalizeSession skipped: ${finErr instanceof Error ? finErr.message : String(finErr)}`);
      }
    }

    traceInflightDoneResolved(session, "executeVoiceTurnBody.finally", currentTurn, {
      cause: ctx.turnEndCause || "natural",
    });
    resolveDone();
    if (session.inflightTurn === currentTurn) {
      session.inflightAbort = null;
      session.inflightTurn = 0;
    }
    try {
      const { storage } = await import("./storage");
      await storage.clearVoiceSessionInflight(session.id);
      log.debug(`turn ${currentTurn} DB_INFLIGHT_CLEAR session=${session.id}`);
    } catch (dbErr: unknown) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.warn(`turn ${currentTurn} DB_INFLIGHT_CLEAR failed: ${msg}`);
    }
  }
}
