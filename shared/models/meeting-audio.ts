import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { SpeechRecognitionAdapterKind } from "./platforms";

export const MEETING_AUDIO_CONSENT_VERSION = 1 as const;
export const MEETING_AUDIO_MAX_RETENTION_DAYS = 7 as const;
export const MEETING_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const MEETING_AUDIO_MAX_DURATION_MS = 15 * 60 * 1000;

export type MeetingAudioSampleStatus = "recording" | "ready" | "failed" | "deleted" | "expired";
export type MeetingAudioEvaluationStatus = "queued" | "running" | "completed" | "failed" | "deleted";

export interface MeetingAudioRecognitionProvenance {
  attemptId: string;
  bindingId?: number;
  adapterKind: SpeechRecognitionAdapterKind;
  provider: string;
  model: string;
  configFingerprint: string;
}

export interface MeetingAudioRetentionState {
  sampleId: string;
  status: MeetingAudioSampleStatus;
  consentVersion: typeof MEETING_AUDIO_CONSENT_VERSION;
  consentedAt: string;
  expiresAt: string;
  byteCount?: number;
  durationMs?: number;
  failureCode?: string;
}

export const meetingAudioSamples = pgTable("meeting_audio_samples", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id").notNull(),
  sourceKey: text("source_key").notNull(),
  status: text("status").$type<MeetingAudioSampleStatus>().notNull().default("recording"),
  consentVersion: integer("consent_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
  retentionDays: integer("retention_days").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  objectKey: text("object_key"),
  byteCount: integer("byte_count").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  sampleRateHz: integer("sample_rate_hz").notNull().default(16000),
  channels: integer("channels").notNull().default(1),
  encoding: text("encoding").notNull().default("pcm_s16le"),
  originalRecognitionProvenance: jsonb("original_recognition_provenance")
    .$type<MeetingAudioRecognitionProvenance[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  failureCode: text("failure_code"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("meeting_audio_samples_owner_session_source").on(table.ownerUserId, table.accountId, table.sessionId, table.sourceKey),
  index("meeting_audio_samples_owner_created").on(table.ownerUserId, table.createdAt),
  index("meeting_audio_samples_expiry").on(table.status, table.expiresAt),
  index("meeting_audio_samples_session").on(table.sessionId),
  check("meeting_audio_samples_scope_check", sql`${table.scope} = 'user'`),
  check("meeting_audio_samples_status_check", sql`${table.status} IN ('recording','ready','failed','deleted','expired')`),
  check("meeting_audio_samples_retention_check", sql`${table.retentionDays} BETWEEN 1 AND ${MEETING_AUDIO_MAX_RETENTION_DAYS}`),
  check("meeting_audio_samples_format_check", sql`${table.encoding} = 'pcm_s16le' AND ${table.sampleRateHz} = 16000 AND ${table.channels} = 1`),
  check("meeting_audio_samples_size_check", sql`${table.byteCount} BETWEEN 0 AND ${MEETING_AUDIO_MAX_BYTES}`),
  check("meeting_audio_samples_duration_check", sql`${table.durationMs} BETWEEN 0 AND ${MEETING_AUDIO_MAX_DURATION_MS}`),
]);

export const meetingAudioEvaluations = pgTable("meeting_audio_evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sampleId: uuid("sample_id").notNull().references(() => meetingAudioSamples.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").$type<MeetingAudioEvaluationStatus>().notNull().default("queued"),
  environmentId: integer("environment_id").notNull(),
  bindingId: integer("binding_id").notNull(),
  attemptId: text("attempt_id"),
  adapterKind: text("adapter_kind").$type<SpeechRecognitionAdapterKind>(),
  provider: text("provider"),
  model: text("model"),
  configFingerprint: text("config_fingerprint"),
  originalRecognitionProvenance: jsonb("original_recognition_provenance")
    .$type<MeetingAudioRecognitionProvenance[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  resultObjectKey: text("result_object_key"),
  utteranceCount: integer("utterance_count").notNull().default(0),
  firstFinalLatencyMs: integer("first_final_latency_ms"),
  finalizationLatencyMs: integer("finalization_latency_ms"),
  failureCode: text("failure_code"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("meeting_audio_evaluations_owner_idempotency").on(table.ownerUserId, table.accountId, table.idempotencyKey),
  index("meeting_audio_evaluations_sample_created").on(table.sampleId, table.createdAt),
  index("meeting_audio_evaluations_owner_created").on(table.ownerUserId, table.createdAt),
  check("meeting_audio_evaluations_scope_check", sql`${table.scope} = 'user'`),
  check("meeting_audio_evaluations_status_check", sql`${table.status} IN ('queued','running','completed','failed','deleted')`),
  check("meeting_audio_evaluations_utterance_check", sql`${table.utteranceCount} BETWEEN 0 AND 10000`),
]);

export type MeetingAudioSample = typeof meetingAudioSamples.$inferSelect;
export type MeetingAudioEvaluation = typeof meetingAudioEvaluations.$inferSelect;
