/**
 * Shared child session monitor — polls a child session until it resolves,
 * fails, or goes idle. Extracted from plan-executor.ts so both plans and
 * workflows can share the same parent-owned lifecycle monitoring.
 *
 * Invariant: an open Question is not terminal work. The monitor keeps
 * polling while the child has an unanswered Question tool call, whether the
 * session is still active or already marked saved after await_user. Human
 * judgment answers resume the child; only explicit acceptance gates
 * (plan needs_review) may complete a step without further child work.
 */

import { createLogger } from "./log";
import { eventBus } from "./event-bus";
import { POST_ABORT_DRAIN_GRACE_MS } from "./timeout";
import { hasUnansweredQuestion } from "./question-response";
import type { ChildMissionTerminalOutcome } from "@shared/models/chat";

const log = createLogger("child-session-monitor");

// ─── Constants ───────────────────────────────────────────────────────

export const IDLE_POLL_INTERVAL_MS = 5_000;
/** After this many consecutive poll errors, the monitor rejects */
export const MAX_CONSECUTIVE_POLL_ERRORS = 5;
/** Throttle "awaiting Question" info logs so open gates don't spam every poll. */
const AWAITING_QUESTION_LOG_INTERVAL_MS = 60_000;
/**
 * Abort first, then allow the executor's own bounded drain plus one poll margin
 * to prove the child is no longer capable of mutating state.
 */
export const CHILD_TERMINATION_CONFIRM_TIMEOUT_MS = POST_ABORT_DRAIN_GRACE_MS + IDLE_POLL_INTERVAL_MS;

// ─── MonitorResult discriminated union ───────────────────────────────

export type MonitorResult =
  | { status: "completed"; output: string; missionOutcome: ChildMissionTerminalOutcome }
  | { status: "failed"; reason: FailureReason; message: string; missionOutcome?: ChildMissionTerminalOutcome }
  | { status: "idle_timeout"; idleMinutes: number; abortingComponent: string; message: string }
  | { status: "termination_unconfirmed"; abortReason: "idle_timeout" | "cancelled"; waitedMs: number; message: string };

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

