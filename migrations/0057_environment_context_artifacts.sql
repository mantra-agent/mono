CREATE TABLE IF NOT EXISTS environment_context_artifacts (
  id SERIAL PRIMARY KEY,
  environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  library_page_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(environment_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_environment_context_artifacts_environment ON environment_context_artifacts(environment_id);
CREATE INDEX IF NOT EXISTS idx_environment_context_artifacts_kind ON environment_context_artifacts(kind);
