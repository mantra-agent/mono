-- Repair sensitive principal ownership columns for environments that ran multi-user code
-- before every additive schema change had landed. Safe/idempotent.

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_connected_accounts_owner ON connected_accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_principal_account ON connected_accounts(principal_account_id);

DO $$
DECLARE
  ray_user_id TEXT;
  ray_account_id TEXT;
BEGIN
  SELECT id INTO ray_user_id
  FROM users
  WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
  ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
  LIMIT 1;

  IF ray_user_id IS NOT NULL THEN
    SELECT id INTO ray_account_id
    FROM accounts
    WHERE kind = 'personal' AND owner_user_id = ray_user_id
    LIMIT 1;

    UPDATE connected_accounts
    SET owner_user_id = COALESCE(owner_user_id, ray_user_id),
        principal_account_id = COALESCE(principal_account_id, ray_account_id)
    WHERE owner_user_id IS NULL;
  END IF;
END $$;

DO $$
DECLARE
  table_name TEXT;
  ray_user_id TEXT;
  ray_account_id TEXT;
BEGIN
  SELECT id INTO ray_user_id
  FROM users
  WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
  ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
  LIMIT 1;

  IF ray_user_id IS NOT NULL THEN
    SELECT id INTO ray_account_id
    FROM accounts
    WHERE kind = 'personal' AND owner_user_id = ray_user_id
    LIMIT 1;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'email_triage_log','email_messages','email_sync_cursors','email_drafts','calendar_event_metadata','email_sync_log','email_enrichments','email_dismissals',
    'plaid_accounts','plaid_transactions','plaid_holdings','plaid_liabilities','plaid_sync_cursors','manual_assets','manual_liabilities','financial_goals','recurring_expenses','budget_entries','budget_monthly_overrides','income_sources','income_deductions','income_deposits','debt_payments','financed_assets','manual_401k_accounts','future_cash_events','transaction_amortizations',
    'health_metrics','wellness_activities','wellness_logs','gratitude_entries','learning_entries','export_jobs','indexed_content'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_user_id TEXT', table_name);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS principal_account_id TEXT', table_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_owner ON %I(owner_user_id)', table_name, table_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_principal_account ON %I(principal_account_id)', table_name, table_name);

      IF ray_user_id IS NOT NULL THEN
        EXECUTE format('UPDATE %I SET owner_user_id = COALESCE(owner_user_id, $1), principal_account_id = COALESCE(principal_account_id, $2) WHERE owner_user_id IS NULL', table_name)
        USING ray_user_id, ray_account_id;
      END IF;
    END IF;
  END LOOP;
END $$;
