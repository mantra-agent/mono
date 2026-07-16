// Use createLogger for logging ONLY
import { Pool, Client, types as pgTypes } from "pg";

// Treat `timestamp without time zone` (OID 1114) as UTC.
// PostgreSQL stores UTC values but node-postgres interprets them as local time,
// causing a +5h shift in America/Chicago. Appending 'Z' forces correct UTC parsing.
pgTypes.setTypeParser(1114, (str: string) => new Date(str + 'Z'));
import { AsyncLocalStorage } from "async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import {
  DB_POOL_MAX,
  DB_IDLE_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
  GENERAL_DB_POOL_MAX,
  GENERAL_DB_POOL_MIN,
  VOICE_DB_ACQUIRE_TIMEOUT_MS,
  VOICE_DB_POOL_MAX,
  VOICE_DB_POOL_MIN,
  VOICE_DB_STATEMENT_TIMEOUT_MS,
} from "./timeout";
import { createLogger } from "./log";
import { safeStringify, safeTruncate } from "./utils/safe-stringify";
import { getPostgresErrorCode, isRecoverablePostgresConnectionError } from "./postgres-errors";

const log = createLogger("DB");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

const DB_CONNECTION_TIMEOUT_MS = 5000;
const SLOW_QUERY_THRESHOLD_MS = 1000;
const HIGH_IN_FLIGHT_THRESHOLD = 10;
const HIGH_IN_FLIGHT_LOG_INTERVAL_MS = 10_000;
const LONG_RUNNING_THRESHOLD_MS = 500;
const LONG_RUNNING_MAX_ROWS = 20;

const SLOW_QUERY_WINDOW_MS = 10 * 60 * 1000;
const _slowQueryTimestamps: number[] = [];
let _lastSlowQueryAt: number | null = null;
let _lastSlowQueryDurationMs: number | null = null;

function recordSlowQuery(durationMs: number): void {
  const now = Date.now();
  _lastSlowQueryAt = now;
  _lastSlowQueryDurationMs = durationMs;
  _slowQueryTimestamps.push(now);
  const cutoff = now - SLOW_QUERY_WINDOW_MS;
  while (_slowQueryTimestamps.length > 0 && _slowQueryTimestamps[0] < cutoff) {
    _slowQueryTimestamps.shift();
  }
}

export function getSlowQueryStats(): {
  lastMinute: number;
  lastTenMinutes: number;
  lastSlowAt: number | null;
  lastSlowDurationMs: number | null;
  thresholdMs: number;
} {
  const now = Date.now();
  const cutoff = now - SLOW_QUERY_WINDOW_MS;
  while (_slowQueryTimestamps.length > 0 && _slowQueryTimestamps[0] < cutoff) {
    _slowQueryTimestamps.shift();
  }
  const minuteCutoff = now - 60_000;
  let lastMinute = 0;
  for (let i = _slowQueryTimestamps.length - 1; i >= 0; i--) {
    if (_slowQueryTimestamps[i] >= minuteCutoff) lastMinute++;
    else break;
  }
  return {
    lastMinute,
    lastTenMinutes: _slowQueryTimestamps.length,
    lastSlowAt: _lastSlowQueryAt,
    lastSlowDurationMs: _lastSlowQueryDurationMs,
    thresholdMs: SLOW_QUERY_THRESHOLD_MS,
  };
}

export function getInFlightHighThreshold(): number {
  return HIGH_IN_FLIGHT_THRESHOLD;
}

import { getAppNamePrefix } from "@shared/instance-config";
export const APP_NAME_PREFIX = getAppNamePrefix();
export const BOOT_ID =
  process.env.WATCHDOG_BOOT_ID ||
  `${Date.now().toString(36)}-${process.pid}`;
export const APP_NAME = `${APP_NAME_PREFIX}-${BOOT_ID}`;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: GENERAL_DB_POOL_MAX,
  min: GENERAL_DB_POOL_MIN,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  statement_timeout: DB_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: APP_NAME,
} as any);

export const voicePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: VOICE_DB_POOL_MAX,
  min: VOICE_DB_POOL_MIN,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  statement_timeout: VOICE_DB_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: VOICE_DB_ACQUIRE_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: `${APP_NAME}-voice`,
} as any);

type ConnectionIncidentLane = "general" | "voice";

