ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS connector_kind TEXT NOT NULL DEFAULT 'integration',
  ADD COLUMN IF NOT EXISTS connector_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_provider_connections_kind_order
  ON provider_connections(connector_kind, sort_order);

ALTER TABLE personas ADD COLUMN IF NOT EXISTS semantic_tier TEXT;
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_semantic_tier_check;
ALTER TABLE personas ADD CONSTRAINT personas_semantic_tier_check
  CHECK (semantic_tier IS NULL OR semantic_tier IN ('max', 'high', 'balanced', 'fast'));

UPDATE personas SET semantic_tier = CASE name
  WHEN 'Strategist' THEN 'max'
  WHEN 'Architect' THEN 'max'
  WHEN 'Operator' THEN 'fast'
  WHEN 'Creative' THEN 'high'
  WHEN 'Coach' THEN 'high'
  WHEN 'Companion' THEN 'balanced'
  ELSE 'balanced'
END
WHERE semantic_tier IS NULL;
