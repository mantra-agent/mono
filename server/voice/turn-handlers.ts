/**
 * Voice turn result handlers — success, abort, error flows, and the
 * executor phase that wires the LLM agent into the voice pipeline.
 */
import type { Response } from "express";
import type { VoiceStreamChunkHandler } from "./turn-io";
import type { VoiceSession, TurnContext } from "./types";
import { agentExecutor } from "../agent-executor";
import { createToolExecutor } from "../tool-execution";
import { createVoiceMiddlewareStack, type VoiceToolContext } from "./tool-middleware";
import { ACTIVITY_VOICE } from "../job-profiles";
import { createThinkingFilter, createPassthroughThinkingFilter } from "./thinking-filter";
import { buildSSEChunk, isResponseAlive, sendSSEComment, sendErrorResponse } from "./sse";
import {
  writeVoiceJournal, publishVoiceEvent, publishVoiceDiagnostic, publishVoiceLifecycleEvent,
  voiceSessionKey, getActiveVoiceRunCount, acquireSessionTurnLock,
  traceInflightDoneResolved,
} from "./session";
import { persistAssistantMessage, persistVoiceErrorMessage, persistOrphanedTurnData } from "./persistence";
import { logPipelineStage, logTurnForensics, logTurnSummary } from "./pipeline-log";
import { getCascadeTimeoutMs } from "./turn-io";
import { CIRCUIT_BREAKER_WINDOW_MS } from "./circuit-breaker";
import { createLogger } from "../log";

const log = createLogger("VoiceTurn");

const VOICE_THINKING_ENABLED = false;
const VOICE_MAX_ITERATIONS = 5;
const BACKPRESSURE_DEAD_TIMEOUT_MS = 15_000;
const COALESCE_INTERVAL_MS = 80;
const SSE_KEEPALIVE_INTERVAL_MS = 5_000;

// ── handleSuccessfulTurn ─────────────────────────────────────────────────

export async function handleSuccessfulTurn(
  session: VoiceSession,
  ctx: TurnContext,
  result: Awaited<ReturnType<typeof agentExecutor.run>>,
  _conversationMessages: Array<{ role: string; content: string }>,
  currentTurn: number,
  systemPromptBytes: number,
  thinkingFilter: { getStats: () => { chars: number; ms: number } },
  trackedWrite: (data: string, label: string) => boolean,
  flushCoalesceBuffer: (trigger?: string, flush?: boolean) => void,
): Promise<void> {
  session.recentCancellations = session.recentCancellations.filter(
    ts => Date.now() - ts < CIRCUIT_BREAKER_WINDOW_MS,
  );

  thinkingFilter.getStats();
  const stats = thinkingFilter.getStats();
  ctx.thinkingSuppressedChars = stats.chars;
  ctx.thinkingSuppressedMs = stats.ms;

  flushCoalesceBuffer("turn_end", true);
  trackedWrite(buildSSEChunk(ctx.chatId, ctx.created, "", "stop"), "final_chunk");
  trackedWrite("data: [DONE]\n\n", "done");

  logTurnSummary(ctx, session, result, systemPromptBytes);
  const turnDuration = Date.now() - ctx.turnStart;
  publishVoiceDiagnostic(session, "turn_complete", `Turn ${currentTurn} done (${turnDuration}ms, ${ctx.chunkCounter.count} chunks, ${result.toolCalls.length} tools)`, { turn: currentTurn, elapsedMs: turnDuration }, ctx);

  // Success is the only path that commits and settles the visible attempt.
  await publishVoiceLifecycleEvent(session, "assistant_attempt_committed", {
    turnId: ctx.turnId,
    assistantAttemptId: ctx.assistantAttemptId,
    transcriptRevision: ctx.transcriptRevision,
    turn: currentTurn,
  });
  writeVoiceJournal(session, "done", { turnId: ctx.turnId });

  const assistantTimestamp = new Date(Date.now()).toISOString();
  await persistAssistantMessage(session, result.content || null, currentTurn, { assistantTimestamp }, ctx);
}

// ── handleAbortedTurn ────────────────────────────────────────────────────

export async function handleAbortedTurn(
  session: VoiceSession, ctx: TurnContext, currentTurn: number,
  trackedWrite: (data: string, label: string) => boolean, res: Response,
): Promise<void> {
  ctx.turnEndCause = "aborted_superseded";
  ctx.aborted = true;
  const abortElapsed = Date.now() - ctx.turnStart;
  log.log(`turn ${currentTurn} aborted after executor session=${session.id}`);
  logTurnForensics(ctx, session);
  publishVoiceDiagnostic(session, "turn_aborted", `Turn ${currentTurn} aborted (superseded, ${abortElapsed}ms)`, { turn: currentTurn, status: "error", elapsedMs: abortElapsed });
  await publishVoiceLifecycleEvent(session, "assistant_attempt_superseded", {
    turnId: ctx.turnId,
    assistantAttemptId: ctx.assistantAttemptId,
    transcriptRevision: ctx.transcriptRevision,
    turn: currentTurn,
  });

  await persistOrphanedTurnData(session, currentTurn, "ABORTED", ctx);
  trackedWrite("data: [DONE]\n\n", "done_aborted");
  res.end();
}

