import { pool } from "../db";
import { createLogger } from "../log";
import {
  reconcileDocumentStoreWorkspaceMigration,
  repairDocumentStoreWorkspaceProjection,
  runDocumentStoreWorkspaceMigration,
} from "./document-store-workspace-migration";
import {
  documentStoreIndependentActivationRequested,
  documentStoreIndependentWritesEnabled,
  enableIndependentDocumentStore,
  ensureDocumentStoreMirror,
  setDocumentStoreReadCutover,
} from "./document-store-cutover";

const log = createLogger("DocumentStoreBootstrap");
const ADVISORY_LOCK_KEY = "document_store_workspace_migration_v1";

/**
 * Reconciles and activates the document store before readiness. Every process
 * waits on the same advisory lock, then re-checks the persisted epoch. No
 * document consumer can run against a half-reconciled store.
 */
export async function runDocumentStoreWorkspaceMigrationBootstrap(): Promise<void> {
  const lockClient = await pool.connect();
  let lockAcquired = false;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [ADVISORY_LOCK_KEY]);
    lockAcquired = true;
    await ensureDocumentStoreMirror();
    if (await documentStoreIndependentWritesEnabled()) {
      await enableIndependentDocumentStore();
      log.info("document store already independently authoritative");
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
      if (await documentStoreIndependentActivationRequested()) {
        await enableIndependentDocumentStore();
        log.info("document migration reconciled and independently activated", {
          reconciliation: before,
        });
      } else {
        log.info("document migration reconciled; database activation request not yet present", {
          reconciliation: before,
        });
      }
      return;
    }

    log.info("document migration starting before readiness", { reconciliation: before });
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
      if (await documentStoreIndependentActivationRequested()) {
        await enableIndependentDocumentStore();
        log.info("document migration completed and independently activated", { result });
      } else {
        log.info("document migration completed; database activation request not yet present", { result });
      }
      return;
    }

    await setDocumentStoreReadCutover(
      false,
      result.reconciliation as unknown as Record<string, unknown>,
    );
    log.error("document migration stopped without clean reconciliation", { result });
    throw new Error("Document-store startup reconciliation failed; server readiness blocked");
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
