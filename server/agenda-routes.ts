import type { Express, Response } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import { agendaDefinitionStorage } from "./agenda-storage";
import { createLogger } from "./log";

const log = createLogger("AgendaRoutes");

const agendaItemSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  title: z.string(),
  description: z.string(),
}).strict();

const createSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  items: z.array(agendaItemSchema),
}).strict();

const updateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  items: z.array(agendaItemSchema).optional(),
  clearFields: z.array(z.literal("description")).optional(),
}).strict();

function respondError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Agenda operation failed";
  const status = error instanceof z.ZodError ? 400
    : message.includes("not found") ? 404
      : message.includes("already exists") || message.includes("already uses") ? 409
        : message.includes("required") || message.includes("requires") || message.includes("must be") || message.includes("may contain") || message.includes("cannot be deleted") ? 400
          : 500;
  if (status >= 500) log.error("Agenda route failed", { errorName: error instanceof Error ? error.name : typeof error });
  res.status(status).json({
    error: status >= 500
      ? "Agenda operation failed"
      : error instanceof z.ZodError
        ? "Invalid agenda request"
        : message,
  });
}

export function registerAgendaRoutes(app: Express): void {
  app.use("/api/agendas", requireAuth);

  app.get("/api/agendas", async (req, res) => {
    try {
      await agendaDefinitionStorage.ensureFtue();
      const query = typeof req.query.query === "string" ? req.query.query : undefined;
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
      res.json({ agendas: await agendaDefinitionStorage.list(query, limit) });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get("/api/agendas/:id", async (req, res) => {
    try {
      const agenda = await agendaDefinitionStorage.get(req.params.id);
      if (!agenda) return res.status(404).json({ error: "Agenda not found" });
      res.json(agenda);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.post("/api/agendas", async (req, res) => {
    try {
      const input = createSchema.parse(req.body);
      const agenda = await agendaDefinitionStorage.create(input);
      log.info("Agenda created", { agendaId: agenda.id, itemCount: agenda.items.length });
      res.status(201).json(agenda);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.patch("/api/agendas/:id", async (req, res) => {
    try {
      const input = updateSchema.parse(req.body);
      const agenda = await agendaDefinitionStorage.update(req.params.id, input);
      if (!agenda) return res.status(404).json({ error: "Agenda not found" });
      log.info("Agenda updated", { agendaId: agenda.id, itemCount: agenda.items.length });
      res.json(agenda);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.delete("/api/agendas/:id", async (req, res) => {
    try {
      const deleted = await agendaDefinitionStorage.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Agenda not found" });
      log.info("Agenda deleted", { agendaId: req.params.id });
      res.status(204).end();
    } catch (error) {
      respondError(res, error);
    }
  });
}
