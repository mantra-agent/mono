ALTER TABLE workflow_stage_attempts
  ADD COLUMN IF NOT EXISTS execution_lease_id TEXT,
  ADD COLUMN IF NOT EXISTS execution_lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_execution_lease
  ON workflow_stage_attempts(execution_lease_expires_at)
  WHERE status = 'active' AND completed_at IS NULL;
