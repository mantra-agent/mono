-- Document Store Extraction Step 2
-- Add replay-safety metadata for COPY-ONLY migration from memory_entries(layer='workspace').
-- This migration is additive only. It does not mutate either legacy store.

ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_memory_entry_id INTEGER;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS one_liner TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_content_hash TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_metadata_hash TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_identity_hash TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ(6);
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS source_processed_at TIMESTAMPTZ(6);
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS migration_key TEXT;
ALTER TABLE document_store_documents ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ(6);

CREATE UNIQUE INDEX IF NOT EXISTS uk_document_store_source_memory_entry
ON document_store_documents(source_memory_entry_id)
WHERE source_memory_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_store_migration_key
ON document_store_documents(migration_key);

CREATE INDEX IF NOT EXISTS idx_document_store_source_hashes
ON document_store_documents(source_content_hash, source_metadata_hash, source_identity_hash);

CREATE TABLE IF NOT EXISTS document_store_migration_runs (
  id TEXT PRIMARY KEY,
  migration_key TEXT NOT NULL,
  status TEXT NOT NULL,
  batch_size INTEGER NOT NULL,
  high_water_start INTEGER NOT NULL DEFAULT 0,
  high_water_end INTEGER NOT NULL DEFAULT 0,
  source_max_id INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(6)
);

CREATE INDEX IF NOT EXISTS idx_document_store_migration_runs_key_status
ON document_store_migration_runs(migration_key, status, high_water_end);

CREATE TABLE IF NOT EXISTS document_store_migration_conflicts (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES document_store_migration_runs(id) ON DELETE CASCADE,
  migration_key TEXT NOT NULL,
  source_memory_entry_id INTEGER NOT NULL,
  target_document_store_id INTEGER,
  conflict_type TEXT NOT NULL,
  source_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_store_migration_conflicts_run
ON document_store_migration_conflicts(run_id);

CREATE INDEX IF NOT EXISTS idx_document_store_migration_conflicts_source
ON document_store_migration_conflicts(source_memory_entry_id);
