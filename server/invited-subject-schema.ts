import { createLogger } from "./log";

const log = createLogger("InvitedSubjectSchema");
const MIGRATION_LOCK_KEY = "migration.invited-subject-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

export async function ensureInvitedSubjectSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS invited_subjects (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        normalized_email TEXT NOT NULL,
        display_label TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        claimed_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invited_subjects_email_normalized_check') THEN
          ALTER TABLE invited_subjects ADD CONSTRAINT invited_subjects_email_normalized_check CHECK (
            normalized_email = LOWER(BTRIM(normalized_email)) AND NULLIF(BTRIM(normalized_email), '') IS NOT NULL
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invited_subjects_claim_pair_check') THEN
          ALTER TABLE invited_subjects ADD CONSTRAINT invited_subjects_claim_pair_check CHECK (
            (claimed_by_user_id IS NULL AND claimed_at IS NULL)
            OR (claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL)
          );
        END IF;
      END $migration$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invited_subjects_normalized_email_unique ON invited_subjects(normalized_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invited_subjects_claimed_user ON invited_subjects(claimed_by_user_id)`);
    await client.query(`COMMENT ON TABLE invited_subjects IS 'Global pre-account security subjects. No credentials, profile, account, Vault, or Person data.'`);
    await client.query(`COMMENT ON COLUMN invited_subjects.normalized_email IS 'Verified registration claim key normalized by the canonical auth email helper.'`);
    await client.query("COMMIT");
    log.info("invited subject schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
