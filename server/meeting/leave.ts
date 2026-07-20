import { createHash } from "crypto";
import type { Principal } from "../principal";
import { pool } from "../db";
import type { FileSession } from "../chat-file-storage";
import { chatStorage } from "../integrations/chat/storage";
import { leaveRecallBot } from "../integrations/recall/client";
import { createLogger } from "../log";
import { principalOwnsMeeting } from "./owner-principal";

const log = createLogger("MeetingLeave");

function leaveLockKey(sessionId: string): bigint {
  const hash = createHash("sha256").update(`meeting-leave:${sessionId}`).digest();
  let key = 0n;
  for (let index = 0; index < 8; index += 1) {
    key = (key << 8n) | BigInt(hash[index]);
  }
  return key & 0x7fffffffffffffffn;
}

async function withMeetingLeaveLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const key = leaveLockKey(sessionId);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
    } catch {
      log.warn(`failed to release departure lock sessionId=${sessionId}`);
    }
    client.release();
  }
}

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

  return withMeetingLeaveLock(sessionId, async () => {
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
