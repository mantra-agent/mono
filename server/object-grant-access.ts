import { and, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { Principal } from "./principal";
import type { ScopeColumns } from "./scoped-storage";
import {
  authorizedScopePredicate,
  liveObjectGrantPredicate,
  objectGrantIdentity,
  ownedScopePredicate,
  type AuthorizableObjectType,
  type ObjectGrantIdentity,
  type ObjectRole,
  type OwnedObjectColumns,
} from "./authorize";

/**
 * Work-object access facade over the canonical authorization spine (`./authorize`).
 *
 * Projects, milestones, and tasks are the work-object subset of the canonical authorizable objects.
 * These aliases keep existing consumers (project-vault-access, object-grant-service, dashboard-activity)
 * stable while the single source of authorization logic lives in `./authorize`.
 */
export type WorkObjectType = "project" | "milestone" | "task";
export type ObjectGrantCapability = ObjectRole;
export type WorkObjectIdentity = ObjectGrantIdentity;
export interface WorkObjectColumns extends ScopeColumns {
  objectId: AnyColumn;
  projectId?: AnyColumn;
}

export { liveObjectGrantPredicate };

export function workObjectKey(objectType: WorkObjectType, objectId: number, parentProjectId?: number): string {
  if (!Number.isInteger(objectId) || objectId <= 0) throw new Error(`${objectType} id must be a positive integer`);
  if (objectType !== "milestone") return String(objectId);
  if (!Number.isInteger(parentProjectId) || (parentProjectId ?? 0) <= 0) {
    throw new Error("Milestone grants require a positive project id");
  }
  return `${parentProjectId}:${objectId}`;
}

export function workObjectIdentity(objectType: WorkObjectType, columns: WorkObjectColumns): WorkObjectIdentity {
  return objectGrantIdentity(objectType as AuthorizableObjectType, columns as OwnedObjectColumns);
}

export function workObjectAccessPredicate(
  principal: Principal,
  columns: WorkObjectColumns,
  objectType: WorkObjectType,
  required: ObjectGrantCapability,
): SQL {
  const owned = ownedScopePredicate(principal, columns as OwnedObjectColumns, required);
  return authorizedScopePredicate(principal, owned, objectType as AuthorizableObjectType, columns as OwnedObjectColumns, required);
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
  return ["title", "description", "spec", "goalId", "ownerPersonId", "people", "milestones"].some(
    field => changes[field] !== undefined,
  );
}

export function hasAdminOnlyTaskChanges(changes: Record<string, unknown>): boolean {
  return ["title", "description", "ownerPersonId", "assigneeSubjectType", "assigneeSubjectId", "projectId", "milestoneId"].some(
    field => changes[field] !== undefined,
  );
}

export function hasAdminOnlyMilestoneChanges(changes: Record<string, unknown>): boolean {
  return changes.name !== undefined || changes.ownerPersonId !== undefined;
}
