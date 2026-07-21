-- Durable session-scoped compaction ownership and replay-safe archive identity.
-- Additive and backward-compatible: existing session documents and archives remain valid.

CREATE TABLE IF NOT EXISTS compaction_operations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  vault_id TEXT,
  session_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  boundary_hash TEXT NOT NULL,
  last_removed_message_id TEXT NOT NULL,
  removed_message_ids JSONB NOT NULL,
  kept_message_ids JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  owner_boot_id TEXT NOT NULL,
  caller_generation INTEGER,
  lease_expires_at TIMESTAMPTZ(6) NOT NULL,
  heartbeat_at TIMESTAMPTZ(6) NOT NULL,
  archive_ref_id TEXT,
  archive_object_path TEXT,
  marker_id TEXT,
  summary_kind TEXT,
  summary_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  segment_count INTEGER,
  model_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  archive_bytes INTEGER,
  outcome TEXT,
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(6),
  CONSTRAINT compaction_operation_status_check CHECK (
    status IN ('claimed', 'archiving', 'summarizing', 'ready', 'committed', 'superseded', 'failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_compaction_operation_snapshot
  ON compaction_operations(owner_user_id, account_id, session_id, snapshot_hash);

CREATE UNIQUE INDEX IF NOT EXISTS uk_compaction_active_session
  ON compaction_operations(owner_user_id, account_id, session_id)
  WHERE status IN ('claimed', 'archiving', 'summarizing', 'ready');

CREATE INDEX IF NOT EXISTS idx_compaction_operation_session
  ON compaction_operations(owner_user_id, account_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_compaction_operation_lease
  ON compaction_operations(status, lease_expires_at);

ALTER TABLE indexed_content
  ADD COLUMN IF NOT EXISTS operation_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uk_indexed_content_operation
  ON indexed_content(owner_user_id, principal_account_id, source_type, operation_key)
  WHERE operation_key IS NOT NULL;
