ALTER TABLE meeting_recap_distributions
  ADD COLUMN IF NOT EXISTS access_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_revoked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mrd_access_token_hash_unique
  ON meeting_recap_distributions(access_token_hash)
  WHERE access_token_hash IS NOT NULL;
