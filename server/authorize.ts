import { and, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { objectGrants } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import type { Principal } from "./principal";
import type { ScopeColumns } from "./scoped-storage";
import { visibleScopePredicate, writableScopePredicate } from "./scoped-storage";

/**
 * Canonical authorization spine.
 *
 * Spec: Sharing Architecture — authorize spine "vault gate -> ownership -> direct/team grant".
 * `object_grants` is the sole ACL primitive. Every read/write path that must honor cross-user
 * sharing routes through exactly one of:
 *   - authorizedScopePredicate(...) — the list/query form (owned-scope OR direct/tree/vault grant), or
 *   - liveObjectGrantPredicate(...) — the single-object existence form.
 *
 * The caller supplies the vault-gated ownership predicate (the "vault gate -> ownership" half);
 * this module ORs in the grant half. Ownership predicates already encode the vault
 * gate, so a grant is the only way a non-owner reaches an object outside their own scope.
 * A live `library_page` grant covers that page and its live descendants. It does not
 * pull invisible ancestors or siblings. Placement (`parent_id`) stays the owner's.
 *
 * Team/organization subjects slot in later at `subjectMatchPredicate` (the membership-expansion
 * seam) without changing a single call site.
 */

export type ObjectRole = "read" | "write" | "admin";

/**
 * Objects the grant primitive can protect. Ships with user subjects only; the object_type set is
 * the single source shared with `objectGrantObjectTypes` in shared/schema.ts.
 */
export type AuthorizableObjectType = "project" | "milestone" | "task" | "library_page" | "vault" | "drive_resource";

export interface ObjectGrantIdentity {
  objectType: AuthorizableObjectType;
  objectId: SQL;
}

export interface OwnedObjectColumns extends ScopeColumns {
  objectId: AnyColumn;
  /** Required only for project-local ids (milestones), whose grant key is `${projectId}:${id}`. */
  projectId?: AnyColumn;
  /**
   * The object's vault. When present, a live grant on this vault (`('vault', vaultId)`) also
   * authorizes the object — the "vault gate": sharing a vault reaches everything inside it.
   */
  vaultId?: AnyColumn;
}

/** Roles that satisfy a required minimum. Higher privilege implies every lower one. */
export function acceptedRoles(required: ObjectRole): ObjectRole[] {
  if (required === "read") return ["read", "write", "admin"];
  if (required === "write") return ["write", "admin"];
  return ["admin"];
}

/**
 * Build the grant `object_id` key for an object. Milestone ids are project-local, so their key is
 * the composite `${projectId}:${milestoneId}`; every other object type keys on its own id text.
 */
export function objectGrantIdentity(objectType: AuthorizableObjectType, columns: OwnedObjectColumns): ObjectGrantIdentity {
  if (objectType === "milestone") {
    if (!columns.projectId) throw new Error("Milestone grant predicates require projectId");
    return { objectType, objectId: sql`${columns.projectId}::text || ':' || ${columns.objectId}::text` };
  }
  return { objectType, objectId: sql`${columns.objectId}::text` };
}

/**
 * Membership-expansion seam. A principal matches its own `('user', userId)` grants, plus any
 * `('team', teamId)` grant for an account-scoped team it belongs to. Team membership is expanded live
 * only while the user also retains membership in the Team's owning Account, so either revocation
 * immediately removes team-derived access — every call site keeps working unchanged. Organization
 * subjects are intentionally cross-account and expand through their separate ownership contract.
 */
function subjectMatchPredicate(principal: Principal): SQL {
  return sql`(
    (${objectGrants.subjectType} = 'user' AND ${objectGrants.subjectId} = ${principal.userId})
    OR (${objectGrants.subjectType} = 'team' AND EXISTS (
      SELECT 1
      FROM team_members tm
      INNER JOIN teams t ON t.id = tm.team_id
      INNER JOIN memberships am ON am.account_id = t.account_id AND am.user_id = tm.user_id
      WHERE tm.team_id = ${objectGrants.subjectId}
        AND tm.user_id = ${principal.userId}
    ))
    OR (${objectGrants.subjectType} = 'organization' AND EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = ${objectGrants.subjectId}
        AND om.user_id = ${principal.userId}
    ))
  )`;
}

/** Does the principal hold a live direct grant on this object at >= the required role? */
export function liveObjectGrantPredicate(
  principal: Principal,
  identity: ObjectGrantIdentity,
  required: ObjectRole,
): SQL {
  if (principal.actorType === "system") return sql`TRUE`;
  if (principal.actorType !== "user" || !principal.userId) return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1
    FROM ${objectGrants}
    WHERE ${subjectMatchPredicate(principal)}
      AND ${objectGrants.objectType} = ${identity.objectType}
      AND ${objectGrants.objectId} = ${identity.objectId}
      AND ${objectGrants.revokedAt} IS NULL
      AND ${inArray(objectGrants.capability, acceptedRoles(required))}
  )`;
}

/**
 * The vault gate: does the principal hold a live grant on the object's vault at >= the required role?
 * A vault grant is stored as `('vault', vaultId)`; granting a vault therefore reaches every object
 * carrying that vault_id without per-object grants. Revoking the vault grant revokes them all at once.
 */
export function liveVaultGatePredicate(principal: Principal, vaultIdColumn: AnyColumn, required: ObjectRole): SQL {
  if (principal.actorType === "system") return sql`TRUE`;
  if (principal.actorType !== "user" || !principal.userId) return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1
    FROM ${objectGrants}
    WHERE ${subjectMatchPredicate(principal)}
      AND ${objectGrants.objectType} = 'vault'
      AND ${objectGrants.objectId} = ${vaultIdColumn}::text
      AND ${objectGrants.revokedAt} IS NULL
      AND ${inArray(objectGrants.capability, acceptedRoles(required))}
  )`;
}

