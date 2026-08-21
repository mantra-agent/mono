/**
 * Voice turn I/O handlers — coalescing, backpressure management,
 * cascade keepalive, and stream chunk processing.
 */
import type { Response } from "express";
import type { VoiceSession, TurnContext } from "./types";
import { buildSSEChunk, isResponseAlive, createTrackedWrite } from "./sse";
import { publishVoiceDiagnostic } from "./session";
import { createLogger } from "../log";
import { getVerifiedCascadeTimeoutSeconds, getVerifiedSoftTimeoutSeconds } from "../elevenlabs";
import { computeSoftTimeoutBufferMs, KEEPALIVE_SAFETY_MARGIN_MS } from "../voice-keepalive-buffer";
import { TurnAssembler, type TurnCloseReason } from "../turn-assembly";

const log = createLogger("VoiceTurnIO");

// ── Timing constants ─────────────────────────────────────────────────────

export const COALESCE_BUFFER_MAX_BYTES = 4096;

const AUDIBLE_KEEPALIVE_THRESHOLD_MS = 6_500;

export function getCascadeTimeoutMs(): number {
  return getVerifiedCascadeTimeoutSeconds() * 1000;
}

export function getKeepaliveCheckIntervalMs(): number {
  const cascadeMs = getCascadeTimeoutMs();
  return Math.max(1_000, Math.min(1_500, Math.floor(cascadeMs / 4)));
}

let keepaliveBufferWarningLogged = false;

export function getSoftTimeoutBufferMs(): number {
  return computeSoftTimeoutBufferMs(
    getVerifiedSoftTimeoutSeconds(),
    getVerifiedCascadeTimeoutSeconds(),
    KEEPALIVE_SAFETY_MARGIN_MS,
    (msg) => {
      if (!keepaliveBufferWarningLogged) {
        keepaliveBufferWarningLogged = true;
        log.warn(msg);
      }
    },
  );
}

// ── Turn IO Handlers ─────────────────────────────────────────────────────

export interface TurnIOHandlers {
  trackedWrite: (data: string, label: string) => boolean;
  stopFillerTimer: (reason: string) => void;
  flushCoalesceBuffer: (trigger?: string, flush?: boolean) => void;
  trackContentDelivery: () => void;
  sendCascadeKeepalive: () => void;
  startKeepaliveTimer: () => void;
}

