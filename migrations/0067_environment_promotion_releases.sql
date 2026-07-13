CREATE TABLE IF NOT EXISTS environment_promotion_releases (
  id SERIAL PRIMARY KEY,
  environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
  publish_run_id TEXT NOT NULL,
  version TEXT NOT NULL,
  increment_kind TEXT NOT NULL,
  promoted_commit_sha TEXT NOT NULL,
  version_file_commit_sha TEXT NOT NULL,
  version_file_path TEXT NOT NULL DEFAULT 'VERSION.md',
  version_file_url TEXT NOT NULL,
  release_notes JSONB NOT NULL DEFAULT '{"newFeatures":[],"improvements":[],"fixes":[]}'::jsonb,
  deployment_id TEXT,
  promoted_by_user_id TEXT,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_promotion_releases_run
  ON environment_promotion_releases(publish_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_promotion_releases_version
  ON environment_promotion_releases(environment_id, version);
CREATE INDEX IF NOT EXISTS idx_environment_promotion_releases_environment_time
  ON environment_promotion_releases(environment_id, promoted_at DESC);
