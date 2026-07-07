ALTER TABLE plaid_transactions
  ADD COLUMN IF NOT EXISTS transfer_pair_id TEXT,
  ADD COLUMN IF NOT EXISTS is_internal_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS transfer_pair_source TEXT;

CREATE INDEX IF NOT EXISTS plaid_transactions_pair_idx
  ON plaid_transactions (transfer_pair_id);
CREATE INDEX IF NOT EXISTS plaid_transactions_internal_idx
  ON plaid_transactions (is_internal_transfer);

CREATE TABLE IF NOT EXISTS transfer_pair_overrides (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  pair_with_transaction_id TEXT,
  force_mark_internal BOOLEAN NOT NULL DEFAULT FALSE,
  force_unmark BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS transfer_pair_overrides_pair_with_idx
  ON transfer_pair_overrides (pair_with_transaction_id);

CREATE TABLE IF NOT EXISTS app_migrations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB
);
