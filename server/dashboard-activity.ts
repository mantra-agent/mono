import type { Principal } from "./principal";
import { queryMergedPrSeries } from "./integrations/merged-pr-ledger";
import { createLogger } from "./log";
import { userDayBounds } from "./utils/user-time";
import {
  queryInteractionSeries,
  queryTaskSeries,
  queryWellnessSeries,
} from "./metrics/engagement-series";

const log = createLogger("DashboardActivity");
const DASHBOARD_LOAD_BUDGET_MS = 1_000;

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
        const result = await queryInteractionSeries(dates[0], date, principal);
        return result.series;
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
