import { createHash, randomUUID } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  deepgramRealtimeConfigSchema,
  environmentCapabilityBindings,
  elevenLabsScribeRealtimeConfigSchema,
  providerConnections,
  speechRecognitionBindingConfigSchema,
  speechRecognitionUseCaseSchema,
  speechmaticsRealtimeConfigSchema,
  type SpeechRecognitionAdapterKind,
  type SpeechRecognitionBindingConfig,
  type SpeechRecognitionUseCase,
} from "@shared/models/platforms";
import { db } from "../db";
import { getProviderCredential } from "../provider-credential-store";
import { getRuntimeIdentity } from "../runtime-identity";
import { getSecretSync } from "../secrets-store";
import type { ResolvedSpeechRecognitionBinding } from "./contracts";

const ADAPTER_PROVIDER: Record<SpeechRecognitionAdapterKind, string> = {
  "elevenlabs-scribe-realtime": "elevenlabs",
  "deepgram-realtime": "deepgram",
  "speechmatics-realtime": "speechmatics",
};

const ADAPTER_MODEL: Record<SpeechRecognitionAdapterKind, string> = {
  "elevenlabs-scribe-realtime": "scribe_v2_realtime",
  "deepgram-realtime": "nova-3",
  "speechmatics-realtime": "enhanced",
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function speechRecognitionConfigFingerprint(config: SpeechRecognitionBindingConfig): string {
  return createHash("sha256").update(stableJson(config)).digest("base64url").slice(0, 22);
}

export function mintRecognitionAttemptId(): string {
  return randomUUID();
}

export function normalizeSpeechRecognitionBindingConfig(value: unknown): SpeechRecognitionBindingConfig {
  return speechRecognitionBindingConfigSchema.parse(value);
}

export interface SpeechRecognitionBindingSummary {
  id: number;
  environmentId: number;
  connectionId: number;
  provider: string;
  adapterKind: SpeechRecognitionAdapterKind;
  useCases: SpeechRecognitionUseCase[];
  model: string;
  config: SpeechRecognitionBindingConfig;
  configFingerprint: string;
  enabled: boolean;
  sortOrder: number;
  connection: {
    label: string;
    status: string;
    hasCredential: boolean;
  };
}

function bindingSummary(row: {
  binding: typeof environmentCapabilityBindings.$inferSelect;
  connection: typeof providerConnections.$inferSelect;
}): SpeechRecognitionBindingSummary {
  const config = normalizeSpeechRecognitionBindingConfig(row.binding.config);
  if (row.binding.provider !== ADAPTER_PROVIDER[config.adapterKind]) {
    throw new Error("Speech recognition binding provider does not match its adapter");
  }
  return {
    id: row.binding.id,
    environmentId: row.binding.environmentId,
    connectionId: row.connection.id,
    provider: row.binding.provider,
    adapterKind: config.adapterKind,
    useCases: config.useCases,
    model: ADAPTER_MODEL[config.adapterKind],
    config,
    configFingerprint: speechRecognitionConfigFingerprint(config),
    enabled: row.binding.enabled,
    sortOrder: row.binding.sortOrder,
    connection: {
      label: row.connection.label,
      status: row.connection.status,
      hasCredential: Boolean(row.connection.credentialEnvelope),
    },
  };
}

async function speechBindingRows(environmentId: number) {
  return db
    .select({ binding: environmentCapabilityBindings, connection: providerConnections })
    .from(environmentCapabilityBindings)
    .innerJoin(providerConnections, eq(environmentCapabilityBindings.connectionId, providerConnections.id))
    .where(and(
      eq(environmentCapabilityBindings.environmentId, environmentId),
      eq(environmentCapabilityBindings.capabilityType, "speech_recognition"),
    ))
    .orderBy(asc(environmentCapabilityBindings.sortOrder), asc(environmentCapabilityBindings.id));
}

export async function listSpeechRecognitionBindings(environmentId: number): Promise<SpeechRecognitionBindingSummary[]> {
  const rows = await speechBindingRows(environmentId);
  return rows.flatMap((row) => {
    try {
      return [bindingSummary(row)];
    } catch {
      return [];
    }
  });
}

function isPlatformManagedConnection(connection: typeof providerConnections.$inferSelect): boolean {
  return connection.scope === "global" || connection.scope === "system";
}

export async function resolveSpeechRecognitionBindingCredential(input: {
  environmentId: number;
  bindingId: number;
}): Promise<ResolvedSpeechRecognitionBinding> {
  const rows = await speechBindingRows(input.environmentId);
  const row = rows.find((candidate) => candidate.binding.id === input.bindingId);
  if (!row || !row.binding.enabled) throw new Error("Speech recognition binding is unavailable");
  const summary = bindingSummary(row);
  if (row.binding.secretEnvelope) throw new Error("Speech recognition bindings cannot own independent secrets");
  if (!isPlatformManagedConnection(row.connection)) {
    throw new Error("Speech recognition requires a platform-managed provider connection");
  }
  if (row.connection.status !== "active") throw new Error("Speech recognition provider connection is inactive");
  const credential = await getProviderCredential(row.connection.id);
  if (!credential) throw new Error("Speech recognition credential could not be resolved");
  return {
    bindingId: summary.id,
    environmentId: summary.environmentId,
    adapterKind: summary.adapterKind,
    provider: summary.provider,
    model: summary.model,
    config: summary.config,
    configFingerprint: summary.configFingerprint,
    credential,
    source: "environment_binding",
  };
}

export async function resolveEnabledSpeechRecognitionBindings(input: {
  environmentId?: number;
  useCase: SpeechRecognitionUseCase;
}): Promise<ResolvedSpeechRecognitionBinding[]> {
  const useCase = speechRecognitionUseCaseSchema.parse(input.useCase);
  const environmentId = input.environmentId ?? (await getRuntimeIdentity()).platformEnvironmentId;
  if (!environmentId) return [];
  const rows = await speechBindingRows(environmentId);
  const resolved: ResolvedSpeechRecognitionBinding[] = [];
  for (const row of rows) {
    let summary: SpeechRecognitionBindingSummary;
    try {
      summary = bindingSummary(row);
    } catch {
      continue;
    }
    if (!summary.enabled || !summary.useCases.includes(useCase)) continue;
    resolved.push(await resolveSpeechRecognitionBindingCredential({ environmentId, bindingId: summary.id }));
  }
  return resolved;
}

function legacyConfig(adapterKind: SpeechRecognitionAdapterKind): SpeechRecognitionBindingConfig {
  if (adapterKind === "elevenlabs-scribe-realtime") {
    return elevenLabsScribeRealtimeConfigSchema.parse({
      version: 1,
      adapterKind,
      useCases: ["meeting_participant_stream"],
    });
  }
  if (adapterKind === "deepgram-realtime") {
    return deepgramRealtimeConfigSchema.parse({
      version: 1,
      adapterKind,
      useCases: ["meeting_shared_room"],
    });
  }
  return speechmaticsRealtimeConfigSchema.parse({
    version: 1,
    adapterKind,
    useCases: ["meeting_shared_room"],
  });
}

/** Rolling migration candidate. It preserves current env-secret routing until every consumer moves. */
export async function resolveLegacySpeechRecognitionBinding(
  adapterKind: "elevenlabs-scribe-realtime" | "deepgram-realtime",
): Promise<ResolvedSpeechRecognitionBinding | null> {
  const credential = getSecretSync(adapterKind === "deepgram-realtime" ? "DEEPGRAM_API_KEY" : "ELEVENLABS_API_KEY")?.trim();
  if (!credential) return null;
  const config = legacyConfig(adapterKind);
  const identity = await getRuntimeIdentity();
  return {
    environmentId: identity.platformEnvironmentId,
    adapterKind,
    provider: ADAPTER_PROVIDER[adapterKind],
    model: ADAPTER_MODEL[adapterKind],
    config,
    configFingerprint: speechRecognitionConfigFingerprint(config),
    credential,
    source: "legacy_environment_secret",
  };
}
