import { getAccount, updateAccount } from "../../connected-accounts";
import { upsertHealthMetricsAndProcessCompletions } from "../../routes/wellness";
import { createLogger } from "../../log";
import { userDateStr } from "../../utils/user-time";
import { fetchOuraCollection, OuraApiError } from "./client";
import {
  mapOuraDailyActivity,
  mapOuraDailyReadiness,
  mapOuraDailySleep,
  mapOuraHeartRate,
  mapOuraSessions,
  mapOuraSleepSessions,
  mapOuraWorkouts,
} from "./mapping";
import type {
  OuraDailyActivity,
  OuraDailyReadiness,
  OuraDailySleep,
  OuraHeartRateSample,
  OuraSession,
  OuraSleepSession,
  OuraWorkout,
} from "./types";

const log = createLogger("OuraSync");

export type OuraSyncMode = "initial" | "incremental";

export interface OuraSyncMetadata {
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastSyncMode?: OuraSyncMode;
  lastSyncStartDate?: string;
  lastSyncEndDate?: string;
  lastSyncInserted?: number;
  lastSyncMetricRows?: number;
  lastSyncCompletionsLogged?: number;
  lastSyncCompletionsUpgraded?: number;
  lastSyncError?: string | null;
}

export interface OuraPermissionsWithSync {
  scopes?: string[];
  sync?: OuraSyncMetadata;
  [key: string]: unknown;
}

export interface OuraSyncResult {
  accountId: string;
  mode: OuraSyncMode;
  startDate: string;
  endDate: string;
  fetched: Record<string, number>;
  metricRows: number;
  inserted: number;
  completions: { logged: number; upgraded: number };
}

interface DatasetSyncSummary {
  dataset: string;
  fetched: number;
  metricRows: number;
}

function classifyOuraSyncError(error: unknown): string {
  if (error instanceof OuraApiError) return error.code;
  if (error instanceof Error) return error.name || "error";
  return typeof error;
}

function summarizeDatasets(datasets: DatasetSyncSummary[]): string {
  return datasets
    .map((dataset) => `${dataset.dataset}:fetched=${dataset.fetched},rows=${dataset.metricRows}`)
    .join(" ");
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}

function dateRangeForMode(mode: OuraSyncMode): { startDate: string; endDate: string } {
  const end = new Date();
  const start = addDays(end, mode === "initial" ? -30 : -3);
  return { startDate: userDateStr(start), endDate: userDateStr(end) };
}

