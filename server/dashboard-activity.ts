import { and, gte, lt } from "drizzle-orm";
import { opportunityInteractions, tasks, wellnessLogs } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { peopleStorage } from "./people-storage";
import { combineWithVisibleScope } from "./scoped-storage";
import { combineWithSensitiveVisible } from "./sensitive-scope";
import { userDayBounds } from "./utils/user-time";
import { fetchMergedPrsSince } from "./integrations/github-timeline";

const opportunityInteractionScope = {
  scope: opportunityInteractions.scope,
  ownerUserId: opportunityInteractions.ownerUserId,
  accountId: opportunityInteractions.accountId,
};

const wellnessLogScope = {
  ownerUserId: wellnessLogs.ownerUserId,
  principalAccountId: wellnessLogs.principalAccountId,
};

const taskScope = {
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

async function queryOpportunitySeries(principal: Principal): Promise<Map<string, number>> {
  const links = await db
    .select({ personId: opportunityInteractions.personId, interactionId: opportunityInteractions.interactionId })
    .from(opportunityInteractions)
    .where(combineWithVisibleScope(principal, opportunityInteractionScope));
  const distinctLinks = new Map(links.map((link) => [`${link.personId}:${link.interactionId}`, link]));
  const people = await peopleStorage.getPeopleByIds([...new Set(links.map((link) => link.personId))]);
  const counts = new Map<string, number>();
  for (const person of people) {
    for (const interaction of person.interactions) {
      if (distinctLinks.has(`${person.id}:${interaction.id}`)) increment(counts, interaction.date);
    }
  }
  return counts;
}

async function queryWellnessSeries(start: Date, end: Date, principal: Principal): Promise<Map<string, number>> {
  const rows = await db
    .select({ completedAt: wellnessLogs.completedAt })
    .from(wellnessLogs)
    .where(combineWithSensitiveVisible(wellnessLogScope, and(gte(wellnessLogs.completedAt, start), lt(wellnessLogs.completedAt, end)), principal));
  const counts = new Map<string, number>();
  for (const row of rows) increment(counts, localCalendarDate(row.completedAt));
  return counts;
}

async function queryTaskSeries(start: Date, end: Date, principal: Principal): Promise<Map<string, number>> {
  const rows = await db
    .select({ completedAt: tasks.completedAt })
    .from(tasks)
    .where(combineWithVisibleScope(principal, taskScope, and(gte(tasks.completedAt, start), lt(tasks.completedAt, end))));
  const counts = new Map<string, number>();
  for (const row of rows) if (row.completedAt) increment(counts, localCalendarDate(row.completedAt));
  return counts;
}

export async function queryActivityDashboard(date: string, principal: Principal): Promise<ActivityDashboardResult> {
  const dates = recentDates(date, 84);
  const rangeStart = userDayBounds(dates[0]).start;
  const selectedEnd = userDayBounds(date).end;
  const rangeEnd = new Date(selectedEnd.getTime() + 1);
  const [opportunities, wellness, completedTasks, shippedPrs] = await Promise.all([
    queryOpportunitySeries(principal),
    queryWellnessSeries(rangeStart, rangeEnd, principal),
    queryTaskSeries(rangeStart, rangeEnd, principal),
    fetchMergedPrsSince(rangeStart),
  ]);
  const shipped = new Map<string, number>();
  for (const pr of shippedPrs) increment(shipped, localCalendarDate(new Date(pr.mergedAt)));
  const countMaps: Record<ActivityDashboardKpi["key"], Map<string, number>> = {
    opportunity_interactions: opportunities,
    wellness_completions: wellness,
    completed_tasks: completedTasks,
    shipped_prs: shipped,
  };
  const series = KPI_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    days: dates.map((day) => ({ date: day, value: countMaps[definition.key].get(day) ?? 0 })),
  }));
  return {
    date,
    kpis: series.map((item) => ({ key: item.key, label: item.label, value: item.days.find((day) => day.date === date)?.value ?? 0 })),
    series,
  };
}
