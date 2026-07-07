// Use createLogger for logging ONLY
import * as fs from "fs";
import { join } from "path";
import { createLogger } from "./log";

const log = createLogger("WedgeWatchdog");

// Distinctive exit code for the generalized wedge watchdog. Distinct from:
//   78 = memory pressure (process-wrapper)
//    1 = event-loop stall (performance-monitor)
//   79 = pool wedge (db.ts watchdog, narrow DB-pool-only path)
//   80 = generalized subsystem wedge (this module)
export const WEDGE_EXIT_CODE = 80;

// ─── Subsystem in-flight registries ───────────────────────────────────────
// Each subsystem keeps a Map<id, { startedAt, label, meta? }>. We name the
// offender (oldest entry) on dump so the runbook can grep for the actual
// sessionId / toolCallId / runId / file / queue that wedged us.

export type WedgeSubsystem =
  | "http_req"
  | "executor_run"
  | "chat_stream"
  | "tool_dispatch"
  | "journal_flush"
  | "doc_upsert"
  | "conv_lock"
  | "db_pool";

interface InFlightEntry {
  id: string;
  startedAt: number;
  label: string;
  meta?: Record<string, unknown>;
}

type Registry = Map<string, InFlightEntry>;

const registries: Record<Exclude<WedgeSubsystem, "executor_run" | "chat_stream" | "db_pool">, Registry> = {
  http_req: new Map(),
  tool_dispatch: new Map(),
  journal_flush: new Map(),
  doc_upsert: new Map(),
  conv_lock: new Map(),
};

function registerStart(
  sub: keyof typeof registries,
  id: string,
  label: string,
  meta?: Record<string, unknown>,
): void {
  registries[sub].set(id, { id, startedAt: Date.now(), label, meta });
}

function registerEnd(sub: keyof typeof registries, id: string): void {
  registries[sub].delete(id);
}

// Public per-subsystem helpers (used by instrumentation call-sites).
export const trackHttpReqStart = (id: string, method: string, path: string) =>
  registerStart("http_req", id, `${method} ${path}`);
export const trackHttpReqEnd = (id: string) => registerEnd("http_req", id);

export const trackToolDispatchStart = (toolCallId: string, toolName: string, sessionId?: string) =>
  registerStart("tool_dispatch", toolCallId, toolName, sessionId ? { sessionId } : undefined);
export const trackToolDispatchEnd = (toolCallId: string) => registerEnd("tool_dispatch", toolCallId);

export const trackJournalFlushStart = (id: string, batchSize: number, sessionsTouched: number) =>
  registerStart("journal_flush", id, `batch=${batchSize} sessions=${sessionsTouched}`, { batchSize, sessionsTouched });
export const trackJournalFlushEnd = (id: string) => registerEnd("journal_flush", id);

export const trackDocUpsertStart = (id: string, docType: string, docId: string) =>
  registerStart("doc_upsert", id, `${docType}/${docId}`, { docType, docId });
export const trackDocUpsertEnd = (id: string) => registerEnd("doc_upsert", id);

export const trackConvLockStart = (id: string, convId: string) =>
  registerStart("conv_lock", id, convId, { convId });
export const trackConvLockEnd = (id: string) => registerEnd("conv_lock", id);

// ─── External-source accessors (lazily resolved to avoid cycles) ──────────
// We resolve these lazily so this module can be imported very early in boot
// without dragging in the whole world.

type ExecutorRunsAccessor = () => Array<{
  runId: string;
  startedAt: number;
  sessionId?: string;
  model?: string;
  activity?: string;
  sessionKey?: string;
  aborted?: boolean;
}>;

type ChatStreamSessionsAccessor = () => Array<{
  sessionId: string;
  startedAt: number;
  sessionKey?: string;
  runId?: string;
}>;

type DbPoolAccessor = () => {
  inFlight: number;
  waiting: number;
  total: number;
  idle: number;
  longRunning: Array<{ subsystem: string; label: string | null; ageMs: number }>;
};

