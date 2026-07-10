import { and, eq, lt, sql, desc, inArray } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import {
  memoryVnextSourceQueue,
  memoryVnextSourceRefs,
  memoryVnextClaims,
  type VnextSourceType,
  type MemoryVnextSourceQueueRow,
} from "@shared/schema";

const log = createLogger("VnextSourceQueue");

const scopeColumns = {
  ownerUserId: memoryVnextSourceQueue.ownerUserId,
  accountId: memoryVnextSourceQueue.accountId,
};


const sourceRefScopeColumns = {
  scope: memoryVnextSourceRefs.scope,
  ownerUserId: memoryVnextSourceRefs.ownerUserId,
  accountId: memoryVnextSourceRefs.accountId,
};

const claimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
};

async function isAutonomousSessionSource(sourceId: string): Promise<boolean> {
  const { chatFileStorage } = await import("../chat-file-storage");
  const session = await chatFileStorage.getSession(sourceId);
  return session?.sessionType === "autonomous";
}

/**
 * Remove one autonomous session from the queue and from claim provenance.
 * Claims are deleted only when this was their final source. Cascades then remove
 * their entity/claim links; claims with any valid source remain intact.
 */
export async function removeAutonomousSessionSource(
  sourceId: string,
  principal: Principal,
): Promise<{ queueRows: number; sourceRefs: number; orphanClaims: number }> {
  const refs = await db
    .select({ id: memoryVnextSourceRefs.id, claimId: memoryVnextSourceRefs.claimId })
    .from(memoryVnextSourceRefs)
    .where(
      combineWithVisibleScope(
        principal,
        sourceRefScopeColumns,
        and(
          eq(memoryVnextSourceRefs.sourceType, "session"),
          eq(memoryVnextSourceRefs.sourceId, sourceId),
        ),
      ),
    );

  const deletedRefs = await db
    .delete(memoryVnextSourceRefs)
    .where(
      combineWithWritableScope(
        principal,
        sourceRefScopeColumns,
        and(
          eq(memoryVnextSourceRefs.sourceType, "session"),
          eq(memoryVnextSourceRefs.sourceId, sourceId),
        ),
      ),
    )
    .returning({ id: memoryVnextSourceRefs.id });

  const deletedQueue = await db
    .delete(memoryVnextSourceQueue)
    .where(
      combineWithWritableScope(
        principal,
        scopeColumns,
        and(
          eq(memoryVnextSourceQueue.sourceType, "session"),
          eq(memoryVnextSourceQueue.sourceId, sourceId),
        ),
      ),
    )
    .returning({ id: memoryVnextSourceQueue.id });

  let orphanClaims = 0;
  const claimIds = [...new Set(refs.map((ref) => ref.claimId))];
  if (claimIds.length > 0) {
    const deletedClaims = await db
      .delete(memoryVnextClaims)
      .where(
        combineWithWritableScope(
          principal,
          claimScopeColumns,
          and(
            inArray(memoryVnextClaims.id, claimIds),
            sql`NOT EXISTS (
              SELECT 1 FROM ${memoryVnextSourceRefs}
              WHERE ${memoryVnextSourceRefs.claimId} = ${memoryVnextClaims.id}
            )`,
          ),
        ),
      )
      .returning({ id: memoryVnextClaims.id });
    orphanClaims = deletedClaims.length;
  }

  if (deletedQueue.length || deletedRefs.length || orphanClaims) {
    log.info(
      `removed autonomous session source=${sourceId} queueRows=${deletedQueue.length} sourceRefs=${deletedRefs.length} orphanClaims=${orphanClaims}`,
    );
  }
  return { queueRows: deletedQueue.length, sourceRefs: deletedRefs.length, orphanClaims };
}

/**
 * Bounded maintenance for legacy autonomous session rows. Ownership from each
 * queue row is restored before session lookup and cleanup. Completed rows are
 * included, so the migration converges rather than relying on re-enqueue.
 */
export async function cleanupAutonomousSessionSources(
  limit = 100,
): Promise<{ scanned: number; removed: number }> {
  const rows = await db
    .select()
    .from(memoryVnextSourceQueue)
    .where(eq(memoryVnextSourceQueue.sourceType, "session"))
    .orderBy(memoryVnextSourceQueue.id)
    .limit(Math.max(1, Math.min(limit, 500)));

  let removed = 0;
  for (const row of rows) {
    if (!row.ownerUserId) {
      log.warn(`cleanup skipped queueId=${row.id} reason=missing_owner`);
      continue;
    }
    const principal: Principal = {
      actorType: "user",
      userId: row.ownerUserId,
      accountId: row.accountId,
      role: "owner",
      scopes: ["user:read", "user:write"],
      permissions: [],
      isAdmin: false,
      impersonation: {
        impersonatedByActorType: "system",
        reason: "vnext autonomous source cleanup",
      },
      source: "system",
    };
    await runWithPrincipal(principal, async () => {
      if (!await isAutonomousSessionSource(row.sourceId)) return;
      await removeAutonomousSessionSource(row.sourceId, principal);
      removed++;
    });
  }
  return { scanned: rows.length, removed };
}

/**
 * Upsert a source into the extraction queue.
 * If the source already exists, bumps last_modified_at and resets status to 'pending'.
 * This is the debounce mechanism: rapid edits keep bumping the timestamp,
 * and the poller only picks up sources that have been quiet for the settle period.
 */
