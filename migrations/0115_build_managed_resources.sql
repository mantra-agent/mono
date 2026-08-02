-- Build-managed resources: durable Timer-run identity for transactional
-- accepted-deployment enqueue. Existing generated Timer run IDs are unique in
-- practice; fail deployment rather than deleting or rewriting history if drift
-- exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_responsibility_runs_run_id_unique
  ON responsibility_runs(run_id);
