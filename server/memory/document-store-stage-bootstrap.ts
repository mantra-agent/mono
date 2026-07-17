import { pool } from "../db";
import { createLogger } from "../log";
import { getRuntimeIdentity } from "../runtime-identity";
import {
  reconcileDocumentStoreWorkspaceMigration,
  repairDocumentStoreWorkspaceProjection,
  runDocumentStoreWorkspaceMigration,
} from "./document-store-workspace-migration";
import { setStageDocumentStoreReadCutover } from "./document-store-stage-cutover";

const log = createLogger("DocumentStoreStageBootstrap");
const ADVISORY_LOCK_KEY = "document_store_workspace_migration_v1";

function isStageEnvironment(names: Array<string | null | undefined>): boolean {
  return names
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
    .some((value) => value === "stage" || value === "staging");
}

/**
 * Runs the Step 2 workspace-document copy only on stage.
 *
 * The migration itself is replay-safe and copy-only. The advisory lock keeps
 * multiple stage processes from running the same batches concurrently. This
 * function is deliberately invoked after readiness so migration load cannot
 * prevent the application from serving traffic.
 */
export async function runStageDocumentStoreWorkspaceMigration(): Promise<void> {
  const identity = await getRuntimeIdentity();
  if (!isStageEnvironment([identity.platformEnvironmentName, identity.environmentName])) {
    log.debug("stage document migration skipped outside stage", {
      platformEnvironmentName: identity.platformEnvironmentName,
      environmentName: identity.environmentName,
    });
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
      log.info("stage document migration already owned by another process");
      return;
    }

    const repair = await repairDocumentStoreWorkspaceProjection(pool);
    if (repair.repairedCount > 0) {
      log.info("stage document projection repaired from authoritative workspace rows", repair);
    }
    const before = await reconcileDocumentStoreWorkspaceMigration(pool);
    if (
      before.sourceCount === before.exactMatchCount &&
      before.sourceCount === before.targetCount &&
      before.unexplainedMismatchCount === 0 &&
      before.conflictCount === 0
    ) {
      await setStageDocumentStoreReadCutover(true, before as unknown as Record<string, unknown>);
      log.info("stage document migration already reconciled; target reads enabled", { reconciliation: before });
      return;
    }

    log.info("stage document migration starting", { reconciliation: before });
    const result = await runDocumentStoreWorkspaceMigration(pool);
    if (
      result.status === "completed" &&
      result.reconciliation.unexplainedMismatchCount === 0 &&
      result.reconciliation.conflictCount === 0
    ) {
      await setStageDocumentStoreReadCutover(
        true,
        result.reconciliation as unknown as Record<string, unknown>,
      );
      log.info("stage document migration completed; target reads enabled", result);
      return;
    }

    await setStageDocumentStoreReadCutover(
      false,
      result.reconciliation as unknown as Record<string, unknown>,
    );
    log.error("stage document migration stopped without clean reconciliation", result);
  } finally {
    if (lockAcquired) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
      } catch (error) {
        log.warn("failed to release stage document migration lock", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    lockClient.release();
  }
}