// ── handleTurnError ──────────────────────────────────────────────────────

export async function handleTurnError(
  err: Error, session: VoiceSession, ctx: TurnContext, currentTurn: number,
  turnAbort: AbortController, trackedWrite: (data: string, label: string) => boolean,
  res: Response, resolveDone: () => void,
): Promise<void> {
  if (turnAbort.signal.aborted) {
    ctx.turnEndCause = "cancelled_superseded";
    ctx.aborted = true;
    const cancelElapsed = Date.now() - ctx.turnStart;
    log.log(`turn ${currentTurn} cancelled (superseded) after ${cancelElapsed}ms session=${session.id}`);
    logTurnForensics(ctx, session);
    publishVoiceDiagnostic(session, "turn_cancelled", `Turn ${currentTurn} cancelled (superseded, ${cancelElapsed}ms)`, { turn: currentTurn, status: "error", elapsedMs: cancelElapsed });
    await publishVoiceLifecycleEvent(session, "assistant_attempt_superseded", {
      turnId: ctx.turnId,
      assistantAttemptId: ctx.assistantAttemptId,
      transcriptRevision: ctx.transcriptRevision,
      turn: currentTurn,
    });

    await persistOrphanedTurnData(session, currentTurn, "CANCELLED", ctx);
    if (res.headersSent) { trackedWrite("data: [DONE]\n\n", "done_cancelled"); res.end(); }
    else { res.status(200).end(); }
    traceInflightDoneResolved(session, "executeVoiceTurnBody.cancelledSuperseded", currentTurn);
    resolveDone();
    return;
  }

  const turnErrorElapsed = Date.now() - ctx.turnStart;
  ctx.turnEndCause = "error";
  logTurnForensics(ctx, session);
  writeVoiceJournal(session, "error", { error: `voice_turn_error: turn=${currentTurn} error=${err.message}` });
  publishVoiceDiagnostic(session, "turn_error", `Turn ${currentTurn} failed: ${err.message} (${turnErrorElapsed}ms)`, { turn: currentTurn, status: "error", elapsedMs: turnErrorElapsed });
  // Note: the "error" journal entry above also drives SessionManager.applyEvent
  // which handles the terminal event. No separate "done" needed here.
  persistVoiceErrorMessage(session, "I ran into a problem processing that. Could you try again?").catch((e: any) => log.debug(`persistVoiceErrorMessage failed session=${session.id}: ${e?.message}`));
  sendErrorResponse(res, trackedWrite, err, currentTurn, session.id, ctx.lastWrite, ctx.currentToolName);
}

// ── runExecutorPhase ─────────────────────────────────────────────────────

export interface ExecutorPhaseResult {
  result: Awaited<ReturnType<typeof agentExecutor.run>>;
  thinkingFilter: ReturnType<typeof createThinkingFilter>;
}

