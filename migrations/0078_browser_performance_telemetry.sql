CREATE TABLE IF NOT EXISTS browser_performance_telemetry (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  route_key TEXT,
  session_id TEXT,
  client_turn_id TEXT,
  bucket TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_browser_perf_scope_owner ON browser_performance_telemetry(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_browser_perf_account_received ON browser_performance_telemetry(account_id, received_at);
CREATE INDEX IF NOT EXISTS idx_browser_perf_kind_received ON browser_performance_telemetry(kind, received_at);
CREATE INDEX IF NOT EXISTS idx_browser_perf_session ON browser_performance_telemetry(session_id, received_at);
CREATE INDEX IF NOT EXISTS idx_browser_perf_retention ON browser_performance_telemetry(received_at);
