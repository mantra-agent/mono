import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { createLogger } from "../log";
import { requirePermission } from "../permissions";
import {
  reconcileDocumentStoreWorkspaceMigration,
  runDocumentStoreWorkspaceMigration,
} from "./document-store-workspace-migration";

const log = createLogger("MemoryMigrationRoutes");

import {
  documentStoreShadowEnabled,
  getDocumentStoreMigrationMode,
} from "./document-store-migration-mode";

const runSchema = z.object({
  batchSize: z.number().int().min(1).max(1000).optional(),
});

function assertMigrationActive(): void {
  if (!documentStoreShadowEnabled()) {
    throw new Error(
      `Document store workspace migration is disabled; mode=${getDocumentStoreMigrationMode()}`,
    );
  }
}

export function registerMigrationRoutes(app: Express) {
  const migrationAdmin = [requireAuth, requirePermission("system:write")];

  app.get("/api/memory/migrations/document-store-workspace/reconcile", ...migrationAdmin, async (_req, res) => {
    try {
      assertMigrationActive();
      res.json(await reconcileDocumentStoreWorkspaceMigration(pool));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconcile document store workspace migration";
      log.error("document store workspace reconciliation failed", { error: message });
      res.status(message.includes("disabled") ? 409 : 500).json({ error: message });
    }
  });

  app.post("/api/memory/migrations/document-store-workspace/run", ...migrationAdmin, async (req, res) => {
    try {
      assertMigrationActive();
      const parsed = runSchema.parse(req.body ?? {});
      const result = await runDocumentStoreWorkspaceMigration(pool, { batchSize: parsed.batchSize });
      res.status(result.status === "completed" ? 200 : 409).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run document store workspace migration";
      log.error("document store workspace migration route failed", { error: message });
      res.status(message.includes("disabled") ? 409 : 500).json({ error: message });
    }
  });
}
