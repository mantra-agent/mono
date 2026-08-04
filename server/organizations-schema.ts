import { createLogger } from "./log";

const log = createLogger("OrganizationsSchema");
const MIGRATION_LOCK_KEY = "migration.organizations-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Idempotent convergence for the organizations data model.
 *
 * An organization is a cross-account billing collection of member users and a grant-addressable
 * subject. Unlike a team (which lives inside one account, many-to-many members), an org sits above
 * accounts and a user belongs to at most one org (0..1) — enforced by a unique index on
 * organization_members.user_id so "one billing home per user" is a structural truth, not a guard.
 * An org never grants access by itself; it is only a *subject* an object_grant can target, and
 * membership expands the grant to member users at authorize() time. Kept in its own convergence
 * module (mirrors ensureTeamsSchema) so the boot sequence stays explicit and each table owns its DDL.
 */
export async function ensureOrganizationsSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        owner_user_id VARCHAR,
        billing_email TEXT,
        created_by_user_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'organizations_owner_user_id_fkey'
        ) THEN
          ALTER TABLE organizations ADD CONSTRAINT organizations_owner_user_id_fkey
            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $migration$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_members (
        id SERIAL PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id VARCHAR NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_by_user_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_organization_id_fkey') THEN
          ALTER TABLE organization_members ADD CONSTRAINT organization_members_organization_id_fkey
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_role_check') THEN
          ALTER TABLE organization_members ADD CONSTRAINT organization_members_role_check CHECK (role IN ('admin', 'member'));
        END IF;
      END $migration$
    `);
    // 0..1 org per user: a user can be a member of at most one organization (their billing home).
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_user_unique ON organization_members(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id)`);

    await client.query(`COMMENT ON TABLE organizations IS 'Cross-account billing collection of member users and a grant-addressable subject. An org is only ever an object_grant subject; membership (0..1 per user) expands the grant to member users at authorize() time.'`);
    await client.query("COMMIT");
    log.info("organizations schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
