CREATE TABLE IF NOT EXISTS communication_audiences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  definition JSONB NOT NULL DEFAULT '{"kind":"manual","personIds":[]}'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_communication_audiences_scope_owner
  ON communication_audiences(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_communication_audiences_account_updated
  ON communication_audiences(account_id, updated_at);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  audience_id TEXT REFERENCES communication_audiences(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL DEFAULT 'Ray',
  sender_email TEXT NOT NULL DEFAULT 'ray@trymantra.ai',
  reply_to_email TEXT NOT NULL DEFAULT 'ray@trymantra.ai',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_scope_owner
  ON email_campaigns(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_account_updated
  ON email_campaigns(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_audience
  ON email_campaigns(audience_id);
