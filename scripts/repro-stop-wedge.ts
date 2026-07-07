/**
 * Repro harness for the 2026-04-28 stop-button server wedge.
 *
 * Goal: turn a vague "the stop button hangs and the server goes silent"
 * regression into a deterministic, asserting test that fails CI when any of
 * the protections from task #984 regress.
 *
 * What it asserts:
 *   1. Abort RTT  ≤ ABORT_DEADLINE_MS  per iteration. This catches the
 *      original 1669 ms wedge of POST /api/sessions/:id/abort.
 *   2. Post-abort /api/health stays 2xx for POST_ABORT_PROBE_MS — the
 *      "silent-but-alive" signature where the abort route returns but the
 *      next request hangs.
 *   3. event-loop p99 stall during the abort window stays under
 *      EVENT_LOOP_P99_BUDGET_MS. perf_hooks.monitorEventLoopDelay is the
 *      only way to detect "JS still running but blocking other I/O".
 *      (only meaningful in SPAWN_SERVER=1 mode — we measure the harness's
 *      own loop while the server we spawned is being hammered.)
 *   4. /api/health.reasons[] never contains "pool_saturated*" entries that
 *      persist for ≥ POOL_SATURATED_BUDGET_MS, i.e. the DB pool recovers.
 *   5. The total in-flight executor runs across all parallel sessions at
 *      abort time was ≥ MIN_INFLIGHT_RUNS (default 5). Sum of `count` in
 *      the abort responses is the ground-truth count of runs the executor
 *      had registered when SIGABRT-equivalent fired. Without this gate the
 *      harness could pass with 5 sessions but 0 actual in-flight runs
 *      (e.g. all completed naturally before ABORT_DELAY_MS elapsed),
 *      which would NOT exercise the pool-saturation wedge class at all.
 *   6. When SPAWN_SERVER=1, every expected AbortTrace stage appears in
 *      captured stderr (route_enter, runs_signalled, route_exit,
 *      db_status_updated|db_status_update_failed, db_status_sql_updated|
 *      db_status_sql_failed). Missing stages = a regression that silently
 *      removed instrumentation we rely on for post-mortems.
 *
 * Modes:
 *   - default: hits an already-running server at BASE_URL and asserts the
 *     route-level guarantees only.
 *   - SPAWN_SERVER=1: spawns the server itself, captures stderr, asserts
 *     the AbortTrace stages, and applies a fresh server per run. This is
 *     the CI-quality mode.
 *
 * Concurrency:
 *   - PARALLEL_SESSIONS controls how many sessions are aborted in parallel
 *     per iteration. The 2026-04-28 incident only triggered under
 *     concurrent abort+stream load, so the default is 4.
 *
 * Run:  tsx scripts/repro-stop-wedge.ts
 *       SPAWN_SERVER=1 tsx scripts/repro-stop-wedge.ts
 *
 * Env (all optional):
 *   BASE_URL                     default http://127.0.0.1:5000
 *   SPAWN_SERVER                 default 0 — when 1, spawn server ourselves
 *   SPAWN_PORT                   default 5050 (only when SPAWN_SERVER=1)
 *   SPAWN_BOOT_TIMEOUT_MS        default 30000
 *   ABORT_DELAY_MS               default 200
 *   ABORT_DEADLINE_MS            default 50    (route should respond <50ms — code-review acceptance bar)
 *   POST_ABORT_PROBE_MS          default 5000
 *   POST_ABORT_PROBE_INTERVAL_MS default 250
 *   HEALTH_PROBE_TIMEOUT_MS      default 2000
 *   ITERATIONS                   default 3
 *   PARALLEL_SESSIONS            default 5  (>= MIN_INFLIGHT_RUNS)
 *   MIN_INFLIGHT_RUNS            default 5  (acceptance bar — sum of abort `count` must reach this)
 *   EVENT_LOOP_P99_BUDGET_MS     default 200   (acceptance bar)
 *   EVENT_LOOP_MAX_BUDGET_MS     default 200   (acceptance bar — single stall ceiling)
 *   POOL_SATURATED_BUDGET_MS     default 2000  (acceptance bar — pool must recover within 2s)
 *   POOL_MIN_RECOVERY_MS         default 2000  (idle ≥ 1 must be observed within 2s post-abort)
 *   MESSAGE                      default "Repro: please stream a long answer."
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";

const SPAWN_SERVER = process.env.SPAWN_SERVER === "1";
const SPAWN_PORT = parseInt(process.env.SPAWN_PORT || "5050", 10);
const SPAWN_BOOT_TIMEOUT_MS = parseInt(process.env.SPAWN_BOOT_TIMEOUT_MS || "30000", 10);
const BASE_URL = process.env.BASE_URL || (SPAWN_SERVER ? `http://127.0.0.1:${SPAWN_PORT}` : "http://127.0.0.1:5000");
const ABORT_DELAY_MS = parseInt(process.env.ABORT_DELAY_MS || "1000", 10);
const ABORT_DEADLINE_MS = parseInt(process.env.ABORT_DEADLINE_MS || "50", 10);
const POST_ABORT_PROBE_MS = parseInt(process.env.POST_ABORT_PROBE_MS || "5000", 10);
const POST_ABORT_PROBE_INTERVAL_MS = parseInt(process.env.POST_ABORT_PROBE_INTERVAL_MS || "250", 10);
const HEALTH_PROBE_TIMEOUT_MS = parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS || "2000", 10);
const ITERATIONS = parseInt(process.env.ITERATIONS || "3", 10);
const PARALLEL_SESSIONS = parseInt(process.env.PARALLEL_SESSIONS || "5", 10);
const MIN_INFLIGHT_RUNS = parseInt(process.env.MIN_INFLIGHT_RUNS || "5", 10);
const EVENT_LOOP_P99_BUDGET_MS = parseInt(process.env.EVENT_LOOP_P99_BUDGET_MS || "200", 10);
const EVENT_LOOP_MAX_BUDGET_MS = parseInt(process.env.EVENT_LOOP_MAX_BUDGET_MS || "200", 10);
const POOL_SATURATED_BUDGET_MS = parseInt(process.env.POOL_SATURATED_BUDGET_MS || "2000", 10);
const POOL_MIN_RECOVERY_MS = parseInt(process.env.POOL_MIN_RECOVERY_MS || "2000", 10);
const MESSAGE = process.env.MESSAGE || "Repro: please stream a long answer.";

const REQUIRED_ABORT_STAGES = [
  "route_enter",
  "runs_signalled",
  "route_exit",
];
const REQUIRED_DEFERRED_STAGES_ANY = [
  ["db_status_updated", "db_status_update_failed"],
  ["db_status_sql_updated", "db_status_sql_failed"],
];

interface ProbeResult {
  t: number;
  ok: boolean;
  status: number | null;
  ms: number;
  reasons: string[];
  poolSaturated: boolean;
  poolIdle: number | null;
  poolWaiting: number | null;
  poolTotal: number | null;
  reason?: string;
}

interface AbortResult {
  status: number;
  ms: number;
  body: string;
  startedAt: number;
  count: number;
}

function parseAbortCount(body: string): number {
  try {
    const j = JSON.parse(body);
    const n = typeof j?.count === "number" ? j.count : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

const now = (): number => Date.now();

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<{ status: number; bodyText: string; ms: number; ok: boolean; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), init.timeoutMs);
  const start = now();
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text().catch(() => "");
    return { status: res.status, bodyText: text, ms: now() - start, ok: res.ok };
  } catch (err: unknown) {
    return { status: 0, bodyText: "", ms: now() - start, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function createSession(): Promise<string> {
  const r = await fetchWithTimeout(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "stop-wedge-repro" }),
    timeoutMs: 5000,
  });
  if (!r.ok) throw new Error(`createSession failed status=${r.status} body=${r.bodyText.slice(0, 200)}`);
  const j = JSON.parse(r.bodyText);
  const id = j?.id ?? j?.sessionId;
  if (!id) throw new Error(`createSession returned no id: ${r.bodyText.slice(0, 200)}`);
  return String(id);
}

async function postMessage(sessionId: string): Promise<void> {
  const r = await fetchWithTimeout(`${BASE_URL}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: MESSAGE }),
    timeoutMs: 5000,
  });
  if (!r.ok && r.status !== 409) {
    throw new Error(`postMessage failed status=${r.status} body=${r.bodyText.slice(0, 200)}`);
  }
}

async function postAbort(sessionId: string): Promise<AbortResult> {
  const startedAt = now();
  const r = await fetchWithTimeout(`${BASE_URL}/api/sessions/${sessionId}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    timeoutMs: 10_000,
  });
  return { status: r.status, ms: r.ms, body: r.bodyText, startedAt, count: parseAbortCount(r.bodyText) };
}

async function probeHealth(): Promise<ProbeResult> {
  const start = now();
  const r = await fetchWithTimeout(`${BASE_URL}/api/health`, {
    method: "GET",
    timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
  });
  let reasons: string[] = [];
  let poolIdle: number | null = null;
  let poolWaiting: number | null = null;
  let poolTotal: number | null = null;
  try {
    if (r.bodyText) {
      const parsed = JSON.parse(r.bodyText);
      if (Array.isArray(parsed?.reasons)) reasons = parsed.reasons.map((x: unknown) => String(x));
      const pool = parsed?.db?.pool;
      if (pool && typeof pool === "object") {
        if (typeof pool.idle === "number") poolIdle = pool.idle;
        if (typeof pool.waiting === "number") poolWaiting = pool.waiting;
        if (typeof pool.total === "number") poolTotal = pool.total;
      }
    }
  } catch {
    /* not JSON, ignore */
  }
  const poolSaturated = reasons.some((s) => s.startsWith("pool_saturated"));
  return {
    t: start,
    ok: r.ok,
    status: r.status || null,
    ms: r.ms,
    reasons,
    poolSaturated,
    poolIdle,
    poolWaiting,
    poolTotal,
    reason: r.error,
  };
}

