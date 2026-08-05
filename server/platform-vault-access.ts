import { and, eq, inArray, type SQL } from "drizzle-orm";
import { platforms, vaults } from "@shared/schema";
import { db, pool } from "./db";
import type { Principal } from "./principal";
import { requireCurrentPrincipal } from "./principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
} from "./scoped-storage";

const platformScopeColumns = {
  scope: platforms.scope,
  ownerUserId: platforms.ownerUserId,
  accountId: platforms.accountId,
};

export async function ensurePlatformVaultMembershipSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE platforms
        ADD COLUMN IF NOT EXISTS vault_id text;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'platforms_vault_id_vaults_id_fk'
        ) THEN
          ALTER TABLE platforms
            ADD CONSTRAINT platforms_vault_id_vaults_id_fk
            FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platforms_vault ON platforms (vault_id);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_vault_memberships (
        id serial PRIMARY KEY,
        platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        vault_id text NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
        scope text NOT NULL DEFAULT 'user',
        owner_user_id varchar,
        account_id varchar,
        created_by_user_id varchar,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT platform_vault_memberships_platform_vault_unique UNIQUE (platform_id, vault_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_vault_memberships_platform
        ON platform_vault_memberships (platform_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_vault_memberships_vault_platform
        ON platform_vault_memberships (vault_id, platform_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_vault_memberships_scope_owner
        ON platform_vault_memberships (scope, owner_user_id, account_id);
    `);
    await client.query(`
      UPDATE platforms p
      SET vault_id = v.id
      FROM vaults v
      WHERE p.vault_id IS NULL
        AND p.account_id IS NOT NULL
        AND v.account_id = p.account_id
        AND v.is_default = true
        AND v.is_archived = false;
    `);
    await client.query(`
      UPDATE platforms p
      SET vault_id = v.vault_id
      FROM (
        SELECT DISTINCT ON (account_id)
          account_id,
          id AS vault_id
        FROM vaults
        WHERE is_archived = false
        ORDER BY
          account_id,
          CASE WHEN is_default = true THEN 0 ELSE 1 END,
          position ASC NULLS LAST,
          created_at ASC
      ) v
      WHERE p.vault_id IS NULL
        AND p.account_id IS NOT NULL
        AND v.account_id = p.account_id;
    `);
    await client.query(`
      INSERT INTO platform_vault_memberships (
        platform_id,
        vault_id,
        scope,
        owner_user_id,
        account_id,
        created_by_user_id
      )
      SELECT
        p.id,
        p.vault_id,
        COALESCE(p.scope, 'user'),
        p.owner_user_id,
        p.account_id,
        p.owner_user_id
      FROM platforms p
      WHERE p.vault_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM platform_vault_memberships m
          WHERE m.platform_id = p.id
        )
      ON CONFLICT (platform_id, vault_id) DO NOTHING;
    `);
    await client.query(`
      COMMENT ON COLUMN platforms.vault_id IS
        'Migration-compatible primary/default Vault; platform_vault_memberships owns Platform visibility.';
    `);
  } finally {
    client.release();
  }
}

// Single-vault visibility: a Platform is visible when its sole owning Vault
// (platforms.vault_id) is currently visible to the principal. The legacy
// platform_vault_memberships join table is no longer consulted — a Platform
// belongs to exactly one Vault.
function visiblePlatformVaultPredicate(principal: Principal): SQL {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId ||
    principal.visibleVaultIds.length === 0
  ) {
    return eq(platforms.id, -1);
  }
  return inArray(platforms.vaultId, principal.visibleVaultIds);
}

export function visiblePlatform(predicate?: SQL): SQL {
  const principal = requireCurrentPrincipal();
  const ownership = combineWithVisibleScope(principal, platformScopeColumns, predicate);
  return and(ownership, visiblePlatformVaultPredicate(principal))!;
}

export function writablePlatform(predicate?: SQL): SQL {
  const principal = requireCurrentPrincipal();
  return combineWithWritableScope(principal, platformScopeColumns, predicate);
}

export function canManagePlatformVaults(
  principal: Principal,
  platform: {
    ownerUserId: string | null;
    accountId: string | null;
    scope: string | null;
    vaultId?: string | null;
  },
): boolean {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    return false;
  }
  if (platform.scope === "global") return false;
  if (platform.ownerUserId !== principal.userId || platform.accountId !== principal.accountId) {
    return false;
  }
  return !!platform.vaultId && principal.visibleVaultIds.includes(platform.vaultId);
}

export async function loadVaultIdsByPlatformIds(
  principal: Principal,
  platformIds: number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (platformIds.length === 0) return result;

  const rows = await db
    .select({ platformId: platforms.id, vaultId: platforms.vaultId })
    .from(platforms)
    .where(inArray(platforms.id, platformIds));

  for (const row of rows) {
    result.set(row.platformId, row.vaultId ? [row.vaultId] : []);
  }

  for (const platformId of platformIds) {
    if (!result.has(platformId)) result.set(platformId, []);
  }
  return result;
}

export function resolveCreationVaultId(explicitVaultId?: string): string {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Platform creation requires an authenticated user account");
  }
  const vaultId = explicitVaultId?.trim() || principal.activeVaultId;
  if (!vaultId) throw new Error("Platform creation requires an active or explicit vault");
  if (!principal.visibleVaultIds.includes(vaultId)) {
    throw new Error(`Platform vault ${vaultId} is not visible to the current principal`);
  }
  return vaultId;
}

// Single-vault ownership: set the one Vault a Platform belongs to. Accepts an
// array for route compatibility but a Platform belongs to exactly one Vault, so
// only the first requested Vault is honored.
export async function setPlatformVault(
  platformId: number,
  requestedVaultIds: string[],
): Promise<{
  id: number;
  vaultId: string;
  vaultIds: string[];
  canManageVaults: boolean;
}> {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Platform Vault ownership requires an authenticated user account");
  }

  const nextVaultId = requestedVaultIds.map((vaultId) => vaultId.trim()).filter(Boolean)[0];
  if (!nextVaultId) {
    throw new Error("A Platform must belong to exactly one Vault");
  }
  if (!principal.visibleVaultIds.includes(nextVaultId)) {
    throw new Error("The selected Platform Vault must be currently visible");
  }

  await db.transaction(async (tx) => {
    const [platform] = await tx
      .select({
        id: platforms.id,
        vaultId: platforms.vaultId,
        ownerUserId: platforms.ownerUserId,
        accountId: platforms.accountId,
        scope: platforms.scope,
      })
      .from(platforms)
      .where(
        and(
          eq(platforms.id, platformId),
          combineWithWritableScope(principal, platformScopeColumns),
        ),
      )
      .for("update");
    if (!platform) {
      throw new Error(`Platform ${platformId} not found or not administrable`);
    }
    if (!canManagePlatformVaults(principal, platform)) {
      throw new Error(`Platform ${platformId} Vault is not manageable`);
    }

    const [available] = await tx
      .select({ id: vaults.id })
      .from(vaults)
      .where(
        and(
          eq(vaults.id, nextVaultId),
          eq(vaults.accountId, principal.accountId!),
          eq(vaults.isArchived, false),
        ),
      );
    if (!available) {
      throw new Error("The selected Platform Vault must be live and writable in the active account");
    }

    await tx
      .update(platforms)
      .set({ vaultId: nextVaultId, updatedAt: new Date() })
      .where(
        and(
          eq(platforms.id, platformId),
          combineWithWritableScope(principal, platformScopeColumns),
        ),
      );
  });

  const [platform] = await db
    .select({
      id: platforms.id,
      vaultId: platforms.vaultId,
      ownerUserId: platforms.ownerUserId,
      accountId: platforms.accountId,
      scope: platforms.scope,
    })
    .from(platforms)
    .where(eq(platforms.id, platformId))
    .limit(1);
  if (!platform) {
    throw new Error(`Platform ${platformId} not found after updating Vault`);
  }
  return {
    id: platform.id,
    vaultId: platform.vaultId ?? "",
    vaultIds: platform.vaultId ? [platform.vaultId] : [],
    canManageVaults: canManagePlatformVaults(principal, platform),
  };
}
