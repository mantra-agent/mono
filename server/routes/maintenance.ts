import type { Express } from "express";
import {
  enterMaintenance,
  exitMaintenance,
  getMaintenanceState,
} from "../maintenance";

import { createLogger } from "../log";
const log = createLogger("maintenance");
export function registerMaintenanceRoutes(app: Express): void {
  // GET status — anyone can read (used by the prod sync orchestrator to
  // confirm the dev instance entered maintenance, and by health checks).
  app.get("/api/maintenance/status", (_req, res) => {
    res.json(getMaintenanceState());
  });

  // POST enter — no auth, matches the existing /api/brain/import pattern.
  // Body: { reason?: string, ttlMs?: number }
  app.post("/api/maintenance/enter", (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "db sync in progress";
    const ttlMs = typeof req.body?.ttlMs === "number" ? req.body.ttlMs : undefined;
    enterMaintenance(reason, ttlMs);
    log.log(`entered maintenance: ${reason} (ttlMs=${ttlMs ?? "default"})`);
    res.json(getMaintenanceState());
  });

  // POST exit — clears maintenance without restarting. Used when a sync
  // fails or is cancelled and we want the dev instance to resume serving.
  app.post("/api/maintenance/exit", (_req, res) => {
    exitMaintenance();
    log.log("exited maintenance (no restart)");
    res.json({ ok: true });
  });

  // POST exit-and-restart — clears maintenance flag, responds, then exits
  // the process. The wrapper restarts on non-zero exit codes (process-wrapper.ts
  // treats exit 0 as a clean shutdown). The fresh boot will:
  //   - clear all in-memory caches
  //   - re-run boot auto-heal migrations
  //   - start with isInMaintenance() === false
  app.post("/api/maintenance/exit-and-restart", (_req, res) => {
    exitMaintenance();
    log.log("exit-and-restart requested — process will exit shortly");
    res.json({ ok: true, restarting: true });
    // Give the response a moment to flush before terminating.
    setTimeout(() => {
      log.warn("exiting process for restart (code=1)");
      process.exit(1);
    }, 250);
  });
}
