ALTER TABLE indexed_content ADD COLUMN IF NOT EXISTS vault_id TEXT;
CREATE INDEX IF NOT EXISTS idx_indexed_content_vault ON indexed_content(vault_id);
