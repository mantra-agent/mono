// Use createLogger for logging ONLY
import os from "os";
import { getHeapUsageInfo } from "./memory-watchdog";
import type { Request, Response, NextFunction } from "express";
import { SUPERVISOR_HEALTH_PATH } from "./supervisor-health-contract";
import { createLogger } from "./log";

const log = createLogger("PerformanceMonitor");

interface TimingEntry {
  duration: number;
  timestamp: number;
  error: boolean;
}

interface RouteTimings {
  entries: TimingEntry[];
  route: string;
  method: string;
}

interface BootPhase {
  name: string;
  durationMs: number;
}

interface BootTimingData {
  phases: BootPhase[];
  totalMs: number;
  bootedAt: string;
}

interface TimestampedSample {
  value: number;
  ts: number;
}

const MAX_ENTRIES = 200;
const ENTRY_TTL = 30 * 60 * 1000;
const HISTORY_LENGTH = 60;

const routeTimings = new Map<string, RouteTimings>();

const eventLoopSamples: number[] = [];
const MAX_SAMPLES = 60;
let eventLoopInterval: ReturnType<typeof setInterval> | null = null;

let bootTiming: BootTimingData | null = null;

const cpuHistory: TimestampedSample[] = [];
const memHistory: TimestampedSample[] = [];
const eventLoopHistory: TimestampedSample[] = [];
const rpsHistory: TimestampedSample[] = [];

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();

let requestCount = 0;
let lastRpsCheck = Date.now();
let wsConnectionCount = 0;

export function recordBootTiming(phases: BootPhase[], totalMs: number) {
  bootTiming = {
    phases,
    totalMs,
    bootedAt: new Date().toISOString(),
  };
}

export function setWsConnectionCount(count: number) { wsConnectionCount = count; }

function pushSample(arr: TimestampedSample[], value: number) {
  arr.push({ value, ts: Date.now() });
  if (arr.length > HISTORY_LENGTH) arr.shift();
}

function sampleCpu() {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedUs = Number(now - lastCpuTime) / 1000;
  if (elapsedUs <= 0) return;
  const userDelta = usage.user - lastCpuUsage.user;
  const sysDelta = usage.system - lastCpuUsage.system;
  const cpuPct = ((userDelta + sysDelta) / elapsedUs) * 100;
  lastCpuUsage = usage;
  lastCpuTime = now;
  pushSample(cpuHistory, Math.round(cpuPct * 10) / 10);
}

function sampleMemory() {
  const mem = process.memoryUsage();
  pushSample(memHistory, mem.rss);
}

function sampleRps() {
  const now = Date.now();
  const elapsed = (now - lastRpsCheck) / 1000;
  if (elapsed <= 0) return;
  const rps = requestCount / elapsed;
  pushSample(rpsHistory, Math.round(rps * 10) / 10);
  requestCount = 0;
  lastRpsCheck = now;
}

function normalizeRoute(path: string): string {
  return path
    .replace(/\/\d+/g, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
    .replace(/\/[A-Za-z0-9_-]{20,}/g, "/:token");
}

export function apiTimingMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api")) return next();
  if (req.path === "/api/diagnostics/performance") return next();
  if (req.path === "/api/health" || req.path === SUPERVISOR_HEALTH_PATH) return next();

  requestCount++;

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = durationNs / 1_000_000;
    const route = normalizeRoute(req.path);
    const method = req.method;
    const key = `${method} ${route}`;

    let timings = routeTimings.get(key);
    if (!timings) {
      timings = { entries: [], route, method };
      routeTimings.set(key, timings);
    }

    timings.entries.push({
      duration: durationMs,
      timestamp: Date.now(),
      error: res.statusCode >= 400,
    });

    if (timings.entries.length > MAX_ENTRIES) {
      timings.entries = timings.entries.slice(-MAX_ENTRIES);
    }
  });

  next();
}

