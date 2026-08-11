import type { Pool } from "pg";

export async function ensurePhoneSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS twilio_number_bindings (
    id TEXT PRIMARY KEY, phone_number TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL,
    account_id TEXT NOT NULL, vault_id TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_twilio_number_binding_owner ON twilio_number_bindings(owner_user_id, account_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS phone_call_records (
    id TEXT PRIMARY KEY, call_sid TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, voice_session_id TEXT NOT NULL,
    direction TEXT NOT NULL, from_number TEXT NOT NULL, to_number TEXT NOT NULL, person_id TEXT, person_name TEXT,
    owner_user_id TEXT NOT NULL, account_id TEXT NOT NULL, vault_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    interaction_logged BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TIMESTAMPTZ)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_phone_call_owner ON phone_call_records(owner_user_id, account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_phone_call_session ON phone_call_records(session_id)`);
}