export async function upsertSource(
  sourceType: VnextSourceType,
  sourceId: string,
  principal: Principal,
): Promise<void> {
  if (sourceType === "session" && await isAutonomousSessionSource(sourceId)) {
    await removeAutonomousSessionSource(sourceId, principal);
    log.debug(`skipped autonomous session source=${sourceId}`);
    return;
  }

  const ownership = ownedInsertValues(principal, scopeColumns);

  await db
    .insert(memoryVnextSourceQueue)
    .values({
      sourceType,
      sourceId,
      status: "pending",
      lastModifiedAt: new Date(),
      ownerUserId: ownership.ownerUserId,
      accountId: ownership.accountId,
    })
    .onConflictDoUpdate({
      target: [
        memoryVnextSourceQueue.sourceType,
        memoryVnextSourceQueue.sourceId,
        memoryVnextSourceQueue.ownerUserId,
      ],
      set: {
        lastModifiedAt: new Date(),
        status: "pending",
      },
    });

  log.debug(
    `upserted source=${sourceType}:${sourceId} owner=${ownership.ownerUserId}`,
  );
}

/**
 * Find sources that have been pending long enough to be considered settled.
 * A source is settled when its last_modified_at is older than the settle threshold,
 * meaning no new edits have come in during the quiet period.
 */
export async function pollSettledSources(
  settleMinutes: number,
  limit: number,
): Promise<MemoryVnextSourceQueueRow[]> {
  const settleThreshold = sql`NOW() - INTERVAL '${sql.raw(String(settleMinutes))} minutes'`;

  const rows = await db
    .select()
    .from(memoryVnextSourceQueue)
    .where(
      and(
        eq(memoryVnextSourceQueue.status, "pending"),
        lt(memoryVnextSourceQueue.lastModifiedAt, settleThreshold),
      ),
    )
    .orderBy(memoryVnextSourceQueue.lastModifiedAt)
    .limit(limit);

  log.debug(
    `polled settleMinutes=${settleMinutes} limit=${limit} found=${rows.length}`,
  );
  return rows;
}

/**
 * Mark a source as processing to prevent concurrent extraction.
 */
export async function markProcessing(id: number): Promise<void> {
  await db
    .update(memoryVnextSourceQueue)
    .set({ status: "processing" })
    .where(eq(memoryVnextSourceQueue.id, id));

  log.debug(`marked processing id=${id}`);
}

/**
 * Mark a source as completed after successful extraction.
 * Records the content hash for change detection on future edits.
 */
export async function markCompleted(
  id: number,
  contentHash: string,
): Promise<void> {
  await db
    .update(memoryVnextSourceQueue)
    .set({
      status: "completed",
      lastExtractedAt: new Date(),
      contentHash,
    })
    .where(eq(memoryVnextSourceQueue.id, id));

  log.debug(`marked completed id=${id} hash=${contentHash.slice(0, 8)}...`);
}

/**
 * Diagnostic: get queue status counts grouped by status.
 */
export async function getQueueStatus(): Promise<{
  pending: number;
  processing: number;
  completed: number;
  total: number;
}> {
  const rows = await db
    .select({
      status: memoryVnextSourceQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(memoryVnextSourceQueue)
    .groupBy(memoryVnextSourceQueue.status);

  const counts = { pending: 0, processing: 0, completed: 0, total: 0 };
  for (const row of rows) {
    const s = row.status as keyof typeof counts;
    if (s in counts) counts[s] = row.count;
    counts.total += row.count;
  }
  return counts;
}

/**
 * Get a single queue entry by source type and source ID for a given principal.
 */
export async function getBySource(
  sourceType: VnextSourceType,
  sourceId: string,
  principal: Principal,
): Promise<MemoryVnextSourceQueueRow | undefined> {
  const rows = await db
    .select()
    .from(memoryVnextSourceQueue)
    .where(
      combineWithVisibleScope(
        principal,
        scopeColumns,
        and(
          eq(memoryVnextSourceQueue.sourceType, sourceType),
          eq(memoryVnextSourceQueue.sourceId, sourceId),
        ),
      ),
    )
    .limit(1);

  return rows[0];
}


/**
 * List source queue entries visible to the current principal. Used by the
 * Layers page to render vNext Stage 0: source intake before claim extraction.
 */
export async function listVisibleSources(
  principal: Principal,
  options: { status?: string; limit?: number } = {},
): Promise<MemoryVnextSourceQueueRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const statusFilter = options.status ? eq(memoryVnextSourceQueue.status, options.status) : undefined;
  return db
    .select()
    .from(memoryVnextSourceQueue)
    .where(combineWithVisibleScope(principal, scopeColumns, statusFilter))
    .orderBy(desc(memoryVnextSourceQueue.lastModifiedAt))
    .limit(limit);
}

/**
 * Reset a stuck "processing" row back to "pending" (recovery from crashes).
 * Only resets rows that have been processing longer than the given timeout.
 */
export async function resetStuckProcessing(
  timeoutMinutes: number,
): Promise<number> {
  const threshold = sql`NOW() - INTERVAL '${sql.raw(String(timeoutMinutes))} minutes'`;

  const result = await db
    .update(memoryVnextSourceQueue)
    .set({
      status: "pending",
      lastModifiedAt: new Date(),
    })
    .where(
      and(
        eq(memoryVnextSourceQueue.status, "processing"),
        lt(memoryVnextSourceQueue.lastModifiedAt, threshold),
      ),
    )
    .returning({ id: memoryVnextSourceQueue.id });

  if (result.length > 0) {
    log.warn(
      `reset ${result.length} stuck processing rows (timeout=${timeoutMinutes}min)`,
    );
  }
  return result.length;
}