/**
 * Folder-descendant grant cascade — TEMPORARILY DISABLED (returns FALSE).
 *
 * The prior implementation built a correlated RECURSIVE CTE whose base case was
 * `WHERE library_pages.id = <outer library_pages.id>`. Because the CTE's own
 * `FROM library_pages` reused the same table name, the outer-row correlation was
 * shadowed and the base case resolved to `library_pages.id = library_pages.id` —
 * trivially true for EVERY row. The `EXISTS` therefore returned true for every
 * candidate page whenever the recipient held any single live `library_page`
 * grant, exposing the entire `library_pages` table across all owners/accounts.
 *
 * Returning FALSE removes only the folder -> descendant cascade. Direct grants on
 * an exact page/file are unaffected: they authorize correctly through
 * `liveObjectGrantPredicate`, which matches the exact `object_id`. A correctly
 * correlated descendant walk (aliasing the CTE tables so the outer reference is
 * not shadowed) will be reintroduced under review in a follow-up.
 */
export function liveLibraryPageTreeGrantPredicate(
  _principal: Principal,
  _pageIdColumn: AnyColumn,
  _required: ObjectRole,
): SQL {
  return sql`FALSE`;
}

/** Default owned-scope predicate for objects whose vault gate is the scope columns themselves. */
export function ownedScopePredicate(principal: Principal, columns: OwnedObjectColumns, required: ObjectRole): SQL {
  return required === "read"
    ? visibleScopePredicate(principal, columns)
    : writableScopePredicate(principal, columns);
}

/**
 * Canonical list/query authorization predicate: vault-gated ownership OR a live direct grant.
 *
 * `ownedPredicate` is the caller's vault-gated ownership predicate (e.g. `combineWithVisibleScope`
 * for library pages, `visibleScopePredicate`/`ownedScopePredicate` for work objects). This is the
 * single path every scoped read/write that honors sharing must funnel through.
 */
export function authorizedScopePredicate(
  principal: Principal,
  ownedPredicate: SQL,
  objectType: AuthorizableObjectType,
  columns: OwnedObjectColumns,
  required: ObjectRole,
): SQL {
  const grant = liveObjectGrantPredicate(principal, objectGrantIdentity(objectType, columns), required);
  // Vault gate: when the object carries a vault_id, a live grant on that vault also authorizes it.
  const parts = [ownedPredicate, grant];
  if (objectType === "library_page") {
    parts.push(liveLibraryPageTreeGrantPredicate(principal, columns.objectId, required));
  }
  if (columns.vaultId) parts.push(liveVaultGatePredicate(principal, columns.vaultId, required));
  return or(...parts)!;
}

/** Convenience combiner: AND an extra predicate onto the canonical authorization predicate. */
export function combineWithAuthorizedScope(
  principal: Principal,
  ownedPredicate: SQL,
  objectType: AuthorizableObjectType,
  columns: OwnedObjectColumns,
  required: ObjectRole,
  predicate?: SQL,
): SQL {
  const access = authorizedScopePredicate(principal, ownedPredicate, objectType, columns, required);
  return predicate ? and(predicate, access)! : access;
}
