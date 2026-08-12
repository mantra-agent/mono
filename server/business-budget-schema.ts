import type { Pool } from "pg";

/** Additive, replay-safe schema convergence for one hypothetical monthly budget per Business. */
export async function ensureBusinessBudgetsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_budgets (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
      year INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      departments JSONB NOT NULL DEFAULT '[]'::jsonb,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      created_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT business_budgets_year_range CHECK (year BETWEEN 2000 AND 2200),
      CONSTRAINT business_budgets_currency_usd CHECK (currency = 'USD')
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_business_budgets_business_year ON business_budgets(business_id, year)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_budgets_scope_owner ON business_budgets(scope, owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_budgets_account ON business_budgets(account_id)`);
}
