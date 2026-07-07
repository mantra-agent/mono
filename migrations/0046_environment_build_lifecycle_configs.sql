CREATE TABLE IF NOT EXISTS environment_build_lifecycle_configs (
  id serial PRIMARY KEY,
  environment_id integer NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
  workflow_template_id text NOT NULL DEFAULT 'build-v1',
  provider_kind text NOT NULL DEFAULT 'railway',
  deploy_policy jsonb NOT NULL DEFAULT '{"mode":"manual"}'::jsonb,
  acceptance_target jsonb NOT NULL DEFAULT '{}'::jsonb,
  auth_mode text NOT NULL DEFAULT 'none',
  retry_policy jsonb NOT NULL DEFAULT '{"maxAttempts":3}'::jsonb,
  gate_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  docs_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_environment_build_lifecycle_configs_environment ON environment_build_lifecycle_configs(environment_id);
CREATE INDEX IF NOT EXISTS idx_environment_build_lifecycle_configs_template ON environment_build_lifecycle_configs(workflow_template_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_build_lifecycle_configs_one_enabled
  ON environment_build_lifecycle_configs(environment_id)
  WHERE enabled = true;
