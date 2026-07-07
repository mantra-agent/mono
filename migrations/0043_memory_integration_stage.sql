ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS integration_stage TEXT NOT NULL DEFAULT 'stage_0';

UPDATE memory_entries
SET integration_stage = CASE
  WHEN COALESCE(title, '') <> ''
    AND COALESCE(summary, '') <> ''
    AND tags IS NOT NULL
    AND array_length(tags, 1) > 0
    THEN 'stage_1'
  WHEN layer IN ('mid', 'long', 'workspace') THEN 'stage_1'
  ELSE 'stage_0'
END
WHERE integration_stage IS NULL OR integration_stage = 'stage_0';

CREATE INDEX IF NOT EXISTS idx_memory_integration_stage
  ON memory_entries(integration_stage);
