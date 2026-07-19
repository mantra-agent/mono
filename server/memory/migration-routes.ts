import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { createLogger } from "../log";
import { requirePermission } from "../permissions";
import { reconcileDocumentStoreWorkspaceMigration } from "./document-store-workspace-migration";
import {
  documentStoreIndependentWritesEnabled,
  requestIndependentDocumentStoreActivation,
} from "./document-store-cutover";

const log = createLogger("MemoryMigrationRoutes");

const runSchema = z.object({
  batchSize: z.number().int().min(1).max(1000).optional(),
});

export function registerMigrationRoutes(app: Express) {
  const migrationAdmin = [requireAuth, requirePermission("system:write")];

  app.get("/api/memory/migrations/document-store-workspace/reconcile", ...migrationAdmin, async (_req, res) => {
    try {
      res.json(await reconcileDocumentStoreWorkspaceMigration(pool));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconcile document store workspace migration";
      log.error("document store workspace reconciliation failed", { error: message });
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/memory/migrations/document-store-workspace/run", ...migrationAdmin, async (req, res) => {
    try {
      runSchema.parse(req.body ?? {});
      if (await documentStoreIndependentWritesEnabled()) {
        return res.status(409).json({
          error: "Document store is independently authoritative; legacy migration reruns are disabled",
        });
      }
      return res.status(409).json({
        error: "Document migration runs only during the startup readiness barrier",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run document store workspace migration";
      log.error("document store workspace migration route failed", { error: message });
      res.status(500).json({ error: message });
    }
  });
  app.post("/api/memory/migrations/document-store-workspace/activate", ...migrationAdmin, async (_req, res) => {
    try {
      await requestIndependentDocumentStoreActivation();
      res.status(202).json({ requested: true, restartRequired: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to request independent document-store activation";
      log.error("independent document-store activation request failed", { error: message });
      res.status(409).json({ error: message });
    }
  });

}
