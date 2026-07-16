-- Document Store Extraction Step 1
-- Add an empty ownership-safe shadow document store alongside legacy
-- memory_entries workspace rows and stale workspace_documents rows.
-- This migration intentionally does not backfill, update, delete, rename,
-- or alter either legacy source table.

CREATE TABLE IF NOT EXISTS document_store_documents (
  id SERIAL PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_table TEXT,
  source_row_id TEXT,
  path TEXT,
  title TEXT,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  vault_id TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_document_store_owner_type_id
ON document_store_documents(scope, owner_user_id, account_id, document_type, document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uk_document_store_source_row
ON document_store_documents(source_table, source_row_id);

CREATE INDEX IF NOT EXISTS idx_document_store_scope_owner
ON document_store_documents(scope, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_document_store_account
ON document_store_documents(account_id);

CREATE INDEX IF NOT EXISTS idx_document_store_vault
ON document_store_documents(vault_id);

CREATE INDEX IF NOT EXISTS idx_document_store_type_id
ON document_store_documents(document_type, document_id);

CREATE INDEX IF NOT EXISTS idx_document_store_source_row
ON document_store_documents(source_table, source_row_id);

CREATE INDEX IF NOT EXISTS idx_document_store_path
ON document_store_documents(path);

CREATE INDEX IF NOT EXISTS idx_document_store_updated_at
ON document_store_documents(updated_at);
