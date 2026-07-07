-- Plan Executions: database-backed plan state (replaces YAML-in-Library-page)
CREATE TABLE IF NOT EXISTS plan_executions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  origin_session_id TEXT NOT NULL,
  blocking BOOLEAN NOT NULL DEFAULT TRUE,
  workspace TEXT,
  workspace_dir TEXT,
  goal_id TEXT,
  project_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_executions_status ON plan_executions(status);

-- Plan Steps: individual steps within a plan execution
CREATE TABLE IF NOT EXISTS plan_steps (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT,
  outcome TEXT,
  error TEXT,
  duration_seconds INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  retry_tier TEXT,
  retry_attempt INTEGER,
  total_attempts INTEGER DEFAULT 0,
  prior_errors JSONB,
  timeout_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plan_id, id)
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan_id ON plan_steps(plan_id);

-- Session tree lifecycle: track spawn outcome so failed spawns don't block retries
ALTER TABLE session_tree ADD COLUMN IF NOT EXISTS spawn_status TEXT NOT NULL DEFAULT 'succeeded';

-- Replace the old absolute unique constraint with a partial index that only
-- enforces uniqueness on non-terminal (pending/running) spawns.
DROP INDEX IF EXISTS uk_session_tree_spawn_idem;
CREATE UNIQUE INDEX IF NOT EXISTS uk_session_tree_spawn_active
  ON session_tree (parent_session_id, spawn_reason, spawner_skill_run)
  WHERE spawn_status IN ('pending', 'running');