function resolvePermissions(value: unknown): OuraPermissionsWithSync {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

async function persistSyncMetadata(accountId: string, metadata: OuraSyncMetadata): Promise<void> {
  const account = await getAccount(accountId);
  const current = resolvePermissions(account?.permissions);
  await updateAccount(accountId, {
    permissions: {
      ...current,
      sync: {
        ...(current.sync && typeof current.sync === "object" ? current.sync : {}),
        ...metadata,
      },
    },
  });
}

async function fetchRange<T>(accountId: string, path: string, startDate: string, endDate: string): Promise<T[]> {
  return fetchOuraCollection<T>({
    accountId,
    path,
    params: { start_date: startDate, end_date: endDate },
    maxPages: 10,
  });
}

export async function syncOuraAccount(input: { accountId: string; mode?: OuraSyncMode }): Promise<OuraSyncResult> {
  const mode = input.mode ?? "incremental";
  const { startDate, endDate } = dateRangeForMode(mode);
  const startedAt = new Date().toISOString();

  log.log(`sync start accountId=${input.accountId} mode=${mode} range=${startDate}..${endDate}`);

  try {
    const [dailyReadiness, dailySleep, sleep, dailyActivity, workouts, sessions, heartRate] = await Promise.all([
      fetchRange<OuraDailyReadiness>(input.accountId, "/v2/usercollection/daily_readiness", startDate, endDate),
      fetchRange<OuraDailySleep>(input.accountId, "/v2/usercollection/daily_sleep", startDate, endDate),
      fetchRange<OuraSleepSession>(input.accountId, "/v2/usercollection/sleep", startDate, endDate),
      fetchRange<OuraDailyActivity>(input.accountId, "/v2/usercollection/daily_activity", startDate, endDate),
      fetchRange<OuraWorkout>(input.accountId, "/v2/usercollection/workout", startDate, endDate),
      fetchRange<OuraSession>(input.accountId, "/v2/usercollection/session", startDate, endDate),
      fetchRange<OuraHeartRateSample>(input.accountId, "/v2/usercollection/heartrate", startDate, endDate),
    ]);

    const mappedDatasets = [
      { dataset: "daily_readiness", fetched: dailyReadiness.length, rows: mapOuraDailyReadiness(dailyReadiness) },
      { dataset: "daily_sleep", fetched: dailySleep.length, rows: mapOuraDailySleep(dailySleep) },
      { dataset: "sleep", fetched: sleep.length, rows: mapOuraSleepSessions(sleep) },
      { dataset: "daily_activity", fetched: dailyActivity.length, rows: mapOuraDailyActivity(dailyActivity) },
      { dataset: "workout", fetched: workouts.length, rows: mapOuraWorkouts(workouts) },
      { dataset: "session", fetched: sessions.length, rows: mapOuraSessions(sessions) },
      { dataset: "heartrate", fetched: heartRate.length, rows: mapOuraHeartRate(heartRate) },
    ];
    const metricRows = mappedDatasets.flatMap((dataset) => dataset.rows);
    const datasetSummaries: DatasetSyncSummary[] = mappedDatasets.map((dataset) => ({
      dataset: dataset.dataset,
      fetched: dataset.fetched,
      metricRows: dataset.rows.length,
    }));
    log.log(`sync datasets accountId=${input.accountId} mode=${mode} range=${startDate}..${endDate} ${summarizeDatasets(datasetSummaries)}`);

    const upsert = await upsertHealthMetricsAndProcessCompletions(metricRows, {
      logPrefix: "[OuraSync]",
      swallowCompletionErrors: false,
    });

    const result: OuraSyncResult = {
      accountId: input.accountId,
      mode,
      startDate,
      endDate,
      fetched: Object.fromEntries(datasetSummaries.map((dataset) => [dataset.dataset, dataset.fetched])),
      metricRows: metricRows.length,
      inserted: upsert.inserted,
      completions: upsert.bridge,
    };

    await persistSyncMetadata(input.accountId, {
      lastSyncAt: startedAt,
      lastSuccessfulSyncAt: new Date().toISOString(),
      lastSyncMode: mode,
      lastSyncStartDate: startDate,
      lastSyncEndDate: endDate,
      lastSyncInserted: result.inserted,
      lastSyncMetricRows: result.metricRows,
      lastSyncCompletionsLogged: result.completions.logged,
      lastSyncCompletionsUpgraded: result.completions.upgraded,
      lastSyncError: null,
    });
    await updateAccount(input.accountId, { healthy: true, healthError: null, healthCheckedAt: new Date() });

    log.log(`sync complete accountId=${input.accountId} mode=${mode} range=${startDate}..${endDate} metricRows=${result.metricRows} inserted=${result.inserted} completionsLogged=${result.completions.logged} completionsUpgraded=${result.completions.upgraded}`);
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = classifyOuraSyncError(error);
    await persistSyncMetadata(input.accountId, {
      lastSyncAt: startedAt,
      lastSyncMode: mode,
      lastSyncStartDate: startDate,
      lastSyncEndDate: endDate,
      lastSyncError: message,
    });
    await updateAccount(input.accountId, {
      healthy: false,
      healthError: error instanceof OuraApiError ? error.code : message,
      healthCheckedAt: new Date(),
    });
    log.warn(`sync failed accountId=${input.accountId} mode=${mode} range=${startDate}..${endDate} errorClass=${errorClass} message=${message}`);
    throw error;
  }
}
