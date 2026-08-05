import type { Express } from "express";
import { fetchVersionTimeline } from "../integrations/github-timeline";
import { createLogger } from "../log";
import { resolveRuntimeIdentity } from "../runtime-identity";

const log = createLogger("VersionRoutes");

export function registerVersionRoutes(app: Express) {
  app.get("/api/version", async (_req, res) => {
    try {
      const identity = await resolveRuntimeIdentity();
      res.setHeader("Cache-Control", "no-store");
      res.json({ buildId: identity.gitCommit });
    } catch (error) {
      log.error("Failed to resolve runtime version", { error });
      res.status(503).json({ message: "Version unavailable" });
    }
  });

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
