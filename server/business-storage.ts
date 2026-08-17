import { randomBytes } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  businesses,
  businessVaultMemberships,
  vaults,
  type BusinessCreate,
  type BusinessPatch,
  type BusinessRow,
} from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import {
  businessOwnerScopeColumns,
  businessVaultMembershipScopeColumns,
  loadBusinessVaultIds,
  visibleBusinessPredicate,
  writableBusinessPredicate,
} from "./business-vault-access";

const log = createLogger("business-storage");

// The Business entity + its vault memberships mirror the People multi-vault
// idiom exactly (person-vault-access / PeopleStorage). Metric ownership is a
// later step; this storage has no consumers of its own beyond the tool.

export interface Business {
  id: string;
  publicName: string;
  entityName: string | null;
  valuesPageId: string | null;
  visionPageId: string | null;
  missionPageId: string | null;
  phasesPageId: string | null;
  pitchPageId: string | null;
  gtmPageId: string | null;
  productPageId: string | null;
  brandPageId: string | null;
  differentiatorsPageId: string | null;
  marketPageId: string | null;
  icpPageId: string | null;
  activationPageId: string | null;
  dataRoomUrl: string | null;
  status: string;
  isPlatformInstrument: boolean;
  vaultIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface BusinessVaultMembershipView {
  id: string;
  name: string;
}

export interface BusinessVaultMutationResult {
  business: Business;
  changed: boolean;
}

function newId(): string {
  return `business_${randomBytes(12).toString("hex")}`;
}

export async function ensureBusinessesSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS businesses (
      id text PRIMARY KEY,
      public_name text NOT NULL,
      entity_name text,
      values_page_id text,
      vision_page_id text,
      mission_page_id text,
      phases_page_id text,
      pitch_page_id text,
      gtm_page_id text,
      product_page_id text,
      brand_page_id text,
      differentiators_page_id text,
      market_page_id text,
      icp_page_id text,
      activation_page_id text,
      data_room_url text,
      status text NOT NULL DEFAULT 'active',
      is_platform_instrument boolean NOT NULL DEFAULT false,
      scope text NOT NULL DEFAULT 'user',
      owner_user_id text,
      account_id text,
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_platform_instrument boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS data_room_url text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phases_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pitch_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gtm_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS product_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS differentiators_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS market_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS icp_page_id text`);
  await db.execute(sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS activation_page_id text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_user_id, account_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_businesses_scope_owner ON businesses(scope, owner_user_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS business_vault_memberships (
      business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      scope text NOT NULL DEFAULT 'user',
      owner_user_id text NOT NULL,
      account_id text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (business_id, vault_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_business_vault_memberships_vault_business ON business_vault_memberships(vault_id, business_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_business_vault_memberships_scope_owner ON business_vault_memberships(scope, owner_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_business_vault_memberships_account ON business_vault_memberships(account_id)`);

  // Extract the first real Business from the existing Mantra Vault. Deterministic
  // identity and conflict guards make this safe across replicas and restarts.
  await db.execute(sql`
    INSERT INTO businesses (
      id, public_name, status, is_platform_instrument, scope, owner_user_id, account_id, created_by_user_id
    )
    SELECT 'business_mantra_' || substring(md5(v.account_id), 1, 16), 'Mantra', 'active', true, 'user',
      a.owner_user_id, v.account_id, a.owner_user_id
    FROM vaults v JOIN accounts a ON a.id = v.account_id
    WHERE v.id = '5097b85a-793b-4811-98e7-95621003eb7a' AND v.is_archived = false
    ON CONFLICT (id) DO NOTHING
  `);
  // Existing installs may have renamed this deterministic Business. Identity,
  // not presentation, owns the platform adapter capability.
  await db.execute(sql`
    UPDATE businesses
    SET is_platform_instrument = true
    WHERE id = 'business_mantra_' || substring(md5(account_id), 1, 16)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS businesses_account_platform_instrument_uidx
    ON businesses(account_id) WHERE is_platform_instrument = true
  `);
  await db.execute(sql`
    INSERT INTO business_vault_memberships (
      business_id, vault_id, scope, owner_user_id, account_id, created_by_user_id
    )
    SELECT b.id, v.id, 'user', b.owner_user_id, b.account_id, b.created_by_user_id
    FROM businesses b JOIN vaults v ON v.account_id = b.account_id
    WHERE b.is_platform_instrument = true
      AND v.id = '5097b85a-793b-4811-98e7-95621003eb7a'
    ON CONFLICT (business_id, vault_id) DO NOTHING
  `);
  log.info("businesses schema ensured");
}

