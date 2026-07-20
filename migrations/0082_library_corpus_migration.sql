CREATE TABLE IF NOT EXISTS library_corpus_migration_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL,
  account_id TEXT,
  owner_user_id TEXT,
  vault_id TEXT,
  report_page_id TEXT REFERENCES library_pages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  mode TEXT NOT NULL DEFAULT 'proposal',
  total_pages INTEGER NOT NULL DEFAULT 0,
  placed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  ambiguous_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  review_gate TEXT NOT NULL DEFAULT 'human_review_required',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_library_corpus_migration_runs_status CHECK (status IN ('proposed', 'partially_applied', 'applied', 'failed')),
  CONSTRAINT chk_library_corpus_migration_runs_mode CHECK (mode IN ('proposal', 'reviewed_apply'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_library_corpus_migration_runs_owner_key
  ON library_corpus_migration_runs(account_id, owner_user_id, idempotency_key);

CREATE TABLE IF NOT EXISTS library_corpus_migration_items (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL REFERENCES library_corpus_migration_runs(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
  page_title TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  current_vault_id TEXT,
  current_parent_id TEXT,
  current_structural_role TEXT,
  proposed_vault_id TEXT,
  proposed_parent_id TEXT,
  proposed_parent_title TEXT,
  proposed_structural_role TEXT,
  outcome TEXT NOT NULL,
  ambiguity_class TEXT,
  reason TEXT NOT NULL DEFAULT '',
  confidence NUMERIC NOT NULL DEFAULT 0,
  applied_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_library_corpus_migration_items_outcome CHECK (outcome IN ('placed', 'unchanged', 'ambiguous', 'invalid'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_library_corpus_migration_items_run_page
  ON library_corpus_migration_items(run_id, page_id);
CREATE INDEX IF NOT EXISTS idx_library_corpus_migration_items_outcome
  ON library_corpus_migration_items(run_id, outcome);
