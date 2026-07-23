import { and, eq, exists, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { projectVaultMemberships, projects, vaults } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { visibleScopePredicate, writableScopePredicate } from "./scoped-storage";
import {
  liveObjectGrantPredicate,
  workObjectAccessPredicate,
  workObjectIdentity,
  type ObjectGrantCapability,
  type WorkObjectColumns,
  type WorkObjectType,
} from "./object-grant-access";

export const projectOwnerScopeColumns = {
  objectId: projects.id,
  scope: projects.scope,
  ownerUserId: projects.ownerUserId,
  accountId: projects.accountId,
};

export const projectVaultMembershipScopeColumns = {
  scope: projectVaultMemberships.scope,
  ownerUserId: projectVaultMemberships.ownerUserId,
  accountId: projectVaultMemberships.accountId,
};

function visibleProjectMembershipExists(principal: Principal): SQL {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId ||
    principal.visibleVaultIds.length === 0
  ) {
    return eq(projects.id, -1);
  }

  return exists(
    db
      .select({ projectId: projectVaultMemberships.projectId })
      .from(projectVaultMemberships)
      .innerJoin(vaults, eq(vaults.id, projectVaultMemberships.vaultId))
      .where(and(
        eq(projectVaultMemberships.projectId, projects.id),
        eq(projectVaultMemberships.scope, "user"),
        eq(projectVaultMemberships.ownerUserId, principal.userId),
        eq(projectVaultMemberships.accountId, principal.accountId),
        inArray(projectVaultMemberships.vaultId, principal.visibleVaultIds),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      )),
  );
}

export function projectOwnerAccessPredicate(
  principal: Principal,
  required: ObjectGrantCapability,
): SQL {
  const owned = required === "read"
    ? visibleScopePredicate(principal, projectOwnerScopeColumns)
    : writableScopePredicate(principal, projectOwnerScopeColumns);
  if (principal.actorType === "system") return owned;
  return and(owned, visibleProjectMembershipExists(principal))!;
}

export function projectAccessPredicate(
  principal: Principal,
  required: ObjectGrantCapability,
): SQL {
  return or(
    projectOwnerAccessPredicate(principal, required),
    liveObjectGrantPredicate(
      principal,
      workObjectIdentity("project", projectOwnerScopeColumns),
      required,
    ),
  )!;
}

export function combineWithProjectAccess(
  principal: Principal,
  required: ObjectGrantCapability,
  predicate?: SQL,
): SQL {
  const access = projectAccessPredicate(principal, required);
  return predicate ? and(predicate, access)! : access;
}

function parentProjectAccessExists(
  principal: Principal,
  projectId: AnyColumn,
): SQL {
  return exists(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), projectAccessPredicate(principal, "read"))),
  );
}

/**
 * Project-attached work derives visibility from its parent Project while
 * preserving child owner/account scope. Direct grants on the exact child
 * remain deliberate recipient access without granting unrelated work.
 */
export function projectDerivedWorkAccessPredicate(
  principal: Principal,
  columns: WorkObjectColumns & { projectId: AnyColumn },
  objectType: Exclude<WorkObjectType, "project">,
  required: ObjectGrantCapability,
): SQL {
  const directGrant = liveObjectGrantPredicate(
    principal,
    workObjectIdentity(objectType, columns),
    required,
  );
  if (required === "read") {
    const childOwned = visibleScopePredicate(principal, columns);
    return or(
      and(childOwned, parentProjectAccessExists(principal, columns.projectId)),
      directGrant,
    )!;
  }
  const childOwned = writableScopePredicate(principal, columns);
  const ownerMutation = and(
    childOwned,
    parentProjectAccessExists(principal, columns.projectId),
  )!;
  return or(ownerMutation, directGrant)!;
}

export function combineWithProjectDerivedWorkAccess(
  principal: Principal,
  columns: WorkObjectColumns & { projectId: AnyColumn },
  objectType: Exclude<WorkObjectType, "project">,
  required: ObjectGrantCapability,
  predicate?: SQL,
): SQL {
  const access = projectDerivedWorkAccessPredicate(principal, columns, objectType, required);
  return predicate ? and(predicate, access)! : access;
}

export function taskAccessPredicate(
  principal: Principal,
  columns: WorkObjectColumns & { projectId: AnyColumn },
  required: ObjectGrantCapability,
): SQL {
  const standalone = and(
    isNull(columns.projectId),
    workObjectAccessPredicate(principal, columns, "task", required),
  )!;
  const attached = and(
    isNotNull(columns.projectId),
    projectDerivedWorkAccessPredicate(principal, columns, "task", required),
  )!;
  return or(standalone, attached)!;
}

export function combineWithTaskAccess(
  principal: Principal,
  columns: WorkObjectColumns & { projectId: AnyColumn },
  required: ObjectGrantCapability,
  predicate?: SQL,
): SQL {
  const access = taskAccessPredicate(principal, columns, required);
  return predicate ? and(predicate, access)! : access;
}

export async function loadProjectVaultIds(
  principal: Principal,
  projectIds: number[],
): Promise<Map<number, string[]>> {
  const uniqueIds = [...new Set(projectIds)];
  if (uniqueIds.length === 0) return new Map();
  if (principal.actorType !== "system" && (!principal.userId || !principal.accountId)) return new Map();

  const ownership = principal.actorType === "system"
    ? undefined
    : and(
        eq(projectVaultMemberships.scope, "user"),
        eq(projectVaultMemberships.ownerUserId, principal.userId!),
        eq(projectVaultMemberships.accountId, principal.accountId!),
        eq(vaults.accountId, principal.accountId!),
      );
  const predicates: SQL[] = [
    inArray(projectVaultMemberships.projectId, uniqueIds),
    eq(vaults.isArchived, false),
  ];
  if (ownership) predicates.push(ownership);
  const rows = await db
    .select({ projectId: projectVaultMemberships.projectId, vaultId: projectVaultMemberships.vaultId })
    .from(projectVaultMemberships)
    .innerJoin(vaults, eq(vaults.id, projectVaultMemberships.vaultId))
    .where(and(...predicates));

  const byProject = new Map<number, string[]>();
  for (const row of rows) {
    const vaultIds = byProject.get(row.projectId) ?? [];
    vaultIds.push(row.vaultId);
    byProject.set(row.projectId, vaultIds);
  }
  for (const vaultIds of byProject.values()) vaultIds.sort();
  return byProject;
}
