/**
 * V2.5 Diagnostics — fixes audit bugs #3 (WebSocket routing inconsistency)
 * and #4 (thinking persistence gap).
 *
 * Every diagnostic event is:
 *   1. Published on the eventBus under a stable category="voice" so the
 *      generic /ws fan-out delivers it (no per-session subscription bugs).
 *   2. Mirrored into the chatFileStorage system-step journal so the
 *      assistant's "thinking" steps survive after the call ends.
 */
import { createLogger } from "../log";
import { eventBus } from "../event-bus";

const log = createLogger("voice-diag");

export type DiagStatus = "started" | "done" | "error";

export interface DiagEvent {
  sessionId: string;
  chatSessionId?: string | null;
  step: string;
  status: DiagStatus;
  detail?: string;
  elapsedMs?: number;
  turnId?: string;
  extra?: Record<string, unknown>;
}

/**
 * Publish + persist a diagnostic event. Always returns immediately;
 * persistence is fire-and-forget so the hot path is not slowed down.
 */
export function emitDiagnostic(ev: DiagEvent): void {
  // (3) WebSocket fan-out — single canonical category/event pair so the
  // client always gets it regardless of which session is currently focused.
  eventBus.publish({
    category: "voice",
    event: "voice_diagnostic",
    payload: {
      sessionId: ev.sessionId,
      chatSessionId: ev.chatSessionId || null,
      step: ev.step,
      status: ev.status,
      detail: ev.detail,
      elapsedMs: ev.elapsedMs,
      turnId: ev.turnId,
      ...(ev.extra || {}),
      ts: Date.now(),
    },
  });

  // (4) Thinking persistence — only "done" steps end up in the durable
  // system-step journal (mirrors v2 behavior so transcripts read identically).
  if (ev.status !== "done" || !ev.chatSessionId) return;
  void persistStep(ev).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`persistStep failed step=${ev.step} chatSessionId=${ev.chatSessionId}: ${msg}`);
  });
}

async function persistStep(ev: DiagEvent): Promise<void> {
  const { chatFileStorage } = await import("../chat-file-storage");
  await chatFileStorage.createMessage(
    ev.chatSessionId!,
    "assistant",
    "",
    undefined,
    undefined,
    "elevenlabs-voice",
    [
      {
        name: ev.step,
        status: "done" as const,
        elapsedMs: ev.elapsedMs,
        detail: ev.detail || `${ev.step} (v2.5)`,
      },
    ],
  );
}

/**
 * Convenience wrapper that times an async block and emits started/done events.
 */
export async function withDiag<T>(
  base: Omit<DiagEvent, "status" | "elapsedMs">,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  emitDiagnostic({ ...base, status: "started" });
  try {
    const out = await fn();
    emitDiagnostic({ ...base, status: "done", elapsedMs: Date.now() - startedAt });
    return out;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    emitDiagnostic({
      ...base,
      status: "error",
      elapsedMs: Date.now() - startedAt,
      detail,
    });
    throw err;
  }
}
