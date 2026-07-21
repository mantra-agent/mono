ALTER TABLE memory_vnext_claims
  ADD COLUMN IF NOT EXISTS active_touched_at TIMESTAMPTZ;
