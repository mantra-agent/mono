#!/bin/bash
set -e
npm install --include=dev --legacy-peer-deps --no-audit --no-fund

psql "$DATABASE_URL" -c "
CREATE TABLE IF NOT EXISTS expense_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  plaid_category TEXT,
  color TEXT
);
CREATE TABLE IF NOT EXISTS merchant_category_overrides (
  id SERIAL PRIMARY KEY,
  merchant_name TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_monthly_overrides (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  month TEXT NOT NULL,
  amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS income_sources (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  gross_pay REAL NOT NULL,
  pay_frequency TEXT NOT NULL,
  effective_date TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS income_deductions (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  is_pre_tax BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS income_deposits (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL,
  account_id TEXT,
  account_label TEXT,
  amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS debt_payments (
  id SERIAL PRIMARY KEY,
  liability_type TEXT NOT NULL,
  liability_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  from_account_id TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS manual_401k_accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  current_balance REAL NOT NULL,
  linked_deduction_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS financed_assets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  purchase_price REAL NOT NULL,
  purchase_date TEXT,
  current_value REAL NOT NULL,
  depreciation_method TEXT DEFAULT 'none',
  useful_life_months INTEGER,
  salvage_value REAL DEFAULT 0,
  loan_original_amount REAL,
  loan_balance REAL,
  loan_apr REAL,
  monthly_payment REAL,
  total_payments INTEGER,
  payments_made INTEGER DEFAULT 0,
  loan_start_date TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS future_cash_events (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE plaid_liabilities ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE plaid_liabilities ADD COLUMN IF NOT EXISTS manual_payment_amount REAL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS pinned_to_context BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS calendar_event_metadata (
  id SERIAL PRIMARY KEY,
  google_event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'meeting',
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT calendar_event_metadata_event_account_calendar_unique UNIQUE (google_event_id, account_id, calendar_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'saved',
  session_key TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS session_tree (
  session_id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  spawn_reason TEXT,
  spawner_tool TEXT,
  spawner_skill_run TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_session_tree_spawn_idem UNIQUE (parent_session_id, spawn_reason, spawner_skill_run)
);
CREATE INDEX IF NOT EXISTS idx_session_tree_parent ON session_tree (parent_session_id);
CREATE TABLE IF NOT EXISTS calendar_event_people (
  id SERIAL PRIMARY KEY,
  metadata_id INTEGER NOT NULL REFERENCES calendar_event_metadata(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  attendee_email TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT calendar_event_people_metadata_person_unique UNIQUE (metadata_id, person_id)
);
" 2>/dev/null || true

timeout 45 bash -c "printf '\n%.0s' {1..200} | npx drizzle-kit push --force" 2>/dev/null || true