type RecoverableConnectionIncident = {
  code: string;
  message: string;
  startedAt: number;
  count: number;
  lanes: Record<ConnectionIncidentLane, number>;
  timer: ReturnType<typeof setTimeout>;
};

let recoverableConnectionIncident: RecoverableConnectionIncident | null = null;

function flushRecoverableConnectionIncident(): void {
  const incident = recoverableConnectionIncident;
  recoverableConnectionIncident = null;
  if (!incident) return;
  log.warn(
    `transient connection incident code=${incident.code} affectedConnections=${incident.count} ` +
      `lanes=general:${incident.lanes.general},voice:${incident.lanes.voice} ` +
      `durationMs=${Date.now() - incident.startedAt} message=${incident.message} ` +
      `pool=general:${pool.totalCount}/${pool.idleCount}/${pool.waitingCount},voice:${voicePool.totalCount}/${voicePool.idleCount}/${voicePool.waitingCount}; pools will reconnect`,
  );
}

function handlePoolConnectionError(lane: ConnectionIncidentLane, error: Error): void {
  if (!isRecoverablePostgresConnectionError(error)) {
    log.error(`unexpected ${lane} connection error:`, error.message, error.stack);
    return;
  }

  const code = getPostgresErrorCode(error);
  const message = error.message;
  const existing = recoverableConnectionIncident;
  if (existing && existing.code === code && existing.message === message) {
    existing.count++;
    existing.lanes[lane]++;
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
    flushRecoverableConnectionIncident();
  }

  const timer = setTimeout(flushRecoverableConnectionIncident, 1_000);
  if (timer.unref) timer.unref();
  recoverableConnectionIncident = {
    code,
    message,
    startedAt: Date.now(),
    count: 1,
    lanes: { general: lane === "general" ? 1 : 0, voice: lane === "voice" ? 1 : 0 },
    timer,
  };
}

pool.on("error", (error) => handlePoolConnectionError("general", error));
voicePool.on("error", (error) => handlePoolConnectionError("voice", error));

let _healthInterval: ReturnType<typeof setInterval> | null = null;
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _saturationInterval: ReturnType<typeof setInterval> | null = null;

let _saturatedSinceMs: number | null = null;
let _lastSuccessfulProbeAt: number | null = null;
let _lastProbeDurationMs: number | null = null;

export function getDbSaturationInfo(): {
  saturatedSinceMs: number | null;
  saturatedForMs: number;
  lastSuccessfulProbeAt: number | null;
  lastProbeDurationMs: number | null;
  total: number;
  idle: number;
  waiting: number;
  general: { total: number; idle: number; waiting: number; max: number };
  voice: { total: number; idle: number; waiting: number; max: number };
} {
  return {
    saturatedSinceMs: _saturatedSinceMs,
    saturatedForMs: _saturatedSinceMs === null ? 0 : Date.now() - _saturatedSinceMs,
    lastSuccessfulProbeAt: _lastSuccessfulProbeAt,
    lastProbeDurationMs: _lastProbeDurationMs,
    total: pool.totalCount + voicePool.totalCount,
    idle: pool.idleCount + voicePool.idleCount,
    waiting: pool.waitingCount + voicePool.waitingCount,
    general: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: GENERAL_DB_POOL_MAX },
    voice: { total: voicePool.totalCount, idle: voicePool.idleCount, waiting: voicePool.waitingCount, max: VOICE_DB_POOL_MAX },
  };
}

