import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { Principal } from "./principal";
import { assertSystemVaultAccess } from "./vault-allowlist";

export interface ScopeColumns {
  userId?: AnyColumn;
  accountId?: AnyColumn;
  ownerUserId?: AnyColumn;
  isTemplate?: AnyColumn;
  visibility?: AnyColumn;
  scope?: AnyColumn;
  /** When present, vault filtering is applied via visibleScopePredicate and ownedInsertValues. */
  vaultId?: AnyColumn;
  /**
   * Optional Instance ownership column (same opt-in as vaultId).
   * Mind seams that opt in today: memory claim graph, personas, persona_revisions,
   * persona_preferences, emotional_states, timers, responsibility_runs, skills,
   * skill_revisions, skill_runs. When present:
   * - reads match pinned Instance OR (NULL instance + owner_user_id)
   * - inserts stamp principal.instanceId when set
   * - account_id is not used for visibility (prevents Business Instance leak)
   */
  instanceId?: AnyColumn;
}

export interface ScopedOwnerValues {
  userId?: string;
  accountId?: string;
  ownerUserId?: string;
  isTemplate?: boolean;
  instanceId?: string;
}

function hasUser(
  principal: Principal,
): principal is Principal & { userId: string } {
  return typeof principal.userId === "string" && principal.userId.length > 0;
}

function hasAccount(
  principal: Principal,
): principal is Principal & { accountId: string } {
  return (
    typeof principal.accountId === "string" && principal.accountId.length > 0
  );
}

