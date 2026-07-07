import { chatFileStorage, type IChatFileStorage, type FileSession } from "./chat-file-storage";
import { createLogger } from "./log";

const log = createLogger("SessionTree");

export const ORPHAN_END_REASON = "parent_orphaned";

export interface OrphanCandidate {
  childId: string;
  childTitle: string;
  parentId: string;
  parentExists: boolean;
  parentStatus?: string;
  parentEndReason?: string;
  childStatus?: string;
  childEndReason?: string;
}

export interface OrphanCleanupResult {
  scanned: number;
  candidates: OrphanCandidate[];
  closed: string[];
  alreadyClosed: string[];
  errors: Array<{ childId: string; error: string }>;
}

/**
 * A parent session has ended abnormally when:
 *   - it cannot be found (deleted out from under its children), OR
 *   - its lifecycle status is failed, OR
 *   - its endReason is set to anything other than a clean completion.
 */
function isParentAbnormal(parent: FileSession | undefined): boolean {
  if (!parent) return true;
  if (parent.status === "failed") return true;
  if (parent.endReason && parent.endReason !== "complete") return true;
  return false;
}

function isChildStillOpen(child: FileSession): boolean {
  if (child.endReason === ORPHAN_END_REASON) return false;
  return child.status === "streaming";
}

export async function findOrphanedChildren(
  storage: Pick<IChatFileStorage, "getAllSessions" | "getSession"> = chatFileStorage,
): Promise<OrphanCandidate[]> {
  const sessions = await storage.getAllSessions();
  const byId = new Map<string, FileSession>(sessions.map(s => [s.id, s]));
  const candidates: OrphanCandidate[] = [];

  for (const child of sessions) {
    if (!child.parentSessionId) continue;
    if (!isChildStillOpen(child)) continue;
    const parent = byId.get(child.parentSessionId);
    if (!isParentAbnormal(parent)) continue;
    candidates.push({
      childId: child.id,
      childTitle: child.title,
      parentId: child.parentSessionId,
      parentExists: !!parent,
      parentStatus: parent?.status,
      parentEndReason: parent?.endReason,
      childStatus: child.status,
      childEndReason: child.endReason,
    });
  }

  log.log(`scan-orphans scanned=${sessions.length} candidates=${candidates.length}`);
  return candidates;
}

export async function cleanupOrphanedChildren(
  storage: Pick<IChatFileStorage, "getAllSessions" | "getSession" | "updateSessionStatus" | "setEndReason"> = chatFileStorage,
): Promise<OrphanCleanupResult> {
  const sessions = await storage.getAllSessions();
  const byId = new Map<string, FileSession>(sessions.map(s => [s.id, s]));
  const result: OrphanCleanupResult = {
    scanned: sessions.length,
    candidates: [],
    closed: [],
    alreadyClosed: [],
    errors: [],
  };

  for (const child of sessions) {
    if (!child.parentSessionId) continue;
    const parent = byId.get(child.parentSessionId);
    if (!isParentAbnormal(parent)) continue;

    const candidate: OrphanCandidate = {
      childId: child.id,
      childTitle: child.title,
      parentId: child.parentSessionId,
      parentExists: !!parent,
      parentStatus: parent?.status,
      parentEndReason: parent?.endReason,
      childStatus: child.status,
      childEndReason: child.endReason,
    };
    result.candidates.push(candidate);

    if (child.endReason === ORPHAN_END_REASON) {
      result.alreadyClosed.push(child.id);
      log.log(`cleanup-orphans skip child=${child.id} parent=${child.parentSessionId} — already endReason=${ORPHAN_END_REASON}`);
      continue;
    }

    try {
      await storage.updateSessionStatus(child.id, "failed");
      await storage.setEndReason(child.id, ORPHAN_END_REASON);
      result.closed.push(child.id);
      log.log(`cleanup-orphans closed child=${child.id} parent=${child.parentSessionId} parentExists=${!!parent} parentStatus=${parent?.status || "-"} parentEndReason=${parent?.endReason || "-"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ childId: child.id, error: msg });
      log.error(`cleanup-orphans error child=${child.id} parent=${child.parentSessionId} — ${msg}`);
    }
  }

  log.log(`cleanup-orphans done scanned=${result.scanned} candidates=${result.candidates.length} closed=${result.closed.length} alreadyClosed=${result.alreadyClosed.length} errors=${result.errors.length}`);
  return result;
}
