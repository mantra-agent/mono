// Worker-thread heartbeat (Task #995, Step F).
//
// This file runs in a dedicated Node.js worker thread inside the main app
// process. Its only job is to post a heartbeat to the main thread every
// HEARTBEAT_INTERVAL_MS. The main thread forwards each beat to its parent
// (process-wrapper.ts) over the IPC channel.
//
// Why a worker thread?
//
// A timer in the main thread can be starved indefinitely by sync work
// (large JSON.stringify, blocking scrypt, blocking fs ops). When that
// happens the process appears wedged to operators, but a stdout-only
// liveness signal is unreliable because some failure modes also block
// stdout flush.
//
// A worker thread runs on its own libuv loop and is unaffected by main-
// thread blocks. If the worker stops emitting heartbeats, *something*
// catastrophic has happened (process hung, OOM-near-limit, kernel preemption
// for tens of seconds) and the watchdog should kill us.
//
// The heartbeat is intentionally tiny — just a timestamp — so it cannot
// itself contribute to event-loop pressure.

import { parentPort } from "worker_threads";

const HEARTBEAT_INTERVAL_MS = 1_000;

if (parentPort) {
  // Heartbeat schema per Task #995: { type: "alive", t }.
  // First beat immediately so the parent has a baseline.
  parentPort.postMessage({ type: "alive", t: Date.now() });

  // The setInterval handle MUST be ref'd (default) so it keeps this
  // worker thread's event loop alive. Calling .unref() here causes the
  // thread to exit as soon as the loop drains, which the main process
  // would observe as canary loss and restart for — exactly what we
  // were seeing before this fix.
  setInterval(() => {
    parentPort!.postMessage({ type: "alive", t: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);
}
