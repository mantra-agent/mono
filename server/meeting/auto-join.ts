/**
 * Meeting auto-join scheduler.
 *
 * Each tick first discovers upcoming calendar meetings under each owning user's
 * principal and materializes policy decisions into calendar metadata. It then
 * atomically claims due rows and dispatches the canonical meeting join path.
 */
import { createLogger } from "../log";
import {
  listDueAgentJoins,
  claimAgentJoin,
  updateAgentJoinOutcome,
  listMetadataByEvents,
  setAgentJoin,
} from "../calendar-metadata";
import { getEvent, listAllEvents, type CalendarEvent } from "../google-calendar";
import { runWithPrincipal } from "../principal-context";
import { createUserPrincipalFromUser, resolveUserIdentityFoundation } from "../principal";
import { storage } from "../storage";
import { joinMeetingByUrl, MeetingJoinError } from "./join";
import { meetingUrlForEvent } from "./identity";
import { getMeetingJoinPolicy, shouldJoinMeeting } from "./join-policy";

const log = createLogger("meeting-auto-join");

const LEAD_MS = 60_000;
const GRACE_MS = 10 * 60_000;
const DISCOVERY_LOOKAHEAD_MS = 15 * 60_000;
const DISCOVERY_MAX_EVENTS = 50;
export const TICK_INTERVAL_MS = 60_000;
const RESCHEDULE_THRESHOLD_MS = 60_000;

let tickInFlight = false;

function startAt(event: CalendarEvent): Date | null {
  if (!event.start.dateTime) return null;
  const value = new Date(event.start.dateTime);
  return Number.isNaN(value.getTime()) ? null : value;
}

async function discoverUserSchedules(user: Awaited<ReturnType<typeof storage.getUsers>>[number], now: Date): Promise<void> {
  const foundation = await resolveUserIdentityFoundation(user.id);
  const principal = createUserPrincipalFromUser(user, foundation.accountId);

  await runWithPrincipal(principal, async () => {
    const policy = await getMeetingJoinPolicy(user.id);
    const { events, errors } = await listAllEvents({
      timeMin: new Date(now.getTime() - GRACE_MS).toISOString(),
      timeMax: new Date(now.getTime() + DISCOVERY_LOOKAHEAD_MS).toISOString(),
      maxResults: DISCOVERY_MAX_EVENTS,
    });
    for (const error of errors) {
      log.warn("Calendar account failed during meeting discovery", {
        ownerUserId: user.id,
        accountId: error.accountId,
        error: error.message,
      });
    }

    const candidates = events.filter((event) => event.status !== "cancelled" && startAt(event));
    const metadata = await listMetadataByEvents(candidates.map((event) => ({
      googleEventId: event.id,
      accountId: event.accountId,
      calendarId: event.calendarId,
    })));
    const byEvent = new Map(metadata.map((row) => [
      `${row.googleEventId}::${row.accountId}::${row.calendarId}`,
      row,
    ]));

    for (const event of candidates) {
      const existing = byEvent.get(`${event.id}::${event.accountId}::${event.calendarId}`);
      const override = existing?.agentJoinOverride ?? null;
      const enabled = shouldJoinMeeting(event, policy, override);
      const eventStart = startAt(event);
      if (!eventStart) continue;
      const meetingUrl = meetingUrlForEvent(event);
      const scheduleUnchanged =
        existing?.agentJoinEnabled === enabled &&
        existing?.agentJoinOverride === override &&
        existing?.agentJoinStartAt?.getTime() === (enabled ? eventStart.getTime() : undefined);
      if (scheduleUnchanged) continue;

      await setAgentJoin(event.id, event.accountId, event.calendarId, enabled, {
        override,
        status: enabled ? meetingUrl ? "scheduled" : "no_link" : null,
        detail: enabled && !meetingUrl ? "No Zoom or Google Meet link found on this event" : null,
        sessionId: enabled ? undefined : null,
        startAt: enabled ? eventStart : null,
      });
    }
  });
}

