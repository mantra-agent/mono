// Use createLogger for logging ONLY — do not use console.log/warn/error directly anywhere in the codebase
import {
  deriveSafeErrorCallsite,
  deriveSafeErrorClassifier,
  selectErrorStack,
} from "@shared/error-callsite";

interface ErrorAggregateProjection {
  deliveryId: string;
  logger: string;
  errorName?: string;
  errorCode?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceSite?: string;
}

interface LogEntry {
  level: string;
  source: string;
  message: string;
  ts: number;
  aggregate?: ErrorAggregateProjection;
}

let pendingLogs: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50;
const MAX_PENDING_LOGS = 200;
const MAX_LOG_MESSAGE_CHARS = 16_384;
const IS_PRODUCTION = import.meta.env.PROD;

function scheduleFlush() {
  if (flushTimer || typeof window === "undefined") return;
  flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
}

function deliverLogs(batch: LogEntry[], exiting = false): void {
  const body = JSON.stringify({ entries: batch });
  if (exiting && typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon("/api/client-logs", new Blob([body], { type: "application/json" }))) return;
    } catch {}
  }
  void fetch("/api/client-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: exiting,
  }).catch(() => {});
}

function flushLogs(exiting = false) {
  flushTimer = null;
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs.splice(0, MAX_BATCH_SIZE);
  if (pendingLogs.length > 0 && !exiting) scheduleFlush();
  deliverLogs(batch, exiting);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushLogs(true));
}

function shouldShip(level: string): boolean {
  if (level === "verbose") return _verboseEnabled;
  if (level === "debug") return !IS_PRODUCTION || _verboseEnabled;
  return level === "info" || level === "warn" || level === "error";
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
    .join(" ")
    .slice(0, MAX_LOG_MESSAGE_CHARS);
}

// ── Verbose logging ──────────────────────────────────────────────────────
// Client-side mirror of server verbose. When disabled (default), verbose()
// is a no-op that never evaluates its thunk argument.
let _verboseEnabled = false;
let diagnosticStateLoaded = !IS_PRODUCTION;
let loadingDiagnosticState: Promise<void> | null = null;

export function isVerboseEnabled(): boolean { return _verboseEnabled; }
export function setVerboseEnabled(enabled: boolean): void {
  _verboseEnabled = enabled;
  diagnosticStateLoaded = true;
}

export function initializeDiagnosticLogging(): Promise<void> {
  if (diagnosticStateLoaded || typeof window === "undefined") return Promise.resolve();
  if (loadingDiagnosticState) return loadingDiagnosticState;
  loadingDiagnosticState = fetch("/api/logs/verbose", { credentials: "include" })
    .then((response) => response.ok ? response.json() : { enabled: false })
    .then((data: { enabled?: boolean }) => {
      setVerboseEnabled(data.enabled === true);
    })
    .catch(() => {
      diagnosticStateLoaded = true;
    })
    .finally(() => {
      loadingDiagnosticState = null;
    });
  return loadingDiagnosticState;
}

export function createLogger(module: string) {
  const prefix = `[${module}]`;
  function ship(level: string, message: string, args: unknown[] = []) {
    if (!shouldShip(level)) return;
    if (pendingLogs.length >= MAX_PENDING_LOGS) pendingLogs.shift();
    const entry: LogEntry = { level, source: module, message: message.slice(0, MAX_LOG_MESSAGE_CHARS), ts: Date.now() };
    if (level === "error") {
      const errorArg = args.find((arg) => arg instanceof Error) as Error | undefined
        ?? args.map((arg) => arg && typeof arg === "object" ? (arg as { error?: unknown }).error : undefined)
          .find((value) => value instanceof Error) as Error | undefined;
      const nestedError = args
        .map((arg) => (arg && typeof arg === "object" ? (arg as { error?: unknown }).error : undefined))
        .find((value) => value && typeof value === "object");
      const classifier = deriveSafeErrorClassifier({
        message,
        error: errorArg ?? nestedError,
        args,
      });
      const stack = selectErrorStack({
        error: errorArg,
        nestedError,
        fallbackStack: errorArg || nestedError ? undefined : new Error().stack,
      });
      const callsite = deriveSafeErrorCallsite(stack);
      entry.aggregate = {
        deliveryId: crypto.randomUUID(),
        logger: module,
        errorName: classifier.errorName,
        errorCode: classifier.errorCode,
        ...callsite,
        sourceSite: callsite.sourceSite ?? module,
      };
    }
    pendingLogs.push(entry);
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
      if (IS_PRODUCTION && !_verboseEnabled) return;
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
      ship("error", formatArgs(args), args);
    },
  };
}
