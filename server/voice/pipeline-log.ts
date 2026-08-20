/**
 * Voice pipeline stage logging — turn forensics, completion summaries,
 * and expected-stage auditing for incident diagnosis.
 */
import type { VoiceSession, TurnContext } from "./types";
import { getActiveVoiceRunCount } from "./session";
import { createLogger } from "../log";
import { agentExecutor } from "../agent-executor";

const log = createLogger("VoicePipeline");

export const EXPECTED_PIPELINE_STAGES = [
  "callback_arrival",
  "ownership_lock_start",
  "ownership_lock_acquired",
  "build_messages_start",
  "build_messages_done",
  "persist_transcript_start",
  "persist_transcript_done",
  "register_lock_start",
  "register_lock_acquired",
  "inflight_registered",
  "context_prompt_start",
  "context_prompt_done",
  "writehead_sent",
  "executor_start",
  "first_llm_delta",
];

export function logPipelineStage(
  ctx: TurnContext,
  session: VoiceSession,
  stage: string,
  pipelineStart: number,
  extra: string = "",
): void {
  ctx.pipelineStagesEmitted.add(stage);
  log.debug(`turn ${ctx.currentTurn} TURN_PIPELINE stage=${stage} elapsed=${Date.now() - pipelineStart}ms${extra ? " " + extra : ""} session=${session.id}`);
}

export function logTurnForensics(ctx: TurnContext, session: VoiceSession): void {
  const now = Date.now();
  const elapsed = now - ctx.turnStart;
  const sinceLastContent = ctx.lastContentAt.ts !== null ? now - ctx.lastContentAt.ts : -1;
  const sinceLastReal = ctx.lastRealContentAt.ts !== null ? now - ctx.lastRealContentAt.ts : -1;
  const sinceLastContentSent = now - ctx.lastContentSentAt;
  const sinceLastWrite = now - ctx.lastWriteAt;
  const sinceSessionLastData = now - session.lastDataDeliveryAt;
  log.debug(`turn ${ctx.currentTurn} TURN_FORENSICS session=${session.id} cause=${ctx.turnEndCause} elapsed=${elapsed}ms chunks=${ctx.chunkCounter.count} bytes=${ctx.responseSize.total} firstContentAt=${ctx.firstChunk.sentAt !== null ? ctx.firstChunk.sentAt - ctx.turnStart : -1}ms firstRealContentAt=${ctx.firstRealContentAt.ts !== null ? ctx.firstRealContentAt.ts - ctx.turnStart : -1}ms lastRealContentAt=${ctx.lastRealContentAt.ts !== null ? ctx.lastRealContentAt.ts - ctx.turnStart : -1}ms sinceLastContent=${sinceLastContent}ms sinceLastReal=${sinceLastReal}ms sinceLastContentSent=${sinceLastContentSent}ms sinceLastWrite=${sinceLastWrite}ms sinceSessionLastData=${sinceSessionLastData}ms longestGap=${ctx.longestContentGapMs}ms longestSessionGap=${session.longestDataGapMs}ms fillerCount=${ctx.fillerCount} tool=${ctx.currentToolName || "none"} sessionChunksDelivered=${session.inflightChunksDelivered}`);
  if (ctx.turnEndCause === "aborted_superseded" || ctx.turnEndCause === "cancelled_superseded") {
    session.totalAbortedTurns++;
  } else if (ctx.chunkCounter.count > 0) {
    session.totalSuccessfulTurns++;
  }
}

export function logTurnSummary(
  ctx: TurnContext,
  session: VoiceSession,
  result: Awaited<ReturnType<typeof agentExecutor.run>>,
  systemPromptBytes: number,
): void {
  const turnDuration = Date.now() - ctx.turnStart;
  const firstChunkElapsed = ctx.firstChunk.sentAt !== null ? ctx.firstChunk.sentAt - ctx.turnStart : -1;
  const avgCharsPerFlush = ctx.coalesceFlushCount > 0 ? Math.round(ctx.responseSize.total / ctx.coalesceFlushCount) : 0;
  const llmTtft = ctx.firstLlmDeltaAt !== null ? ctx.firstLlmDeltaAt - ctx.turnStart : -1;
  const voiceRunCount = getActiveVoiceRunCount();
  log.log(`turn ${ctx.currentTurn} COMPLETE session=${session.id} duration=${turnDuration}ms model=${result.model} iterations=${result.iterations} tools=${result.toolCalls.length} chunks=${ctx.chunkCounter.count} responseSize=${ctx.responseSize.total} flushes=${ctx.coalesceFlushCount} avgCharsPerFlush=${avgCharsPerFlush} drainWaits=${ctx.bp.drainWaits} bpBytes=${ctx.bp.totalBytes} firstChunk=${firstChunkElapsed}ms llmTtft=${llmTtft}ms thinkingSuppressed=${ctx.thinkingSuppressedChars}chars/${ctx.thinkingSuppressedMs}ms fillers=${ctx.fillerCount} voiceRuns=${voiceRunCount} circuitBreaker=${session.circuitBreakerActive}`);
  logTurnForensics(ctx, session);
}
