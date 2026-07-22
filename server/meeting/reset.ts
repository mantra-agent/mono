import type { Principal } from "../principal";
import type { FileSession } from "../chat-file-storage";
import type { MeetingBotStatus } from "@shared/models/chat";
import { chatStorage } from "../integrations/chat/storage";
import { eventBus } from "../event-bus";
import { leaveRecallBot } from "../integrations/recall/client";
import { createLogger } from "../log";
import { principalOwnsMeeting } from "./owner-principal";
import { withMeetingTransportLock } from "./locks";
import { MeetingJoinError, meetingPlatform, createMeetingRecallBot } from "./join";
import { createMeetingRecognitionLaunchPlan, meetingRecognitionLaunchMeta } from "./stt";
import { syncMeetingVisualizerBotStatus } from "./output-media";

const log = createLogger("MeetingReset");

/** How the bot is recovered — one discriminant per decision, computed at source. */
export type MeetingResetStrategy = "in_place" | "rejoin";

export type MeetingResetResult =
  | { outcome: "recovered_in_place" | "rejoining"; strategy: MeetingResetStrategy; session: FileSession }
  | { outcome: "already_resetting"; session: FileSession }
  | { outcome: "not_found" }
  | { outcome: "not_recoverable"; session: FileSession; reason: string }
  | { outcome: "failed"; error: string };

/** Bot is present in the call — recover recognition without a new bot. */
const IN_PLACE_STATUSES: MeetingBotStatus[] = ["live"];
/** A join/rejoin is already converging — resetting again would risk two bots. */
const JOINING_STATUSES: MeetingBotStatus[] = ["dialing", "in_lobby"];

/**
 * Canonical owner-scoped meeting recovery. Chooses the smallest recovery that
 * fits the current bot state and preserves meeting/session identity:
 *
 *  - in_place: the bot is live, so re-arm speech recognition in place (no new
 *    bot). Idempotent — re-emitting the reset signal simply rebuilds again.
 *  - rejoin: the bot has left/failed/ended, so tell any stale bot to leave and
 *    dispatch a fresh Recall bot bound to the SAME session, reusing the stored
 *    meeting URL, speaker policy, participants, agenda, and calendar identity.
 *
 * Serialized with leave via the shared transport lock so recovery and departure
 * can never interleave into conflicting lifecycles.
 */
export async function requestMeetingBotReset(
  sessionId: string,
  principal: Principal,
): Promise<MeetingResetResult> {
  const session = await chatStorage.getSession(sessionId);
  if (!session?.meeting || !principalOwnsMeeting(principal, session)) {
    return { outcome: "not_found" };
  }

  return withMeetingTransportLock(sessionId, async () => {
    const locked = await chatStorage.getSession(sessionId);
    if (!locked?.meeting || !principalOwnsMeeting(principal, locked)) {
      return { outcome: "not_found" };
    }
    const meeting = locked.meeting;

    if (IN_PLACE_STATUSES.includes(meeting.botStatus)) {
      eventBus.publish({
        category: "voice",
        event: "meeting.recognition.reset",
        payload: { sessionId },
        audience: principal.userId && principal.accountId
          ? { scope: "user", ownerUserId: principal.userId, accountId: principal.accountId }
          : { scope: "system" },
      });
      const updated = await chatStorage.updateMeetingMeta(sessionId, {
        statusDetail: "Reconnecting speech recognition…",
      });
      syncMeetingVisualizerBotStatus(sessionId, "live");
      log.info(`meeting reset in place sessionId=${sessionId} botId=${meeting.botId ?? "none"}`);
      return { outcome: "recovered_in_place", strategy: "in_place", session: updated ?? locked };
    }

    if (JOINING_STATUSES.includes(meeting.botStatus)) {
      return { outcome: "already_resetting", session: locked };
    }

    // rejoin: bot is gone (leaving/denied/failed/ended). Recreate it on this session.
    if (!meeting.meetingUrl) {
      return {
        outcome: "not_recoverable",
        session: locked,
        reason: "This meeting has no join URL to reconnect to.",
      };
    }

    // Best-effort: tell any stale bot to leave so we never leave a zombie in the
    // call. 404s are tolerated by the client — the bot may already be gone.
    if (meeting.botId) {
      try {
        await leaveRecallBot(meeting.botId);
      } catch (error) {
        log.warn(
          `prior bot leave during reset failed sessionId=${sessionId} botId=${meeting.botId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const platform = meetingPlatform(meeting.meetingUrl);
    const recognitionLaunch = createMeetingRecognitionLaunchPlan(meeting.speakerPolicy);

    // Mark dialing before dispatch so the UI shows progress and any concurrent
    // caller sees a join already in flight. endedAt is explicitly cleared so a
    // previously ended meeting reads as live again.
    await chatStorage.updateMeetingMeta(sessionId, {
      botStatus: "dialing",
      statusDetail: "Reconnecting Mantra to the meeting…",
      endedAt: undefined,
      ...meetingRecognitionLaunchMeta(recognitionLaunch),
    });
    syncMeetingVisualizerBotStatus(sessionId, "dialing");

    let dispatch: { botId: string; outputMediaUrl: string };
    try {
      dispatch = await createMeetingRecallBot({
        sessionId,
        meetingUrl: meeting.meetingUrl,
        recognitionLaunch,
      });
    } catch (error) {
      const detail = error instanceof MeetingJoinError || error instanceof Error
        ? error.message
        : String(error);
      await chatStorage.updateMeetingMeta(sessionId, {
        botStatus: "failed",
        statusDetail: detail,
        endedAt: new Date().toISOString(),
      });
      log.error(`meeting rejoin dispatch failed sessionId=${sessionId}: ${detail}`);
      return { outcome: "failed", error: detail };
    }

    const updated = await chatStorage.updateMeetingMeta(sessionId, {
      botId: dispatch.botId,
      outputMediaUrl: dispatch.outputMediaUrl,
    });
    log.info(`meeting rejoin dispatched sessionId=${sessionId} botId=${dispatch.botId} platform=${platform}`);
    return { outcome: "rejoining", strategy: "rejoin", session: updated ?? locked };
  });
}