let _executorRunsAccessor: ExecutorRunsAccessor | null = null;
let _chatStreamAccessor: ChatStreamSessionsAccessor | null = null;
let _dbPoolAccessor: DbPoolAccessor | null = null;

export function registerExecutorRunsAccessor(fn: ExecutorRunsAccessor): void {
  _executorRunsAccessor = fn;
}
export function registerChatStreamAccessor(fn: ChatStreamSessionsAccessor): void {
  _chatStreamAccessor = fn;
}
export function registerDbPoolAccessor(fn: DbPoolAccessor): void {
  _dbPoolAccessor = fn;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────

export interface SubsystemSnapshot {
  count: number;
  oldestAgeMs: number | null;
  oldest: { id: string; label: string; ageMs: number; meta?: Record<string, unknown> } | null;
  entries: Array<{ id: string; label: string; ageMs: number; meta?: Record<string, unknown> }>;
}

export interface SubsystemDelta {
  countDelta: number;
  oldestAgeMsDelta: number | null;
  msSinceLastHeartbeat: number | null;
}

export interface WedgeSnapshot {
  ts: number;
  pid: number;
  uptimeS: number;
  subsystems: Record<WedgeSubsystem, SubsystemSnapshot>;
  totalInFlight: number;
  oldestSubsystem: { name: WedgeSubsystem; ageMs: number; label: string; id: string } | null;
  /**
   * Per-subsystem delta vs. the previous heartbeat snapshot. `countDelta` > 0
   * means in-flight grew since last heartbeat (suspicious if it stays high
   * across multiple ticks). `oldestAgeMsDelta` close to `msSinceLastHeartbeat`
   * means the same offender stayed wedged the entire interval. Only baselined
   * by `writeSnapshotFile()` so ad-hoc `/api/diag/inflight` reads do not
   * disturb the heartbeat baseline.
   */
  sinceLastHeartbeat: Record<WedgeSubsystem, SubsystemDelta>;
}

const MAX_ENTRIES_PER_SUB = 25;

function snapshotRegistry(reg: Registry): SubsystemSnapshot {
  const now = Date.now();
  const all = Array.from(reg.values())
    .map((e) => ({ id: e.id, label: e.label, ageMs: now - e.startedAt, meta: e.meta }))
    .sort((a, b) => b.ageMs - a.ageMs);
  return {
    count: all.length,
    oldestAgeMs: all[0]?.ageMs ?? null,
    oldest: all[0] ?? null,
    entries: all.slice(0, MAX_ENTRIES_PER_SUB),
  };
}

function snapshotExecutorRuns(): SubsystemSnapshot {
  const now = Date.now();
  const runs = (_executorRunsAccessor?.() ?? []).slice();
  const entries = runs
    .map((r) => ({
      id: r.runId,
      label: `${r.activity || "?"} ${r.model || "?"}${r.aborted ? " [aborting]" : ""}`,
      ageMs: now - r.startedAt,
      meta: { sessionId: r.sessionId, sessionKey: r.sessionKey, activity: r.activity, model: r.model, aborted: r.aborted },
    }))
    .sort((a, b) => b.ageMs - a.ageMs);
  return {
    count: entries.length,
    oldestAgeMs: entries[0]?.ageMs ?? null,
    oldest: entries[0] ?? null,
    entries: entries.slice(0, MAX_ENTRIES_PER_SUB),
  };
}

function snapshotChatStreams(): SubsystemSnapshot {
  const now = Date.now();
  const sessions = _chatStreamAccessor?.() ?? [];
  const entries = sessions
    .map((s) => ({
      id: s.sessionId,
      label: `session=${s.sessionId}${s.runId ? ` runId=${s.runId}` : ""}`,
      ageMs: now - s.startedAt,
      meta: { sessionId: s.sessionId, sessionKey: s.sessionKey, runId: s.runId },
    }))
    .sort((a, b) => b.ageMs - a.ageMs);
  return {
    count: entries.length,
    oldestAgeMs: entries[0]?.ageMs ?? null,
    oldest: entries[0] ?? null,
    entries: entries.slice(0, MAX_ENTRIES_PER_SUB),
  };
}

function snapshotDbPool(): SubsystemSnapshot {
  const info = _dbPoolAccessor?.();
  if (!info) {
    return { count: 0, oldestAgeMs: null, oldest: null, entries: [] };
  }
  const entries = info.longRunning.map((q, i) => ({
    id: `${q.subsystem}:${i}`,
    label: `${q.subsystem} ${q.label || ""}`.trim(),
    ageMs: q.ageMs,
    meta: { subsystem: q.subsystem },
  }));
  // Sentinel entry capturing pool counters even when no long-runners are
  // tracked, so the dump still names the offender as "db pool wait".
  const synthetic = {
    id: `pool`,
    label: `pool inFlight=${info.inFlight} waiting=${info.waiting} total=${info.total} idle=${info.idle}`,
    ageMs: 0,
    meta: { inFlight: info.inFlight, waiting: info.waiting, total: info.total, idle: info.idle },
  };
  const total = info.inFlight + info.waiting;
  return {
    count: total,
    oldestAgeMs: entries[0]?.ageMs ?? (total > 0 ? 0 : null),
    oldest: entries[0] ?? (total > 0 ? synthetic : null),
    entries: [synthetic, ...entries].slice(0, MAX_ENTRIES_PER_SUB),
  };
}

// Per-subsystem baseline updated only by writeSnapshotFile() (the heartbeat).
// Ad-hoc snapshot reads do not disturb this baseline so the delta in
// /api/diag/inflight always reflects "how things changed since the last
// heartbeat tick."
interface HeartbeatBaseline {
  ts: number;
  count: number;
  oldestAgeMs: number | null;
}
const _heartbeatBaseline: Map<WedgeSubsystem, HeartbeatBaseline> = new Map();

function computeDelta(name: WedgeSubsystem, snap: SubsystemSnapshot): SubsystemDelta {
  const baseline = _heartbeatBaseline.get(name);
  if (!baseline) {
    return { countDelta: 0, oldestAgeMsDelta: null, msSinceLastHeartbeat: null };
  }
  const msSince = Date.now() - baseline.ts;
  let oldestAgeMsDelta: number | null = null;
  if (snap.oldestAgeMs !== null && baseline.oldestAgeMs !== null) {
    oldestAgeMsDelta = snap.oldestAgeMs - baseline.oldestAgeMs;
  } else if (snap.oldestAgeMs !== null && baseline.oldestAgeMs === null) {
    oldestAgeMsDelta = snap.oldestAgeMs;
  } else if (snap.oldestAgeMs === null && baseline.oldestAgeMs !== null) {
    oldestAgeMsDelta = -baseline.oldestAgeMs;
  }
  return {
    countDelta: snap.count - baseline.count,
    oldestAgeMsDelta,
    msSinceLastHeartbeat: msSince,
  };
}

export function collectInflightSnapshot(): WedgeSnapshot {
  const subsystems: Record<WedgeSubsystem, SubsystemSnapshot> = {
    http_req: snapshotRegistry(registries.http_req),
    executor_run: snapshotExecutorRuns(),
    chat_stream: snapshotChatStreams(),
    tool_dispatch: snapshotRegistry(registries.tool_dispatch),
    journal_flush: snapshotRegistry(registries.journal_flush),
    doc_upsert: snapshotRegistry(registries.doc_upsert),
    conv_lock: snapshotRegistry(registries.conv_lock),
    db_pool: snapshotDbPool(),
  };

  let totalInFlight = 0;
  let oldestSubsystem: WedgeSnapshot["oldestSubsystem"] = null;
  const sinceLastHeartbeat = {} as Record<WedgeSubsystem, SubsystemDelta>;
  for (const [name, snap] of Object.entries(subsystems) as Array<[WedgeSubsystem, SubsystemSnapshot]>) {
    totalInFlight += snap.count;
    if (snap.oldest && snap.oldestAgeMs !== null) {
      if (!oldestSubsystem || snap.oldestAgeMs > oldestSubsystem.ageMs) {
        oldestSubsystem = { name, ageMs: snap.oldestAgeMs, label: snap.oldest.label, id: snap.oldest.id };
      }
    }
    sinceLastHeartbeat[name] = computeDelta(name, snap);
  }

  return {
    ts: Date.now(),
    pid: process.pid,
    uptimeS: Math.round(process.uptime()),
    subsystems,
    totalInFlight,
    oldestSubsystem,
    sinceLastHeartbeat,
  };
}

function updateHeartbeatBaseline(snap: WedgeSnapshot): void {
  for (const [name, sub] of Object.entries(snap.subsystems) as Array<[WedgeSubsystem, SubsystemSnapshot]>) {
    _heartbeatBaseline.set(name, {
      ts: snap.ts,
      count: sub.count,
      oldestAgeMs: sub.oldestAgeMs,
    });
  }
}

export function hasInflightWork(): boolean {
  const snap = collectInflightSnapshot();
  return snap.totalInFlight > 0;
}

// ─── SIGKILL-survivable death-rattle dump ─────────────────────────────────
// Strategy:
//   1. Pre-open `logs/wedge-rattle.log` with O_APPEND|O_SYNC so every write
//      is fsync'd before the syscall returns. Even if the supervisor
//      SIGKILLs us seconds later, anything we already wrote is durable.
//   2. On every snapshot tick, write the current snapshot synchronously to
//      `logs/wedge-snapshot.json` (atomic via tmp+rename) so an external
//      tail (or post-mortem reader) always has the most recent state.
//   3. On dump, we write a single death-rattle line to both stderr (fd 2,
//      synchronous) and the rattle log, then exit.

const LOG_DIR = join(process.cwd(), "logs");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const RATTLE_LOG_PATH = join(LOG_DIR, "wedge-rattle.log");
const SNAPSHOT_PATH = join(LOG_DIR, "wedge-snapshot.json");
const SNAPSHOT_TMP_PATH = join(LOG_DIR, "wedge-snapshot.json.tmp");

let _rattleFd: number | null = null;
function getRattleFd(): number | null {
  if (_rattleFd !== null) return _rattleFd;
  try {
    // O_APPEND | O_CREAT | O_WRONLY | O_SYNC — synchronous appends
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_SYNC;
    _rattleFd = fs.openSync(RATTLE_LOG_PATH, flags, 0o644);
    return _rattleFd;
  } catch (err) {
    log.error("failed to open rattle log fd:", err);
    return null;
  }
}

function writeSyncSafely(fd: number, line: string): void {
  try {
    fs.writeSync(fd, line);
  } catch {
    // best-effort
  }
}

export function writeSnapshotFile(snapshot?: WedgeSnapshot): void {
  try {
    const snap = snapshot ?? collectInflightSnapshot();
    const payload = JSON.stringify(snap);
    fs.writeFileSync(SNAPSHOT_TMP_PATH, payload, { encoding: "utf-8", flag: "w" });
    fs.renameSync(SNAPSHOT_TMP_PATH, SNAPSHOT_PATH);
    // Update the heartbeat baseline so the next snapshot's `sinceLastHeartbeat`
    // diff reflects what changed during this interval.
    updateHeartbeatBaseline(snap);
  } catch {
    // best-effort
  }
}

/**
 * Read the most recent N WEDGE dump entries from the rattle log file.
 *
 * A "WEDGE dump entry" is delimited by a header line that starts with
 * `[Watchdog] WEDGE — ` and continues until the next such header (or EOF).
 * We only read the tail of the file (up to MAX_TAIL_BYTES) to bound memory.
 */
export function getRecentRattleLines(n: number = 5, maxTailBytes: number = 64 * 1024): string[] {
  try {
    if (!fs.existsSync(RATTLE_LOG_PATH)) return [];
    const stat = fs.statSync(RATTLE_LOG_PATH);
    const start = Math.max(0, stat.size - maxTailBytes);
    const length = stat.size - start;
    if (length <= 0) return [];
    const fd = fs.openSync(RATTLE_LOG_PATH, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      const text = buf.toString("utf-8");
      // Split on the WEDGE header. Keep the prefix attached to its dump.
      const parts = text.split(/(?=\[Watchdog\] WEDGE — )/g);
      const dumps = parts.filter((p) => p.startsWith("[Watchdog] WEDGE — "));
      return dumps.slice(-n).map((d) => d.replace(/\n+$/, ""));
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  } catch {
    return [];
  }
}

function formatSnapshotForRattle(snap: WedgeSnapshot, reason: string): string {
  const hdr = `[Watchdog] WEDGE — ${reason} ts=${new Date(snap.ts).toISOString()} pid=${snap.pid} uptime=${snap.uptimeS}s totalInFlight=${snap.totalInFlight}`;
  const offender = snap.oldestSubsystem
    ? `OFFENDER subsystem=${snap.oldestSubsystem.name} ageMs=${snap.oldestSubsystem.ageMs} id=${snap.oldestSubsystem.id} label="${snap.oldestSubsystem.label}"`
    : `OFFENDER none`;
  const lines: string[] = [hdr, offender];
  for (const [name, sub] of Object.entries(snap.subsystems) as Array<[WedgeSubsystem, SubsystemSnapshot]>) {
    if (sub.count === 0) continue;
    const d = snap.sinceLastHeartbeat[name];
    const deltaStr = d && d.msSinceLastHeartbeat !== null
      ? ` Δsince${Math.round(d.msSinceLastHeartbeat / 1000)}s: countΔ=${d.countDelta} oldestAgeΔ=${d.oldestAgeMsDelta ?? "-"}`
      : "";
    lines.push(`  ${name}: count=${sub.count} oldestAgeMs=${sub.oldestAgeMs ?? "-"}${deltaStr}`);
    for (const e of sub.entries.slice(0, 5)) {
      const meta = e.meta ? ` meta=${JSON.stringify(e.meta)}` : "";
      lines.push(`    - id=${e.id} ageMs=${e.ageMs} label="${e.label}"${meta}`);
    }
  }
  return lines.join("\n") + "\n";
}

let _wedgeFiring = false;
/**
 * Test-only: reset the latched "wedge firing" guard. Production code should
 * never call this — once a wedge has fired we want to remain latched until
 * the process exits.
 */
export function _resetWedgeFiringForTest(): void {
  _wedgeFiring = false;
}

export function dumpWedgeRattle(reason: string, exitCode: number = WEDGE_EXIT_CODE): void {
  if (_wedgeFiring) return;
  _wedgeFiring = true;

  const snap = collectInflightSnapshot();
  const text = formatSnapshotForRattle(snap, reason);

  // 1. stderr (fd 2) — synchronous so logs flush before exit
  writeSyncSafely(2, text);

  // 2. dedicated O_SYNC log file
  const fd = getRattleFd();
  if (fd !== null) writeSyncSafely(fd, text);

  // 3. update the JSON snapshot (post-mortem readers see it)
  writeSnapshotFile(snap);

  // 4. structured logger record (best-effort, may not flush)
  log.error(`death-rattle written reason="${reason}" exitCode=${exitCode}`);

  // 5. one tick out, then exit
  setImmediate(() => process.exit(exitCode));
}

// ─── Client wedge ring buffer ─────────────────────────────────────────────
// The client posts a notice when its subscribe watchdog fires (5s/10s/20s).
// We ring-buffer the most recent N so /api/diag/inflight can show them and
// the dump writer can include them in death rattles.

export interface ClientWedgeReport {
  receivedAt: number;
  delayMs: number;
  level: "warn" | "error";
  sessionKey?: string;
  sessionId?: string;
  wsReady?: number;
  wsAlive?: boolean;
  message?: string;
  // Correlation fields populated by the client watchdog so a death-rattle
  // dump can match the client-side stall to a specific server-side run /
  // event / tool call.
  runId?: string;
  lastEventId?: string;
  lastEventAgeMs?: number;
  lastToolCallId?: string;
  lastToolCallAgeMs?: number;
  watchdogStage?: string;
  userAgent?: string;
}

const CLIENT_WEDGE_BUFFER_MAX = 50;
const _clientWedges: ClientWedgeReport[] = [];

export function recordClientWedge(report: ClientWedgeReport): void {
  _clientWedges.push(report);
  while (_clientWedges.length > CLIENT_WEDGE_BUFFER_MAX) _clientWedges.shift();
  // Also append to the rattle log synchronously so a death-rattle reader
  // can correlate client-side timing with server-side wedges.
  const fd = getRattleFd();
  if (fd !== null) {
    const line =
      `[ClientWedge] ${new Date(report.receivedAt).toISOString()} ` +
      `level=${report.level} delayMs=${report.delayMs} ` +
      `stage=${report.watchdogStage || "-"} ` +
      `sessionKey=${report.sessionKey || "-"} sessionId=${report.sessionId || "-"} ` +
      `runId=${report.runId || "-"} ` +
      `lastEventId=${report.lastEventId || "-"} lastEventAgeMs=${report.lastEventAgeMs ?? "-"} ` +
      `lastToolCallId=${report.lastToolCallId || "-"} lastToolCallAgeMs=${report.lastToolCallAgeMs ?? "-"} ` +
      `wsReady=${report.wsReady ?? "-"} wsAlive=${report.wsAlive ?? "-"} ` +
      `ua="${(report.userAgent || "").slice(0, 80)}" ` +
      `msg="${(report.message || "").slice(0, 200)}"\n`;
    writeSyncSafely(fd, line);
  }
}

export function getClientWedges(): ClientWedgeReport[] {
  return _clientWedges.slice();
}

// ─── Periodic snapshot heartbeat ──────────────────────────────────────────

let _snapshotInterval: ReturnType<typeof setInterval> | null = null;
export function startSnapshotHeartbeat(intervalMs = 10_000): void {
  if (_snapshotInterval) return;
  // Open the rattle FD eagerly so it's ready when needed.
  getRattleFd();
  // Initial snapshot.
  writeSnapshotFile();
  _snapshotInterval = setInterval(() => {
    writeSnapshotFile();
  }, intervalMs);
  if (_snapshotInterval.unref) _snapshotInterval.unref();
}

export function stopSnapshotHeartbeat(): void {
  if (_snapshotInterval) {
    clearInterval(_snapshotInterval);
    _snapshotInterval = null;
  }
}

// ─── Public diag dump (no-exit) for /api/diag/inflight ────────────────────
export function getDiagDump(opts?: { recentRattleN?: number }): {
  snapshot: WedgeSnapshot;
  clientWedges: ClientWedgeReport[];
  recentRattleDumps: string[];
  rattleLogPath: string;
  snapshotPath: string;
  exitCode: number;
} {
  return {
    snapshot: collectInflightSnapshot(),
    clientWedges: getClientWedges(),
    recentRattleDumps: getRecentRattleLines(opts?.recentRattleN ?? 5),
    rattleLogPath: RATTLE_LOG_PATH,
    snapshotPath: SNAPSHOT_PATH,
    exitCode: WEDGE_EXIT_CODE,
  };
}
