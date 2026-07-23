import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { objectGrants } from "@shared/schema";
import type { Principal } from "./principal";
import type { ScopeColumns } from "./scoped-storage";
import { visibleScopePredicate, writableScopePredicate } from "./scoped-storage";

export type WorkObjectType = "project" | "milestone" | "task";
export type ObjectGrantCapability = "read" | "write" | "admin";

export interface WorkObjectIdentity {
  objectType: WorkObjectType;
  objectId: SQL;
}

export interface WorkObjectColumns extends ScopeColumns {
  objectId: AnyColumn;
  projectId?: AnyColumn;
}

export function workObjectKey(objectType: WorkObjectType, objectId: number, parentProjectId?: number): string {
  if (!Number.isInteger(objectId) || objectId <= 0) throw new Error(`${objectType} id must be a positive integer`);
  if (objectType !== "milestone") return String(objectId);
  if (!Number.isInteger(parentProjectId) || (parentProjectId ?? 0) <= 0) {
    throw new Error("Milestone grants require a positive project id");
  }
  return `${parentProjectId}:${objectId}`;
}

export function workObjectIdentity(objectType: WorkObjectType, columns: WorkObjectColumns): WorkObjectIdentity {
  if (objectType === "milestone") {
    if (!columns.projectId) throw new Error("Milestone grant predicates require projectId");
    return {
      objectType,
      objectId: sql`${columns.projectId}::text || ':' || ${columns.objectId}::text`,
    };
  }
  return { objectType, objectId: sql`${columns.objectId}::text` };
}

function acceptedCapabilities(required: ObjectGrantCapability): ObjectGrantCapability[] {
  if (required === "read") return ["read", "write", "admin"];
  if (required === "write") return ["write", "admin"];
  return ["admin"];
}

export function liveObjectGrantPredicate(
  principal: Principal,
  identity: WorkObjectIdentity,
  required: ObjectGrantCapability,
): SQL {
  if (principal.actorType === "system") return sql`TRUE`;
  if (principal.actorType !== "user" || !principal.userId) return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1
    FROM ${objectGrants}
    WHERE ${objectGrants.subjectType} = 'user'
      AND ${objectGrants.subjectId} = ${principal.userId}
      AND ${objectGrants.objectType} = ${identity.objectType}
      AND ${objectGrants.objectId} = ${identity.objectId}
      AND ${objectGrants.revokedAt} IS NULL
      AND ${inArray(objectGrants.capability, acceptedCapabilities(required))}
  )`;
}

export function workObjectAccessPredicate(
  principal: Principal,
  columns: WorkObjectColumns,
  objectType: WorkObjectType,
  required: ObjectGrantCapability,
): SQL {
  const owned = required === "read"
    ? visibleScopePredicate(principal, columns)
    : writableScopePredicate(principal, columns);
  return or(owned, liveObjectGrantPredicate(principal, workObjectIdentity(objectType, columns), required))!;
}

export function combineWithWorkObjectAccess(
  principal: Principal,
  columns: WorkObjectColumns,
  objectType: WorkObjectType,
  required: ObjectGrantCapability,
  predicate?: SQL,
): SQL {
  const access = workObjectAccessPredicate(principal, columns, objectType, required);
  return predicate ? and(predicate, access)! : access;
}

export function hasAdminOnlyProjectChanges(changes: Record<string, unknown>): boolean {
  return ["title", "description", "spec", "goalId", "owner", "people", "milestones"].some(
    field => changes[field] !== undefined,
  );
}

export function hasAdminOnlyTaskChanges(changes: Record<string, unknown>): boolean {
  return ["title", "description", "owner", "projectId", "milestoneId"].some(
    field => changes[field] !== undefined,
  );
}

export function hasAdminOnlyMilestoneChanges(changes: Record<string, unknown>): boolean {
  return changes.name !== undefined;
}
