-- Additive Life Addressing convergence for execution provenance.
-- Legacy type/id columns remain authoritative for scoring/workflow compatibility
-- until parity and rollback observation permit retirement.
ALTER TABLE session_artifacts
  ADD COLUMN IF NOT EXISTS artifact_address TEXT,
  ADD COLUMN IF NOT EXISTS address_link_id UUID;

ALTER TABLE workflow_artifacts
  ADD COLUMN IF NOT EXISTS artifact_address TEXT,
  ADD COLUMN IF NOT EXISTS address_link_id UUID;

CREATE INDEX IF NOT EXISTS idx_session_artifacts_address
  ON session_artifacts (owner_user_id, account_id, artifact_address)
  WHERE artifact_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_address
  ON workflow_artifacts (owner_user_id, account_id, artifact_address)
  WHERE artifact_address IS NOT NULL;
