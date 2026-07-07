ALTER TABLE email_sync_log
  ADD COLUMN IF NOT EXISTS reconciled_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS email_messages_account_open_updated_idx
  ON email_messages (account_id, is_done, updated_at);
