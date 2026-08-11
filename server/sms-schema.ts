import type { Pool } from "pg";

export async function ensureSmsSchema(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twilio_number_bindings (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number TEXT NOT NULL,
      owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      vault_id VARCHAR NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_twilio_number_bindings_active_number ON twilio_number_bindings(phone_number) WHERE active = TRUE;
    CREATE INDEX IF NOT EXISTS idx_twilio_number_bindings_owner ON twilio_number_bindings(owner_user_id, account_id, vault_id);

    CREATE TABLE IF NOT EXISTS sms_consent_events (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      vault_id VARCHAR NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      phone_number TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('opted_in', 'opted_out', 'help_requested')),
      disclosure_version TEXT NOT NULL,
      source TEXT NOT NULL,
      provider_message_sid TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sms_consent_events_owner_phone ON sms_consent_events(owner_user_id, account_id, phone_number, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_consent_events_provider_sid_state ON sms_consent_events(provider_message_sid, state) WHERE provider_message_sid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sms_messages (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      vault_id VARCHAR NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      person_id VARCHAR,
      phone_number TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      body TEXT NOT NULL,
      provider_message_sid TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_provider_sid ON sms_messages(provider_message_sid);
    CREATE INDEX IF NOT EXISTS idx_sms_messages_owner_created ON sms_messages(owner_user_id, account_id, created_at);
  `);
}
