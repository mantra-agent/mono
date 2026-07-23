import { and, eq, exists, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { projectVaultMemberships, projects, vaults } from "@shared/schema";
import { db, pool } from "./db";
import { createLogger } from "./log";
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

const log = createLogger("ProjectVaultAccess");
const MIGRATION_LOCK_KEY = "migration.project-vault-memberships.v1";

export async function ensureProjectVaultMembershipSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_vault_memberships (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, vault_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_vault_memberships_vault_project ON project_vault_memberships(vault_id, project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_vault_memberships_scope_owner ON project_vault_memberships(scope, owner_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_vault_memberships_account ON project_vault_memberships(account_id)`);
    const backfill = await client.query(`
      INSERT INTO project_vault_memberships (
        project_id, vault_id, scope, owner_user_id, account_id, created_by_user_id
      )
      SELECT project.id, project.vault_id, 'user', project.owner_user_id, project.account_id, project.owner_user_id
      FROM projects AS project
      JOIN vaults AS vault
        ON vault.id = project.vault_id
       AND vault.account_id = project.account_id
       AND vault.is_archived = FALSE
      WHERE project.scope = 'user'
        AND project.owner_user_id IS NOT NULL
        AND project.account_id IS NOT NULL
      ON CONFLICT (project_id, vault_id) DO NOTHING
    `);
    const unresolved = await client.query(`
      SELECT count(*)::int AS count
      FROM projects AS project
      WHERE project.scope = 'user'
        AND project.owner_user_id IS NOT NULL
        AND project.account_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM project_vault_memberships AS membership
          JOIN vaults AS vault
            ON vault.id = membership.vault_id
           AND vault.account_id = project.account_id
           AND vault.is_archived = FALSE
          WHERE membership.project_id = project.id
            AND membership.owner_user_id = project.owner_user_id
            AND membership.account_id = project.account_id
        )
    `);
    const unresolvedCount = Number(unresolved.rows[0]?.count ?? 0);
    if (unresolvedCount > 0) {
      throw new Error(`Project Vault membership convergence unresolved projects=${unresolvedCount}`);
    }
    await client.query(`COMMENT ON TABLE project_vault_memberships IS 'Canonical live Project-to-Vault membership and owner visibility authority.'`);
    await client.query(`COMMENT ON COLUMN projects.vault_id IS 'Migration-compatible primary/default Vault; project_vault_memberships owns Project visibility.'`);
    await client.query("COMMIT");
    log.info(`Project Vault membership convergence complete inserted=${backfill.rowCount ?? 0}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

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
