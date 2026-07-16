-- Inline Plan Architecture foundation: additive persistence and invariants.

ALTER TABLE plan_executions ADD COLUMN IF NOT EXISTS execution_lease_id TEXT;
ALTER TABLE plan_executions ADD COLUMN IF NOT EXISTS execution_lease_owner TEXT;
ALTER TABLE plan_executions ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ;
ALTER TABLE plan_executions ADD COLUMN IF NOT EXISTS execution_claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_plan_executions_lease ON plan_executions(execution_lease_expires_at);

CREATE TABLE IF NOT EXISTS plan_session_links (
  id SERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  owner_user_id TEXT,
  account_id TEXT,
  anchor_message_id TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unlinked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_session_links_plan ON plan_session_links(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_session_links_session ON plan_session_links(session_id);
CREATE INDEX IF NOT EXISTS idx_plan_session_links_owner ON plan_session_links(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_plan_session_links_account ON plan_session_links(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_session_links_active_unique
  ON plan_session_links(plan_id, session_id)
  WHERE unlinked_at IS NULL;

CREATE TABLE IF NOT EXISTS plan_step_attempts (
  id SERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  owner_user_id TEXT,
  account_id TEXT,
  attempt_number INTEGER NOT NULL,
  child_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  error TEXT,
  duration_seconds INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_step_attempts_plan ON plan_step_attempts(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_attempts_step ON plan_step_attempts(plan_id, step_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_attempts_child_session ON plan_step_attempts(child_session_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_attempts_owner ON plan_step_attempts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_attempts_account ON plan_step_attempts(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_step_attempts_attempt_unique
  ON plan_step_attempts(plan_id, step_id, attempt_number);

-- Compatibility backfill: preserve existing latest child session as attempt history.
INSERT INTO plan_step_attempts (
  plan_id,
  step_id,
  owner_user_id,
  account_id,
  attempt_number,
  child_session_id,
  status,
  outcome,
  error,
  duration_seconds,
  started_at,
  completed_at,
  created_at,
  updated_at
)
SELECT
  ps.plan_id,
  ps.id,
  ps.owner_user_id,
  ps.account_id,
  GREATEST(COALESCE(ps.total_attempts, 1), 1),
  ps.session_id,
  CASE WHEN ps.status = 'running' THEN 'running' ELSE COALESCE(NULLIF(ps.status, 'pending'), 'completed') END,
  ps.outcome,
  ps.error,
  ps.duration_seconds,
  ps.started_at,
  ps.completed_at,
  COALESCE(ps.started_at, ps.created_at, NOW()),
  COALESCE(ps.updated_at, NOW())
FROM plan_steps ps
WHERE ps.session_id IS NOT NULL
ON CONFLICT (plan_id, step_id, attempt_number) DO NOTHING;

-- Compatibility backfill: origin session remains provenance, link table owns placement.
INSERT INTO plan_session_links (
  plan_id,
  session_id,
  owner_user_id,
  account_id,
  linked_at,
  created_at,
  updated_at
)
SELECT
  pe.id,
  pe.origin_session_id,
  pe.owner_user_id,
  pe.account_id,
  COALESCE(pe.created_at, NOW()),
  COALESCE(pe.created_at, NOW()),
  COALESCE(pe.updated_at, NOW())
FROM plan_executions pe
WHERE pe.origin_session_id IS NOT NULL
  AND pe.origin_session_id <> ''
  AND pe.origin_session_id NOT LIKE 'unlinked:%'
ON CONFLICT (plan_id, session_id) WHERE unlinked_at IS NULL DO NOTHING;

-- Cross-process invariant: one running step per plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_steps_one_running_per_plan
  ON plan_steps(plan_id)
  WHERE status = 'running';
