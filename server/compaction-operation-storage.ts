import { randomUUID } from "crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  compactionOperations,
  indexedContent,
  type CompactionOperation,
  type CompactionOperationStatus,
} from "@shared/schema";
import {
  ADVISORY_LOCK_NS,
  acquireAdvisoryTransactionLock,
  BOOT_ID,
  db,
} from "./db";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import type { CompactionSnapshot } from "./compaction-snapshot";
import { createLogger } from "./log";

const log = createLogger("CompactionOperations");

export const COMPACTION_LEASE_MS = 5 * 60_000;
const RECONCILIATION_RETENTION_MS = 24 * 60 * 60_000;
const RECONCILIATION_BATCH_SIZE = 25;
const ACTIVE_STATUSES: CompactionOperationStatus[] = [
  "claimed",
  "archiving",
  "summarizing",
  "ready",
];

// Operation queries always combine owner and account identity.

function ownerIdentity(): { ownerUserId: string; accountId: string; vaultId: string | null } {
  const principal = getCurrentPrincipalOrSystem();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Compaction requires an explicit user and account principal");
  }
  return {
    ownerUserId: principal.userId,
    accountId: principal.accountId,
    vaultId: principal.activeVaultId,
  };
}

function ownedPredicate(owner: ReturnType<typeof ownerIdentity>) {
  return and(
    eq(compactionOperations.ownerUserId, owner.ownerUserId),
    eq(compactionOperations.accountId, owner.accountId),
  );
}

export type CompactionClaim =
  | { outcome: "claimed"; operation: CompactionOperation; reclaimed: boolean }
  | { outcome: "joined"; operation: CompactionOperation };