export async function runExecutorPhase(
  session: VoiceSession, ctx: TurnContext, currentTurn: number,
  executorMessages: import("../agent-executor").ExecutorMessage[], tools: import("../tool-registry").ToolSchema[], turnAbort: AbortController,
  pipelineStart: number, systemPromptBytes: number,
  sendChunk: VoiceStreamChunkHandler,
  flushCoalesceBuffer: (trigger?: string, flush?: boolean) => void,
  stopFillerTimer: (reason: string) => void,
  res: Response, trackedWrite: (data: string, label: string) => boolean,
): Promise<ExecutorPhaseResult> {
  const { getThinkingForActivity } = await import("../job-profiles");
  const tierThinking = getThinkingForActivity(ACTIVITY_VOICE);
  const voiceThinking: import("../thinking-config").ThinkingTierConfig = VOICE_THINKING_ENABLED
    ? tierThinking
    : { type: "disabled" };
  const thinkingActive = voiceThinking.type !== "disabled";
  const thinkingFilter = thinkingActive
    ? createThinkingFilter(sendChunk)
    : createPassthroughThinkingFilter(sendChunk);

  let coalesceTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!isResponseAlive(res)) {
      const elapsed = Date.now() - ctx.turnStart;
      log.warn(`TIMER_STOPPED_DEAD_RESPONSE location=coalesceTimer turn=${currentTurn} session=${session.id}`);
      publishVoiceDiagnostic(session, "coalesce_timer_dead", `Coalesce timer stopped — response dead (turn ${currentTurn}, ${elapsed}ms)`, { turn: currentTurn, status: "error", elapsedMs: elapsed });
      if (coalesceTimer) { clearInterval(coalesceTimer); coalesceTimer = null; }
      return;
    }
    if (ctx.bp.active) {
      if (ctx.bp.startedAt && Date.now() - ctx.bp.startedAt > BACKPRESSURE_DEAD_TIMEOUT_MS) {
        ctx.turnEndCause = "dead_connection";
        stopFillerTimer("dead_connection");
        const elapsed = Date.now() - ctx.turnStart;
        log.error(`turn ${currentTurn} DEAD_CONNECTION session=${session.id}`);
        publishVoiceDiagnostic(session, "dead_connection_abort", `LLM aborted — backpressure dead connection (turn ${currentTurn}, ${elapsed}ms)`, { turn: currentTurn, status: "error", elapsedMs: elapsed });
        turnAbort.abort();
        if (coalesceTimer) { clearInterval(coalesceTimer); coalesceTimer = null; }
      }
      return;
    }
    if (ctx.currentToolName && ctx.coalesceBuf.value && /[.!?]$/.test(ctx.coalesceBuf.value)) ctx.coalesceBuf.value += " ";
    flushCoalesceBuffer("timer");
  }, COALESCE_INTERVAL_MS);

  let keepaliveTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!isResponseAlive(res)) {
      const elapsed = Date.now() - ctx.turnStart;
      log.warn(`TIMER_STOPPED_DEAD_RESPONSE location=sseKeepaliveTimer turn=${currentTurn} session=${session.id}`);
      publishVoiceDiagnostic(session, "sse_keepalive_dead", `SSE keepalive stopped — response dead (turn ${currentTurn}, ${elapsed}ms)`, { turn: currentTurn, status: "error", elapsedMs: elapsed });
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      return;
    }
    sendSSEComment(res, "keepalive", session.id);
  }, SSE_KEEPALIVE_INTERVAL_MS);

  log.debug(`turn ${currentTurn} VOICE_DIAG systemPromptBytes=${systemPromptBytes} voiceRuns=${getActiveVoiceRunCount()} session=${session.id}`);
  // Publish thinking journal entry — drives SessionManager streaming projection
  // so clients see "Thinking" for voice turns just like text chat.
  writeVoiceJournal(session, "thinking", { content: "" });
  publishVoiceEvent(session, "voice_thinking", { turn: currentTurn });

  let toolStartAt: number | null = null;
  let executorResult: Awaited<ReturnType<typeof agentExecutor.run>>;

  const voiceToolCtx: VoiceToolContext = {
    voiceSessionId: session.id,
    chatSessionId: session.chatSessionId,
    chatSessionKey: session.chatSessionKey,
    originTurn: currentTurn,
    get toolCallIndex() { return ctx.toolCallIndex; },
    set toolCallIndex(v: number) { ctx.toolCallIndex = v; },
    onSessionEnd: (reason) => {
      session.ending = true;
      session.disconnectReason = `session_end:${reason}`;
    },
    onPromptInvalidate: () => {
      session.cachedSystemPrompt = null;
      session.cachedSystemPromptFocusKey = null;
      session.inflightContextPromise = null;
      session.inflightContextFocusKey = null;
    },
    onJournal: (type, extra) => writeVoiceJournal(session, type as import("../chat-journal").JournalEntryType, extra),
    onVoiceEvent: (event, payload) => publishVoiceEvent(session, event, payload),
    onToolCallComplete: async (name, args, result, callId) => {
      const releaseLock = await acquireSessionTurnLock(session.id);
      try {
        if (session.activeTurnNumber === currentTurn) {
          session.toolCalls.push({ name, args, result, callId, timestamp: new Date().toISOString() });
        } else {
          log.warn(`tool_result name=${name} callId=${callId} STALE_PUSH — originTurn=${currentTurn} activeTurn=${session.activeTurnNumber} — discarding from shared toolCalls`);
        }
      } finally {
        releaseLock();
      }
    },
  };
  const voiceToolExecutor = createToolExecutor(
    createVoiceMiddlewareStack(voiceToolCtx),
    {
      sessionKey: voiceSessionKey(session),
      sessionId: session.chatSessionId || undefined,
      voiceSessionId: session.id,
      activity: ACTIVITY_VOICE,
      runId: `voice-${session.id}-t${currentTurn}`,
    },
  );

  try {
    executorResult = await agentExecutor.run({
      sessionKey: voiceSessionKey(session),
      sessionId: session.chatSessionId || undefined,
      voiceSessionId: session.id,
      messages: executorMessages,
      tools,
      toolExecutor: voiceToolExecutor,
      activity: ACTIVITY_VOICE,
      thinking: voiceThinking,
      signal: turnAbort.signal,
      onEvent: (event) => {
        if (event.type === "ttft_breakdown") {
          const breakdown = (event as unknown as { breakdown: Record<string, unknown> }).breakdown;
          publishVoiceDiagnostic(
            session, "llm_ttft_breakdown",
            `TTFT breakdown firstSdkEvent=${breakdown.msToFirstSdkEvent ?? "n/a"}ms firstText=${breakdown.msToFirstTextDelta ?? "n/a"}ms thinking=${breakdown.thinkingSent ?? "?"}`,
            { turn: currentTurn, ...breakdown }, ctx,
          );
        }
        if (event.type === "delta" && event.content) {
          if (ctx.firstLlmDeltaAt === null) {
            ctx.firstLlmDeltaAt = Date.now();
            const llmTtft = ctx.firstLlmDeltaAt - ctx.turnStart;
            publishVoiceDiagnostic(session, "llm_first_delta", `TTFT ${llmTtft}ms`, { turn: currentTurn, elapsedMs: llmTtft }, ctx);
            logPipelineStage(ctx, session, "first_llm_delta", pipelineStart, `llmTtft=${llmTtft}ms`);
          }
          thinkingFilter.filteredSendChunk(event.content);
          // AgentExecutor already journals every emitted delta through its canonical
          // publish path. Republish here and SessionManager appends each token twice.
        }
        if (event.type === "tool_call") {
          const toolName = event.toolName || "?";
          if (ctx.coalesceBuf.value) {
            const endsClean = /[.!?]\s*$/.test(ctx.coalesceBuf.value);
            if (!endsClean && ctx.coalesceBuf.value.trim().length > 0) ctx.coalesceBuf.value += ". ";
            else if (endsClean && !/\s$/.test(ctx.coalesceBuf.value)) ctx.coalesceBuf.value += " ";
            flushCoalesceBuffer("pre_tool_call", true);
          }
          ctx.toolCallActive = true;
          toolStartAt = Date.now();
          ctx.currentToolName = toolName;
          ctx.currentToolStartAt = toolStartAt;
          ctx.segmentChronology.push({ s: "tool", i: ctx.toolCallChronologyCount });
          ctx.toolCallChronologyCount++;
          const predictedCallId = `voice-${session.id}-t${currentTurn}-${ctx.toolCallIndex}`;
          ctx.lastToolCallId = predictedCallId;
          log.debug(`turn ${currentTurn} tool_call name=${toolName} callId=${predictedCallId} executorCallId=${event.toolCallId || "?"} session=${session.id}`);
          // Publish tool_call to SessionManager so clients see tool activity
          writeVoiceJournal(session, "tool_call", {
            toolName,
            toolCallId: predictedCallId,
            narrative: (event as Record<string, unknown>).narrative as string | undefined,
          });
        }
        if (event.type === "tool_result") {
          const toolName = event.toolName || "?";
          const toolElapsed = toolStartAt !== null ? Date.now() - toolStartAt : -1;
          const callId = ctx.lastToolCallId || "?";
          log.debug(`turn ${currentTurn} tool_result name=${toolName} callId=${callId} executorCallId=${event.toolCallId || "?"} elapsed=${toolElapsed}ms session=${session.id}`);
          // Publish tool_result to SessionManager so clients see tool completion
          writeVoiceJournal(session, "tool_result", {
            toolName,
            toolCallId: callId,
            result: (event as Record<string, unknown>).result,
          });
          ctx.toolCallActive = false;
          toolStartAt = null;
          ctx.currentToolName = null;
          ctx.currentToolStartAt = null;
        }
        if (event.type === "tool_use_pause") {
          log.debug(`turn ${currentTurn} ITERATION_BOUNDARY chunks=${ctx.chunkCounter.count} bytes=${ctx.responseSize.total} session=${session.id}`);
        }
      },
    });
  } finally {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (coalesceTimer) { clearInterval(coalesceTimer); coalesceTimer = null; }
    stopFillerTimer("turn_end");
  }

  if (ctx.firstLlmDeltaAt === null) {
    log.warn(`turn ${currentTurn} TURN_PIPELINE stage=no_llm_delta elapsed=${Date.now() - pipelineStart}ms keepalivesSent=${ctx.keepalivesSent} session=${session.id}`);
    ctx.pipelineStagesEmitted.add("no_llm_delta");
  }

  return { result: executorResult!, thinkingFilter };
}
