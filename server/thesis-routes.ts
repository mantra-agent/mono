import type { Express, Response } from "express";
import { thesisStorage, migrateThesisSchema } from "./thesis-storage";
import {
  insertThesisSchema,
  insertThesisEvidenceSchema,
  insertThesisPredictionSchema,
  thesisStatuses,
  predictionOutcomes,
  type ThesisStatus,
  type PredictionOutcome,
} from "@shared/schema";
import { z } from "zod";
import { createLogger } from "./log";
import { eventBus } from "./event-bus";

const log = createLogger("Theses");

function publishChanged(source: string): void {
  eventBus.publish({ category: "system", event: "data:theses_changed", payload: { source } });
}

const updateThesisSchema = insertThesisSchema.partial();

function isZodError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function handleError(prefix: string, err: unknown, res: Response): Response {
  if (isZodError(err)) return res.status(400).json({ error: "Validation failed", details: err.errors });
  log.error(`${prefix} error:`, errMsg(err));
  return res.status(500).json({ error: errMsg(err) });
}

export function registerThesisRoutes(app: Express): void {
  migrateThesisSchema().catch(err => log.error("schema migration error:", errMsg(err)));

  // ── Thesis CRUD ──────────────────────────────────────────────────
  app.get("/api/theses", async (req, res) => {
    try {
      const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
      let status: ThesisStatus | undefined;
      if (statusRaw && statusRaw !== "all") {
        if (!(thesisStatuses as readonly string[]).includes(statusRaw)) {
          return res.status(400).json({ error: `Invalid status: ${statusRaw}` });
        }
        status = statusRaw as ThesisStatus;
      }
      const list = await thesisStorage.list({ status });
      res.json(list);
    } catch (err) {
      handleError("GET /api/theses", err, res);
    }
  });

  app.post("/api/theses", async (req, res) => {
    try {
      const parsed = insertThesisSchema.parse(req.body);
      const row = await thesisStorage.create(parsed);
      publishChanged("create");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/theses", err, res);
    }
  });

  app.get("/api/theses/:id", async (req, res) => {
    try {
      const thesis = await thesisStorage.get(req.params.id);
      if (!thesis) return res.status(404).json({ error: "Thesis not found" });
      const [evidence, predictions] = await Promise.all([
        thesisStorage.listEvidence(thesis.id),
        thesisStorage.listPredictions(thesis.id),
      ]);
      res.json({ ...thesis, evidence, predictions });
    } catch (err) {
      handleError("GET /api/theses/:id", err, res);
    }
  });

  app.patch("/api/theses/:id", async (req, res) => {
    try {
      const parsed = updateThesisSchema.parse(req.body);
      if (parsed.status === "superseded" && parsed.successorId === req.params.id) {
        return res.status(400).json({ error: "Cannot supersede to self" });
      }
      const row = await thesisStorage.update(req.params.id, parsed);
      if (!row) return res.status(404).json({ error: "Thesis not found" });
      publishChanged("update");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/theses/:id", err, res);
    }
  });

  app.delete("/api/theses/:id", async (req, res) => {
    try {
      const ok = await thesisStorage.delete(req.params.id);
      if (!ok) return res.status(404).json({ error: "Thesis not found" });
      publishChanged("delete");
      res.json({ ok: true });
    } catch (err) {
      handleError("DELETE /api/theses/:id", err, res);
    }
  });

  // ── Evidence ─────────────────────────────────────────────────────
  app.post("/api/theses/:id/evidence", async (req, res) => {
    try {
      const thesis = await thesisStorage.get(req.params.id);
      if (!thesis) return res.status(404).json({ error: "Thesis not found" });
      const parsed = insertThesisEvidenceSchema.parse({ ...req.body, thesisId: req.params.id });
      const row = await thesisStorage.addEvidence(parsed);
      publishChanged("add_evidence");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/theses/:id/evidence", err, res);
    }
  });

  app.patch("/api/theses/evidence/:eid", async (req, res) => {
    try {
      const updates: Record<string, unknown> = {};
      if (typeof req.body.content === "string") updates.content = req.body.content;
      if (typeof req.body.sourceUrl === "string") updates.sourceUrl = req.body.sourceUrl;
      if (typeof req.body.position === "number") updates.position = req.body.position;
      const row = await thesisStorage.updateEvidence(req.params.eid, updates);
      if (!row) return res.status(404).json({ error: "Evidence not found" });
      publishChanged("update_evidence");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/theses/evidence/:eid", err, res);
    }
  });

  app.delete("/api/theses/evidence/:eid", async (req, res) => {
    try {
      const ok = await thesisStorage.removeEvidence(req.params.eid);
      if (!ok) return res.status(404).json({ error: "Evidence not found" });
      publishChanged("remove_evidence");
      res.json({ ok: true });
    } catch (err) {
      handleError("DELETE /api/theses/evidence/:eid", err, res);
    }
  });

  // ── Predictions ──────────────────────────────────────────────────
  app.post("/api/theses/:id/predictions", async (req, res) => {
    try {
      const thesis = await thesisStorage.get(req.params.id);
      if (!thesis) return res.status(404).json({ error: "Thesis not found" });
      const parsed = insertThesisPredictionSchema.parse({ ...req.body, thesisId: req.params.id });
      const row = await thesisStorage.addPrediction(parsed);
      publishChanged("add_prediction");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/theses/:id/predictions", err, res);
    }
  });

  app.patch("/api/theses/predictions/:pid", async (req, res) => {
    try {
      const updates: Record<string, unknown> = {};
      if (typeof req.body.claim === "string") updates.claim = req.body.claim;
      if (typeof req.body.deadline !== "undefined") updates.deadline = req.body.deadline;
      if (typeof req.body.outcome === "string") {
        if (!(predictionOutcomes as readonly string[]).includes(req.body.outcome)) {
          return res.status(400).json({ error: `Invalid outcome: ${req.body.outcome}` });
        }
        // Use resolve for outcome changes to handle resolvedAt
        const row = await thesisStorage.resolvePrediction(req.params.pid, req.body.outcome as PredictionOutcome);
        if (!row) return res.status(404).json({ error: "Prediction not found" });
        publishChanged("resolve_prediction");
        return res.json(row);
      }
      // Non-outcome updates (claim, deadline)
      if (Object.keys(updates).length > 0) {
        const row = await thesisStorage.updatePrediction(req.params.pid, updates);
        if (!row) return res.status(404).json({ error: "Prediction not found" });
        publishChanged("update_prediction");
        return res.json(row);
      }
      return res.status(400).json({ error: "No valid fields to update" });
    } catch (err) {
      handleError("PATCH /api/theses/predictions/:pid", err, res);
    }
  });

  app.delete("/api/theses/predictions/:pid", async (req, res) => {
    try {
      const ok = await thesisStorage.removePrediction(req.params.pid);
      if (!ok) return res.status(404).json({ error: "Prediction not found" });
      publishChanged("remove_prediction");
      res.json({ ok: true });
    } catch (err) {
      handleError("DELETE /api/theses/predictions/:pid", err, res);
    }
  });
}
