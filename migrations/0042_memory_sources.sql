CREATE TABLE IF NOT EXISTS memory_sources (
  id SERIAL PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'extracted_from',
  context TEXT NOT NULL DEFAULT '',
  quote TEXT,
  span_start INTEGER,
  span_end INTEGER,
  strength REAL NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_memory_sources_ref UNIQUE (memory_id, source_type, source_id, relationship)
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_memory ON memory_sources(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_source ON memory_sources(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_relationship ON memory_sources(relationship);
CREATE INDEX IF NOT EXISTS idx_memory_sources_scope_owner ON memory_sources(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_account ON memory_sources(account_id);

INSERT INTO memory_sources (
  memory_id,
  source_type,
  source_id,
  relationship,
  context,
  strength,
  scope,
  owner_user_id,
  account_id,
  created_by_user_id,
  updated_by_user_id,
  created_at
)
SELECT
  me.id,
  me.source,
  me.source_id,
  'extracted_from',
  'Backfilled from legacy memory_entries.source/source_id',
  1,
  me.scope,
  me.owner_user_id,
  me.account_id,
  me.created_by_user_id,
  me.updated_by_user_id,
  COALESCE(me.created_at, CURRENT_TIMESTAMP)
FROM memory_entries me
WHERE me.source_id IS NOT NULL AND me.source_id <> ''
ON CONFLICT (memory_id, source_type, source_id, relationship) DO NOTHING;
