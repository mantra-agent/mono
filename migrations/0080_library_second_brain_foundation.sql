-- Library Second Brain foundation: explicit structural role for every Library page.
-- Vault membership already exists on library_pages via ensure-vaults; this migration
-- adds the Library-specific role discriminant without rewriting legacy pages.

ALTER TABLE library_pages
  ADD COLUMN IF NOT EXISTS structural_role TEXT NOT NULL DEFAULT 'artifact';

ALTER TABLE library_pages
  DROP CONSTRAINT IF EXISTS chk_library_pages_structural_role;

ALTER TABLE library_pages
  ADD CONSTRAINT chk_library_pages_structural_role
  CHECK (structural_role IN ('source', 'artifact', 'wiki', 'meta'));

CREATE INDEX IF NOT EXISTS idx_library_pages_structural_role
  ON library_pages(structural_role);

CREATE INDEX IF NOT EXISTS idx_library_pages_vault_role
  ON library_pages(vault_id, structural_role);
