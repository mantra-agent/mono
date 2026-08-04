import { createLogger } from "./log";

const log = createLogger("DriveResourcesSchema");
const MIGRATION_LOCK_KEY = "migration.drive-resources-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Idempotent convergence for drive_resources — Google Drive files/folders bound into a vault's Files
 * branch via the Picker (drive.file scope). A binding is a pointer, never a copy; unbinding deletes
 * the row and never touches the underlying Google file. Kept in its own convergence module (mirrors
 * ensureTeamsSchema) so each table owns its DDL and the boot sequence stays explicit.
 */
export async function ensureDriveResourcesSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drive_resources (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR NOT NULL,
        vault_id TEXT NOT NULL,
        connected_account_id TEXT NOT NULL,
        google_file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        resource_type TEXT NOT NULL DEFAULT 'file',
        icon_url TEXT,
        web_view_link TEXT,
        added_by_user_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.accounts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'drive_resources_account_id_fkey'
        ) THEN
          ALTER TABLE drive_resources ADD CONSTRAINT drive_resources_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('public.vaults') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'drive_resources_vault_id_fkey'
        ) THEN
          ALTER TABLE drive_resources ADD CONSTRAINT drive_resources_vault_id_fkey
            FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_resources_resource_type_check') THEN
          ALTER TABLE drive_resources ADD CONSTRAINT drive_resources_resource_type_check
            CHECK (resource_type IN ('file', 'folder'));
        END IF;
      END $migration$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drive_resources_vault ON drive_resources(vault_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drive_resources_account ON drive_resources(account_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_resources_vault_file_unique ON drive_resources(vault_id, google_file_id)`);
    await client.query(`COMMENT ON TABLE drive_resources IS 'Google Drive files/folders bound into a vault Files branch via the Picker. A pointer, never a copy; unbinding never touches the Google file.'`);
    await client.query("COMMIT");
    log.info("drive_resources schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
