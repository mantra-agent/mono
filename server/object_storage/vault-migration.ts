/**
 * Vault R2 Migration Job
 *
 * Copies legacy `private/...` objects to vault-prefixed `vaults/{vaultId}/...` paths.
 * Idempotent: skips objects that already exist at the destination.
 * Does NOT delete legacy copies (migrate-don't-mutate safety).
 *
 * Bound by:
 * - Batch size: processes BATCH_SIZE objects per iteration
 * - Concurrency: MAX_CONCURRENT copies at a time
 * - Total cap: stops after MAX_TOTAL_OBJECTS to bound runtime
 */
import { db } from "../db";
import { objectAcls } from "@shared/schema";
import { storageBackend, PRIVATE_PREFIX } from "./s3-backend";
import { legacyKeyToVaultKey, isVaultKey, VAULT_PREFIX } from "./vault-keys";
import { createLogger } from "../log";
import { sql, isNull, and } from "drizzle-orm";

const log = createLogger("VaultMigration");

const BATCH_SIZE = 100;
const MAX_CONCURRENT = 5;
const MAX_TOTAL_OBJECTS = 10_000;

interface MigrationStats {
  scanned: number;
  copied: number;
  skipped: number;
  errors: number;
  alreadyMigrated: number;
}

/**
 * Resolve the default (personal) vault ID for a given account.
 * Used when an object's ACL has no vault association — defaults to personal vault.
 */
async function getDefaultVaultId(accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const result = await db.execute(sql`
    SELECT id FROM vaults
    WHERE account_id = ${accountId} AND is_default = true
    LIMIT 1
  `);
  const rows = result.rows as Array<{ id: string }>;
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Get the first account's default vault as the system fallback.
 * For objects with no ACL or no account, we need a vault to put them in.
 */
async function getSystemFallbackVaultId(): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM vaults WHERE is_default = true ORDER BY created_at ASC LIMIT 1
  `);
  const rows = result.rows as Array<{ id: string }>;
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Copy a single object from legacy path to vault-prefixed path.
 * Returns true if copied, false if skipped (already exists at destination).
 */
async function copyObjectToVault(
  legacyKey: string,
  vaultId: string,
): Promise<{ copied: boolean; destKey: string }> {
  const destKey = legacyKeyToVaultKey(legacyKey, vaultId);

  // Check if destination already exists (idempotent)
  const destMeta = await storageBackend.headObject(destKey);
  if (destMeta) {
    return { copied: false, destKey };
  }

  // Copy using S3 CopyObject (server-side copy, no data transfer)
  await storageBackend.copyObject(legacyKey, destKey);
  return { copied: true, destKey };
}

/**
 * Process a batch of legacy keys with bounded concurrency.
 */
async function processBatch(
  keys: string[],
  vaultId: string,
  stats: MigrationStats,
): Promise<void> {
  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < keys.length; i += MAX_CONCURRENT) {
    const chunk = keys.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      chunk.map(async (key) => {
        try {
          const result = await copyObjectToVault(key, vaultId);
          if (result.copied) {
            stats.copied++;
            log.debug(`copied ${key} → ${result.destKey}`);
          } else {
            stats.alreadyMigrated++;
          }
        } catch (err) {
          stats.errors++;
          log.warn(`failed to copy ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    // All settled, no need to check results (errors tracked in stats)
  }
}

/**
 * Run the vault R2 migration.
 *
 * Lists legacy `private/` objects, resolves vault ownership from ACL records,
 * and copies them to vault-prefixed paths.
 *
 * Safe to run multiple times. Does not delete legacy objects.
 */
export async function runVaultR2Migration(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    scanned: 0,
    copied: 0,
    skipped: 0,
    errors: 0,
    alreadyMigrated: 0,
  };

  // Get fallback vault for objects without ACL
  const fallbackVaultId = await getSystemFallbackVaultId();
  if (!fallbackVaultId) {
    log.warn("No vaults exist — skipping R2 migration");
    return stats;
  }

  // Build a map of legacy key → vault ID from ACL records
  const aclRows = await db
    .select({
      objectKey: objectAcls.objectKey,
      vaultId: objectAcls.vaultId,
      policy: objectAcls.policy,
    })
    .from(objectAcls)
    .where(
      sql`${objectAcls.objectKey} LIKE 'private/%'`,
    );

  const keyToVaultId = new Map<string, string>();
  for (const row of aclRows) {
    if (row.vaultId) {
      keyToVaultId.set(row.objectKey, row.vaultId);
    } else {
      // Try to resolve from ACL policy's accountId → default vault
      const policy = row.policy as { accountId?: string | null } | null;
      if (policy?.accountId) {
        const vaultId = await getDefaultVaultId(policy.accountId);
        if (vaultId) {
          keyToVaultId.set(row.objectKey, vaultId);
        }
      }
    }
  }

  log.info(`vault R2 migration starting: ${aclRows.length} ACL records mapped, fallback vault=${fallbackVaultId}`);

  // List and process legacy objects in batches
  let continuationToken: string | undefined;
  let totalProcessed = 0;

  // Use listObjects which handles pagination internally
  const allLegacyObjects = await storageBackend.listObjects(PRIVATE_PREFIX, { maxKeys: MAX_TOTAL_OBJECTS });

  for (let batchStart = 0; batchStart < allLegacyObjects.length; batchStart += BATCH_SIZE) {
    const batch = allLegacyObjects.slice(batchStart, batchStart + BATCH_SIZE);
    const keysToMigrate: string[] = [];

    for (const obj of batch) {
      stats.scanned++;

      // Skip objects in system directories that shouldn't be vault-scoped
      if (
        obj.key.startsWith(`${PRIVATE_PREFIX}backups/`) ||
        obj.key.startsWith(`${PRIVATE_PREFIX}inference/`)
      ) {
        stats.skipped++;
        continue;
      }

      keysToMigrate.push(obj.key);
    }

    if (keysToMigrate.length > 0) {
      // Resolve vault IDs for this batch
      const batchByVault = new Map<string, string[]>();
      for (const key of keysToMigrate) {
        const vaultId = keyToVaultId.get(key) ?? fallbackVaultId;
        if (!batchByVault.has(vaultId)) {
          batchByVault.set(vaultId, []);
        }
        batchByVault.get(vaultId)!.push(key);
      }

      for (const [vaultId, keys] of batchByVault) {
        await processBatch(keys, vaultId, stats);
      }
    }

    totalProcessed += batch.length;
    if (totalProcessed >= MAX_TOTAL_OBJECTS) {
      log.info(`vault R2 migration: reached MAX_TOTAL_OBJECTS cap (${MAX_TOTAL_OBJECTS}), stopping`);
      break;
    }
  }

  log.info(
    `vault R2 migration complete: scanned=${stats.scanned} copied=${stats.copied} ` +
    `alreadyMigrated=${stats.alreadyMigrated} skipped=${stats.skipped} errors=${stats.errors}`,
  );
  return stats;
}
