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
import {
  LIVE_LEGACY_MEMORY_QUARANTINE_ENV,
  applyLegacyMemoryQuarantine,
  getLegacyMemoryQuarantineStatus,
  observeLegacyMemoryWriteActivity,
  prepareLegacyMemoryQuarantine,
} from "./legacy-memory-quarantine";

const log = createLogger("MemoryMigrationRoutes");

const runSchema = z.object({
  batchSize: z.number().int().min(1).max(1000).optional(),
});

const MANTRA_WEB_LIVE_ENVIRONMENT_ID = 12;
const LIVE_LEGACY_MEMORY_APPLY_CONFIRMATION =
  "APPLY-LIVE-LEGACY-MEMORY-QUARANTINE";

const liveApplySchema = z.object({
  confirm: z.string(),
});

async function resolveLivePlatformEnvironmentId(): Promise<number | null> {
  const { getRuntimeIdentity } = await import("../runtime-identity");
  const runtimeIdentity = await getRuntimeIdentity();
  return runtimeIdentity.platformEnvironmentId;
}

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
      const outcome = await requestIndependentDocumentStoreActivation();
      res.status(outcome === "requested" ? 202 : 200).json({
        outcome,
        requested: outcome !== "already_enabled",
        restartRequired: outcome !== "already_enabled",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to request independent document-store activation";
      log.error("independent document-store activation request failed", { error: message });
      res.status(409).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // Legacy-memory quarantine (Live, Platform Environment #12)
  //
  // status  — read-only catalog + ledger state (any environment).
  // prepare — non-mutating: builds and byte-verifies the immutable archive,
  //           persists prepared state, records a zero-write observation. Moves
  //           NO table. Live (env 12) only.
  // apply   — the explicit, human-authorized destructive gate: moves the 7
  //           legacy tables to the archive schema and drops the 2 inbound FKs.
  //           Requires an exact confirmation string. Live (env 12) only.
  // ---------------------------------------------------------------------------
  app.get(
    "/api/memory/migrations/legacy-memory/status",
    ...migrationAdmin,
    async (_req, res) => {
      try {
        const [status, writeActivity] = await Promise.all([
          getLegacyMemoryQuarantineStatus(),
          observeLegacyMemoryWriteActivity(),
        ]);
        res.json({ ...status, writeActivity });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to read legacy-memory quarantine status";
        log.error("legacy-memory quarantine status failed", { error: message });
        res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/memory/migrations/legacy-memory/live/prepare",
    ...migrationAdmin,
    async (_req, res) => {
      try {
        const platformEnvironmentId = await resolveLivePlatformEnvironmentId();
        if (platformEnvironmentId !== MANTRA_WEB_LIVE_ENVIRONMENT_ID) {
          return res.status(409).json({
            error:
              "Live legacy-memory prepare runs only on Platform Environment #12 (live)",
          });
        }
        if (!(await documentStoreIndependentWritesEnabled())) {
          return res.status(409).json({
            error:
              "Document store is not independently authoritative; legacy-memory prepare is unavailable",
          });
        }
        const writeActivityBefore = await observeLegacyMemoryWriteActivity();
        const prepared = await prepareLegacyMemoryQuarantine(
          LIVE_LEGACY_MEMORY_QUARANTINE_ENV,
        );
        const status = await getLegacyMemoryQuarantineStatus();
        res.json({
          outcome: "prepared",
          moved: false,
          ...prepared,
          hasRollbackSql: status.hasRollbackSql,
          writeActivity: writeActivityBefore,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to prepare live legacy-memory quarantine";
        log.error("live legacy-memory quarantine prepare failed", {
          error: message,
        });
        res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/memory/migrations/legacy-memory/live/apply",
    ...migrationAdmin,
    async (req, res) => {
      try {
        const body = liveApplySchema.parse(req.body ?? {});
        if (body.confirm !== LIVE_LEGACY_MEMORY_APPLY_CONFIRMATION) {
          return res.status(400).json({
            error: `Explicit confirmation required to move Live legacy-memory tables (confirm must equal "${LIVE_LEGACY_MEMORY_APPLY_CONFIRMATION}")`,
          });
        }
        const platformEnvironmentId = await resolveLivePlatformEnvironmentId();
        if (platformEnvironmentId !== MANTRA_WEB_LIVE_ENVIRONMENT_ID) {
          return res.status(409).json({
            error:
              "Live legacy-memory apply runs only on Platform Environment #12 (live)",
          });
        }
        const applied = await applyLegacyMemoryQuarantine(
          LIVE_LEGACY_MEMORY_QUARANTINE_ENV,
        );
        log.info("live legacy-memory quarantine applied via authorized route", {
          movedTables: applied.movedTables,
          droppedInboundForeignKeys: applied.droppedInboundForeignKeys,
        });
        res.json({ outcome: "applied", ...applied });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to apply live legacy-memory quarantine";
        log.error("live legacy-memory quarantine apply failed", {
          error: message,
        });
        res.status(500).json({ error: message });
      }
    },
  );
}
