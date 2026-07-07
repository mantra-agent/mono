ALTER TABLE workflow_runs
ADD COLUMN IF NOT EXISTS lifecycle_snapshot JSONB;
