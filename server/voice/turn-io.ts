/**
 * Voice turn I/O — presence writer, phrase assembler, hold-as-presence.
 *
 * Presence is one discriminant produced only at the speakable write helper.
 * Unflushed non-speech never leaves this module onto the SSE wire.
 */
import type { Response } from "express";
import type { PresenceState, VoiceSession, TurnContext } from "./types";
import { buildSSEChunk, isResponseAlive, createTrackedWrite, sendSSEComment, setupSSELifecycle } from "./sse";
import { publishVoiceDiagnostic } from "./session";
import { createLogger } from "../log";
import { getVerifiedCascadeTimeoutSeconds, getVerifiedSoftTimeoutSeconds } from "../elevenlabs";
import { computeSoftTimeoutBufferMs, KEEPALIVE_SAFETY_MARGIN_MS } from "../voice-keepalive-buffer";
import { TurnAssembler, type TurnCloseReason } from "../turn-assembly";

const log = createLogger("VoiceTurnIO");

// ── Timing constants ─────────────────────────────────────────────────────

export const COALESCE_BUFFER_MAX_BYTES = 4096;

/** Spoken hold sentences are gone. Continuity is the live generator + write port. */
const SPOKEN_FILLER_PREAMBLE = /^(?:One second\.|One moment\.|Still on it\.|Working\.)\s*/i;

/** Drop a model-authored stall opener so it cannot become the first flushed speakable. */
export function stripSpokenFillerPreamble(text: string): { text: string; stripped: boolean } {
  const next = text.replace(SPOKEN_FILLER_PREAMBLE, "");
  return { text: next, stripped: next !== text };
}

/**
 * Split completed speakable prose from an unstable trailing fragment.
 * ElevenLabs only forces TTS when delta.flush=true; incomplete clauses must stay
 * buffered so mid-tool progress is voiced as finished sentences, not one delayed block.
 */
export function takeCompletedSpeakable(buffer: string): { speakable: string; remainder: string } {
  if (!buffer) return { speakable: "", remainder: "" };
  const boundary = /[.!?]["')\]]*(?=\s|$)/g;
  let lastEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(buffer)) !== null) {
    lastEnd = match.index + match[0].length;
    while (lastEnd < buffer.length && /\s/.test(buffer[lastEnd]!)) lastEnd++;
  }
  if (lastEnd <= 0) return { speakable: "", remainder: buffer };
  return {
    speakable: buffer.slice(0, lastEnd),
    remainder: buffer.slice(lastEnd),
  };
}

export function getCascadeTimeoutMs(): number {
  return getVerifiedCascadeTimeoutSeconds() * 1000;
}

/** Poll slightly faster than the hold window so a hold lands near the cascade-safe instant. */
export function getPresenceHoldCheckIntervalMs(): number {
  const windowMs = getSoftTimeoutBufferMs();
  return Math.max(1_000, Math.min(2_000, Math.floor(windowMs / 3)));
}

