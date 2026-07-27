import { createLogger } from "../log";
import type { RuntimeIdentity } from "../runtime-identity";
import { documentStoreIndependentWritesEnabled } from "./document-store-cutover";
import {
  applyLegacyMemoryQuarantine,
  getLegacyMemoryQuarantineStatus,
  legacyMemoryQuarantineWasAppliedAtBoot,
  prepareLegacyMemoryQuarantine,
} from "./legacy-memory-quarantine";

const log = createLogger("StageLegacyMemoryQuarantineOperation");
const MANTRA_WEB_STAGE_ENVIRONMENT_ID = 11;

export const STAGE_LEGACY_MEMORY_QUARANTINE_RESTART_REASON =
  "stage_legacy_memory_quarantine";

export type StageLegacyMemoryQuarantineOutcome =
  | "not_stage"
  | "document_store_not_independent"
  | "already_applied"
  | "prepared"
  | "restart_requested";

async function requestPlannedRestart(): Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error(
      "Stage legacy memory quarantine requires the supervised process wrapper",
    );
  }
  await new Promise<void>((resolve, reject) => {
    process.send!(
      {
        type: "planned_restart",
        reason: STAGE_LEGACY_MEMORY_QUARANTINE_RESTART_REASON,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/**
 * One-time post-readiness stage rollout. Canonical Platform Environment #11
 * and the durable independent-document-store epoch are hard preconditions.
 * Every eligible invocation produces a fresh verified archive immediately
 * before apply, then requests a supervised clean restart. Other environments
 * and an already-applied epoch are pure no-ops.
 */
export async function requestStageLegacyMemoryQuarantineAfterReadiness(
  runtimeIdentity: RuntimeIdentity,
): Promise<StageLegacyMemoryQuarantineOutcome> {
  if (
    runtimeIdentity.platformEnvironmentId !==
    MANTRA_WEB_STAGE_ENVIRONMENT_ID
  ) {
    return "not_stage";
  }
  if (!(await documentStoreIndependentWritesEnabled())) {
    log.warn(
      "stage legacy memory quarantine blocked: document store is not independently authoritative",
    );
    return "document_store_not_independent";
  }
  const initialStatus = await getLegacyMemoryQuarantineStatus();
  log.info("stage legacy memory quarantine catalog inspected", {
    applied: initialStatus.applied,
    preparedAt: initialStatus.preparedAt,
    appliedAt: initialStatus.appliedAt,
    archiveSha256: initialStatus.archiveSha256,
    rowCounts: initialStatus.rowCounts,
    catalog: initialStatus.catalog,
  });
  if (initialStatus.applied) {
    if (legacyMemoryQuarantineWasAppliedAtBoot()) {
      return "already_applied";
    }
    await requestPlannedRestart();
    log.info(
      "stage legacy memory quarantine observed after boot; planned restart requested",
    );
    return "restart_requested";
  }

  const status = initialStatus;
  if (!status.preparedAt || !status.archiveSha256) {
    await prepareLegacyMemoryQuarantine();
    // Request a supervised planned restart so the deployed binary self-converges
    // to apply on the next fresh boot instead of waiting passively for an
    // unrelated deployment. The apply branch below re-prepares and re-verifies
    // the archive immediately before the SET SCHEMA move, so the prepare/apply
    // split across restarts still guarantees destructive application only ever
    // runs against a freshly verified snapshot.
    await requestPlannedRestart();
    log.info(
      "stage legacy memory quarantine prepared; planned restart requested for apply on next boot",
    );
    return "restart_requested";
  }

  // A later boot always refreshes and re-verifies the archive immediately
  // before apply. This makes destructive application impossible on the first
  // deploy of a new execution path while still preventing stale snapshots.
  await prepareLegacyMemoryQuarantine();
  const applied = await applyLegacyMemoryQuarantine();
  await requestPlannedRestart();
  log.info("stage legacy memory quarantine applied; planned restart requested", {
    appliedByThisProcess: applied.applied,
    movedTables: applied.movedTables,
  });
  return "restart_requested";
}
