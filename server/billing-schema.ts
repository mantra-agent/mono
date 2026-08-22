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
  await pool.query(`ALTER TABLE account_billing ADD COLUMN IF NOT EXISTS pricing_revision_id TEXT`);
  await pool.query(`ALTER TABLE account_billing ADD COLUMN IF NOT EXISTS licensed_stripe_price_id TEXT`);
  await pool.query(`ALTER TABLE account_billing ADD COLUMN IF NOT EXISTS overage_stripe_price_id TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_account_billing_account ON account_billing(account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_billing_customer ON account_billing(stripe_customer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_billing_subscription ON account_billing(stripe_subscription_id)`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_package_key_check
        CHECK (package_key IN ('max', 'max_plus', 'factory_plus', 'custom'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_collection_status_check
        CHECK (collection_status IN ('pending_setup', 'active', 'past_due', 'canceled', 'unpaid'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_payment_method_kind_check
        CHECK (payment_method_kind IN ('card', 'us_bank_account', 'none'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_include_tokens_check
        CHECK (include_tokens >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_custom_include_check
        CHECK (package_key <> 'custom' OR include_tokens IS NOT NULL);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_customer_prefix_check
        CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_subscription_prefix_check
        CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE account_billing ADD CONSTRAINT account_billing_cancel_notice_check
        CHECK (cancel_at IS NULL OR cancel_notice_at IS NOT NULL OR term_ends_at IS NOT NULL);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_price_bindings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pricing_revision_id TEXT NOT NULL REFERENCES business_pricing_revisions(id) ON DELETE RESTRICT,
      entry_key TEXT NOT NULL,
      stripe_price_id TEXT,
      stripe_product_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT billing_price_bindings_price_prefix_check CHECK (stripe_price_id IS NULL OR stripe_price_id ~ '^price_'),
      CONSTRAINT billing_price_bindings_product_prefix_check CHECK (stripe_product_id IS NULL OR stripe_product_id ~ '^prod_'),
      CONSTRAINT uq_billing_price_bindings_revision_entry UNIQUE (pricing_revision_id, entry_key)
    )
  `);
  await pool.query(`
    INSERT INTO business_pricing_revisions (id, business_id, pricing_id, snapshot, created_at)
    SELECT 'pricing_rev_' || bp.id || '_' || floor(extract(epoch FROM bp.updated_at) * 1000)::bigint,
      bp.business_id, bp.id, jsonb_build_object('packages', bp.packages, 'extras', bp.extras), bp.updated_at
    FROM business_pricing bp
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    DO $billing_price_migration$
    DECLARE platform_revision_id TEXT;
    BEGIN
      IF to_regclass('public.billing_prices') IS NULL THEN RETURN; END IF;
      SELECT r.id INTO platform_revision_id
      FROM business_pricing_revisions r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.is_platform_instrument = true
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
      IF platform_revision_id IS NULL THEN RETURN; END IF;
      EXECUTE format(
        'INSERT INTO billing_price_bindings (pricing_revision_id, entry_key, stripe_price_id, stripe_product_id, updated_at)
         SELECT %L, key, stripe_price_id, stripe_product_id, updated_at FROM billing_prices WHERE key <> ''custom''
         ON CONFLICT (pricing_revision_id, entry_key) DO UPDATE SET stripe_price_id = EXCLUDED.stripe_price_id, stripe_product_id = EXCLUDED.stripe_product_id, updated_at = EXCLUDED.updated_at',
        platform_revision_id
      );
      EXECUTE format(
        'UPDATE account_billing ab SET pricing_revision_id = COALESCE(ab.pricing_revision_id, %L),
           licensed_stripe_price_id = COALESCE(ab.licensed_stripe_price_id, licensed.stripe_price_id),
           overage_stripe_price_id = COALESCE(ab.overage_stripe_price_id, overage.stripe_price_id)
         FROM billing_prices licensed, billing_prices overage
         WHERE licensed.key = ab.package_key AND overage.key = ''token_overage''
           AND (ab.pricing_revision_id IS NULL OR ab.licensed_stripe_price_id IS NULL OR ab.overage_stripe_price_id IS NULL)',
        platform_revision_id
      );
      DROP TABLE billing_prices;
    END $billing_price_migration$
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_meter_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_call_id INTEGER,
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
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_meter_deliveries_identifier ON billing_meter_deliveries(stripe_identifier)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_meter_deliveries_api_call ON billing_meter_deliveries(api_call_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_billing_meter_deliveries_status ON billing_meter_deliveries(status, created_at)`);

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