class CapturedServer {
  child: ChildProcessWithoutNullStreams | null = null;
  stderrLines: string[] = [];
  stdoutLines: string[] = [];

  async spawn(): Promise<void> {
    const args = ["tsx", "server/process-wrapper.ts"];
    const env = { ...process.env, NODE_ENV: "development", PORT: String(SPAWN_PORT) };
    this.child = spawn("npx", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stderr.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      this.stderrLines.push(text);
      process.stderr.write(`[srv:err] ${text}`);
    });
    this.child.stdout.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      this.stdoutLines.push(text);
      process.stdout.write(`[srv:out] ${text}`);
    });
    const deadline = now() + SPAWN_BOOT_TIMEOUT_MS;
    while (now() < deadline) {
      const r = await fetchWithTimeout(`${BASE_URL}/api/health`, { method: "GET", timeoutMs: 1000 });
      if (r.ok) {
        console.log(`[harness] spawned server is healthy at ${BASE_URL}`);
        return;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`spawned server did not become healthy within ${SPAWN_BOOT_TIMEOUT_MS}ms`);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try { c.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 5000);
      c.once("exit", () => { clearTimeout(t); resolve(); });
      try { c.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
    });
  }

  stderrText(): string { return this.stderrLines.join(""); }
}

function startEventLoopMonitor(): { stop: () => { p50: number; p99: number; max: number } } {
  const h: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  return {
    stop: () => {
      h.disable();
      return {
        p50: Math.round(h.percentile(50) / 1e6),
        p99: Math.round(h.percentile(99) / 1e6),
        max: Math.round(h.max / 1e6),
      };
    },
  };
}

