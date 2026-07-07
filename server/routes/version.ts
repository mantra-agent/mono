import type { Express } from "express";
import { fetchVersionTimeline } from "../integrations/github-timeline";
import { createLogger } from "../log";

const log = createLogger("VersionRoutes");

export function registerVersionRoutes(app: Express) {
  app.get("/api/version/timeline", async (_req, res) => {
    try {
      const timeline = await fetchVersionTimeline();
      res.json(timeline);
    } catch (err: any) {
      log.error(`Version timeline fetch failed: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to fetch version timeline" });
    }
  });
}
