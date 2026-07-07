/**
 * Voice circuit breaker — rapid-cancellation detection, concurrency
 * capping, zombie executor detection, and recovery wait loops.
 */
import type { VoiceSession } from "./types";
import { voiceSessionKey, getActiveVoiceRunCount, publishVoiceDiagnostic } from "./session";
import { agentExecutor } from "../agent-executor";
import { createLogger } from "../log";

const log = createLogger("VoiceLlm");

// ── Constants ────────────────────────────────────────────────────────────

export const CIRCUIT_BREAKER_WINDOW_MS = 20_000;
const CIRCUIT_BREAKER_THRESHOLD = 15;
const CIRCUIT_BREAKER_COOLDOWN_MS = 3_000;
const MAX_CONCURRENT_VOICE_RUNS = 2;
const CB_RETRY_WAIT_MS = 2_000;
export const CB_MAX_RETRIES = 7;

// ── Circuit Breaker Check ────────────────────────────────────────────────

export function checkCircuitBreaker(session: VoiceSession, currentTurn: number): boolean {
  const now = Date.now();
  session.recentCancellations = session.recentCancellations.filter(
    ts => now - ts < CIRCUIT_BREAKER_WINDOW_MS,
  );

  if (session.circuitBreakerActive) {
    const oldest = session.recentCancellations[0] || 0;
    const sinceOldest = now - oldest;
    if (sinceOldest > CIRCUIT_BREAKER_COOLDOWN_MS && session.recentCancellations.length < CIRCUIT_BREAKER_THRESHOLD) {
      log.log(`[CircuitBreaker] DEACTIVATED session=${session.id} turn=${currentTurn} — churn settled`);
      session.circuitBreakerActive = false;
      return false;
    }
    log.warn(`[CircuitBreaker] ACTIVE session=${session.id} turn=${currentTurn} — suppressing executor run (${session.recentCancellations.length} cancellations in window)`);
    return true;
  }

  if (session.recentCancellations.length >= CIRCUIT_BREAKER_THRESHOLD) {
    session.circuitBreakerActive = true;
    log.warn(`[CircuitBreaker] ACTIVATED session=${session.id} turn=${currentTurn} — ${session.recentCancellations.length} rapid cancellations in ${CIRCUIT_BREAKER_WINDOW_MS}ms window`);
    return true;
  }
  return false;
}

// ── Circuit Breaker Wait Computation ─────────────────────────────────────

export function computeCircuitBreakerWaitMs(session: VoiceSession): number {
  const now = Date.now();
  const oldest = session.recentCancellations[0] || 0;
  const remaining = oldest > 0 ? CIRCUIT_BREAKER_COOLDOWN_MS - (now - oldest) : CIRCUIT_BREAKER_COOLDOWN_MS;
  const clamped = Math.max(CB_RETRY_WAIT_MS, Math.min(remaining + 500, CIRCUIT_BREAKER_COOLDOWN_MS + 1_000));
  return clamped;
}

// ── Concurrency Cap ──────────────────────────────────────────────────────

export function checkVoiceConcurrencyCap(): boolean {
  const count = getActiveVoiceRunCount();
  if (count >= MAX_CONCURRENT_VOICE_RUNS) {
    log.warn(`[VoiceConcurrency] cap reached: ${count}/${MAX_CONCURRENT_VOICE_RUNS} voice runs active — rejecting new run`);
    return true;
  }
  log.log(`[VoiceConcurrency] OK: ${count}/${MAX_CONCURRENT_VOICE_RUNS} voice runs active`);
  return false;
}

// ── Active Executor Run Check ────────────────────────────────────────────

export function hasActiveExecutorRun(session: VoiceSession): boolean {
  return agentExecutor.hasActiveVoiceRun(
    session.chatSessionId || "",
    voiceSessionKey(session),
  );
}

// ── Wait for Blocker to Clear ────────────────────────────────────────────

export async function waitForBlockerToClear(
  session: VoiceSession,
  currentTurn: number,
  reason: string,
): Promise<boolean> {
  const maxRetries = reason === "circuit_breaker" ? CB_MAX_RETRIES + 1 : CB_MAX_RETRIES;
  const waitMs = reason === "circuit_breaker"
    ? computeCircuitBreakerWaitMs(session)
    : CB_RETRY_WAIT_MS;

  publishVoiceDiagnostic(session, "recovery", `Recovering from ${reason}…`, { turn: currentTurn, status: "active" });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const delay = attempt === 1 ? waitMs : CB_RETRY_WAIT_MS;
    log.log(`[CBRetry] attempt ${attempt}/${maxRetries} waiting ${delay}ms for blocker to clear reason=${reason} session=${session.id} turn=${currentTurn}`);
    await new Promise(resolve => setTimeout(resolve, delay));

    if (reason === "zombie_blocked") {
      const stillActive = hasActiveExecutorRun(session);
      if (!stillActive) {
        log.log(`[CBRetry] zombie cleared after attempt ${attempt} session=${session.id} turn=${currentTurn}`);
        publishVoiceDiagnostic(session, "recovery", `Recovered from ${reason}`, { turn: currentTurn, elapsedMs: attempt * CB_RETRY_WAIT_MS });
        return true;
      }
      agentExecutor.abortVoiceSession(
        session.chatSessionId || "",
        voiceSessionKey(session),
      );
    } else if (reason === "circuit_breaker") {
      if (!checkCircuitBreaker(session, currentTurn)) {
        log.log(`[CBRetry] circuit breaker cleared after attempt ${attempt} session=${session.id} turn=${currentTurn}`);
        publishVoiceDiagnostic(session, "recovery", `Recovered from ${reason}`, { turn: currentTurn, elapsedMs: attempt * CB_RETRY_WAIT_MS });
        return true;
      }
    } else if (reason === "concurrency_cap") {
      if (!checkVoiceConcurrencyCap()) {
        log.log(`[CBRetry] concurrency cap cleared after attempt ${attempt} session=${session.id} turn=${currentTurn}`);
        publishVoiceDiagnostic(session, "recovery", `Recovered from ${reason}`, { turn: currentTurn, elapsedMs: attempt * CB_RETRY_WAIT_MS });
        return true;
      }
    }
  }
  publishVoiceDiagnostic(session, "recovery", `Recovery failed for ${reason}`, { turn: currentTurn, status: "error" });
  log.warn(`[CBRetry] blocker NOT cleared after ${maxRetries} retries reason=${reason} session=${session.id} turn=${currentTurn}`);
  return false;
}
