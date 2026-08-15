import type { Pool } from "pg";

const MIGRATION_LOCK_KEY = "life-addressing-schema-v1";

/** Additive, replay-safe schema convergence for the protocol-owned projections. */
export async function ensureLifeAddressingSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS reference_occurrence_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_address TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        source_observed_at TIMESTAMPTZ NOT NULL,
        projection_hash TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        CONSTRAINT reference_occurrence_sources_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT reference_occurrence_sources_address_length_check CHECK (char_length(source_address) BETWEEN 3 AND 2048),
        CONSTRAINT reference_occurrence_sources_revision_length_check CHECK (char_length(source_revision) BETWEEN 1 AND 200),
        CONSTRAINT reference_occurrence_sources_hash_check CHECK (projection_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT reference_occurrence_sources_count_check CHECK (occurrence_count BETWEEN 0 AND 5000)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_reference_occurrence_source_owner
      ON reference_occurrence_sources(owner_user_id, account_id, source_address)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reference_occurrence_sources_scope_owner
      ON reference_occurrence_sources(scope, owner_user_id, account_id, source_address)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reference_occurrence_sources_replay
      ON reference_occurrence_sources(owner_user_id, account_id, source_observed_at, source_address)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reference_occurrences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_projection_id UUID NOT NULL REFERENCES reference_occurrence_sources(id) ON DELETE CASCADE,
        source_address TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurrence_ordinal INTEGER NOT NULL,
        target_address TEXT NOT NULL,
        location_block_id TEXT,
        location_start INTEGER,
        location_end INTEGER,
        origin TEXT NOT NULL DEFAULT 'embedded',
        observed_at TIMESTAMPTZ NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        CONSTRAINT reference_occurrences_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT reference_occurrences_source_length_check CHECK (char_length(source_address) BETWEEN 3 AND 2048),
        CONSTRAINT reference_occurrences_target_length_check CHECK (char_length(target_address) BETWEEN 3 AND 2048),
        CONSTRAINT reference_occurrences_revision_length_check CHECK (char_length(source_revision) BETWEEN 1 AND 200),
        CONSTRAINT reference_occurrences_ordinal_check CHECK (occurrence_ordinal BETWEEN 0 AND 4999),
        CONSTRAINT reference_occurrences_origin_check CHECK (origin = 'embedded'),
        CONSTRAINT reference_occurrences_block_length_check CHECK (location_block_id IS NULL OR char_length(location_block_id) BETWEEN 1 AND 200),
        CONSTRAINT reference_occurrences_location_check CHECK (
          (location_start IS NULL OR location_start >= 0)
          AND (location_end IS NULL OR location_end >= 0)
          AND (location_start IS NULL OR location_end IS NULL OR location_end >= location_start)
        )
      )
    `);
    await client.query(`
      DO $constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'reference_occurrence_sources'::regclass
            AND conname = 'reference_occurrence_sources_count_check'
            AND pg_get_constraintdef(oid) LIKE '%5000%'
        ) THEN
          ALTER TABLE reference_occurrence_sources
            DROP CONSTRAINT IF EXISTS reference_occurrence_sources_count_check,
            ADD CONSTRAINT reference_occurrence_sources_count_check CHECK (occurrence_count BETWEEN 0 AND 5000);
        END IF;
      END
      $constraint$
    `);
    await client.query(`
      DO $constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'reference_occurrences'::regclass
            AND conname = 'reference_occurrences_ordinal_check'
            AND pg_get_constraintdef(oid) LIKE '%4999%'
        ) THEN
          ALTER TABLE reference_occurrences
            DROP CONSTRAINT IF EXISTS reference_occurrences_ordinal_check,
            ADD CONSTRAINT reference_occurrences_ordinal_check CHECK (occurrence_ordinal BETWEEN 0 AND 4999);
        END IF;
      END
      $constraint$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_reference_occurrence_projection_ordinal
      ON reference_occurrences(source_projection_id, occurrence_ordinal)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reference_occurrences_source
      ON reference_occurrences(owner_user_id, account_id, source_address, occurrence_ordinal)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reference_occurrences_target
      ON reference_occurrences(owner_user_id, account_id, target_address, observed_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reference_occurrences_scope_owner
      ON reference_occurrences(scope, owner_user_id, account_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS address_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_address TEXT NOT NULL,
        predicate TEXT NOT NULL,
        target_address TEXT NOT NULL,
        provenance_address TEXT,
        created_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        retired_at TIMESTAMPTZ,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        CONSTRAINT address_links_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT address_links_source_length_check CHECK (char_length(source_address) BETWEEN 3 AND 2048),
        CONSTRAINT address_links_target_length_check CHECK (char_length(target_address) BETWEEN 3 AND 2048),
        CONSTRAINT address_links_provenance_length_check CHECK (provenance_address IS NULL OR char_length(provenance_address) BETWEEN 3 AND 2048),
        CONSTRAINT address_links_distinct_endpoints_check CHECK (source_address <> target_address),
        CONSTRAINT address_links_predicate_check CHECK (predicate ~ '^[a-z][a-z0-9_]{0,79}$'),
        CONSTRAINT address_links_created_by_length_check CHECK (char_length(created_by) BETWEEN 1 AND 200),
        CONSTRAINT address_links_idempotency_length_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
        CONSTRAINT address_links_lifecycle_check CHECK (lifecycle IN ('active', 'retired')),
        CONSTRAINT address_links_retirement_check CHECK (
          (lifecycle = 'active' AND retired_at IS NULL)
          OR (lifecycle = 'retired' AND retired_at IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_address_links_owner_idempotency
      ON address_links(owner_user_id, account_id, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_address_links_source_active
      ON address_links(owner_user_id, account_id, source_address, predicate)
      WHERE lifecycle = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_address_links_target_active
      ON address_links(owner_user_id, account_id, target_address, predicate)
      WHERE lifecycle = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_address_links_scope_owner
      ON address_links(scope, owner_user_id, account_id, lifecycle)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_address_links_active_relationship
      ON address_links(owner_user_id, account_id, source_address, predicate, target_address)
      WHERE lifecycle = 'active'
    `);
    await client.query(`
      ALTER TABLE decision_links ADD COLUMN IF NOT EXISTS address_link_id UUID REFERENCES address_links(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decision_links_address_link
      ON decision_links(address_link_id)
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