export async function probeDb(timeoutMs = 2000): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const queryP = pool.query("SELECT 1");
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([queryP, timeoutP]);
    const durationMs = Date.now() - start;
    _lastSuccessfulProbeAt = Date.now();
    _lastProbeDurationMs = durationMs;
    return { ok: true, durationMs };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    _lastProbeDurationMs = durationMs;
    return { ok: false, durationMs, error: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startPoolSaturationMonitor(intervalMs = 1000): void {
  if (_saturationInterval) return;
  _saturationInterval = setInterval(() => {
    const saturated = (pool.idleCount === 0 && pool.totalCount >= GENERAL_DB_POOL_MAX && pool.waitingCount > 0) || (voicePool.idleCount === 0 && voicePool.totalCount >= VOICE_DB_POOL_MAX && voicePool.waitingCount > 0);
    if (saturated) {
      if (_saturatedSinceMs === null) _saturatedSinceMs = Date.now();
    } else {
      _saturatedSinceMs = null;
    }
  }, intervalMs);
  if (_saturationInterval.unref) _saturationInterval.unref();
}

export function stopPoolSaturationMonitor(): void {
  if (_saturationInterval) {
    clearInterval(_saturationInterval);
    _saturationInterval = null;
  }
}

// Database connections are owned by PostgreSQL and the process that opened them.
// A new app process must never infer that another boot is dead from a different
// application_name and terminate its backends. Hosted verification commands can
// overlap the serving process, and PostgreSQL already reclaims connections when
// their real owner exits.

// The heartbeat is the canary: every tick stamps `_lastHeartbeatLogAt`. If
// this stops moving while real work is in flight, the pool-wedge watchdog
// (below) will dump pg_stat_activity and self-exit so the supervisor restarts
// us. Crucially, we do NOT fan-out N parallel `SELECT 1`s here — under
// contention that DDoSes the already-stressed pool with bookkeeping queries
// and hides the real waiting count behind synthetic load. We log once per
// interval and, at most, kick a single low-cost seed connect+release in
// flight. Real traffic refills the pool naturally.
let _lastHeartbeatLogAt: number = Date.now();
let _seedInFlight: boolean = false;

export function getLastHeartbeatLogAt(): number {
  return _lastHeartbeatLogAt;
}

export function startPoolHeartbeat(intervalMs = 30_000): void {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    _lastHeartbeatLogAt = Date.now();
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const inFlight = inFlightQueries;
    const deficit = GENERAL_DB_POOL_MIN - total;
    if (deficit <= 0) return;

    log.log(
      `heartbeat: pool below min total=${total} idle=${idle} waiting=${waiting} in-flight=${inFlight} min=${GENERAL_DB_POOL_MIN} deficit=${deficit}`,
    );

    // At most one seed connection in flight at a time. We use connect+release
    // so the connection lands in the idle pool (instead of being reaped
    // immediately like a fire-and-forget `SELECT 1` would be). Bounded with a
    // short timeout so a wedged pool can't pile up zombie seeds.
    if (_seedInFlight) return;
    _seedInFlight = true;
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (_seedInFlight) {
        log.warn(`heartbeat seed timed out after ${Date.now() - start}ms (pool may be saturated)`);
        _seedInFlight = false;
      }
      timer = null;
    }, 5_000);
    pool.connect()
      .then((client) => {
        client.release();
        const ms = Date.now() - start;
        if (ms > 1_000) log.log(`heartbeat seed completed in ${ms}ms`);
      })
      .catch((err) => {
        log.warn(`heartbeat seed failed: ${err?.message || err}`);
      })
      .finally(() => {
        if (timer) {
          clearTimeout(timer);
          _seedInFlight = false;
        }
      });
  }, intervalMs);
  if (_heartbeatInterval.unref) _heartbeatInterval.unref();
}

export function stopPoolHeartbeat(): void {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

// ─── Pool-wedge self-exit watchdog ─────────────────────────────────────────
// If the heartbeat stops moving for `silenceMs` while there is real work in
// flight (in-flight queries or clients waiting), assume the event loop is
// alive but the DB pool is wedged on a deadlock. Dump pg_stat_activity for
// our application_name (so a triager can see waiting/blocking PIDs and
// xact_age) and `process.exit(POOL_WEDGE_EXIT_CODE)`. The supervisor then
// restarts us cleanly. This is the safety net behind all the deadlock-prevention
// fixes — it should almost never fire.
export const POOL_WEDGE_EXIT_CODE = 79;

let _wedgeInterval: ReturnType<typeof setInterval> | null = null;
let _wedgeTriggered = false;

export async function dumpPgStatActivity(timeoutMs = 5_000): Promise<string> {
  // Use a dedicated short-lived client so we don't compete for the wedged
  // pool's connections.
  const dedicated = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: `${APP_NAME}-watchdog`,
    statement_timeout: timeoutMs,
    connectionTimeoutMillis: timeoutMs,
  } as any);
  try {
    await dedicated.connect();
    const res = await dedicated.query(
      `SELECT pid, state, wait_event_type, wait_event,
              EXTRACT(EPOCH FROM (NOW() - xact_start))::int AS xact_age_s,
              EXTRACT(EPOCH FROM (NOW() - query_start))::int AS query_age_s,
              pg_blocking_pids(pid) AS blocking_pids,
              LEFT(query, 300) AS query
         FROM pg_stat_activity
        WHERE application_name = $1
          AND pid <> pg_backend_pid()
        ORDER BY xact_start NULLS LAST`,
      [APP_NAME],
    );
    if (res.rows.length === 0) {
      return `pg_stat_activity dump: 0 rows for app=${APP_NAME}`;
    }
    const lines = res.rows.map((r: any) =>
      `  pid=${r.pid} state=${r.state} wait=${r.wait_event_type ?? "-"}/${r.wait_event ?? "-"} ` +
      `xact_age=${r.xact_age_s ?? "-"}s query_age=${r.query_age_s ?? "-"}s ` +
      `blocked_by=[${(r.blocking_pids || []).join(",")}] query=${r.query}`,
    );
    return `pg_stat_activity dump (${res.rows.length} rows for app=${APP_NAME}):\n${lines.join("\n")}`;
  } catch (err: any) {
    return `pg_stat_activity dump failed: ${err?.message || err}`;
  } finally {
    try { await dedicated.end(); } catch {}
  }
}

