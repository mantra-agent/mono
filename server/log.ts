// Use createLogger for logging ONLY — do not use console.log/warn/error directly anywhere in the codebase
import { mkdirSync, createWriteStream, type WriteStream } from "fs";
import { readFile, readdir, stat, unlink } from "fs/promises";
import { join, resolve } from "path";
import { redactSensitiveText, redactSensitiveValue } from "./sensitive-data-redaction";

/** Severity ranking for threshold-based filtering: selecting a level shows that level and above. */
const LOG_LEVEL_RANK: Record<string, number> = { verbose: -1, debug: 0, log: 1, info: 1, warn: 2, error: 3 };

// ── Verbose logging ──────────────────────────────────────────────────────
// Verbose is below debug. When disabled (default), verbose() is a no-op
// that never evaluates its arguments. Callers pass a thunk so expensive
// string interpolation is skipped entirely when verbose is off:
//
//   log.verbose(() => `per-token detail: ${computeExpensiveThing()}`);
//
// Toggle for the current process via System → Logs. The toggle resets off on
// every boot so a temporary diagnostic window cannot silently become normal.
let _verboseEnabled = false;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

export function isVerboseEnabled(): boolean { return _verboseEnabled; }
export function setVerboseEnabled(enabled: boolean): void { _verboseEnabled = enabled; }

function shouldEmitLevel(level: string): boolean {
  if (level === "verbose") return _verboseEnabled;
  if (level === "debug") return !IS_PRODUCTION || _verboseEnabled;
  return true;
}

type LogSink = (entry: { level: string; message: string; source: string }) => void;

let sink: LogSink | null = null;

export function registerLogSink(fn: LogSink) {
  sink = fn;
}

interface LogEntry {
  ts: number;
  level: string;
  message: string;
  source: string;
}

// In-memory ring buffer (Task #995, Step D).
//
// We keep the most recent LOG_BUFFER_SIZE entries in memory so /api/logs
// can serve recent activity without a disk read. Older entries are
// overwritten in place — bounded-loss is INTENTIONAL: this is a recent-
// activity window, not a durable log. Durability is owned by the
// WriteStream below, which writes every entry to disk asynchronously.
//
// Implementation: fixed-size pre-allocated slot array + write index. Push
// is O(1) and never allocates. Reads snapshot the buffer in chronological
// order (oldest first). Bounded loss is operator-visible via the
// `dropped` counter, exposed by getRecentLogs metadata so we can detect
// when something is logging fast enough to overflow the window.
const LOG_BUFFER_SIZE = 500;
const ringSlots: Array<LogEntry | undefined> = new Array(LOG_BUFFER_SIZE);
let ringWriteIdx = 0;          // next slot to overwrite
let ringCount = 0;             // entries currently held (saturates at SIZE)
let ringDroppedCount = 0;      // total entries overwritten (lifetime)

function bufferLog(level: string, message: string, source: string) {
  // O(1) push: overwrite the oldest slot in place, no array shift.
  if (ringCount === LOG_BUFFER_SIZE) {
    ringDroppedCount++;
  } else {
    ringCount++;
  }
  ringSlots[ringWriteIdx] = { ts: Date.now(), level, message, source };
  ringWriteIdx = (ringWriteIdx + 1) % LOG_BUFFER_SIZE;
}

function snapshotRing(): LogEntry[] {
  // Walk slots in chronological order (oldest → newest) without allocating
  // beyond the output array.
  const out: LogEntry[] = new Array(ringCount);
  if (ringCount < LOG_BUFFER_SIZE) {
    // Buffer not yet full — entries live in [0, ringWriteIdx).
    for (let i = 0; i < ringCount; i++) out[i] = ringSlots[i] as LogEntry;
  } else {
    // Buffer full — oldest slot is at ringWriteIdx, walk circularly.
    for (let i = 0; i < LOG_BUFFER_SIZE; i++) {
      out[i] = ringSlots[(ringWriteIdx + i) % LOG_BUFFER_SIZE] as LogEntry;
    }
  }
  return out;
}