// Event-loop self-exit watchdog (Task #809).
//
// In the Apr 20 incident the process didn't crash — it kept the TCP
// listener open and served 504s for ~hour because the event loop was
// blocked but no health check tripped. The platform supervisor will
// restart us cleanly if we exit, so when we observe N consecutive lag
// samples above the threshold we exit loudly and let the supervisor
// pick us back up.
//
// Defaults: opt-in via env so dev / tests don't trip it. In prod,
// setting `EVENT_LOOP_WATCHDOG_LAG_MS=15000` and
// `EVENT_LOOP_WATCHDOG_CONSECUTIVE=3` means a 3 × 2s = 6s sustained
// >15s lag triggers exit (≈30s of stall).
const WATCHDOG_LAG_MS = parseInt(process.env.EVENT_LOOP_WATCHDOG_LAG_MS || "0", 10);
const WATCHDOG_CONSECUTIVE = Math.max(1, parseInt(process.env.EVENT_LOOP_WATCHDOG_CONSECUTIVE || "3", 10));
let watchdogConsecutive = 0;
let watchdogTriggered = false;

function maybeTriggerEventLoopWatchdog(lagMs: number) {
  if (!Number.isFinite(WATCHDOG_LAG_MS) || WATCHDOG_LAG_MS <= 0) return;
  if (watchdogTriggered) return;
  if (lagMs >= WATCHDOG_LAG_MS) {
    watchdogConsecutive++;
    if (watchdogConsecutive >= WATCHDOG_CONSECUTIVE) {
      watchdogTriggered = true;
      log.error(
        `[Watchdog] EVENT-LOOP STALL — self-exit due to event-loop stall — lagMs=${Math.round(lagMs)}, samples=${watchdogConsecutive}, threshold=${WATCHDOG_LAG_MS}ms × ${WATCHDOG_CONSECUTIVE} consecutive. Process exiting (1) so the supervisor restarts us cleanly.`,
      );
      // Schedule the exit one tick out so the log line gets flushed.
      setImmediate(() => process.exit(1));
    }
  } else {
    watchdogConsecutive = 0;
  }
}

// Stack-capture threshold for event-loop stalls (Task #1025).
// At 500ms+ we're well outside normal jitter; capture a stack trace and
// (best-effort) trigger a wedge-watchdog snapshot so post-mortems aren't
// guesswork. Deduplicated so a sustained stall doesn't spam logs/snapshots.
const STALL_CAPTURE_THRESHOLD_MS = 500;
const STALL_CAPTURE_DEDUPE_MS = 30_000;
let lastStallCaptureAt = 0;

function captureEventLoopStallSnapshot(lagMs: number) {
  const now = Date.now();
  if (now - lastStallCaptureAt < STALL_CAPTURE_DEDUPE_MS) return;
  lastStallCaptureAt = now;
  // Note: by the time setImmediate fires, the offending sync work has
  // already returned, so this stack snapshot only captures *our* call
  // chain at detection time. The richer signal comes from wedge-watchdog
  // (subsystem in-flight counters), which we trigger below.
  const detectionStack = new Error("event-loop-stall-detection-marker").stack || "(no stack available)";
  log.warn(`[EventLoopStall] lag=${Math.round(lagMs)}ms — detection stack:\n${detectionStack}`);
  try {
    // Lazy-require to avoid pulling wedge-watchdog into modules that don't
    // need it. The snapshot file lands in /tmp (or WEDGE_SNAPSHOT_DIR) and
    // includes per-subsystem in-flight counts at the moment of capture.
    const ww = require("./wedge-watchdog");
    if (typeof ww.writeSnapshotFile === "function") {
      ww.writeSnapshotFile();
    }
  } catch { /* watchdog unavailable in this environment */ }
}

