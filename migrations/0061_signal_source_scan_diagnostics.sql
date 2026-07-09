CREATE TABLE IF NOT EXISTS signal_source_scan_diagnostics (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id text NOT NULL REFERENCES scan_runs(id),
  source_id text REFERENCES signal_sources(id),
  source_type text NOT NULL,
  source_value text NOT NULL,
  adapter_status text NOT NULL,
  fetched_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  persisted_count integer NOT NULL DEFAULT 0,
  surfaced_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  rejected_by_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  scope text NOT NULL DEFAULT 'user',
  owner_user_id text,
  account_id text
);

CREATE INDEX IF NOT EXISTS idx_signal_source_diag_scan_run ON signal_source_scan_diagnostics(scan_run_id);
CREATE INDEX IF NOT EXISTS idx_signal_source_diag_source_started ON signal_source_scan_diagnostics(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_source_diag_scope_owner ON signal_source_scan_diagnostics(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_signal_source_diag_account ON signal_source_scan_diagnostics(account_id);
