import { createLogger } from "./log";

const log = createLogger("FilesIndexSchema");
const MIGRATION_LOCK_KEY = "migration.files-index-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Idempotent convergence for Files semantic-index policy tables.
 *
 * file_index_policies — vault-scoped mode (off|self|recursive) anchored to a drive_resource.
 * indexed_file_sources — materialized discovered files only (not recursive state on every child).
 * file_index_reconciliation_runs — durable run stub for folder discovery (worker lands in step 3).
 *
 * Coverage semantics (v1): a source remains indexed while any active policy covers it.
 * Turning a folder off retires only sources no longer covered elsewhere. No per-child exclusions.
 */
export async function ensureFilesIndexSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS file_index_policies (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        drive_resource_id TEXT NOT NULL REFERENCES drive_resources(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'off',
        created_by_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        updated_by_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT file_index_policies_mode_check CHECK (mode IN ('off', 'self', 'recursive'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_file_index_policies_drive_resource
      ON file_index_policies(drive_resource_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_index_policies_vault ON file_index_policies(vault_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_index_policies_account ON file_index_policies(account_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS indexed_file_sources (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        policy_id TEXT REFERENCES file_index_policies(id) ON DELETE SET NULL,
        root_drive_resource_id TEXT REFERENCES drive_resources(id) ON DELETE SET NULL,
        drive_resource_id TEXT REFERENCES drive_resources(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        provider_file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        provider_path TEXT,
        provider_parent_id TEXT,
        provider_checksum TEXT,
        provider_modified_at TIMESTAMPTZ,
        discovery_state TEXT NOT NULL DEFAULT 'active',
        title TEXT,
        one_liner TEXT,
        summary TEXT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_discovered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        retired_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT indexed_file_sources_discovery_state_check
          CHECK (discovery_state IN ('active', 'inaccessible', 'deleted', 'unsupported', 'retired')),
        CONSTRAINT indexed_file_sources_provider_check
          CHECK (provider IN ('google', 'box', 'mantra'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_indexed_file_sources_vault_provider_file
      ON indexed_file_sources(vault_id, provider, provider_file_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_indexed_file_sources_account ON indexed_file_sources(account_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_indexed_file_sources_policy ON indexed_file_sources(policy_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_indexed_file_sources_root ON indexed_file_sources(root_drive_resource_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_indexed_file_sources_drive_resource
      ON indexed_file_sources(drive_resource_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_indexed_file_sources_discovery ON indexed_file_sources(discovery_state)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS file_index_reconciliation_runs (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        policy_id TEXT NOT NULL REFERENCES file_index_policies(id) ON DELETE CASCADE,
        root_drive_resource_id TEXT NOT NULL REFERENCES drive_resources(id) ON DELETE CASCADE,
        phase TEXT NOT NULL DEFAULT 'queued',
        folders_visited INTEGER NOT NULL DEFAULT 0,
        files_discovered INTEGER NOT NULL DEFAULT 0,
        files_eligible INTEGER NOT NULL DEFAULT 0,
        files_completed INTEGER NOT NULL DEFAULT 0,
        files_unchanged INTEGER NOT NULL DEFAULT 0,
        files_unsupported INTEGER NOT NULL DEFAULT 0,
        files_failed INTEGER NOT NULL DEFAULT 0,
        discovery_cursor JSONB,
        last_error TEXT,
        started_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT file_index_reconciliation_runs_phase_check
          CHECK (phase IN ('queued', 'discovering', 'indexing', 'complete', 'partial', 'failed', 'canceled'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_index_recon_runs_policy
      ON file_index_reconciliation_runs(policy_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_index_recon_runs_account_phase
      ON file_index_reconciliation_runs(account_id, phase)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_index_recon_runs_root
      ON file_index_reconciliation_runs(root_drive_resource_id)
    `);

    await client.query(`
      COMMENT ON TABLE file_index_policies IS
      'Vault-scoped Files semantic index policy anchored to a bound drive_resource. mode=off|self|recursive. Folders are continuous selection rules, not one-shot expansions. v1 has no per-child exclusions.'
    `);
    await client.query(`
      COMMENT ON TABLE indexed_file_sources IS
      'Materialized file sources discovered under active index policies. Coverage is multi-policy: disable retires only sources not covered elsewhere. Semantic queue state lives in memory_vnext_source_queue.'
    `);
    await client.query(`
      COMMENT ON TABLE file_index_reconciliation_runs IS
      'Durable folder reconciliation run projection. Step 2 enqueues queued stubs; step 3 owns the resumable worker and counters.'
    `);

    await client.query("COMMIT");
    log.info("files index schema convergence complete");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
