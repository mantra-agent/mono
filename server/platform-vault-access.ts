import { and, eq, exists, inArray, type SQL } from "drizzle-orm";
import { platformVaultMemberships, platforms, vaults } from "@shared/schema";
import { db, pool } from "./db";
import type { Principal } from "./principal";
import { requireCurrentPrincipal } from "./principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";

export const platformVaultMembershipScopeColumns = {
  scope: platformVaultMemberships.scope,
  ownerUserId: platformVaultMemberships.ownerUserId,
  accountId: platformVaultMemberships.accountId,
};

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

function visiblePlatformMembershipExists(principal: Principal): SQL {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId ||
    principal.visibleVaultIds.length === 0
  ) {
    return eq(platforms.id, -1);
  }

  return exists(
    db
      .select({ platformId: platformVaultMemberships.platformId })
      .from(platformVaultMemberships)
      .innerJoin(vaults, eq(vaults.id, platformVaultMemberships.vaultId))
      .where(
        and(
          eq(platformVaultMemberships.platformId, platforms.id),
          eq(platformVaultMemberships.scope, "user"),
          eq(platformVaultMemberships.ownerUserId, principal.userId),
          eq(platformVaultMemberships.accountId, principal.accountId),
          inArray(platformVaultMemberships.vaultId, principal.visibleVaultIds),
          eq(vaults.accountId, principal.accountId),
          eq(vaults.isArchived, false),
        ),
      ),
  );
}

export function visiblePlatform(predicate?: SQL): SQL {
  const principal = requireCurrentPrincipal();
  const ownership = combineWithVisibleScope(principal, platformScopeColumns, predicate);
  return and(ownership, visiblePlatformMembershipExists(principal))!;
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
    vaultIds?: string[];
  },
): boolean {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    return false;
  }
  if (platform.scope === "global") return false;
  if (platform.ownerUserId !== principal.userId || platform.accountId !== principal.accountId) {
    return false;
  }
  const vaultIds = platform.vaultIds ?? [];
  return vaultIds.some((vaultId) => principal.visibleVaultIds.includes(vaultId));
}

export async function loadVaultIdsByPlatformIds(
  principal: Principal,
  platformIds: number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (platformIds.length === 0) return result;

  const rows = await db
    .select({
      platformId: platformVaultMemberships.platformId,
      vaultId: platformVaultMemberships.vaultId,
      position: vaults.position,
      isDefault: vaults.isDefault,
      createdAt: vaults.createdAt,
    })
    .from(platformVaultMemberships)
    .innerJoin(vaults, eq(platformVaultMemberships.vaultId, vaults.id))
    .where(
      and(
        inArray(platformVaultMemberships.platformId, platformIds),
        eq(vaults.isArchived, false),
        principal.actorType === "user" && principal.userId && principal.accountId
          ? and(
              eq(platformVaultMemberships.scope, "user"),
              eq(platformVaultMemberships.ownerUserId, principal.userId),
              eq(platformVaultMemberships.accountId, principal.accountId),
            )
          : eq(platformVaultMemberships.id, -1),
      ),
    );

  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.platformId) ?? [];
    list.push(row);
    grouped.set(row.platformId, list);
  }

  for (const [platformId, memberships] of grouped) {
    memberships.sort((a, b) => {
      const defaultDelta = Number(b.isDefault) - Number(a.isDefault);
      if (defaultDelta !== 0) return defaultDelta;
      const posA = a.position ?? Number.MAX_SAFE_INTEGER;
      const posB = b.position ?? Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return createdA - createdB || a.vaultId.localeCompare(b.vaultId);
    });
    result.set(
      platformId,
      memberships.map((membership) => membership.vaultId),
    );
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

export async function seedPlatformVaultMembership(args: {
  platformId: number;
  vaultId: string;
  principal: Principal;
}): Promise<void> {
  const { platformId, vaultId, principal } = args;
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Platform Vault membership requires an authenticated user account");
  }
  await db.insert(platformVaultMemberships).values({
    platformId,
    vaultId,
    ...ownedInsertValues(principal, {
      scope: platformVaultMemberships.scope,
      ownerUserId: platformVaultMemberships.ownerUserId,
      accountId: platformVaultMemberships.accountId,
    }),
    createdByUserId: principal.userId,
  });
}

