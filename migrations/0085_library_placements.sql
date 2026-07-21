-- Library2 second-brain lens: the load-bearing join between a Library page and
-- a vault's Index/Wiki structure. A placement is a lightweight join
-- (page -> vault -> index section/parent), never a copy of the page. A page is
-- "in" the second-brain lens when it has a placement row; deleting the row
-- removes it from the lens and leaves the flat Library page untouched.
-- One page, one source of truth, two views.
--
-- Additive and backwards-compatible: creates a new table only. The existing
-- flat Library (library_pages) is not altered, so import is fully reversible by
-- deleting placement rows. vault_id carries no hard FK, matching
-- library_pages.vault_id (vaults are runtime-loaded, user-owned objects).
-- page_id and parent_page_id are hard FKs to library_pages.

CREATE TABLE IF NOT EXISTS library_placements (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  index_section TEXT NOT NULL DEFAULT 'Concepts',
  parent_page_id TEXT REFERENCES library_pages(id) ON DELETE SET NULL,
  placed_by TEXT NOT NULL DEFAULT 'manual',
  confidence REAL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_library_placements_page_vault UNIQUE (page_id, vault_id),
  CONSTRAINT chk_library_placements_index_section
    CHECK (index_section IN ('Entities', 'Concepts', 'Synthesis')),
  CONSTRAINT chk_library_placements_placed_by
    CHECK (placed_by IN ('semantic', 'explicit', 'manual', 'import'))
);

CREATE INDEX IF NOT EXISTS idx_library_placements_page ON library_placements (page_id);
CREATE INDEX IF NOT EXISTS idx_library_placements_vault ON library_placements (vault_id);
CREATE INDEX IF NOT EXISTS idx_library_placements_parent ON library_placements (parent_page_id);
CREATE INDEX IF NOT EXISTS idx_library_placements_vault_section ON library_placements (vault_id, index_section);
CREATE INDEX IF NOT EXISTS idx_library_placements_scope_owner ON library_placements (scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_library_placements_account ON library_placements (account_id);
