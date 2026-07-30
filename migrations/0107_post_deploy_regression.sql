CREATE TABLE IF NOT EXISTS regression_runs (
  id TEXT PRIMARY KEY,
  trigger_key TEXT NOT NULL,
  environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
  accepted_deployment_id TEXT NOT NULL,
  accepted_revision TEXT NOT NULL,
  source_workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  acceptance_attempt_id INTEGER REFERENCES workflow_stage_attempts(id) ON DELETE SET NULL,
  lifecycle_snapshot JSONB NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  skill_session_id TEXT,
  plan_id TEXT REFERENCES plan_executions(id) ON DELETE SET NULL,
  candidate_snapshot JSONB,
  failure_context JSONB,
  claimed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT regression_runs_scope_check CHECK (scope = 'user'),
  CONSTRAINT regression_runs_status_check CHECK (status IN ('queued','claimed','planning','executing','completed','partial','failed','skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS regression_runs_owner_trigger_key
  ON regression_runs(owner_user_id, account_id, trigger_key);
CREATE UNIQUE INDEX IF NOT EXISTS regression_runs_plan_unique
  ON regression_runs(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS regression_runs_due_status
  ON regression_runs(status, due_at);
CREATE INDEX IF NOT EXISTS regression_runs_owner_created
  ON regression_runs(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS regression_runs_environment_created
  ON regression_runs(environment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issue_regression_contracts (
  id SERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'enabled',
  exclusion_reason TEXT,
  environment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  route_path TEXT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_outcome TEXT,
  setup_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT issue_regression_contracts_scope_check CHECK (scope = 'user'),
  CONSTRAINT issue_regression_contracts_disposition_check CHECK (disposition IN ('enabled','not_applicable')),
  CONSTRAINT issue_regression_contracts_exclusion_check CHECK (disposition <> 'not_applicable' OR length(trim(exclusion_reason)) > 0),
  CONSTRAINT issue_regression_contracts_version_check CHECK (version > 0),
  CONSTRAINT issue_regression_contracts_environment_ids_check CHECK (jsonb_typeof(environment_ids) = 'array'),
  CONSTRAINT issue_regression_contracts_steps_check CHECK (jsonb_typeof(steps) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_regression_contracts_owner_issue_key
  ON issue_regression_contracts(owner_user_id, account_id, issue_id);
CREATE INDEX IF NOT EXISTS issue_regression_contracts_issue
  ON issue_regression_contracts(issue_id);
CREATE INDEX IF NOT EXISTS issue_regression_contracts_owner_updated
  ON issue_regression_contracts(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS issue_regression_results (
  id SERIAL PRIMARY KEY,
  regression_run_id TEXT NOT NULL REFERENCES regression_runs(id) ON DELETE RESTRICT,
  issue_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  plan_id TEXT REFERENCES plan_executions(id) ON DELETE SET NULL,
  plan_step_id TEXT,
  environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
  deployment_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  session_id TEXT,
  contract_version INTEGER,
  summary TEXT NOT NULL,
  action_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  assertions JSONB NOT NULL DEFAULT '[]'::jsonb,
  screenshots JSONB NOT NULL DEFAULT '[]'::jsonb,
  browser_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT issue_regression_results_scope_check CHECK (scope = 'user'),
  CONSTRAINT issue_regression_results_status_check CHECK (status IN ('passed','failed','blocked')),
  CONSTRAINT issue_regression_results_reason_check CHECK (length(trim(reason_code)) > 0),
  CONSTRAINT issue_regression_results_summary_check CHECK (length(trim(summary)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_regression_results_run_issue_key
  ON issue_regression_results(owner_user_id, account_id, regression_run_id, issue_id);
CREATE INDEX IF NOT EXISTS issue_regression_results_run_created
  ON issue_regression_results(regression_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS issue_regression_results_issue_created
  ON issue_regression_results(issue_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_issue_regression_result_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'issue_regression_results is append-only';
END;
$$;

DROP TRIGGER IF EXISTS issue_regression_results_append_only ON issue_regression_results;
CREATE TRIGGER issue_regression_results_append_only
  BEFORE UPDATE OR DELETE ON issue_regression_results
  FOR EACH ROW EXECUTE FUNCTION prevent_issue_regression_result_mutation();
