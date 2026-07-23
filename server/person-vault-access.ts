import { and, eq, exists, inArray, type SQL } from "drizzle-orm";
import { personVaultMemberships, persons, vaults } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope } from "./scoped-storage";

export const personOwnerScopeColumns = {
  scope: persons.scope,
  ownerUserId: persons.ownerUserId,
  accountId: persons.accountId,
};

export const personVaultMembershipScopeColumns = {
  scope: personVaultMemberships.scope,
  ownerUserId: personVaultMemberships.ownerUserId,
  accountId: personVaultMemberships.accountId,
};

function visibleMembershipExists(principal: Principal): SQL | null {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId ||
    principal.visibleVaultIds.length === 0
  ) {
    return null;
  }

  return exists(
    db
      .select({ personId: personVaultMemberships.personId })
      .from(personVaultMemberships)
      .innerJoin(vaults, eq(vaults.id, personVaultMemberships.vaultId))
      .where(and(
        eq(personVaultMemberships.personId, persons.id),
        eq(personVaultMemberships.scope, "user"),
        eq(personVaultMemberships.ownerUserId, principal.userId),
        eq(personVaultMemberships.accountId, principal.accountId),
        inArray(personVaultMemberships.vaultId, principal.visibleVaultIds),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      )),
  );
}

export function visiblePersonPredicate(principal: Principal, predicate?: SQL): SQL {
  const ownerPredicate = combineWithVisibleScope(principal, personOwnerScopeColumns, predicate);
  if (principal.actorType === "system") return ownerPredicate;
  const membershipPredicate = visibleMembershipExists(principal);
  if (!membershipPredicate) return and(ownerPredicate, eq(persons.id, "__no_visible_person__"))!;
  return and(ownerPredicate, membershipPredicate)!;
}

export function writablePersonPredicate(principal: Principal, predicate?: SQL): SQL {
  const ownerPredicate = combineWithWritableScope(principal, personOwnerScopeColumns, predicate);
  if (principal.actorType === "system") return ownerPredicate;
  const membershipPredicate = visibleMembershipExists(principal);
  if (!membershipPredicate) return and(ownerPredicate, eq(persons.id, "__no_visible_person__"))!;
  return and(ownerPredicate, membershipPredicate)!;
}

export async function loadPersonVaultIds(
  principal: Principal,
  personIds: string[],
): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(personIds)];
  if (uniqueIds.length === 0) return new Map();
  if (principal.actorType !== "system" && (!principal.userId || !principal.accountId)) return new Map();

  const ownership = principal.actorType === "system"
    ? undefined
    : and(
        eq(personVaultMemberships.scope, "user"),
        eq(personVaultMemberships.ownerUserId, principal.userId!),
        eq(personVaultMemberships.accountId, principal.accountId!),
        eq(vaults.accountId, principal.accountId!),
      );
  let query = db
    .select({ personId: personVaultMemberships.personId, vaultId: personVaultMemberships.vaultId })
    .from(personVaultMemberships)
    .innerJoin(vaults, eq(vaults.id, personVaultMemberships.vaultId));
  if (principal.actorType === "system") {
    query = query.where(inArray(personVaultMemberships.personId, uniqueIds)) as typeof query;
  } else {
    query = query.where(and(
      inArray(personVaultMemberships.personId, uniqueIds),
      eq(vaults.isArchived, false),
      ownership,
    )) as typeof query;
  }
  const rows = await query;

  const byPerson = new Map<string, string[]>();
  for (const row of rows) {
    const vaultIds = byPerson.get(row.personId) ?? [];
    vaultIds.push(row.vaultId);
    byPerson.set(row.personId, vaultIds);
  }
  for (const vaultIds of byPerson.values()) vaultIds.sort();
  return byPerson;
}
