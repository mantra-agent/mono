// Use createLogger for logging ONLY
import type { Express, Response } from "express";
import { decisionsStorage, migrateDecisionsSchema } from "./decisions-storage";
import {
  insertDecisionSchema,
  insertDecisionUpdateSchema,
  insertDecisionLinkSchema,
  decisionStatuses,
  decisionTrafficLights,
  decisionLinkTargetTypes,
  type DecisionLinkTargetType,
  type DecisionStatus,
} from "@shared/schema";
import { z } from "zod";
import { createLogger } from "./log";
import { eventBus } from "./event-bus";

const log = createLogger("Decisions");

function publishChanged(source: string): void {
  eventBus.publish({ category: "system", event: "data:decisions_changed", payload: { source } });
}

const updateDecisionSchema = insertDecisionSchema.partial().extend({
  status: z.enum(decisionStatuses).optional(),
  trafficLight: z.enum(decisionTrafficLights).nullable().optional(),
});

const updateContentSchema = z.object({ content: z.string().min(1) });

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

export function registerDecisionsRoutes(app: Express): void {
  migrateDecisionsSchema().catch(err => log.error("schema migration error:", errMsg(err)));

  app.get("/api/decisions", async (req, res) => {
    try {
      const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
      let status: DecisionStatus | undefined;
      if (statusRaw && statusRaw !== "all") {
        if (!(decisionStatuses as readonly string[]).includes(statusRaw)) {
          return res.status(400).json({ error: `Invalid status: ${statusRaw}` });
        }
        status = statusRaw as DecisionStatus;
      }
      const list = await decisionsStorage.listDecisions({ status });
      res.json(list);
    } catch (err) {
      handleError("GET /api/decisions", err, res);
    }
  });

  app.post("/api/decisions", async (req, res) => {
    try {
      const parsed = insertDecisionSchema.parse(req.body);
      const row = await decisionsStorage.createDecision(parsed);
      publishChanged("create");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/decisions", err, res);
    }
  });

  app.get("/api/decisions/:id", async (req, res) => {
    try {
      const decision = await decisionsStorage.getDecision(req.params.id);
      if (!decision) return res.status(404).json({ error: "Decision not found" });
      const [updates, links] = await Promise.all([
        decisionsStorage.listUpdates(req.params.id),
        decisionsStorage.listLinks(req.params.id),
      ]);
      res.json({ ...decision, updates, links });
    } catch (err) {
      handleError(`GET /api/decisions/${req.params.id}`, err, res);
    }
  });

  app.patch("/api/decisions/:id", async (req, res) => {
    try {
      const parsed = updateDecisionSchema.parse(req.body);
      // Status changes go through dedicated lock/reopen endpoints
      if (parsed.status !== undefined) delete (parsed as { status?: unknown }).status;
      const row = await decisionsStorage.updateDecision(req.params.id, parsed);
      if (!row) return res.status(404).json({ error: "Decision not found" });
      publishChanged("update");
      res.json(row);
    } catch (err) {
      handleError(`PATCH /api/decisions/${req.params.id}`, err, res);
    }
  });

  app.delete("/api/decisions/:id", async (req, res) => {
    try {
      const ok = await decisionsStorage.deleteDecision(req.params.id);
      if (!ok) return res.status(404).json({ error: "Decision not found" });
      publishChanged("delete");
      res.json({ success: true });
    } catch (err) {
      handleError(`DELETE /api/decisions/${req.params.id}`, err, res);
    }
  });

  app.post("/api/decisions/:id/lock", async (req, res) => {
    try {
      const row = await decisionsStorage.lockDecision(req.params.id);
      if (!row) return res.status(404).json({ error: "Decision not found" });
      publishChanged("lock");
      res.json(row);
    } catch (err) {
      handleError(`POST /api/decisions/${req.params.id}/lock`, err, res);
    }
  });

  app.post("/api/decisions/:id/reopen", async (req, res) => {
    try {
      const row = await decisionsStorage.reopenDecision(req.params.id);
      if (!row) return res.status(404).json({ error: "Decision not found" });
      publishChanged("reopen");
      res.json(row);
    } catch (err) {
      handleError(`POST /api/decisions/${req.params.id}/reopen`, err, res);
    }
  });

  app.get("/api/decisions/:id/updates", async (req, res) => {
    try {
      const updates = await decisionsStorage.listUpdates(req.params.id);
      res.json(updates);
    } catch (err) {
      handleError(`GET /api/decisions/${req.params.id}/updates`, err, res);
    }
  });

  app.post("/api/decisions/:id/updates", async (req, res) => {
    try {
      const decision = await decisionsStorage.getDecision(req.params.id);
      if (!decision) return res.status(404).json({ error: "Decision not found" });
      if (decision.status !== "closed") {
        return res.status(400).json({ error: "Updates can only be added to closed decisions" });
      }
      const parsed = insertDecisionUpdateSchema.parse({ ...req.body, decisionId: req.params.id });
      const row = await decisionsStorage.addUpdate(parsed);
      publishChanged("update_added");
      res.status(201).json(row);
    } catch (err) {
      handleError(`POST /api/decisions/${req.params.id}/updates`, err, res);
    }
  });

  app.patch("/api/decisions/updates/:updateId", async (req, res) => {
    try {
      const { content } = updateContentSchema.parse(req.body);
      const row = await decisionsStorage.editUpdate(req.params.updateId, content);
      if (!row) return res.status(404).json({ error: "Update not found" });
      publishChanged("update_edited");
      res.json(row);
    } catch (err) {
      handleError(`PATCH /api/decisions/updates/${req.params.updateId}`, err, res);
    }
  });

  app.delete("/api/decisions/updates/:updateId", async (req, res) => {
    try {
      const ok = await decisionsStorage.deleteUpdate(req.params.updateId);
      if (!ok) return res.status(404).json({ error: "Update not found" });
      publishChanged("update_deleted");
      res.json({ success: true });
    } catch (err) {
      handleError(`DELETE /api/decisions/updates/${req.params.updateId}`, err, res);
    }
  });

  app.get("/api/decisions/:id/links", async (req, res) => {
    try {
      const links = await decisionsStorage.listLinks(req.params.id);
      res.json(links);
    } catch (err) {
      handleError(`GET /api/decisions/${req.params.id}/links`, err, res);
    }
  });

  app.post("/api/decisions/:id/links", async (req, res) => {
    try {
      const parsed = insertDecisionLinkSchema.parse({ ...req.body, decisionId: req.params.id });
      const row = await decisionsStorage.addLink(parsed);
      publishChanged("link_added");
      res.status(201).json(row);
    } catch (err) {
      handleError(`POST /api/decisions/${req.params.id}/links`, err, res);
    }
  });

  app.delete("/api/decisions/links/:linkId", async (req, res) => {
    try {
      const ok = await decisionsStorage.deleteLink(req.params.linkId);
      if (!ok) return res.status(404).json({ error: "Link not found" });
      publishChanged("link_deleted");
      res.json({ success: true });
    } catch (err) {
      handleError(`DELETE /api/decisions/links/${req.params.linkId}`, err, res);
    }
  });

  app.get("/api/decisions/links/target/:targetType/:targetId", async (req, res) => {
    try {
      const targetType = req.params.targetType;
      if (!(decisionLinkTargetTypes as readonly string[]).includes(targetType)) {
        return res.status(400).json({ error: `Invalid targetType: ${targetType}` });
      }
      const links = await decisionsStorage.listLinksForTarget(targetType as DecisionLinkTargetType, req.params.targetId);
      const ids = Array.from(new Set(links.map(l => l.decisionId)));
      const all = await Promise.all(ids.map(id => decisionsStorage.getDecision(id)));
      res.json(all.filter((d): d is NonNullable<typeof d> => Boolean(d)));
    } catch (err) {
      handleError(`GET /api/decisions/links/target/${req.params.targetType}/${req.params.targetId}`, err, res);
    }
  });
}