interface IterResult {
  pass: boolean;
  details: Record<string, unknown>;
  failures: string[];
}

async function runOnce(iter: number, server: CapturedServer | null): Promise<IterResult> {
  const t0 = now();
  const stderrBefore = server ? server.stderrText().length : 0;
  const elMonitor = startEventLoopMonitor();

  const sessionIds = await Promise.all(
    Array.from({ length: PARALLEL_SESSIONS }, () => createSession()),
  );
  console.log(`[iter ${iter}] sessions=${sessionIds.length}`);

  for (const sid of sessionIds) {
    postMessage(sid).catch((err) => {
      console.warn(`[iter ${iter}] postMessage error sid=${sid} (non-fatal): ${err instanceof Error ? err.message : err}`);
    });
  }

  await new Promise((r) => setTimeout(r, ABORT_DELAY_MS));

  const aborts = await Promise.all(sessionIds.map((sid) => postAbort(sid)));
  for (const a of aborts) {
    console.log(`[iter ${iter}] abort status=${a.status} ms=${a.ms} body=${a.body.slice(0, 120)}`);
  }

  const probes: ProbeResult[] = [];
  const probeDeadline = now() + POST_ABORT_PROBE_MS;
  while (now() < probeDeadline) {
    const p = await probeHealth();
    probes.push(p);
    await new Promise((r) => setTimeout(r, POST_ABORT_PROBE_INTERVAL_MS));
  }

  const elStats = elMonitor.stop();
  const failedProbes = probes.filter((p) => !p.ok);
  const slowAborts = aborts.filter((a) => !(a.status === 200 || a.status === 202) || a.ms > ABORT_DEADLINE_MS);

  // Pool-saturated runs of consecutive degraded health probes — we tolerate
  // a brief blip but a sustained streak indicates the pool didn't recover.
  let longestPoolStreakMs = 0;
  let curStreakStart: number | null = null;
  for (const p of probes) {
    if (p.poolSaturated) {
      if (curStreakStart === null) curStreakStart = p.t;
      else longestPoolStreakMs = Math.max(longestPoolStreakMs, now() - curStreakStart);
    } else {
      if (curStreakStart !== null) {
        longestPoolStreakMs = Math.max(longestPoolStreakMs, p.t - curStreakStart);
        curStreakStart = null;
      }
    }
  }

  // Pool-min recovery: post-abort, the pool must return to a healthy idle
  // state (idle ≥ 1, waiting === 0) within POOL_MIN_RECOVERY_MS. This is the
  // explicit assertion the 2026-04-28 code review demanded — saturation
  // budget alone is not enough; we must positively observe recovery.
  const tAbortDone = aborts.reduce((m, a) => Math.max(m, a.startedAt + a.ms), t0);
  const recoveryDeadline = tAbortDone + POOL_MIN_RECOVERY_MS;
  const recoveryProbe = probes.find((p) =>
    p.t >= tAbortDone &&
    p.t <= recoveryDeadline &&
    p.ok &&
    p.poolIdle !== null && p.poolIdle >= 1 &&
    p.poolWaiting !== null && p.poolWaiting === 0,
  );
  const poolRecoveredAtMs = recoveryProbe ? (recoveryProbe.t - tAbortDone) : -1;

  const failures: string[] = [];
  if (slowAborts.length > 0) {
    failures.push(`${slowAborts.length}/${aborts.length} aborts breached deadline (>${ABORT_DEADLINE_MS}ms or non-2xx)`);
  }
  if (failedProbes.length > 0) {
    failures.push(`${failedProbes.length}/${probes.length} post-abort health probes failed`);
  }
  if (elStats.p99 > EVENT_LOOP_P99_BUDGET_MS) {
    failures.push(`harness event-loop p99=${elStats.p99}ms exceeded budget ${EVENT_LOOP_P99_BUDGET_MS}ms`);
  }
  if (elStats.max > EVENT_LOOP_MAX_BUDGET_MS) {
    failures.push(`harness event-loop max=${elStats.max}ms exceeded budget ${EVENT_LOOP_MAX_BUDGET_MS}ms`);
  }
  if (longestPoolStreakMs > POOL_SATURATED_BUDGET_MS) {
    failures.push(`DB pool stayed saturated for ${longestPoolStreakMs}ms (budget ${POOL_SATURATED_BUDGET_MS}ms)`);
  }
  if (!recoveryProbe) {
    failures.push(`DB pool failed to recover (idle≥1, waiting=0) within ${POOL_MIN_RECOVERY_MS}ms after abort`);
  }

  // Inflight load assertion (review-3 ask): the abort responses' summed
  // `count` is the ground-truth number of executor runs that were active
  // when each abort fired. If this is < MIN_INFLIGHT_RUNS the harness did
  // not actually exercise the pool-saturation wedge class — we'd be
  // certifying "it's fine" against zero load. Fail loudly so a maintainer
  // raises ABORT_DELAY_MS / MESSAGE size or PARALLEL_SESSIONS until real
  // in-flight work is observed.
  const totalInflightRuns = aborts.reduce((sum, a) => sum + a.count, 0);
  if (totalInflightRuns < MIN_INFLIGHT_RUNS) {
    failures.push(
      `insufficient in-flight load: observed ${totalInflightRuns} active runs across ${aborts.length} aborts ` +
        `(need ≥ ${MIN_INFLIGHT_RUNS}). Raise ABORT_DELAY_MS=${ABORT_DELAY_MS}ms or PARALLEL_SESSIONS=${PARALLEL_SESSIONS}.`,
    );
  }

  // AbortTrace stage assertions only meaningful when we own the server.
  // Deferred-stage checks only fire when at least one abort actually had
  // count>0; a no-op abort (run already finished naturally) correctly
  // skips the deferred DB write so its absence isn't a regression.
  const abortTraceCheck: Record<string, boolean | string[] | number> = {};
  // Active-abort observation is now driven by the abort response counts
  // (ground truth from agent_executor) rather than a stderr regex — same
  // signal MIN_INFLIGHT_RUNS uses, so the two assertions stay consistent.
  const activeAbortObserved = totalInflightRuns > 0;
  if (server) {
    const newStderr = server.stderrText().slice(stderrBefore);
    abortTraceCheck.activeAbortObserved = activeAbortObserved;
    abortTraceCheck.totalInflightRuns = totalInflightRuns;
    for (const stage of REQUIRED_ABORT_STAGES) {
      const present = newStderr.includes(`stage=${stage}`);
      abortTraceCheck[stage] = present;
      if (!present) failures.push(`AbortTrace missing required stage: ${stage}`);
    }
    if (activeAbortObserved) {
      for (const variants of REQUIRED_DEFERRED_STAGES_ANY) {
        const matched = variants.filter((s) => newStderr.includes(`stage=${s}`));
        abortTraceCheck[variants.join("|")] = matched;
        if (matched.length === 0) {
          failures.push(`AbortTrace missing deferred stage (any of): ${variants.join(" | ")}`);
        }
      }
    } else {
      // Surface this in the report so a maintainer doesn't read a green
      // result as "deferred path proven". They should bump ABORT_DELAY_MS
      // until at least one abort lands while the run is still in flight.
      console.warn(`[iter ${iter}] no active abort observed (all count=0) — deferred-stage assertions skipped; consider increasing ABORT_DELAY_MS=${ABORT_DELAY_MS}ms`);
    }
  }

  const wallMs = now() - t0;
  const pass = failures.length === 0;
  const details = {
    sessionIds,
    aborts: aborts.map((a) => ({ status: a.status, ms: a.ms, count: a.count })),
    totalInflightRuns,
    minInflightRuns: MIN_INFLIGHT_RUNS,
    abortDeadlineMs: ABORT_DEADLINE_MS,
    probesTotal: probes.length,
    probesFailed: failedProbes.length,
    firstFailedProbe: failedProbes[0],
    longestPoolStreakMs,
    poolSaturatedBudgetMs: POOL_SATURATED_BUDGET_MS,
    poolRecoveredAtMs,
    poolMinRecoveryBudgetMs: POOL_MIN_RECOVERY_MS,
    eventLoop: elStats,
    eventLoopBudgetMs: EVENT_LOOP_P99_BUDGET_MS,
    eventLoopMaxBudgetMs: EVENT_LOOP_MAX_BUDGET_MS,
    abortTrace: abortTraceCheck,
    wallMs,
  };
  console.log(`[iter ${iter}] pass=${pass} failures=${failures.length} ${JSON.stringify(details)}`);
  return { pass, details, failures };
}