export async function claimCompactionOperation(input: {
  snapshot: CompactionSnapshot;
  callerGeneration?: number;
}): Promise<CompactionClaim> {
  const owner = ownerIdentity();
  return db.transaction(async (transaction) => {
    await acquireAdvisoryTransactionLock(
      transaction,
      ADVISORY_LOCK_NS.COMPACTION_OPERATION,
      `${owner.ownerUserId}:${owner.accountId}:${input.snapshot.sessionId}`,
    );
    const [active] = await transaction
      .select()
      .from(compactionOperations)
      .where(
        and(
          ownedPredicate(owner),
          eq(compactionOperations.sessionId, input.snapshot.sessionId),
          inArray(compactionOperations.status, ACTIVE_STATUSES),
        ),
      )
      .orderBy(asc(compactionOperations.createdAt))
      .limit(1);
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + COMPACTION_LEASE_MS);
    // The active row owns work even when this caller shares its process.
    // Same-boot callers join; process death is represented by lease expiry.
    if (active && active.leaseExpiresAt.getTime() > now.getTime()) {
      log.info("compaction.lifecycle", {
        transition: "joined",
        operationId: active.id,
        sessionId: active.sessionId,
        snapshotHash: active.snapshotHash,
        ownerBootId: active.ownerBootId,
        callerGeneration: input.callerGeneration,
      });
      return { outcome: "joined", operation: active };
    }
    if (active && active.snapshotHash !== input.snapshot.snapshotHash) {
      await transaction
        .update(compactionOperations)
        .set({
          status: "superseded",
          outcome: "snapshot_changed",
          failureReason: "stale_operation_snapshot_changed",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(compactionOperations.id, active.id),
            ownedPredicate(owner),
            lt(compactionOperations.leaseExpiresAt, now),
          ),
        );
    } else if (active) {
      const [reclaimed] = await transaction
        .update(compactionOperations)
        .set({
          ownerBootId: BOOT_ID,
          callerGeneration: input.callerGeneration,
          leaseExpiresAt,
          heartbeatAt: now,
          attemptCount: sql`${compactionOperations.attemptCount} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(compactionOperations.id, active.id),
            ownedPredicate(owner),
            lt(compactionOperations.leaseExpiresAt, now),
          ),
        )
        .returning();
      if (!reclaimed) return { outcome: "joined", operation: active };
      log.warn("compaction.lifecycle", {
        transition: "reclaimed",
        operationId: reclaimed.id,
        sessionId: reclaimed.sessionId,
        snapshotHash: reclaimed.snapshotHash,
        ownerBootId: BOOT_ID,
        attemptCount: reclaimed.attemptCount,
      });
      return { outcome: "claimed", operation: reclaimed, reclaimed: true };
    }

    const [existingSnapshot] = await transaction
      .select()
      .from(compactionOperations)
      .where(
        and(
          ownedPredicate(owner),
          eq(compactionOperations.sessionId, input.snapshot.sessionId),
          eq(compactionOperations.snapshotHash, input.snapshot.snapshotHash),
        ),
      )
      .limit(1);
    if (existingSnapshot) {
      if (existingSnapshot.status === "failed") {
        const [retried] = await transaction
          .update(compactionOperations)
          .set({
            status: "claimed",
            ownerBootId: BOOT_ID,
            callerGeneration: input.callerGeneration,
            leaseExpiresAt,
            heartbeatAt: now,
            outcome: null,
            failureReason: null,
            completedAt: null,
            attemptCount: sql`${compactionOperations.attemptCount} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(compactionOperations.id, existingSnapshot.id),
              ownedPredicate(owner),
              eq(compactionOperations.status, "failed"),
            ),
          )
          .returning();
        if (!retried) return { outcome: "joined", operation: existingSnapshot };
        log.info("compaction.lifecycle", {
          transition: "retried",
          operationId: retried.id,
          sessionId: retried.sessionId,
          snapshotHash: retried.snapshotHash,
          ownerBootId: BOOT_ID,
          attemptCount: retried.attemptCount,
        });
        return { outcome: "claimed", operation: retried, reclaimed: true };
      }
      if (
        existingSnapshot.status === "committed" ||
        existingSnapshot.status === "superseded"
      ) {
        return { outcome: "joined", operation: existingSnapshot };
      }
      throw new Error(
        `Compaction snapshot ${existingSnapshot.id} remained active without the active-session claim`,
      );
    }

    const [created] = await transaction
      .insert(compactionOperations)
      .values({
        id: randomUUID(),
        scope: "user",
        ...owner,
        sessionId: input.snapshot.sessionId,
        snapshotHash: input.snapshot.snapshotHash,
        boundaryHash: input.snapshot.boundaryHash,
        lastRemovedMessageId: input.snapshot.lastRemovedMessageId,
        removedMessageIds: [...input.snapshot.removedMessageIds],
        keptMessageIds: [...input.snapshot.keptMessageIds],
        status: "claimed",
        ownerBootId: BOOT_ID,
        callerGeneration: input.callerGeneration,
        leaseExpiresAt,
        heartbeatAt: now,
      })
      .returning();
    log.info("compaction.lifecycle", {
      transition: "claimed",
      operationId: created.id,
      sessionId: created.sessionId,
      snapshotHash: created.snapshotHash,
      ownerBootId: BOOT_ID,
      callerGeneration: input.callerGeneration,
    });
    return { outcome: "claimed", operation: created, reclaimed: false };
  });
}

export async function transitionCompactionOperation(
  operationId: string,
  status: CompactionOperationStatus,
  patch: Partial<{
    archiveRefId: string | null;
    archiveObjectPath: string | null;
    markerId: string | null;
    summaryKind: string | null;
    summaryMetadata: Record<string, unknown>;
    segmentCount: number | null;
    modelCallCount: number;
    inputTokens: number;
    archiveBytes: number | null;
    outcome: string | null;
    failureReason: string | null;
  }> = {},
): Promise<CompactionOperation | null> {
  const owner = ownerIdentity();
  const now = new Date();
  const terminal = status === "committed" || status === "superseded" || status === "failed";
  const [operation] = await db
    .update(compactionOperations)
    .set({
      status,
      ...patch,
      ownerBootId: BOOT_ID,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + COMPACTION_LEASE_MS),
      updatedAt: now,
      completedAt: terminal ? now : null,
    })
    .where(
      and(
        eq(compactionOperations.id, operationId),
        ownedPredicate(owner),
      ),
    )
    .returning();
  if (operation) {
    log.info("compaction.lifecycle", {
      transition: status,
      operationId,
      sessionId: operation.sessionId,
      snapshotHash: operation.snapshotHash,
      ownerBootId: BOOT_ID,
      outcome: operation.outcome,
      archiveBytes: operation.archiveBytes,
      segmentCount: operation.segmentCount,
      modelCallCount: operation.modelCallCount,
      inputTokens: operation.inputTokens,
      failureReason: operation.failureReason,
    });
  }
  return operation ?? null;
}

