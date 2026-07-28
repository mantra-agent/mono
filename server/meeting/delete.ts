import type { Principal } from "../principal";
import { chatStorage } from "../integrations/chat/storage";
import { leaveRecallBot } from "../integrations/recall/client";
import { principalOwnsMeeting } from "./owner-principal";
import { withMeetingTransportLock } from "./locks";

export type MeetingDeletionResult =
  | { outcome: "deleted"; deletedSessionIds: string[]; descendantCount: number }
  | { outcome: "not_found" }
  | { outcome: "transport_failed"; error: string };

const ACTIVE_RECALL_STATUSES = new Set(["dialing", "in_lobby", "live"]);

/** Canonical owner-scoped meeting deletion path, including active transport teardown. */
export async function deleteMeetingSession(
  sessionId: string,
  principal: Principal,
): Promise<MeetingDeletionResult> {
  const session = await chatStorage.getSession(sessionId);
  if (!session?.meeting || !principalOwnsMeeting(principal, session)) {
    return { outcome: "not_found" };
  }

  return withMeetingTransportLock(sessionId, async () => {
    const lockedSession = await chatStorage.getSession(sessionId);
    if (!lockedSession?.meeting || !principalOwnsMeeting(principal, lockedSession)) {
      return { outcome: "not_found" };
    }

    const meeting = lockedSession.meeting;
    if (
      meeting.transport !== "native"
      && ACTIVE_RECALL_STATUSES.has(meeting.botStatus)
      && meeting.botId
    ) {
      try {
        await leaveRecallBot(meeting.botId);
      } catch (error) {
        return {
          outcome: "transport_failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const deleted = await chatStorage.deleteSession(sessionId);
    return { outcome: "deleted", ...deleted };
  });
}
