import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { createLogger } from "../log";
import { requirePermission } from "../permissions";
import { getRuntimeIdentity } from "../runtime-identity";
import {
  reconcileDocumentStoreWorkspaceMigration,
  runDocumentStoreWorkspaceMigration,
} from "./document-store-workspace-migration";

const log = createLogger("MemoryMigrationRoutes");

const runSchema = z.object({
  batchSize: z.number().int().min(1).max(1000).optional(),
});

async function assertStageOnly(): Promise<void> {
  const identity = await getRuntimeIdentity();
  const names = [identity.platformEnvironmentName, identity.environmentName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (!names.includes("stage") && !names.includes("staging")) {
    throw new Error(
      `Document store workspace migration is stage-only in this step; current environment=${identity.platformEnvironmentName ?? identity.environmentName}`,
    );
  }
}

export function registerMigrationRoutes(app: Express) {
  const migrationAdmin = [requireAuth, requirePermission("system:write")];

  app.get("/api/memory/migrations/document-store-workspace/reconcile", ...migrationAdmin, async (_req, res) => {
    try {
      await assertStageOnly();
      res.json(await reconcileDocumentStoreWorkspaceMigration(pool));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconcile document store workspace migration";
      log.error("document store workspace reconciliation failed", { error: message });
      res.status(message.includes("stage-only") ? 403 : 500).json({ error: message });
    }
  });

  app.post("/api/memory/migrations/document-store-workspace/run", ...migrationAdmin, async (req, res) => {
    try {
      await assertStageOnly();
      const parsed = runSchema.parse(req.body ?? {});
      const result = await runDocumentStoreWorkspaceMigration(pool, { batchSize: parsed.batchSize });
      res.status(result.status === "completed" ? 200 : 409).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run document store workspace migration";
      log.error("document store workspace migration route failed", { error: message });
      res.status(message.includes("stage-only") ? 403 : 500).json({ error: message });
    }
  });
}
