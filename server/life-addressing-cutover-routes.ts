import type { Express } from "express";
import { requireAuth } from "./auth";
import { principalHasPermission, requirePermission } from "./permissions";
import { getCurrentPrincipal } from "./principal-context";
import { runLifeAddressingCutoverAudit } from "./life-addressing-cutover";
import { createLogger } from "./log";

const log = createLogger("LifeAddressingCutoverRoutes");

function positiveLimit(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Authenticated operator boundary for bounded Phase 4 evidence and replay. */
export function registerLifeAddressingCutoverRoutes(app: Express): void {
  app.post("/api/life-addressing/cutover/audit", requireAuth, requirePermission("build:read"), async (req, res) => {
    const principal = getCurrentPrincipal();
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    const runBackfills = req.body?.runBackfills === true;
    if (runBackfills && !principalHasPermission(principal, "build:write")) {
      return res.status(403).json({ error: "build:write permission required for backfills" });
    }
    try {
      return res.json(await runLifeAddressingCutoverAudit(principal, {
        limit: positiveLimit(req.body?.limit),
        runBackfills,
      }));
    } catch (error) {
      const status = Number((error as { status?: number }).status) || 500;
      log.error("Life Addressing cutover audit failed", { errorName: error instanceof Error ? error.name : typeof error });
      return res.status(status).json({ error: status < 500 && error instanceof Error ? error.message : "Life Addressing cutover audit failed" });
    }
  });
}
