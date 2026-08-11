ALTER TABLE platform_deployment_observations
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

ALTER TABLE platform_deployment_observations
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

ALTER TABLE platform_deployment_observations
  DROP CONSTRAINT IF EXISTS platform_deployment_observations_timing_check;

ALTER TABLE platform_deployment_observations
  ADD CONSTRAINT platform_deployment_observations_timing_check CHECK (
    (started_at IS NULL AND duration_ms IS NULL)
    OR (started_at IS NOT NULL AND duration_ms IS NOT NULL
      AND duration_ms >= 0 AND deployed_at >= started_at)
  );
