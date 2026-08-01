import type { Pool } from "pg";

const MIGRATION_LOCK_KEY = "mod-platform-schema-v1";

/**
 * Additive, replay-safe schema convergence for the Mod platform persistence
 * foundation. Ordinary Mod mutations flow through ModLifecycleService; this
 * ensure only guarantees the three account-owned structures exist at runtime.
 */
export async function ensureModPlatformSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mod_entitlements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mod_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'granted',
        source_type TEXT,
        source_id TEXT,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mod_entitlements_status_check CHECK (status IN ('granted', 'suspended', 'expired')),
        CONSTRAINT mod_entitlements_mod_key_check CHECK (mod_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
        CONSTRAINT mod_entitlements_validity_check CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_mod_entitlements_account_mod
      ON mod_entitlements(account_id, mod_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mod_entitlements_scope_owner
      ON mod_entitlements(scope, owner_user_id, account_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mod_installations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mod_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'installing',
        resolved_version TEXT,
        installed_by_user_id TEXT,
        activated_at TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        failure_code TEXT,
        failure_detail TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mod_installations_status_check CHECK (status IN ('installing', 'active', 'disabling', 'disabled', 'error')),
        CONSTRAINT mod_installations_mod_key_check CHECK (mod_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
        CONSTRAINT mod_installations_failure_detail_check CHECK (failure_detail IS NULL OR char_length(failure_detail) <= 2000),
        CONSTRAINT mod_installations_failure_code_check CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 80)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_mod_installations_account_mod
      ON mod_installations(account_id, mod_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mod_installations_scope_owner
      ON mod_installations(scope, owner_user_id, account_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mod_installations_status
      ON mod_installations(account_id, status)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mod_installation_resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        installation_id UUID NOT NULL REFERENCES mod_installations(id) ON DELETE CASCADE,
        contribution_id TEXT NOT NULL,
        subject_user_id TEXT,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mod_installation_resources_status_check CHECK (status IN ('active', 'disabled', 'detached', 'error')),
        CONSTRAINT mod_installation_resources_kind_check CHECK (char_length(resource_kind) BETWEEN 1 AND 80),
        CONSTRAINT mod_installation_resources_hash_check CHECK (char_length(definition_hash) BETWEEN 1 AND 200)
      )
    `);
    // Spec §5.3 unique (installation_id, contribution_id, subject_user_id).
    // subject_user_id is nullable (account-level materialization); collapse
    // NULL to '' so duplicate account-level rows cannot bypass uniqueness.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_mod_installation_resources_contribution
      ON mod_installation_resources(installation_id, contribution_id, coalesce(subject_user_id, ''))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mod_installation_resources_installation
      ON mod_installation_resources(installation_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mod_installation_resources_scope_owner
      ON mod_installation_resources(scope, owner_user_id, account_id)
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
