/**
 * Shared engagement day-series producers.
 *
 * Dashboard heatmaps and queryMetric adapters must call these collectors —
 * never reimplement counts. Residual rides on MetricCoverage (partial when
 * calendar is down; unbound when Wellness is inactive is handled by the
 * wellness adapter before calling here).
 */
import { and, gte, lt, sql } from "drizzle-orm";
import { tasks, wellnessLogs, type CalendarEventMetadata } from "@shared/schema";
import { db } from "../db";
import type { Principal } from "../principal";
import { queryNonMeetingInteractionEventSeries } from "../interaction-activity";
import { combineWithTaskAccess } from "../project-vault-access";
import { combineWithSensitiveVisible } from "../sensitive-scope";
import { userDateStr, userDayBounds } from "../utils/user-time";
import { createLogger } from "../log";
import { classifyEventByTitle, listMetadataByEvents, makeMetaKey } from "../calendar-metadata";
import { listAllEvents, type CalendarEvent } from "../google-calendar";
import { listGmailAccounts } from "../gmail";
import { calendarOccurrenceKey } from "../meeting/identity";
import { TTLCache } from "../utils/ttl-cache";
import type { MetricCoverage } from "@shared/models/metrics";

const log = createLogger("EngagementSeries");
const CALENDAR_INTERACTION_CACHE_TTL_MS = 15 * 60_000;
const CALENDAR_INTERACTION_MAX_EVENTS = 2500;
const CALENDAR_METADATA_BATCH_SIZE = 100;
export const INTERACTION_TRACKING_START_DATE = "2026-06-02";

const calendarInteractionCache = new TTLCache<Map<string, number>>(
  "DashboardCalendarInteractions",
  CALENDAR_INTERACTION_CACHE_TTL_MS,
);

const wellnessLogScope = {
  ownerUserId: wellnessLogs.ownerUserId,
  principalAccountId: wellnessLogs.principalAccountId,
};

const taskScope = {
  objectId: tasks.id,
  projectId: tasks.projectId,
  scope: tasks.scope,
  ownerUserId: tasks.ownerUserId,
  accountId: tasks.accountId,
};

export async function queryWellnessSeries(
  start: Date,
  end: Date,
  principal: Principal,
): Promise<Map<string, number>> {
  const localDate = sql<string>`to_char(${wellnessLogs.completedAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ date: localDate, value: sql<number>`count(*)::int` })
    .from(wellnessLogs)
    .where(
      combineWithSensitiveVisible(
        wellnessLogScope,
        and(gte(wellnessLogs.completedAt, start), lt(wellnessLogs.completedAt, end)),
        principal,
      ),
    )
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

export async function queryAchievedGoalSeries(
  start: Date,
  end: Date,
  _principal: Principal,
): Promise<Map<string, number>> {
  const { goalStorage } = await import("../goal-storage");
  const startMs = start.getTime();
  const endMs = end.getTime();
  const dayMap = new Map<string, number>();
  const goals = await goalStorage.listGoals({ includeDormant: true });
  for (const goal of goals) {
    if (goal.status !== "achieved" || !goal.completedAt) continue;
    const completed = new Date(goal.completedAt);
    const completedMs = completed.getTime();
    if (!Number.isFinite(completedMs) || completedMs < startMs || completedMs >= endMs) continue;
    const date = userDateStr(completed);
    dayMap.set(date, (dayMap.get(date) ?? 0) + 1);
  }
  return dayMap;
}

export async function queryTaskSeries(
  start: Date,
  end: Date,
  principal: Principal,
): Promise<Map<string, number>> {
  const localDate = sql<string>`to_char(${tasks.completedAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ date: localDate, value: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      combineWithTaskAccess(
        principal,
        taskScope,
        "read",
        and(gte(tasks.completedAt, start), lt(tasks.completedAt, end)),
      ),
    )
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

function externalAttendeeEmails(event: CalendarEvent, selfEmails: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      event.attendees
        .filter((attendee) => !attendee.self)
        .map((attendee) => attendee.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email) && !selfEmails.has(email)),
    ),
  ];
}

function wasDeclinedByUser(event: CalendarEvent, selfEmails: ReadonlySet<string>): boolean {
  const selfAttendee = event.attendees.find(
    (attendee) => attendee.self || selfEmails.has(attendee.email?.trim().toLowerCase() || ""),
  );
  return selfAttendee?.responseStatus === "declined";
}

function eventEnd(event: CalendarEvent): Date | null {
  if (event.end.date) return userDayBounds(event.end.date).start;
  if (!event.end.dateTime) return null;
  const value = new Date(event.end.dateTime);
  return Number.isNaN(value.getTime()) ? null : value;
}

function eventStartDate(event: CalendarEvent): string | null {
  if (event.start.date) return event.start.date;
  if (!event.start.dateTime) return null;
  const value = new Date(event.start.dateTime);
  return Number.isNaN(value.getTime()) ? null : userDateStr(value);
}

