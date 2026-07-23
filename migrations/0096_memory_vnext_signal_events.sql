CREATE TABLE IF NOT EXISTS memory_vnext_exposures (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
  context_build_id TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_exposure_build_claim
  ON memory_vnext_exposures(owner_user_id, account_id, context_build_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_exposure_claim
  ON memory_vnext_exposures(claim_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_exposure_owner
  ON memory_vnext_exposures(scope, owner_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_exposure_account
  ON memory_vnext_exposures(account_id, occurred_at);

CREATE TABLE IF NOT EXISTS memory_vnext_strength_events (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL,
  weight REAL NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_strength_event_weight_bounded CHECK (weight >= -1 AND weight <= 1),
  CONSTRAINT memory_vnext_strength_event_type_valid CHECK (event_type IN (
    'explicit_confirmation',
    'decision_use',
    'goal_relevance',
    'confirmed_recurrence',
    'contextual_importance',
    'correction'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_strength_event_replay
  ON memory_vnext_strength_events(owner_user_id, account_id, event_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_strength_event_claim
  ON memory_vnext_strength_events(claim_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_strength_event_owner
  ON memory_vnext_strength_events(scope, owner_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_strength_event_account
  ON memory_vnext_strength_events(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_strength_event_type
  ON memory_vnext_strength_events(event_type, occurred_at);

COMMENT ON COLUMN memory_vnext_claims.recall_count IS
  'Legacy compatibility telemetry only. Excluded from strength, certainty, lifecycle, retirement, deletion, and retrieval ranking.';
COMMENT ON COLUMN memory_vnext_claims.last_recalled_at IS
  'Legacy compatibility telemetry only. New passive context exposure is recorded in memory_vnext_exposures.';
