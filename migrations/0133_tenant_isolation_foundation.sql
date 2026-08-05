-- DORMANT TENANT-ISOLATION FOUNDATION ONLY.
-- Checked in for review; do not apply until the separate deployment gate approves
-- role credentials, ownership backfill validation, rollback, and hosted-db execution.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantra_owner') THEN
    CREATE ROLE mantra_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantra_app') THEN
    CREATE ROLE mantra_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantra_system') THEN
    CREATE ROLE mantra_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantra_migrator') THEN
    CREATE ROLE mantra_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')
$$;
CREATE OR REPLACE FUNCTION app_account_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.account_id', true), '')
$$;
CREATE OR REPLACE FUNCTION app_vault_ids() RETURNS text[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('app.vault_ids', true), '') IS NULL THEN ARRAY[]::text[]
    ELSE ARRAY(SELECT jsonb_array_elements_text(current_setting('app.vault_ids', true)::jsonb))
  END
$$;
CREATE OR REPLACE FUNCTION app_service_principal() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.service_principal', true), '')
$$;
CREATE OR REPLACE FUNCTION app_request_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.request_id', true), '')
$$;

-- Ownership normalization is additive and nullable until deterministic backfills
-- have been reviewed. Existing application authorization remains authoritative.
ALTER TABLE users ADD COLUMN IF NOT EXISTS quarantine_status text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quarantine_reason text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quarantine_status text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quarantine_reason text;
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS quarantine_status text;
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS quarantine_reason text;

COMMENT ON COLUMN users.account_id IS 'Canonical identity-to-account ownership; required before RLS activation.';
COMMENT ON COLUMN vaults.account_id IS 'Canonical Vault-to-account ownership; required before RLS activation.';
COMMENT ON COLUMN users.quarantine_status IS 'Dormant onboarding quarantine marker; no runtime behavior until separately activated.';

-- First represented policy family: ACCOUNT_DIRECT for email_messages.
-- The policy exists in migration source but RLS remains explicitly DISABLED.
DROP POLICY IF EXISTS email_messages_account_direct ON email_messages;
CREATE POLICY email_messages_account_direct ON email_messages
  FOR ALL TO mantra_app
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());
ALTER TABLE email_messages DISABLE ROW LEVEL SECURITY;

COMMENT ON POLICY email_messages_account_direct ON email_messages IS
  'Dormant ACCOUNT_DIRECT pilot. Do not enable until the separate deployment gate passes.';
