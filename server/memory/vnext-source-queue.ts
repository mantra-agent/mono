import { and, eq, lt, sql, desc, inArray, isNull, or } from "drizzle-orm";
import { db, runWithDatabaseTransaction } from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { tryResolveUserIdentityFoundation } from "../principal";
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
  instanceId: memoryVnextSourceRefs.instanceId,
};

const claimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
  instanceId: memoryVnextClaims.instanceId,
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
 * Remove Library-page sources from the vNext pipeline when their pages are
 * permanently hard-deleted. Deletes queue rows and claim provenance for
 * source_type='library_page'; claims are deleted only when this removes their
 * final source (cascades entity/claim links). Mirrors
 * removeAutonomousSessionSource, batched across many pages so it serves both
 * user-triggered Empty Trash and the nightly auto-purge. Writable scope means a
 * user principal only clears their own provenance, while a system principal
 * (nightly auto-purge) spans all owners.
 */
export async function removeLibraryPageSources(
  pageIds: string[],
  principal: Principal,
): Promise<{ queueRows: number; sourceRefs: number; orphanClaims: number }> {
  const ids = [...new Set(pageIds)].filter(Boolean);
  if (ids.length === 0) return { queueRows: 0, sourceRefs: 0, orphanClaims: 0 };

  const BATCH = 500;
  let queueRows = 0;
  let sourceRefs = 0;
  let orphanClaims = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);

    const refs = await db
      .select({
        id: memoryVnextSourceRefs.id,
        claimId: memoryVnextSourceRefs.claimId,
      })
      .from(memoryVnextSourceRefs)
      .where(
        combineWithVisibleScope(
          principal,
          sourceRefScopeColumns,
          and(
            eq(memoryVnextSourceRefs.sourceType, "library_page"),
            inArray(memoryVnextSourceRefs.sourceId, batch),
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
            eq(memoryVnextSourceRefs.sourceType, "library_page"),
            inArray(memoryVnextSourceRefs.sourceId, batch),
          ),
        ),
      )
      .returning({ id: memoryVnextSourceRefs.id });
    sourceRefs += deletedRefs.length;

    const deletedQueue = await db
      .delete(memoryVnextSourceQueue)
      .where(
        combineWithWritableScope(
          principal,
          scopeColumns,
          and(
            eq(memoryVnextSourceQueue.sourceType, "library_page"),
            inArray(memoryVnextSourceQueue.sourceId, batch),
          ),
        ),
      )
      .returning({ id: memoryVnextSourceQueue.id });
    queueRows += deletedQueue.length;

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
      orphanClaims += deletedClaims.length;
    }
  }

  if (queueRows || sourceRefs || orphanClaims) {
    log.info(
      `removed library_page sources pages=${ids.length} queueRows=${queueRows} sourceRefs=${sourceRefs} orphanClaims=${orphanClaims}`,
    );
  }
  return { queueRows, sourceRefs, orphanClaims };
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
    const foundation = await tryResolveUserIdentityFoundation(row.ownerUserId);
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
      visibleVaultIds: foundation?.visibleVaultIds ?? [],
      activeVaultId: foundation?.activeVaultId ?? null,
      instanceId:
        foundation?.accountId === row.accountId ? foundation.instanceId : null,
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
 * Mark a source as changed in the extraction queue.
 * If the source already exists, bumps last_modified_at and resets status to 'pending'.
 * This is the debounce mechanism: rapid edits keep bumping the timestamp,
 * and the poller only picks up sources that have been quiet for the settle period.
 */
export async function markSourceChanged(
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
        runtimeRunId: null,
        runtimeSourceVersion: null,
        runtimeAttemptId: null,
        runtimeLeaseEpoch: null,
      },
    });

  log.debug(
    `marked source changed=${sourceType}:${sourceId} owner=${ownership.ownerUserId}`,
  );
}

/**
 * Register a source for extraction without invalidating an existing queue row.
 * Full reads use this path so observing unchanged content is replay-safe.
 */