export function createTurnIOHandlers(
  res: Response, ctx: TurnContext, session: VoiceSession, currentTurn: number,
): TurnIOHandlers {
  const _rawTrackedWrite = createTrackedWrite(res, ctx.lastWrite, ctx.bp, session.id, currentTurn, () => {
    publishVoiceDiagnostic(session, "backpressure", `Backpressure detected (buffered=${ctx.bp.totalBytes} bytes)`, { turn: currentTurn, status: "active" }, ctx);
  });

  const trackedWrite = (data: string, label: string): boolean => {
    const ok = _rawTrackedWrite(data, label);
    if (!res.destroyed) ctx.lastWriteAt = Date.now();
    return ok;
  };

  const stopFillerTimer = (reason: string): void => {
    if (ctx.fillerTimer) {
      clearInterval(ctx.fillerTimer);
      ctx.fillerTimer = null;
      log.log(`turn ${currentTurn} KEEPALIVE_TIMER_STOP reason=${reason} session=${session.id}`);
    } else {
      log.debug(`turn ${currentTurn} KEEPALIVE_TIMER_STOP skipped=not_running reason=${reason} session=${session.id}`);
    }
  };

  const trackContentDelivery = (): void => {
    const now = Date.now();
    ctx.lastContentAt.ts = now;
    ctx.lastContentSentAt = now;
    session.inflightChunksDelivered++;
    const sessionGap = now - session.lastDataDeliveryAt;
    if (sessionGap > session.longestDataGapMs) session.longestDataGapMs = sessionGap;
    session.lastDataDeliveryAt = now;
    if (ctx.lastRealContentAt.ts !== null) {
      const gap = now - ctx.lastRealContentAt.ts;
      if (gap > ctx.longestContentGapMs) ctx.longestContentGapMs = gap;
    }
    if (ctx.firstRealContentAt.ts === null) ctx.firstRealContentAt.ts = now;
    ctx.lastRealContentAt.ts = now;
  };

  const flushCoalesceBuffer = (trigger?: string, flush: boolean = false): void => {
    if (!ctx.coalesceBuf.value) return;
    if (!isResponseAlive(res)) {
      log.warn(`CONTENT_DROPPED_DEAD_RESPONSE location=flushCoalesceBuffer trigger=${trigger} contentBytes=${ctx.coalesceBuf.value.length} turn=${currentTurn} session=${session.id}`);
      if (!ctx.contentDroppedPublished) {
        ctx.contentDroppedPublished = true;
        publishVoiceDiagnostic(session, "content_dropped", `Content dropped — response dead (${ctx.coalesceBuf.value.length} bytes)`, { turn: currentTurn, status: "error" }, ctx);
      }
      return;
    }
    const content = ctx.coalesceBuf.value;
    ctx.coalesceBuf.value = "";
    ctx.coalesceFlushCount++;
    ctx.chunkCounter.count++;
    ctx.responseSize.total += content.length;
    if (ctx.firstChunk.sentAt === null) ctx.firstChunk.sentAt = Date.now();
    trackContentDelivery();
    // Scan backwards past system entries to find the last content entry to merge into.
    // Tool entries are intentional content breaks — stop scanning if we hit one.
    let lastContentIdx = -1;
    for (let i = ctx.segmentChronology.length - 1; i >= 0; i--) {
      const entry = ctx.segmentChronology[i];
      if (entry.s === "content") { lastContentIdx = i; break; }
      if (entry.s === "tool") break;
    }
    if (lastContentIdx >= 0) {
      (ctx.segmentChronology[lastContentIdx] as { s: "content"; c: string }).c += content;
    } else {
      ctx.segmentChronology.push({ s: "content", c: content });
    }
    trackedWrite(buildSSEChunk(ctx.chatId, ctx.created, content, null, flush), `coalesced_${ctx.coalesceFlushCount}`);
  };

  const sendCascadeKeepalive = (): void => {
    if (!isResponseAlive(res)) {
      log.warn(`CONTENT_DROPPED_DEAD_RESPONSE location=sendCascadeKeepalive turn=${currentTurn} session=${session.id}`);
      return;
    }
    const bufferWord = "... ";
    const chunk = buildSSEChunk(ctx.chatId, ctx.created, bufferWord);
    try {
      res.write(chunk);
      const now = Date.now();
      ctx.lastContentAt.ts = now;
      ctx.lastContentSentAt = now;
      const sessionGap = now - session.lastDataDeliveryAt;
      if (sessionGap > session.longestDataGapMs) session.longestDataGapMs = sessionGap;
      session.lastDataDeliveryAt = now;
      ctx.keepalivesSent++;
      ctx.lastKeepaliveAt = now;
      session.inflightChunksDelivered++;
      log.debug(`turn ${currentTurn} CASCADE_KEEPALIVE sent #${ctx.keepalivesSent} sinceTurnStart=${now - ctx.turnStart}ms sinceAudible=${now - ctx.lastAudibleDeltaAt}ms session=${session.id}`);
    } catch (e: any) {
      log.warn(`turn ${currentTurn} CASCADE_KEEPALIVE write failed: ${e.message} session=${session.id}`);
    }
  };

  const startKeepaliveTimer = (): void => {
    if (ctx.fillerTimer) {
      log.debug(`turn ${currentTurn} KEEPALIVE_TIMER_START skipped=already_running session=${session.id}`);
      return;
    }
    const turnKeepaliveStart = Date.now();
    const sinceSessionLastData = turnKeepaliveStart - session.lastDataDeliveryAt;
    log.debug(`turn ${currentTurn} KEEPALIVE_TIMER_START softTimeoutBuffer=${getSoftTimeoutBufferMs()}ms checkInterval=${getKeepaliveCheckIntervalMs()}ms cascadeTimeout=${getCascadeTimeoutMs()}ms sinceSessionLastData=${sinceSessionLastData}ms session=${session.id}`);
    ctx.fillerTimer = setInterval(() => {
      const now = Date.now();
      const sinceTurnStart = now - turnKeepaliveStart;
      const sinceLastContent = now - ctx.lastContentSentAt;
      const sinceAudible = now - ctx.lastAudibleDeltaAt;
      if (!isResponseAlive(res)) {
        log.warn(`turn ${currentTurn} KEEPALIVE_TICK response_dead sinceLastContent=${sinceLastContent}ms sinceAudible=${sinceAudible}ms sinceTurnStart=${sinceTurnStart}ms — self-terminating session=${session.id}`);
        publishVoiceDiagnostic(session, "keepalive_dead", `Keepalive detected dead response — self-terminating`, { turn: currentTurn, status: "error", elapsedMs: sinceTurnStart }, ctx);
        stopFillerTimer("response_dead");
        return;
      }
      if (sinceAudible >= AUDIBLE_KEEPALIVE_THRESHOLD_MS) {
        log.debug(`turn ${currentTurn} KEEPALIVE_TICK action=keepalive sinceTurnStart=${sinceTurnStart}ms sinceAudible=${sinceAudible}ms threshold=${AUDIBLE_KEEPALIVE_THRESHOLD_MS}ms audibleDeltas=${ctx.audibleDeltaCount} session=${session.id}`);
        sendCascadeKeepalive();
      } else {
        log.debug(`turn ${currentTurn} KEEPALIVE_TICK action=skip sinceAudible=${sinceAudible}ms threshold=${AUDIBLE_KEEPALIVE_THRESHOLD_MS}ms sinceTurnStart=${sinceTurnStart}ms session=${session.id}`);
      }
    }, getKeepaliveCheckIntervalMs());
  };

  return { trackedWrite, stopFillerTimer, flushCoalesceBuffer, trackContentDelivery, sendCascadeKeepalive, startKeepaliveTimer };
}