function definedPredicates(
  predicates: Array<SQL | undefined>,
): SQL | undefined {
  const present = predicates.filter(
    (predicate): predicate is SQL => !!predicate,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return or(...present);
}

export function templatePredicate(columns: ScopeColumns): SQL | undefined {
  const templateFlag = columns.isTemplate
    ? eq(columns.isTemplate, true)
    : undefined;
  const templateVisibility = columns.visibility
    ? eq(columns.visibility, "template")
    : undefined;
  const globalScope = columns.scope ? eq(columns.scope, "global") : undefined;
  const sharedScope = columns.scope ? eq(columns.scope, "shared") : undefined;
  // scope='system' is NOT a template — system-scoped records are only visible
  // through ownership columns (userId, ownerUserId, accountId)
  // scope='shared' makes records visible (read-only) to all authenticated users
  return definedPredicates([
    templateFlag,
    templateVisibility,
    globalScope,
    sharedScope,
  ]);
}

/**
 * Instance-aware ownership for tables that opt into ScopeColumns.instanceId.
 * Visible when: instance_id matches the principal pin, OR instance_id IS NULL
 * and owner_user_id/user_id is the principal. Never match account_id alone —
 * that leaks across Business Instances on the same Account.
 */
function instanceOwnershipPredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL | undefined {
  if (!columns.instanceId) return undefined;
  const pinned =
    typeof principal.instanceId === "string" && principal.instanceId.length > 0
      ? eq(columns.instanceId, principal.instanceId)
      : undefined;
  const unpinnedOwner = definedPredicates([
    hasUser(principal) && columns.userId
      ? and(sql`${columns.instanceId} IS NULL`, eq(columns.userId, principal.userId))
      : undefined,
    hasUser(principal) && columns.ownerUserId
      ? and(sql`${columns.instanceId} IS NULL`, eq(columns.ownerUserId, principal.userId))
      : undefined,
  ]);
  return definedPredicates([pinned, unpinnedOwner]);
}

export function visibleScopePredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL {
  if (principal.actorType === "system") {
    if (columns.vaultId) assertSystemVaultAccess(principal, "visibleScopePredicate");
    return sql`TRUE`;
  }
  // Instance-opted tables: dual-read Instance pin OR legacy owner-null rows.
  // Do not OR account_id — Account is not the mind boundary.
  const instanceScoped = instanceOwnershipPredicate(principal, columns);
  const scoped = instanceScoped
    ? definedPredicates([instanceScoped, templatePredicate(columns)])
    : definedPredicates([
        hasUser(principal) && columns.userId
          ? eq(columns.userId, principal.userId)
          : undefined,
        hasUser(principal) && columns.ownerUserId
          ? eq(columns.ownerUserId, principal.userId)
          : undefined,
        hasAccount(principal) && columns.accountId
          ? eq(columns.accountId, principal.accountId)
          : undefined,
        templatePredicate(columns),
      ]);
  const basePredicate = scoped ?? sql`FALSE`;
  // Vault filtering: when the table has a vaultId column and the principal
  // has a non-empty visibleVaultIds set, additionally require vault_id IN (...).
  // Empty visibleVaultIds (system principals, or users before vault setup) = no vault filter.
  // Rows with NULL vault_id pass through (backwards compatibility during backfill).
  if (columns.vaultId && principal.visibleVaultIds && principal.visibleVaultIds.length > 0) {
    const vaultFilter = or(
      inArray(columns.vaultId, principal.visibleVaultIds),
      sql`${columns.vaultId} IS NULL`,
    )!;
    return and(basePredicate, vaultFilter)!;
  }
  return basePredicate;
}

export function writableScopePredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL {
  if (principal.actorType === "system") {
    if (columns.vaultId) assertSystemVaultAccess(principal, "writableScopePredicate");
    return sql`TRUE`;
  }
  // Instance-opted tables: same dual-write ownership as reads (no account match).
  const instanceScoped = instanceOwnershipPredicate(principal, columns);
  const scoped = instanceScoped
    ? instanceScoped
    : definedPredicates([
        hasUser(principal) && columns.userId
          ? eq(columns.userId, principal.userId)
          : undefined,
        hasUser(principal) && columns.ownerUserId
          ? eq(columns.ownerUserId, principal.userId)
          : undefined,
        hasAccount(principal) && columns.accountId
          ? eq(columns.accountId, principal.accountId)
          : undefined,
      ]);
  const basePredicate = scoped ?? sql`FALSE`;
  // Vault filtering on writes: same logic as reads — restrict to visible vaults.
  if (columns.vaultId && principal.visibleVaultIds && principal.visibleVaultIds.length > 0) {
    const vaultFilter = or(
      inArray(columns.vaultId, principal.visibleVaultIds),
      sql`${columns.vaultId} IS NULL`,
    )!;
    return and(basePredicate, vaultFilter)!;
  }
  return basePredicate;
}

export function ownedInsertValues(
  principal: Principal,
  columns: ScopeColumns = {},
): ScopedOwnerValues {
  if (principal.actorType !== "user" && principal.actorType !== "system") {
    throw new Error(
      "Service principals must choose an explicit owner before inserting scoped data",
    );
  }
  const values: ScopedOwnerValues = {};
  if (columns.userId && principal.userId) values.userId = principal.userId;
  if (columns.ownerUserId && principal.userId)
    values.ownerUserId = principal.userId;
  if (columns.accountId && principal.accountId)
    values.accountId = principal.accountId;
  if (columns.isTemplate) values.isTemplate = false;
  if (columns.scope)
    (values as Record<string, unknown>).scope =
      principal.actorType === "system" ? "system" : "user";
  // Stamp vault_id from principal's activeVaultId when the table has a vaultId column.
  // System principals without an activeVaultId produce null (backfill assigns later).
  if (columns.vaultId && principal.activeVaultId) {
    (values as Record<string, unknown>).vaultId = principal.activeVaultId;
  }
  // Optional Instance stamp — only tables that opt into columns.instanceId.
  // owner_user_id / created_by stay the acting User; Instance is the mind owner.
  if (columns.instanceId && principal.instanceId) {
    values.instanceId = principal.instanceId;
  }
  return values;
}

export function rowIsTemplate(row: Record<string, unknown>): boolean {
  return (
    row.isTemplate === true ||
    row.visibility === "template" ||
    row.scope === "global"
    // scope='system' is NOT a template — visible only through ownership match
  );
}

function rowInstanceId(row: Record<string, unknown>): string | null {
  const value = row.instanceId ?? row.instance_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Row-level dual-read for Instance-stamped mind rows (memory, personas, affect).
 * When the row carries instance_id (including null after opt-in tables),
 * match pin OR (null + owner). Account alone never grants visibility.
 */
function rowMatchesInstanceOwnership(
  principal: Principal,
  row: Record<string, unknown>,
): boolean | null {
  // Only apply when the row shape includes the instance column key.
  if (!("instanceId" in row) && !("instance_id" in row)) return null;
  const rowInstance = rowInstanceId(row);
  if (rowInstance) {
    return (
      typeof principal.instanceId === "string" &&
      principal.instanceId.length > 0 &&
      rowInstance === principal.instanceId
    );
  }
  // Unpinned legacy row: owner_user_id / user_id only.
  return !!(
    principal.userId &&
    (row.userId === principal.userId ||
      row.user_id === principal.userId ||
      row.ownerUserId === principal.userId ||
      row.owner_user_id === principal.userId)
  );
}

export function rowVisibleToPrincipal(
  principal: Principal,
  row: Record<string, unknown>,
): boolean {
  if (principal.actorType === "system") {
    // Row-level visibility — vault allowlist check when row has vault_id
    const rowVault = row.vaultId ?? row.vault_id;
    if (rowVault) assertSystemVaultAccess(principal, "rowVisibleToPrincipal");
    return true;
  }
  if (rowIsTemplate(row)) return true;
  const instanceMatch = rowMatchesInstanceOwnership(principal, row);
  const ownerMatch =
    instanceMatch !== null
      ? instanceMatch
      : (principal.userId &&
          (row.userId === principal.userId ||
            row.user_id === principal.userId ||
            row.ownerUserId === principal.userId ||
            row.owner_user_id === principal.userId)) ||
        (principal.accountId &&
          (row.accountId === principal.accountId ||
            row.account_id === principal.accountId));
  if (!ownerMatch) return false;
  // Vault filter: if principal has visible vaults and row has a vault_id, check membership.
  // Null vault_id rows pass through (backwards compat).
  const rowVault = row.vaultId ?? row.vault_id;
  if (rowVault && principal.visibleVaultIds && principal.visibleVaultIds.length > 0) {
    return principal.visibleVaultIds.includes(rowVault as string);
  }
  return true;
}

export function rowWritableByPrincipal(
  principal: Principal,
  row: Record<string, unknown>,
): boolean {
  if (principal.actorType === "system") {
    const rowVault = row.vaultId ?? row.vault_id;
    if (rowVault) assertSystemVaultAccess(principal, "rowWritableByPrincipal");
    return true;
  }
  const instanceMatch = rowMatchesInstanceOwnership(principal, row);
  const ownerMatch =
    instanceMatch !== null
      ? instanceMatch
      : (principal.userId &&
          (row.userId === principal.userId ||
            row.user_id === principal.userId ||
            row.ownerUserId === principal.userId ||
            row.owner_user_id === principal.userId)) ||
        (principal.accountId &&
          (row.accountId === principal.accountId ||
            row.account_id === principal.accountId));
  if (!ownerMatch) return false;
  // Vault filter on writes: same as reads.
  const rowVault = row.vaultId ?? row.vault_id;
  if (rowVault && principal.visibleVaultIds && principal.visibleVaultIds.length > 0) {
    return principal.visibleVaultIds.includes(rowVault as string);
  }
  return true;
}

export function assertVisible<T extends Record<string, unknown>>(
  principal: Principal,
  row: T | null | undefined,
  label = "record",
): T {
  if (!row || !rowVisibleToPrincipal(principal, row)) {
    throw Object.assign(new Error(`${label} not found or not visible`), {
      status: 404,
    });
  }
  return row;
}

export function assertWritable<T extends Record<string, unknown>>(
  principal: Principal,
  row: T | null | undefined,
  label = "record",
): T {
  if (!row || !rowWritableByPrincipal(principal, row)) {
    throw Object.assign(new Error(`${label} not writable`), { status: 403 });
  }
  return row;
}

export function visibleOrTemplatePredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL {
  return visibleScopePredicate(principal, columns);
}

export function writableOwnedPredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL {
  return writableScopePredicate(principal, columns);
}

export function combineWithVisibleScope(
  principal: Principal,
  columns: ScopeColumns,
  predicate?: SQL,
): SQL {
  const scope = visibleScopePredicate(principal, columns);
  return predicate ? and(predicate, scope)! : scope;
}

export function combineWithWritableScope(
  principal: Principal,
  columns: ScopeColumns,
  predicate?: SQL,
): SQL {
  const scope = writableScopePredicate(principal, columns);
  return predicate ? and(predicate, scope)! : scope;
}
