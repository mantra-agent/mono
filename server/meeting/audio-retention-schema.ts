import { sql } from "drizzle-orm";
import { db } from "../db";

/** Ordered boot owner for the additive retained meeting-audio schema. */
export async function ensureMeetingAudioRetentionSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS meeting_audio_samples (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      consent_version INTEGER NOT NULL,
      consented_at TIMESTAMPTZ NOT NULL,
      retention_days INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      object_key TEXT,
      byte_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      sample_rate_hz INTEGER NOT NULL DEFAULT 16000,
      channels INTEGER NOT NULL DEFAULT 1,
      encoding TEXT NOT NULL DEFAULT 'pcm_s16le',
      original_recognition_provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
      failure_code TEXT,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT meeting_audio_samples_scope_check CHECK (scope = 'user'),
      CONSTRAINT meeting_audio_samples_status_check CHECK (status IN ('recording','ready','failed','deleted','expired')),
      CONSTRAINT meeting_audio_samples_retention_check CHECK (retention_days BETWEEN 1 AND 7),
      CONSTRAINT meeting_audio_samples_format_check CHECK (encoding = 'pcm_s16le' AND sample_rate_hz = 16000 AND channels = 1),
      CONSTRAINT meeting_audio_samples_size_check CHECK (byte_count BETWEEN 0 AND 33554432),
      CONSTRAINT meeting_audio_samples_duration_check CHECK (duration_ms BETWEEN 0 AND 900000)
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS meeting_audio_samples_owner_session_source ON meeting_audio_samples(owner_user_id, account_id, session_id, source_key)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audio_samples_owner_created ON meeting_audio_samples(owner_user_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audio_samples_expiry ON meeting_audio_samples(status, expires_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audio_samples_session ON meeting_audio_samples(session_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS meeting_audio_evaluations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sample_id UUID NOT NULL REFERENCES meeting_audio_samples(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
      binding_id INTEGER NOT NULL REFERENCES environment_capability_bindings(id) ON DELETE RESTRICT,
      attempt_id TEXT,
      adapter_kind TEXT,
      provider TEXT,
      model TEXT,
      config_fingerprint TEXT,
      original_recognition_provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
      result_object_key TEXT,
      utterance_count INTEGER NOT NULL DEFAULT 0,
      first_final_latency_ms INTEGER,
      finalization_latency_ms INTEGER,
      failure_code TEXT,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      completed_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT meeting_audio_evaluations_scope_check CHECK (scope = 'user'),
      CONSTRAINT meeting_audio_evaluations_status_check CHECK (status IN ('queued','running','completed','failed','deleted')),
      CONSTRAINT meeting_audio_evaluations_utterance_check CHECK (utterance_count BETWEEN 0 AND 10000)
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS meeting_audio_evaluations_owner_idempotency ON meeting_audio_evaluations(owner_user_id, account_id, idempotency_key)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audio_evaluations_sample_created ON meeting_audio_evaluations(sample_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audio_evaluations_owner_created ON meeting_audio_evaluations(owner_user_id, created_at DESC)`);
}
