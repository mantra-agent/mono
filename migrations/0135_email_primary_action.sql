ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS primary_action TEXT NOT NULL DEFAULT 'reply';
