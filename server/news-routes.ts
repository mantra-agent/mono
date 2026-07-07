import type { Express } from "express";
import { signalStorage } from "./news-storage";
import { buildInterestGraph, generateSearchQueries } from "./news-adapters";
import { createLogger } from "./log";

const log = createLogger("Landscape");

export function registerNewsRoutes(app: Express): void {
  // ── Signals ──────────────────────────────────────────────────────
  app.get("/api/landscape/signals", async (req, res) => {
    try {
      const opts: Parameters<typeof signalStorage.listSignals>[0] = {};
      if (typeof req.query.status === "string") opts.status = req.query.status as any;
      if (typeof req.query.sourceType === "string") opts.sourceType = req.query.sourceType;
      if (typeof req.query.limit === "string") opts.limit = Number(req.query.limit);
      if (typeof req.query.offset === "string") opts.offset = Number(req.query.offset);
      if (typeof req.query.minRelevance === "string") opts.minRelevance = Number(req.query.minRelevance);
      const result = await signalStorage.listSignals(opts);
      res.json(result);
    } catch (err) {
      log.error("GET /api/landscape/signals error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/landscape/signals/:id", async (req, res) => {
    try {
      const signal = await signalStorage.getSignal(req.params.id);
      if (!signal) return res.status(404).json({ error: "Signal not found" });
      res.json(signal);
    } catch (err) {
      log.error("GET /api/landscape/signals/:id error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/api/landscape/signals/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      if (!status || !["new", "surfaced", "dismissed", "saved", "archived"].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Options: new, surfaced, dismissed, saved, archived" });
      }
      const updated = await signalStorage.updateSignalStatus(req.params.id, status);
      if (!updated) return res.status(404).json({ error: "Signal not found" });
      res.json(updated);
    } catch (err) {
      log.error("PATCH /api/landscape/signals/:id/status error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Sources ──────────────────────────────────────────────────────
  app.get("/api/landscape/sources", async (req, res) => {
    try {
      const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType : undefined;
      const sources = await signalStorage.listSources(sourceType ? { sourceType } : undefined);
      res.json(sources);
    } catch (err) {
      log.error("GET /api/landscape/sources error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/landscape/sources", async (req, res) => {
    try {
      const { sourceType, value } = req.body;
      if (!sourceType || !value) {
        return res.status(400).json({ error: "sourceType and value are required" });
      }
      const source = await signalStorage.addSource({ sourceType, value });
      res.status(201).json(source);
    } catch (err) {
      log.error("POST /api/landscape/sources error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/api/landscape/sources/:id", async (req, res) => {
    try {
      const updates: any = {};
      if (req.body.value !== undefined) updates.value = req.body.value;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      if (req.body.sourceType !== undefined) updates.sourceType = req.body.sourceType;
      const source = await signalStorage.updateSource(req.params.id, updates);
      if (!source) return res.status(404).json({ error: "Source not found" });
      res.json(source);
    } catch (err) {
      log.error("PATCH /api/landscape/sources/:id error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/landscape/sources/:id", async (req, res) => {
    try {
      const deleted = await signalStorage.deleteSource(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Source not found" });
      res.json({ ok: true });
    } catch (err) {
      log.error("DELETE /api/landscape/sources/:id error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Topics (pinned_topic CRUD) ────────────────────────────────────
  app.get("/api/landscape/topics", async (_req, res) => {
    try {
      const pinned = await signalStorage.listSources({ sourceType: "pinned_topic" });
      const sessionTopics = await signalStorage.getRecentSessionTopics({ days: 14, limit: 40 });
      const pinnedByValue = new Map(pinned.map(topic => [topic.value.toLowerCase(), topic]));
      const rows = pinned.map(topic => ({ ...topic, topicSource: "pinned", alsoRecent: false, mentions: 0, lastSeenAt: null }));
      for (const topic of sessionTopics) {
        const pinnedMatch = pinnedByValue.get(topic.value.toLowerCase());
        if (pinnedMatch) {
          const row = rows.find(r => r.id === pinnedMatch.id);
          if (row) { row.alsoRecent = true; row.mentions = topic.mentions; row.lastSeenAt = topic.lastSeenAt.toISOString(); }
          continue;
        }
        rows.push({
          id: `session:${encodeURIComponent(topic.value.toLowerCase())}`,
          sourceType: "session_topic",
          value: topic.value,
          enabled: true,
          lastScanAt: null,
          signalCount: 0,
          createdAt: topic.lastSeenAt.toISOString(),
          topicSource: "session",
          alsoRecent: true,
          mentions: topic.mentions,
          lastSeenAt: topic.lastSeenAt.toISOString(),
        });
      }
      res.json(rows);
    } catch (err) {
      log.error("GET /api/landscape/topics error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/landscape/topics", async (req, res) => {
    try {
      const { value } = req.body;
      if (!value || typeof value !== "string" || !value.trim()) {
        return res.status(400).json({ error: "value is required" });
      }
      // Dedup check
      const existing = await signalStorage.listSources({ sourceType: "pinned_topic" });
      if (existing.some(s => s.value.toLowerCase() === value.trim().toLowerCase())) {
        return res.status(409).json({ error: "Topic already exists" });
      }
      const source = await signalStorage.addSource({ sourceType: "pinned_topic", value: value.trim() });
      res.status(201).json(source);
    } catch (err) {
      log.error("POST /api/landscape/topics error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/landscape/topics/:id", async (req, res) => {
    try {
      // Type guard: only allow deleting pinned_topic entries via this endpoint
      const source = await signalStorage.getSource(req.params.id);
      if (!source) return res.status(404).json({ error: "Topic not found" });
      if (source.sourceType !== "pinned_topic") {
        return res.status(400).json({ error: "This endpoint only manages pinned topics" });
      }
      await signalStorage.deleteSource(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      log.error("DELETE /api/landscape/topics/:id error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Channels (non-topic sources) ─────────────────────────────────
  app.get("/api/landscape/channels", async (_req, res) => {
    try {
      // Run migration to ensure channel singletons exist
      await signalStorage.migrateChannelsAndTopics();
      const allSources = await signalStorage.listSources();
      const channels = allSources.filter(s => s.sourceType !== "pinned_topic");
      res.json(channels);
    } catch (err) {
      log.error("GET /api/landscape/channels error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Interest Graph ───────────────────────────────────────────────
  app.get("/api/landscape/interest-graph", async (_req, res) => {
    try {
      const graph = await buildInterestGraph();
      const queries = generateSearchQueries(graph);
      res.json({ topics: graph, searchQueries: queries });
    } catch (err) {
      log.error("GET /api/landscape/interest-graph error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Scan Runs ────────────────────────────────────────────────────
  app.get("/api/landscape/scan-runs", async (req, res) => {
    try {
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
      const runs = await signalStorage.listScanRuns(limit);
      res.json(runs);
    } catch (err) {
      log.error("GET /api/landscape/scan-runs error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/landscape/scan-runs/:id/cancel", async (req, res) => {
    try {
      const run = await signalStorage.cancelScanRun(req.params.id);
      if (!run) {
        return res.status(404).json({ error: "No in-progress scan run found with that ID" });
      }
      res.json(run);
    } catch (err) {
      log.error("POST /api/landscape/scan-runs/:id/cancel error:", (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  log.log("Landscape routes registered");
}
