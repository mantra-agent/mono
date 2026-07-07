CREATE TABLE IF NOT EXISTS transaction_amortizations (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  original_amount REAL NOT NULL,
  spread_months INTEGER NOT NULL,
  start_month TEXT NOT NULL,
  category TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS transaction_amortizations_active_idx
  ON transaction_amortizations (is_active);
CREATE INDEX IF NOT EXISTS transaction_amortizations_txn_idx
  ON transaction_amortizations (transaction_id);
