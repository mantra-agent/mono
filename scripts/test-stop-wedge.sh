#!/usr/bin/env bash
# Stop-wedge regression gate.
#
# This is the canonical execution entry point for the harness in
# scripts/repro-stop-wedge.ts. The strict default budgets in the harness
# (ABORT_DEADLINE_MS=50, EVENT_LOOP_P99_BUDGET_MS=200, etc.) are the
# acceptance bars agreed in the 2026-04-28 stop-wedge code reviews.
#
# Usage:
#   scripts/test-stop-wedge.sh              # spawn a server, run harness
#   BASE_URL=http://127.0.0.1:5000 \
#       SPAWN_SERVER=0 scripts/test-stop-wedge.sh   # run vs already-running server
#
# Exit codes:
#   0 — all assertions met (abort RTT, post-abort liveness, event loop,
#       pool, AbortTrace stages)
#   2 — one or more assertions regressed (budget breach, missing trace,
#       pool failed to recover, etc.)
#
# CI uses .github/workflows/stop-wedge.yml which runs this script.

set -euo pipefail

cd "$(dirname "$0")/.."

# Defaults are deliberately empty so the harness's own defaults
# (PARALLEL_SESSIONS=5, MIN_INFLIGHT_RUNS=5) remain the single source of
# truth. Override here only to scale up; never down.
: "${SPAWN_SERVER:=1}"
: "${ITERATIONS:=2}"

export SPAWN_SERVER ITERATIONS

exec npx tsx scripts/repro-stop-wedge.ts "$@"
