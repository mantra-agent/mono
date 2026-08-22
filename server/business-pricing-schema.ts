import type { Pool } from "pg";

/** Additive, replay-safe schema convergence for one closed Pricing catalog per Business. */
export async function ensureBusinessPricingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_pricing (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
      packages JSONB NOT NULL DEFAULT '[]'::jsonb,
      extras JSONB NOT NULL DEFAULT '{}'::jsonb,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      created_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_business_pricing_business ON business_pricing(business_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_pricing_scope_owner ON business_pricing(scope, owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_pricing_account ON business_pricing(account_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_pricing_revisions (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
      pricing_id TEXT NOT NULL REFERENCES business_pricing(id) ON DELETE RESTRICT,
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_pricing_revisions_business ON business_pricing_revisions(business_id, created_at)`);
}
