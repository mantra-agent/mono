ALTER TABLE skill_runs
  ADD COLUMN IF NOT EXISTS parent_session_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_skill_run_id INTEGER,
  ADD COLUMN IF NOT EXISTS parent_tool_call_id TEXT;

CREATE INDEX IF NOT EXISTS idx_skill_runs_parent_lineage
  ON skill_runs(parent_skill_run_id, parent_tool_call_id, skill_name);
