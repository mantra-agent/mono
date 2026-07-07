/**
 * V2.5 Transcript — fixes audit bug #1 (interim transcripts not surfacing).
 *
 * v2 only persisted final transcripts and emitted no events for partial
 * (in-flight) speech, so the UI sat in "..." for the duration of long user
 * utterances. v2.5 publishes interim updates incrementally, then a final
 * event when the speaker stops, so the client can render live captions.
 *
 * The functions here are pure — they're invoked by both the custom-LLM
 * handler (server-driven path) and from event-bus listeners that translate
 * ElevenLabs SDK transcript events into our diagnostic stream.
 */
import { eventBus } from "../event-bus";
import { emitDiagnostic } from "./diagnostics";

export type TranscriptRole = "user" | "assistant";

export interface InterimEvent {
  sessionId: string;
  chatSessionId?: string | null;
  role: TranscriptRole;
  text: string;
  /** Sequence number to allow the client to dedupe / order partials. */
  seq: number;
  turnId?: string;
}

export interface FinalEvent extends Omit<InterimEvent, "seq"> {
  /** Total chars in the final transcript line. */
  chars: number;
  /** Optional final-confidence ASR score (0-1) when available. */
  confidence?: number;
}

export function publishInterim(ev: InterimEvent): void {
  eventBus.publish({
    category: "voice",
    event: "voice_transcript_interim",
    payload: {
      sessionId: ev.sessionId,
      chatSessionId: ev.chatSessionId || null,
      role: ev.role,
      text: ev.text,
      seq: ev.seq,
      turnId: ev.turnId,
      ts: Date.now(),
    },
  });
}

export function publishFinal(ev: FinalEvent): void {
  eventBus.publish({
    category: "voice",
    event: "voice_transcript_final",
    payload: {
      sessionId: ev.sessionId,
      chatSessionId: ev.chatSessionId || null,
      role: ev.role,
      text: ev.text,
      chars: ev.chars,
      confidence: ev.confidence,
      turnId: ev.turnId,
      ts: Date.now(),
    },
  });
  // Also emit a diagnostic so the system-step journal records the turn boundary.
  emitDiagnostic({
    sessionId: ev.sessionId,
    chatSessionId: ev.chatSessionId || null,
    step: ev.role === "user" ? "user_utterance" : "assistant_utterance",
    status: "done",
    detail: `${ev.chars} chars`,
    turnId: ev.turnId,
  });
}

/**
 * Throttle interim publishing so we don't flood the bus on long utterances.
 * The throttle key is `${sessionId}:${role}`; the latest pending text is
 * always sent, so the client UI tracks the most recent state.
 */
const throttle = new Map<string, { last: number; pending: NodeJS.Timeout | null }>();
const INTERIM_INTERVAL_MS = 120;
/**
 * Slots are normally cleared by clearInterimState(sessionId) at end-of-call.
 * If a session ends abnormally (crash, lost socket) we still need to release
 * the entry — otherwise the throttle map leaks for the lifetime of the
 * process. This sweeper drops any slot idle for >SLOT_IDLE_MS and clears
 * its pending timer, satisfying "Bound Every Database Operation".
 */
const SLOT_IDLE_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - SLOT_IDLE_MS;
    for (const [k, slot] of Array.from(throttle.entries())) {
      if (slot.last < cutoff) {
        if (slot.pending) clearTimeout(slot.pending);
        throttle.delete(k);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive on its own.
  if (typeof sweepTimer === "object" && sweepTimer && "unref" in sweepTimer) {
    (sweepTimer as { unref: () => void }).unref();
  }
}

export function publishInterimThrottled(ev: InterimEvent): void {
  ensureSweeper();
  const key = `${ev.sessionId}:${ev.role}`;
  const slot = throttle.get(key) || { last: 0, pending: null };
  const now = Date.now();
  const since = now - slot.last;
  if (since >= INTERIM_INTERVAL_MS) {
    slot.last = now;
    throttle.set(key, slot);
    publishInterim(ev);
    return;
  }
  if (slot.pending) clearTimeout(slot.pending);
  slot.pending = setTimeout(() => {
    slot.last = Date.now();
    slot.pending = null;
    throttle.set(key, slot);
    publishInterim(ev);
  }, INTERIM_INTERVAL_MS - since);
  throttle.set(key, slot);
}

export function clearInterimState(sessionId: string): void {
  for (const key of Array.from(throttle.keys())) {
    if (key.startsWith(`${sessionId}:`)) {
      const slot = throttle.get(key);
      if (slot?.pending) clearTimeout(slot.pending);
      throttle.delete(key);
    }
  }
}
