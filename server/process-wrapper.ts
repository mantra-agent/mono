// Use createLogger for logging ONLY
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createLogger } from "./log";
import {
  createSupervisorHealthToken,
  SUPERVISOR_HEALTH_HEADER,
  SUPERVISOR_HEALTH_PATH,
  SUPERVISOR_HEALTH_TOKEN_ENV,
} from "./supervisor-health-contract";

const log = createLogger("ProcessWrapper");

const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
// Health-check HTTP timeout. The process-local supervisor endpoint runs the
// same deep DB/pool probe as the authenticated operator endpoint and caps its
// DB work at ~2s internally. Five seconds gives that handler full headroom
// plus loopback scheduling slack. Three-strike kill logic is preserved below.
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_CHECK_FAILURES_BEFORE_KILL = 3;
const POOL_DEGRADED_FAILURES_BEFORE_KILL = 3;
const BOOT_HARD_TIMEOUT_MS = parseInt(process.env.BOOT_HARD_TIMEOUT_MS || "90000", 10);
// Silent-boot detection: kill the child if it produces no stdout for this long
// during the pre-BOOT_COMPLETE phase. This is the first signature observed in
// the 2026-04-28 stop-button wedge investigation: the boot sequence stalled
// silently during quarantine recovery and never reached __BOOT_COMPLETE__.
const SILENT_BOOT_STDOUT_SILENT_MS = parseInt(process.env.SILENT_BOOT_STDOUT_SILENT_MS || "30000", 10);
// Silent-but-alive runtime watchdog: after boot, if stdout falls silent for
// this long AND /api/health is also unresponsive, treat as wedged and SIGKILL.
const RUNTIME_WEDGE_STDOUT_SILENT_MS = parseInt(process.env.RUNTIME_WEDGE_STDOUT_SILENT_MS || "120000", 10);
const RUNTIME_WEDGE_CHECK_INTERVAL_MS = 30_000;
// Runtime-phase quick-health HTTP timeout. Bumped from 5s → 30s as part of
// Task #995. /api/health is now a trivial process-only handler so a healthy
// server responds in <10ms; the only reason it would take more than a few
// hundred ms is event-loop pressure, in which case we want to give it room
// rather than cause a wedge with a tight kill timer. Three-strike kill logic
// preserved.
const RUNTIME_WEDGE_HEALTH_TIMEOUT_MS = 30_000;
// Worker-thread heartbeat staleness threshold (Task #995, Step 7-8). The
// in-process heartbeat worker posts every 1s. If we go this long without one,
// the main thread is wedged or the worker died — either way, hard fail.
const WORKER_HEARTBEAT_DEAD_MS = parseInt(process.env.WORKER_HEARTBEAT_DEAD_MS || "10000", 10);
const MEMORY_PRESSURE_EXIT_CODE = 78;
const APPLICATION_HEAP_PERCENT = 75;
const BYTES_PER_MIB = 1024 * 1024;
const CGROUP_MEMORY_LIMIT_PATHS = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
] as const;
const BOOT_COMPLETE_MARKER = "__BOOT_COMPLETE__";
const PREV_BOOT_ID_FILE = path.join("/tmp", "watchdog-prev-boot-id");
const CHILD_PATH = "dist/index.mjs";
const WRAPPER_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "local"}:${process.pid}:${Date.now().toString(36)}`;

const PORT = parseInt(process.env.PORT || "5000", 10);
const isDev = process.env.NODE_ENV !== "production";

let child: ChildProcess | null = null;
let restartCount = 0;
let restartTimestamps: number[] = [];
let consecutiveHealthFailures = 0;
let consecutivePoolDegraded = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let bootDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
let silentBootTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeWedgeTimer: ReturnType<typeof setInterval> | null = null;
let bootComplete = false;
let childStartedAt = 0;
let lastStdoutAt = 0;
let lastStderrAt = 0;
let lastHealthOkAt = 0;
// Last worker-thread heartbeat received over IPC (Task #995, Step F).
// 0 means we have not yet received any heartbeat — until then the
// heartbeat-staleness rule does not vote in the kill decision so the
// watchdog falls back to stdout+health probes alone.
let lastHeartbeatAt = 0;
let isShuttingDown = false;
let currentBootId = "";
let prevBootId = "";
let forwardedSignal: NodeJS.Signals | null = null;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let pendingChildTerminationReason: string | null = null;
let workerDeadReason: string | null = null;
let supervisorHealthToken = "";
let previousExit: ChildExitEvidence | null = null;

interface ChildExitEvidence {
  bootId: string;
  observedAt: string;
  exitCode: number | null;
  signal: string | null;
  reason: string;
  terminationKind: "clean" | "unclean";
}

type LifecycleEvent =
  | "wrapper_boot"
  | "child_started"
  | "child_exit_observed"
  | "restart_decision"
  | "signal_forwarded"
  | "restart_budget_exhausted";

function timestamp(): string {
  return new Date().toISOString();
}

function logLifecycle(event: LifecycleEvent, details: Record<string, unknown>, level: "info" | "warn" | "error" = "info"): void {
  const payload = {
    event,
    observedAt: timestamp(),
    wrapperId: WRAPPER_ID,
    wrapperPid: process.pid,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    replicaId: process.env.RAILWAY_REPLICA_ID || null,
    ...details,
  };
  const line = `process_lifecycle ${JSON.stringify(payload)}`;
  if (level === "error") log.error(line);
  else if (level === "warn") log.warn(line);
  else log.info(line);
}

function recordObservedExit(reason: string, exitCode: number | null, signal: string | null): ChildExitEvidence {
  const evidence: ChildExitEvidence = {
    bootId: currentBootId,
    observedAt: timestamp(),
    exitCode,
    signal,
    reason,
    terminationKind: exitCode === 0 && signal === null ? "clean" : "unclean",
  };
  previousExit = evidence;
  logLifecycle("child_exit_observed", {
    childBootId: evidence.bootId,
    childPid: child?.pid ?? null,
    exitCode,
    signal,
    reason,
    terminationKind: evidence.terminationKind,
    restartCount,
    forwardedSignal,
  }, evidence.terminationKind === "clean" ? "info" : "warn");
  return evidence;
}

function pruneRestartTimestamps() {
  const cutoff = Date.now() - RESTART_WINDOW_MS;
  restartTimestamps = restartTimestamps.filter(t => t > cutoff);
}

function getBackoffMs(): number {
  const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, Math.min(restartCount - 1, 5)), MAX_BACKOFF_MS);
  return backoff;
}

interface HealthResult {
  ok: boolean;
  status: number | null;
  degraded: boolean;
  reasons: string[];
  poolSaturated: boolean;
}

// The wrapper needs the deep {degraded, reasons[]} payload for independent
// pool-saturation escalation. The trivial /api/health used by
// probeHealthQuick deliberately has no DB semantics. This request crosses a
// bounded parent-to-child capability boundary over loopback; it never weakens
// the authenticated /api/health/deep operator route.
function checkHealth(): Promise<HealthResult> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: SUPERVISOR_HEALTH_PATH,
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        headers: {
          [SUPERVISOR_HEALTH_HEADER]: supervisorHealthToken,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed: any = {};
          try { parsed = JSON.parse(data); } catch {}
          const reasons: string[] = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
          const degraded = parsed?.degraded === true;
          const poolSaturated = reasons.some((r: string) => typeof r === "string" && r.startsWith("pool_saturated"));
          resolve({
            ok: res.statusCode === 200 && !degraded,
            status: res.statusCode ?? null,
            degraded,
            reasons,
            poolSaturated,
          });
        });
      },
    );
    req.on("error", () => resolve({ ok: false, status: null, degraded: false, reasons: ["http_error"], poolSaturated: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: null, degraded: false, reasons: ["http_timeout"], poolSaturated: false });
    });
  });
}

// ── Shared liveness-kill predicate (Task #995) ────────────────────────────
// Single source of truth for "is this process actually wedged enough to
// SIGKILL?". Used by every liveness-based kill path (health-failure
// threshold, runtime-wedge watchdog, legacy stdout+health backstop) so
// they cannot drift apart.
//
// Rule (per task spec):
//   1. Worker-thread heartbeat staleness is REQUIRED. Without it we cannot
//      distinguish a real wedge from benign causes (DB-pool starvation
//      while the main thread is fine, transient gateway hiccups, bursty
//      stdout flush). The worker runs on its own libuv loop, so a stale
//      heartbeat is the strongest evidence we have that the process is
//      actually stuck.
//   2. Stdout silence past the runtime-wedge threshold is also REQUIRED.
//      A momentary canary skip during GC must not by itself trigger
//      SIGKILL — we want both signals jointly wedged before we declare
//      the process dead. /api/health failure status is captured for the
//      restart-event log only; it is not part of the kill predicate.
//
// Pool-saturation kills and boot-timeout kills are intentionally NOT
// routed through here — they are independent failure modes with their
// own escalation thresholds.
type LivenessEvidence = {
  stdoutSilentMs: number;
  heartbeatStaleMs: number;  // -1 if heartbeat never started (treated as missing)
  healthy: boolean | null;   // null when not probed in this pass — diagnostic only
};
function shouldKillForLiveness(ev: LivenessEvidence): { kill: boolean; reason: string } {
  const heartbeatWedged = ev.heartbeatStaleMs > WORKER_HEARTBEAT_DEAD_MS;
  const stdoutWedged = ev.stdoutSilentMs >= RUNTIME_WEDGE_STDOUT_SILENT_MS;
  if (!heartbeatWedged && !stdoutWedged) {
    return { kill: false, reason: "heartbeat-not-stale,stdout-not-silent" };
  }
  if (!heartbeatWedged) {
    return { kill: false, reason: "heartbeat-not-stale" };
  }
  if (!stdoutWedged) {
    return { kill: false, reason: "heartbeat-stale-but-stdout-flowing" };
  }
  return { kill: true, reason: "heartbeat-stale+stdout-silent" };
}

function startHealthChecks() {
  stopHealthChecks();
  consecutiveHealthFailures = 0;
  consecutivePoolDegraded = 0;

  healthCheckTimer = setInterval(async () => {
    if (isShuttingDown || !child) return;
    if (!bootComplete) return;

    const result = await checkHealth();

    if (result.ok) {
      if (consecutiveHealthFailures > 0 || consecutivePoolDegraded > 0) {
        log.log(`Health check recovered (failures=${consecutiveHealthFailures} poolDegraded=${consecutivePoolDegraded})`);
      }
      consecutiveHealthFailures = 0;
      consecutivePoolDegraded = 0;
      lastHealthOkAt = Date.now();
      return;
    }

    if (result.poolSaturated) {
      consecutivePoolDegraded++;
      log.warn(`Pool saturation degraded (${consecutivePoolDegraded}/${POOL_DEGRADED_FAILURES_BEFORE_KILL}) reasons=${result.reasons.join(",")}`);
      if (consecutivePoolDegraded >= POOL_DEGRADED_FAILURES_BEFORE_KILL) {
        log.error(`Pool wedged after ${POOL_DEGRADED_FAILURES_BEFORE_KILL} consecutive degraded probes — killing process`);
        killChild("pool_saturation");
        return;
      }
    } else {
      consecutiveHealthFailures++;
      log.warn(`Health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_FAILURES_BEFORE_KILL}) status=${result.status} reasons=${result.reasons.join(",")}`);
      if (consecutiveHealthFailures >= HEALTH_CHECK_FAILURES_BEFORE_KILL) {
        // Task #995: route all liveness kills through shouldKillForLiveness.
        // We just observed N consecutive /api/health failures (healthy=false);
        // the predicate decides whether that is enough by also checking
        // heartbeat staleness (REQUIRED) and stdout silence as the
        // corroborating signal class.
        const now = Date.now();
        const stdoutSilentMs = now - lastStdoutAt;
        const heartbeatStaleMs = lastHeartbeatAt > 0 ? now - lastHeartbeatAt : -1;
        const decision = shouldKillForLiveness({ stdoutSilentMs, heartbeatStaleMs, healthy: false });
        if (!decision.kill) {
          log.warn(`Health failures reached threshold but liveness predicate deferred kill (decision=${decision.reason} stdoutSilentMs=${stdoutSilentMs} heartbeatStaleMs=${heartbeatStaleMs}) — runtime-wedge / worker-canary watchdogs own escalation`);
          return;
        }
        try {
          process.stderr.write(`UNRESPONSIVE_KILL bootId=${currentBootId} consecutiveFailures=${consecutiveHealthFailures} stdoutSilentMs=${stdoutSilentMs} heartbeatStaleMs=${heartbeatStaleMs} decision=${decision.reason} ts=${timestamp()}\n`);
        } catch {}
        log.error(`Server unresponsive after ${HEALTH_CHECK_FAILURES_BEFORE_KILL} consecutive health check failures (decision=${decision.reason} stdoutSilentMs=${stdoutSilentMs} heartbeatStaleMs=${heartbeatStaleMs}) — killing process`);
        killChild("unresponsive");
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthChecks() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function startBootDeadline() {
  clearBootDeadline();
  bootComplete = false;
  bootDeadlineTimer = setTimeout(() => {
    if (bootComplete || isShuttingDown || !child) return;
    log.error(`Boot did not complete within ${BOOT_HARD_TIMEOUT_MS}ms — killing process`);
    killChild("boot_timeout");
  }, BOOT_HARD_TIMEOUT_MS);
}

function clearBootDeadline() {
  if (bootDeadlineTimer) {
    clearTimeout(bootDeadlineTimer);
    bootDeadlineTimer = null;
  }
}

function armSilentBootTimer() {
  if (silentBootTimer) clearTimeout(silentBootTimer);
  silentBootTimer = setTimeout(() => {
    if (bootComplete || isShuttingDown || !child) return;
    const silentMs = Date.now() - lastStdoutAt;
    const elapsed = Date.now() - childStartedAt;
    try {
      process.stderr.write(`SILENT_BOOT_WEDGE bootId=${currentBootId} prevBootId=${prevBootId || "none"} silentMs=${silentMs} elapsedMs=${elapsed} ts=${timestamp()}\n`);
    } catch {}
    log.error(`SILENT_BOOT_WEDGE — no stdout for ${silentMs}ms (boot elapsed=${elapsed}ms) — killing process`);
    killChild("silent_boot_wedge");
  }, SILENT_BOOT_STDOUT_SILENT_MS);
}

function clearSilentBootTimer() {
  if (silentBootTimer) {
    clearTimeout(silentBootTimer);
    silentBootTimer = null;
  }
}

function probeHealthQuick(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: PORT, path: "/api/health", timeout: RUNTIME_WEDGE_HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume();
        // 2026-04-28 stop-wedge code review: only 2xx counts as healthy.
        // Treating 3xx/4xx/5xx as healthy masked the silent-but-alive wedge
        // because a "still listening but every request hangs and returns
        // 502/504 from a layer above us" pattern was being treated as OK.
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        if (ok) lastHealthOkAt = Date.now();
        resolve(ok);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function startRuntimeWedgeWatchdog() {
  stopRuntimeWedgeWatchdog();
  runtimeWedgeTimer = setInterval(async () => {
    if (isShuttingDown || !child || !bootComplete) return;
    const now = Date.now();
    const silentMs = now - lastStdoutAt;
    const heartbeatStaleMs = lastHeartbeatAt > 0 ? now - lastHeartbeatAt : -1;

    // Task #995: heartbeat staleness is the REQUIRED primary signal for
    // any liveness-based SIGKILL on this path. The worker runs on its own
    // libuv loop, so a stale beat is the strongest evidence the main
    // thread is hard-stuck. We never kill from stdout-silence + health-
    // fail alone — that path produced false positives during DB-pool
    // starvation in the 2026-04-28 incident, where the main thread was
    // actually fine and the process recovered on its own.
    //
    // Probe /api/health only when the heartbeat is already stale, so we
    // avoid extra HTTP load in the steady state. If the heartbeat is
    // fresh, no liveness kill is possible from this watchdog (the
    // worker_canary IPC path handles canary loss separately, and pool /
    // boot watchdogs handle their own concerns).
    if (heartbeatStaleMs <= WORKER_HEARTBEAT_DEAD_MS) return;

    const healthy = await probeHealthQuick();
    const decision = shouldKillForLiveness({ stdoutSilentMs: silentMs, heartbeatStaleMs, healthy });
    if (!decision.kill) {
      // Heartbeat is stale but no corroborating signal yet — log once per
      // interval at warn level so operators can see the canary skipped
      // without being deafened during transient GC stalls.
      log.warn(`Heartbeat stale (${heartbeatStaleMs}ms) but kill deferred (decision=${decision.reason} silentMs=${silentMs} healthy=${healthy})`);
      return;
    }
    const healthSilentMs = lastHealthOkAt ? now - lastHealthOkAt : -1;
    try {
      const stderrSilentMs = lastStderrAt ? now - lastStderrAt : -1;
      process.stderr.write(`RUNTIME_WEDGE bootId=${currentBootId} decision=${decision.reason} heartbeatStaleMs=${heartbeatStaleMs} lastHeartbeatAt=${lastHeartbeatAt} silentMs=${silentMs} lastStdoutAt=${lastStdoutAt} lastStderrAt=${lastStderrAt} stderrSilentMs=${stderrSilentMs} lastHealthOkAt=${lastHealthOkAt} healthSilentMs=${healthSilentMs} healthy=${healthy} ts=${timestamp()}\n`);
    } catch {}
    log.error(`RUNTIME_WEDGE — ${decision.reason} (heartbeatStaleMs=${heartbeatStaleMs} silentMs=${silentMs} healthSilentMs=${healthSilentMs} healthy=${healthy}) — killing process`);
    killChild(`runtime_wedge:${decision.reason}`);
  }, RUNTIME_WEDGE_CHECK_INTERVAL_MS);
}

function stopRuntimeWedgeWatchdog() {
  if (runtimeWedgeTimer) {
    clearInterval(runtimeWedgeTimer);
    runtimeWedgeTimer = null;
  }
}

function onBootComplete() {
  if (bootComplete) return;
  bootComplete = true;
  clearBootDeadline();
  clearSilentBootTimer();
  lastHealthOkAt = Date.now();
  const elapsed = Date.now() - childStartedAt;
  log.log(`Boot complete (${elapsed}ms, bootId=${currentBootId})`);
  try {
    fs.writeFileSync(PREV_BOOT_ID_FILE, currentBootId, "utf8");
  } catch {}
  startRuntimeWedgeWatchdog();
}

function killChild(reason: string) {
  pendingChildTerminationReason = reason;
  if (child && child.pid) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

const WORKER_DEAD_EXIT_CODE = 79;

function classifyExitReason(code: number | null, signal: string | null): string {
  if (signal === "SIGKILL") return "killed";
  if (code === MEMORY_PRESSURE_EXIT_CODE) return "memory_pressure";
  if (code === WORKER_DEAD_EXIT_CODE) return "watchdog_exit_79";
  if (code !== null && code !== 0) return "crash";
  return "clean_exit";
}

function generateBootId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface ApplicationHeapBudget {
  heapMiB: number;
  availableMemoryMiB: number;
  source: string;
}

function readCgroupMemoryLimitBytes(): { bytes: number; source: string } | null {
  for (const limitPath of CGROUP_MEMORY_LIMIT_PATHS) {
    try {
      const raw = fs.readFileSync(limitPath, "utf8").trim();
      if (!raw || raw === "max") continue;
      const bytes = Number(raw);
      if (Number.isSafeInteger(bytes) && bytes > 0) {
        return { bytes, source: limitPath };
      }
    } catch {}
  }
  return null;
}

function resolveApplicationHeapBudget(): ApplicationHeapBudget {
  const cgroupLimit = readCgroupMemoryLimitBytes();
  const hostMemoryBytes = os.totalmem();
  const availableMemoryBytes = cgroupLimit
    ? Math.min(cgroupLimit.bytes, hostMemoryBytes)
    : hostMemoryBytes;
  const availableMemoryMiB = Math.max(1, Math.floor(availableMemoryBytes / BYTES_PER_MIB));
  const heapMiB = Math.max(
    1,
    Math.floor((availableMemoryMiB * APPLICATION_HEAP_PERCENT) / 100),
  );

  return {
    heapMiB,
    availableMemoryMiB,
    source: cgroupLimit?.source || "os.totalmem",
  };
}

function startChild() {
  pendingRestartTimer = null;
  pruneRestartTimestamps();

  if (restartTimestamps.length >= MAX_RESTARTS) {
    logLifecycle("restart_budget_exhausted", {
      childBootId: currentBootId || null,
      restartCount,
      startsInWindow: restartTimestamps.length,
      restartWindowMs: RESTART_WINDOW_MS,
      restartDecision: "give_up",
    }, "error");
    process.exit(1);
  }

  if (!isDev && !fs.existsSync(CHILD_PATH)) {
    logLifecycle("restart_budget_exhausted", {
      childPath: CHILD_PATH,
      restartCount,
      restartDecision: "give_up",
      reason: "child_artifact_missing",
    }, "error");
    process.exit(1);
  }

  const heapBudget = resolveApplicationHeapBudget();
  const childNodeArgs = [`--max-old-space-size=${heapBudget.heapMiB}`, CHILD_PATH];

  currentBootId = generateBootId();
  supervisorHealthToken = createSupervisorHealthToken();
  bootComplete = false;
  lastHeartbeatAt = 0;
  consecutiveHealthFailures = 0;
  consecutivePoolDegraded = 0;
  forwardedSignal = null;
  workerDeadReason = null;

  const childEnv = {
    ...process.env,
    WRAPPED_BY_WATCHDOG: "true",
    WATCHDOG_WRAPPER_ID: WRAPPER_ID,
    WATCHDOG_BOOT_ID: currentBootId,
    WATCHDOG_PREVIOUS_EXIT_JSON: previousExit ? JSON.stringify(previousExit) : "",
    MEMORY_PRESSURE_EXIT_CODE: String(MEMORY_PRESSURE_EXIT_CODE),
    [SUPERVISOR_HEALTH_TOKEN_ENV]: supervisorHealthToken,
  };

  // stdio: inherit stdin, pipe stdout/stderr so we can scan for boot marker,
  // plus a 4th IPC channel so the child can send heartbeat messages from its
  // worker thread (Task #995, Step F).
  const stdio: any = ["inherit", "pipe", "pipe", "ipc"];

  if (isDev) {
    const tsxPath = "./node_modules/.bin/tsx";
    child = spawn(tsxPath, ["server/index.ts"], {
      stdio,
      env: { ...childEnv, NODE_ENV: "development" },
    });
  } else {
    child = spawn("node", childNodeArgs, {
      stdio,
      env: { ...childEnv, NODE_ENV: "production" },
    });
  }

  childStartedAt = Date.now();
  lastStdoutAt = childStartedAt;
  lastStderrAt = childStartedAt;
  restartTimestamps.push(childStartedAt);

  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    // Liveness signal is stdout-only; stderr may itself be the wedge.
    lastStdoutAt = Date.now();
    if (!bootComplete) armSilentBootTimer();
    if (bootComplete) return;
    stdoutBuf += chunk.toString("utf8");
    if (stdoutBuf.includes(BOOT_COMPLETE_MARKER)) {
      onBootComplete();
      stdoutBuf = "";
    } else if (stdoutBuf.length > 8192) {
      // keep only the tail to bound memory while still detecting marker spanning chunks
      stdoutBuf = stdoutBuf.slice(-1024);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    // Tracked for diagnostics only. Stderr does NOT re-arm the silent-boot
    // timer: a wedged boot that emits a periodic stderr error must still
    // trip the stdout-silence kill within SILENT_BOOT_STDOUT_SILENT_MS.
    lastStderrAt = Date.now();
  });

  // IPC channel from the child (Task #995, Step F).
  //  - { type: "alive", t } — worker-thread heartbeat (Task #995 schema).
  //    If the main thread is wedged by sync work, the worker keeps beating
  //    but the forwarder cannot run, so we observe staleness even though
  //    stdout might still be flowing from buffered writes.
  //  - { type: "worker_dead", reason } — explicit canary-loss signal so we
  //    can log the cause; the child also exits with WORKER_DEAD_EXIT_CODE
  //    immediately after so the existing exit-handler path triggers a
  //    restart.
  child.on("message", (msg: any) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "alive") {
      lastHeartbeatAt = typeof msg.t === "number" ? msg.t : Date.now();
    } else if (msg.type === "worker_dead") {
      workerDeadReason = typeof msg.reason === "string" ? msg.reason : "unknown";
      log.error(`Worker canary dead — reason=${workerDeadReason}; awaiting child exit`);
    }
  });

  logLifecycle("child_started", {
    childBootId: currentBootId,
    childPid: child.pid ?? null,
    childPath: isDev ? "server/index.ts" : CHILD_PATH,
    previousChildBootId: previousExit?.bootId ?? (prevBootId || null),
    restartCount,
    startsInWindow: restartTimestamps.length,
    hardBootTimeoutMs: BOOT_HARD_TIMEOUT_MS,
    silentBootMs: SILENT_BOOT_STDOUT_SILENT_MS,
    runtimeWedgeMs: RUNTIME_WEDGE_STDOUT_SILENT_MS,
    applicationHeapMiB: heapBudget.heapMiB,
    availableMemoryMiB: heapBudget.availableMemoryMiB,
    applicationHeapPercent: APPLICATION_HEAP_PERCENT,
    memoryLimitSource: heapBudget.source,
  });

  startBootDeadline();
  armSilentBootTimer();
  startHealthChecks();

  child.on("exit", (code, signal) => {
    stopHealthChecks();
    clearBootDeadline();
    clearSilentBootTimer();
    stopRuntimeWedgeWatchdog();

    const reason = pendingChildTerminationReason || (workerDeadReason ? `worker_canary_dead:${workerDeadReason}` : classifyExitReason(code, signal));
    pendingChildTerminationReason = null;
    workerDeadReason = null;
    const evidence = recordObservedExit(reason, code, signal);

    if (isShuttingDown) {
      logLifecycle("restart_decision", {
        childBootId: evidence.bootId,
        exitCode: code,
        signal,
        terminationKind: evidence.terminationKind,
        restartCount,
        restartDecision: "shutdown",
        forwardedSignal,
      });
      process.exit(code ?? (signal ? 1 : 0));
      return;
    }

    if (evidence.terminationKind === "clean") {
      logLifecycle("restart_decision", {
        childBootId: evidence.bootId,
        exitCode: code,
        signal,
        terminationKind: evidence.terminationKind,
        restartCount,
        restartDecision: "stop",
        reason: "clean_child_exit",
      });
      process.exit(0);
      return;
    }

    restartCount++;
    const backoff = getBackoffMs();
    logLifecycle("restart_decision", {
      childBootId: evidence.bootId,
      exitCode: code,
      signal,
      terminationKind: evidence.terminationKind,
      restartCount,
      restartDecision: "restart",
      backoffMs: backoff,
      reason,
    }, "warn");
    pendingRestartTimer = setTimeout(startChild, backoff);
  });
}

function setupSignalForwarding() {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const sig of signals) {
    process.on(sig, () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      forwardedSignal = sig;
      stopHealthChecks();
      clearBootDeadline();
      clearSilentBootTimer();
      stopRuntimeWedgeWatchdog();
      if (pendingRestartTimer) {
        clearTimeout(pendingRestartTimer);
        pendingRestartTimer = null;
      }
      const forwarded = Boolean(child?.pid && child.kill(sig));
      logLifecycle("signal_forwarded", {
        signal: sig,
        childBootId: currentBootId || null,
        childPid: child?.pid ?? null,
        forwarded,
      });
      if (!child?.pid) process.exit(0);
      setTimeout(() => {
        logLifecycle("restart_decision", {
          childBootId: currentBootId || null,
          childPid: child?.pid ?? null,
          restartDecision: "give_up",
          reason: "child_shutdown_timeout",
          forwardedSignal: sig,
        }, "error");
        process.exit(1);
      }, 10_000).unref();
    });
  }
}

function loadPrevBootId(): void {
  try {
    if (fs.existsSync(PREV_BOOT_ID_FILE)) {
      prevBootId = fs.readFileSync(PREV_BOOT_ID_FILE, "utf8").trim();
    }
  } catch {}
}

logLifecycle("wrapper_boot", {
  dev: isDev,
  port: PORT,
  childPath: isDev ? "server/index.ts" : CHILD_PATH,
  hardBootTimeoutMs: BOOT_HARD_TIMEOUT_MS,
  maxRestarts: MAX_RESTARTS,
  restartWindowMs: RESTART_WINDOW_MS,
});
loadPrevBootId();
setupSignalForwarding();
startChild();