function measureEventLoopLag() {
  const start = process.hrtime.bigint();
  setImmediate(() => {
    const lagNs = Number(process.hrtime.bigint() - start);
    const lagMs = lagNs / 1_000_000;
    eventLoopSamples.push(lagMs);
    if (eventLoopSamples.length > MAX_SAMPLES) {
      eventLoopSamples.shift();
    }
    pushSample(eventLoopHistory, Math.round(lagMs * 100) / 100);

    if (lagMs > 10_000) {
      log.error(`event loop blocked for ${Math.round(lagMs)}ms`);
    } else if (lagMs > 2_000) {
      log.warn(`event loop blocked for ${Math.round(lagMs)}ms`);
    }

    if (lagMs > STALL_CAPTURE_THRESHOLD_MS) {
      captureEventLoopStallSnapshot(lagMs);
    }

    maybeTriggerEventLoopWatchdog(lagMs);
  });
}

export function getLatestEventLoopLag(): number {
  return eventLoopSamples.length > 0 ? eventLoopSamples[eventLoopSamples.length - 1] : 0;
}

export function startEventLoopMonitor() {
  if (eventLoopInterval) return;
  eventLoopInterval = setInterval(measureEventLoopLag, 2000);
  measureEventLoopLag();

  setInterval(() => {
    sampleCpu();
    sampleMemory();
    sampleRps();
  }, 2000);

  sampleCpu();
  sampleMemory();
}

export function getPerformanceDiagnostics() {
  const now = Date.now();
  const cutoff = now - ENTRY_TTL;

  const apiTimings = Array.from(routeTimings.values()).map((t) => {
    const recent = t.entries.filter((e) => e.timestamp > cutoff);
    if (recent.length === 0) return null;

    const durations = recent.map((e) => e.duration).sort((a, b) => a - b);
    const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
    const p95Index = Math.min(Math.floor(durations.length * 0.95), durations.length - 1);

    return {
      route: t.route,
      method: t.method,
      avg: Math.round(avg * 100) / 100,
      p95: Math.round(durations[p95Index] * 100) / 100,
      count: recent.length,
      errors: recent.filter((e) => e.error).length,
    };
  }).filter(Boolean);

  const currentLag = eventLoopSamples.length > 0 ? eventLoopSamples[eventLoopSamples.length - 1] : 0;
  const avgLag = eventLoopSamples.length > 0
    ? eventLoopSamples.reduce((s, v) => s + v, 0) / eventLoopSamples.length
    : 0;
  const maxLag = eventLoopSamples.length > 0 ? Math.max(...eventLoopSamples) : 0;

  const mem = process.memoryUsage();
  const watchdogMemory = getHeapUsageInfo();
  const totalSystemMemory = os.totalmem();
  const freeSystemMemory = os.freemem();
  const loadAvg = os.loadavg();

  return {
    buildMode: process.env.NODE_ENV === "production" ? "production" : "development",
    eventLoopLag: {
      current: Math.round(currentLag * 100) / 100,
      avg: Math.round(avgLag * 100) / 100,
      max: Math.round(maxLag * 100) / 100,
    },
    uptime: Math.floor(process.uptime()),
    memoryUsage: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      maxMemoryBytes: watchdogMemory.maxMemoryBytes,
      maxMemoryMB: watchdogMemory.maxMemoryMB,
      rssUsedPct: watchdogMemory.rssUsedPct,
      limitSource: watchdogMemory.maxMemoryBytes ? "railway.serviceInstanceLimits" : null,
    },
    system: {
      cpuCores: os.cpus().length,
      loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
      totalMemory: totalSystemMemory,
      freeMemory: freeSystemMemory,
      platform: os.platform(),
      arch: os.arch(),
    },
    realtime: {
      cpu: {
        current: cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1].value : 0,
        history: cpuHistory.map(s => s.value),
      },
      rss: {
        current: mem.rss,
        history: memHistory.map(s => s.value),
      },
      eventLoop: {
        current: Math.round(currentLag * 100) / 100,
        history: eventLoopHistory.map(s => s.value),
      },
      rps: {
        current: rpsHistory.length > 0 ? rpsHistory[rpsHistory.length - 1].value : 0,
        history: rpsHistory.map(s => s.value),
      },
      wsConnections: wsConnectionCount,
    },
    apiTimings,
    bootTiming,
  };
}