export function startPoolWedgeWatchdog(opts?: {
  silenceMs?: number;
  intervalMs?: number;
  exitCode?: number;
}): void {
  if (_wedgeInterval) return;
  const silenceMs = opts?.silenceMs ?? 90_000;
  const intervalMs = opts?.intervalMs ?? 15_000;
  const exitCode = opts?.exitCode ?? POOL_WEDGE_EXIT_CODE;
  _wedgeInterval = setInterval(() => {
    if (_wedgeTriggered) return;
    const sinceHeartbeat = Date.now() - _lastHeartbeatLogAt;
    if (sinceHeartbeat < silenceMs) return;

    const inFlight = inFlightQueries;
    const waiting = pool.waitingCount;
    const dbHasWork = inFlight > 0 || waiting > 0;

    // Generalized check across all subsystems (HTTP req, executor runs, chat
    // streams, tool dispatches, journal flushes, doc upserts, conv locks,
    // db pool). The pool-only gate misses wedges in any of those.
    let crossSubsystemHasWork = false;
    let wedgeSnap: any = null;
    try {
      // Lazy require to avoid an import cycle.
      const { collectInflightSnapshot } = require("./wedge-watchdog");
      wedgeSnap = collectInflightSnapshot();
      crossSubsystemHasWork = wedgeSnap.totalInFlight > 0;
    } catch {
      // If the wedge module isn't available, fall back to pool-only check.
    }

    const hasWork = dbHasWork || crossSubsystemHasWork;
    if (!hasWork) {
      // Process is just idle — don't kill it. Reset the heartbeat clock so
      // we don't fire as soon as a single request shows up.
      log.warn(
        `pool-wedge watchdog: heartbeat silent for ${Math.round(sinceHeartbeat / 1000)}s but no work in flight (in-flight=${inFlight}, waiting=${waiting}); not exiting`,
      );
      _lastHeartbeatLogAt = Date.now();
      return;
    }

    _wedgeTriggered = true;
    const offenderStr = wedgeSnap?.oldestSubsystem
      ? ` offender=${wedgeSnap.oldestSubsystem.name}/${wedgeSnap.oldestSubsystem.id} ageMs=${wedgeSnap.oldestSubsystem.ageMs}`
      : "";
    log.error(
      `[Watchdog] WEDGE — heartbeat silent for ${Math.round(sinceHeartbeat / 1000)}s with db.in-flight=${inFlight} db.waiting=${waiting} pool=total:${pool.totalCount}/idle:${pool.idleCount} crossSubsystem=${crossSubsystemHasWork ? wedgeSnap?.totalInFlight : 0}${offenderStr}. Dumping pg_stat_activity + inflight snapshot then exiting.`,
    );
    void (async () => {
      try {
        const dump = await Promise.race<string>([
          dumpPgStatActivity(5_000),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("pg_stat_activity dump: outer timeout"), 7_000),
          ),
        ]);
        // pg_stat_activity dump can be many MB on a saturated pool. Bound
        // it before the synchronous log write so the dump itself can never
        // become the wedge we are trying to escape from.
        log.error(safeTruncate(dump, 256 * 1024, "db.pgStatActivity"));
      } catch (err: any) {
        log.error(`pg_stat_activity dump errored: ${safeTruncate(String(err?.message || err), 4 * 1024, "db.pgStatActivity.error")}`);
      } finally {
        // Death-rattle dump + exit. If wedge-watchdog isn't loaded, fall back
        // to legacy pool-wedge exit code.
        try {
          const { dumpWedgeRattle, WEDGE_EXIT_CODE } = require("./wedge-watchdog");
          // If db pool is the only signal, use the generalized code anyway —
          // dumpWedgeRattle will name the actual offender (db pool entries).
          dumpWedgeRattle(
            `db pool/multi-subsystem wedge silenceMs=${sinceHeartbeat} dbInFlight=${inFlight} dbWaiting=${waiting}`,
            crossSubsystemHasWork && !dbHasWork ? WEDGE_EXIT_CODE : exitCode,
          );
        } catch {
          log.error(`[Watchdog] pool-wedge: exiting with code ${exitCode}`);
          setImmediate(() => process.exit(exitCode));
        }
      }
    })();
  }, intervalMs);
  if (_wedgeInterval.unref) _wedgeInterval.unref();
}

