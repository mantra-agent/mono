// Use createLogger for logging ONLY
import type { Express } from "express";
import { getAllThoughts, getRecentThoughts, deleteThought, deleteAllThoughts, getThoughtById } from "./thoughts";
import type { Thought } from "./thoughts";
import { createLogger } from "./log";
import { requireAuth } from "./auth";

const log = createLogger("ThoughtRoutes");

function stripContext(thought: Thought): Omit<Thought, "context"> {
  const { context, ...rest } = thought;
  return rest;
}

export function registerObservationRoutes(app: Express): void {
  app.use("/api/thoughts", requireAuth);
  app.get("/api/thoughts", async (_req, res) => {
    try {
      const limit = parseInt(_req.query.limit as string) || 50;
      const offset = parseInt(_req.query.offset as string) || 0;
      const all = await getAllThoughts();
      const paginated = all.slice(offset, offset + limit).map(stripContext);
      res.json({ thoughts: paginated, total: all.length });
    } catch (err: unknown) {
      log.error("GET /api/thoughts error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to fetch thoughts" });
    }
  });

  app.get("/api/thoughts/active", async (_req, res) => {
    try {
      const active = await getRecentThoughts(25 * 60 * 1000, 5);
      res.json({ thoughts: active.map(stripContext), count: active.length });
    } catch (err: unknown) {
      log.error("GET /api/thoughts/active error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to fetch active thoughts" });
    }
  });

  app.get("/api/thoughts/:id/context", async (req, res) => {
    try {
      const thought = await getThoughtById(req.params.id);
      if (!thought) {
        return res.status(404).json({ error: "Thought not found" });
      }
      res.json({
        id: thought.id,
        context: thought.context || null,
        hasContext: !!thought.context,
      });
    } catch (err: unknown) {
      log.error("GET /api/thoughts/:id/context error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to fetch thought context" });
    }
  });

  app.delete("/api/thoughts/:id", async (req, res) => {
    try {
      const deleted = await deleteThought(req.params.id);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Thought not found" });
      }
    } catch (err: unknown) {
      log.error("DELETE /api/thoughts/:id error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to delete thought" });
    }
  });

  app.delete("/api/thoughts", async (_req, res) => {
    try {
      const count = await deleteAllThoughts();
      res.json({ success: true, deleted: count });
    } catch (err: unknown) {
      log.error("DELETE /api/thoughts error:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to delete all thoughts" });
    }
  });
}
