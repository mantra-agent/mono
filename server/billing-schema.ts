import type { Pool } from "pg";

/** Additive, replay-safe schema for the Account Stripe collector. */
export async function ensureBillingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_billing (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      package_key TEXT NOT NULL,
      include_tokens INTEGER NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_meter_id TEXT,
      term_started_at TIMESTAMPTZ,
      term_ends_at TIMESTAMPTZ,
      cancel_notice_at TIMESTAMPTZ,
      cancel_at TIMESTAMPTZ,
      collection_status TEXT NOT NULL DEFAULT 'pending_setup',
      payment_method_kind TEXT NOT NULL DEFAULT 'none',
      checkout_session_id TEXT,
      checkout_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_account_billing_account ON account_billing(account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_billing_customer ON account_billing(stripe_customer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_billing_subscription ON account_billing(stripe_subscription_id)`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_package_key_check
        CHECK (package_key IN ('max', 'max_plus', 'factory_plus', 'custom'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_collection_status_check
        CHECK (collection_status IN ('pending_setup', 'active', 'past_due', 'canceled', 'unpaid'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_payment_method_kind_check
        CHECK (payment_method_kind IN ('card', 'us_bank_account', 'none'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_include_tokens_check
        CHECK (include_tokens >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_custom_include_check
        CHECK (package_key <> 'custom' OR include_tokens IS NOT NULL);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_customer_prefix_check
        CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_subscription_prefix_check
        CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing
        ADD CONSTRAINT account_billing_cancel_notice_check
        CHECK (cancel_at IS NULL OR cancel_notice_at IS NOT NULL OR term_ends_at IS NOT NULL);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_prices (
      key TEXT PRIMARY KEY,
      stripe_price_id TEXT NOT NULL,
      stripe_product_id TEXT,
      amount_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'usd',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT billing_prices_key_check CHECK (
        key IN (
          'max', 'max_plus', 'factory_plus',
          'extra_principal', 'extra_agent', 'extra_participant',
          'token_overage', 'tive_custom'
        )
      ),
      CONSTRAINT billing_prices_price_prefix_check CHECK (stripe_price_id ~ '^price_')
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_meter_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_call_id INTEGER NOT NULL,
      account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      account_billing_id UUID NOT NULL REFERENCES account_billing(id) ON DELETE CASCADE,
      token_delta INTEGER NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      stripe_identifier TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT billing_meter_deliveries_status_check CHECK (status IN ('queued', 'delivered', 'error'))
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_meter_deliveries_api_call
    ON billing_meter_deliveries(api_call_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_billing_meter_deliveries_status
    ON billing_meter_deliveries(status, created_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      account_billing_id UUID,
      stripe_object_id TEXT,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
