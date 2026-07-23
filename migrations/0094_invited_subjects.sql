-- P3: global pre-account security subject and claim key.
-- Carries no credentials, profile, account, Vault, or Person data.

CREATE TABLE IF NOT EXISTS invited_subjects (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email TEXT NOT NULL,
  display_label TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ,
  CONSTRAINT invited_subjects_email_normalized_check CHECK (
    normalized_email = LOWER(BTRIM(normalized_email))
    AND NULLIF(BTRIM(normalized_email), '') IS NOT NULL
  ),
  CONSTRAINT invited_subjects_claim_pair_check CHECK (
    (claimed_by_user_id IS NULL AND claimed_at IS NULL)
    OR (claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invited_subjects_normalized_email_unique
  ON invited_subjects(normalized_email);

CREATE INDEX IF NOT EXISTS idx_invited_subjects_claimed_user
  ON invited_subjects(claimed_by_user_id);

COMMENT ON TABLE invited_subjects IS 'Global pre-account security subjects. No credentials, profile, account, Vault, or Person data.';
COMMENT ON COLUMN invited_subjects.normalized_email IS 'Verified registration claim key normalized by the canonical auth email helper.';
