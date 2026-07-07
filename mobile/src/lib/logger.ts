type Module =
  | 'Auth'
  | 'Surface'
  | 'ChatSheet'
  | 'Pro'
  | 'WebView'
  | 'Config'
  | 'Navigation'
  | 'NativeDiagnostics'
  | 'SimpleScreen'
  | 'GlassesSession'
  | 'VoiceSession'
  | 'DATBridge'
  | 'PrimaryScreen'
  | 'App';

// ---------------------------------------------------------------------------
// Server-side log shipping
// ---------------------------------------------------------------------------
// Buffers log entries and periodically flushes them to the server's
// /api/client-logs endpoint — same one the web client uses. This gives
// full native-side visibility in the server log viewer.

interface LogEntry {
  level: string;
  source: string;
  message: string;
  ts: number;
}

let pendingLogs: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let serverUrl: string | null = null;

const FLUSH_INTERVAL_MS = 2_000;
const MAX_BATCH_SIZE = 50;
const MAX_PENDING = 500; // prevent unbounded growth if server is unreachable

/** Call once at app startup to enable server-side log shipping. */
export function initRemoteLogging(url: string) {
  serverUrl = url.replace(/\/+$/, '');
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
}

async function flushLogs() {
  flushTimer = null;
  if (pendingLogs.length === 0 || !serverUrl) return;

  const batch = pendingLogs.splice(0, MAX_BATCH_SIZE);
  if (pendingLogs.length > 0) scheduleFlush();

  try {
    await fetch(`${serverUrl}/api/client-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    // Silently drop if server unreachable. Don't re-queue to avoid loops.
  }
}

function ship(level: string, source: string, message: string) {
  if (!serverUrl) return;
  if (pendingLogs.length >= MAX_PENDING) {
    // Drop oldest to prevent unbounded growth
    pendingLogs.splice(0, pendingLogs.length - MAX_PENDING + 1);
  }
  pendingLogs.push({ level, source: `mobile:${source}`, message, ts: Date.now() });
  scheduleFlush();
}

function formatData(data: unknown): string {
  if (data === undefined || data === null || data === '') return '';
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' [unserializable]';
  }
}

// ---------------------------------------------------------------------------
// Public Logger API — unchanged interface, now ships to server
// ---------------------------------------------------------------------------

function debug(module: Module, message: string, data?: unknown) {
  console.debug(`[${module}] ${message}`, data ?? '');
  ship('debug', module, message + formatData(data));
}

function log(module: Module, message: string, data?: unknown) {
  console.log(`[${module}] ${message}`, data ?? '');
  ship('info', module, message + formatData(data));
}

function info(module: Module, message: string, data?: unknown) {
  console.log(`[${module}] ${message}`, data ?? '');
  ship('info', module, message + formatData(data));
}

function warn(module: Module, message: string, data?: unknown) {
  console.warn(`[${module}] ${message}`, data ?? '');
  ship('warn', module, message + formatData(data));
}

function error(module: Module, message: string, data?: unknown) {
  console.error(`[${module}] ${message}`, data ?? '');
  ship('error', module, message + formatData(data));
}

export const Logger = { debug, log, info, warn, error };
export default Logger;