export function stopPoolWedgeWatchdog(): void {
  if (_wedgeInterval) {
    clearInterval(_wedgeInterval);
    _wedgeInterval = null;
  }
}

export function startPoolHealthCheck(intervalMs = 60_000): void {
  if (_healthInterval) return;
  _healthInterval = setInterval(() => {
    const breakdown = Object.entries(inFlightBySubsystem)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const subsystemInfo = breakdown ? ` in-flight=[${breakdown}]` : "";

    let elLag = 0;
    let elMaxRecent = 0;
    try {
      const pm = require("./performance-monitor");
      elLag = pm.getLatestEventLoopLag?.() ?? 0;
      const diag = pm.getPerformanceDiagnostics?.();
      elMaxRecent = diag?.eventLoopLag?.max ?? 0;
    } catch {}

    const sinceProbe = _lastSuccessfulProbeAt === null
      ? "never"
      : `${Math.round((Date.now() - _lastSuccessfulProbeAt) / 1000)}s`;
    const satFor = _saturatedSinceMs === null
      ? "0ms"
      : `${Date.now() - _saturatedSinceMs}ms`;
    const slowest = Object.entries(inFlightBySubsystem)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])[0];
    const slowestStr = slowest ? `${slowest[0]}(${slowest[1]})` : "none";

    log.log(
      `op-summary boot=${BOOT_ID} general=total:${pool.totalCount}/idle:${pool.idleCount}/waiting:${pool.waitingCount} voice=total:${voicePool.totalCount}/idle:${voicePool.idleCount}/waiting:${voicePool.waitingCount} saturated=${satFor} top-subsystem=${slowestStr} eventLoop=cur:${Math.round(elLag)}ms/max60s:${Math.round(elMaxRecent)}ms lastProbe=${sinceProbe} probeMs=${_lastProbeDurationMs ?? "-"}${subsystemInfo}`
    );
    if (pool.waitingCount > 5 || voicePool.waitingCount > 0) {
      log.warn(
        `HIGH WAIT COUNT: general=${pool.waitingCount} voice=${voicePool.waitingCount}`
      );
    }
  }, intervalMs);
  if (_healthInterval.unref) _healthInterval.unref();
}

export function stopPoolHealthCheck(): void {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}

let inFlightQueries = 0;
const inFlightBySubsystem: Record<string, number> = {};

interface InFlightEntry {
  id: number;
  subsystem: string;
  label: string | null;
  startedAt: number;
}
const _inFlightEntries = new Map<number, InFlightEntry>();
let _inFlightSeq = 0;
let lastHighInFlightWarningAt = 0;
let lastHighInFlightWarningPeak = 0;

export type QuerySubsystem = "context-build" | "context-prewarm" | "chat-stream" | "ooda" | "tool-exec" | "memory" | "memory-write" | "log-sink" | "timer-scheduler" | "voice" | "autonomous" | "general";

export function getInFlightStats(): { total: number; bySubsystem: Record<string, number> } {
  return { total: inFlightQueries, bySubsystem: { ...inFlightBySubsystem } };
}

export function getLongRunningQueries(thresholdMs = LONG_RUNNING_THRESHOLD_MS): {
  thresholdMs: number;
  rows: Array<{ subsystem: string; label: string | null; ageMs: number }>;
} {
  const now = Date.now();
  const rows: Array<{ subsystem: string; label: string | null; ageMs: number }> = [];
  for (const e of _inFlightEntries.values()) {
    const ageMs = now - e.startedAt;
    if (ageMs >= thresholdMs) {
      rows.push({ subsystem: e.subsystem, label: e.label, ageMs });
    }
  }
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return { thresholdMs, rows: rows.slice(0, LONG_RUNNING_MAX_ROWS) };
}

