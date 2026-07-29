CREATE TABLE IF NOT EXISTS meeting_turn_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  speaker_key TEXT NOT NULL,
  speaker_label TEXT NOT NULL,
  participation_mode TEXT NOT NULL DEFAULT 'contextual',
  execution_affinity_boot_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at TIMESTAMPTZ,
  enrolled_turn_id UUID,
  postgres_code TEXT,
  error_type TEXT,
  enrolled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT meeting_turn_enrollments_status_check
    CHECK (status IN ('pending', 'enrolled', 'failed')),
  CONSTRAINT meeting_turn_enrollments_participation_mode_check
    CHECK (participation_mode IN ('contextual', 'always'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_meeting_turn_enrollment_source
  ON meeting_turn_enrollments(owner_user_id, account_id, session_id, source_turn_id);
CREATE INDEX IF NOT EXISTS idx_meeting_turn_enrollments_due
  ON meeting_turn_enrollments(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_meeting_turn_enrollments_session
  ON meeting_turn_enrollments(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_meeting_turn_enrollments_owner
  ON meeting_turn_enrollments(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_turn_enrollments_account
  ON meeting_turn_enrollments(account_id);
