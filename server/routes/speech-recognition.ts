import type { Express } from "express";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import { requirePermission } from "../permissions";
import {
  deleteEnvironmentSpeechRecognitionBinding,
  getEnvironmentSpeechRecognitionBindings,
  upsertEnvironmentSpeechRecognitionBinding,
} from "../speech-recognition/service";

const log = createLogger("SpeechRecognitionRoutes");

function positiveId(value: string, label: string): number {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid ${label}`);
  return id;
}

export function registerSpeechRecognitionRoutes(app: Express): void {
  const base = "/api/platforms/environments/:environmentId/speech-recognition-bindings";

  app.get(base, requireAuth, requirePermission("system:read"), async (req, res) => {
    try {
      const environmentId = positiveId(req.params.environmentId, "environment id");
      const bindings = await getEnvironmentSpeechRecognitionBindings(environmentId);
      if (!bindings) return res.status(404).json({ error: "Platform Environment not found" });
      res.json(bindings);
    } catch (error) {
      log.error("Speech recognition binding list failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      res.status(400).json({ error: error instanceof Error ? error.message : "Speech binding list failed" });
    }
  });

  app.put(base, requireAuth, requirePermission("system:write"), async (req, res) => {
    try {
      const environmentId = positiveId(req.params.environmentId, "environment id");
      const binding = await upsertEnvironmentSpeechRecognitionBinding(environmentId, req.body);
      log.info("Speech recognition binding configured", {
        environmentId,
        bindingId: binding.id,
        provider: binding.provider,
        enabled: binding.enabled,
        sortOrder: binding.sortOrder,
      });
      res.json({ id: binding.id, environmentId, configured: true });
    } catch (error) {
      log.error("Speech recognition binding mutation failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      res.status(400).json({ error: error instanceof Error ? error.message : "Speech binding mutation failed" });
    }
  });

  app.delete(`${base}/:bindingId`, requireAuth, requirePermission("system:write"), async (req, res) => {
    try {
      const environmentId = positiveId(req.params.environmentId, "environment id");
      const bindingId = positiveId(req.params.bindingId, "binding id");
      const deleted = await deleteEnvironmentSpeechRecognitionBinding(environmentId, bindingId);
      if (!deleted) return res.status(404).json({ error: "Speech recognition binding not found" });
      log.info("Speech recognition binding deleted", { environmentId, bindingId });
      res.json({ deleted: true });
    } catch (error) {
      log.error("Speech recognition binding deletion failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      res.status(400).json({ error: error instanceof Error ? error.message : "Speech binding deletion failed" });
    }
  });
}
