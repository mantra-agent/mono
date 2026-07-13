-- Additive Google-derived Vault provenance. Safe to replay.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['email_messages','email_triage_log','email_sync_cursors','email_sync_log','email_enrichments','email_dismissals','email_drafts']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS vault_id text REFERENCES vaults(id)', table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_vault ON %I(vault_id)', table_name, table_name);
  END LOOP;
END $$;

-- Source-account lineage is authoritative. This is bounded to rows with a resolvable
-- Google account and is idempotent; unresolved rows remain NULL and fail closed.
UPDATE email_messages d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;
UPDATE email_triage_log d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;
UPDATE email_sync_cursors d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;
UPDATE email_sync_log d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;
UPDATE email_enrichments d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;
UPDATE email_dismissals d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;
UPDATE email_drafts d SET vault_id = a.vault_id FROM connected_accounts a WHERE d.vault_id IS NULL AND d.gmail_account_id = a.account_id AND a.provider = 'google' AND a.vault_id IS NOT NULL;

DO $$
DECLARE table_name text; unresolved bigint;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['email_messages','email_triage_log','email_sync_cursors','email_sync_log','email_enrichments','email_dismissals']
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE vault_id IS NULL', table_name) INTO unresolved;
    RAISE NOTICE 'google_vault_backfill table=% unresolved=%', table_name, unresolved;
  END LOOP;
  SELECT count(*) INTO unresolved FROM email_drafts WHERE gmail_account_id IS NOT NULL AND vault_id IS NULL;
  RAISE NOTICE 'google_vault_backfill table=email_drafts unresolved=%', unresolved;
END $$;
