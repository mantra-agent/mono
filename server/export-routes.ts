// Use createLogger for logging ONLY
import type { Express, Request, Response } from "express";
import { createLogger } from "./log";
import { requireAuth } from "./auth";

const log = createLogger("ExportRoutes");

export function registerExportRoutes(app: Express): void {
  app.use("/api/export", requireAuth, (_req: Request, res: Response) => {
    res.status(503).json({ error: "Data export is temporarily unavailable while owner-scoped export generation is rebuilt.", code: "EXPORT_SECURITY_HOLD" });
  });
}
