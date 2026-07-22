import type { Principal } from "../principal";
import type { FileSession } from "../chat-file-storage";
import { chatStorage } from "../integrations/chat/storage";
import { leaveRecallBot } from "../integrations/recall/client";
import { createLogger } from "../log";
import { principalOwnsMeeting } from "./owner-principal";
import { withMeetingTransportLock } from "./locks";

const log = createLogger("MeetingLeave");

export type MeetingLeaveResult =
  | { outcome: "requested" | "already_leaving"; session: FileSession }
  | { outcome: "not_found" }
  | { outcome: "not_leaveable"; session: FileSession }
  | { outcome: "failed"; error: string };

/** Canonical owner-scoped path for requesting that a meeting transport depart. */
export async function requestMeetingBotLeave(
  sessionId: string,
  principal: Principal,
): Promise<MeetingLeaveResult> {
  const session = await chatStorage.getSession(sessionId);
  if (!session || !principalOwnsMeeting(principal, session)) {
    return { outcome: "not_found" };
  }

  return withMeetingTransportLock(sessionId, async () => {
    const lockedSession = await chatStorage.getSession(sessionId);
    if (!lockedSession || !principalOwnsMeeting(principal, lockedSession)) {
      return { outcome: "not_found" };
    }
    const claim = await chatStorage.claimMeetingLeave(sessionId);
    if (claim.outcome === "not_meeting") return { outcome: "not_found" };
    if (claim.outcome === "already_leaving") {
      return { outcome: "already_leaving", session: claim.session };
    }
    if (claim.outcome === "not_leaveable") {
      return { outcome: "not_leaveable", session: claim.session };
    }

    const botId = claim.session.meeting?.botId;
    if (!botId) {
      await chatStorage.restoreMeetingLeave(
        sessionId,
        claim.previousStatus,
        "No Recall bot is attached to this meeting",
      );
      return { outcome: "failed", error: "This meeting has no Recall bot attached" };
    }

    try {
      await leaveRecallBot(botId);
      log.info(`departure requested sessionId=${sessionId} botId=${botId}`);
      return { outcome: "requested", session: claim.session };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await chatStorage.restoreMeetingLeave(sessionId, claim.previousStatus, detail);
      log.error(`departure request failed sessionId=${sessionId}: ${detail}`);
      return { outcome: "failed", error: detail };
    }
  });
}