async function queryCalendarMeetingSeries(
  startDate: string,
  endDate: string,
  principal: Principal,
  selfEmails: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const principalKey = [
    principal.actorType,
    principal.accountId || "no-account",
    principal.userId || "no-user",
  ].join(":");
  const selfEmailKey = [...selfEmails].sort().join(",");
  const cacheKey = `${principalKey}:${selfEmailKey}:${startDate}:${endDate}`;
  return calendarInteractionCache.getOrFetch(cacheKey, async () => {
    const rangeStart = userDayBounds(startDate).start;
    const rangeEnd = userDayBounds(endDate).end;
    const completionCutoff = new Date(Math.min(rangeEnd.getTime(), Date.now()));
    const { events, errors } = await listAllEvents({
      timeMin: rangeStart.toISOString(),
      timeMax: new Date(rangeEnd.getTime() + 1).toISOString(),
      maxResults: CALENDAR_INTERACTION_MAX_EVENTS,
    });
    if (errors.length > 0) {
      log.warn("Dashboard calendar interactions loaded with account errors", {
        errorCount: errors.length,
        eventCount: events.length,
      });
    }

    const candidates = events.filter((event) => {
      if (
        event.status === "cancelled" ||
        wasDeclinedByUser(event, selfEmails) ||
        externalAttendeeEmails(event, selfEmails).length === 0
      ) {
        return false;
      }
      const endedAt = eventEnd(event);
      return endedAt !== null && endedAt.getTime() <= completionCutoff.getTime();
    });
    const eventIdentities = candidates.map((event) => ({
      googleEventId: event.id,
      accountId: event.accountId,
      calendarId: event.calendarId,
    }));
    const metadata: CalendarEventMetadata[] = [];
    for (let offset = 0; offset < eventIdentities.length; offset += CALENDAR_METADATA_BATCH_SIZE) {
      metadata.push(
        ...(await listMetadataByEvents(
          eventIdentities.slice(offset, offset + CALENDAR_METADATA_BATCH_SIZE),
        )),
      );
    }
    const metadataByEvent = new Map(
      metadata.map((row) => [makeMetaKey(row.googleEventId, row.accountId, row.calendarId), row]),
    );
    const eventKeysByDate = new Map<string, Set<string>>();

    for (const event of candidates) {
      const storedType = metadataByEvent.get(
        makeMetaKey(event.id, event.accountId, event.calendarId),
      )?.eventType;
      const eventType = storedType || classifyEventByTitle(event.summary) || "meeting";
      if (eventType !== "meeting") continue;
      const date = eventStartDate(event);
      if (!date) continue;
      if (date < startDate || date > endDate) continue;
      const keys = eventKeysByDate.get(date) ?? new Set<string>();
      keys.add(calendarOccurrenceKey(event));
      eventKeysByDate.set(date, keys);
    }

    return new Map([...eventKeysByDate].map(([date, keys]) => [date, keys.size]));
  });
}

function sumSeries(...series: Map<string, number>[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const values of series) {
    for (const [date, value] of values) result.set(date, (result.get(date) ?? 0) + value);
  }
  return result;
}

export interface InteractionSeriesResult {
  series: Map<string, number>;
  coverage: MetricCoverage;
}

/**
 * Person events ∪ ended external calendar meetings from INTERACTION_TRACKING_START_DATE.
 * Calendar failure returns persisted person events only with coverage=partial.
 */
export async function queryInteractionSeries(
  startDate: string,
  endDate: string,
  principal: Principal,
): Promise<InteractionSeriesResult> {
  if (endDate < INTERACTION_TRACKING_START_DATE) {
    return { series: new Map(), coverage: { status: "finalized" } };
  }
  const interactionStartDate =
    startDate < INTERACTION_TRACKING_START_DATE ? INTERACTION_TRACKING_START_DATE : startDate;
  const accounts = await listGmailAccounts();
  const selfEmails = new Set(
    accounts.map((account) => account.email.trim().toLowerCase()).filter(Boolean),
  );
  let calendarPartial = false;
  const [interactionEvents, calendarMeetings] = await Promise.all([
    queryNonMeetingInteractionEventSeries(interactionStartDate, endDate, selfEmails, principal),
    queryCalendarMeetingSeries(interactionStartDate, endDate, principal, selfEmails).catch(
      (error) => {
        calendarPartial = true;
        log.warn(
          "Dashboard calendar interactions unavailable; returning persisted interaction events",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return new Map<string, number>();
      },
    ),
  ]);
  return {
    series: sumSeries(interactionEvents, calendarMeetings),
    coverage: calendarPartial
      ? {
          status: "partial",
          availableFrom: null,
          reason: "Calendar unavailable; persisted person interaction events only.",
        }
      : { status: "finalized" },
  };
}
