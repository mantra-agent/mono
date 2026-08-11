import { createLogger } from "./log";

const log = createLogger("DriveResourcesSchema");
const MIGRATION_LOCK_KEY = "migration.drive-resources-schema.v3";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Idempotent convergence for drive_resources — provider-agnostic file/folder binds into a vault's
 * Files branch (Picker today; Box/Mantra later). A binding is a pointer, never a copy; unbinding
 * deletes the row and never touches the underlying provider file. Kept in its own convergence
 * module (mirrors ensureTeamsSchema) so each table owns its DDL and the boot sequence stays explicit.
 *
 * Identity is (provider, provider_file_id). Legacy google_file_id is backfilled into provider_file_id
 * and retained as a generated compatibility column for zero-downtime readers.
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
        provider TEXT NOT NULL DEFAULT 'google',
        provider_file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        resource_type TEXT NOT NULL DEFAULT 'file',
        icon_url TEXT,
        web_view_link TEXT,
        added_by_user_id VARCHAR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Additive migration from google_file_id → (provider, provider_file_id).
    await client.query(`
      DO $migration$
      BEGIN
        ALTER TABLE drive_resources ALTER COLUMN connected_account_id DROP NOT NULL;
        ALTER TABLE drive_resources ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'bind';
        ALTER TABLE drive_resources ADD COLUMN IF NOT EXISTS source_session_id TEXT;

        -- provider column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'drive_resources' AND column_name = 'provider'
        ) THEN
          ALTER TABLE drive_resources ADD COLUMN provider TEXT NOT NULL DEFAULT 'google';
        END IF;

        -- provider_file_id column (nullable first for backfill)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'drive_resources' AND column_name = 'provider_file_id'
        ) THEN
          ALTER TABLE drive_resources ADD COLUMN provider_file_id TEXT;
        END IF;

        -- Backfill provider_file_id from legacy google_file_id when present
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'drive_resources' AND column_name = 'google_file_id'
        ) THEN
          EXECUTE 'UPDATE drive_resources SET provider_file_id = google_file_id WHERE provider_file_id IS NULL AND google_file_id IS NOT NULL';
        END IF;

        -- Fail closed if any row still lacks provider_file_id (empty table is fine)
        IF EXISTS (SELECT 1 FROM drive_resources WHERE provider_file_id IS NULL) THEN
          RAISE EXCEPTION 'drive_resources.provider_file_id backfill incomplete';
        END IF;

        -- Enforce NOT NULL on provider_file_id
        ALTER TABLE drive_resources ALTER COLUMN provider_file_id SET NOT NULL;

        -- Drop legacy unique on (vault_id, google_file_id) if present
        IF EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'idx_drive_resources_vault_file_unique'
        ) THEN
          EXECUTE 'DROP INDEX IF EXISTS idx_drive_resources_vault_file_unique';
        END IF;

        -- New unique on (vault_id, provider, provider_file_id)
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'idx_drive_resources_vault_provider_file_unique'
        ) THEN
          EXECUTE 'CREATE UNIQUE INDEX idx_drive_resources_vault_provider_file_unique ON drive_resources(vault_id, provider, provider_file_id)';
        END IF;

        -- Keep google_file_id as a generated compatibility column when the physical column still exists
        -- (fresh installs never create it; existing installs keep it as a view of provider_file_id for google rows).
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'drive_resources' AND column_name = 'google_file_id'
        ) THEN
          -- Drop the physical column after backfill; public types no longer expose it.
          -- Reads that still need the Google id use provider_file_id where provider = 'google'.
          EXECUTE 'ALTER TABLE drive_resources DROP COLUMN google_file_id';
        END IF;
      END $migration$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_resource_sources (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        drive_resource_id TEXT NOT NULL REFERENCES drive_resources(id) ON DELETE CASCADE,
        session_id TEXT,
        message_id TEXT,
        source_kind TEXT NOT NULL DEFAULT 'conversation',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_resource_sources_identity ON upload_resource_sources(drive_resource_id, source_kind, session_id, message_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_upload_resource_sources_session ON upload_resource_sources(session_id)`);
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
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_resources_provider_check') THEN
          ALTER TABLE drive_resources ADD CONSTRAINT drive_resources_provider_check
            CHECK (provider IN ('google', 'box', 'mantra'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_resources_origin_check') THEN
          ALTER TABLE drive_resources ADD CONSTRAINT drive_resources_origin_check
            CHECK (origin IN ('bind', 'upload'));
        END IF;
      END $migration$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drive_resources_vault ON drive_resources(vault_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drive_resources_account ON drive_resources(account_id)`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_resources_vault_provider_file_unique ON drive_resources(vault_id, provider, provider_file_id)`,
    );
    await client.query(
      `COMMENT ON TABLE drive_resources IS 'Provider-agnostic file/folder binds into a vault Files branch. Identity is (provider, provider_file_id). A pointer, never a copy; unbinding never touches the provider file.'`,
    );
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
