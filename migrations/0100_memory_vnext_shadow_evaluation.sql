CREATE TABLE IF NOT EXISTS memory_vnext_retrieval_controls (
  id SERIAL PRIMARY KEY,
  retrieval_mode TEXT NOT NULL DEFAULT 'compatibility',
  prediction_output_mode TEXT NOT NULL DEFAULT 'shadow',
  reason TEXT NOT NULL DEFAULT 'default_off',
  scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT,
  created_by_user_id TEXT, updated_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_retrieval_control_mode_valid CHECK (retrieval_mode IN ('compatibility', 'corrected')),
  CONSTRAINT memory_vnext_prediction_output_shadow_only CHECK (prediction_output_mode = 'shadow')
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_retrieval_control_owner ON memory_vnext_retrieval_controls(owner_user_id, account_id);

CREATE TABLE IF NOT EXISTS memory_vnext_retrieval_activation_events (
  id SERIAL PRIMARY KEY, replay_key TEXT NOT NULL, previous_mode TEXT NOT NULL, next_mode TEXT NOT NULL,
  reason TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT,
  created_by_user_id TEXT, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_activation_event_modes_valid CHECK (previous_mode IN ('compatibility', 'corrected') AND next_mode IN ('compatibility', 'corrected'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_activation_event_replay ON memory_vnext_retrieval_activation_events(owner_user_id, account_id, replay_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_activation_event_owner ON memory_vnext_retrieval_activation_events(scope, owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS memory_vnext_retrieval_labels (
  id SERIAL PRIMARY KEY, context_key TEXT NOT NULL, claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
  relevance TEXT NOT NULL, durable_fact BOOLEAN NOT NULL DEFAULT FALSE, note TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT, created_by_user_id TEXT, updated_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_retrieval_label_relevance_valid CHECK (relevance IN ('relevant', 'irrelevant'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_retrieval_label ON memory_vnext_retrieval_labels(owner_user_id, account_id, context_key, claim_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_retrieval_label_context ON memory_vnext_retrieval_labels(scope, owner_user_id, context_key);

CREATE TABLE IF NOT EXISTS memory_vnext_retrieval_evaluation_runs (
  id SERIAL PRIMARY KEY, replay_key TEXT NOT NULL, context_build_id TEXT NOT NULL, context_key TEXT NOT NULL,
  selected_mode TEXT NOT NULL, compatibility_claim_ids INTEGER[] NOT NULL DEFAULT '{}', corrected_claim_ids INTEGER[] NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL, dimension_contributions JSONB NOT NULL, ablations JSONB NOT NULL,
  started_at TIMESTAMPTZ(6) NOT NULL, completed_at TIMESTAMPTZ(6) NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT, created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_retrieval_eval_mode_valid CHECK (selected_mode IN ('compatibility', 'corrected')),
  CONSTRAINT memory_vnext_retrieval_eval_time_order CHECK (completed_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_retrieval_eval_replay ON memory_vnext_retrieval_evaluation_runs(owner_user_id, account_id, replay_key);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_retrieval_eval_context ON memory_vnext_retrieval_evaluation_runs(owner_user_id, account_id, context_build_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_retrieval_eval_owner ON memory_vnext_retrieval_evaluation_runs(scope, owner_user_id, completed_at);

CREATE TABLE IF NOT EXISTS memory_vnext_causal_path_reviews (
  id SERIAL PRIMARY KEY, prediction_id INTEGER NOT NULL REFERENCES memory_vnext_predictions(id) ON DELETE RESTRICT,
  judgment TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT,
  created_by_user_id TEXT, updated_by_user_id TEXT, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_causal_path_review_valid CHECK (judgment IN ('correct', 'incorrect', 'unclear'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_causal_path_review ON memory_vnext_causal_path_reviews(owner_user_id, account_id, prediction_id);

CREATE TABLE IF NOT EXISTS memory_vnext_prediction_evaluation_runs (
  id SERIAL PRIMARY KEY, replay_key TEXT NOT NULL, metrics JSONB NOT NULL, evaluated_at TIMESTAMPTZ(6) NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT, created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_prediction_eval_replay ON memory_vnext_prediction_evaluation_runs(owner_user_id, account_id, replay_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_prediction_eval_owner ON memory_vnext_prediction_evaluation_runs(scope, owner_user_id, evaluated_at);

CREATE OR REPLACE FUNCTION reject_memory_vnext_evaluation_ledger_mutation()
RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_memory_vnext_retrieval_activation_events_append_only ON memory_vnext_retrieval_activation_events;
CREATE TRIGGER trg_memory_vnext_retrieval_activation_events_append_only BEFORE UPDATE OR DELETE ON memory_vnext_retrieval_activation_events FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_evaluation_ledger_mutation();
DROP TRIGGER IF EXISTS trg_memory_vnext_retrieval_evaluation_runs_append_only ON memory_vnext_retrieval_evaluation_runs;
CREATE TRIGGER trg_memory_vnext_retrieval_evaluation_runs_append_only BEFORE UPDATE OR DELETE ON memory_vnext_retrieval_evaluation_runs FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_evaluation_ledger_mutation();
DROP TRIGGER IF EXISTS trg_memory_vnext_prediction_evaluation_runs_append_only ON memory_vnext_prediction_evaluation_runs;
CREATE TRIGGER trg_memory_vnext_prediction_evaluation_runs_append_only BEFORE UPDATE OR DELETE ON memory_vnext_prediction_evaluation_runs FOR EACH ROW EXECUTE FUNCTION reject_memory_vnext_evaluation_ledger_mutation();

COMMENT ON TABLE memory_vnext_retrieval_controls IS 'User-scoped corrected-retrieval authority. Missing row means compatibility and prediction output remains shadow-only.';
COMMENT ON TABLE memory_vnext_retrieval_evaluation_runs IS 'Immutable bounded dual-retrieval measurements. Focus content is represented only by a hash.';
COMMENT ON TABLE memory_vnext_prediction_evaluation_runs IS 'Immutable strict-cutoff forecast and baseline evaluation aggregates.';
