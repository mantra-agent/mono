// Use createLogger for logging ONLY
import type { Express } from "express";
import { z } from "zod";
import { createLogger } from "../log";
import { requireAuth } from "../auth";

const log = createLogger("CognitionRoutes");

export async function registerCognitionRoutes(app: Express) {
  app.use(["/api/personas", "/api/emotion", "/api/cognition"], requireAuth);
  const { personaStorage } = await import("../file-storage/persona-storage");

  // === Persona Routes ===

  app.get("/api/personas", async (_req, res) => {
    log.debug("GET /api/personas");
    try {
      const all = await personaStorage.list();
      res.json(all.filter((p) => !p.isSystem));
    } catch (error: any) {
      log.error("GET /api/personas error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/personas/active", async (_req, res) => {
    log.debug("GET /api/personas/active");
    try {
      const active = await personaStorage.getActive();
      res.json(active);
    } catch (error: any) {
      log.error("GET /api/personas/active error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  const createPersonaSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    icon: z.string().min(1).max(50).optional(),
    promptOverlay: z.string().max(5000).optional(),
    expressionTags: z.array(z.string()).max(20).optional(),
    cognitiveOverrides: z.record(z.unknown()).optional(),
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
    } catch (error: any) {
      log.error("POST /api/personas error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  const updatePersonaSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(1000).optional(),
    icon: z.string().min(1).max(50).optional(),
    promptOverlay: z.string().max(5000).optional(),
    expressionTags: z.array(z.string()).max(20).optional(),
    cognitiveOverrides: z.record(z.unknown()).optional(),
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
      const updated = await personaStorage.update(id, parsed.data);
      if (!updated) return res.status(404).json({ error: "Persona not found" });
      res.json(updated);
    } catch (error: any) {
      log.error("PUT /api/personas/:id error:", error?.message);
      res.status(500).json({ error: error.message });
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
      });
      res.json(activated);
    } catch (error: any) {
      log.error("POST /api/personas/:id/activate error:", error?.message);
      res.status(500).json({ error: error.message });
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
    } catch (error: any) {
      log.error("DELETE /api/personas/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });
}
