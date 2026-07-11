/**
 * Controlled migration of legacy private/ objects into the authenticated
 * administrator's Personal vault. Legacy objects and references are preserved.
 */
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import {
  vaultR2MigrationStates,
  vaults,
  type VaultR2MigrationState,
  type VaultR2MigrationStatus,
} from "@shared/schema";
import { storageBackend, PRIVATE_PREFIX, type ListedObject, type ObjectMetadata } from "./s3-backend";
import { legacyKeyToVaultKey } from "./vault-keys";

const log = createLogger("VaultMigration");
const STATE_ID = "legacy-private-to-personal";
const MAX_COPY_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_CONCURRENT = 5;
const PROGRESS_BATCH_SIZE = 25;
const EXCLUDED_PREFIXES = [`${PRIVATE_PREFIX}backups/`, `${PRIVATE_PREFIX}inference/`];

export interface VaultR2MigrationView {
  status: VaultR2MigrationStatus;
  destination: { accountId: string; vaultId: string; name: string } | null;
  counts: {
    scanned: number;
    eligible: number;
    excluded: number;
    oversized: number;
    verified: number;
    copied: number;
    existing: number;
    errors: number;
    unresolved: number;
  };
  analysisFingerprint: string | null;
  lastProcessedKey: string | null;
  lastError: string | null;
  analyzedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

interface MigrationTarget {
  accountId: string;
  vaultId: string;
  name: string;
  adminUserId: string;
}

function requireAdminIdentity(principal: Principal): asserts principal is Principal & {
  userId: string;
  accountId: string;
} {
  if (!principal.userId || !principal.accountId || !principal.permissions.includes("system:write")) {
    throw new Error("Vault migration requires an authenticated administrator account");
  }
}

async function resolveMigrationTarget(principal: Principal): Promise<MigrationTarget> {
  requireAdminIdentity(principal);
  const candidates = await db
    .select({ id: vaults.id, name: vaults.name })
    .from(vaults)
    .where(and(
      eq(vaults.accountId, principal.accountId),
      eq(vaults.isDefault, true),
      eq(vaults.isArchived, false),
    ));

  if (candidates.length !== 1 || candidates[0].name !== "Personal") {
    throw new Error(
      `Expected exactly one active default Personal vault for admin account; found ${candidates.length}`,
    );
  }

  return {
    accountId: principal.accountId,
    vaultId: candidates[0].id,
    name: candidates[0].name,
    adminUserId: principal.userId,
  };
}

async function ensureStateRow(): Promise<VaultR2MigrationState> {
  const [state] = await db
    .insert(vaultR2MigrationStates)
    .values({ id: STATE_ID })
    .onConflictDoNothing()
    .returning();
  if (state) return state;
  const [existing] = await db
    .select()
    .from(vaultR2MigrationStates)
    .where(eq(vaultR2MigrationStates.id, STATE_ID));
  if (!existing) throw new Error("Vault migration state is unavailable");
  return existing;
}

function toView(state: VaultR2MigrationState, targetName: string | null = null): VaultR2MigrationView {
  return {
    status: state.status as VaultR2MigrationStatus,
    destination: state.accountId && state.destinationVaultId
      ? { accountId: state.accountId, vaultId: state.destinationVaultId, name: targetName ?? "Personal" }
      : null,
    counts: {
      scanned: state.scannedCount,
      eligible: state.eligibleCount,
      excluded: state.excludedCount,
      oversized: state.oversizedCount,
      verified: state.verifiedCount,
      copied: state.copiedCount,
      existing: state.existingCount,
      errors: state.errorCount,
      unresolved: state.unresolvedCount,
    },
    analysisFingerprint: state.analysisFingerprint,
    lastProcessedKey: state.lastProcessedKey,
    lastError: state.lastError,
    analyzedAt: state.analyzedAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    updatedAt: state.updatedAt,
  };
}

async function getState(): Promise<VaultR2MigrationState> {
  await ensureStateRow();
  const [state] = await db
    .select()
    .from(vaultR2MigrationStates)
    .where(eq(vaultR2MigrationStates.id, STATE_ID));
  if (!state) throw new Error("Vault migration state is unavailable");
  return state;
}

function isExcluded(key: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function eligibleObjects(objects: ListedObject[]): ListedObject[] {
  return objects.filter((object) => !isExcluded(object.key));
}

function fingerprint(objects: ListedObject[], vaultId: string): string {
  const hash = createHash("sha256");
  hash.update(vaultId);
  for (const object of objects) hash.update(`\n${object.key}:${object.size}`);
  return hash.digest("hex");
}

function normalizeEtag(etag: string | undefined): string | null {
  return etag?.replace(/^"|"$/g, "") || null;
}

function objectsMatch(source: ObjectMetadata, destination: ObjectMetadata): boolean {
  if (source.contentLength !== destination.contentLength) return false;
  const sourceEtag = normalizeEtag(source.etag);
  const destinationEtag = normalizeEtag(destination.etag);
  return Boolean(sourceEtag && destinationEtag && sourceEtag === destinationEtag);
}

async function markFailed(error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(vaultR2MigrationStates)
    .set({ status: "failed", lastError: message, updatedAt: new Date() })
    .where(eq(vaultR2MigrationStates.id, STATE_ID));
  log.error("Vault R2 migration failed", { error: message });
  throw error;
}

export async function getVaultR2MigrationStatus(principal: Principal): Promise<VaultR2MigrationView> {
  requireAdminIdentity(principal);
  return toView(await getState());
}

export async function analyzeVaultR2Migration(principal: Principal): Promise<VaultR2MigrationView> {
  const target = await resolveMigrationTarget(principal);
  await ensureStateRow();
  const claimed = await db
    .update(vaultR2MigrationStates)
    .set({ status: "analyzing", lastError: null, updatedAt: new Date() })
    .where(and(
      eq(vaultR2MigrationStates.id, STATE_ID),
      sql`${vaultR2MigrationStates.status} NOT IN ('analyzing', 'running')`,
    ))
    .returning({ id: vaultR2MigrationStates.id });
  if (claimed.length !== 1) throw new Error("Vault migration is already active");

  try {
    const objects = await storageBackend.listObjects(PRIVATE_PREFIX);
    const eligible = eligibleObjects(objects);
    const excluded = objects.length - eligible.length;
    const oversized = eligible.filter((object) => object.size > MAX_COPY_BYTES).length;
    const now = new Date();
    const [state] = await db
      .update(vaultR2MigrationStates)
      .set({
        status: oversized === 0 ? "ready" : "failed",
        adminUserId: target.adminUserId,
        accountId: target.accountId,
        destinationVaultId: target.vaultId,
        analysisFingerprint: fingerprint(eligible, target.vaultId),
        scannedCount: objects.length,
        eligibleCount: eligible.length,
        excludedCount: excluded,
        oversizedCount: oversized,
        verifiedCount: 0,
        copiedCount: 0,
        existingCount: 0,
        errorCount: 0,
        unresolvedCount: oversized,
        lastProcessedKey: null,
        lastError: oversized > 0
          ? `${oversized} object(s) exceed the 5 GB single-copy limit`
          : null,
        analyzedAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(vaultR2MigrationStates.id, STATE_ID))
      .returning();
    log.info("Vault R2 migration analyzed", {
      accountId: target.accountId,
      destinationVaultId: target.vaultId,
      scanned: objects.length,
      eligible: eligible.length,
      excluded,
      oversized,
    });
    return toView(state, target.name);
  } catch (error) {
    return markFailed(error);
  }
}

interface CopyResult {
  key: string;
  copied: boolean;
  verified: boolean;
  error?: string;
}

async function copyAndVerify(object: ListedObject, vaultId: string): Promise<CopyResult> {
  const destinationKey = legacyKeyToVaultKey(object.key, vaultId);
  const source = await storageBackend.headObject(object.key);
  if (!source) return { key: object.key, copied: false, verified: false, error: "Source object disappeared" };
  if ((source.contentLength ?? object.size) > MAX_COPY_BYTES) {
    return { key: object.key, copied: false, verified: false, error: "Object exceeds the 5 GB copy limit" };
  }

  const existing = await storageBackend.headObject(destinationKey);
  if (existing) {
    if (!objectsMatch(source, existing)) {
      return { key: object.key, copied: false, verified: false, error: "Destination exists but does not match source" };
    }
    return { key: object.key, copied: false, verified: true };
  }

  try {
    await storageBackend.copyObject(object.key, destinationKey, {
      sourceEtag: source.etag,
      destinationIfNoneMatch: true,
    });
  } catch (error) {
    const concurrentDestination = await storageBackend.headObject(destinationKey);
    if (!concurrentDestination || !objectsMatch(source, concurrentDestination)) throw error;
    return { key: object.key, copied: false, verified: true };
  }

  const copied = await storageBackend.headObject(destinationKey);
  if (!copied || !objectsMatch(source, copied)) {
    return { key: object.key, copied: true, verified: false, error: "Copied object failed verification" };
  }
  return { key: object.key, copied: true, verified: true };
}

export async function startVaultR2Migration(principal: Principal): Promise<VaultR2MigrationView> {
  const target = await resolveMigrationTarget(principal);
  const before = await getState();
  if (before.status !== "ready" && before.status !== "failed" && before.status !== "completed") {
    throw new Error("Analyze the migration before starting it");
  }
  if (before.oversizedCount > 0) throw new Error("Migration contains oversized unresolved objects");
  if (before.accountId !== target.accountId || before.destinationVaultId !== target.vaultId) {
    throw new Error("Migration destination changed; analyze again before starting");
  }

  const objects = eligibleObjects(await storageBackend.listObjects(PRIVATE_PREFIX));
  if (fingerprint(objects, target.vaultId) !== before.analysisFingerprint) {
    throw new Error("Legacy object inventory changed; analyze again before starting");
  }

  const claimed = await db
    .update(vaultR2MigrationStates)
    .set({
      status: "running",
      verifiedCount: 0,
      copiedCount: 0,
      existingCount: 0,
      errorCount: 0,
      unresolvedCount: 0,
      lastProcessedKey: null,
      lastError: null,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(vaultR2MigrationStates.id, STATE_ID),
      eq(vaultR2MigrationStates.analysisFingerprint, before.analysisFingerprint),
      eq(vaultR2MigrationStates.status, before.status),
    ))
    .returning({ id: vaultR2MigrationStates.id });
  if (claimed.length !== 1) throw new Error("Vault migration is already active");

  try {
    let copiedCount = 0;
    let existingCount = 0;
    let verifiedCount = 0;
    let errorCount = 0;
    let lastError: string | null = null;
    let lastProcessedKey: string | null = null;

    for (let offset = 0; offset < objects.length; offset += PROGRESS_BATCH_SIZE) {
      const batch = objects.slice(offset, offset + PROGRESS_BATCH_SIZE);
      for (let index = 0; index < batch.length; index += MAX_CONCURRENT) {
        const results = await Promise.all(
          batch.slice(index, index + MAX_CONCURRENT).map(async (object) => {
            try {
              return await copyAndVerify(object, target.vaultId);
            } catch (error) {
              return {
                key: object.key,
                copied: false,
                verified: false,
                error: error instanceof Error ? error.message : String(error),
              } satisfies CopyResult;
            }
          }),
        );
        for (const result of results) {
          lastProcessedKey = result.key;
          if (result.verified) verifiedCount++;
          if (result.copied) copiedCount++;
          if (result.verified && !result.copied) existingCount++;
          if (result.error) {
            errorCount++;
            lastError = `${result.key}: ${result.error}`;
          }
        }
      }
      await db
        .update(vaultR2MigrationStates)
        .set({
          verifiedCount,
          copiedCount,
          existingCount,
          errorCount,
          unresolvedCount: errorCount,
          lastProcessedKey,
          lastError,
          updatedAt: new Date(),
        })
        .where(eq(vaultR2MigrationStates.id, STATE_ID));
    }

    const completed = verifiedCount === objects.length && errorCount === 0;
    const [state] = await db
      .update(vaultR2MigrationStates)
      .set({
        status: completed ? "completed" : "failed",
        verifiedCount,
        copiedCount,
        existingCount,
        errorCount,
        unresolvedCount: objects.length - verifiedCount,
        lastProcessedKey,
        lastError: completed ? null : lastError ?? "Not every eligible object was verified",
        completedAt: completed ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(vaultR2MigrationStates.id, STATE_ID))
      .returning();
    log.info("Vault R2 migration finished", {
      status: state.status,
      eligible: objects.length,
      verified: verifiedCount,
      copied: copiedCount,
      existing: existingCount,
      errors: errorCount,
    });
    return toView(state, target.name);
  } catch (error) {
    return markFailed(error);
  }
}
