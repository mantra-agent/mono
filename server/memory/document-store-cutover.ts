import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("DocumentStoreCutover");
export const DOCUMENT_STORE_CUTOVER_KEY = "workspace_v1";

type CutoverState = {
  shadow_writes_enabled: boolean;
  read_enabled: boolean;
  independent_writes_enabled: boolean;
  independent_activation_requested_at?: Date | null;
  independent_started_at?: Date | null;
  legacy_workspace_row_count?: number | null;
};

async function readCutoverState(client: { query: typeof pool.query }): Promise<CutoverState | null> {
  const state = await client.query<CutoverState>(
    `SELECT shadow_writes_enabled, read_enabled, independent_writes_enabled,
            independent_activation_requested_at, independent_started_at, legacy_workspace_row_count
     FROM document_store_cutover_state
     WHERE cutover_key = $1`,
    [DOCUMENT_STORE_CUTOVER_KEY],
  );
  return state.rows[0] ?? null;
}

let independentEnabled = false;

/** PostgreSQL is authoritative. False is never cached across requests. */
export async function documentStoreIndependentWritesEnabled(): Promise<boolean> {
  if (independentEnabled) return true;
  const state = await readCutoverState(pool);
  independentEnabled = state?.independent_writes_enabled === true;
  return independentEnabled;
}

export async function documentStoreIndependentActivationRequested(): Promise<boolean> {
  const state = await readCutoverState(pool);
  return state?.independent_activation_requested_at != null;
}

export async function requestIndependentDocumentStoreActivation(): Promise<void> {
  const result = await pool.query(
    `UPDATE document_store_cutover_state
     SET independent_activation_requested_at = COALESCE(independent_activation_requested_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE cutover_key = $1
       AND shadow_writes_enabled = TRUE
       AND read_enabled = TRUE
       AND independent_writes_enabled = FALSE`,
    [DOCUMENT_STORE_CUTOVER_KEY],
  );
  if (result.rowCount !== 1) {
    const state = await readCutoverState(pool);
    if (state?.independent_writes_enabled) return;
    throw new Error("Independent activation request requires a reconciled document-store cutover");
  }
  log.info("independent document-store activation requested; restart required");
}

