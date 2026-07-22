CREATE TABLE IF NOT EXISTS inference_payload_captures (
  id UUID PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  activity TEXT,
  boundary TEXT NOT NULL,
  authority TEXT NOT NULL,
  observable_boundary TEXT NOT NULL,
  request JSONB NOT NULL,
  request_chars INTEGER NOT NULL,
  excluded_sensitive_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  residual_limitation TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  session_id TEXT,
  source TEXT
);

CREATE INDEX IF NOT EXISTS idx_inference_payload_owner_captured
  ON inference_payload_captures(owner_user_id, account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_inference_payload_session
  ON inference_payload_captures(session_id, captured_at DESC);
