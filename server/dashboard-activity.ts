import { and, gte, lt, sql } from "drizzle-orm";
import { tasks, wellnessLogs, type CalendarEventMetadata } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { queryNonMeetingInteractionEventSeries } from "./interaction-activity";
import { combineWithTaskAccess } from "./project-vault-access";
import { combineWithSensitiveVisible } from "./sensitive-scope";
import { userDateStr, userDayBounds } from "./utils/user-time";
import { queryMergedPrSeries } from "./integrations/merged-pr-ledger";
import { createLogger } from "./log";
import { classifyEventByTitle, listMetadataByEvents, makeMetaKey } from "./calendar-metadata";
import { listAllEvents, type CalendarEvent } from "./google-calendar";
import { listGmailAccounts } from "./gmail";
import { calendarOccurrenceKey } from "./meeting/identity";
import { TTLCache } from "./utils/ttl-cache";

const log = createLogger("DashboardActivity");
const DASHBOARD_LOAD_BUDGET_MS = 1_000;
const CALENDAR_INTERACTION_CACHE_TTL_MS = 15 * 60_000;
const CALENDAR_INTERACTION_MAX_EVENTS = 2500;
const CALENDAR_METADATA_BATCH_SIZE = 100;
const INTERACTION_TRACKING_START_DATE = "2026-06-02";
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

export interface ActivityDashboardKpi {
  key: "opportunity_interactions" | "wellness_completions" | "completed_tasks" | "shipped_prs";
  label: string;
  value: number;
}

export interface ActivityDashboardSeries {
  key: ActivityDashboardKpi["key"];
  label: string;
  days: Array<{ date: string; value: number }>;
}

export interface ActivityDashboardResult {
  date: string;
  kpis: ActivityDashboardKpi[];
  series: ActivityDashboardSeries[];
}

export type ActivityDashboardSeriesKey = ActivityDashboardKpi["key"];

/** @deprecated Prefer seriesKeys allowlist from product composition. */
export type ActivityDashboardSource = "all" | "core" | "code";

const KPI_DEFINITIONS: ReadonlyArray<Pick<ActivityDashboardKpi, "key" | "label">> = [
  {
    key: "opportunity_interactions",
    label: "Opportunity interactions",
  },
  {
    key: "wellness_completions",
    label: "Wellness completions",
  },
  {
    key: "completed_tasks",
    label: "Completed tasks",
  },
  {
    key: "shipped_prs",
    label: "Shipped PRs",
  },
];

const ALL_SERIES_KEYS: ActivityDashboardSeriesKey[] = KPI_DEFINITIONS.map(
  (definition) => definition.key,
);

function normalizeSeriesKeys(
  seriesKeys: readonly string[] | undefined,
  source: ActivityDashboardSource | undefined,
): ActivityDashboardSeriesKey[] {
  const allowed = new Set<string>(ALL_SERIES_KEYS);
  if (seriesKeys && seriesKeys.length > 0) {
    const selected = new Set(
      seriesKeys
        .map((key) => key.trim())
        .filter((key): key is ActivityDashboardSeriesKey => allowed.has(key)),
    );
    return ALL_SERIES_KEYS.filter((key) => selected.has(key));
  }
  // Legacy source filter kept for transitional callers.
  if (source === "core") {
    return ALL_SERIES_KEYS.filter((key) => key !== "shipped_prs");
  }
  if (source === "code") {
    return ["shipped_prs"];
  }
  return [...ALL_SERIES_KEYS];
}

