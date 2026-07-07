CREATE TABLE IF NOT EXISTS reflection_entries (
  id SERIAL PRIMARY KEY,
  owner_user_id TEXT,
  principal_account_id TEXT,
  content TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS reflection_entries_owner_account_date_unique ON reflection_entries(owner_user_id, principal_account_id, date);
CREATE INDEX IF NOT EXISTS idx_reflection_entries_owner ON reflection_entries(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_reflection_entries_principal_account ON reflection_entries(principal_account_id);