function hydrate(row: BusinessRow, vaultIds: string[]): Business {
  return {
    id: row.id,
    publicName: row.publicName,
    entityName: row.entityName ?? null,
    valuesPageId: row.valuesPageId ?? null,
    visionPageId: row.visionPageId ?? null,
    missionPageId: row.missionPageId ?? null,
    phasesPageId: row.phasesPageId ?? null,
    pitchPageId: row.pitchPageId ?? null,
    gtmPageId: row.gtmPageId ?? null,
    productPageId: row.productPageId ?? null,
    brandPageId: row.brandPageId ?? null,
    differentiatorsPageId: row.differentiatorsPageId ?? null,
    marketPageId: row.marketPageId ?? null,
    icpPageId: row.icpPageId ?? null,
    activationPageId: row.activationPageId ?? null,
    dataRoomUrl: row.dataRoomUrl ?? null,
    status: row.status,
    isPlatformInstrument: row.isPlatformInstrument,
    vaultIds,
    createdAt: row.createdAt?.toISOString?.() ?? undefined,
    updatedAt: row.updatedAt?.toISOString?.() ?? undefined,
  };
}

async function hydrateRows(principal: Principal, rows: BusinessRow[]): Promise<Business[]> {
  if (rows.length === 0) return [];
  const vaultMap = await loadBusinessVaultIds(principal, rows.map((row) => row.id));
  return rows.map((row) => hydrate(row, vaultMap.get(row.id) ?? []));
}

async function assertVisibleLiveVaults(principal: Principal, vaultIds: string[]): Promise<void> {
  if (vaultIds.length === 0) return;
  const owned = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(
      inArray(vaults.id, vaultIds),
      eq(vaults.accountId, principal.accountId!),
      inArray(vaults.id, principal.visibleVaultIds),
      eq(vaults.isArchived, false),
    ));
  if (new Set(owned.map((v) => v.id)).size !== new Set(vaultIds).size) {
    throw new Error("Every Business Vault must be visible, live, and belong to the active account");
  }
}

async function loadWritableBusinessAfterMutation(principal: Principal, businessId: string): Promise<Business> {
  const rows = await db
    .select()
    .from(businesses)
    .where(combineWithWritableScope(principal, businessOwnerScopeColumns, eq(businesses.id, businessId)));
  const [business] = await hydrateRows(principal, rows);
  if (!business) throw new Error(`Business ${businessId} not found after mutation`);
  return business;
}