function recentDates(endDate: string, count: number): string[] {
  const end = new Date(`${endDate}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (count - index - 1));
    return day.toISOString().slice(0, 10);
  });
}

async function queryWellnessSeries(start: Date, end: Date, principal: Principal): Promise<Map<string, number>> {
  const localDate = sql<string>`to_char(${wellnessLogs.completedAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ date: localDate, value: sql<number>`count(*)::int` })
    .from(wellnessLogs)
    .where(combineWithSensitiveVisible(wellnessLogScope, and(gte(wellnessLogs.completedAt, start), lt(wellnessLogs.completedAt, end)), principal))
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

async function queryTaskSeries(start: Date, end: Date, principal: Principal): Promise<Map<string, number>> {
  const localDate = sql<string>`to_char(${tasks.completedAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ date: localDate, value: sql<number>`count(*)::int` })
    .from(tasks)
    .where(combineWithTaskAccess(principal, taskScope, "read", and(gte(tasks.completedAt, start), lt(tasks.completedAt, end))))
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

function externalAttendeeEmails(event: CalendarEvent, selfEmails: ReadonlySet<string>): string[] {
  return [...new Set(event.attendees
    .filter((attendee) => !attendee.self)
    .map((attendee) => attendee.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email) && !selfEmails.has(email)))];
}

function wasDeclinedByUser(event: CalendarEvent, selfEmails: ReadonlySet<string>): boolean {
  const selfAttendee = event.attendees.find((attendee) =>
    attendee.self || selfEmails.has(attendee.email?.trim().toLowerCase() || ""),
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
  const principalKey = [principal.actorType, principal.accountId || "no-account", principal.userId || "no-user"].join(":");
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
        event.status === "cancelled"
        || wasDeclinedByUser(event, selfEmails)
        || externalAttendeeEmails(event, selfEmails).length === 0
      ) return false;
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
      metadata.push(...await listMetadataByEvents(eventIdentities.slice(offset, offset + CALENDAR_METADATA_BATCH_SIZE)));
    }
    const metadataByEvent = new Map(metadata.map((row) => [makeMetaKey(row.googleEventId, row.accountId, row.calendarId), row]));
    const eventKeysByDate = new Map<string, Set<string>>();

    for (const event of candidates) {
      const storedType = metadataByEvent.get(makeMetaKey(event.id, event.accountId, event.calendarId))?.eventType;
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

async function timedSource<T>(
  source: ActivityDashboardKpi["key"],
  timings: Partial<Record<ActivityDashboardKpi["key"], number>>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings[source] = Math.round(performance.now() - startedAt);
  }
}

export async function queryActivityDashboard(
  date: string,
  principal: Principal,
  seriesKeysOrSource: readonly string[] | ActivityDashboardSource = "all",
): Promise<ActivityDashboardResult> {
  const startedAt = performance.now();
  const timings: Partial<Record<ActivityDashboardKpi["key"], number>> = {};
  const dates = recentDates(date, 364);
  const rangeStart = userDayBounds(dates[0]).start;
  const selectedEnd = userDayBounds(date).end;
  const rangeEnd = new Date(selectedEnd.getTime() + 1);

  const legacySource =
    typeof seriesKeysOrSource === "string" ? seriesKeysOrSource : undefined;
  const seriesKeys =
    Array.isArray(seriesKeysOrSource) ? seriesKeysOrSource : undefined;
  const includedKeys = new Set(normalizeSeriesKeys(seriesKeys, legacySource));
  const include = (key: ActivityDashboardSeriesKey) => includedKeys.has(key);

  const interactionsPromise = include("opportunity_interactions")
    ? timedSource("opportunity_interactions", timings, async () => {
        if (date < INTERACTION_TRACKING_START_DATE) return new Map<string, number>();
        const interactionStartDate =
          dates[0] < INTERACTION_TRACKING_START_DATE
            ? INTERACTION_TRACKING_START_DATE
            : dates[0];
        const accounts = await listGmailAccounts();
        const selfEmails = new Set(
          accounts.map((account) => account.email.trim().toLowerCase()).filter(Boolean),
        );
        const [interactionEvents, calendarMeetings] = await Promise.all([
          queryNonMeetingInteractionEventSeries(
            interactionStartDate,
            date,
            selfEmails,
            principal,
          ),
          queryCalendarMeetingSeries(
            interactionStartDate,
            date,
            principal,
            selfEmails,
          ).catch((error) => {
            log.warn(
              "Dashboard calendar interactions unavailable; returning persisted interaction events",
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return new Map<string, number>();
          }),
        ]);
        return sumSeries(interactionEvents, calendarMeetings);
      })
    : Promise.resolve(new Map<string, number>());

  const wellnessPromise = include("wellness_completions")
    ? timedSource("wellness_completions", timings, () =>
        queryWellnessSeries(rangeStart, rangeEnd, principal),
      )
    : Promise.resolve(new Map<string, number>());

  const tasksPromise = include("completed_tasks")
    ? timedSource("completed_tasks", timings, () =>
        queryTaskSeries(rangeStart, rangeEnd, principal),
      )
    : Promise.resolve(new Map<string, number>());

  const shippedPromise = include("shipped_prs")
    ? timedSource("shipped_prs", timings, () => queryMergedPrSeries(rangeStart, rangeEnd))
    : Promise.resolve(new Map<string, number>());

  const [interactions, wellness, completedTasks, shipped] = await Promise.all([
    interactionsPromise,
    wellnessPromise,
    tasksPromise,
    shippedPromise,
  ]);

  const countMaps: Record<ActivityDashboardKpi["key"], Map<string, number>> = {
    opportunity_interactions: interactions,
    wellness_completions: wellness,
    completed_tasks: completedTasks,
    shipped_prs: shipped,
  };
  const series = KPI_DEFINITIONS.filter((definition) => include(definition.key)).map(
    (definition) => ({
      key: definition.key,
      label: definition.label,
      days: dates.map((day) => ({
        date: day,
        value: countMaps[definition.key].get(day) ?? 0,
      })),
    }),
  );
  const totalMs = Math.round(performance.now() - startedAt);
  const diagnostic = {
    date,
    seriesKeys: [...includedKeys],
    totalMs,
    sourcesMs: timings,
  };
  if (totalMs > DASHBOARD_LOAD_BUDGET_MS) {
    log.warn("Dashboard load exceeded latency budget", diagnostic);
  } else {
    log.debug("Dashboard load completed", diagnostic);
  }
  return {
    date,
    kpis: series.map((item) => ({
      key: item.key,
      label: item.label,
      value: item.days.find((day) => day.date === date)?.value ?? 0,
    })),
    series,
  };
}
