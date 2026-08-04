import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { queryActivityDashboard } from "../dashboard-activity";
import { createLogger } from "../log";
import { resolveProductComposition } from "../mods/composition/contribution-resolver";
import { requirePermission } from "../permissions";

const log = createLogger("dashboard-routes");

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return (
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    );
  }, "Invalid calendar date");

function parseSeriesParam(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const keys = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

export function registerDashboardRoutes(app: Express) {
  app.get(
    "/api/dashboard/activity",
    requireAuth,
    requirePermission("system:read"),
    async (req, res) => {
      const parsedDate = dateSchema.safeParse(req.query.date);
      if (!parsedDate.success) {
        return res
          .status(400)
          .json({ error: "date must be a valid YYYY-MM-DD calendar date" });
      }
      if (!req.principal) return res.status(401).json({ error: "Authentication required" });

      try {
        const composition = await resolveProductComposition(req.principal, "web");
        const allowedSeries = composition.dashboardHeatmaps.map(
          (heatmap) => heatmap.seriesKey,
        );
        if (allowedSeries.length === 0) {
          return res.json({ date: parsedDate.data, kpis: [], series: [] });
        }

        const requested = parseSeriesParam(req.query.series);
        const seriesKeys = requested
          ? requested.filter((key) => allowedSeries.includes(key))
          : allowedSeries;

        if (seriesKeys.length === 0) {
          return res.json({ date: parsedDate.data, kpis: [], series: [] });
        }

        res.json(
          await queryActivityDashboard(parsedDate.data, req.principal, seriesKeys),
        );
      } catch (error) {
        log.error("Failed to load activity dashboard", {
          date: parsedDate.data,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to load dashboard activity" });
      }
    },
  );
}
