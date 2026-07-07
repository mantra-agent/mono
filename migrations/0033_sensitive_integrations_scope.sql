-- Step 7: sensitive integrations are private by principal; privileged/admin access is audited separately.

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_connected_accounts_owner ON connected_accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_principal_account ON connected_accounts(principal_account_id);

DO $$
DECLARE ray_user TEXT; ray_account TEXT;
BEGIN
  SELECT id INTO ray_user FROM users WHERE role = 'admin' ORDER BY created_at NULLS LAST, id LIMIT 1;
  SELECT id INTO ray_account FROM accounts WHERE owner_user_id = ray_user AND kind = 'personal' LIMIT 1;
  IF ray_user IS NOT NULL THEN
    UPDATE connected_accounts SET owner_user_id = COALESCE(owner_user_id, ray_user), principal_account_id = COALESCE(principal_account_id, ray_account);
  END IF;
END $$;

-- Email/cache/drafts/enrichment/calendar metadata carry explicit principal ownership.
ALTER TABLE email_triage_log ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_triage_log ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE email_sync_cursors ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_sync_cursors ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE email_sync_log ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_sync_log ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE email_enrichments ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_enrichments ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
ALTER TABLE email_dismissals ADD COLUMN IF NOT EXISTS owner_user_id TEXT; ALTER TABLE email_dismissals ADD COLUMN IF NOT EXISTS principal_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_email_triage_log_owner ON email_triage_log(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_triage_log_principal_account ON email_triage_log(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_owner ON email_messages(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_messages_principal_account ON email_messages(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_email_sync_cursors_owner ON email_sync_cursors(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_sync_cursors_principal_account ON email_sync_cursors(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_owner ON email_drafts(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_drafts_principal_account ON email_drafts(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_metadata_owner ON calendar_event_metadata(owner_user_id); CREATE INDEX IF NOT EXISTS idx_calendar_event_metadata_principal_account ON calendar_event_metadata(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_email_sync_log_owner ON email_sync_log(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_sync_log_principal_account ON email_sync_log(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_email_enrichments_owner ON email_enrichments(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_enrichments_principal_account ON email_enrichments(principal_account_id);
CREATE INDEX IF NOT EXISTS idx_email_dismissals_owner ON email_dismissals(owner_user_id); CREATE INDEX IF NOT EXISTS idx_email_dismissals_principal_account ON email_dismissals(principal_account_id);

UPDATE email_triage_log e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE email_messages e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE email_sync_cursors e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE email_drafts e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE calendar_event_metadata e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE email_sync_log e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE email_enrichments e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;
UPDATE email_dismissals e SET owner_user_id = ca.owner_user_id, principal_account_id = ca.principal_account_id FROM connected_accounts ca WHERE e.account_id = ca.account_id AND e.owner_user_id IS NULL;

-- Finance/Plaid and wellness are sensitive personal domains.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'plaid_accounts','plaid_transactions','plaid_holdings','plaid_liabilities','plaid_sync_cursors','manual_assets','manual_liabilities','financial_goals','recurring_expenses','budget_entries','budget_monthly_overrides','income_sources','income_deductions','income_deposits','debt_payments','financed_assets','manual_401k_accounts','future_cash_events','transaction_amortizations',
    'health_metrics','wellness_activities','wellness_logs','gratitude_entries','learning_entries','export_jobs','indexed_content'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_user_id TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS principal_account_id TEXT', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_owner ON %I(owner_user_id)', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_principal_account ON %I(principal_account_id)', t, t);
  END LOOP;
END $$;

-- Backfill remaining singleton legacy rows to the first admin personal principal.
DO $$
DECLARE ray_user TEXT; ray_account TEXT; t TEXT;
BEGIN
  SELECT id INTO ray_user FROM users WHERE role = 'admin' ORDER BY created_at NULLS LAST, id LIMIT 1;
  SELECT id INTO ray_account FROM accounts WHERE owner_user_id = ray_user AND kind = 'personal' LIMIT 1;
  IF ray_user IS NOT NULL THEN
    FOREACH t IN ARRAY ARRAY[
      'plaid_accounts','plaid_transactions','plaid_holdings','plaid_liabilities','plaid_sync_cursors','manual_assets','manual_liabilities','financial_goals','recurring_expenses','budget_entries','budget_monthly_overrides','income_sources','income_deductions','income_deposits','debt_payments','financed_assets','manual_401k_accounts','future_cash_events','transaction_amortizations',
      'health_metrics','wellness_activities','wellness_logs','gratitude_entries','learning_entries','export_jobs','indexed_content'
    ] LOOP
      EXECUTE format('UPDATE %I SET owner_user_id = COALESCE(owner_user_id, $1), principal_account_id = COALESCE(principal_account_id, $2) WHERE owner_user_id IS NULL', t) USING ray_user, ray_account;
    END LOOP;
  END IF;
END $$;
