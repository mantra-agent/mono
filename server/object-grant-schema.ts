import { createLogger } from "./log";

const log = createLogger("ObjectGrantSchema");
const MIGRATION_LOCK_KEY = "migration.object-grants-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

export async function ensureObjectGrantSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_grants (
        id SERIAL PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_by_user_id TEXT NOT NULL,
        origin_type TEXT NOT NULL,
        origin_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_grants_subject_type_check') THEN
          ALTER TABLE object_grants ADD CONSTRAINT object_grants_subject_type_check CHECK (subject_type IN ('user', 'invited_subject'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_grants_object_type_check') THEN
          ALTER TABLE object_grants ADD CONSTRAINT object_grants_object_type_check CHECK (object_type IN ('project', 'milestone', 'task'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_grants_capability_check') THEN
          ALTER TABLE object_grants ADD CONSTRAINT object_grants_capability_check CHECK (capability IN ('read', 'write', 'admin'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_grants_origin_type_check') THEN
          ALTER TABLE object_grants ADD CONSTRAINT object_grants_origin_type_check CHECK (origin_type IN ('meeting', 'manual'));
        END IF;
      END $migration$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_object_grants_one_live_subject_object
      ON object_grants(subject_type, subject_id, object_type, object_id)
      WHERE revoked_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_object_grants_live_subject_object
      ON object_grants(subject_type, subject_id, object_type, object_id, capability)
      WHERE revoked_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_object_grants_live_object
      ON object_grants(object_type, object_id)
      WHERE revoked_at IS NULL
    `);
    await client.query(`COMMENT ON TABLE object_grants IS 'Canonical per-object work authorization ledger. Revocation stamps revoked_at; rows are never deleted.'`);
    await client.query(`COMMENT ON COLUMN object_grants.object_id IS 'Project/task decimal id; milestone uses project_id:milestone_id because milestone ids are project-local.'`);
    await client.query("COMMIT");
    log.info("object grant schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
