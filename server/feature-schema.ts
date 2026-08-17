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
  await pool.query(`ALTER TABLE features ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_features_product_stage ON features(product_id, stage, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_features_scope_owner ON features(scope, owner_user_id, account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_features_archived ON features(archived_at)`);

  // Append-only stage/status provenance. Every meaningful Feature state change
  // records from→to plus a required why-note. feature-storage is the sole writer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'system',
      actor_user_id TEXT,
      session_id TEXT,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT feature_history_to_stage_check CHECK (to_stage IN ('idea','spec','develop','test','calibrate','maintain','deprecate')),
      CONSTRAINT feature_history_to_status_check CHECK (to_status IN ('ready','in_progress','needs_review')),
      CONSTRAINT feature_history_from_stage_check CHECK (from_stage IS NULL OR from_stage IN ('idea','spec','develop','test','calibrate','maintain','deprecate')),
      CONSTRAINT feature_history_from_status_check CHECK (from_status IS NULL OR from_status IN ('ready','in_progress','needs_review')),
      CONSTRAINT feature_history_note_nonempty CHECK (char_length(btrim(note)) > 0)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feature_history_feature_created ON feature_history(feature_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feature_history_scope_owner ON feature_history(scope, owner_user_id, account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feature_history_to_stage ON feature_history(to_stage, created_at DESC)`);
}
