-- Additive Autonomy Runtime Kernel foundation.
-- No existing executor reads or writes these tables in this migration step.

CREATE TABLE IF NOT EXISTS runtime_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  handler_key TEXT NOT NULL,
  handler_version INTEGER NOT NULL CHECK (handler_version > 0),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  causal_parent_run_id UUID,
  run_as_actor_type TEXT NOT NULL CHECK (run_as_actor_type IN ('user','service')),
  run_as_subject_id TEXT NOT NULL,
  resource_pool TEXT NOT NULL CHECK (resource_pool IN ('interactive_agent','background_agent','short_worker','isolated_execution')),
  executor_profile TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  available_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  input_schema_version INTEGER NOT NULL CHECK (input_schema_version > 0),
  input JSONB NOT NULL,
  input_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_refs) = 'array' AND jsonb_array_length(input_refs) <= 100),
  authority_policy_version_at_enqueue TEXT NOT NULL,
  budget JSONB NOT NULL,
  retry_policy JSONB NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending','leased','running','terminal')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded','degraded','blocked','failed','cancelled','needs_review')),
  outcome_reason_code TEXT,
  attribution TEXT CHECK (attribution IS NULL OR attribution IN ('runtime','provider','producer','handler','authority','external_dependency','user','system','unknown')),
  current_attempt_id UUID,
  receipt_event_id UUID,
  cancellation_requested_at TIMESTAMPTZ,
  cancellation_reason_code TEXT,
  terminal_at TIMESTAMPTZ,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope = 'user'),
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT runtime_runs_deadline_check CHECK (deadline_at > created_at),
  CONSTRAINT runtime_runs_terminal_shape_check CHECK (
    (phase = 'terminal' AND outcome IS NOT NULL AND outcome_reason_code IS NOT NULL AND attribution IS NOT NULL AND receipt_event_id IS NOT NULL AND terminal_at IS NOT NULL)
    OR (phase <> 'terminal' AND outcome IS NULL AND outcome_reason_code IS NULL AND attribution IS NULL AND receipt_event_id IS NULL AND terminal_at IS NULL)
  ),
  CONSTRAINT runtime_runs_attempt_shape_check CHECK (
    (phase = 'pending' AND current_attempt_id IS NULL)
    OR (phase IN ('leased','running') AND current_attempt_id IS NOT NULL)
    OR phase = 'terminal'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_account_kind_idempotency ON runtime_runs(account_id, kind, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_account_id_unique ON runtime_runs(account_id, id);
CREATE INDEX IF NOT EXISTS runtime_runs_dispatch_head ON runtime_runs(resource_pool, phase, available_at, account_id);
CREATE INDEX IF NOT EXISTS runtime_runs_owner_created ON runtime_runs(owner_user_id, account_id, created_at);
CREATE INDEX IF NOT EXISTS runtime_runs_parent ON runtime_runs(causal_parent_run_id);

CREATE TABLE IF NOT EXISTS runtime_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  account_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  resource_pool TEXT NOT NULL CHECK (resource_pool IN ('interactive_agent','background_agent','short_worker','isolated_execution')),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  lease_token_hash TEXT NOT NULL CHECK (lease_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  worker_id TEXT NOT NULL,
  executor_profile TEXT NOT NULL,
  capacity_policy_version INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'leased' CHECK (phase IN ('leased','running','finished')),
  result TEXT CHECK (result IS NULL OR result IN ('completed','retry','lost','cancelled','blocked')),
  failure_class TEXT,
  reason_code TEXT,
  attribution TEXT CHECK (attribution IS NULL OR attribution IN ('runtime','provider','producer','handler','authority','external_dependency','user','system','unknown')),
  usage_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  leased_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope = 'user'),
  owner_user_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  CONSTRAINT runtime_attempts_run_account_fk FOREIGN KEY (account_id, run_id) REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT,
  CONSTRAINT runtime_attempts_finished_shape_check CHECK (
    (phase = 'finished' AND result IS NOT NULL AND finished_at IS NOT NULL)
    OR (phase <> 'finished' AND result IS NULL AND finished_at IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_run_number_unique ON runtime_attempts(run_id, attempt_number);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_run_epoch_unique ON runtime_attempts(run_id, lease_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_account_run_id_unique ON runtime_attempts(account_id, run_id, id);
CREATE INDEX IF NOT EXISTS runtime_attempts_active_capacity ON runtime_attempts(resource_pool, phase, lease_expires_at);
CREATE INDEX IF NOT EXISTS runtime_attempts_account_active ON runtime_attempts(account_id, resource_pool, phase, lease_expires_at);
CREATE INDEX IF NOT EXISTS runtime_attempts_run_leased ON runtime_attempts(run_id, leased_at);

CREATE TABLE IF NOT EXISTS runtime_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  attempt_id UUID,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('authorization','mutation','verification','failure','correction','terminal_receipt')),
  reason_code TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope = 'user'),
  owner_user_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  CONSTRAINT runtime_run_events_run_account_fk FOREIGN KEY (account_id, run_id) REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT,
  CONSTRAINT runtime_run_events_attempt_fk FOREIGN KEY (account_id, run_id, attempt_id) REFERENCES runtime_attempts(account_id, run_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_run_events_terminal_receipt_unique ON runtime_run_events(run_id) WHERE event_type = 'terminal_receipt';
CREATE UNIQUE INDEX IF NOT EXISTS runtime_run_events_account_run_id_unique ON runtime_run_events(account_id, run_id, id);
CREATE INDEX IF NOT EXISTS runtime_run_events_run_time ON runtime_run_events(run_id, occurred_at);
CREATE INDEX IF NOT EXISTS runtime_run_events_attempt_time ON runtime_run_events(attempt_id, occurred_at);
CREATE INDEX IF NOT EXISTS runtime_run_events_owner_time ON runtime_run_events(owner_user_id, account_id, occurred_at);

CREATE TABLE IF NOT EXISTS runtime_capacity_policies (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactional_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,119}$'),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error_code TEXT,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope = 'user'),
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS transactional_outbox_owner_idempotency ON transactional_outbox(owner_user_id, account_id, idempotency_key);
CREATE INDEX IF NOT EXISTS transactional_outbox_ready ON transactional_outbox(published_at, available_at, created_at);
CREATE INDEX IF NOT EXISTS transactional_outbox_aggregate ON transactional_outbox(account_id, aggregate_type, aggregate_id);

DO $runtime_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_runs_current_attempt_fk') THEN
    ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_current_attempt_fk
      FOREIGN KEY (account_id, id, current_attempt_id) REFERENCES runtime_attempts(account_id, run_id, id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_runs_receipt_event_fk') THEN
    ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_receipt_event_fk
      FOREIGN KEY (account_id, id, receipt_event_id) REFERENCES runtime_run_events(account_id, run_id, id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_runs_causal_parent_account_fk') THEN
    ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_causal_parent_account_fk
      FOREIGN KEY (account_id, causal_parent_run_id) REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT;
  END IF;
END
$runtime_constraints$;

CREATE OR REPLACE FUNCTION prevent_runtime_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$function$;
DROP TRIGGER IF EXISTS runtime_run_events_append_only ON runtime_run_events;
CREATE TRIGGER runtime_run_events_append_only BEFORE UPDATE OR DELETE ON runtime_run_events FOR EACH ROW EXECUTE FUNCTION prevent_runtime_append_only_mutation();
DROP TRIGGER IF EXISTS runtime_capacity_policies_append_only ON runtime_capacity_policies;
CREATE TRIGGER runtime_capacity_policies_append_only BEFORE UPDATE OR DELETE ON runtime_capacity_policies FOR EACH ROW EXECUTE FUNCTION prevent_runtime_append_only_mutation();
