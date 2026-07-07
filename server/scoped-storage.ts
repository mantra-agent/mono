import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { Principal } from "./principal";

export interface ScopeColumns {
  userId?: AnyColumn;
  accountId?: AnyColumn;
  ownerUserId?: AnyColumn;
  isTemplate?: AnyColumn;
  visibility?: AnyColumn;
  scope?: AnyColumn;
}

export interface ScopedOwnerValues {
  userId?: string;
  accountId?: string;
  ownerUserId?: string;
  isTemplate?: boolean;
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

export function visibleScopePredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL {
  if (principal.actorType === "system") return sql`TRUE`;
  const scoped = definedPredicates([
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
  return scoped ?? sql`FALSE`;
}

export function writableScopePredicate(
  principal: Principal,
  columns: ScopeColumns,
): SQL {
  if (principal.actorType === "system") return sql`TRUE`;
  const scoped = definedPredicates([
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
  return scoped ?? sql`FALSE`;
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

export function rowVisibleToPrincipal(
  principal: Principal,
  row: Record<string, unknown>,
): boolean {
  if (principal.actorType === "system") return true;
  if (rowIsTemplate(row)) return true;
  if (
    principal.userId &&
    (row.userId === principal.userId ||
      row.user_id === principal.userId ||
      row.ownerUserId === principal.userId ||
      row.owner_user_id === principal.userId)
  )
    return true;
  if (
    principal.accountId &&
    (row.accountId === principal.accountId ||
      row.account_id === principal.accountId)
  )
    return true;
  return false;
}

export function rowWritableByPrincipal(
  principal: Principal,
  row: Record<string, unknown>,
): boolean {
  if (principal.actorType === "system") return true;
  if (
    principal.userId &&
    (row.userId === principal.userId ||
      row.user_id === principal.userId ||
      row.ownerUserId === principal.userId ||
      row.owner_user_id === principal.userId)
  )
    return true;
  if (
    principal.accountId &&
    (row.accountId === principal.accountId ||
      row.account_id === principal.accountId)
  )
    return true;
  return false;
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
