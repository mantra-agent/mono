import type { Pool } from "pg";

/**
 * Additive Slack pilot schema. Statements stay separate so one bad DDL cannot
 * hide behind a multi-statement string, and every regex CHECK is a complete
 * PostgreSQL string literal (closing $' required — bare {n,m} is syntax error).
 */
export async function ensureSlackSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_installations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
      provider_connection_id INTEGER NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
      team_id TEXT NOT NULL,
      api_app_id TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      allowed_channel_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      allowed_channel_name TEXT,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'unconfigured',
      last_connected_at TIMESTAMPTZ,
      last_error_code TEXT,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT slack_installations_ids_check CHECK (
        team_id ~ '^T[A-Z0-9]{1,31}$' AND api_app_id ~ '^A[A-Z0-9]{1,31}$' AND bot_user_id ~ '^U[A-Z0-9]{1,31}$'
      ),
      CONSTRAINT slack_installations_channel_ids_check CHECK (
        cardinality(allowed_channel_ids) = 0 OR allowed_channel_ids[1] ~ '^C[A-Z0-9]{1,31}$'
      ),
      CONSTRAINT slack_installations_channel_limit CHECK (cardinality(allowed_channel_ids) <= 1),
      CONSTRAINT slack_installations_channel_name_check CHECK (
        allowed_channel_name IS NULL OR allowed_channel_name ~ '^#?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'
      ),
      CONSTRAINT slack_installations_status_check CHECK (status IN ('unconfigured','ready','connected','degraded','disabled'))
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_team_app_environment_unique
      ON slack_installations(team_id, api_app_id, platform_environment_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_one_enabled_app
      ON slack_installations(team_id, api_app_id) WHERE enabled
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_installations_account_owner
      ON slack_installations(account_id, owner_user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_principal_mappings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      mantra_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT slack_principal_mappings_ids_check CHECK (
        team_id ~ '^T[A-Z0-9]{1,31}$' AND slack_user_id ~ '^U[A-Z0-9]{1,31}$'
      )
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_principal_mappings_external_unique
      ON slack_principal_mappings(installation_id, team_id, slack_user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_principal_mappings_account_user
      ON slack_principal_mappings(account_id, mantra_user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_session_bindings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
      mapping_id UUID NOT NULL REFERENCES slack_principal_mappings(id) ON DELETE RESTRICT,
      external_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      root_ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT slack_session_bindings_external_key_check CHECK (char_length(external_key) BETWEEN 1 AND 240)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_session_bindings_external_unique
      ON slack_session_bindings(installation_id, external_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_session_bindings_session_unique
      ON slack_session_bindings(session_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      root_ts TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      body TEXT,
      body_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ,
      mapping_id UUID REFERENCES slack_principal_mappings(id) ON DELETE SET NULL,
      binding_id UUID REFERENCES slack_session_bindings(id) ON DELETE SET NULL,
      session_id TEXT,
      client_turn_id TEXT,
      response_hash TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'none',
      delivery_client_msg_id UUID NOT NULL,
      delivery_ts TEXT,
      failure_code TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT slack_events_status_check CHECK (status IN ('received','ignored','queued','processing','completed','failed','delivery_failed','blocked')),
      CONSTRAINT slack_events_delivery_check CHECK (delivery_state IN ('none','progress','final','failure','failed')),
      CONSTRAINT slack_events_body_limit CHECK (body IS NULL OR char_length(body) <= 4000),
      CONSTRAINT slack_events_attempt_limit CHECK (attempt_count BETWEEN 0 AND 3)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_events_provider_unique
      ON slack_events(installation_id, event_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_events_claim
      ON slack_events(installation_id, status, received_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_events_retention
      ON slack_events(updated_at)
  `);

  // Rolling-deploy repair for pre-channel-name tables and any prior incomplete CHECKs.
  await pool.query(`ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS allowed_channel_name TEXT`);
  await pool.query(`ALTER TABLE slack_installations DROP CONSTRAINT IF EXISTS slack_installations_ids_check`);
  await pool.query(`
    ALTER TABLE slack_installations ADD CONSTRAINT slack_installations_ids_check CHECK (
      team_id ~ '^T[A-Z0-9]{1,31}$' AND api_app_id ~ '^A[A-Z0-9]{1,31}$' AND bot_user_id ~ '^U[A-Z0-9]{1,31}$'
    )
  `);
  await pool.query(`ALTER TABLE slack_installations DROP CONSTRAINT IF EXISTS slack_installations_channel_ids_check`);
  await pool.query(`
    ALTER TABLE slack_installations ADD CONSTRAINT slack_installations_channel_ids_check CHECK (
      cardinality(allowed_channel_ids) = 0 OR allowed_channel_ids[1] ~ '^C[A-Z0-9]{1,31}$'
    )
  `);
  await pool.query(`ALTER TABLE slack_installations DROP CONSTRAINT IF EXISTS slack_installations_channel_name_check`);
  await pool.query(`
    ALTER TABLE slack_installations ADD CONSTRAINT slack_installations_channel_name_check CHECK (
      allowed_channel_name IS NULL OR allowed_channel_name ~ '^#?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'
    )
  `);
  await pool.query(`ALTER TABLE slack_principal_mappings DROP CONSTRAINT IF EXISTS slack_principal_mappings_ids_check`);
  await pool.query(`
    ALTER TABLE slack_principal_mappings ADD CONSTRAINT slack_principal_mappings_ids_check CHECK (
      team_id ~ '^T[A-Z0-9]{1,31}$' AND slack_user_id ~ '^U[A-Z0-9]{1,31}$'
    )
  `);

  // Outbound tool receipts. Distinct from inbound slack_events (event_id keyed).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_outbound_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      origin TEXT NOT NULL,
      caller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      session_id TEXT,
      run_id TEXT,
      tool_call_id TEXT,
      destination_kind TEXT NOT NULL,
      destination_slack_id TEXT NOT NULL,
      person_id TEXT,
      mapping_id UUID REFERENCES slack_principal_mappings(id) ON DELETE SET NULL,
      body TEXT,
      body_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      delivery_client_msg_id UUID NOT NULL,
      delivery_channel TEXT,
      delivery_ts TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      CONSTRAINT slack_outbound_messages_idempotency_check CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
      CONSTRAINT slack_outbound_messages_origin_check CHECK (
        origin IN ('interactive','autonomous','timer','hook','skill','plan')
      ),
      CONSTRAINT slack_outbound_messages_destination_kind_check CHECK (destination_kind IN ('dm','channel')),
      CONSTRAINT slack_outbound_messages_destination_id_check CHECK (
        (destination_kind = 'dm' AND destination_slack_id ~ '^U[A-Z0-9]{1,31}$')
        OR (destination_kind = 'channel' AND destination_slack_id ~ '^C[A-Z0-9]{1,31}$')
      ),
      CONSTRAINT slack_outbound_messages_status_check CHECK (
        status IN ('queued','sending','sent','failed','blocked')
      ),
      CONSTRAINT slack_outbound_messages_body_limit CHECK (body IS NULL OR char_length(body) <= 4000),
      CONSTRAINT slack_outbound_messages_attempt_limit CHECK (attempt_count BETWEEN 0 AND 3)
    )
  `);
  // Repair destination CHECK if an earlier incomplete CREATE left no constraint or a broken one.
  await pool.query(`ALTER TABLE slack_outbound_messages DROP CONSTRAINT IF EXISTS slack_outbound_messages_destination_id_check`);
  await pool.query(`
    ALTER TABLE slack_outbound_messages ADD CONSTRAINT slack_outbound_messages_destination_id_check CHECK (
      (destination_kind = 'dm' AND destination_slack_id ~ '^U[A-Z0-9]{1,31}$')
      OR (destination_kind = 'channel' AND destination_slack_id ~ '^C[A-Z0-9]{1,31}$')
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS slack_outbound_messages_idempotency_unique
      ON slack_outbound_messages(installation_id, idempotency_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_outbound_messages_rate_destination
      ON slack_outbound_messages(installation_id, destination_slack_id, created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_outbound_messages_rate_caller
      ON slack_outbound_messages(caller_user_id, created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS slack_outbound_messages_retention
      ON slack_outbound_messages(updated_at)
  `);
}
