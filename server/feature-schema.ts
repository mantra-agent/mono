import type { Pool } from "pg";

/** Additive, idempotent Feature domain convergence. */
export async function ensureFeatureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      owner_person_id TEXT NOT NULL,
      spec_page_id TEXT,
      summary TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'idea',
      status TEXT NOT NULL DEFAULT 'ready',
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT features_stage_check CHECK (stage IN ('idea','spec','develop','test','calibrate','maintain','deprecate')),
      CONSTRAINT features_status_check CHECK (status IN ('ready','in_progress','needs_review'))
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_features_product_stage ON features(product_id, stage, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_features_scope_owner ON features(scope, owner_user_id, account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_features_archived ON features(archived_at)`);
}
