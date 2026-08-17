import type { Express, Response } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import { documentTemplateStorage } from "./document-template-storage";
import { createLogger } from "./log";

const log = createLogger("DocumentTemplateRoutes");

const createSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pageId: z.string(),
    status: z.enum(["active", "deprecated"]).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().optional(),
    pageId: z.string().optional(),
    status: z.enum(["active", "deprecated"]).optional(),
  })
  .strict();

const bindSchema = z
  .object({
    skillId: z.string(),
    key: z.enum(["spec", "daily", "weekly"]),
    templateId: z.string(),
  })
  .strict();

function respondError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Template operation failed";
  const status =
    error instanceof z.ZodError
      ? 400
      : message.includes("not found")
        ? 404
        : message.includes("already exists")
          ? 409
          : message.includes("required") ||
              message.includes("must be") ||
              message.includes("may not bind") ||
              message.includes("Unknown template")
            ? 400
            : 500;
  if (status >= 500) log.error("Template route failed", { errorName: error instanceof Error ? error.name : typeof error });
  res.status(status).json({
    error:
      status >= 500
        ? "Template operation failed"
        : error instanceof z.ZodError
          ? "Invalid template request"
          : message,
  });
}

export function registerDocumentTemplateRoutes(app: Express): void {
  app.use("/api/templates", requireAuth);

  app.get("/api/templates", async (req, res) => {
    try {
      const query = typeof req.query.query === "string" ? req.query.query : undefined;
      res.json({ templates: await documentTemplateStorage.list(query) });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get("/api/templates/:id", async (req, res) => {
    try {
      const template = await documentTemplateStorage.get(req.params.id);
      if (!template) return res.status(404).json({ error: "Template not found" });
      res.json(template);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.post("/api/templates", async (req, res) => {
    try {
      const input = createSchema.parse(req.body);
      const template = await documentTemplateStorage.create(input);
      log.info("Template created", { templateId: template.id });
      res.status(201).json(template);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.patch("/api/templates/:id", async (req, res) => {
    try {
      const input = updateSchema.parse(req.body);
      const template = await documentTemplateStorage.update(req.params.id, input);
      if (!template) return res.status(404).json({ error: "Template not found" });
      log.info("Template updated", { templateId: template.id });
      res.json(template);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.post("/api/templates/bind", async (req, res) => {
    try {
      const input = bindSchema.parse(req.body);
      const binding = await documentTemplateStorage.bind(input.skillId, input.key, input.templateId);
      log.info("Template bound", { skillId: input.skillId, key: input.key, templateId: input.templateId });
      res.json(binding);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get("/api/templates/resolve", async (req, res) => {
    try {
      const skill = typeof req.query.skill === "string" ? req.query.skill : "";
      const key = typeof req.query.key === "string" ? req.query.key : "";
      if (!skill || !key) return res.status(400).json({ error: "skill and key are required" });
      const resolved = await documentTemplateStorage.resolve(skill, key);
      if (!resolved) return res.status(404).json({ error: "template_unavailable" });
      res.json(resolved);
    } catch (error) {
      respondError(res, error);
    }
  });
}