async function discoverUpcomingMeetingSchedules(now: Date): Promise<void> {
  const users = await storage.getUsers();
  for (const user of users) {
    try {
      await discoverUserSchedules(user, now);
    } catch (error) {
      log.error("Meeting auto-join discovery failed for user", {
        ownerUserId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function runMeetingAutoJoinTick(): Promise<void> {
  if (tickInFlight) {
    log.debug("Skipping tick because previous tick is still in flight");
    return;
  }
  tickInFlight = true;
  try {
    const now = new Date();
    await discoverUpcomingMeetingSchedules(now);
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
          detail: error instanceof Error ? error.message : "Unknown auto-join failure",
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
    await updateAgentJoinOutcome(row.id, { status: "failed", detail: "No owning user on calendar metadata row" });
    return;
  }
  const user = await storage.getUser(row.ownerUserId);
  if (!user) {
    await updateAgentJoinOutcome(row.id, { status: "failed", detail: "Owning user not found" });
    return;
  }
  if (!row.principalAccountId) {
    await updateAgentJoinOutcome(row.id, { status: "failed", detail: "No principal account on calendar metadata row" });
    return;
  }
  const principal = createUserPrincipalFromUser(user, row.principalAccountId);

  await runWithPrincipal(principal, async () => {
    let event: CalendarEvent | null = null;
    try {
      event = await getEvent(row.accountId, row.calendarId, row.googleEventId);
      if (event.status === "cancelled") {
        await updateAgentJoinOutcome(row.id, { status: "failed", detail: "Event was cancelled" });
        return;
      }
    } catch (error) {
      const detail = `Could not re-fetch calendar event at join time: ${error instanceof Error ? error.message : String(error)}`;
      await updateAgentJoinOutcome(row.id, { status: "failed", detail });
      log.error("Could not re-fetch event at join time", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
        detail,
      });
      return;
    }

    if (event) {
      const policy = await getMeetingJoinPolicy(user.id);
      if (!shouldJoinMeeting(event, policy, row.agentJoinOverride)) {
        await setAgentJoin(row.googleEventId, row.accountId, row.calendarId, false, {
          override: row.agentJoinOverride,
          sessionId: null,
          startAt: null,
          attemptedAt: null,
        });
        return;
      }

      const newStart = startAt(event);
      const storedStart = row.agentJoinStartAt ? new Date(row.agentJoinStartAt) : null;
      if (
        newStart &&
        newStart.getTime() > Date.now() + LEAD_MS + RESCHEDULE_THRESHOLD_MS &&
        (!storedStart || Math.abs(newStart.getTime() - storedStart.getTime()) > RESCHEDULE_THRESHOLD_MS)
      ) {
        log.info("Event start moved; rescheduling agent auto-join", {
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

    const meetingUrl = event ? meetingUrlForEvent(event) : null;
    if (!meetingUrl) {
      await updateAgentJoinOutcome(row.id, {
        status: "no_link",
        detail: "No Zoom or Google Meet link found on this event at join time",
      });
      log.warn("Agent auto-join skipped because no meeting link was found", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
      });
      return;
    }

    try {
      const result = await joinMeetingByUrl({
        meetingUrl,
        title: event?.summary || "Meeting",
        agenda: row.agenda ?? undefined,
        explicitEvent: {
          accountId: event.accountId,
          calendarId: event.calendarId,
          providerEventId: event.id,
          eventStart: event.start.dateTime || event.start.date || undefined,
          eventEnd: event.end.dateTime || event.end.date || undefined,
          title: event.summary || undefined,
          agenda: row.agenda ?? undefined,
          attendees: event.attendees,
        },
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
      const detail = error instanceof MeetingJoinError
        ? error.message
        : error instanceof Error ? error.message : "Unknown join failure";
      const sessionId = error instanceof MeetingJoinError ? error.sessionId : undefined;
      await updateAgentJoinOutcome(row.id, { status: "failed", detail, sessionId });
      log.error("Agent auto-join dispatch failed", {
        metadataId: row.id,
        googleEventId: row.googleEventId,
        detail,
      });
    }
  });
}
