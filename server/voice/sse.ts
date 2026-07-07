/**
 * Voice SSE response helpers — chunk building, keepalive, backpressure
 * detection, error responses, and stream lifecycle.
 */
import type { Response } from "express";
import type { Request } from "express";
import type { SSEWriteState, BackpressureState, TurnContext, VoiceSession } from "./types";
import { getSessionMap, publishVoiceDiagnostic } from "./session";
import { writeJournal } from "../chat-journal";
import { createLogger } from "../log";

const log = createLogger("VoiceLlm");

// ── SSE Chunk Building ───────────────────────────────────────────────────

export function buildSSEChunk(
  chatId: string,
  created: number,
  content: string,
  finishReason: string | null = null,
  flush: boolean = false,
): string {
  const delta: Record<string, unknown> = finishReason ? {} : { content };
  if (flush && !finishReason) delta.flush = true;
  const chunk = {
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model: "xyz-voice",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── Response State Helpers ───────────────────────────────────────────────

export function isResponseAlive(res: Response): boolean {
  return !res.writableEnded && !res.destroyed;
}

export function sendSSEComment(res: Response, label: string, sessionId?: string): void {
  try {
    res.write(`: ${label}\n\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`sendSSEComment failed label=${label} writableEnded=${res.writableEnded} destroyed=${res.destroyed} session=${sessionId || "unknown"} err=${msg}`);
  }
}

// ── SSE Stream Initialization ────────────────────────────────────────────

export function initSSEStream(
  res: Response,
  ctx: TurnContext,
  trackedWrite: (data: string, label: string) => boolean,
  pipelineStart: number,
  currentTurn: number,
  sessionId: string,
): void {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }
  if (res.socket) res.socket.setNoDelay(true);
  ctx.pipelineStagesEmitted.add("writehead_sent");
  log.log(`turn ${currentTurn} TURN_PIPELINE stage=writehead_sent elapsed=${Date.now() - pipelineStart}ms session=${sessionId}`);

  if (!ctx.firstChunk.sentAt) {
    const roleChunk = {
      id: ctx.chatId, object: "chat.completion.chunk", created: ctx.created, model: "xyz-voice",
      choices: [{ index: 0, delta: { role: "assistant", content: " " }, finish_reason: null }],
    };
    trackedWrite(`data: ${JSON.stringify(roleChunk)}\n\n`, "role_chunk");
  }
}

// ── Brief Ack ────────────────────────────────────────────────────────────

export function sendBriefAck(
  res: Response,
  chatId: string,
  created: number,
  opts: { closeResponse: boolean; reason: string },
): boolean {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }
  const bufferWord = "... ";
  const contentChunk = buildSSEChunk(chatId, created, bufferWord);
  let ok = true;
  try {
    res.write(contentChunk);
    if (opts.closeResponse) {
      res.write(buildSSEChunk(chatId, created, "", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`sendBriefAck SSE write failed (reason=${opts.reason} close=${opts.closeResponse}): ${msg}`);
    ok = false;
  }
  log.debug(`BRIEF_ACK reason=${opts.reason} close=${opts.closeResponse} ok=${ok}`);
  return ok;
}

// ── Error Responses ──────────────────────────────────────────────────────

export function closeSSEWithError(
  res: Response,
  session: VoiceSession,
  currentTurn: number,
  errorMsg: string,
): void {
  const chatId = `chatcmpl-${session.id}-${currentTurn}`;
  const created = Math.floor(Date.now() / 1000);
  const errChunk = buildSSEChunk(chatId, created, ` ${errorMsg}`);
  const finish = buildSSEChunk(chatId, created, "", "stop");
  try {
    res.write(errChunk);
    res.write(finish);
    res.write("data: [DONE]\n\n");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`closeSSEWithError write failed: ${msg}`);
  }
  res.end();
}

export function sendErrorResponse(
  res: Response,
  trackedWrite: (data: string, label: string) => boolean,
  err: unknown,
  currentTurn: number,
  sessionId: string,
  lastWrite: SSEWriteState,
  currentToolName: string | null,
): void {
  const errObj = err instanceof Error ? err : new Error(String(err));
  log.error(`TURN_ERROR turn=${currentTurn} err=${JSON.stringify(errObj, Object.getOwnPropertyNames(errObj))} headersSent=${res.headersSent} writableEnded=${res.writableEnded} destroyed=${res.destroyed} lastWrite=#${lastWrite.index} lastOk=${lastWrite.ok} tool=${currentToolName || "none"} session=${sessionId}`);

  if (res.headersSent) {
    const errorChunk = {
      id: "chatcmpl-error",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "xyz-voice",
      choices: [{ index: 0, delta: { content: "... " }, finish_reason: "stop" }],
    };
    trackedWrite(`data: ${JSON.stringify(errorChunk)}\n\n`, "error_chunk");
    trackedWrite("data: [DONE]\n\n", "done_error");
    res.end();
  } else {
    log.warn(`TURN_ERROR_NON_SSE turn=${currentTurn} — responding with JSON 500 instead of SSE`);
    res.status(500).json({ error: errObj.message });
  }
}

// ── Tracked Write Factory ────────────────────────────────────────────────

export function createTrackedWrite(
  res: Response,
  lastWrite: SSEWriteState,
  bp: BackpressureState,
  sessionId: string,
  currentTurn: number,
  onBackpressureDetected?: () => void,
): (data: string, label: string) => boolean {
  return (data: string, label: string): boolean => {
    lastWrite.index++;
    const preview = data.slice(0, 200).replace(/\n/g, "\\n");
    try {
      const ok = res.write(data);
      lastWrite.ts = Date.now();
      lastWrite.preview = preview;
      lastWrite.ok = ok;
      if (!ok) {
        bp.totalBytes += data.length;
        if (!bp.active) {
          bp.active = true;
          bp.startedAt = Date.now();
          bp.drainWaits++;
          log.warn(`turn ${currentTurn} BACKPRESSURE started on write #${lastWrite.index} label=${label} len=${data.length} totalBuffered=${bp.totalBytes} session=${sessionId}`);
          onBackpressureDetected?.();
        }
      } else if (lastWrite.index % 50 === 0) {
        log.debug(`SSE_WRITE #${lastWrite.index} label=${label} len=${data.length} session=${sessionId}`);
      }
      return ok;
    } catch (err: unknown) {
      lastWrite.ok = false;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`turn ${currentTurn} WRITE_THROW #${lastWrite.index} label=${label} err=${msg} writableEnded=${res.writableEnded} destroyed=${res.destroyed} session=${sessionId} lastOkWrite=#${lastWrite.index - 1}@${lastWrite.ts ? new Date(lastWrite.ts).toISOString() : "never"} preview="${lastWrite.preview}"`);
      return false;
    }
  };
}

// ── Orphan Response ──────────────────────────────────────────────────────

const orphanCountBySession = new Map<string, { count: number; firstAt: number }>();
const ORPHAN_MAX_RESPONSES = 2;
const ORPHAN_CLEANUP_MS = 60_000;

export function sendOrphanResponse(res: Response, sessionId: string | undefined): void {
  const key = sessionId || "unknown";
  const now = Date.now();

  let tracker = orphanCountBySession.get(key);
  if (!tracker || (now - tracker.firstAt > ORPHAN_CLEANUP_MS)) {
    tracker = { count: 0, firstAt: now };
    orphanCountBySession.set(key, tracker);
  }
  tracker.count++;

  log.warn(`ORPHAN_RESPONSE #${tracker.count} sessionId=${key} mapSize=${getSessionMap().size} ids=[${Array.from(getSessionMap().keys()).join(",")}]`);
  const orphanSession = getSessionMap().get(key);
  if (orphanSession) {
    publishVoiceDiagnostic(orphanSession, "orphan_response", `Orphan response #${tracker.count} — session resolution failed`, { status: "error" });
  }
  try {
    writeJournal({
      ts: now,
      type: "error",
      sessionKey: `voice:${key}`,
      sessionId: key,
      source: "voice",
      error: `voice_orphan_response: session resolution failed, mapSize=${getSessionMap().size}, orphanCount=${tracker.count}`,
    });
  } catch (journalErr: unknown) {
    log.warn(`voice journal write failed (voice_orphan_response): ${journalErr instanceof Error ? journalErr.message : String(journalErr)}`);
  }

  const chatId = `chatcmpl-orphan-${key}`;
  const created = Math.floor(now / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

  if (tracker.count > ORPHAN_MAX_RESPONSES) {
    log.warn(`ORPHAN_SUPPRESSED sessionId=${key} count=${tracker.count} — sending empty response to break loop`);
    const finish = buildSSEChunk(chatId, created, "", "stop");
    try { res.write(finish); res.write("data: [DONE]\n\n"); } catch (e: any) { log.warn(`orphan SSE write failed: ${e.message}`); }
    res.end();
    return;
  }

  sendBriefAck(res, chatId, created, { closeResponse: true, reason: "orphan_response" });
}

// ── SSE Lifecycle ────────────────────────────────────────────────────────

export function setupSSELifecycle(
  req: Request,
  res: Response,
  session: VoiceSession,
  ctx: TurnContext,
  trackedWrite: (data: string, label: string) => boolean,
  flushCoalesceBuffer: (trigger?: string, flush?: boolean) => void,
  stopFillerTimer: (reason: string) => void,
  turnAbort: AbortController,
  getCascadeTimeoutMs: () => number,
): void {
  res.on("drain", () => {
    if (ctx.bp.active) {
      const bpDuration = ctx.bp.startedAt ? Date.now() - ctx.bp.startedAt : 0;
      log.log(`turn ${ctx.currentTurn} DRAIN after ${bpDuration}ms session=${session.id}`);
      publishVoiceDiagnostic(session, "backpressure", `Backpressure resolved (${bpDuration}ms)`, { turn: ctx.currentTurn, elapsedMs: bpDuration }, ctx);
      ctx.bp.active = false;
      ctx.bp.startedAt = null;
      flushCoalesceBuffer("drain");
    }
  });

  req.on("close", () => {
    if (!res.writableEnded) {
      ctx.turnEndCause = "req_close";
      stopFillerTimer("req_close");
      log.warn(`REQ_CLOSE turn=${ctx.currentTurn} elapsed=${Date.now() - ctx.turnStart}ms chunks=${ctx.chunkCounter.count} session=${session.id}`);
      publishVoiceDiagnostic(session, "req_close", `Request closed before response finished (turn ${ctx.currentTurn})`, { turn: ctx.currentTurn, status: "error", elapsedMs: Date.now() - ctx.turnStart }, ctx);
      const { logTurnForensics } = require("./pipeline-log");
      logTurnForensics(ctx, session);
    }
  });

  res.on("error", (err: any) => {
    log.error(`RES_ERROR turn=${ctx.currentTurn} err=${err?.message || String(err)} elapsed=${Date.now() - ctx.turnStart}ms session=${session.id}`);
    publishVoiceDiagnostic(session, "res_error", `Response error: ${err?.message || String(err)}`, { turn: ctx.currentTurn, status: "error", elapsedMs: Date.now() - ctx.turnStart }, ctx);
  });

  res.on("close", () => {
    const premature = !res.writableEnded;
    const elapsed = Date.now() - ctx.turnStart;
    const sinceAudible = Date.now() - ctx.lastAudibleDeltaAt;
    const cascadeBudgetRemaining = getCascadeTimeoutMs() - sinceAudible;
    const { EXPECTED_PIPELINE_STAGES } = require("./pipeline-log");
    const stagesEmitted = Array.from(ctx.pipelineStagesEmitted).join(",") || "none";
    const missingStages = EXPECTED_PIPELINE_STAGES.filter((s: string) => !ctx.pipelineStagesEmitted.has(s));
    if (missingStages.length > 0) {
      log.warn(`RES_CLOSE turn=${ctx.currentTurn} pipeline_missing_stages=[${missingStages.join(",")}] session=${session.id}`);
    }
    log.log(`RES_CLOSE turn=${ctx.currentTurn} premature=${premature} elapsed=${elapsed}ms keepalivesSent=${ctx.keepalivesSent} audibleDeltas=${ctx.audibleDeltaCount} sinceAudibleAtCloseMs=${sinceAudible} cascadeBudgetRemainingMs=${cascadeBudgetRemaining} pipelineStages=[${stagesEmitted}] missingStages=[${missingStages.join(",") || "none"}] session=${session.id}`);
    if (premature) {
      publishVoiceDiagnostic(session, "res_close_premature", `Response closed (premature)`, { turn: ctx.currentTurn, status: "error", elapsedMs: elapsed }, ctx);
      if (!turnAbort.signal.aborted) {
        log.warn(`RES_CLOSE turn=${ctx.currentTurn} aborting LLM — connection closed while inflight elapsed=${elapsed}ms session=${session.id}`);
        turnAbort.abort();
        publishVoiceDiagnostic(session, "response_closed_abort", `LLM aborted — HTTP connection closed (turn ${ctx.currentTurn}, ${elapsed}ms)`, { turn: ctx.currentTurn, status: "error", elapsedMs: elapsed });
      }
    }
  });
}
