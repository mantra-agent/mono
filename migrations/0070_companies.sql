CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  website TEXT,
  industry TEXT,
  location TEXT,
  notes TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_companies_scope_owner ON companies(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
ALTER TABLE persons ADD COLUMN IF NOT EXISTS company_id TEXT;
CREATE INDEX IF NOT EXISTS idx_persons_company_id ON persons(company_id);
