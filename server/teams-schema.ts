import { createLogger } from "./log";

const log = createLogger("TeamsSchema");
const MIGRATION_LOCK_KEY = "migration.teams-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Idempotent convergence for the teams data model.
 *
 * Teams are grant-addressable groups scoped to an account. A team never grants access by itself;
 * it is only a *subject* an object_grant can target, and membership expands the grant to member
 * users at authorize() time. Kept in its own convergence module (mirrors ensureObjectGrantSchema)
 * so the boot sequence stays explicit and each table owns its DDL.
 */
export async function ensureTeamsSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR NOT NULL,
        name TEXT NOT NULL,
        created_by_user_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.accounts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'teams_account_id_fkey'
        ) THEN
          ALTER TABLE teams ADD CONSTRAINT teams_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
        END IF;
      END $migration$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_teams_account ON teams(account_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_account_name_unique ON teams(account_id, name)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id VARCHAR NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_by_user_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_team_id_fkey') THEN
          ALTER TABLE team_members ADD CONSTRAINT team_members_team_id_fkey
            FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_role_check') THEN
          ALTER TABLE team_members ADD CONSTRAINT team_members_role_check CHECK (role IN ('admin', 'member'));
        END IF;
      END $migration$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_user_unique ON team_members(team_id, user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`);

    await client.query(`COMMENT ON TABLE teams IS 'Grant-addressable groups scoped to an account. A team is only ever an object_grant subject; membership expands the grant to member users at authorize() time.'`);
    await client.query("COMMIT");
    log.info("teams schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
