#!/usr/bin/env bash
# Capture a V8 CPU profile while the stop-wedge repro is hammering the server.
# This is the artifact code review asked us to commit so future regressions can
# be diagnosed by diffing isolate-*-v8.log against a known-good profile.
#
# Usage:
#   scripts/capture-stop-wedge-profile.sh [out_dir]
#
# Output:
#   <out_dir>/isolate-*-v8.log     — raw V8 tick log (process & --prof-process compatible)
#   <out_dir>/cpu-summary.txt      — `node --prof-process` text summary
#   <out_dir>/repro-output.log     — repro harness stdout/stderr
#
# How to read:
#   node --prof-process <out_dir>/isolate-*-v8.log > summary.txt
#   Look for time spent in withConvLock, jsonb_set, fs/promises appendFile,
#   pg.Pool.query, and any function dominating the [JavaScript] section.
#
# Why we keep this in-tree:
#   The 2026-04-28 wedge runbook (docs/runbooks/stop-wedge-rca.md) cites
#   "no CPU profile from the wedged process" as the single biggest gap that
#   delayed root-cause. This script makes capturing one a one-liner.

set -euo pipefail

OUT_DIR="${1:-tmp/stop-wedge-profile}"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR" || exit 1
PROFILE_DIR="$(pwd)"
cd - >/dev/null

REPRO_LOG="$PROFILE_DIR/repro-output.log"
SUMMARY="$PROFILE_DIR/cpu-summary.txt"

echo "[capture] profile dir: $PROFILE_DIR"
echo "[capture] starting profiled server (port 5050)..."

# Note: --prof / --cpu-prof are not allowed in NODE_OPTIONS, so we spawn
# `node` directly with tsx as a CommonJS loader. --cpu-prof produces a
# .cpuprofile JSON that loads into Chrome DevTools/clinic.js without
# `--prof-process` post-processing, which is what the runbook recommends.
PORT=5050 NODE_ENV=development \
  node --cpu-prof --cpu-prof-dir="$PROFILE_DIR" --import tsx server/process-wrapper.ts \
    >"$PROFILE_DIR/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill -TERM $SERVER_PID 2>/dev/null || true; wait $SERVER_PID 2>/dev/null || true' EXIT

# Wait for server to be ready
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:5050/api/health" || echo "000")
  if [ "$code" = "200" ] || [ "$code" = "503" ]; then
    # 503 (degraded) still proves the route layer is up — good enough to drive load.
    echo "[capture] server is reachable after ${i}s (http=$code)"
    break
  fi
  sleep 1
done

echo "[capture] running repro harness against profiled server..."
BASE_URL="http://127.0.0.1:5050" \
  ITERATIONS=2 PARALLEL_SESSIONS=2 \
  ABORT_DEADLINE_MS=2000 EVENT_LOOP_P99_BUDGET_MS=500 EVENT_LOOP_MAX_BUDGET_MS=2000 \
  POOL_SATURATED_BUDGET_MS=4000 POOL_MIN_RECOVERY_MS=4000 \
  npx tsx scripts/repro-stop-wedge.ts >"$REPRO_LOG" 2>&1 || true

echo "[capture] stopping profiled server (SIGINT to flush --cpu-prof)..."
kill -INT "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
trap - EXIT

CPU_PROFILE="$(ls "$PROFILE_DIR"/CPU.*.cpuprofile 2>/dev/null | head -1 || true)"
if [ -n "$CPU_PROFILE" ]; then
  echo "[capture] cpuprofile written: $CPU_PROFILE"
  # Generate a small text summary so reviewers can eyeball without DevTools.
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const nodes = p.nodes || [];
    const samples = p.samples || [];
    const ts = p.timeDeltas || [];
    const totalUs = ts.reduce((a,b)=>a+b,0);
    const counts = new Map();
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i];
      const slice = ts[i] || 0;
      counts.set(id, (counts.get(id) || 0) + slice);
    }
    const byNode = nodes.map(n => ({
      id: n.id,
      fn: (n.callFrame.functionName || "(anonymous)") + " @ " + (n.callFrame.url || "?") + ":" + n.callFrame.lineNumber,
      selfUs: counts.get(n.id) || 0,
    })).sort((a,b)=>b.selfUs-a.selfUs).slice(0, 40);
    console.log("Total wall:", (totalUs/1000).toFixed(1) + "ms",
                "Samples:", samples.length, "Nodes:", nodes.length);
    console.log("\nTop 40 self-time call frames:\n");
    for (const f of byNode) {
      const pct = totalUs ? ((f.selfUs/totalUs)*100).toFixed(2) : "0.00";
      console.log(`${pct.padStart(6)}%  ${(f.selfUs/1000).toFixed(2).padStart(8)}ms  ${f.fn}`);
    }
  ' "$CPU_PROFILE" >"$SUMMARY" 2>&1 || true
else
  echo "[capture] WARNING: no .cpuprofile was produced"
fi

echo "[capture] done."
echo "  cpuprofile:  ${CPU_PROFILE:-<none>}"
echo "  cpu summary: $SUMMARY"
echo "  repro log:   $REPRO_LOG"