export async function replacePlatformVaultMemberships(
  platformId: number,
  vaultIds: string[],
): Promise<{
  id: number;
  vaultId: string;
  vaultIds: string[];
  canManageVaults: boolean;
}> {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Platform Vault membership requires an authenticated user account");
  }

  const normalizedVisibleVaultIds = [
    ...new Set(vaultIds.map((vaultId) => vaultId.trim()).filter(Boolean)),
  ];
  if (normalizedVisibleVaultIds.length === 0) {
    throw new Error("A Platform must belong to at least one visible Vault");
  }
  if (normalizedVisibleVaultIds.some((vaultId) => !principal.visibleVaultIds.includes(vaultId))) {
    throw new Error("Every selected Platform Vault must be currently visible");
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

    const existingMemberships = await tx
      .select({ vaultId: platformVaultMemberships.vaultId })
      .from(platformVaultMemberships)
      .where(
        and(
          eq(platformVaultMemberships.platformId, platformId),
          eq(platformVaultMemberships.scope, "user"),
          eq(platformVaultMemberships.ownerUserId, principal.userId!),
          eq(platformVaultMemberships.accountId, principal.accountId!),
        ),
      );
    const existingVaultIds = existingMemberships.map((membership) => membership.vaultId);
    if (
      !canManagePlatformVaults(principal, {
        ...platform,
        vaultIds: existingVaultIds,
      })
    ) {
      throw new Error(`Platform ${platformId} Vaults are not manageable`);
    }

    const hiddenVaultIds = existingVaultIds.filter(
      (vaultId) => !principal.visibleVaultIds.includes(vaultId),
    );
    const finalVaultIds = [...new Set([...hiddenVaultIds, ...normalizedVisibleVaultIds])];

    const availableVaults = await tx
      .select({ id: vaults.id })
      .from(vaults)
      .where(
        and(
          inArray(vaults.id, finalVaultIds),
          eq(vaults.accountId, principal.accountId!),
          eq(vaults.isArchived, false),
        ),
      );
    if (availableVaults.length !== finalVaultIds.length) {
      throw new Error("Every Platform Vault must be live and writable in the active account");
    }

    await tx
      .delete(platformVaultMemberships)
      .where(
        and(
          eq(platformVaultMemberships.platformId, platformId),
          eq(platformVaultMemberships.scope, "user"),
          eq(platformVaultMemberships.ownerUserId, principal.userId!),
          eq(platformVaultMemberships.accountId, principal.accountId!),
        ),
      );
    await tx.insert(platformVaultMemberships).values(
      finalVaultIds.map((vaultId) => ({
        platformId,
        vaultId,
        scope: "user" as const,
        ownerUserId: principal.userId!,
        accountId: principal.accountId!,
        createdByUserId: principal.userId!,
      })),
    );

    const primaryVaultId = finalVaultIds.includes(platform.vaultId ?? "")
      ? (platform.vaultId as string)
      : normalizedVisibleVaultIds[0];
    await tx
      .update(platforms)
      .set({ vaultId: primaryVaultId, updatedAt: new Date() })
      .where(
        and(
          eq(platforms.id, platformId),
          combineWithWritableScope(principal, platformScopeColumns),
        ),
      );
  });

  const vaultIdsForPlatform = await loadVaultIdsByPlatformIds(principal, [platformId]);
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
    throw new Error(`Platform ${platformId} not found after updating Vaults`);
  }
  const nextVaultIds = vaultIdsForPlatform.get(platformId) ?? [];
  return {
    id: platform.id,
    vaultId: platform.vaultId ?? nextVaultIds[0] ?? "",
    vaultIds: nextVaultIds,
    canManageVaults: canManagePlatformVaults(principal, {
      ...platform,
      vaultIds: nextVaultIds,
    }),
  };
}