export function getRecentLogs(opts?: { limit?: number; level?: string; source?: string }): LogEntry[] {
  let entries = snapshotRing();
  if (opts?.level) {
    const minRank = LOG_LEVEL_RANK[opts.level] ?? 0;
    entries = entries.filter(e => (LOG_LEVEL_RANK[e.level] ?? 0) >= minRank);
  }
  if (opts?.source) entries = entries.filter(e => e.source.toLowerCase().includes(opts.source!.toLowerCase()));
  const limit = opts?.limit || 100;
  return entries.slice(-limit);
}

export function getRecentLogStats(): { capacity: number; held: number; droppedLifetime: number } {
  return { capacity: LOG_BUFFER_SIZE, held: ringCount, droppedLifetime: ringDroppedCount };
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return redactSensitiveText(arg);
      try {
        return JSON.stringify(redactSensitiveValue(arg));
      } catch {
        return "[unserializable]";
      }
    })
    .join(" ");
}

const LOGS_DIR = join(process.cwd(), "logs");
const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024;
const LOG_TOTAL_MAX_BYTES = 100 * 1024 * 1024;
const LOG_FILE_RETAIN_COUNT = 2;
const LOG_MESSAGE_MAX_BYTES = 64 * 1024;

function ensureLogsDir() {
  // boot-only sync mkdir — runs once at module load before any traffic.
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
  } catch {}
}

function makeLogFileName(part = 0): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}-${process.pid}-part-${pad2(part)}.log`;
}

ensureLogsDir();
let logFilePart = 0;
let currentLogFile = join(LOGS_DIR, makeLogFileName(logFilePart));
let currentLogBytes = 0;

// Buffered async log writer (Task #995, Step D). Replaces the per-line
// blocking append pattern — it was being called from 2,633 sites and was
// the dominant contributor to event-loop blocks. WriteStream.write() is
// non-blocking; data is queued in Node's internal buffer and flushed by
// libuv. SIGKILL loss is bounded to whatever's queued in the in-memory and
// kernel buffers (small KBs). On SIGTERM/SIGINT we end() the stream and the
// existing tail of the buffer makes it to disk.
let logStream: WriteStream | null = null;
let logStreamErrored = false;
function getLogStream(): WriteStream | null {
  if (logStreamErrored) return null;
  if (logStream) return logStream;
  try {
    const stream = createWriteStream(currentLogFile, { flags: "a", encoding: "utf-8" });
    logStream = stream;
    stream.on("error", (err) => {
      if (logStream === stream) {
        logStreamErrored = true;
        logStream = null;
      }
      // best-effort fallback to stderr; never throw from a logger
      try { process.stderr.write(`[log.ts] log stream error: ${(err as any)?.message || err}\n`); } catch {}
    });
    return stream;
  } catch (err) {
    logStreamErrored = true;
    try { process.stderr.write(`[log.ts] log stream open failed: ${(err as any)?.message || err}\n`); } catch {}
    return null;
  }
}

let pruningLogFiles = false;
async function pruneLogFiles(): Promise<void> {
  if (pruningLogFiles) return;
  pruningLogFiles = true;
  try {
    const files = (await readdir(LOGS_DIR))
      .filter((file) => file.endsWith(".log"))
      .sort()
      .reverse();
    let retainedBytes = 0;
    let retainedFiles = 0;
    for (const filename of files) {
      const path = join(LOGS_DIR, filename);
      let size = 0;
      try { size = (await stat(path)).size; } catch { continue; }
      const isCurrent = path === currentLogFile;
      const canRetain = retainedFiles < LOG_FILE_RETAIN_COUNT && retainedBytes + size <= LOG_TOTAL_MAX_BYTES;
      if (isCurrent || canRetain) {
        retainedBytes += size;
        retainedFiles++;
      } else {
        try { await unlink(path); } catch {}
      }
    }
  } catch {
    // Local logs are best-effort diagnostics. Never fail the app over pruning.
  } finally {
    pruningLogFiles = false;
  }
}

function rotateLogStream(): void {
  const previous = logStream;
  logStream = null;
  logStreamErrored = false;
  currentLogBytes = 0;
  currentLogFile = join(LOGS_DIR, makeLogFileName(++logFilePart));
  try { previous?.end(); } catch {}
  getLogStream();
  void pruneLogFiles();
}

// Open eagerly so a torrent of writes never has to race the open() call.
getLogStream();
void pruneLogFiles();

let shutdownRegistered = false;
function registerShutdownFlush() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const flush = () => {
    try {
      const s = logStream;
      if (s && !s.destroyed) {
        // end() flushes pending writes before closing the fd. We do not await
        // — the surrounding signal handler is best-effort and the watchdog
        // forces a hard exit shortly after.
        s.end();
      }
    } catch {}
  };
  try { process.on("SIGTERM", flush); } catch {}
  try { process.on("SIGINT", flush); } catch {}
  // beforeExit fires on a clean exit (no remaining work); useful when a test
  // harness or run script ends without a signal.
  try { process.on("beforeExit", flush); } catch {}
}
registerShutdownFlush();

export function getCurrentLogFile(): string {
  return currentLogFile;
}

export function getLogsDir(): string {
  return LOGS_DIR;
}

export function validateLogFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  const logsRoot = resolve(LOGS_DIR);
  if (!resolved.startsWith(logsRoot + "/") && resolved !== logsRoot) {
    throw new Error("Access denied: path outside logs directory");
  }
  return resolved;
}

export function resolveLogFilename(filename: string): string {
  const basename = filename.replace(/[/\\]/g, "");
  if (!basename.endsWith(".log")) {
    throw new Error("Access denied: invalid log filename");
  }
  return validateLogFilePath(join(LOGS_DIR, basename));
}

function boundLogMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  if (bytes.byteLength <= LOG_MESSAGE_MAX_BYTES) return message;
  return `${bytes.subarray(0, LOG_MESSAGE_MAX_BYTES).toString("utf8")}…[truncated]`;
}

function formatLogLine(level: string, source: string, message: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase().padEnd(7)}] [${source}] ${message}\n`;
}

