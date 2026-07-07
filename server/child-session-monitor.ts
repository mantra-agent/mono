/**
 * Shared child session monitor — polls a child session until it resolves,
 * fails, or goes idle. Extracted from plan-executor.ts so both plans and
 * workflows can share the same parent-owned lifecycle monitoring.
 */

import { createLogger } from "./log";
import { eventBus } from "./event-bus";

const log = createLogger("child-session-monitor");

// ─── Constants ───────────────────────────────────────────────────────

export const IDLE_POLL_INTERVAL_MS = 5_000;
/** After this many consecutive poll errors, the monitor rejects */
export const MAX_CONSECUTIVE_POLL_ERRORS = 5;

// ─── MonitorResult discriminated union ───────────────────────────────

export type MonitorResult =
  | { status: "completed"; output: string }
  | { status: "failed"; reason: FailureReason; message: string }
  | { status: "idle_timeout"; idleMinutes: number; abortingComponent: string; message: string };

export type FailureReason =
  | "child_session_failed"
  | "child_session_not_found"
  | "aborted"
  | "poll_errors_exceeded";

async function failChildSessionClosed(sessionId: string, endReason: string): Promise<void> {
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    await chatFileStorage.setEndReason(sessionId, endReason).catch(() => undefined);
    await chatFileStorage.updateSessionStatus(sessionId, "failed");
  } catch (err) {
    log.warn(
      `[monitor] Failed to mark child session ${sessionId} failed after ${endReason}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Monitor ─────────────────────────────────────────────────────────

/**
 * Poll a child session until it resolves, fails, or goes idle.
 *
 * The parent owns the lifecycle — the child just does its work and finishes.
 * The parent watches, detects completion, extracts the output, and records
 * the result. The child never needs to call an explicit "I'm done" tool.
 */
export async function monitorChildSession(
  sessionId: string,
  idleTimeoutMs: number,
  abortSignal?: AbortSignal,
  parentSessionId?: string,
): Promise<MonitorResult> {
  const { chatFileStorage } = await import("./chat-file-storage");
  const { agentExecutor } = await import("./agent-executor");

  let lastActivityAt = Date.now();
  let lastUpdatedAt: string | undefined;
  let consecutivePollErrors = 0;

  return new Promise<MonitorResult>((resolve) => {
    const pollTimer = setInterval(async () => {
      try {
        // Check if parent was aborted
        if (abortSignal?.aborted) {
          cleanup();
          agentExecutor.abortByChatSessionId(sessionId, "cancelled");
          await failChildSessionClosed(sessionId, "cancelled");
          resolve({ status: "failed", reason: "aborted", message: "Parent execution was aborted" });
          return;
        }

        const session = await chatFileStorage.getSession(sessionId);
        if (!session) {
          cleanup();
          resolve({ status: "failed", reason: "child_session_not_found", message: `Child session ${sessionId} not found` });
          return;
        }

        // Reset consecutive error counter on successful poll
        consecutivePollErrors = 0;

        const sessionStatus = (session as { status?: string }).status;
        const updatedAt = (session as { updatedAt?: string }).updatedAt;

        // Detect activity: if updatedAt changed, the session is still working.
        if (updatedAt && updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = updatedAt;
          lastActivityAt = Date.now();
        }

        // Also treat the live executor run as activity. Long tool calls may not
        // persist chat messages while they run, but agentExecutor.activeRuns is
        // heartbeated by stream/tool activity. Without this, sessions doing
        // legitimate long-running tool work can be falsely killed as idle.
        const activeRun = agentExecutor.getActiveRuns()
          .filter((run) => run.sessionId === sessionId && !run.aborted)
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
        if (activeRun && activeRun.lastActivityAt > lastActivityAt) {
          lastActivityAt = activeRun.lastActivityAt;
        }

        // Child is alive — heartbeat the parent run so its zombie detector
        // sees the parent as active while children do the work.
        if (parentSessionId) {
          agentExecutor.heartbeatRunBySessionId(parentSessionId);
        }

        // Check completion states. The child session row's status is the
        // lifecycle source of truth.
        if (sessionStatus === "saved") {
          cleanup();
          const output = await readFinalAssistantOutput(sessionId);
          const completedOutput = output || "Completed successfully";
          eventBus.publish({
            category: "session",
            event: "child_session.completed",
            payload: {
              childSessionId: sessionId,
              sessionStatus,
              outputLength: completedOutput.length,
              hasAssistantOutput: Boolean(output),
            },
          });
          resolve({ status: "completed", output: completedOutput });
          return;
        }
        if (sessionStatus === "failed") {
          cleanup();
          const failure = await readChildFailureMessage(sessionId);
          resolve({
            status: "failed",
            reason: "child_session_failed",
            message: failure || `Session ${sessionId} failed`,
          });
          return;
        }

        // Check idle timeout — add one poll interval margin to avoid
        // false positives from slow-but-active sessions
        const idleMs = Date.now() - lastActivityAt;
        const effectiveTimeout = idleTimeoutMs + IDLE_POLL_INTERVAL_MS;
        if (idleMs >= effectiveTimeout) {
          cleanup();
          const idleMinutes = Math.round(idleMs / 60000);
          const message = `Child session monitor saw no session or executor activity for ${idleMinutes}m`;
          log.warn(`[monitor] Session ${sessionId} idle for ${idleMinutes}m — aborting with idle_timeout`);
          agentExecutor.abortByChatSessionId(sessionId, "idle_timeout");
          await failChildSessionClosed(sessionId, "idle_timeout");
          resolve({ status: "idle_timeout", idleMinutes, abortingComponent: "child-session-monitor", message });
          return;
        }
      } catch (err) {
        consecutivePollErrors++;
        log.warn(
          `[monitor] Poll error ${consecutivePollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS} for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );

        // Reject after too many consecutive poll errors
        if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          cleanup();
          await failChildSessionClosed(sessionId, "poll_errors_exceeded");
          resolve({
            status: "failed",
            reason: "poll_errors_exceeded",
            message: `${MAX_CONSECUTIVE_POLL_ERRORS} consecutive poll errors — last: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
    }, IDLE_POLL_INTERVAL_MS);

    function cleanup() {
      clearInterval(pollTimer);
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Read the last assistant message from a child session.
 */
export async function readFinalAssistantOutput(sessionId: string): Promise<string | undefined> {
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    const messages = await chatFileStorage.getMessagesBySession(sessionId);
    if (!messages || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string; content?: string };
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0) return m.content;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a failure message from a child session, combining endReason with
 * the last assistant output when available.
 */
export async function readChildFailureMessage(sessionId: string): Promise<string | undefined> {
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    const session = await chatFileStorage.getSession(sessionId);
    const endReason = (session as { endReason?: string } | null)?.endReason;
    if (endReason && endReason !== "complete" && endReason !== "error") {
      const output = await readFinalAssistantOutput(sessionId);
      return output ? `${endReason}: ${truncateOutput(output)}` : endReason;
    }
    return await readFinalAssistantOutput(sessionId);
  } catch {
    return await readFinalAssistantOutput(sessionId);
  }
}

/**
 * Truncate output text for use in outcome summaries.
 */
export function truncateOutput(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
