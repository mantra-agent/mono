-- Preserve the canonical Index heading path selected for a Library2 placement.
-- This lets empty Index sections exist as real destinations without inventing
-- Library pages or deriving destination availability from placement rows.

ALTER TABLE library_placements
  ADD COLUMN IF NOT EXISTS index_path TEXT;

CREATE INDEX IF NOT EXISTS idx_library_placements_vault_path
  ON library_placements (vault_id, index_path);
