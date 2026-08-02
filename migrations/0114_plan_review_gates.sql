-- Durable Plan review gates and human decision provenance.

CREATE TABLE IF NOT EXISTS plan_step_reviews (
  id SERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  attempt_id INTEGER REFERENCES plan_step_attempts(id) ON DELETE SET NULL,
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  prompt TEXT NOT NULL,
  decision TEXT,
  decision_reason TEXT,
  opened_by_session_id TEXT,
  resolved_by_user_id TEXT,
  resolved_by_session_id TEXT,
  resolution_source TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_plan_step_reviews_status CHECK (status IN ('open', 'resolved')),
  CONSTRAINT chk_plan_step_reviews_decision CHECK (
    decision IS NULL OR decision IN ('approve', 'request_changes', 'retry', 'stop')
  ),
  CONSTRAINT chk_plan_step_reviews_resolution CHECK (
    (status = 'open' AND decision IS NULL AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
    OR
    (status = 'resolved' AND decision IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_plan_step_reviews_plan ON plan_step_reviews(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_reviews_step ON plan_step_reviews(plan_id, step_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_reviews_attempt ON plan_step_reviews(attempt_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_reviews_owner ON plan_step_reviews(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_reviews_account ON plan_step_reviews(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_step_reviews_open_unique
  ON plan_step_reviews(plan_id, step_id)
  WHERE status = 'open';

-- Rolling compatibility: existing review-pending steps gain one open review.
INSERT INTO plan_step_reviews (
  plan_id,
  step_id,
  attempt_id,
  owner_user_id,
  account_id,
  prompt,
  opened_by_session_id,
  opened_at,
  created_at,
  updated_at
)
SELECT
  ps.plan_id,
  ps.id,
  latest_attempt.id,
  plan.owner_user_id,
  plan.account_id,
  COALESCE(NULLIF(BTRIM(ps.outcome), ''), NULLIF(BTRIM(ps.error), ''), 'Review the completed step before the Plan continues.'),
  latest_attempt.child_session_id,
  COALESCE(latest_attempt.completed_at, ps.completed_at, ps.updated_at, NOW()),
  COALESCE(latest_attempt.completed_at, ps.completed_at, ps.updated_at, NOW()),
  NOW()
FROM plan_steps ps
INNER JOIN plan_executions plan ON plan.id = ps.plan_id
LEFT JOIN LATERAL (
  SELECT psa.id, psa.child_session_id, psa.completed_at
  FROM plan_step_attempts psa
  WHERE psa.plan_id = ps.plan_id AND psa.step_id = ps.id
  ORDER BY psa.attempt_number DESC
  LIMIT 1
) latest_attempt ON TRUE
WHERE ps.status = 'needs_review'
  AND plan.owner_user_id IS NOT NULL
  AND plan.account_id IS NOT NULL
ON CONFLICT (plan_id, step_id) WHERE status = 'open' DO NOTHING;
