import { and, eq, lt, sql, desc } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import {
  memoryVnextSourceQueue,
  type VnextSourceType,
  type MemoryVnextSourceQueueRow,
} from "@shared/schema";

const log = createLogger("VnextSourceQueue");

const scopeColumns = {
  ownerUserId: memoryVnextSourceQueue.ownerUserId,
  accountId: memoryVnextSourceQueue.accountId,
};

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
