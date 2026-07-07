import type { Express } from "express";
import { storage } from "./storage";
import { createLogger } from "./log";
import { insertPromptModuleSchema, updatePromptModuleSchema } from "@shared/schema";
import { backfillPromptModulesFromSkills } from "./prompt-modules";
import { PROMPT_MODULE_MANIFEST, isPromptModuleKey } from "./prompt-module-registry";
import { requireAuth } from "./auth";
import { requirePermission } from "./permissions";

const log = createLogger("PromptModuleRoutes");

function withManifestMetadata<T extends { key: string; domain: string; description: string; metadata: unknown }>(module: T): T {
  if (!isPromptModuleKey(module.key)) return module;
  const manifest = PROMPT_MODULE_MANIFEST[module.key];
  const existingMetadata = module.metadata && typeof module.metadata === "object" && !Array.isArray(module.metadata) ? module.metadata : {};
  return {
    ...module,
    domain: manifest.domain || module.domain,
    description: module.description || manifest.description,
    metadata: {
      ...existingMetadata,
      ownerSystem: manifest.ownerSystem,
      callSites: manifest.callSites,
      manifestDescription: manifest.description,
      activity: manifest.activity,
    },
  };
}

const patchPromptModuleSchema = updatePromptModuleSchema.extend({
  changeNote: updatePromptModuleSchema.shape.description.optional(),
});

export function registerPromptModuleRoutes(app: Express): void {
  app.get("/api/prompt-modules", requireAuth, requirePermission("build:read"), async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const domain = req.query.domain as string | undefined;
      const modules = await storage.getPromptModules({ status, domain });
      res.json(modules.map(withManifestMetadata));
    } catch (err: any) {
      log.error("GET /api/prompt-modules error:", err.message);
      res.status(500).json({ error: "Failed to fetch prompt modules" });
    }
  });

  app.post("/api/prompt-modules/backfill", requireAuth, requirePermission("build:write"), async (_req, res) => {
    try {
      const result = await backfillPromptModulesFromSkills();
      res.json(result);
    } catch (err: any) {
      log.error("POST /api/prompt-modules/backfill error:", err.message);
      res.status(500).json({ error: "Failed to backfill prompt modules" });
    }
  });

  app.get("/api/prompt-modules/key/:key", requireAuth, requirePermission("build:read"), async (req, res) => {
    try {
      const module = await storage.getPromptModuleByKey(req.params.key);
      if (!module) return res.status(404).json({ error: "Prompt module not found" });
      res.json(withManifestMetadata(module));
    } catch (err: any) {
      log.error("GET /api/prompt-modules/key/:key error:", err.message);
      res.status(500).json({ error: "Failed to fetch prompt module" });
    }
  });

  app.get("/api/prompt-modules/:id/versions", requireAuth, requirePermission("build:read"), async (req, res) => {
    try {
      const versions = await storage.getPromptModuleVersions(req.params.id);
      res.json(versions);
    } catch (err: any) {
      log.error("GET /api/prompt-modules/:id/versions error:", err.message);
      res.status(500).json({ error: "Failed to fetch prompt module versions" });
    }
  });

  app.post("/api/prompt-modules/:id/restore/:versionId", requireAuth, requirePermission("build:write"), async (req, res) => {
    try {
      const versionId = Number.parseInt(req.params.versionId, 10);
      if (!Number.isFinite(versionId)) return res.status(400).json({ error: "Invalid version id" });
      const module = await storage.restorePromptModuleVersion(req.params.id, versionId);
      if (!module) return res.status(404).json({ error: "Prompt module or version not found" });
      res.json(withManifestMetadata(module));
    } catch (err: any) {
      log.error("POST /api/prompt-modules/:id/restore/:versionId error:", err.message);
      res.status(500).json({ error: "Failed to restore prompt module" });
    }
  });

  app.get("/api/prompt-modules/:id", requireAuth, requirePermission("build:read"), async (req, res) => {
    try {
      const module = await storage.getPromptModule(req.params.id);
      if (!module) return res.status(404).json({ error: "Prompt module not found" });
      res.json(withManifestMetadata(module));
    } catch (err: any) {
      log.error("GET /api/prompt-modules/:id error:", err.message);
      res.status(500).json({ error: "Failed to fetch prompt module" });
    }
  });

  app.post("/api/prompt-modules", requireAuth, requirePermission("build:write"), async (req, res) => {
    try {
      const parsed = insertPromptModuleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      const module = await storage.createPromptModule(parsed.data);
      res.status(201).json(withManifestMetadata(module));
    } catch (err: any) {
      if (err.message?.includes("unique") || err.code === "23505") {
        return res.status(409).json({ error: "A prompt module with this key already exists" });
      }
      log.error("POST /api/prompt-modules error:", err.message);
      res.status(500).json({ error: "Failed to create prompt module" });
    }
  });

  app.patch("/api/prompt-modules/:id", requireAuth, requirePermission("build:write"), async (req, res) => {
    try {
      const parsed = patchPromptModuleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      const { changeNote, ...data } = parsed.data;
      const module = await storage.updatePromptModule(req.params.id, data, changeNote);
      if (!module) return res.status(404).json({ error: "Prompt module not found" });
      res.json(withManifestMetadata(module));
    } catch (err: any) {
      log.error("PATCH /api/prompt-modules/:id error:", err.message);
      res.status(500).json({ error: "Failed to update prompt module" });
    }
  });

  app.delete("/api/prompt-modules/:id", requireAuth, requirePermission("build:write"), async (req, res) => {
    try {
      const deleted = await storage.deletePromptModule(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Prompt module not found" });
      res.json({ success: true });
    } catch (err: any) {
      log.error("DELETE /api/prompt-modules/:id error:", err.message);
      res.status(500).json({ error: "Failed to delete prompt module" });
    }
  });
}