async function main(): Promise<void> {
  console.log(
    `stop-wedge repro: BASE_URL=${BASE_URL} spawnServer=${SPAWN_SERVER} iterations=${ITERATIONS} ` +
      `parallel=${PARALLEL_SESSIONS} abortDelay=${ABORT_DELAY_MS}ms abortDeadline=${ABORT_DEADLINE_MS}ms ` +
      `postAbortProbe=${POST_ABORT_PROBE_MS}ms eventLoopP99Budget=${EVENT_LOOP_P99_BUDGET_MS}ms`,
  );

  let server: CapturedServer | null = null;
  if (SPAWN_SERVER) {
    server = new CapturedServer();
    try {
      await server.spawn();
    } catch (err) {
      console.error("[harness] failed to spawn server:", err instanceof Error ? err.message : err);
      await server.stop();
      process.exit(4);
    }
  }

  let allPass = true;
  const allFailures: string[] = [];
  try {
    for (let i = 1; i <= ITERATIONS; i++) {
      try {
        const { pass, failures } = await runOnce(i, server);
        if (!pass) {
          allPass = false;
          for (const f of failures) allFailures.push(`iter${i}: ${f}`);
        }
      } catch (err: unknown) {
        allPass = false;
        const msg = err instanceof Error ? err.message : String(err);
        allFailures.push(`iter${i}: FATAL ${msg}`);
        console.error(`[iter ${i}] FATAL:`, msg);
      }
    }
  } finally {
    if (server) await server.stop();
  }

  if (allPass) {
    console.log("PASS: all iterations met abort RTT, post-abort liveness, event-loop, pool, and AbortTrace stage budgets.");
    process.exit(0);
  } else {
    console.error("FAIL: regression(s) detected:");
    for (const f of allFailures) console.error("  -", f);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("repro harness crashed:", err);
  process.exit(3);
});