// ── Stream Chunk Handler ─────────────────────────────────────────────────

export interface VoiceStreamChunkHandler {
  (content: string): void;
  close(reason?: TurnCloseReason): void;
}

export function createStreamChunkHandler(
  res: Response, ctx: TurnContext, session: VoiceSession, currentTurn: number,
  flushCoalesceBuffer: (trigger?: string, flush?: boolean) => void,
): VoiceStreamChunkHandler {
  const assembler = new TurnAssembler({
    maxActiveTurns: 1,
    maxFragmentsPerTurn: null,
    maxBytesPerTurn: null,
    maxOpenAgeMs: null,
  });
  const streamId = `voice:${session.id}`;
  const turnKey = ctx.assistantAttemptId;
  let sequence = 0;
  let firstRealChunkFlushed = false;
  let terminal = false;
  let diagnosticBytes = 0;
  let fragmentDiagnosticPublished = false;
  let byteDiagnosticPublished = false;

  const close = (reason: TurnCloseReason = "completed"): void => {
    if (terminal) return;
    terminal = true;
    const outcome = reason === "cancelled" || reason === "superseded"
      ? assembler.cancel(turnKey, reason)
      : assembler.close(turnKey, reason);
    if (outcome.outcome === "closed") {
      log.info(`voice_output_closed session=${session.id} turn=${currentTurn} turnKey=${turnKey} reason=${reason} fragments=${outcome.turn.rawFragments.length} degraded=${outcome.turn.degraded}`);
    }
  };

  const handler = ((content: string): void => {
    if (terminal) {
      log.warn(`voice_output_late_delta session=${session.id} turn=${currentTurn} turnKey=${turnKey} bytes=${Buffer.byteLength(content)}`);
      return;
    }
    const now = Date.now();
    diagnosticBytes += Buffer.byteLength(content);
    if (!fragmentDiagnosticPublished && sequence >= 2_048) {
      fragmentDiagnosticPublished = true;
      log.warn(`voice_output_fragment_volume session=${session.id} turn=${currentTurn} turnKey=${turnKey} fragments=${sequence}`);
      publishVoiceDiagnostic(session, "output_volume", `Voice output crossed 2,048 fragments; continuing`, { turn: currentTurn, status: "done" }, ctx);
    }
    if (!byteDiagnosticPublished && diagnosticBytes >= 256 * 1_024) {
      byteDiagnosticPublished = true;
      log.warn(`voice_output_byte_volume session=${session.id} turn=${currentTurn} turnKey=${turnKey} bytes=${diagnosticBytes}`);
      publishVoiceDiagnostic(session, "output_volume", `Voice output crossed 256 KiB; continuing`, { turn: currentTurn, status: "done" }, ctx);
    }
    const outcome = assembler.accept({ streamId, turnKey, sequence: sequence++, direction: "outbound", text: content, stability: "stable", providerEventId: `${turnKey}:${sequence - 1}`, occurredAtMs: now, receivedAtMs: now });
    if (outcome.outcome === "closed") {
      terminal = true;
      ctx.turnEndCause = outcome.turn.closeReason;
      log.error(`voice_output_budget_exceeded session=${session.id} turn=${currentTurn} turnKey=${turnKey} fragments=${outcome.turn.rawFragments.length}`);
      publishVoiceDiagnostic(session, "coalesce_truncation", "Voice output budget exceeded; terminating turn without silent truncation", { turn: currentTurn, status: "error" }, ctx);
      ctx.turnAbort.abort();
      return;
    }
    if (outcome.outcome !== "accepted") {
      log.warn(`voice_output_fragment_rejected session=${session.id} turn=${currentTurn} turnKey=${turnKey} outcome=${outcome.outcome}`);
      return;
    }
    if (!isResponseAlive(res)) {
      close("transport_failed");
      log.warn(`CONTENT_DROPPED_DEAD_RESPONSE location=streamChunkHandler contentBytes=${content.length} turn=${currentTurn} elapsed=${Date.now() - ctx.turnStart}ms session=${session.id}`);
      if (!ctx.contentDroppedPublished) {
        ctx.contentDroppedPublished = true;
        publishVoiceDiagnostic(session, "content_dropped", `Content dropped — response dead (${content.length} bytes)`, { turn: currentTurn, status: "error" }, ctx);
      }
      return;
    }
    ctx.lastAudibleDeltaAt = now;
    ctx.audibleDeltaCount++;
    ctx.coalesceBuf.value += content;
    if (!firstRealChunkFlushed) {
      firstRealChunkFlushed = true;
      if (!ctx.bp.active) flushCoalesceBuffer("first_real_content");
      return;
    }
    if (ctx.coalesceBuf.value.length > COALESCE_BUFFER_MAX_BYTES && !ctx.bp.active) flushCoalesceBuffer("overflow");
  }) as VoiceStreamChunkHandler;
  handler.close = close;
  return handler;
}
