ALTER TABLE plan_executions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_plan_executions_archived_at ON plan_executions(archived_at);
