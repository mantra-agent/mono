import { chatFileStorage } from "../chat-file-storage";
import { getAncestry, getChildren, deleteSessionTreeRow, upsertSessionTreeRow } from "./tree";
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

export interface ReparentChildrenReport {
  reparented: number;
  promoted: number;
  deleted: number;
}

/**
 * Re-home the children of a session that is about to be (or just was) deleted,
 * so they don't surface as new `parentMissing` orphans on the next boot.
 *
 * For each child:
 *   1. If the deleted session has a living ancestor (preferring its immediate
 *      parent), re-parent the child to that ancestor.
 *   2. Otherwise, if the child has no useful content (zero messages or no
 *      chat doc), hard-delete it.
 *   3. Otherwise clear the child's `parentSessionId` so it surfaces as a real
 *      top-level session.
 *
 * Idempotent: safe to call multiple times; settles to a no-op once children
 * are re-homed.
 *
 * `hintedParentId` is the deleted session's own parent (its metadata
 * `parentSessionId`) — passed in by callers to avoid a second `getAncestry`
 * lookup and to handle sessions whose tree row may not yet have been written.
 */
export async function reparentChildrenOfDeletedSession(
  deletedId: string,
  hintedParentId?: string | null,
): Promise<ReparentChildrenReport> {
  const report: ReparentChildrenReport = { reparented: 0, promoted: 0, deleted: 0 };

  let treeChildren: Awaited<ReturnType<typeof getChildren>> = [];
  try {
    treeChildren = await getChildren(deletedId);
  } catch {
    /* getChildren already logs */
  }

  let allSessions: Awaited<ReturnType<typeof chatFileStorage.getAllSessions>> = [];
  try {
    allSessions = await chatFileStorage.getAllSessions();
  } catch (err) {
    log.warn(`[OrphanCleanup] reparentChildrenOf(${deletedId}) getAllSessions failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const allIds = new Set(allSessions.map(s => s.id));
  const byId = new Map(allSessions.map(s => [s.id, s] as const));
  // Some legacy children may only have parentSessionId in chat-doc metadata
  // (no session_tree row yet). Union both sources so we don't miss any.
  const metaChildIds = allSessions.filter(s => s.parentSessionId === deletedId).map(s => s.id);
  const childIds = new Set<string>([
    ...treeChildren.map(c => c.sessionId),
    ...metaChildIds,
  ]);
  childIds.delete(deletedId);

  if (childIds.size === 0) return report;

  // Find the nearest living ancestor of `deletedId` to use as the children's
  // new parent. Prefer the hinted (immediate) parent when it still exists;
  // otherwise walk up the ancestry chain.
  let livingAncestorId: string | null = null;
  const liveAllIds = new Set(allIds);
  liveAllIds.delete(deletedId);
  if (hintedParentId && hintedParentId !== deletedId && liveAllIds.has(hintedParentId)) {
    livingAncestorId = hintedParentId;
  } else {
    try {
      const ancestry = await getAncestry(deletedId);
      const found = ancestry.find(row => row.sessionId !== deletedId && liveAllIds.has(row.sessionId));
      if (found) livingAncestorId = found.sessionId;
    } catch {
      /* getAncestry already logs */
    }
  }

  const treeRowById = new Map(treeChildren.map(c => [c.sessionId, c] as const));

  for (const childId of childIds) {
    try {
      const childDoc = byId.get(childId);
      const stillExists = childDoc !== undefined;
      const treeRow = treeRowById.get(childId);

      if (livingAncestorId) {
        if (stillExists) {
          await chatFileStorage.setParentSessionId(childId, livingAncestorId, {
            spawnReason: childDoc.spawnReason ?? treeRow?.spawnReason ?? undefined,
            spawnerTool: childDoc.spawnerTool ?? treeRow?.spawnerTool ?? undefined,
            spawnerSkillRun: childDoc.spawnerSkillRun ?? treeRow?.spawnerSkillRun ?? undefined,
          });
        } else {
          // No chat doc — just rewrite the tree row directly.
          await upsertSessionTreeRow({
            sessionId: childId,
            parentSessionId: livingAncestorId,
            spawnReason: treeRow?.spawnReason ?? null,
            spawnerTool: treeRow?.spawnerTool ?? null,
            spawnerSkillRun: treeRow?.spawnerSkillRun ?? null,
          });
        }
        report.reparented++;
        log.log(`[OrphanCleanup] On delete of ${deletedId}: re-parented ${childId} -> ${livingAncestorId}`);
        continue;
      }

      const messageCount = childDoc?.messageCount ?? 0;
      if (!stillExists || messageCount === 0) {
        if (stillExists) {
          await chatFileStorage.deleteSession(childId);
        } else {
          await deleteSessionTreeRow(childId);
        }
        report.deleted++;
        log.log(`[OrphanCleanup] On delete of ${deletedId}: hard-deleted empty child ${childId}`);
        continue;
      }

      await chatFileStorage.clearParentSessionId(childId);
      report.promoted++;
      log.log(`[OrphanCleanup] On delete of ${deletedId}: promoted ${childId} to top-level (${messageCount} message(s))`);
    } catch (err) {
      log.warn(`[OrphanCleanup] reparentChildrenOf(${deletedId}) failed for child ${childId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return report;
}
