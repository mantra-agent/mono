ALTER TABLE meeting_recap_distributions
  ADD COLUMN IF NOT EXISTS onboarding_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mrd_onboarding_token_hash_unique
  ON meeting_recap_distributions(onboarding_token_hash)
  WHERE onboarding_token_hash IS NOT NULL;
