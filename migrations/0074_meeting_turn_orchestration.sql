CREATE TABLE IF NOT EXISTS meeting_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  speaker_key TEXT NOT NULL,
  speaker_label TEXT NOT NULL,
  participation_mode TEXT NOT NULL DEFAULT 'contextual',
  execution_affinity_boot_id TEXT,
  text TEXT NOT NULL,
  source_turn_ids TEXT[] NOT NULL DEFAULT '{}',
  source_message_ids TEXT[] NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  assembly_status TEXT NOT NULL DEFAULT 'collecting',
  participation_status TEXT NOT NULL DEFAULT 'pending',
  execution_status TEXT NOT NULL DEFAULT 'waiting',
  participation_decision JSONB,
  prompt TEXT,
  completeness_deferrals INTEGER NOT NULL DEFAULT 0,
  ready_at TIMESTAMPTZ NOT NULL,
  first_fragment_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_fragment_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  assistant_message_id TEXT,
  error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT meeting_turns_participation_mode_check CHECK (participation_mode IN ('contextual', 'always')),
  CONSTRAINT meeting_turns_assembly_status_check CHECK (assembly_status IN ('collecting', 'complete')),
  CONSTRAINT meeting_turns_participation_status_check CHECK (participation_status IN ('pending', 'claimed', 'respond', 'silent', 'failed')),
  CONSTRAINT meeting_turns_execution_status_check CHECK (execution_status IN ('waiting', 'pending', 'claimed', 'completed', 'failed', 'not_applicable'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_turns_ready ON meeting_turns(assembly_status, ready_at);
CREATE INDEX IF NOT EXISTS idx_meeting_turns_session ON meeting_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_meeting_turns_owner ON meeting_turns(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_turns_account ON meeting_turns(account_id);
CREATE INDEX IF NOT EXISTS idx_meeting_turns_affinity ON meeting_turns(execution_affinity_boot_id) WHERE execution_affinity_boot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_turns_claimed_session
  ON meeting_turns(session_id) WHERE execution_status = 'claimed';
