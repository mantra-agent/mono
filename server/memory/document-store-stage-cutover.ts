import { pool } from "../db";
import { createLogger } from "../log";
import { getRuntimeIdentity } from "../runtime-identity";

const log = createLogger("DocumentStoreStageCutover");
export const DOCUMENT_STORE_CUTOVER_KEY = "workspace_v1";

function isStageEnvironment(names: Array<string | null | undefined>): boolean {
  return names
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
    .some((value) => value === "stage" || value === "staging");
}

export function isStageRuntimeSync(): boolean {
  return isStageEnvironment([process.env.RAILWAY_ENVIRONMENT_NAME]);
}

/** Install the atomic workspace mirror only on stage. Production is untouched. */
export async function ensureStageDocumentStoreMirror(): Promise<void> {
  const identity = await getRuntimeIdentity();
  if (!isStageEnvironment([identity.platformEnvironmentName, identity.environmentName])) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_store_cutover_state (
        cutover_key TEXT PRIMARY KEY,
        shadow_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        read_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_reconciled_at TIMESTAMPTZ(6),
        reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(
      `INSERT INTO document_store_cutover_state (cutover_key)
       VALUES ($1)
       ON CONFLICT (cutover_key) DO NOTHING`,
      [DOCUMENT_STORE_CUTOVER_KEY],
    );
    await client.query(`
      CREATE OR REPLACE FUNCTION mirror_workspace_memory_to_document_store()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.layer = 'workspace' THEN
            DELETE FROM document_store_documents
            WHERE source_memory_entry_id = OLD.id;
          END IF;
          RETURN OLD;
        END IF;

        IF NEW.layer <> 'workspace' THEN
          IF TG_OP = 'UPDATE' AND OLD.layer = 'workspace' THEN
            DELETE FROM document_store_documents
            WHERE source_memory_entry_id = OLD.id;
          END IF;
          RETURN NEW;
        END IF;

        INSERT INTO document_store_documents (
          document_type, document_id, source_table, source_row_id,
          source_memory_entry_id, source_id, path, title, summary, one_liner,
          content, metadata, tags, scope, owner_user_id, account_id, vault_id,
          created_by_user_id, updated_by_user_id, created_at, updated_at,
          source_created_at, source_processed_at, migration_key, migrated_at
        ) VALUES (
          NEW.source,
          COALESCE(NULLIF(BTRIM(NEW.source_id), ''), 'memory-entry:' || NEW.id::text),
          'memory_entries', NEW.id::text, NEW.id, NEW.source_id, NEW.path,
          NEW.title, NEW.summary, NEW.one_liner, NEW.content,
          COALESCE(NEW.metadata, '{}'::jsonb), COALESCE(to_jsonb(NEW.tags), '[]'::jsonb),
          NEW.scope, NEW.owner_user_id, NEW.account_id, NEW.vault_id,
          NEW.created_by_user_id, NEW.updated_by_user_id, NEW.created_at,
          COALESCE(NEW.processed_at, NEW.created_at), NEW.created_at,
          NEW.processed_at, 'memory_workspace_to_document_store_v1', CURRENT_TIMESTAMP
        )
        ON CONFLICT (source_memory_entry_id)
          WHERE source_memory_entry_id IS NOT NULL
        DO UPDATE SET
          document_type = EXCLUDED.document_type,
          document_id = EXCLUDED.document_id,
          source_table = EXCLUDED.source_table,
          source_row_id = EXCLUDED.source_row_id,
          source_id = EXCLUDED.source_id,
          path = EXCLUDED.path,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          one_liner = EXCLUDED.one_liner,
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          tags = EXCLUDED.tags,
          scope = EXCLUDED.scope,
          owner_user_id = EXCLUDED.owner_user_id,
          account_id = EXCLUDED.account_id,
          vault_id = EXCLUDED.vault_id,
          created_by_user_id = EXCLUDED.created_by_user_id,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          source_created_at = EXCLUDED.source_created_at,
          source_processed_at = EXCLUDED.source_processed_at,
          source_content_hash = NULL,
          source_metadata_hash = NULL,
          source_identity_hash = NULL,
          migration_key = EXCLUDED.migration_key,
          migrated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgname = 'trg_mirror_workspace_memory'
            AND tgrelid = 'memory_entries'::regclass
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER trg_mirror_workspace_memory
          AFTER INSERT OR UPDATE OR DELETE ON memory_entries
          FOR EACH ROW
          EXECUTE FUNCTION mirror_workspace_memory_to_document_store();
        END IF;
      END
      $$
    `);
    await client.query(
      `UPDATE document_store_cutover_state
       SET shadow_writes_enabled = TRUE, read_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE cutover_key = $1`,
      [DOCUMENT_STORE_CUTOVER_KEY],
    );
    await client.query("COMMIT");
    log.info("stage workspace mirror installed");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function setStageDocumentStoreReadCutover(
  enabled: boolean,
  reconciliation: Record<string, unknown>,
): Promise<void> {
  const identity = await getRuntimeIdentity();
  if (!isStageEnvironment([identity.platformEnvironmentName, identity.environmentName])) {
    throw new Error("Document store read cutover can only change on stage");
  }
  await pool.query(
    `UPDATE document_store_cutover_state
     SET read_enabled = $2,
         last_reconciled_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE last_reconciled_at END,
         reconciliation = $3::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE cutover_key = $1 AND shadow_writes_enabled = TRUE`,
    [DOCUMENT_STORE_CUTOVER_KEY, enabled, JSON.stringify(reconciliation)],
  );
}