export async function enableIndependentDocumentStore(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "document_store_workspace_independent_v1",
    ]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS document_store_cutover_state (
        cutover_key TEXT PRIMARY KEY,
        shadow_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        read_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        independent_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        independent_activation_requested_at TIMESTAMPTZ(6),
        independent_started_at TIMESTAMPTZ(6),
        legacy_workspace_row_count INTEGER,
        last_reconciled_at TIMESTAMPTZ(6),
        reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    await client.query(
      `ALTER TABLE document_store_cutover_state
       ADD COLUMN IF NOT EXISTS independent_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS independent_activation_requested_at TIMESTAMPTZ(6),
       ADD COLUMN IF NOT EXISTS independent_started_at TIMESTAMPTZ(6),
       ADD COLUMN IF NOT EXISTS legacy_workspace_row_count INTEGER`,
    );
    const state = await client.query<CutoverState>(
      `SELECT shadow_writes_enabled, read_enabled, independent_writes_enabled,
              independent_activation_requested_at, independent_started_at, legacy_workspace_row_count
       FROM document_store_cutover_state
       WHERE cutover_key = $1
       FOR UPDATE`,
      [DOCUMENT_STORE_CUTOVER_KEY],
    );
    const current = state.rows[0];
    if (!current) {
      throw new Error("Document-store cutover state is missing; independent mode requires a completed cutover");
    }

    if (!current.independent_writes_enabled) {
      if (!current.independent_activation_requested_at) {
        throw new Error("Independent activation has not been requested in PostgreSQL");
      }
      if (!current.shadow_writes_enabled || !current.read_enabled) {
        throw new Error("Independent mode requires active shadow writes and reconciled target reads");
      }
      await client.query("LOCK TABLE memory_entries IN ACCESS EXCLUSIVE MODE");
      await client.query("LOCK TABLE document_store_documents IN ACCESS EXCLUSIVE MODE");
      const gate = await client.query<{
        source_count: number;
        target_count: number;
        mismatch_count: number;
        conflict_count: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM memory_entries WHERE layer = 'workspace') AS source_count,
          (SELECT COUNT(*)::int FROM document_store_documents WHERE source_memory_entry_id IS NOT NULL) AS target_count,
          (SELECT COUNT(*)::int
           FROM memory_entries m
           FULL OUTER JOIN document_store_documents d ON d.source_memory_entry_id = m.id
           WHERE (m.layer = 'workspace' OR d.source_memory_entry_id IS NOT NULL)
             AND (
               m.id IS NULL OR d.id IS NULL OR m.layer IS DISTINCT FROM 'workspace' OR
               m.source IS DISTINCT FROM d.document_type OR
               COALESCE(NULLIF(BTRIM(m.source_id), ''), 'memory-entry:' || m.id::text) IS DISTINCT FROM d.document_id OR
               m.source_id IS DISTINCT FROM d.source_id OR m.path IS DISTINCT FROM d.path OR
               m.title IS DISTINCT FROM d.title OR m.summary IS DISTINCT FROM d.summary OR
               m.one_liner IS DISTINCT FROM d.one_liner OR m.content IS DISTINCT FROM d.content OR
               COALESCE(m.metadata, '{}'::jsonb) IS DISTINCT FROM d.metadata OR
               COALESCE(to_jsonb(m.tags), '[]'::jsonb) IS DISTINCT FROM d.tags OR
               m.scope IS DISTINCT FROM d.scope OR m.owner_user_id IS DISTINCT FROM d.owner_user_id OR
               m.account_id IS DISTINCT FROM d.account_id OR m.vault_id IS DISTINCT FROM d.vault_id OR
               m.created_by_user_id IS DISTINCT FROM d.created_by_user_id OR
               m.updated_by_user_id IS DISTINCT FROM d.updated_by_user_id OR
               m.created_at IS DISTINCT FROM d.source_created_at OR
               m.processed_at IS DISTINCT FROM d.source_processed_at
             )) AS mismatch_count,
          (SELECT COUNT(*)::int FROM document_store_migration_conflicts
           WHERE migration_key = 'memory_workspace_to_document_store_v1') AS conflict_count
      `);
      const proof = gate.rows[0];
      if (
        !proof ||
        proof.source_count !== proof.target_count ||
        proof.mismatch_count !== 0 ||
        proof.conflict_count !== 0
      ) {
        throw new Error(`Independent document-store gate failed: ${JSON.stringify(proof)}`);
      }

      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('document_store_documents', 'id'),
          GREATEST(
            COALESCE((SELECT MAX(id) FROM document_store_documents), 1),
            COALESCE((SELECT MAX(source_memory_entry_id) FROM document_store_documents), 1)
          ),
          TRUE
        )
      `);
      await client.query("DROP TRIGGER IF EXISTS trg_mirror_workspace_memory ON memory_entries");
      await client.query(`
        CREATE OR REPLACE FUNCTION reject_legacy_workspace_mutation()
        RETURNS TRIGGER AS $$
        BEGIN
          IF (TG_OP = 'INSERT' AND NEW.layer = 'workspace') OR
             (TG_OP = 'UPDATE' AND (OLD.layer = 'workspace' OR NEW.layer = 'workspace')) OR
             (TG_OP = 'DELETE' AND OLD.layer = 'workspace') THEN
            RAISE EXCEPTION 'legacy workspace mutation rejected: document_store_documents is authoritative';
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query("DROP TRIGGER IF EXISTS trg_reject_legacy_workspace_mutation ON memory_entries");
      await client.query(`
        CREATE TRIGGER trg_reject_legacy_workspace_mutation
        BEFORE INSERT OR UPDATE OR DELETE ON memory_entries
        FOR EACH ROW EXECUTE FUNCTION reject_legacy_workspace_mutation()
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION reject_legacy_memory_truncate()
        RETURNS TRIGGER AS $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM document_store_cutover_state
            WHERE cutover_key = 'workspace_v1' AND independent_writes_enabled = TRUE
          ) THEN
            RAISE EXCEPTION 'memory_entries truncate rejected after independent document cutover';
          END IF;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query("DROP TRIGGER IF EXISTS trg_reject_legacy_memory_truncate ON memory_entries");
      await client.query(`
        CREATE TRIGGER trg_reject_legacy_memory_truncate
        BEFORE TRUNCATE ON memory_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_legacy_memory_truncate()
      `);
      await client.query(
        `UPDATE document_store_cutover_state
         SET shadow_writes_enabled = FALSE,
             read_enabled = TRUE,
             independent_writes_enabled = TRUE,
             independent_started_at = COALESCE(independent_started_at, CURRENT_TIMESTAMP),
             legacy_workspace_row_count = COALESCE(legacy_workspace_row_count, $2),
             updated_at = CURRENT_TIMESTAMP
         WHERE cutover_key = $1
           AND independent_writes_enabled = FALSE
           AND independent_activation_requested_at IS NOT NULL`,
        [DOCUMENT_STORE_CUTOVER_KEY, proof.source_count],
      );
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_store_independent_state_valid') THEN
            ALTER TABLE document_store_cutover_state
              ADD CONSTRAINT document_store_independent_state_valid CHECK (
                NOT independent_writes_enabled OR (
                  shadow_writes_enabled = FALSE AND read_enabled = TRUE AND
                  independent_started_at IS NOT NULL AND legacy_workspace_row_count IS NOT NULL
                )
              );
          END IF;
        END $$
      `);
      const catalog = await client.query<{ mirror_count: number; row_guard_count: number; truncate_guard_count: number }>(`
        SELECT
          COUNT(*) FILTER (WHERE tgname = 'trg_mirror_workspace_memory' AND NOT tgisinternal)::int AS mirror_count,
          COUNT(*) FILTER (WHERE tgname = 'trg_reject_legacy_workspace_mutation' AND tgenabled <> 'D' AND NOT tgisinternal)::int AS row_guard_count,
          COUNT(*) FILTER (WHERE tgname = 'trg_reject_legacy_memory_truncate' AND tgenabled <> 'D' AND NOT tgisinternal)::int AS truncate_guard_count
        FROM pg_trigger WHERE tgrelid = 'memory_entries'::regclass
      `);
      const triggerProof = catalog.rows[0];
      if (!triggerProof || triggerProof.mirror_count !== 0 || triggerProof.row_guard_count !== 1 || triggerProof.truncate_guard_count !== 1) {
        throw new Error(`Independent trigger catalog assertion failed: ${JSON.stringify(triggerProof)}`);
      }
      independentEnabled = true;
      log.info("document store independent write ownership enabled", { proof, triggerProof });
    } else {
      await client.query(
        `UPDATE document_store_cutover_state
         SET shadow_writes_enabled = FALSE, read_enabled = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE cutover_key = $1`,
        [DOCUMENT_STORE_CUTOVER_KEY],
      );
      log.info("document store independent write ownership already enabled");
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Install the atomic compatibility mirror until PostgreSQL records independent
 * ownership. The persisted epoch is the only authority; deployment variables
 * cannot enable, disable, or roll back this transition.
 */
export async function ensureDocumentStoreMirror(): Promise<void> {
  const persisted = await readCutoverState(pool);
  if (persisted?.independent_writes_enabled) {
    await enableIndependentDocumentStore();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_store_cutover_state (
        cutover_key TEXT PRIMARY KEY,
        shadow_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        read_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        independent_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        independent_activation_requested_at TIMESTAMPTZ(6),
        independent_started_at TIMESTAMPTZ(6),
        legacy_workspace_row_count INTEGER,
        last_reconciled_at TIMESTAMPTZ(6),
        reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(
      `ALTER TABLE document_store_cutover_state
       ADD COLUMN IF NOT EXISTS independent_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS independent_activation_requested_at TIMESTAMPTZ(6)`,
    );
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
        IF NOT EXISTS (
          SELECT 1
          FROM document_store_cutover_state
          WHERE cutover_key = 'workspace_v1'
            AND shadow_writes_enabled = TRUE
        ) THEN
          IF TG_OP = 'DELETE' THEN
            RETURN OLD;
          END IF;
          RETURN NEW;
        END IF;

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
       SET shadow_writes_enabled = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE cutover_key = $1`,
      [DOCUMENT_STORE_CUTOVER_KEY],
    );
    await client.query("COMMIT");
    log.info("workspace mirror installed pending database-owned activation");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function setDocumentStoreReadCutover(
  enabled: boolean,
  reconciliation: Record<string, unknown>,
): Promise<void> {
  const result = await pool.query(
    `UPDATE document_store_cutover_state
     SET read_enabled = $2,
         last_reconciled_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE last_reconciled_at END,
         reconciliation = $3::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE cutover_key = $1 AND shadow_writes_enabled = TRUE`,
    [DOCUMENT_STORE_CUTOVER_KEY, enabled, JSON.stringify(reconciliation)],
  );
  if (result.rowCount !== 1) {
    throw new Error("Document-store cutover state is missing or shadow writes are disabled");
  }
}