export async function waitForCompactionOperation(
  operationId: string,
  maxWaitMs: number,
): Promise<CompactionOperation> {
  const owner = ownerIdentity();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const [operation] = await db
      .select()
      .from(compactionOperations)
      .where(
        and(
          eq(compactionOperations.id, operationId),
          ownedPredicate(owner),
        ),
      )
      .limit(1);
    if (!operation) throw new Error(`Compaction operation unavailable: ${operationId}`);
    if (!ACTIVE_STATUSES.includes(operation.status)) return operation;
    if (operation.leaseExpiresAt.getTime() <= Date.now()) return operation;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Compaction join timed out after ${maxWaitMs}ms`);
}

export async function reconcileAbandonedCompactions(): Promise<{
  inspected: number;
  failed: number;
  archivesDeleted: number;
}> {
  const cutoff = new Date(Date.now() - RECONCILIATION_RETENTION_MS);
  const abandoned = await db
    .select()
    .from(compactionOperations)
    .where(
      and(
        lt(compactionOperations.updatedAt, cutoff),
        isNull(compactionOperations.markerId),
        or(
          and(
            inArray(compactionOperations.status, ACTIVE_STATUSES),
            lt(compactionOperations.leaseExpiresAt, cutoff),
          ),
          and(
            inArray(compactionOperations.status, ["failed", "superseded"]),
            sql`${compactionOperations.archiveObjectPath} IS NOT NULL`,
          ),
        ),
      ),
    )
    .orderBy(asc(compactionOperations.leaseExpiresAt))
    .limit(RECONCILIATION_BATCH_SIZE);
  let archivesDeleted = 0;
  for (const operation of abandoned) {
    await db.transaction(async (transaction) => {
      await acquireAdvisoryTransactionLock(
        transaction,
        ADVISORY_LOCK_NS.COMPACTION_OPERATION,
        `${operation.ownerUserId}:${operation.accountId}:${operation.sessionId}`,
      );
      const updated = await transaction
        .update(compactionOperations)
        .set({
          status: "failed",
          outcome: operation.outcome ?? "failed",
          failureReason:
            operation.failureReason ?? "stale_operation_reconciled",
          completedAt: operation.completedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(compactionOperations.id, operation.id),
            eq(compactionOperations.ownerUserId, operation.ownerUserId),
            eq(compactionOperations.accountId, operation.accountId),
            isNull(compactionOperations.markerId),
          ),
        )
        .returning({ archiveObjectPath: compactionOperations.archiveObjectPath });
      if (!updated[0]) return;
      if (operation.archiveRefId) {
        await transaction
          .delete(indexedContent)
          .where(
            and(
              eq(indexedContent.id, operation.archiveRefId),
              eq(indexedContent.ownerUserId, operation.ownerUserId),
              eq(indexedContent.principalAccountId, operation.accountId),
            ),
          );
      }
    });
    if (operation.archiveObjectPath) {
      try {
        const { deleteCompactionArchiveObject } = await import("./content-indexer");
        await deleteCompactionArchiveObject(operation.archiveObjectPath, operation.vaultId);
        await db
          .update(compactionOperations)
          .set({
            archiveRefId: null,
            archiveObjectPath: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(compactionOperations.id, operation.id),
              eq(compactionOperations.ownerUserId, operation.ownerUserId),
              eq(compactionOperations.accountId, operation.accountId),
              isNull(compactionOperations.markerId),
            ),
          );
        archivesDeleted += 1;
      } catch (error) {
        log.warn("compaction.lifecycle", {
          transition: "orphan_cleanup_failed",
          operationId: operation.id,
          sessionId: operation.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (abandoned.length > 0) {
    log.warn("compaction.lifecycle", {
      transition: "reconciled",
      inspected: abandoned.length,
      failed: abandoned.length,
      archivesDeleted,
    });
  }
  return { inspected: abandoned.length, failed: abandoned.length, archivesDeleted };
}
