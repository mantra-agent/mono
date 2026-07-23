CREATE TABLE IF NOT EXISTS memory_vnext_predictions (
  id SERIAL PRIMARY KEY,
  replay_key TEXT NOT NULL,
  input_state_claim_ids INTEGER[] NOT NULL,
  action_claim_id INTEGER NOT NULL,
  action_mode TEXT NOT NULL,
  predicted_outcome_claim_id INTEGER,
  predicted_outcome_class TEXT NOT NULL,
  probability REAL NOT NULL,
  horizon_seconds INTEGER NOT NULL,
  expected_at TIMESTAMPTZ(6) NOT NULL,
  transition_path_id INTEGER NOT NULL,
  causal_claim_link_ids INTEGER[] NOT NULL DEFAULT '{}',
  transition_snapshot JSONB NOT NULL,
  generation_context JSONB NOT NULL,
  producer_method TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  model_version TEXT,
  generated_at TIMESTAMPTZ(6) NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_prediction_probability_bounded CHECK (probability >= 0 AND probability <= 1),
  CONSTRAINT memory_vnext_prediction_horizon_positive CHECK (horizon_seconds > 0),
  CONSTRAINT memory_vnext_prediction_action_mode_valid CHECK (action_mode IN ('observed', 'proposed')),
  CONSTRAINT memory_vnext_prediction_expected_after_generation CHECK (expected_at > generated_at),
  CONSTRAINT memory_vnext_prediction_inputs_present CHECK (cardinality(input_state_claim_ids) > 0),
  CONSTRAINT memory_vnext_prediction_outcome_present CHECK (length(trim(predicted_outcome_class)) > 0),
  CONSTRAINT memory_vnext_prediction_snapshot_present CHECK (transition_snapshot <> '{}'::jsonb),
  CONSTRAINT memory_vnext_prediction_context_present CHECK (generation_context <> '{}'::jsonb)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_prediction_replay ON memory_vnext_predictions(owner_user_id, account_id, replay_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_owner_expected ON memory_vnext_predictions(scope, owner_user_id, expected_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_account_expected ON memory_vnext_predictions(account_id, expected_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_action ON memory_vnext_predictions(action_claim_id, generated_at);

CREATE TABLE IF NOT EXISTS memory_vnext_prediction_resolutions (
  id SERIAL PRIMARY KEY,
  prediction_id INTEGER NOT NULL REFERENCES memory_vnext_predictions(id) ON DELETE RESTRICT,
  replay_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  observed_outcome_claim_id INTEGER,
  evidence_source_ref_ids INTEGER[] NOT NULL DEFAULT '{}',
  evidence_snapshot JSONB NOT NULL,
  actual_value REAL,
  brier_score REAL,
  log_score REAL,
  scoring_rule_version TEXT NOT NULL,
  resolution_method TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  supersedes_resolution_id INTEGER,
  resolved_at TIMESTAMPTZ(6) NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_prediction_resolution_outcome_valid CHECK (outcome IN ('confirmed', 'refuted', 'unobservable', 'superseded')),
  CONSTRAINT memory_vnext_prediction_resolution_actual_bounded CHECK (actual_value IS NULL OR actual_value IN (0, 1)),
  CONSTRAINT memory_vnext_prediction_resolution_brier_bounded CHECK (brier_score IS NULL OR (brier_score >= 0 AND brier_score <= 1)),
  CONSTRAINT memory_vnext_prediction_resolution_scoring_coherent CHECK (
    (outcome IN ('confirmed', 'refuted') AND actual_value IS NOT NULL AND brier_score IS NOT NULL AND log_score IS NOT NULL)
    OR (outcome IN ('unobservable', 'superseded') AND actual_value IS NULL AND brier_score IS NULL AND log_score IS NULL)
  ),
  CONSTRAINT memory_vnext_prediction_resolution_evidence_present CHECK (evidence_snapshot <> '{}'::jsonb)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_prediction_resolution_replay ON memory_vnext_prediction_resolutions(owner_user_id, account_id, replay_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_resolution_prediction ON memory_vnext_prediction_resolutions(prediction_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_resolution_owner ON memory_vnext_prediction_resolutions(scope, owner_user_id, resolved_at);

CREATE TABLE IF NOT EXISTS memory_vnext_relationship_certainty_events (
  id SERIAL PRIMARY KEY,
  prediction_id INTEGER NOT NULL REFERENCES memory_vnext_predictions(id) ON DELETE RESTRICT,
  resolution_id INTEGER NOT NULL REFERENCES memory_vnext_prediction_resolutions(id) ON DELETE RESTRICT,
  claim_link_id INTEGER NOT NULL,
  replay_key TEXT NOT NULL,
  previous_certainty REAL NOT NULL,
  delta REAL NOT NULL,
  resulting_certainty REAL NOT NULL,
  rule_version TEXT NOT NULL,
  provenance JSONB NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_relationship_certainty_previous_bounded CHECK (previous_certainty >= 0 AND previous_certainty <= 1),
  CONSTRAINT memory_vnext_relationship_certainty_delta_bounded CHECK (delta >= -0.04 AND delta <= 0.02),
  CONSTRAINT memory_vnext_relationship_certainty_result_bounded CHECK (resulting_certainty >= 0 AND resulting_certainty <= 1),
  CONSTRAINT memory_vnext_relationship_certainty_provenance_present CHECK (provenance <> '{}'::jsonb)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_relationship_certainty_event_replay ON memory_vnext_relationship_certainty_events(owner_user_id, account_id, replay_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_relationship_certainty_event_link ON memory_vnext_relationship_certainty_events(claim_link_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_relationship_certainty_event_resolution ON memory_vnext_relationship_certainty_events(resolution_id);

CREATE TABLE IF NOT EXISTS memory_vnext_prediction_runs (
  id SERIAL PRIMARY KEY,
  run_key TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scanned_paths INTEGER NOT NULL,
  generated INTEGER NOT NULL,
  abstained INTEGER NOT NULL,
  resolved INTEGER NOT NULL,
  scored INTEGER NOT NULL,
  certainty_updates INTEGER NOT NULL,
  abstention_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  producer_method TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  started_at TIMESTAMPTZ(6) NOT NULL,
  completed_at TIMESTAMPTZ(6) NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_prediction_run_counts_nonnegative CHECK (
    scanned_paths >= 0 AND generated >= 0 AND abstained >= 0 AND resolved >= 0 AND scored >= 0 AND certainty_updates >= 0
  ),
  CONSTRAINT memory_vnext_prediction_run_time_order CHECK (completed_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_prediction_run_key ON memory_vnext_prediction_runs(owner_user_id, account_id, run_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_run_owner ON memory_vnext_prediction_runs(scope, owner_user_id, completed_at);

CREATE OR REPLACE FUNCTION reject_memory_vnext_prediction_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_vnext_predictions_append_only ON memory_vnext_predictions;
CREATE TRIGGER trg_memory_vnext_predictions_append_only BEFORE UPDATE OR DELETE ON memory_vnext_predictions
FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_prediction_ledger_mutation();
DROP TRIGGER IF EXISTS trg_memory_vnext_prediction_resolutions_append_only ON memory_vnext_prediction_resolutions;
CREATE TRIGGER trg_memory_vnext_prediction_resolutions_append_only BEFORE UPDATE OR DELETE ON memory_vnext_prediction_resolutions
FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_prediction_ledger_mutation();
DROP TRIGGER IF EXISTS trg_memory_vnext_relationship_certainty_events_append_only ON memory_vnext_relationship_certainty_events;
CREATE TRIGGER trg_memory_vnext_relationship_certainty_events_append_only BEFORE UPDATE OR DELETE ON memory_vnext_relationship_certainty_events
FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_prediction_ledger_mutation();
DROP TRIGGER IF EXISTS trg_memory_vnext_prediction_runs_append_only ON memory_vnext_prediction_runs;
CREATE TRIGGER trg_memory_vnext_prediction_runs_append_only BEFORE UPDATE OR DELETE ON memory_vnext_prediction_runs
FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_prediction_ledger_mutation();

COMMENT ON TABLE memory_vnext_predictions IS 'Immutable shadow forecasts recorded before outcome evidence is visible.';
COMMENT ON TABLE memory_vnext_prediction_resolutions IS 'Append-only outcome evidence and proper scoring for immutable forecasts.';
COMMENT ON TABLE memory_vnext_relationship_certainty_events IS 'Append-only provenance for bounded prediction-derived relationship certainty updates.';