function appendToLogFile(level: string, source: string, message: string): void {
  if (!shouldEmitLevel(level)) return;
  const line = formatLogLine(level, source, message);
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (currentLogBytes > 0 && currentLogBytes + lineBytes > LOG_FILE_MAX_BYTES) {
    rotateLogStream();
  }
  const s = getLogStream();
  if (!s) return;
  try {
    s.write(line);
    currentLogBytes += lineBytes;
  } catch {
    // Never throw from a logger.
  }
}

export function appendClientLog(level: string, source: string, message: string) {
  const normalizedLevel = level === "log" ? "info" : level.toLowerCase();
  if (!(normalizedLevel in LOG_LEVEL_RANK) || !shouldEmitLevel(normalizedLevel)) return;
  const clientSource = `client:${source.slice(0, 128)}`;
  const boundedMessage = boundLogMessage(redactSensitiveText(message));
  appendToLogFile(normalizedLevel, clientSource, boundedMessage);
  bufferLog(normalizedLevel, boundedMessage, clientSource);
  sink?.({ level: normalizedLevel, message: boundedMessage, source: clientSource });
}

export interface LogFileInfo {
  filename: string;
  path: string;
  size: number;
  createdAt: string;
}

export async function listLogFiles(): Promise<LogFileInfo[]> {
  try {
    let files: string[] = [];
    try {
      files = (await readdir(LOGS_DIR))
        .filter(f => f.endsWith(".log"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
    const out: LogFileInfo[] = [];
    for (const f of files) {
      const fullPath = join(LOGS_DIR, f);
      try {
        const st = await stat(fullPath);
        out.push({
          filename: f,
          path: fullPath,
          size: st.size,
          createdAt: f.replace(".log", "").replace(/_/g, " ").replace(/-/g, (m, offset: number) => offset > 10 ? ":" : "-"),
        });
      } catch {
        // skip files that disappeared between readdir and stat
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ParsedLogEntry {
  ts: string;
  level: string;
  source: string;
  message: string;
  line: number;
}

const LOG_LINE_REGEX = /^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[([^\]]+)\]\s+(.*)$/;

function parseLogLines(content: string, opts?: {
  limit?: number;
  since?: string;
  level?: string;
  source?: string;
  tail?: boolean;
}): ParsedLogEntry[] {
  const lines = content.split("\n").filter(l => l.trim());
  const parsed: ParsedLogEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(LOG_LINE_REGEX);
    if (match) {
      parsed.push({
        ts: match[1],
        level: match[2].toLowerCase(),
        source: match[3],
        message: match[4],
        line: i + 1,
      });
    }
  }

  let entries = parsed;

  if (opts?.since) {
    const sinceDate = new Date(opts.since);
    entries = entries.filter(e => new Date(e.ts) >= sinceDate);
  }

  if (opts?.level) {
    const minRank = LOG_LEVEL_RANK[opts.level.toLowerCase()] ?? 0;
    entries = entries.filter(e => (LOG_LEVEL_RANK[e.level] ?? 0) >= minRank);
  }

  if (opts?.source) {
    const src = opts.source.toLowerCase();
    entries = entries.filter(e => e.source.toLowerCase().includes(src));
  }

  const limit = opts?.limit || entries.length;
  if (opts?.tail !== false) {
    entries = entries.slice(-limit);
  } else {
    entries = entries.slice(0, limit);
  }

  return entries;
}

export async function readLogFile(filePath: string, opts?: {
  limit?: number;
  since?: string;
  level?: string;
  source?: string;
  tail?: boolean;
}): Promise<ParsedLogEntry[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parseLogLines(content, opts);
  } catch {
    return [];
  }
}

export interface PaginatedLogResult {
  entries: ParsedLogEntry[];
  total: number;
  offset: number;
  limit: number;
}

export async function readLogFileAsync(filePath: string, opts?: {
  limit?: number;
  offset?: number;
  since?: string;
  level?: string;
  source?: string;
  tail?: boolean;
}): Promise<PaginatedLogResult> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    const parsed: ParsedLogEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(LOG_LINE_REGEX);
      if (match) {
        parsed.push({
          ts: match[1],
          level: match[2].toLowerCase(),
          source: match[3],
          message: match[4],
          line: i + 1,
        });
      }
    }

    let entries = parsed;

    if (opts?.since) {
      const sinceDate = new Date(opts.since);
      entries = entries.filter(e => new Date(e.ts) >= sinceDate);
    }

    if (opts?.level) {
      const minRank = LOG_LEVEL_RANK[opts.level.toLowerCase()] ?? 0;
      entries = entries.filter(e => (LOG_LEVEL_RANK[e.level] ?? 0) >= minRank);
    }

    if (opts?.source) {
      const src = opts.source.toLowerCase();
      entries = entries.filter(e => e.source.toLowerCase().includes(src));
    }

    const total = entries.length;
    const limit = opts?.limit || 500;

    if (opts?.offset !== undefined) {
      entries = entries.slice(opts.offset, opts.offset + limit);
    } else if (opts?.tail !== false) {
      entries = entries.slice(-limit);
    } else {
      entries = entries.slice(0, limit);
    }

    return {
      entries,
      total,
      offset: opts?.offset ?? Math.max(0, total - limit),
      limit,
    };
  } catch {
    return { entries: [], total: 0, offset: 0, limit: opts?.limit || 500 };
  }
}

export function createLogger(module: string) {
  const prefix = `[${module}]`;
  const write = (consoleWrite: (...args: unknown[]) => void, sinkLevel: string, args: unknown[]) => {
    if (!shouldEmitLevel(sinkLevel)) return;
    const msg = boundLogMessage(formatArgs(args));
    consoleWrite(prefix, msg);
    bufferLog(sinkLevel, msg, module);
    appendToLogFile(sinkLevel, module, msg);
    sink?.({ level: sinkLevel, message: msg, source: module });
  };
  const info = (...args: unknown[]) => {
    write((...line) => console.log(...line), "info", args);
  };
  return {
    // Verbose: lazy-evaluated, zero-cost when disabled.
    // Pass a thunk to defer expensive string construction:
    //   log.verbose(() => `detail: ${expensiveComputation()}`);
    // Or a plain string when construction is trivial:
    //   log.verbose("simple message");
    verbose(msgOrThunk: string | (() => string)) {
      if (!_verboseEnabled) return;
      const msg = typeof msgOrThunk === "function" ? msgOrThunk() : msgOrThunk;
      write((...line) => console.debug(...line), "verbose", [msg]);
    },
    debug: (...args: unknown[]) => {
      write((...line) => console.debug(...line), "debug", args);
    },
    log: info,
    info,
    warn: (...args: unknown[]) => {
      write((...line) => console.warn(...line), "warn", args);
    },
    error: (...args: unknown[]) => {
      write((...line) => console.error(...line), "error", args);
    },
  };
}
