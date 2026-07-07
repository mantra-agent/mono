ALTER TABLE memory_vnext_claims
  ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT NOT NULL DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS lifecycle_stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_lifecycle_stage
  ON memory_vnext_claims(lifecycle_stage);
