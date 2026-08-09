-- Canonical incremental conversation history. Additive and rollback-safe:
-- legacy chat document content remains readable until each session crosses the
-- ordinary chat mutation boundary, which imports its stable message identities.
CREATE TABLE IF NOT EXISTS conversation_messages (
  id SERIAL PRIMARY KEY,
  document_store_id INTEGER NOT NULL REFERENCES document_store_documents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  run_id TEXT,
  turn_id TEXT,
  assistant_attempt_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  durable_revision INTEGER NOT NULL CHECK (durable_revision >= 1),
  payload JSONB NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'global', 'system')),
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_conversation_messages_identity
  ON conversation_messages(owner_user_id, account_id, session_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_conversation_messages_ordinal
  ON conversation_messages(owner_user_id, account_id, session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_document
  ON conversation_messages(document_store_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_attempt
  ON conversation_messages(account_id, session_id, assistant_attempt_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_scope_owner
  ON conversation_messages(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_account_session_ordinal
  ON conversation_messages(account_id, session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_vault
  ON conversation_messages(vault_id);
