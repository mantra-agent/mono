import { chatFileStorage } from "../chat-file-storage";
import { getAncestry, deleteSessionTreeRow } from "./tree";
import { createLogger } from "../log";

const log = createLogger("SessionTree");

export interface OrphanCleanupReport {
  scanned: number;
  reparented: number;
  promoted: number;
  deleted: number;
}

/**
 * One-time cleanup pass for sub-sessions whose `parentSessionId` no longer
 * resolves to an existing session. For each such orphan we:
 *   1. Walk the ancestry chain in `session_tree` until we find an ancestor
 *      whose chat document still exists. If found, re-parent the orphan to
 *      that nearest living ancestor.
 *   2. Otherwise, if the orphan has no useful content (zero messages),
 *      hard-delete it.
 *   3. Otherwise, clear its `parentSessionId` so it surfaces as a real
 *      top-level session instead of an orphan.
 *
 * Safe to re-run: in steady state the scanned/changed counts settle to zero.
 */
export async function cleanupOrphanedSubsessions(): Promise<OrphanCleanupReport> {
  const report: OrphanCleanupReport = { scanned: 0, reparented: 0, promoted: 0, deleted: 0 };

  let all;
  try {
    all = await chatFileStorage.getAllSessions();
  } catch (err) {
    log.warn(`[OrphanCleanup] getAllSessions failed: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }

  const allIds = new Set(all.map(s => s.id));
  const byId = new Map(all.map(s => [s.id, s] as const));
  const orphans = all.filter(s => s.parentSessionId && !allIds.has(s.parentSessionId));
  report.scanned = orphans.length;

  if (orphans.length === 0) {
    log.log("[OrphanCleanup] No parent-missing sub-sessions found");
    return report;
  }

  log.log(`[OrphanCleanup] Found ${orphans.length} sub-session(s) with missing parent — starting cleanup pass`);

  for (const orphan of orphans) {
    try {
      const ancestry = await getAncestry(orphan.id);
      // ancestry includes the orphan itself; find first ancestor (skipping self)
      // whose chat document still exists.
      const livingAncestor = ancestry.find(row =>
        row.sessionId !== orphan.id && allIds.has(row.sessionId),
      );

      if (livingAncestor) {
        await chatFileStorage.setParentSessionId(orphan.id, livingAncestor.sessionId, {
          spawnReason: orphan.spawnReason,
          spawnerTool: orphan.spawnerTool,
          spawnerSkillRun: orphan.spawnerSkillRun,
        });
        report.reparented++;
        log.log(`[OrphanCleanup] Re-parented ${orphan.id} -> ${livingAncestor.sessionId} (was ${orphan.parentSessionId})`);
        continue;
      }

      const messageCount = byId.get(orphan.id)?.messageCount ?? 0;
      if (messageCount === 0) {
        await chatFileStorage.deleteSession(orphan.id);
        await deleteSessionTreeRow(orphan.id);
        report.deleted++;
        log.log(`[OrphanCleanup] Hard-deleted empty orphan ${orphan.id} (was child of ${orphan.parentSessionId})`);
        continue;
      }

      await chatFileStorage.clearParentSessionId(orphan.id);
      report.promoted++;
      log.log(`[OrphanCleanup] Promoted ${orphan.id} to top-level (had ${messageCount} message(s), was child of ${orphan.parentSessionId})`);
    } catch (err) {
      log.warn(`[OrphanCleanup] Failed to clean orphan ${orphan.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.log(
    `[OrphanCleanup] Done — scanned=${report.scanned} reparented=${report.reparented} promoted=${report.promoted} deleted=${report.deleted}`,
  );
  return report;
}
