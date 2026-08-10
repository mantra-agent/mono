import { and, eq, exists, inArray, type SQL } from "drizzle-orm";
import { businesses, businessVaultMemberships, vaults } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope } from "./scoped-storage";

// Business visibility mirrors person-vault-access.ts verbatim: a Business is
// visible only when at least one membership resolves to a currently visible
// live vault in the principal account. Fail closed.

export const businessOwnerScopeColumns = {
  scope: businesses.scope,
  ownerUserId: businesses.ownerUserId,
  accountId: businesses.accountId,
};

export const businessVaultMembershipScopeColumns = {
  scope: businessVaultMemberships.scope,
  ownerUserId: businessVaultMemberships.ownerUserId,
  accountId: businessVaultMemberships.accountId,
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
      .select({ businessId: businessVaultMemberships.businessId })
      .from(businessVaultMemberships)
      .innerJoin(vaults, eq(vaults.id, businessVaultMemberships.vaultId))
      .where(and(
        eq(businessVaultMemberships.businessId, businesses.id),
        eq(businessVaultMemberships.scope, "user"),
        eq(businessVaultMemberships.ownerUserId, principal.userId),
        eq(businessVaultMemberships.accountId, principal.accountId),
        inArray(businessVaultMemberships.vaultId, principal.visibleVaultIds),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      )),
  );
}

export function visibleBusinessPredicate(principal: Principal, predicate?: SQL): SQL {
  const ownerPredicate = combineWithVisibleScope(principal, businessOwnerScopeColumns, predicate);
  if (principal.actorType === "system") return ownerPredicate;
  const membershipPredicate = visibleMembershipExists(principal);
  if (!membershipPredicate) return and(ownerPredicate, eq(businesses.id, "__no_visible_business__"))!;
  return and(ownerPredicate, membershipPredicate)!;
}

export function writableBusinessPredicate(principal: Principal, predicate?: SQL): SQL {
  const ownerPredicate = combineWithWritableScope(principal, businessOwnerScopeColumns, predicate);
  if (principal.actorType === "system") return ownerPredicate;
  const membershipPredicate = visibleMembershipExists(principal);
  if (!membershipPredicate) return and(ownerPredicate, eq(businesses.id, "__no_visible_business__"))!;
  return and(ownerPredicate, membershipPredicate)!;
}

export async function loadBusinessVaultIds(
  principal: Principal,
  businessIds: string[],
): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(businessIds)];
  if (uniqueIds.length === 0) return new Map();
  if (principal.actorType !== "system" && (!principal.userId || !principal.accountId)) return new Map();

  const ownership = principal.actorType === "system"
    ? undefined
    : and(
        eq(businessVaultMemberships.scope, "user"),
        eq(businessVaultMemberships.ownerUserId, principal.userId!),
        eq(businessVaultMemberships.accountId, principal.accountId!),
        eq(vaults.accountId, principal.accountId!),
      );
  let query = db
    .select({ businessId: businessVaultMemberships.businessId, vaultId: businessVaultMemberships.vaultId })
    .from(businessVaultMemberships)
    .innerJoin(vaults, eq(vaults.id, businessVaultMemberships.vaultId));
  if (principal.actorType === "system") {
    query = query.where(inArray(businessVaultMemberships.businessId, uniqueIds)) as typeof query;
  } else {
    query = query.where(and(
      inArray(businessVaultMemberships.businessId, uniqueIds),
      eq(vaults.isArchived, false),
      ownership,
    )) as typeof query;
  }
  const rows = await query;

  const byBusiness = new Map<string, string[]>();
  for (const row of rows) {
    const vaultIds = byBusiness.get(row.businessId) ?? [];
    vaultIds.push(row.vaultId);
    byBusiness.set(row.businessId, vaultIds);
  }
  for (const vaultIds of byBusiness.values()) vaultIds.sort();
  return byBusiness;
}
