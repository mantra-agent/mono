/**
 * Meeting auto-join scheduler.
 *
 * Every tick, scans calendar_event_metadata for events with the agent
 * toggle enabled whose start time falls inside the due window, atomically
 * claims each row, re-fetches the event under the owning user's principal,
 * and dispatches the canonical meeting join path (server/meeting/join.ts).
 *
 * Outcomes are recorded on the metadata row via the single discriminant
 * agent_join_status ("scheduled" | "no_link" | "joined" | "failed") with a
 * human-visible agent_join_detail.
 */
import { createLogger } from "../log";
import {
  listDueAgentJoins,
  claimAgentJoin,
  updateAgentJoinOutcome,
} from "../calendar-metadata";
import { getEvent } from "../google-calendar";
import { runWithPrincipal } from "../principal-context";
import { createUserPrincipalFromUser } from "../principal";
import { storage } from "../storage";
import { extractMeetingUrl, joinMeetingByUrl, MeetingJoinError } from "./join";

const log = createLogger("meeting-auto-join");

/** How early before start time a join may fire. */
const LEAD_MS = 60_000;
/** How long after start time a missed join is still attempted (covers restarts). */
const GRACE_MS = 10 * 60_000;
/** Tick cadence. */
export const TICK_INTERVAL_MS = 60_000;
/** If the event start moved further than this into the future, reschedule instead of joining. */
const RESCHEDULE_THRESHOLD_MS = 60_000;

let tickInFlight = false;

export async function runMeetingAutoJoinTick(): Promise<void> {
  if (tickInFlight) {
    log.debug("Skipping tick — previous tick still in flight");
    return;
  }
  tickInFlight = true;
  try {
    const now = new Date();
    const due = await listDueAgentJoins(now, GRACE_MS, LEAD_MS);
    if (due.length === 0) return;
    log.info("Due agent auto-joins found", { count: due.length });

    for (const row of due) {
      const claimed = await claimAgentJoin(row.id, now);
      if (!claimed) {
        log.debug("Row already claimed by another tick", { metadataId: row.id });
        continue;
      }
      try {
        await processDueJoin(row);
      } catch (error) {
        log.error("Agent auto-join processing failed", {
          metadataId: row.id,
          googleEventId: row.googleEventId,
          error: error instanceof Error ? error.message : String(error),
        });
        await updateAgentJoinOutcome(row.id, {
          status: "failed",
          detail:
            error instanceof Error ? error.message : "Unknown auto-join failure",
        }).catch(() => {});
      }
    }
  } catch (error) {
    log.error("Meeting auto-join tick failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    tickInFlight = false;
  }
}

type DueJoinRow = Awaited<ReturnType<typeof listDueAgentJoins>>[number];

async function processDueJoin(row: DueJoinRow): Promise<void> {
  if (!row.ownerUserId) {
    await updateAgentJoinOutcome(row.id, {
      status: "failed",
      detail: "No owning user on calendar metadata row",
    });
    return;
  }
  const user = await storage.getUser(row.ownerUserId);
  if (!user) {
    await updateAgentJoinOutcome(row.id, {
      status: "failed",
      detail: "Owning user not found",
    });
    return;
  }
  if (!row.principalAccountId) {
    await updateAgentJoinOutcome(row.id, {
      status: "failed",
      detail: "No principal account on calendar metadata row",
    });
    return;
  }
  const principal = createUserPrincipalFromUser(user, row.principalAccountId);

  await runWithPrincipal(principal, async () => {
    // Re-fetch the event at fire time: catches link-added-later and reschedules.
    let location: string | undefined;
    let description: string | undefined;
    let summary: string | undefined;
    let startDateTime: string | undefined;
    try {
      const event = await getEvent(row.accountId, row.calendarId, row.googleEventId);
      location = event.location ?? undefined;
      description = event.description ?? undefined;
      summary = event.summary ?? undefined;
      startDateTime = event.start?.dateTime ?? undefined;
      if (event.status === "cancelled") {
        await updateAgentJoinOutcome(row.id, {
          status: "failed",
          detail: "Event was cancelled",
        });
        return;
      }
    } catch (error) {
      log.warn("Could not re-fetch event at join time — using stored data", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Reschedule if the event moved into the future.
    if (startDateTime) {
      const newStart = new Date(startDateTime);
      const storedStart = row.agentJoinStartAt ? new Date(row.agentJoinStartAt) : null;
      if (
        newStart.getTime() > Date.now() + LEAD_MS + RESCHEDULE_THRESHOLD_MS &&
        (!storedStart || Math.abs(newStart.getTime() - storedStart.getTime()) > RESCHEDULE_THRESHOLD_MS)
      ) {
        log.info("Event start moved — rescheduling agent auto-join", {
          metadataId: row.id,
          googleEventId: row.googleEventId,
          newStart: newStart.toISOString(),
        });
        await updateAgentJoinOutcome(row.id, {
          status: "scheduled",
          detail: null,
          startAt: newStart,
          attemptedAt: null,
        });
        return;
      }
    }

    const meetingUrl = extractMeetingUrl(location, description, summary);
    if (!meetingUrl) {
      await updateAgentJoinOutcome(row.id, {
        status: "no_link",
        detail: "No Zoom or Google Meet link found on this event at join time",
      });
      log.warn("Agent auto-join skipped — no resolvable meeting link", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
      });
      return;
    }

    try {
      const result = await joinMeetingByUrl({
        meetingUrl,
        title: summary || "Meeting",
      });
      await updateAgentJoinOutcome(row.id, {
        status: "joined",
        detail: null,
        sessionId: result.sessionId,
      });
      log.info("Agent auto-joined meeting", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
        sessionId: result.sessionId,
        botId: result.botId,
        platform: result.platform,
      });
    } catch (error) {
      const detail =
        error instanceof MeetingJoinError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown join failure";
      await updateAgentJoinOutcome(row.id, { status: "failed", detail });
      log.error("Agent auto-join dispatch failed", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
        detail,
      });
    }
  });
}
