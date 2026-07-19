ALTER TABLE document_store_cutover_state
  ADD COLUMN IF NOT EXISTS independent_writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS independent_started_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS legacy_workspace_row_count INTEGER;