export async function registerSourceIfAbsent(
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

  const inserted = await db
    .insert(memoryVnextSourceQueue)
    .values({
      sourceType,
      sourceId,
      status: "pending",
      lastModifiedAt: new Date(),
      ownerUserId: ownership.ownerUserId,
      accountId: ownership.accountId,
    })
    .onConflictDoNothing()
    .returning({ id: memoryVnextSourceQueue.id });

  if (inserted.length > 0) {
    log.debug(
      `registered source=${sourceType}:${sourceId} owner=${ownership.ownerUserId}`,
    );
  }
}

/**
 * Atomically select one settled source version, enqueue its idempotent Runtime
 * Run through the restored owner principal, and bind that Run to the queue row.
 * The row lock is held only across bounded database work; extraction remains in
 * the Runtime handler outside this transaction. SKIP LOCKED distributes intake
 * across replicas without creating a second lease beside Runtime.
 */
export async function bindNextSettledSourceRuntime(
  settleMinutes: number,
  enqueue: (row: MemoryVnextSourceQueueRow) => Promise<{ runId: string; disposition: "created" | "existing" }>,
): Promise<{ row: MemoryVnextSourceQueueRow; disposition: "created" | "existing" } | null> {
  const boundedSettleMinutes = Math.max(1, Math.min(Math.floor(settleMinutes), 24 * 60));
  const settleThreshold = sql`NOW() - INTERVAL '${sql.raw(String(boundedSettleMinutes))} minutes'`;

  return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const [row] = await tx
      .select()
      .from(memoryVnextSourceQueue)
      .where(and(
        eq(memoryVnextSourceQueue.status, "pending"),
        isNull(memoryVnextSourceQueue.runtimeRunId),
        lt(memoryVnextSourceQueue.lastModifiedAt, settleThreshold),
      ))
      .orderBy(memoryVnextSourceQueue.lastModifiedAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;

    const result = await enqueue(row);
    const [bound] = await tx
      .update(memoryVnextSourceQueue)
      .set({ runtimeRunId: result.runId, runtimeSourceVersion: row.lastModifiedAt })
      .where(and(
        eq(memoryVnextSourceQueue.id, row.id),
        eq(memoryVnextSourceQueue.status, "pending"),
        eq(memoryVnextSourceQueue.lastModifiedAt, row.lastModifiedAt),
        isNull(memoryVnextSourceQueue.runtimeRunId),
        eq(memoryVnextSourceQueue.ownerUserId, row.ownerUserId),
        eq(memoryVnextSourceQueue.accountId, row.accountId),
      ))
      .returning();
    if (!bound) {
      throw Object.assign(new Error("Memory source version changed before Runtime binding"), {
        code: "source_version_changed",
      });
    }
    return { row: bound, disposition: result.disposition };
  }));
}

