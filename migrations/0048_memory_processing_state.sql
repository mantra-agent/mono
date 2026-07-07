ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS processing_run_id TEXT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS processing_updated_at TIMESTAMPTZ;

UPDATE memory_entries
SET processing_status = 'idle'
WHERE processing_status IS NULL OR processing_status NOT IN ('idle', 'processing', 'error');

UPDATE memory_entries
SET processing_updated_at = processed_at
WHERE processing_updated_at IS NULL AND processed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_processing_status
  ON memory_entries(processing_status);

CREATE INDEX IF NOT EXISTS idx_memory_processing_run
  ON memory_entries(processing_run_id)
  WHERE processing_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_stage_processing_claim
  ON memory_entries(integration_stage, processing_status, created_at, processed_at)
  WHERE integration_stage = 'stage_1';
