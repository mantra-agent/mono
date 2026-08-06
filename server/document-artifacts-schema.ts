import { createLogger } from "./log";

const log = createLogger("DocumentArtifactsSchema");
const MIGRATION_LOCK_KEY = "migration.document-artifacts-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = { connect: () => Promise<QueryableClient> };

export async function ensureDocumentArtifactsSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_artifacts (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        vault_id TEXT NOT NULL REFERENCES vaults(id),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('upload','generated','bound_external','url_import','session_artifact')),
        source_ref TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        title TEXT NOT NULL,
        byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
        checksum TEXT,
        object_path TEXT,
        page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
        text_extract_status TEXT NOT NULL DEFAULT 'none' CHECK (text_extract_status IN ('none','pending','ready','failed')),
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        provenance JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_document_artifacts_owner ON document_artifacts(account_id, owner_user_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_document_artifacts_vault ON document_artifacts(vault_id)");
    await client.query("COMMIT");
    log.log("document_artifacts schema ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
