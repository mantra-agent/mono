import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { simplePeopleSurfaceState } from "@shared/schema";

const log = createLogger("SimplePeopleSurfaceState");

const peopleSurfaceScopeColumns = {
  ownerUserId: simplePeopleSurfaceState.ownerUserId,
  accountId: simplePeopleSurfaceState.accountId,
  scope: simplePeopleSurfaceState.scope,
  vaultId: simplePeopleSurfaceState.vaultId,
};

let ensurePromise: Promise<void> | null = null;

async function ensurePeopleSurfaceStateTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS simple_people_surface_state (
          id serial PRIMARY KEY,
          person_id text NOT NULL,
          dismissed_at timestamp with time zone,
          dismissed_reason_key text,
          snoozed_until timestamp with time zone,
          surfaced_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
          scope text NOT NULL DEFAULT 'user',
          owner_user_id text,
          account_id text NOT NULL,
          reason_key text NOT NULL DEFAULT 'legacy',
          created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ADD COLUMN IF NOT EXISTS reason_key text NOT NULL DEFAULT 'legacy'`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ADD COLUMN IF NOT EXISTS surfaced_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ALTER COLUMN reason_key SET DEFAULT 'legacy'`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ALTER COLUMN surfaced_at SET DEFAULT CURRENT_TIMESTAMP`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP`);
      await db.execute(sql`ALTER TABLE simple_people_surface_state DROP CONSTRAINT IF EXISTS simple_people_surface_state_person_account_unique`);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_simple_people_surface_state_person_account_reason_unique
          ON simple_people_surface_state(person_id, account_id, reason_key)
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_simple_people_surface_state_scope_owner ON simple_people_surface_state(scope, owner_user_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_simple_people_surface_state_snoozed_until ON simple_people_surface_state(snoozed_until)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_simple_people_surface_state_person_reason ON simple_people_surface_state(person_id, reason_key)`);
      log.info("ensured simple_people_surface_state table");
    })().catch(error => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

export interface PeopleSurfaceState {
  personId: string;
  reasonKey: string;
  dismissedAt: Date | null;
  dismissedReasonKey: string | null;
  snoozedUntil: Date | null;
  updatedAt: Date;
  surfacedAt: Date;
}

function normalizeDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapRow(row: typeof simplePeopleSurfaceState.$inferSelect): PeopleSurfaceState {
  return {
    personId: row.personId,
    reasonKey: row.reasonKey,
    dismissedAt: normalizeDate(row.dismissedAt),
    dismissedReasonKey: row.dismissedReasonKey,
    snoozedUntil: normalizeDate(row.snoozedUntil),
    updatedAt: normalizeDate(row.updatedAt) ?? new Date(),
    surfacedAt: normalizeDate(row.surfacedAt) ?? normalizeDate(row.createdAt) ?? new Date(),
  };
}

function stateKey(personId: string, reasonKey: string): string {
  return `${personId}::${reasonKey}`;
}

export interface PeopleSurfaceStateLookup {
  personId: string;
  reasonKey: string;
}

export async function ensurePeopleSurfaceStates(lookups: PeopleSurfaceStateLookup[]): Promise<void> {
  await ensurePeopleSurfaceStateTable();
  const normalized = lookups.filter(item => item.personId && item.reasonKey);
  if (normalized.length === 0) return;
  const principal = getCurrentPrincipalOrSystem();
  const ownerValues = ownedInsertValues(principal, peopleSurfaceScopeColumns);
  const now = new Date();
  const seen = new Set<string>();
  const values = normalized
    .filter(item => {
      const key = stateKey(item.personId, item.reasonKey);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(item => ({
      personId: item.personId,
      reasonKey: item.reasonKey,
      dismissedAt: null,
      dismissedReasonKey: null,
      snoozedUntil: null,
      surfacedAt: now,
      ...ownerValues,
      createdAt: now,
      updatedAt: now,
    }));
  await db
    .insert(simplePeopleSurfaceState)
    .values(values)
    .onConflictDoNothing({
      target: [simplePeopleSurfaceState.personId, simplePeopleSurfaceState.accountId, simplePeopleSurfaceState.reasonKey],
    });
}

export async function listPeopleSurfaceStates(lookups: PeopleSurfaceStateLookup[]): Promise<Map<string, PeopleSurfaceState>> {
  await ensurePeopleSurfaceStateTable();
  const normalized = lookups.filter(item => item.personId && item.reasonKey);
  const uniqueIds = [...new Set(normalized.map(item => item.personId))];
  const wantedKeys = new Set(normalized.map(item => stateKey(item.personId, item.reasonKey)));
  if (uniqueIds.length === 0) return new Map();
  const principal = getCurrentPrincipalOrSystem();
  const predicate = combineWithVisibleScope(
    principal,
    peopleSurfaceScopeColumns,
    inArray(simplePeopleSurfaceState.personId, uniqueIds),
  );
  const rows = await db.select().from(simplePeopleSurfaceState).where(predicate);
  return new Map(
    rows
      .map(mapRow)
      .filter(row => wantedKeys.has(stateKey(row.personId, row.reasonKey)))
      .map(row => [stateKey(row.personId, row.reasonKey), row]),
  );
}

export async function dismissPeopleSurface(personId: string, reasonKey: string): Promise<PeopleSurfaceState> {
  await ensurePeopleSurfaceStateTable();
  const principal = getCurrentPrincipalOrSystem();
  const ownerValues = ownedInsertValues(principal, peopleSurfaceScopeColumns);
  const now = new Date();
  const [row] = await db
    .insert(simplePeopleSurfaceState)
    .values({
      personId,
      dismissedAt: now,
      reasonKey,
      dismissedReasonKey: reasonKey,
      snoozedUntil: null,
      surfacedAt: now,
      ...ownerValues,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [simplePeopleSurfaceState.personId, simplePeopleSurfaceState.accountId, simplePeopleSurfaceState.reasonKey],
      set: {
        dismissedAt: now,
        dismissedReasonKey: reasonKey,
        snoozedUntil: null,
        updatedAt: now,
      },
      where: combineWithWritableScope(
        principal,
        peopleSurfaceScopeColumns,
        and(eq(simplePeopleSurfaceState.personId, personId), eq(simplePeopleSurfaceState.reasonKey, reasonKey)),
      ),
    })
    .returning();
  return mapRow(row);
}

export async function snoozePeopleSurface(personId: string, reasonKey: string, snoozedUntil: Date): Promise<PeopleSurfaceState> {
  await ensurePeopleSurfaceStateTable();
  const principal = getCurrentPrincipalOrSystem();
  const ownerValues = ownedInsertValues(principal, peopleSurfaceScopeColumns);
  const now = new Date();
  const [row] = await db
    .insert(simplePeopleSurfaceState)
    .values({
      personId,
      reasonKey,
      dismissedAt: null,
      dismissedReasonKey: reasonKey,
      snoozedUntil,
      surfacedAt: now,
      ...ownerValues,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [simplePeopleSurfaceState.personId, simplePeopleSurfaceState.accountId, simplePeopleSurfaceState.reasonKey],
      set: {
        dismissedAt: null,
        dismissedReasonKey: reasonKey,
        snoozedUntil,
        updatedAt: now,
      },
      where: combineWithWritableScope(
        principal,
        peopleSurfaceScopeColumns,
        and(eq(simplePeopleSurfaceState.personId, personId), eq(simplePeopleSurfaceState.reasonKey, reasonKey)),
      ),
    })
    .returning();
  return mapRow(row);
}

export async function clearPeopleSurfaceState(personId: string, reasonKey: string): Promise<void> {
  await ensurePeopleSurfaceStateTable();
  const principal = getCurrentPrincipalOrSystem();
  await db
    .delete(simplePeopleSurfaceState)
    .where(combineWithWritableScope(
      principal,
      peopleSurfaceScopeColumns,
      and(eq(simplePeopleSurfaceState.personId, personId), eq(simplePeopleSurfaceState.reasonKey, reasonKey)),
    ));
}
