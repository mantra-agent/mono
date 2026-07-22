CREATE TABLE IF NOT EXISTS financial_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Mantra Model',
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_financial_models_scope_owner ON financial_models(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_financial_models_account ON financial_models(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_models_account ON financial_models(account_id) WHERE account_id IS NOT NULL;
