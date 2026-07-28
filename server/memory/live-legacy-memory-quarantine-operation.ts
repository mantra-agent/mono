import { createLogger } from "../log";
import type { RuntimeIdentity } from "../runtime-identity";
import { documentStoreIndependentWritesEnabled } from "./document-store-cutover";
import {
  LIVE_LEGACY_MEMORY_QUARANTINE_ENV,
  getLegacyMemoryQuarantineStatus,
  observeLegacyMemoryWriteActivity,
  prepareLegacyMemoryQuarantine,
} from "./legacy-memory-quarantine";

const log = createLogger("LiveLegacyMemoryQuarantineOperation");
const MANTRA_WEB_LIVE_ENVIRONMENT_ID = 12;

export type LiveLegacyMemoryQuarantinePrepareOutcome =
  | "not_live"
  | "document_store_not_independent"
  | "already_applied"
  | "already_prepared"
  | "prepared";

/**
 * Live (Platform Environment #12) legacy-memory quarantine entrypoint.
 *
 * This entrypoint is prepare-and-report ONLY. It never moves, drops, archives,
 * or truncates any table. It builds and byte-verifies the immutable deletion-
 * grade archive (SHA-256 read-back verified), persists prepared state, and
 * records a zero-write observation. Moving the tables requires an explicit,
 * separately authorized human action through the authenticated Live apply route
 * (`applyLegacyMemoryQuarantine`); absent that authorization this path prepares
 * and reports only.
 *
 * The Stage rollout (env 11) remains untouched and is the only path that may
 * self-converge to apply on a supervised restart.
 */
export async function requestLiveLegacyMemoryQuarantinePrepareAfterReadiness(
  runtimeIdentity: RuntimeIdentity,
): Promise<LiveLegacyMemoryQuarantinePrepareOutcome> {
  if (runtimeIdentity.platformEnvironmentId !== MANTRA_WEB_LIVE_ENVIRONMENT_ID) {
    return "not_live";
  }
  if (!(await documentStoreIndependentWritesEnabled())) {
    log.warn(
      "live legacy memory quarantine prepare blocked: document store is not independently authoritative",
    );
    return "document_store_not_independent";
  }

  const status = await getLegacyMemoryQuarantineStatus();
  if (status.applied) {
    return "already_applied";
  }
  if (status.preparedAt && status.archiveSha256) {
    log.info("live legacy memory quarantine already prepared; reporting only", {
      preparedAt: status.preparedAt,
      archiveSha256: status.archiveSha256,
      rowCounts: status.rowCounts,
    });
    return "already_prepared";
  }

  const writeActivityBefore = await observeLegacyMemoryWriteActivity();
  const prepared = await prepareLegacyMemoryQuarantine(
    LIVE_LEGACY_MEMORY_QUARANTINE_ENV,
  );
  log.info("live legacy memory quarantine prepared; no tables moved", {
    archiveObjectPath: prepared.archiveObjectPath,
    archiveSha256: prepared.archiveSha256,
    totalRows: prepared.totalRows,
    rowCounts: prepared.rowCounts,
    writeActivity: writeActivityBefore,
  });
  return "prepared";
}