/** Claim domain processing only with the current native Runtime fence. */
export async function claimSourceForRuntime(
  id: number,
  sourceVersion: Date,
  fence: { runId: string; attemptId: string; leaseEpoch: number },
  principal: Principal,
): Promise<MemoryVnextSourceQueueRow | null> {
  const [row] = await db
    .update(memoryVnextSourceQueue)
    .set({
      status: "processing",
      runtimeAttemptId: fence.attemptId,
      runtimeLeaseEpoch: fence.leaseEpoch,
    })
    .where(
      combineWithWritableScope(
        principal,
        scopeColumns,
        and(
          eq(memoryVnextSourceQueue.id, id),
          eq(memoryVnextSourceQueue.lastModifiedAt, sourceVersion),
          eq(memoryVnextSourceQueue.runtimeRunId, fence.runId),
          or(
            and(
              eq(memoryVnextSourceQueue.status, "pending"),
              isNull(memoryVnextSourceQueue.runtimeAttemptId),
              isNull(memoryVnextSourceQueue.runtimeLeaseEpoch),
            ),
            and(
              eq(memoryVnextSourceQueue.status, "processing"),
              sql`EXISTS (
                SELECT 1
                FROM runtime_attempts AS previous_attempt
                WHERE previous_attempt.id = ${memoryVnextSourceQueue.runtimeAttemptId}
                  AND previous_attempt.run_id = ${memoryVnextSourceQueue.runtimeRunId}
                  AND previous_attempt.account_id = ${memoryVnextSourceQueue.accountId}
                  AND previous_attempt.lease_epoch = ${memoryVnextSourceQueue.runtimeLeaseEpoch}
                  AND previous_attempt.phase = 'finished'
                  AND previous_attempt.result IN ('retry', 'lost')
              )`,
            ),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Run the canonical claim-graph mutation while holding the exact source-version
 * and Runtime-attempt projection lock. `applyObservation` inherits this ambient
 * transaction, so a source edit cannot slip between fence validation and graph
 * writes.
 */
export async function withSourceRuntimeFence<T>(
  id: number,
  sourceVersion: Date,
  fence: { runId: string; attemptId: string; leaseEpoch: number },
  principal: Principal,
  mutation: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const [row] = await tx
      .select({ id: memoryVnextSourceQueue.id })
      .from(memoryVnextSourceQueue)
      .where(
        combineWithWritableScope(
          principal,
          scopeColumns,
          and(
            eq(memoryVnextSourceQueue.id, id),
            eq(memoryVnextSourceQueue.status, "processing"),
            eq(memoryVnextSourceQueue.lastModifiedAt, sourceVersion),
            eq(memoryVnextSourceQueue.runtimeRunId, fence.runId),
            eq(memoryVnextSourceQueue.runtimeAttemptId, fence.attemptId),
            eq(memoryVnextSourceQueue.runtimeLeaseEpoch, fence.leaseEpoch),
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) {
      throw Object.assign(new Error("Memory source Runtime fence is stale"), { code: "stale_fence" });
    }
    return mutation();
  }));
}

/** Complete one source only while its exact Runtime fence still owns it. */
export async function completeSourceForRuntime(
  id: number,
  sourceVersion: Date,
  fence: { runId: string; attemptId: string; leaseEpoch: number },
  contentHash: string,
  principal: Principal,
): Promise<boolean> {
  const [row] = await db
    .update(memoryVnextSourceQueue)
    .set({
      status: "completed",
      lastExtractedAt: new Date(),
      contentHash,
      runtimeAttemptId: null,
      runtimeLeaseEpoch: null,
    })
    .where(
      combineWithWritableScope(
        principal,
        scopeColumns,
        and(
          eq(memoryVnextSourceQueue.id, id),
          eq(memoryVnextSourceQueue.status, "processing"),
          eq(memoryVnextSourceQueue.lastModifiedAt, sourceVersion),
          eq(memoryVnextSourceQueue.runtimeRunId, fence.runId),
          eq(memoryVnextSourceQueue.runtimeAttemptId, fence.attemptId),
          eq(memoryVnextSourceQueue.runtimeLeaseEpoch, fence.leaseEpoch),
        ),
      ),
    )
    .returning({ id: memoryVnextSourceQueue.id });
  return Boolean(row);
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

/** Get one queue row through the owning principal boundary. */
export async function getSourceQueueRow(
  id: number,
  principal: Principal,
): Promise<MemoryVnextSourceQueueRow | null> {
  const [row] = await db
    .select()
    .from(memoryVnextSourceQueue)
    .where(combineWithVisibleScope(principal, scopeColumns, eq(memoryVnextSourceQueue.id, id)))
    .limit(1);
  return row ?? null;
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
 * Legacy-only recovery for rows created before native Runtime ownership.
 * Runtime-bound rows recover through attempt lease reconciliation and fenced
 * takeover; this maintenance path must never clear a canonical fence.
 */
export async function resetLegacyStuckProcessing(
  timeoutMinutes: number,
): Promise<number> {
  const threshold = sql`NOW() - INTERVAL '${sql.raw(String(timeoutMinutes))} minutes'`;

  const result = await db
    .update(memoryVnextSourceQueue)
    .set({ status: "pending" })
    .where(
      and(
        eq(memoryVnextSourceQueue.status, "processing"),
        isNull(memoryVnextSourceQueue.runtimeRunId),
        isNull(memoryVnextSourceQueue.runtimeAttemptId),
        isNull(memoryVnextSourceQueue.runtimeLeaseEpoch),
        lt(memoryVnextSourceQueue.lastModifiedAt, threshold),
      ),
    )
    .returning({ id: memoryVnextSourceQueue.id });

  if (result.length > 0) {
    log.warn(
      `reset ${result.length} legacy stuck processing rows (timeout=${timeoutMinutes}min)`,
    );
  }
  return result.length;
}
