CREATE TABLE IF NOT EXISTS platform_deployment_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_deployment_id TEXT NOT NULL,
  deployment_state TEXT NOT NULL,
  platform_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  environment_name TEXT NOT NULL,
  commit_sha TEXT,
  deployed_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT platform_deployment_observations_provider_check CHECK (provider = 'railway'),
  CONSTRAINT platform_deployment_observations_state_check CHECK (deployment_state = 'SUCCESS'),
  CONSTRAINT platform_deployment_observations_provider_id_check CHECK (char_length(provider_deployment_id) BETWEEN 1 AND 200),
  CONSTRAINT platform_deployment_observations_identity_check CHECK (
    char_length(platform_name) BETWEEN 1 AND 200
    AND char_length(product_name) BETWEEN 1 AND 200
    AND char_length(environment_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT platform_deployment_observations_commit_check CHECK (
    commit_sha IS NULL OR char_length(commit_sha) BETWEEN 1 AND 200
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_platform_deployment_observation_provider_identity
  ON platform_deployment_observations(account_id, platform_environment_id, provider, provider_deployment_id);
CREATE INDEX IF NOT EXISTS idx_platform_deployment_observations_owner_time
  ON platform_deployment_observations(owner_user_id, account_id, deployed_at DESC);

CREATE TABLE IF NOT EXISTS build_deployment_home_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES platform_deployment_observations(id) ON DELETE RESTRICT,
  reason_key TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ,
  dismissed_by_user_id TEXT,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT build_deployment_home_projection_reason_check CHECK (char_length(reason_key) BETWEEN 1 AND 500),
  CONSTRAINT build_deployment_home_projection_dismissal_check CHECK (
    (dismissed_at IS NULL AND dismissed_by_user_id IS NULL)
    OR (dismissed_at IS NOT NULL AND dismissed_by_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_build_deployment_home_projection_observation
  ON build_deployment_home_projections(observation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_build_deployment_home_projection_reason
  ON build_deployment_home_projections(account_id, reason_key);
CREATE INDEX IF NOT EXISTS idx_build_deployment_home_projection_owner
  ON build_deployment_home_projections(owner_user_id, account_id, dismissed_at, created_at DESC);