/** @deprecated alias — hold cadence uses getSoftTimeoutBufferMs, not a 1–1.5s drip. */
export function getKeepaliveCheckIntervalMs(): number {
  return getPresenceHoldCheckIntervalMs();
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

function spineIds(session: VoiceSession, ctx: TurnContext): string {
  return `session=${session.id} turnId=${ctx.turnId} assistantAttemptId=${ctx.assistantAttemptId}`;
}

function setPresence(ctx: TurnContext, next: PresenceState): void {
  if (ctx.presence === next) return;
  ctx.presence = next;
}

// ── Turn IO Handlers ─────────────────────────────────────────────────────

export interface TurnIOHandlers {
  trackedWrite: (data: string, label: string) => boolean;
  stopFillerTimer: (reason: string) => void;
  flushCoalesceBuffer: (trigger?: string, flush?: boolean) => void;
  trackContentDelivery: () => void;
  /** Emit a flushed hold sentence when the cascade-safe window has elapsed. */
  sendPresenceHold: () => void;
  startKeepaliveTimer: () => void;
  /** @deprecated removed — unflushed ellipsis keepalive is unrepresentable. */
  sendCascadeKeepalive: () => void;
}

export function createTurnIOHandlers(
  res: Response, ctx: TurnContext, session: VoiceSession, currentTurn: number,
): TurnIOHandlers {
  session.activeWriteRes = res;
  const writeRes = (): Response => session.activeWriteRes ?? res;
  const _rawTrackedWrite = createTrackedWrite(writeRes, ctx.lastWrite, ctx.bp, session.id, currentTurn, () => {
    publishVoiceDiagnostic(session, "backpressure", `Backpressure detected (buffered=${ctx.bp.totalBytes} bytes)`, { turn: currentTurn, status: "active" }, ctx);
  });

  const trackedWrite = (data: string, label: string): boolean => {
    const ok = _rawTrackedWrite(data, label);
    const port = writeRes();
    if (!port.destroyed) ctx.lastWriteAt = Date.now();
    return ok;
  };

  const stopFillerTimer = (reason: string): void => {
    if (ctx.fillerTimer) {
      clearInterval(ctx.fillerTimer);
      ctx.fillerTimer = null;
      log.log(`turn ${currentTurn} PRESENCE_HOLD_TIMER_STOP reason=${reason} ${spineIds(session, ctx)}`);
    } else {
      log.debug(`turn ${currentTurn} PRESENCE_HOLD_TIMER_STOP skipped=not_running reason=${reason} ${spineIds(session, ctx)}`);
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

  /**
   * Presence writer — sole path for speakable SSE.
   * Every speakable uses flush=true. Holds are not transcript content.
   */
  const writeSpeakable = (
    content: string,
    kind: "model" | "hold",
    trigger: string,
  ): boolean => {
    if (!content) return false;
    if (!isResponseAlive(writeRes())) {
      log.warn(
        `WRITE_PORT_DEAD location=writeSpeakable kind=${kind} trigger=${trigger} contentBytes=${content.length} turn=${currentTurn} ${spineIds(session, ctx)}`,
      );
      return false;
    }

    const now = Date.now();
    const sincePriorFlushed = now - ctx.lastFlushedSpeakableAt;
    const speakableId = ctx.lastFlushedSpeakableId + 1;

    const ok = trackedWrite(
      buildSSEChunk(ctx.chatId, ctx.created, content, null, true),
      kind === "hold" ? `presence_hold_${ctx.fillerCount + 1}` : `coalesced_${ctx.coalesceFlushCount}`,
    );
    if (!ok) {
      log.debug(
        `turn ${currentTurn} SSE_WRITE kind=${kind} speakableId=${speakableId} ok=false ${spineIds(session, ctx)}`,
      );
      return false;
    }
    if (kind === "model") {
      setPresence(ctx, "speaking");
      ctx.chunkCounter.count++;
      ctx.responseSize.total += content.length;
      if (ctx.firstChunk.sentAt === null) ctx.firstChunk.sentAt = now;
      if (ctx.firstRealContentAt.ts === null) ctx.firstRealContentAt.ts = now;
      ctx.lastRealContentAt.ts = now;
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
      log.info(
        `turn ${currentTurn} PHRASE_FLUSH trigger=${trigger} forceTts=true chars=${content.length} remainder=${ctx.coalesceBuf.value.length} speakableId=${speakableId} ${spineIds(session, ctx)}`,
      );
    } else {
      setPresence(ctx, "holding");
      ctx.fillerCount++;
      ctx.lastFillerSentAt = now;
      log.info(
        `turn ${currentTurn} PRESENCE_HOLD fillerCount=${ctx.fillerCount} sinceLastFlushedSpeakable=${sincePriorFlushed}ms speakableId=${speakableId} ${spineIds(session, ctx)}`,
      );
    }
    ctx.lastFlushedSpeakableId = speakableId;
    ctx.lastFlushedSpeakableAt = now;
    ctx.lastContentSentAt = now;
    ctx.lastContentAt.ts = now;
    ctx.lastAudibleDeltaAt = now;
    session.inflightChunksDelivered++;
    const sessionGap = now - session.lastDataDeliveryAt;
    if (sessionGap > session.longestDataGapMs) session.longestDataGapMs = sessionGap;
    session.lastDataDeliveryAt = now;
    log.debug(
      `turn ${currentTurn} SSE_WRITE kind=${kind} speakableId=${speakableId} ok=${ok} ${spineIds(session, ctx)}`,
    );
    return ok;
  };

  /**
   * Phrase assembler — soft flush emits completed sentences only.
   * Forced flush allowed for turn_end, overflow, guide_introduction — not tool start.
   */
  const flushCoalesceBuffer = (trigger?: string, flush: boolean = false): void => {
    if (!ctx.coalesceBuf.value) return;
    if (!isResponseAlive(writeRes())) {
      log.warn(
        `WRITE_PORT_DEAD location=flushCoalesceBuffer trigger=${trigger} holdingBytes=${ctx.coalesceBuf.value.length} turn=${currentTurn} ${spineIds(session, ctx)}`,
      );
      return;
    }

    const forceEmpty = flush === true
      && (trigger === "turn_end" || trigger === "overflow" || trigger === "guide_introduction" || trigger === "drain");

    let content: string;
    let remainder = "";
    if (forceEmpty) {
      content = ctx.coalesceBuf.value;
      ctx.coalesceBuf.value = "";
    } else {
      // Soft path (timer, first content) and any other force request that is not
      // a named forced trigger — including legacy pre_tool_call — keep remainder.
      const split = takeCompletedSpeakable(ctx.coalesceBuf.value);
      if (!split.speakable) {
        if (trigger === "pre_tool_call") {
          log.debug(
            `turn ${currentTurn} PHRASE_HOLD_ACROSS_TOOL remainder=${ctx.coalesceBuf.value.length} ${spineIds(session, ctx)}`,
          );
        }
        return;
      }
      content = split.speakable;
      remainder = split.remainder;
      ctx.coalesceBuf.value = remainder;
    }

    const stripped = stripSpokenFillerPreamble(content);
    if (stripped.stripped) {
      log.info(`turn ${currentTurn} SPOKEN_FILLER_STRIPPED trigger=${trigger} ${spineIds(session, ctx)}`);
      content = stripped.text;
    }
    if (!content) {
      ctx.coalesceBuf.value = remainder;
      return;
    }

    ctx.coalesceFlushCount++;
    const wrote = writeSpeakable(content, "model", trigger || "unspecified");
    if (!wrote) {
      ctx.coalesceBuf.value = content + remainder;
      ctx.coalesceFlushCount = Math.max(0, ctx.coalesceFlushCount - 1);
      log.warn(
        `WRITE_PORT_HOLD location=flushCoalesceBuffer trigger=${trigger} restoredBytes=${ctx.coalesceBuf.value.length} turn=${currentTurn} ${spineIds(session, ctx)}`,
      );
    }
  };

  session.attachWritePort = (req, res) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }
    if (res.socket) res.socket.setNoDelay(true);
    const prev = session.activeWriteRes;
    session.activeWriteRes = res;
    sendSSEComment(res, "write_port_attached", session.id);
    setupSSELifecycle(req, res, session, ctx, trackedWrite, flushCoalesceBuffer, stopFillerTimer, ctx.turnAbort, getCascadeTimeoutMs);
    if (prev && prev !== res && !prev.writableEnded && !prev.destroyed) {
      try { prev.end(); } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`WRITE_PORT_PREV_END_FAILED turn=${currentTurn} session=${session.id} error=${msg}`);
      }
    }
    flushCoalesceBuffer("write_port_attached");
  };

  if (session.pendingAttach) {
    const pending = session.pendingAttach;
    session.pendingAttach = null;
    session.attachWritePort(pending.req, pending.res);
  }

  const sendPresenceHold = (): void => {
    const port = writeRes();
    if (!isResponseAlive(port)) {
      log.warn(`WRITE_PORT_DEAD location=sendPresenceHold turn=${currentTurn} ${spineIds(session, ctx)}`);
      return;
    }
    sendSSEComment(port, "presence_hold", session.id);
    ctx.lastFillerSentAt = Date.now();
    log.info(
      `turn ${currentTurn} PRESENCE_HOLD fillerCount=${ctx.fillerCount} silent=true ${spineIds(session, ctx)}`,
    );
  };

  /** Demolished: unflushed "... " is unrepresentable. Kept as no-op for stray callers. */
  const sendCascadeKeepalive = (): void => {
    log.debug(`turn ${currentTurn} CASCADE_KEEPALIVE rejected=unrepresentable ${spineIds(session, ctx)}`);
  };

  const startKeepaliveTimer = (): void => {
    if (ctx.fillerTimer) {
      log.debug(`turn ${currentTurn} PRESENCE_HOLD_TIMER_START skipped=already_running ${spineIds(session, ctx)}`);
      return;
    }
    const holdWindowMs = getSoftTimeoutBufferMs();
    const checkIntervalMs = getPresenceHoldCheckIntervalMs();
    log.debug(
      `turn ${currentTurn} PRESENCE_HOLD_TIMER_START holdWindow=${holdWindowMs}ms checkInterval=${checkIntervalMs}ms cascadeTimeout=${getCascadeTimeoutMs()}ms ${spineIds(session, ctx)}`,
    );
    ctx.fillerTimer = setInterval(() => {
      const now = Date.now();
      const sinceFlushed = now - ctx.lastFlushedSpeakableAt;
      if (!isResponseAlive(writeRes())) {
        log.debug(
          `turn ${currentTurn} PRESENCE_HOLD_TICK write_port_dead sinceFlushed=${sinceFlushed}ms — holding ${spineIds(session, ctx)}`,
        );
        return;
      }

      // Hold only after cascade-safe silence on flushed speakables, and not while
      // the model is still streaming incomplete clauses (lastAudibleDeltaAt = last model delta).
      const sinceModelDelta = now - ctx.lastAudibleDeltaAt;
      const shouldHold = sinceFlushed >= holdWindowMs
        && (ctx.toolCallActive || sinceModelDelta >= holdWindowMs);

      if (shouldHold) {
        log.debug(
          `turn ${currentTurn} PRESENCE_HOLD_TICK action=hold sinceFlushed=${sinceFlushed}ms window=${holdWindowMs}ms toolActive=${ctx.toolCallActive} ${spineIds(session, ctx)}`,
        );
        sendPresenceHold();
      } else {
        log.debug(
          `turn ${currentTurn} PRESENCE_HOLD_TICK action=skip sinceFlushed=${sinceFlushed}ms window=${holdWindowMs}ms toolActive=${ctx.toolCallActive} ${spineIds(session, ctx)}`,
        );
      }
    }, checkIntervalMs);
  };

  return {
    trackedWrite,
    stopFillerTimer,
    flushCoalesceBuffer,
    trackContentDelivery,
    sendPresenceHold,
    startKeepaliveTimer,
    sendCascadeKeepalive,
  };
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
      log.info(
        `voice_output_closed session=${session.id} turn=${currentTurn} turnKey=${turnKey} reason=${reason} fragments=${outcome.turn.rawFragments.length} degraded=${outcome.turn.degraded} turnId=${ctx.turnId} assistantAttemptId=${ctx.assistantAttemptId}`,
      );
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
    if (!isResponseAlive(session.activeWriteRes ?? res)) {
      log.warn(`WRITE_PORT_DEAD location=streamChunkHandler buffering contentBytes=${content.length} turn=${currentTurn} elapsed=${Date.now() - ctx.turnStart}ms session=${session.id}`);
    }
    log.debug(
      `turn ${currentTurn} MODEL_DELTA_ACCEPTED chars=${content.length} sequence=${sequence - 1} turnId=${ctx.turnId} assistantAttemptId=${ctx.assistantAttemptId} session=${session.id}`,
    );
    ctx.lastAudibleDeltaAt = now;
    ctx.audibleDeltaCount++;
    ctx.coalesceBuf.value += content;
    if (!firstRealChunkFlushed) {
      firstRealChunkFlushed = true;
      if (!ctx.bp.active) flushCoalesceBuffer("first_real_content");
      return;
    }
    // Overflow must force-empty: holding >4KiB of unfinished prose is worse than
    // speaking a non-sentence boundary once under backpressure-free delivery.
    if (ctx.coalesceBuf.value.length > COALESCE_BUFFER_MAX_BYTES && !ctx.bp.active) {
      flushCoalesceBuffer("overflow", true);
    }
  }) as VoiceStreamChunkHandler;
  handler.close = close;
  return handler;
}
