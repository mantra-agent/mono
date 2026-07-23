import { and, gte, lt, sql } from "drizzle-orm";
import { tasks, wellnessLogs } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { queryDistinctInteractionPeopleSeries } from "./interaction-activity";
import { combineWithWorkObjectAccess } from "./object-grant-access";
import { combineWithSensitiveVisible } from "./sensitive-scope";
import { userDayBounds } from "./utils/user-time";
import { fetchMergedPrsSince } from "./integrations/github-timeline";
import { createLogger } from "./log";

const log = createLogger("DashboardActivity");
const DASHBOARD_LOAD_BUDGET_MS = 1_000;

const wellnessLogScope = {
  ownerUserId: wellnessLogs.ownerUserId,
  principalAccountId: wellnessLogs.principalAccountId,
};

const taskScope = {
  objectId: tasks.id,
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

function recentDates(endDate: string, count: number): string[] {
  const end = new Date(`${endDate}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (count - index - 1));
    return day.toISOString().slice(0, 10);
  });
}

function increment(map: Map<string, number>, date: string): void {
  map.set(date, (map.get(date) ?? 0) + 1);
}

function localCalendarDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(value);
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
    .where(combineWithWorkObjectAccess(principal, taskScope, "task", "read", and(gte(tasks.completedAt, start), lt(tasks.completedAt, end))))
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
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
  source: ActivityDashboardSource = "all",
): Promise<ActivityDashboardResult> {
  const startedAt = performance.now();
  const timings: Partial<Record<ActivityDashboardKpi["key"], number>> = {};
  const dates = recentDates(date, 364);
  const rangeStart = userDayBounds(dates[0]).start;
  const selectedEnd = userDayBounds(date).end;
  const rangeEnd = new Date(selectedEnd.getTime() + 1);
  const includeCore = source !== "code";
  const includeCode = source !== "core";

  const corePromise = includeCore
    ? Promise.all([
        timedSource("opportunity_interactions", timings, () => queryDistinctInteractionPeopleSeries(dates[0], date, principal)),
        timedSource("wellness_completions", timings, () => queryWellnessSeries(rangeStart, rangeEnd, principal)),
        timedSource("completed_tasks", timings, () => queryTaskSeries(rangeStart, rangeEnd, principal)),
      ])
    : Promise.resolve([new Map<string, number>(), new Map<string, number>(), new Map<string, number>()] as const);
  const codePromise = includeCode
    ? timedSource("shipped_prs", timings, () => fetchMergedPrsSince(rangeStart))
    : Promise.resolve([]);
  const [[interactions, wellness, completedTasks], shippedPrs] = await Promise.all([corePromise, codePromise]);

  const shipped = new Map<string, number>();
  for (const pr of shippedPrs) increment(shipped, localCalendarDate(new Date(pr.mergedAt)));
  const countMaps: Record<ActivityDashboardKpi["key"], Map<string, number>> = {
    opportunity_interactions: interactions,
    wellness_completions: wellness,
    completed_tasks: completedTasks,
    shipped_prs: shipped,
  };
  const includedKeys = source === "core"
    ? new Set<ActivityDashboardKpi["key"]>(["opportunity_interactions", "wellness_completions", "completed_tasks"])
    : source === "code"
      ? new Set<ActivityDashboardKpi["key"]>(["shipped_prs"])
      : null;
  const series = KPI_DEFINITIONS
    .filter((definition) => !includedKeys || includedKeys.has(definition.key))
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      days: dates.map((day) => ({ date: day, value: countMaps[definition.key].get(day) ?? 0 })),
    }));
  const totalMs = Math.round(performance.now() - startedAt);
  const diagnostic = { date, source, totalMs, sourcesMs: timings };
  if (totalMs > DASHBOARD_LOAD_BUDGET_MS) {
    log.warn("Dashboard load exceeded latency budget", diagnostic);
  } else {
    log.debug("Dashboard load completed", diagnostic);
  }
  return {
    date,
    kpis: series.map((item) => ({ key: item.key, label: item.label, value: item.days.find((day) => day.date === date)?.value ?? 0 })),
    series,
  };
}
