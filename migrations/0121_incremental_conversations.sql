-- Canonical incremental conversation persistence. Legacy chat blobs remain
-- migration input and aggregate metadata only; active transcript writes use rows.
CREATE TABLE IF NOT EXISTS conversation_messages (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  payload JSONB NOT NULL,
  message_revision INTEGER NOT NULL DEFAULT 1,
  session_revision INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  vault_id TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_conversation_messages_ordinal CHECK (ordinal >= 0),
  CONSTRAINT ck_conversation_messages_revision CHECK (message_revision > 0 AND session_revision > 0),
  CONSTRAINT ck_conversation_messages_user_owner CHECK (
    scope <> 'user' OR (owner_user_id IS NOT NULL AND account_id IS NOT NULL AND vault_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_conversation_messages_session_message
  ON conversation_messages(owner_user_id, account_id, session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_scope_owner_session
  ON conversation_messages(scope, owner_user_id, session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_account_session
  ON conversation_messages(account_id, session_id, ordinal);

CREATE TABLE IF NOT EXISTS conversation_revisions (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'canonical_write',
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  vault_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_conversation_revisions_revision CHECK (revision > 0 AND message_count >= 0),
  CONSTRAINT ck_conversation_revisions_reason CHECK (reason IN ('canonical_write', 'legacy_adoption')),
  CONSTRAINT ck_conversation_revisions_user_owner CHECK (
    scope <> 'user' OR (owner_user_id IS NOT NULL AND account_id IS NOT NULL AND vault_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_conversation_revisions_session_revision
  ON conversation_revisions(owner_user_id, account_id, session_id, revision);
CREATE INDEX IF NOT EXISTS idx_conversation_revisions_scope_owner_session
  ON conversation_revisions(scope, owner_user_id, session_id, revision);
