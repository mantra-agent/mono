import { pool } from "../db";
import { createLogger } from "../log";
import {
  reconcileDocumentStoreWorkspaceMigration,
  repairDocumentStoreWorkspaceProjection,
  runDocumentStoreWorkspaceMigration,
} from "./document-store-workspace-migration";
import { setDocumentStoreReadCutover } from "./document-store-cutover";
import {
  documentStoreShadowEnabled,
  documentStoreTargetReadsRequested,
  getDocumentStoreMigrationMode,
} from "./document-store-migration-mode";

const log = createLogger("DocumentStoreBootstrap");
const ADVISORY_LOCK_KEY = "document_store_workspace_migration_v1";

/**
 * Runs the replay-safe workspace-document copy in explicit shadow/cutover mode.
 * The advisory lock keeps multiple processes from running batches concurrently.
 * Work starts after readiness so migration load cannot prevent serving traffic.
 */
export async function runDocumentStoreWorkspaceMigrationBootstrap(): Promise<void> {
  const mode = getDocumentStoreMigrationMode();
  if (!documentStoreShadowEnabled()) {
    log.debug("document migration skipped in off mode");
    return;
  }

  const lockClient = await pool.connect();
  let lockAcquired = false;
  try {
    const lockResult = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [ADVISORY_LOCK_KEY],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      log.info("document migration already owned by another process");
      return;
    }

    const repair = await repairDocumentStoreWorkspaceProjection(pool);
    if (repair.repairedCount > 0) {
      log.info("document projection repaired from authoritative workspace rows", repair);
    }
    const before = await reconcileDocumentStoreWorkspaceMigration(pool);
    if (
      before.sourceCount === before.exactMatchCount &&
      before.sourceCount === before.targetCount &&
      before.unexplainedMismatchCount === 0 &&
      before.conflictCount === 0
    ) {
      await setDocumentStoreReadCutover(true, before as unknown as Record<string, unknown>);
      log.info("document migration already reconciled", {
        mode,
        targetReadsEnabled: documentStoreTargetReadsRequested(),
        reconciliation: before,
      });
      return;
    }

    log.info("document migration starting", { mode, reconciliation: before });
    const result = await runDocumentStoreWorkspaceMigration(pool);
    if (
      result.status === "completed" &&
      result.reconciliation.unexplainedMismatchCount === 0 &&
      result.reconciliation.conflictCount === 0
    ) {
      await setDocumentStoreReadCutover(
        true,
        result.reconciliation as unknown as Record<string, unknown>,
      );
      log.info("document migration completed", {
        mode,
        targetReadsEnabled: documentStoreTargetReadsRequested(),
        result,
      });
      return;
    }

    await setDocumentStoreReadCutover(
      false,
      result.reconciliation as unknown as Record<string, unknown>,
    );
    log.error("document migration stopped without clean reconciliation", { mode, result });
  } finally {
    if (lockAcquired) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
      } catch (error) {
        log.warn("failed to release document migration lock", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    lockClient.release();
  }
}
