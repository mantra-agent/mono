import { createLogger } from "./log";

const log = createLogger("MemoryWatchdog");

const DEFAULT_WARNING_THRESHOLD = 0.70;
const DEFAULT_HIGH_THRESHOLD = 0.85;
const DEFAULT_CRITICAL_THRESHOLD = 0.90;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

interface WatchdogConfig {
  maxMemoryMB: number;
  warningThreshold?: number;
  highThreshold?: number;
  criticalThreshold?: number;
  checkIntervalMs?: number;
  drainTimeoutMs?: number;
  onGracefulShutdown?: () => Promise<void>;
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

let activeMaxMemoryMB: number | null = null;

export function getHeapUsageInfo() {
  const mem = process.memoryUsage();
  const maxMemoryBytes = activeMaxMemoryMB ? activeMaxMemoryMB * 1024 * 1024 : null;
  const rssUsedPct = maxMemoryBytes ? mem.rss / maxMemoryBytes : null;
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    maxMemoryBytes,
    maxMemoryMB: activeMaxMemoryMB,
    rssUsedPct: rssUsedPct === null ? null : Math.round(rssUsedPct * 1000) / 10,
  };
}

function getMemoryPressureExitCode(): number {
  const envCode = process.env.MEMORY_PRESSURE_EXIT_CODE;
  if (envCode) {
    const parsed = parseInt(envCode, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return 78;
}

export function startMemoryWatchdog(config: WatchdogConfig): void {
  if (watchdogTimer) return;

  const maxMemoryMB = config.maxMemoryMB;
  if (!Number.isFinite(maxMemoryMB) || maxMemoryMB <= 0) {
    log.error(`Memory watchdog disabled: invalid maxMemoryMB=${maxMemoryMB}`);
    return;
  }
  activeMaxMemoryMB = maxMemoryMB;
  const warningThreshold = config.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
  const highThreshold = config.highThreshold ?? DEFAULT_HIGH_THRESHOLD;
  const criticalThreshold = config.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
  const checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const onGracefulShutdown = config.onGracefulShutdown;

  const maxMemoryBytes = maxMemoryMB * 1024 * 1024;

  log.log(`Memory watchdog started: source=railway.serviceInstanceLimits maxMemory=${maxMemoryMB}MB, warn=${warningThreshold * 100}%, high=${highThreshold * 100}%, critical=${criticalThreshold * 100}%, interval=${checkIntervalMs}ms`);

  watchdogTimer = setInterval(async () => {
    if (isShuttingDown) return;

    const mem = process.memoryUsage();
    const ratio = mem.rss / maxMemoryBytes;

    if (ratio >= criticalThreshold) {
      log.error(`CRITICAL memory pressure: rss ${Math.round(mem.rss / 1024 / 1024)}MB / ${maxMemoryMB}MB (${(ratio * 100).toFixed(1)}%) — initiating graceful shutdown`);
      isShuttingDown = true;

      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }

      let drainComplete = false;

      try {
        if (onGracefulShutdown) {
          const shutdownPromise = onGracefulShutdown().then(() => {
            drainComplete = true;
          });
          const timeoutPromise = new Promise<void>(resolve => setTimeout(() => {
            if (!drainComplete) {
              log.warn(`Drain timeout reached (${drainTimeoutMs}ms) — proceeding with exit`);
            }
            resolve();
          }, drainTimeoutMs));
          await Promise.race([shutdownPromise, timeoutPromise]);
        }
      } catch (err: any) {
        log.error(`Error during graceful shutdown: ${err.message}`);
      }

      const exitCode = getMemoryPressureExitCode();
      log.error(`Memory watchdog: exiting process with code ${exitCode} for restart`);
      process.exit(exitCode);
    } else if (ratio >= highThreshold) {
      log.warn(`HIGH memory pressure: rss ${Math.round(mem.rss / 1024 / 1024)}MB / ${maxMemoryMB}MB (${(ratio * 100).toFixed(1)}%)`);
    } else if (ratio >= warningThreshold) {
      log.warn(`Elevated memory usage: rss ${Math.round(mem.rss / 1024 / 1024)}MB / ${maxMemoryMB}MB (${(ratio * 100).toFixed(1)}%)`);
    }
  }, checkIntervalMs);
}

export function stopMemoryWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  activeMaxMemoryMB = null;
}