export const businessStorage = {
  async create(input: BusinessCreate): Promise<Business> {
    const principal = requireCurrentUserPrincipal();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId || !principal.activeVaultId) {
      throw new Error("Creating a Business requires an authenticated user with an active Vault");
    }
    const requestedVaultIds = [...new Set((input.vaultIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const targetVaultIds = requestedVaultIds.length > 0 ? requestedVaultIds : [principal.activeVaultId];
    await assertVisibleLiveVaults(principal, targetVaultIds);

    const id = newId();
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(businesses).values({
        id,
        ...ownedInsertValues(principal, businessOwnerScopeColumns),
        publicName: input.publicName,
        entityName: input.entityName ?? null,
        valuesPageId: input.valuesPageId ?? null,
        visionPageId: input.visionPageId ?? null,
        missionPageId: input.missionPageId ?? null,
        phasesPageId: input.phasesPageId ?? null,
        pitchPageId: input.pitchPageId ?? null,
        gtmPageId: input.gtmPageId ?? null,
        productPageId: input.productPageId ?? null,
        brandPageId: input.brandPageId ?? null,
        differentiatorsPageId: input.differentiatorsPageId ?? null,
        marketPageId: input.marketPageId ?? null,
        icpPageId: input.icpPageId ?? null,
        activationPageId: input.activationPageId ?? null,
        dataRoomUrl: input.dataRoomUrl ?? null,
        status: "active",
        createdByUserId: principal.userId,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(businessVaultMemberships).values(
        targetVaultIds.map((vaultId) => ({
          businessId: id,
          vaultId,
          scope: "user",
          ownerUserId: principal.userId!,
          accountId: principal.accountId!,
          createdByUserId: principal.userId!,
        })),
      );
    });
    return loadWritableBusinessAfterMutation(principal, id);
  },

  async get(id: string): Promise<Business | null> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db
      .select()
      .from(businesses)
      .where(visibleBusinessPredicate(principal, eq(businesses.id, id)))
      .limit(1);
    const [business] = await hydrateRows(principal, rows);
    return business ?? null;
  },

  async list(): Promise<Business[]> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db
      .select()
      .from(businesses)
      .where(visibleBusinessPredicate(principal))
      .orderBy(asc(businesses.createdAt));
    return hydrateRows(principal, rows);
  },

  async update(id: string, patch: BusinessPatch): Promise<Business> {
    const principal = requireCurrentUserPrincipal();
    const updates: Partial<typeof businesses.$inferInsert> = { updatedAt: new Date() };
    if (patch.publicName !== undefined) updates.publicName = patch.publicName;
    if (patch.entityName !== undefined) updates.entityName = patch.entityName;
    if (patch.valuesPageId !== undefined) updates.valuesPageId = patch.valuesPageId;
    if (patch.visionPageId !== undefined) updates.visionPageId = patch.visionPageId;
    if (patch.missionPageId !== undefined) updates.missionPageId = patch.missionPageId;
    if (patch.phasesPageId !== undefined) updates.phasesPageId = patch.phasesPageId;
    if (patch.pitchPageId !== undefined) updates.pitchPageId = patch.pitchPageId;
    if (patch.gtmPageId !== undefined) updates.gtmPageId = patch.gtmPageId;
    if (patch.productPageId !== undefined) updates.productPageId = patch.productPageId;
    if (patch.brandPageId !== undefined) updates.brandPageId = patch.brandPageId;
    if (patch.differentiatorsPageId !== undefined) updates.differentiatorsPageId = patch.differentiatorsPageId;
    if (patch.marketPageId !== undefined) updates.marketPageId = patch.marketPageId;
    if (patch.icpPageId !== undefined) updates.icpPageId = patch.icpPageId;
    if (patch.activationPageId !== undefined) updates.activationPageId = patch.activationPageId;
    if (patch.dataRoomUrl !== undefined) updates.dataRoomUrl = patch.dataRoomUrl;
    if (patch.status !== undefined) updates.status = patch.status;

    const updated = await db
      .update(businesses)
      .set(updates)
      .where(combineWithWritableScope(principal, businessOwnerScopeColumns, eq(businesses.id, id)))
      .returning({ id: businesses.id });
    if (updated.length === 0) throw new Error(`Business ${id} not found or not writable`);
    return loadWritableBusinessAfterMutation(principal, id);
  },

  async archive(id: string): Promise<Business> {
    return this.update(id, { status: "archived" });
  },

  async listVaultMemberships(id: string): Promise<BusinessVaultMembershipView[]> {
    const principal = requireCurrentUserPrincipal();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Business Vault membership requires an authenticated user account");
    }
    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(visibleBusinessPredicate(principal, eq(businesses.id, id)))
      .limit(1);
    if (!business) throw new Error(`Business ${id} not found or not visible`);

    return db
      .select({ id: vaults.id, name: vaults.name })
      .from(businessVaultMemberships)
      .innerJoin(vaults, eq(vaults.id, businessVaultMemberships.vaultId))
      .where(and(
        eq(businessVaultMemberships.businessId, id),
        eq(businessVaultMemberships.scope, "user"),
        eq(businessVaultMemberships.ownerUserId, principal.userId),
        eq(businessVaultMemberships.accountId, principal.accountId),
        inArray(businessVaultMemberships.vaultId, principal.visibleVaultIds),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ))
      .orderBy(vaults.position, vaults.createdAt);
  },

  async addVaultMembership(id: string, vaultId: string): Promise<BusinessVaultMutationResult> {
    const principal = requireCurrentUserPrincipal();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Business Vault membership requires an authenticated user account");
    }
    const normalizedVaultId = vaultId.trim();
    if (!normalizedVaultId) throw new Error("vaultId is required");

    const changed = await db.transaction(async (tx) => {
      const [business] = await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(writableBusinessPredicate(principal, eq(businesses.id, id)))
        .for("update");
      if (!business) throw new Error(`Business ${id} not found or not writable`);

      const [ownedVault] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(
          eq(vaults.id, normalizedVaultId),
          eq(vaults.accountId, principal.accountId),
          inArray(vaults.id, principal.visibleVaultIds),
          eq(vaults.isArchived, false),
        ))
        .limit(1);
      if (!ownedVault) throw new Error("Business Vault must be live and belong to the active account");

      const inserted = await tx
        .insert(businessVaultMemberships)
        .values({
          businessId: id,
          vaultId: normalizedVaultId,
          scope: "user",
          ownerUserId: principal.userId,
          accountId: principal.accountId,
          createdByUserId: principal.userId,
        })
        .onConflictDoNothing()
        .returning({ vaultId: businessVaultMemberships.vaultId });
      return inserted.length > 0;
    });

    return { business: await loadWritableBusinessAfterMutation(principal, id), changed };
  },

  async removeVaultMembership(id: string, vaultId: string): Promise<BusinessVaultMutationResult> {
    const principal = requireCurrentUserPrincipal();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Business Vault membership requires an authenticated user account");
    }
    const normalizedVaultId = vaultId.trim();
    if (!normalizedVaultId) throw new Error("vaultId is required");

    const changed = await db.transaction(async (tx) => {
      const [business] = await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(writableBusinessPredicate(principal, eq(businesses.id, id)))
        .for("update");
      if (!business) throw new Error(`Business ${id} not found or not writable`);

      const memberships = await tx
        .select({ vaultId: businessVaultMemberships.vaultId })
        .from(businessVaultMemberships)
        .innerJoin(vaults, eq(vaults.id, businessVaultMemberships.vaultId))
        .where(combineWithWritableScope(
          principal,
          businessVaultMembershipScopeColumns,
          and(
            eq(businessVaultMemberships.businessId, id),
            eq(vaults.accountId, principal.accountId),
            eq(vaults.isArchived, false),
          ),
        ))
        .for("update");
      if (!memberships.some((m) => m.vaultId === normalizedVaultId)) return false;
      if (memberships.length === 1) throw new Error("A Business must belong to at least one Vault");

      const removed = await tx
        .delete(businessVaultMemberships)
        .where(combineWithWritableScope(
          principal,
          businessVaultMembershipScopeColumns,
          and(
            eq(businessVaultMemberships.businessId, id),
            eq(businessVaultMemberships.vaultId, normalizedVaultId),
          ),
        ))
        .returning({ vaultId: businessVaultMemberships.vaultId });
      return removed.length > 0;
    });

    return { business: await loadWritableBusinessAfterMutation(principal, id), changed };
  },

  async replaceVaultMemberships(id: string, vaultIds: string[]): Promise<Business> {
    const principal = requireCurrentUserPrincipal();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Business Vault membership requires an authenticated user account");
    }
    const normalizedVaultIds = [...new Set(vaultIds.map((v) => v.trim()).filter(Boolean))];
    if (normalizedVaultIds.length === 0) throw new Error("A Business must belong to at least one Vault");

    await db.transaction(async (tx) => {
      const [business] = await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(writableBusinessPredicate(principal, eq(businesses.id, id)))
        .for("update");
      if (!business) throw new Error(`Business ${id} not found or not writable`);

      const ownedVaults = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(
          inArray(vaults.id, normalizedVaultIds),
          eq(vaults.accountId, principal.accountId),
          inArray(vaults.id, principal.visibleVaultIds),
          eq(vaults.isArchived, false),
        ));
      if (ownedVaults.length !== normalizedVaultIds.length) {
        throw new Error("Every Business Vault must be visible, live, and belong to the active account");
      }

      await tx.delete(businessVaultMemberships).where(
        combineWithWritableScope(
          principal,
          businessVaultMembershipScopeColumns,
          eq(businessVaultMemberships.businessId, id),
        ),
      );
      await tx.insert(businessVaultMemberships).values(
        normalizedVaultIds.map((vaultId) => ({
          businessId: id,
          vaultId,
          scope: "user",
          ownerUserId: principal.userId!,
          accountId: principal.accountId!,
          createdByUserId: principal.userId!,
        })),
      );
    });

    return loadWritableBusinessAfterMutation(principal, id);
  },
};
