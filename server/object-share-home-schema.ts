import type { Pool } from "pg";

const MIGRATION_LOCK_KEY = "object-share-home-schema-v1";

/** Additive, replay-safe schema for recipient-local object_share Home dismissals. */
export async function ensureObjectShareHomeSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS object_share_home_dismissals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        grant_id TEXT NOT NULL,
        reason_key TEXT NOT NULL,
        dismissed_at TIMESTAMPTZ NOT NULL,
        dismissed_by_user_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT object_share_home_dismissal_grant_check CHECK (char_length(grant_id) BETWEEN 1 AND 80),
        CONSTRAINT object_share_home_dismissal_reason_check CHECK (char_length(reason_key) BETWEEN 1 AND 500)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_object_share_home_dismissal_owner_grant
      ON object_share_home_dismissals(account_id, owner_user_id, grant_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_object_share_home_dismissal_reason
      ON object_share_home_dismissals(account_id, owner_user_id, reason_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_object_share_home_dismissal_owner
      ON object_share_home_dismissals(owner_user_id, account_id, dismissed_at)
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