export async function abortAndConfirmChildTermination(
  sessionId: string,
  abortReason: "idle_timeout" | "cancelled",
): Promise<{ confirmed: boolean; waitedMs: number }> {
  const startedAt = Date.now();
  try {
    const { agentExecutor } = await import("./agent-executor");
    const abortedRuns = agentExecutor.abortByChatSessionId(sessionId, abortReason);
    const deadline = startedAt + CHILD_TERMINATION_CONFIRM_TIMEOUT_MS;

    // Wait through both live execution AND post-run tool persistence settling.
    // hasActiveRunForSession alone has a gap: activeRuns is cleared before the
    // caller persists toolCalls, which is exactly when premature session.end
    // used to flip status to saved and hollow-complete plan steps.
    while (agentExecutor.isSessionBusy(sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
    }

    const waitedMs = Date.now() - startedAt;
    const confirmed = !agentExecutor.isSessionBusy(sessionId);
    const logMessage =
      `[monitor] Child termination ${confirmed ? "confirmed" : "unconfirmed"} session=${sessionId} ` +
      `abortReason=${abortReason} abortedRuns=${abortedRuns} waitedMs=${waitedMs}`;
    if (confirmed) log.debug(logMessage);
    else log.error(logMessage);
    return { confirmed, waitedMs };
  } catch (err) {
    const waitedMs = Date.now() - startedAt;
    log.error(
      `[monitor] Child termination check failed session=${sessionId} abortReason=${abortReason} ` +
      `waitedMs=${waitedMs}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { confirmed: false, waitedMs };
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
  const { admissionController } = await import("./run-admission");

  let lastActivityAt = Date.now();
  let lastUpdatedAt: string | undefined;
  let consecutivePollErrors = 0;
  let lastAwaitingQuestionLogAt = 0;

  return new Promise<MonitorResult>((resolve) => {
    let settling = false;
    const pollTimer = setInterval(async () => {
      if (settling) return;
      try {
        // Check if parent was aborted
        if (abortSignal?.aborted) {
          if (!beginSettlement()) return;
          const termination = await abortAndConfirmChildTermination(sessionId, "cancelled");
          if (!termination.confirmed) {
            resolve({
              status: "termination_unconfirmed",
              abortReason: "cancelled",
              waitedMs: termination.waitedMs,
              message: `Parent execution was aborted, but child session ${sessionId} remained active after the bounded termination wait`,
            });
            return;
          }
          await failChildSessionClosed(sessionId, "cancelled");
          resolve({ status: "failed", reason: "aborted", message: "Parent execution was aborted" });
          return;
        }

        const session = await chatFileStorage.getSession(sessionId);
        if (!session) {
          if (!beginSettlement()) return;
          const termination = await abortAndConfirmChildTermination(sessionId, "cancelled");
          if (!termination.confirmed) {
            resolve({
              status: "termination_unconfirmed",
              abortReason: "cancelled",
              waitedMs: termination.waitedMs,
              message: `Child session ${sessionId} was not found, but its active executor could not be terminated`,
            });
            return;
          }
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

        // Waiting for admission is healthy queued work, not executor silence.
        // Keep both the child idle clock and parent heartbeat alive until the
        // admission controller grants capacity. The admission request itself
        // remains bounded and will surface a real failure if it expires.
        const queuedAdmission = admissionController.getQueuedRequestForSession(sessionId);
        if (queuedAdmission) {
          lastActivityAt = Date.now();
          log.debug(
            `[monitor] Session ${sessionId} waiting for ${queuedAdmission.tier} admission ` +
            `(run=${queuedAdmission.runId}${queuedAdmission.activity ? ` activity=${queuedAdmission.activity}` : ""})`,
          );
        }

        // Child is alive — heartbeat the parent run so its zombie detector
        // sees the parent as active while children do the work.
        if (parentSessionId) {
          agentExecutor.heartbeatRunBySessionId(parentSessionId);
        }

        // Check completion states. The child session row's status is the
        // lifecycle source of truth — but only after the run is no longer busy
        // (live or settling tools). A mid-run session.end can write "saved"
        // before toolCalls are durable; ignore it until isSessionBusy is false.
        if (sessionStatus === "saved" && agentExecutor.isSessionBusy(sessionId)) {
          log.debug(
            `[monitor] Session ${sessionId} status=saved while still busy — waiting for tool persistence`,
          );
          return;
        }

        // Open Question is not terminal. await_user ends the agent run as
        // "saved" while the human answer is outstanding; keep polling so the
        // answer can resume the child and finish real step work.
        const messages = await chatFileStorage.getMessagesBySession(sessionId);
        if (hasUnansweredQuestion(messages)) {
          lastActivityAt = Date.now();
          if (Date.now() - lastAwaitingQuestionLogAt >= AWAITING_QUESTION_LOG_INTERVAL_MS) {
            lastAwaitingQuestionLogAt = Date.now();
            log.info(
              `[monitor] Child session ${sessionId} has an open Question — ` +
                "keeping monitor alive until the human answers",
            );
          }
          return;
        }

        if (sessionStatus === "saved") {
          if (!beginSettlement()) return;
          const output = await readFinalAssistantOutput(sessionId);
          const completedOutput = output || "Child session ended without a closing narration";
          const missionOutcome = (session as { childMissionOutcome?: ChildMissionTerminalOutcome }).childMissionOutcome;
          if (!missionOutcome) {
            resolve({
              status: "failed",
              reason: "child_session_failed",
              message: `Child session ${sessionId} ended without a source-owned mission terminal outcome`,
            });
            return;
          }
          eventBus.publish({
            category: "session",
            event: "child_session.completed",
            payload: {
              childSessionId: sessionId,
              sessionStatus,
              missionOutcome,
              outputLength: completedOutput.length,
              hasAssistantOutput: Boolean(output),
            },
          });
          resolve({ status: "completed", output: completedOutput, missionOutcome });
          return;
        }
        if (sessionStatus === "failed") {
          if (!beginSettlement()) return;
          const termination = await abortAndConfirmChildTermination(sessionId, "cancelled");
          if (!termination.confirmed) {
            resolve({
              status: "termination_unconfirmed",
              abortReason: "cancelled",
              waitedMs: termination.waitedMs,
              message: `Child session ${sessionId} was marked failed, but its active executor could not be terminated`,
            });
            return;
          }
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
          if (!beginSettlement()) return;
          const idleMinutes = Math.round(idleMs / 60000);
          const message = `Child session monitor saw no session or executor activity for ${idleMinutes}m`;
          log.warn(`[monitor] Session ${sessionId} idle for ${idleMinutes}m — aborting with idle_timeout`);
          const termination = await abortAndConfirmChildTermination(sessionId, "idle_timeout");
          if (!termination.confirmed) {
            resolve({
              status: "termination_unconfirmed",
              abortReason: "idle_timeout",
              waitedMs: termination.waitedMs,
              message: `${message}, and the child remained active after the bounded termination wait`,
            });
            return;
          }
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
          if (!beginSettlement()) return;
          const termination = await abortAndConfirmChildTermination(sessionId, "cancelled");
          if (!termination.confirmed) {
            resolve({
              status: "termination_unconfirmed",
              abortReason: "cancelled",
              waitedMs: termination.waitedMs,
              message: `${MAX_CONSECUTIVE_POLL_ERRORS} consecutive poll errors, and child termination could not be confirmed`,
            });
            return;
          }
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

    function beginSettlement(): boolean {
      if (settling) return false;
      settling = true;
      clearInterval(pollTimer);
      return true;
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
