// Use createLogger for logging ONLY — do not use console.log/warn/error directly anywhere in the codebase

interface LogEntry {
  level: string;
  source: string;
  message: string;
  ts: number;
}

let pendingLogs: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
}

async function flushLogs() {
  flushTimer = null;
  if (pendingLogs.length === 0) return;

  const batch = pendingLogs.splice(0, MAX_BATCH_SIZE);
  if (pendingLogs.length > 0) scheduleFlush();

  try {
    await fetch("/api/client-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    // silently drop if server unreachable
  }
}

function serializeLogArg(arg: unknown, seen = new WeakSet<object>()): unknown {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
      cause: arg.cause ? serializeLogArg(arg.cause, seen) : undefined,
      ...Object.fromEntries(Object.entries(arg)),
    };
  }

  if (arg instanceof Event) {
    return {
      type: arg.type,
      target: arg.target instanceof Element ? arg.target.tagName : null,
      currentTarget: arg.currentTarget instanceof Element ? arg.currentTarget.tagName : null,
      defaultPrevented: arg.defaultPrevented,
    };
  }

  if (typeof arg !== "object" || arg === null) return arg;

  if (seen.has(arg)) return "[Circular]";
  seen.add(arg);

  if (Array.isArray(arg)) {
    return arg.map((item) => serializeLogArg(item, seen));
  }

  return Object.fromEntries(
    Object.entries(arg).map(([key, value]) => [key, serializeLogArg(value, seen)]),
  );
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(serializeLogArg(arg));
      } catch (error) {
        return JSON.stringify({
          unserializable: true,
          type: typeof arg,
          serializerError: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .join(" ");
}

// ── Verbose logging ──────────────────────────────────────────────────────
// Client-side mirror of server verbose. When disabled (default), verbose()
// is a no-op that never evaluates its thunk argument.
let _verboseEnabled = false;
export function isVerboseEnabled(): boolean { return _verboseEnabled; }
export function setVerboseEnabled(enabled: boolean): void { _verboseEnabled = enabled; }

export function createLogger(module: string) {
  const prefix = `[${module}]`;
  function ship(level: string, message: string) {
    pendingLogs.push({ level, source: module, message, ts: Date.now() });
    scheduleFlush();
  }

  return {
    verbose(msgOrThunk: string | (() => string)) {
      if (!_verboseEnabled) return;
      const msg = typeof msgOrThunk === "function" ? msgOrThunk() : msgOrThunk;
      console.debug(prefix, msg);
      ship("verbose", msg);
    },
    debug: (...args: unknown[]) => {
      console.debug(prefix, ...args);
      ship("debug", formatArgs(args));
    },
    log: (...args: unknown[]) => {
      console.log(prefix, ...args);
      ship("info", formatArgs(args));
    },
    info: (...args: unknown[]) => {
      console.log(prefix, ...args);
      ship("info", formatArgs(args));
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args);
      ship("warn", formatArgs(args));
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args);
      ship("error", formatArgs(args));
    },
  };
}
