import { BOOT_ID } from "../db";
import { agentExecutor } from "../agent-executor";
import { chatStorage } from "../integrations/chat/storage";
import { chatRunLifecycle } from "../integrations/chat/run-lifecycle";
import { createLogger } from "../log";
import { createNamedSystemPrincipal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { sessionManager } from "../session-manager";
import {
  assessMeetingTurnCompleteness,
  inferMeetingParticipation,
} from "./addressed-turn";
import { runWithMeetingOwnerIdentity } from "./owner-principal";
import {
  claimPendingMeetingTurnExecution,
  claimReadyMeetingTurn,
  deferIncompleteMeetingTurn,
  failMeetingParticipation,
  finishMeetingTurnExecution,
  failPendingAffinityMeetingTurns,
  listActionableMeetingSessions,
  recordMeetingParticipation,
  recoverStaleMeetingTurnClaims,
  releaseMeetingTurnExecutionClaim,
  type MeetingTurnOwnerIdentity,
  type MeetingTurnRecord,
} from "./turn-queue";

const log = createLogger("MeetingTurnCoordinator");
const IDLE_POLL_MS = 2_000;
const BUSY_POLL_MS = 250;

export interface MeetingTurnExecutionSettlement {
  status: "completed" | "failed";
  assistantMessageId?: string;
  error?: string;
}

export interface MeetingTurnExecutionRequest {
  turn: MeetingTurnRecord;
  sessionKey: string;
  sessionId: string;
  content: string;
  sayAloud: boolean;
  onResponse?: (content: string) => Promise<void> | void;
  runGeneration?: number;
  currentMessageIds: string[];
  onSettled: (settlement: MeetingTurnExecutionSettlement) => Promise<void>;
}

export interface MeetingTurnCoordinator {
  schedule(delayMs?: number): void;
  registerPhoneResponse(
    sessionId: string,
    callback: (content: string) => Promise<void>,
  ): void;
  unregisterPhoneResponse(sessionId: string): Promise<void>;
}

export function createMeetingTurnCoordinator(
  execute: (request: MeetingTurnExecutionRequest) => Promise<void>,
): MeetingTurnCoordinator {
  const phoneResponses = new Map<string, (content: string) => Promise<void>>();
  const workerPrincipal = createNamedSystemPrincipal("meeting-turn-worker");
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const schedule = (delayMs = 1_250): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
    timer.unref?.();
  };

  async function executeTurn(turn: MeetingTurnRecord): Promise<boolean> {
    if (
      chatRunLifecycle.current(turn.sessionId)
      || agentExecutor.hasActiveRunForSession(turn.sessionId)
    ) {
      await releaseMeetingTurnExecutionClaim(turn, "local chat run already active");
      return false;
    }
    const session = await chatStorage.getSession(turn.sessionId);
    if (!session?.meeting || session.type !== "meeting") {
      await finishMeetingTurnExecution({
        turn,
        status: "failed",
        error: "meeting session not found",
      });
      return false;
    }
    const isPhone = session.meeting.platform === "phone";
    const onResponse = isPhone ? phoneResponses.get(turn.sessionId) : undefined;
    if (isPhone && !onResponse) {
      await releaseMeetingTurnExecutionClaim(
        turn,
        `phone callback unavailable on boot ${BOOT_ID}`,
      );
      return false;
    }

    let runGeneration: number | undefined;
    try {
      runGeneration = sessionManager.registerSession(
        turn.sessionId,
        turn.sessionKey,
        "meeting",
      );
    } catch (error) {
      await releaseMeetingTurnExecutionClaim(
        turn,
        `runtime registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    await chatStorage
      .updateSessionStatus(turn.sessionId, "streaming")
      .catch((error) =>
        log.warn(
          `status update failed sessionId=${turn.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    void execute({
      turn,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      content: `[${turn.speakerLabel}] ${turn.prompt || turn.text}`,
      sayAloud: !isPhone,
      onResponse,
      runGeneration,
      currentMessageIds: turn.sourceMessageIds,
      onSettled: async (settlement) => {
        await finishMeetingTurnExecution({
          turn,
          status: settlement.status,
          assistantMessageId: settlement.assistantMessageId,
          error: settlement.error,
        });
        schedule(25);
      },
    }).catch(async (error) => {
      log.error(
        `execution failed sessionId=${turn.sessionId} turnId=${turn.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await finishMeetingTurnExecution({
        turn,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      schedule(25);
    });
    return true;
  }

  async function processSession(identity: MeetingTurnOwnerIdentity): Promise<boolean> {
    return runWithMeetingOwnerIdentity(identity, async () => {
      const ready = await claimReadyMeetingTurn(identity.sessionId);
      if (ready) {
        const completeness = ready.participationMode === "always"
          ? { complete: true, reason: "transport_completed_turn", confidence: 1 }
          : assessMeetingTurnCompleteness(
              ready.text,
              ready.completenessDeferrals,
            );
        log.debug(
          `completeness sessionId=${ready.sessionId} turnId=${ready.id} complete=${completeness.complete} reason=${completeness.reason} confidence=${completeness.confidence}`,
        );
        if (!completeness.complete) {
          await deferIncompleteMeetingTurn(ready);
          return true;
        }
        const session = await chatStorage.getSession(ready.sessionId);
        if (!session?.meeting) {
          await failMeetingParticipation(ready, "meeting session not found");
          return true;
        }
        try {
          // Listen Mode is a hard session-level mute: transcription and recap
          // continue, but no participation inference runs and no response is
          // generated, even for explicit invocations.
          const decision = session.meeting.participationPolicy === "listen_only"
            ? {
                outcome: "ignored" as const,
                shouldRespond: false,
                reason: "listen_only_policy",
                latencyMs: 0,
                confidence: 1,
              }
            : ready.participationMode === "always"
            ? {
                outcome: "explicit" as const,
                shouldRespond: true,
                reason: "transport_requires_response",
                latencyMs: 0,
                confidence: 1,
                prompt: ready.text,
              }
            : await inferMeetingParticipation({
                sessionId: ready.sessionId,
                sessionKey: ready.sessionKey,
                turnId: ready.id,
                currentMessageIds: ready.sourceMessageIds,
                text: ready.text,
                speakerLabel: ready.speakerLabel,
                participants: session.meeting.participants || [],
              });
          const recorded = await recordMeetingParticipation(ready, decision);
          log.info(
            `participation sessionId=${ready.sessionId} turnId=${ready.id} revision=${ready.revision} recorded=${recorded} outcome=${decision.outcome} shouldRespond=${decision.shouldRespond} reason=${decision.reason} latencyMs=${decision.latencyMs}`,
          );
          if (recorded === "superseded") return true;
        } catch (error) {
          await failMeetingParticipation(
            ready,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      const execution = await claimPendingMeetingTurnExecution(identity.sessionId);
      return execution ? executeTurn(execution) : Boolean(ready);
    });
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await runWithPrincipal(workerPrincipal, async () => {
        await recoverStaleMeetingTurnClaims();
        const sessions = await listActionableMeetingSessions(20);
        for (const identity of sessions) {
          try {
            await processSession(identity);
          } catch (error) {
            log.error(
              `drain failed sessionId=${identity.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });
    } finally {
      running = false;
      const remaining = await runWithPrincipal(workerPrincipal, () =>
        listActionableMeetingSessions(1),
      );
      schedule(remaining.length > 0 ? BUSY_POLL_MS : IDLE_POLL_MS);
    }
  }

  schedule(250);
  return {
    schedule,
    registerPhoneResponse(sessionId, callback) {
      phoneResponses.set(sessionId, callback);
    },
    async unregisterPhoneResponse(sessionId) {
      phoneResponses.delete(sessionId);
      const failed = await failPendingAffinityMeetingTurns(
        sessionId,
        BOOT_ID,
        "phone transport closed before response execution",
      );
      if (failed > 0) {
        log.warn(`failed ${failed} pending phone turn(s) sessionId=${sessionId} boot=${BOOT_ID}`);
      }
    },
  };
}
