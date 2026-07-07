ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_done boolean NOT NULL DEFAULT false;