export type DatabaseLane = "general" | "voice";
const databaseLaneALS = new AsyncLocalStorage<DatabaseLane>();
const querySubsystemALS = new AsyncLocalStorage<QuerySubsystem>();
const queryLabelALS = new AsyncLocalStorage<string>();
const admissionTierALS = new AsyncLocalStorage<string>();

export function withDatabaseLane<T>(lane: DatabaseLane, fn: () => T): T {
  return databaseLaneALS.run(lane, fn);
}

export function withAdmissionTier<T>(tier: string, fn: () => Promise<T>): Promise<T> {
  return admissionTierALS.run(tier, fn);
}

export function withQueryAttributionAsync<T>(subsystem: QuerySubsystem, fn: () => Promise<T>, label?: string): Promise<T> {
  if (label) {
    return querySubsystemALS.run(subsystem, () => queryLabelALS.run(label, fn));
  }
  return querySubsystemALS.run(subsystem, fn);
}

function instrumentPool(targetPool: Pool, lane: DatabaseLane): void {
  const origQuery = targetPool.query.bind(targetPool);
  (targetPool as any).query = function (...args: any[]) {
    const subsystem = lane === "voice" ? "voice" : (querySubsystemALS.getStore() || "general");
    const label = queryLabelALS.getStore() || null;

    if (subsystem === "context-prewarm" || lane === "voice") {
      const tag = lane === "voice"
        ? (label ? `/* lane:voice:${label} */` : `/* lane:voice */`)
        : (label ? `/* context:prewarm:${label} */` : `/* context:prewarm */`);
      if (typeof args[0] === "string") args[0] = `${tag} ${args[0]}`;
      else if (args[0] && typeof args[0].text === "string") args[0] = { ...args[0], text: `${tag} ${args[0].text}` };
    }

    inFlightQueries++;
    inFlightBySubsystem[subsystem] = (inFlightBySubsystem[subsystem] || 0) + 1;
    const entryId = ++_inFlightSeq;
    _inFlightEntries.set(entryId, { id: entryId, subsystem, label: label ? `${lane}:${label}` : lane, startedAt: Date.now() });
    if (inFlightQueries > HIGH_IN_FLIGHT_THRESHOLD) {
      const now = Date.now();
      const isNewPeak = inFlightQueries > lastHighInFlightWarningPeak;
      if (isNewPeak || now - lastHighInFlightWarningAt >= HIGH_IN_FLIGHT_LOG_INTERVAL_MS) {
        lastHighInFlightWarningAt = now;
        lastHighInFlightWarningPeak = Math.max(lastHighInFlightWarningPeak, inFlightQueries);
        const breakdown = Object.entries(inFlightBySubsystem)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${name}=${count}`)
          .join(" ");
        log.warn(`HIGH IN-FLIGHT: ${inFlightQueries} queries concurrent [${breakdown}] general=${pool.totalCount}/${pool.idleCount}/${pool.waitingCount} voice=${voicePool.totalCount}/${voicePool.idleCount}/${voicePool.waitingCount}`);
      }
    } else if (lastHighInFlightWarningPeak > 0) {
      lastHighInFlightWarningPeak = 0;
    }
    const start = Date.now();
    const queryText = typeof args[0] === "string" ? args[0] : args[0]?.text || "(unknown)";

    let result: any;
    try {
      result = (origQuery as any)(...args);
    } catch (err) {
      inFlightQueries--;
      inFlightBySubsystem[subsystem] = Math.max(0, (inFlightBySubsystem[subsystem] || 0) - 1);
      _inFlightEntries.delete(entryId);
      throw err;
    }

    const settle = (failed: boolean) => {
      inFlightQueries--;
      inFlightBySubsystem[subsystem] = Math.max(0, (inFlightBySubsystem[subsystem] || 0) - 1);
      _inFlightEntries.delete(entryId);
      const elapsed = Date.now() - start;
      if (elapsed > SLOW_QUERY_THRESHOLD_MS || failed) {
        if (elapsed > SLOW_QUERY_THRESHOLD_MS) recordSlowQuery(elapsed);
        const truncated = safeTruncate(queryText, 2 * 1024, `db.${failed ? "failed" : "slow"}.${subsystem}`);
        const counts = `${targetPool.totalCount}/${targetPool.idleCount}/${targetPool.waitingCount}`;
        const message = `${failed ? "query contract failed" : "SLOW query"} after ${elapsed}ms lane=${lane} subsystem=${subsystem} label=${label || "none"} pool=${counts}: ${truncated}`;
        if (failed) log.error(message); else log.warn(message);
      }
    };

    if (result && typeof result.then === "function") result.then(() => settle(false), () => settle(true));
    else settle(false);
    return result;
  };
}

instrumentPool(pool, "general");
instrumentPool(voicePool, "voice");

const generalDb = drizzle(pool, { schema });
const voiceDb = drizzle(voicePool, { schema });
const databaseProxyTarget = Object.create(null);
export const db = new Proxy(databaseProxyTarget, {
  get(_target, property, receiver) {
    const selected = databaseLaneALS.getStore() === "voice" ? voiceDb : generalDb;
    const value = Reflect.get(selected as object, property, selected);
    return typeof value === "function" ? value.bind(selected) : value;
  },
}) as typeof generalDb;

export async function closeDatabasePools(): Promise<void> {
  stopPoolHealthCheck();
  stopPoolHeartbeat();
  stopPoolSaturationMonitor();
  stopPoolWedgeWatchdog();
  await Promise.allSettled([pool.end(), voicePool.end()]);
}


// ─── Advisory locks for serializing writes per logical key ─────────────────
// Postgres `pg_advisory_xact_lock(int4, int4)` takes two 32-bit ints. We use
// the namespace as a stable per-subsystem id and the per-key int as a
// 32-bit hash of the logical key (e.g. a parent UUID, or a sentinel for
// "root"). Locks are released automatically at transaction commit/rollback.
//
// `LIBRARY_PARENT` serializes Library tree mutations (reorder, create,
// update, edit, delete) per affected parent so the bulk sort_order shifts
// in `PATCH /api/info/library/reorder` cannot cross-lock with concurrent
// reorders or with `library` tool writes targeting the same parent.
export const ADVISORY_LOCK_NS = {
  LIBRARY_PARENT: 0x4c425052, // 'LBPR' — must fit in int32
  PERSON_MERGE: 0x5052534d, // 'PRSM' — serializes Person merges per account
} as const;

const LIBRARY_ROOT_SENTINEL = "__LIBRARY_ROOT__";

// Stable 32-bit FNV-1a hash, returned as a signed int32 (so it always fits
// in Postgres int4). Postgres `pg_advisory_xact_lock(int4,int4)` requires
// int4 args and silently truncates >32-bit numbers, so we keep this exact.
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h | 0;
}

export function libraryParentLockKey(parentId: string | null): number {
  return fnv1a32(parentId === null ? LIBRARY_ROOT_SENTINEL : parentId);
}

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Acquire pg advisory locks (transaction-scoped) for the given parent ids.
// Locks are deduplicated and acquired in a stable sorted order so concurrent
// reparents touching {A,B} and {B,A} can't AB/BA-deadlock on the locks
// themselves. Must be called inside a `db.transaction(...)` block — the lock
// is released when the transaction commits or rolls back.
export async function acquireLibraryParentLocks(
  tx: DrizzleTx,
  parentIds: (string | null)[],
): Promise<void> {
  const uniq = Array.from(
    new Set(parentIds.map((p) => (p === null ? LIBRARY_ROOT_SENTINEL : p))),
  ).sort();
  const ns = ADVISORY_LOCK_NS.LIBRARY_PARENT;
  for (const k of uniq) {
    const key = fnv1a32(k);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ns}::int4, ${key}::int4)`);
  }
}

// True for Postgres serialization-conflict error codes. Caller can map these
// to a 409 with a "retry" hint.
export function isSerializationConflict(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === "40P01" /* deadlock_detected */ || code === "40001" /* serialization_failure */;
}

startPoolHealthCheck();
startPoolHeartbeat();
startPoolSaturationMonitor();
log.log(`pools initialized: app=${APP_NAME} totalMax=${DB_POOL_MAX} general=${GENERAL_DB_POOL_MAX}/${GENERAL_DB_POOL_MIN} voice=${VOICE_DB_POOL_MAX}/${VOICE_DB_POOL_MIN} voiceAcquireMs=${VOICE_DB_ACQUIRE_TIMEOUT_MS} voiceStatementMs=${VOICE_DB_STATEMENT_TIMEOUT_MS}`);
