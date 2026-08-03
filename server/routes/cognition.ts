// Use createLogger for logging ONLY
import type { Express, Response } from "express";
import { z } from "zod";
import { semanticTierSchema } from "@shared/model-connectors";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { isUniqueViolationError } from "../postgres-errors";

const log = createLogger("CognitionRoutes");

function sendRouteError(
  res: Response,
  error: unknown,
  context: string,
  reservedNameError: new (...args: never[]) => Error & { statusCode: number },
): void {
  const err = error as Error & { statusCode?: number };
  const message = err?.message || String(error);
  log.error(`${context} error:`, message);

  if (error instanceof reservedNameError) {
    res.status(err.statusCode ?? 409).json({ error: message });
    return;
  }
  if (isUniqueViolationError(error)) {
    res.status(409).json({
      error: "Could not save persona due to a temporary ID conflict. Please try again.",
    });
    return;
  }
  // Never leak raw Drizzle/Postgres SQL ("Failed query: insert into ...") to the client.
  if (/^Failed query:/i.test(message) || /unique constraint/i.test(message)) {
    res.status(500).json({ error: "Could not save persona. Please try again." });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
}

export async function registerCognitionRoutes(app: Express) {
  app.use(["/api/personas", "/api/emotion", "/api/cognition"], requireAuth);
  const { personaStorage, PersonaReservedNameError } = await import("../file-storage/persona-storage");

  // === Persona Routes ===

  app.get("/api/personas", async (_req, res) => {
    log.debug("GET /api/personas");
    try {
      res.json(await personaStorage.list());
    } catch (error: unknown) {
      sendRouteError(res, error, "GET /api/personas", PersonaReservedNameError);
    }
  });

  app.get("/api/personas/management", async (_req, res) => {
    log.debug("GET /api/personas/management");
    try {
      res.json(await personaStorage.listForManagement());
    } catch (error: unknown) {
      sendRouteError(res, error, "GET /api/personas/management", PersonaReservedNameError);
    }
  });

  app.get("/api/personas/active", async (_req, res) => {
    log.debug("GET /api/personas/active");
    try {
      const active = await personaStorage.getActive();
      res.json(active);
    } catch (error: unknown) {
      sendRouteError(res, error, "GET /api/personas/active", PersonaReservedNameError);
    }
  });

  // Catalog of optional context sections a persona bundle can toggle. Bootstrap
  // sections are always loaded and intentionally excluded from this list.
  app.get("/api/personas/section-catalog", async (_req, res) => {
    log.debug("GET /api/personas/section-catalog");
    try {
      const { getContextSectionCatalog } = await import("../context-builder");
      res.json(getContextSectionCatalog());
    } catch (error: unknown) {
      sendRouteError(res, error, "GET /api/personas/section-catalog", PersonaReservedNameError);
    }
  });

  // Catalog of agent tools a persona bundle can toggle. Core tools are marked so
  // the editor can render them as always-on; an empty bundle loads all tools.
  app.get("/api/personas/tool-catalog", async (_req, res) => {
    log.debug("GET /api/personas/tool-catalog");
    try {
      const { getToolCatalog } = await import("../tool-registry");
      res.json(getToolCatalog());
    } catch (error: unknown) {
      sendRouteError(res, error, "GET /api/personas/tool-catalog", PersonaReservedNameError);
    }
  });

  const createPersonaSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    icon: z.string().min(1).max(50).optional(),
    promptOverlay: z.string().max(5000).optional(),
    expressionTags: z.array(z.string()).max(20).optional(),
    cognitiveOverrides: z.record(z.unknown()).optional(),
    semanticTier: semanticTierSchema.nullable().optional(),
    contextSections: z.record(z.boolean()).optional(),
    toolBundle: z.array(z.string()).optional(),
  });

  app.post("/api/personas", async (req, res) => {
    log.debug("POST /api/personas name=", req.body?.name);
    try {
      const parsed = createPersonaSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const persona = await personaStorage.create(parsed.data);
      res.status(201).json(persona);
    } catch (error: unknown) {
      sendRouteError(res, error, "POST /api/personas", PersonaReservedNameError);
    }
  });

  const updatePersonaSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(1000).optional(),
    icon: z.string().min(1).max(50).optional(),
    promptOverlay: z.string().max(5000).optional(),
    expressionTags: z.array(z.string()).max(20).optional(),
    cognitiveOverrides: z.record(z.unknown()).optional(),
    semanticTier: semanticTierSchema.nullable().optional(),
    contextSections: z.record(z.boolean()).optional(),
    toolBundle: z.array(z.string()).optional(),
  });

  app.put("/api/personas/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    log.debug("PUT /api/personas/:id id=", id);
    try {
      if (isNaN(id))
        return res.status(400).json({ error: "Invalid persona ID" });
      const parsed = updatePersonaSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      // Editing a seed copy-on-writes into the caller's own persona row so the
      // save lands on an editable copy instead of failing against a read-only seed.
      const owned = await personaStorage.ensureOwnedCopy(id);
      if (!owned) return res.status(404).json({ error: "Persona not found" });
      const updated = await personaStorage.update(owned.id, parsed.data);
      if (!updated) return res.status(403).json({ error: "Persona is read-only or not found" });
      res.json(updated);
    } catch (error: unknown) {
      sendRouteError(res, error, "PUT /api/personas/:id", PersonaReservedNameError);
    }
  });

  app.post("/api/personas/:id/activate", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    log.debug("POST /api/personas/:id/activate id=", id);
    try {
      if (isNaN(id))
        return res.status(400).json({ error: "Invalid persona ID" });
      const activated = await personaStorage.activate(id);
      if (!activated)
        return res.status(404).json({ error: "Persona not found" });
      const { eventBus } = await import("../event-bus");
      eventBus.publish({
        category: "agent",
        event: "cognition.persona.switched",
        payload: { personaId: activated.id, personaName: activated.name },
        sessionId: null,
        userId: null,
      });
      res.json(activated);
    } catch (error: unknown) {
      sendRouteError(res, error, "POST /api/personas/:id/activate", PersonaReservedNameError);
    }
  });

  app.delete("/api/personas/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    log.debug("DELETE /api/personas/:id id=", id);
    try {
      if (isNaN(id))
        return res.status(400).json({ error: "Invalid persona ID" });
      const result = await personaStorage.delete(id);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ message: "Persona deleted" });
    } catch (error: unknown) {
      sendRouteError(res, error, "DELETE /api/personas/:id", PersonaReservedNameError);
    }
  });
}
