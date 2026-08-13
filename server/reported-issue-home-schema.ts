import type { Pool } from "pg";

const MIGRATION_LOCK_KEY = "reported-issue-home-schema-v1";

/** Additive, replay-safe schema convergence for reported-issue Home dismissals. */
export async function ensureReportedIssueHomeSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reported_issue_home_dismissals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        issue_id TEXT NOT NULL,
        reason_key TEXT NOT NULL,
        dismissed_at TIMESTAMPTZ NOT NULL,
        dismissed_by_user_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT reported_issue_home_dismissal_issue_check CHECK (char_length(issue_id) BETWEEN 1 AND 40),
        CONSTRAINT reported_issue_home_dismissal_reason_check CHECK (char_length(reason_key) BETWEEN 1 AND 500)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_reported_issue_home_dismissal_owner_issue
      ON reported_issue_home_dismissals(account_id, owner_user_id, issue_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_reported_issue_home_dismissal_reason
      ON reported_issue_home_dismissals(account_id, owner_user_id, reason_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reported_issue_home_dismissal_owner
      ON reported_issue_home_dismissals(owner_user_id, account_id, dismissed_at)
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
