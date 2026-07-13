import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { queryActivityDashboard } from "../dashboard-activity";
import { createLogger } from "../log";
import { requirePermission } from "../permissions";

const log = createLogger("dashboard-routes");

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}, "Invalid calendar date");

export function registerDashboardRoutes(app: Express) {
  app.get(
    "/api/dashboard/activity",
    requireAuth,
    requirePermission("system:read"),
    async (req, res) => {
      const parsed = dateSchema.safeParse(req.query.date);
      if (!parsed.success) return res.status(400).json({ error: "date must be a valid YYYY-MM-DD calendar date" });
      if (!req.principal) return res.status(401).json({ error: "Authentication required" });

      try {
        res.json(await queryActivityDashboard(parsed.data, req.principal));
      } catch (error) {
        log.error("Failed to load activity dashboard", {
          date: parsed.data,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to load dashboard activity" });
      }
    },
  );
}
