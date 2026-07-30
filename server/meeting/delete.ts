import type { Principal } from "../principal";
import { chatStorage } from "../integrations/chat/storage";
import { leaveRecallBot } from "../integrations/recall/client";
import { createLogger } from "../log";
import { principalOwnsMeeting } from "./owner-principal";
import { deleteMeetingAudioForSession } from "./audio-retention";
import { withMeetingTransportLock } from "./locks";

const log = createLogger("MeetingDelete");

export type MeetingDeletionResult =
  | { outcome: "deleted"; deletedSessionIds: string[]; descendantCount: number }
  | { outcome: "not_found" };

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
      // Best-effort departure. A meeting can be stuck in a transient status
      // (dialing/in_lobby/live) long after its Recall bot has departed, timed
      // out, or been reclaimed — the durable session then lingers in the
      // Meetings active projection with no way to remove it. A remote leave
      // failure for a bot the owner no longer controls must never block the
      // owner from deleting their own session, so log and proceed to durable
      // deletion.
      try {
        await leaveRecallBot(meeting.botId);
      } catch (error) {
        log.warn(
          `best-effort Recall departure failed before deletion sessionId=${sessionId} botId=${meeting.botId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await deleteMeetingAudioForSession(sessionId);
    const deleted = await chatStorage.deleteSession(sessionId);
    return { outcome: "deleted", ...deleted };
  });
}
