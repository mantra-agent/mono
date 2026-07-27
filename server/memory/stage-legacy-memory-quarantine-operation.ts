import { createLogger } from "../log";
import type { RuntimeIdentity } from "../runtime-identity";
import { documentStoreIndependentWritesEnabled } from "./document-store-cutover";
import {
  applyLegacyMemoryQuarantine,
  getLegacyMemoryQuarantineStatus,
  prepareLegacyMemoryQuarantine,
} from "./legacy-memory-quarantine";

const log = createLogger("StageLegacyMemoryQuarantineOperation");
const MANTRA_WEB_STAGE_ENVIRONMENT_ID = 11;

export const STAGE_LEGACY_MEMORY_QUARANTINE_RESTART_REASON =
  "stage_legacy_memory_quarantine";

export type StageQuarantineGuard =
  | { ok: true }
  | { ok: false; reason: "not_stage" | "document_store_not_independent" | "already_applied" };

/**
 * Every stage quarantine operation is gated on the canonical stage Platform
 * Environment (#11) and on the independent document store already owning
 * workspace writes, so the legacy `memory_entries` graph is quarantined only
 * after the workspace cutover no longer depends on it.
 */
async function guardStageQuarantine(
  runtimeIdentity: RuntimeIdentity,
): Promise<StageQuarantineGuard> {
  if (runtimeIdentity.platformEnvironmentId !== MANTRA_WEB_STAGE_ENVIRONMENT_ID) {
    return { ok: false, reason: "not_stage" };
  }
  if (!(await documentStoreIndependentWritesEnabled())) {
    return { ok: false, reason: "document_store_not_independent" };
  }
  const status = await getLegacyMemoryQuarantineStatus();
  if (status.applied) {
    return { ok: false, reason: "already_applied" };
  }
  return { ok: true };
}

/**
 * Supervised prepare: build, upload, and verify the deterministic archive on
 * stage. Does not move any table.
 */
export async function prepareStageLegacyMemoryQuarantine(
  runtimeIdentity: RuntimeIdentity,
): Promise<
  | { outcome: "prepared"; archiveObjectPath: string; archiveSha256: string; totalRows: number; rowCounts: Record<string, number> }
  | { outcome: "blocked"; reason: string }
> {
  const guard = await guardStageQuarantine(runtimeIdentity);
  if (!guard.ok) {
    log.info("stage legacy memory quarantine prepare blocked", { reason: guard.reason });
    return { outcome: "blocked", reason: guard.reason };
  }
  const prepared = await prepareLegacyMemoryQuarantine();
  return { outcome: "prepared", ...prepared };
}

/**
 * Supervised apply: prepare if needed, move the closure into the quarantine
 * schema, then request the one supervised planned restart so the next boot
 * comes up quarantine-aware. Requires the supervised process wrapper.
 */
export async function applyStageLegacyMemoryQuarantine(
  runtimeIdentity: RuntimeIdentity,
): Promise<
  | { outcome: "restart_requested"; movedTables: string[]; droppedInboundForeignKeys: string[]; rollbackSql: string }
  | { outcome: "blocked"; reason: string }
> {
  const guard = await guardStageQuarantine(runtimeIdentity);
  if (!guard.ok) {
    log.info("stage legacy memory quarantine apply blocked", { reason: guard.reason });
    return { outcome: "blocked", reason: guard.reason };
  }

  const status = await getLegacyMemoryQuarantineStatus();
  if (!status.preparedAt || !status.archiveSha256) {
    await prepareLegacyMemoryQuarantine();
  }

  const applied = await applyLegacyMemoryQuarantine();

  if (typeof process.send !== "function") {
    throw new Error("Stage legacy memory quarantine apply requires the supervised process wrapper");
  }
  await new Promise<void>((resolve, reject) => {
    process.send!(
      { type: "planned_restart", reason: STAGE_LEGACY_MEMORY_QUARANTINE_RESTART_REASON },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  log.info("stage legacy memory quarantine applied; planned restart requested");
  return {
    outcome: "restart_requested",
    movedTables: applied.movedTables,
    droppedInboundForeignKeys: applied.droppedInboundForeignKeys,
    rollbackSql: applied.rollbackSql,
  };
}
