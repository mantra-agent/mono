import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("MigrateObjectAcls");

export async function addObjectAclsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS object_acls (
        object_key TEXT PRIMARY KEY,
        policy JSONB NOT NULL,
        vault_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `ALTER TABLE object_acls ADD COLUMN IF NOT EXISTS vault_id TEXT`,
    );
    log.log("Ensured object_acls table exists");
  } catch (err) {
    log.error("Failed to ensure object_acls table", err);
  }
}
