import { getPublicBaseUrl } from "./voice-llm";
import { createLogger } from "./log";
import { getSecretSync, onSecretChange } from "./secrets-store";
import crypto from "crypto";
import { HIGH_QUALITY_SCRIBE_POLICY } from "./voice/stt";
import { buildLanguagePresets, ELEVENLABS_ADDITIONAL_LANGUAGE_CODES } from "./voice/provider-system-tools";
import { providerFetch, readBoundedProviderBody } from "./integrations/provider-http";

const log = createLogger("ElevenLabs");
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

let cachedApiKey: string | null = null;
let cachedVoiceId: string | null = null;

onSecretChange((name) => {
  if (name === "ELEVENLABS_API_KEY") cachedApiKey = null;
});
const LEGAL_CASCADE_TIMEOUT_SECONDS = 15;
const DISABLED_SOFT_TIMEOUT_SECONDS = -1;
const DISABLED_SOFT_TIMEOUT_MESSAGE = ".";
let verifiedCascadeTimeoutSeconds: number = LEGAL_CASCADE_TIMEOUT_SECONDS;
let verifiedSoftTimeoutSeconds: number = 0;

export function getVerifiedCascadeTimeoutSeconds(): number {
  return verifiedCascadeTimeoutSeconds;
}

export function getVerifiedSoftTimeoutSeconds(): number {
  return verifiedSoftTimeoutSeconds;
}

export interface AgentPromptConfig {
  prompt: string;
  llm?: string;
  custom_llm?: {
    url: string;
    model_id: string;
    cascade_timeout_seconds?: number;
  };
  tool_ids?: string[];
  tools?: Array<{
    type: "system";
    name: "language_detection";
    description: string;
  }>;
}

export interface AgentBaseConfig {
  prompt: AgentPromptConfig;
  language: string;
  first_message?: string;
}

export interface AgentConversationConfig {
  agent: AgentBaseConfig;
  tts: {
    voice_id: string;
    model_id: string;
    suggested_audio_tags?: Array<{ tag: string; description?: string }>;
    pronunciation_dictionary_locators?: Array<{
      pronunciation_dictionary_id: string;
      version_id: string;
    }>;
    voice_settings?: {
      speed?: number;
      stability?: number;
      similarity_boost?: number;
      style?: number;
    };
  };
  asr?: {
    quality: string;
    provider: string;
  };
  turn?: {
    mode: string;
    turn_timeout: number;
    cascade_timeout_seconds?: number;
    end_of_speech_silence_ms?: number;
    interruption_sensitivity?: number;
    soft_timeout_config?: {
      timeout_seconds: number;
      message: string;
      use_llm_generated_message: boolean;
    };
  };
  max_duration_seconds?: number;
  language_presets?: Record<string, {
    overrides: { agent: { first_message: string } };
  }>;
}

export interface AgentPatchPayload {
  conversation_config: AgentConversationConfig;
  platform_settings?: {
    overrides?: Record<string, unknown>;
  };
  name?: string;
}

interface AgentPatchResponse {
  agent_id?: string;
  conversation_config?: {
    turn?: {
      turn_timeout?: number;
      mode?: string;
      end_of_speech_silence_ms?: number;
      interruption_sensitivity?: number;
      cascade_timeout_seconds?: number;
    };
    agent?: {
      prompt?: {
        custom_llm?: {
          url?: string;
          api_type?: string;
          cascade_timeout_seconds?: number;
        };
      };
      first_message?: string;
    };
  };
}

interface AgentCreateResponse {
  agent_id: string;
}

interface SignedUrlResponse {
  signed_url: string;
}

interface VoicesListResponse {
  voices?: Array<VoiceRaw>;
}

interface VoiceRaw {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
  description?: string;
}

async function getCredentials(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const key = getSecretSync("ELEVENLABS_API_KEY");
  if (!key) {
    throw new Error("ElevenLabs API key not configured. Add ELEVENLABS_API_KEY in Settings → Connections.");
  }
  cachedApiKey = key;
  log.log("API key cached for process lifetime");
  return cachedApiKey;
}

export function getCachedVoiceId(): string {
  return cachedVoiceId || DEFAULT_VOICE_ID;
}

export async function registerTwilioCall(input: {
  agentId: string;
  fromNumber: string;
  toNumber: string;
  direction: "inbound" | "outbound";
  sessionId: string;
}): Promise<string> {
  const apiKey = await getCredentials();
  const response = await providerFetch(`${ELEVENLABS_API_BASE}/convai/twilio/register-call`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: input.agentId,
      from_number: input.fromNumber,
      to_number: input.toNumber,
      direction: input.direction,
      conversation_initiation_client_data: {
        custom_llm_extra_body: { sessionId: input.sessionId },
      },
    }),
    timeoutMs: 10_000,
  });
  const twiml = await readBoundedProviderBody(response, 64_000);
  if (!response.ok) throw new Error(`ElevenLabs register-call returned ${response.status}`);
  if (!twiml.trim().startsWith("<")) throw new Error("ElevenLabs register-call returned invalid TwiML");
  return twiml;
}

export async function fetchAndCacheVoiceId(agentId: string): Promise<string> {
  if (cachedVoiceId) return cachedVoiceId;
  try {
    const cfg = await getAgentConfig(agentId);
    const convCfg = cfg.conversation_config as Record<string, unknown> | undefined;
    if (convCfg) {
      const tts = convCfg.tts as Record<string, unknown> | undefined;
      if (tts && typeof tts.voice_id === "string") {
        cachedVoiceId = tts.voice_id;
        log.debug(`voiceId cached: ${cachedVoiceId}`);
        return cachedVoiceId;
      }
    }
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`fetchAndCacheVoiceId failed (using default): ${m}`);
  }
  cachedVoiceId = DEFAULT_VOICE_ID;
  return cachedVoiceId;
}

export async function setupAgentCallbackUrl(agentId: string): Promise<void> {
  const setupStart = Date.now();
  log.log(`setupAgentCallbackUrl: BEGIN agentId=${agentId}`);

  log.debug(`setupAgentCallbackUrl: step 1/6 — getCredentials`);
  const apiKey = await getCredentials();
  log.debug(`setupAgentCallbackUrl: step 1/6 — getCredentials done (${Date.now() - setupStart}ms)`);

  log.debug(`setupAgentCallbackUrl: step 2/6 — getPublicBaseUrl`);
  const baseUrl = getPublicBaseUrl();
  const callbackSecret = getSecretSync("SESSION_SECRET")?.trim();
  if (!callbackSecret) throw new Error("SESSION_SECRET is required for the ElevenLabs callback capability");
  const callbackToken = crypto.createHmac("sha256", callbackSecret).update("elevenlabs-custom-llm-v1").digest("base64url");
  const callbackUrl = `${baseUrl}/api/voice/llm/route/${callbackToken}`;
  log.debug(`setupAgentCallbackUrl: step 2/6 — getPublicBaseUrl done callbackOrigin=${new URL(callbackUrl).origin} (${Date.now() - setupStart}ms)`);

  const { hasVoiceWebhookBaseUrlOverride } = await import("./voice-webhook-base-url");
  const overridden = hasVoiceWebhookBaseUrlOverride();
  const isDev = process.env.NODE_ENV === "development";
  const isDevUrl = /localhost|127\.0\.0\.1/.test(baseUrl);
  if (isDev && isDevUrl && !overridden) {
    log.warn(`setupAgentCallbackUrl: SKIPPING PATCH in dev mode — dev URL (${baseUrl}) would overwrite production callback URL. Set the Voice Webhook Base URL override in voice settings, or set VOICE_LLM_BASE_URL.`);
    return;
  }

  log.debug(`setupAgentCallbackUrl: step 3/6 — getTtsConfig`);
  const { getTtsConfig } = await import("./routes/voice-config");
  const ttsConfig = await getTtsConfig();
  log.debug(`setupAgentCallbackUrl: step 3/6 — getTtsConfig done model=${ttsConfig.modelId} expressive=${ttsConfig.expressiveEnabled} tagCount=${ttsConfig.suggestedAudioTags.length} (${Date.now() - setupStart}ms)`);

  const ttsPayload: AgentConversationConfig["tts"] = {
    voice_id: getCachedVoiceId(),
    model_id: ttsConfig.modelId,
  };

  if (ttsConfig.expressiveEnabled && ttsConfig.modelId === "eleven_v3_conversational") {
    (ttsPayload as Record<string, unknown>).expressive_mode = true;
    if (ttsConfig.suggestedAudioTags.length > 0) {
      ttsPayload.suggested_audio_tags = ttsConfig.suggestedAudioTags.map(t => ({
        tag: t.tag,
        ...(t.description ? { description: t.description } : {}),
      }));
    }
  }

  ttsPayload.voice_settings = {
    speed: ttsConfig.speed,
    stability: ttsConfig.stability,
    similarity_boost: ttsConfig.similarityBoost,
    style: ttsConfig.style,
  };

  log.debug(`setupAgentCallbackUrl: step 4/6 — getDictionaryLocator`);
  try {
    const { getDictionaryLocator } = await import("./pronunciation");
    const locator = await getDictionaryLocator();
    if (locator) {
      ttsPayload.pronunciation_dictionary_locators = [locator];
      log.debug(`setupAgentCallbackUrl: step 4/6 — getDictionaryLocator done id=${locator.pronunciation_dictionary_id} version=${locator.version_id} (${Date.now() - setupStart}ms)`);
    } else {
      log.debug(`setupAgentCallbackUrl: step 4/6 — getDictionaryLocator done (no locator) (${Date.now() - setupStart}ms)`);
    }
  } catch (err) {
    log.warn(`setupAgentCallbackUrl: step 4/6 — getDictionaryLocator FAILED (${Date.now() - setupStart}ms)`, err);
  }

  log.debug(`setupAgentCallbackUrl: step 5/6 — PATCH agent config`);
  const payload: AgentPatchPayload = {
    conversation_config: {
      agent: {
        prompt: {
          prompt: "You are an Agent. Use the identity and instructions supplied by the custom LLM context.",
          llm: "custom-llm",
          custom_llm: {
            url: callbackUrl,
            model_id: "xyz-voice",
            // Preferred home when the provider retains it. Always dual-write turn
            // below — current EL GET often leaves custom_llm.cascade absent.
            cascade_timeout_seconds: LEGAL_CASCADE_TIMEOUT_SECONDS,
          },
          tool_ids: [],
          tools: [{
            type: "system",
            name: "language_detection",
            description: "",
          }],
        },
        language: "en",
        first_message: "",
      },
      language_presets: buildLanguagePresets(),
      tts: ttsPayload,
      asr: {
        quality: "high",
        provider: HIGH_QUALITY_SCRIBE_POLICY.provider,
      },
      turn: {
        mode: "turn",
        turn_timeout: 60,
        // EL currently persists cascade here even when custom_llm.cascade is dropped.
        cascade_timeout_seconds: LEGAL_CASCADE_TIMEOUT_SECONDS,
        end_of_speech_silence_ms: 1000,
        interruption_sensitivity: 0.5,
        // Official disable is -1. Message is still required 1–200 chars; empty 400s.
        // "." is schema tax, not speech. Spoken dummies are unrepresentable.
        soft_timeout_config: {
          timeout_seconds: DISABLED_SOFT_TIMEOUT_SECONDS,
          message: DISABLED_SOFT_TIMEOUT_MESSAGE,
          use_llm_generated_message: false,
        },
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: {
            first_message: true,
            language: true,
            prompt: {
              prompt: true,
            },
          },
          tts: {
            voice_id: true,
          },
        },
        custom_llm_extra_body: true,
      },
    },
    name: "Agent Voice",
  };

  const reqStart = Date.now();
  const res = await providerFetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    method: "PATCH",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const patchElapsed = Date.now() - reqStart;
  if (!res.ok) {
    const error = await readBoundedProviderBody(res);
    log.error(`setupAgentCallbackUrl: step 5/6 — PATCH FAILED status=${res.status} elapsed=${patchElapsed}ms body: ${error} (total=${Date.now() - setupStart}ms)`);
    throw new Error(`Failed to setup agent callback URL: ${res.status} ${error}`);
  }

  const responseText = await res.text();
  let responseData: AgentPatchResponse;
  try {
    responseData = JSON.parse(responseText);
  } catch (parseErr) {
    log.error(`setupAgentCallbackUrl: step 5/6 — PATCH response not valid JSON elapsed=${patchElapsed}ms body=${responseText.slice(0, 2000)}`);
    throw new Error(`PATCH response not valid JSON: ${responseText.slice(0, 200)}`);
  }
  log.debug(`setupAgentCallbackUrl: step 5/6 — PATCH full response body (${responseText.length} bytes): ${responseText.slice(0, 3000)}`);
  const effectiveLlm = responseData?.conversation_config?.agent?.prompt?.custom_llm;
  const patchCascadeCustom = effectiveLlm?.cascade_timeout_seconds;
  const patchCascadeTurn = responseData?.conversation_config?.turn?.cascade_timeout_seconds;
  log.debug(`setupAgentCallbackUrl: step 5/6 — PATCH success elapsed=${patchElapsed}ms custom_llm.configured=${Boolean(effectiveLlm?.url)} custom_llm.cascade=${patchCascadeCustom ?? "(not in response)"} turn.cascade=${patchCascadeTurn ?? "(not in response)"} (total=${Date.now() - setupStart}ms)`);

  if (effectiveLlm?.url && effectiveLlm.url !== callbackUrl) {
    log.warn("setupAgentCallbackUrl MISMATCH: provider callback URL differs from the configured capability URL");
  }

  const ttsVoiceId = (responseData?.conversation_config as Record<string, unknown> | undefined);
  if (ttsVoiceId) {
    const tts = (ttsVoiceId as Record<string, unknown>).tts as Record<string, unknown> | undefined;
    if (tts && typeof tts.voice_id === "string") {
      cachedVoiceId = tts.voice_id;
      log.debug(`voiceId cached from boot PATCH: ${cachedVoiceId}`);
    }
  }

  log.debug(`setupAgentCallbackUrl: step 6/6 — GET verification`);
  const getStart = Date.now();
  const getRes = await providerFetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    headers: { "xi-api-key": apiKey },
  });
  const getElapsed = Date.now() - getStart;

  if (!getRes.ok) {
    const error = await readBoundedProviderBody(getRes);
    log.error(`setupAgentCallbackUrl: step 6/6 — GET verification failed status=${getRes.status} elapsed=${getElapsed}ms body: ${error}`);
    throw new Error(`Failed to verify agent config: ${getRes.status} ${error}`);
  }

  const rawGetBody = await getRes.text();
  let agentData: Record<string, unknown>;
  try {
    agentData = JSON.parse(rawGetBody) as Record<string, unknown>;
  } catch {
    log.error(`setupAgentCallbackUrl: step 6/6 — GET response not valid JSON body=${rawGetBody.slice(0, 500)}`);
    throw new Error("Failed to verify agent config: GET response not valid JSON");
  }
  log.debug(`setupAgentCallbackUrl: step 6/6 — GET full response body (${rawGetBody.length} bytes): ${rawGetBody.slice(0, 3000)}`);
  const convConfig = agentData.conversation_config as Record<string, unknown> | undefined;
  const agentConf = convConfig?.agent as Record<string, unknown> | undefined;
  const promptConf = agentConf?.prompt as Record<string, unknown> | undefined;
  const customLlm = promptConf?.custom_llm as Record<string, unknown> | undefined;
  const turnConf = convConfig?.turn as Record<string, unknown> | undefined;
  const languagePresets = convConfig?.language_presets as Record<string, unknown> | undefined;
  const promptTools = Array.isArray(promptConf?.tools) ? promptConf.tools as Array<Record<string, unknown>> : [];
  const hasLanguageDetection = promptTools.some((tool) => tool.type === "system" && tool.name === "language_detection");
  const configuredLanguageCount = ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.filter((code) => languagePresets?.[code]).length;

  const cascadeInCustomLlm = customLlm?.cascade_timeout_seconds;
  const cascadeInTurn = turnConf?.cascade_timeout_seconds;
  const effectiveUrl = customLlm?.url;
  const softTimeoutConfig = turnConf?.soft_timeout_config as Record<string, unknown> | undefined;
  const storedSoftTimeout = softTimeoutConfig?.timeout_seconds != null ? Number(softTimeoutConfig.timeout_seconds) : undefined;
  const storedSoftTimeoutMessage = typeof softTimeoutConfig?.message === "string" ? softTimeoutConfig.message : undefined;
  const cascadeSource =
    cascadeInCustomLlm != null ? "custom_llm" :
    cascadeInTurn != null ? "turn" :
    null;
  const storedCascade =
    cascadeInCustomLlm != null ? Number(cascadeInCustomLlm) :
    cascadeInTurn != null ? Number(cascadeInTurn) :
    undefined;

  log.debug(`setupAgentCallbackUrl: step 6/6 — GET verification done elapsed=${getElapsed}ms custom_llm.configured=${Boolean(effectiveUrl)} custom_llm.cascade_timeout_seconds=${cascadeInCustomLlm ?? "(absent)"} turn.cascade_timeout_seconds=${cascadeInTurn ?? "(absent)"} soft_timeout_config.timeout_seconds=${softTimeoutConfig?.timeout_seconds ?? "(absent)"} language_presets=${configuredLanguageCount}/${ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.length} language_detection=${hasLanguageDetection} (total=${Date.now() - setupStart}ms)`);

  if (!hasLanguageDetection || configuredLanguageCount !== ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.length) {
    log.error(`setupAgentCallbackUrl: MULTILINGUAL CONFIG MISMATCH — language_detection=${hasLanguageDetection} language_presets=${configuredLanguageCount}/${ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.length}`);
  }

  if (storedSoftTimeout !== DISABLED_SOFT_TIMEOUT_SECONDS) {
    log.error(`setupAgentCallbackUrl: SOFT TIMEOUT NOT DISABLED — stored=${storedSoftTimeout ?? "(absent)"} requested=${DISABLED_SOFT_TIMEOUT_SECONDS}`);
    throw new Error(`Agent soft_timeout_config.timeout_seconds is ${storedSoftTimeout ?? "absent"}, expected ${DISABLED_SOFT_TIMEOUT_SECONDS}`);
  }
  if (storedSoftTimeoutMessage !== DISABLED_SOFT_TIMEOUT_MESSAGE) {
    log.error(`setupAgentCallbackUrl: SOFT TIMEOUT MESSAGE NOT SCHEMA TAX — stored=${storedSoftTimeoutMessage ?? "(absent)"} requested=${DISABLED_SOFT_TIMEOUT_MESSAGE}`);
    throw new Error(`Agent soft_timeout_config.message is ${storedSoftTimeoutMessage ?? "absent"}, expected ${DISABLED_SOFT_TIMEOUT_MESSAGE}`);
  }
  if (cascadeSource == null || storedCascade !== LEGAL_CASCADE_TIMEOUT_SECONDS) {
    log.error(`setupAgentCallbackUrl: CASCADE TIMEOUT NOT STORED — custom_llm=${cascadeInCustomLlm ?? "(absent)"} turn=${cascadeInTurn ?? "(absent)"} requested=${LEGAL_CASCADE_TIMEOUT_SECONDS}`);
    throw new Error(`Agent cascade_timeout_seconds is ${storedCascade ?? "absent"} (custom_llm=${cascadeInCustomLlm ?? "absent"}, turn=${cascadeInTurn ?? "absent"}), expected ${LEGAL_CASCADE_TIMEOUT_SECONDS}`);
  }

  verifiedSoftTimeoutSeconds = 0;
  verifiedCascadeTimeoutSeconds = LEGAL_CASCADE_TIMEOUT_SECONDS;
  log.debug(`setupAgentCallbackUrl: SOFT TIMEOUT DISABLED — agent reports ${storedSoftTimeout}`);
  log.debug(`setupAgentCallbackUrl: CASCADE TIMEOUT VERIFIED at ${verifiedCascadeTimeoutSeconds}s from ${cascadeSource}`);

  try {
    const { computeSoftTimeoutBufferMs } = await import("./voice-keepalive-buffer");
    const bootBuffer = computeSoftTimeoutBufferMs(
      verifiedSoftTimeoutSeconds,
      verifiedCascadeTimeoutSeconds,
      undefined,
      (msg) => log.warn(msg),
    );
    log.debug(`setupAgentCallbackUrl: KEEPALIVE_BUFFER_BOOT firstFireMs=${bootBuffer} softTimeoutSeconds=${verifiedSoftTimeoutSeconds} cascadeTimeoutSeconds=${verifiedCascadeTimeoutSeconds}`);
  } catch (bufErr) {
    const msg = bufErr instanceof Error ? bufErr.message : String(bufErr);
    log.warn(`setupAgentCallbackUrl: keepalive buffer boot check failed: ${msg}`);
  }

  if (effectiveUrl && effectiveUrl !== callbackUrl) {
    log.error(`setupAgentCallbackUrl: CALLBACK URL MISMATCH after verification — expected=${callbackUrl} got=${effectiveUrl}`);
    throw new Error("Agent callback URL mismatch after GET verification");
  }

  log.debug(`setupAgentCallbackUrl: END total=${Date.now() - setupStart}ms`);
}

export async function getSignedUrl(agentId: string): Promise<string> {
  const apiKey = await getCredentials();
  const fetchStart = Date.now();
  log.debug(`fetching signed URL for agent=${agentId}`);

  const res = await providerFetch(
    `${ELEVENLABS_API_BASE}/convai/conversation/get-signed-url?agent_id=${agentId}`,
    {
      headers: { "xi-api-key": apiKey },
    }
  );

  const elapsed = Date.now() - fetchStart;
  log.debug(`signed URL response status=${res.status} elapsed=${elapsed}ms`);

  if (!res.ok) {
    const error = await readBoundedProviderBody(res);
    log.error(`signed URL error body: ${error}`);
    throw new Error(`Failed to get signed URL: ${res.status} ${error}`);
  }

  const data: SignedUrlResponse = await res.json();
  log.debug(`signed URL obtained len=${data.signed_url?.length || 0}`);
  return data.signed_url;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview_url: string | null;
  description: string | null;
}

export async function listVoices(): Promise<ElevenLabsVoice[]> {
  const apiKey = await getCredentials();

  const res = await providerFetch(`${ELEVENLABS_API_BASE}/voices`, {
    headers: { "xi-api-key": apiKey },
  });

  if (!res.ok) {
    const error = await readBoundedProviderBody(res);
    throw new Error(`Failed to list voices: ${res.status} ${error}`);
  }

  const data: VoicesListResponse = await res.json();
  return (data.voices || []).map((v: VoiceRaw) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category || "unknown",
    labels: v.labels || {},
    preview_url: v.preview_url || null,
    description: v.description || null,
  }));
}

export async function getAgentConfig(agentId: string): Promise<Record<string, unknown>> {
  const apiKey = await getCredentials();
  const fetchStart = Date.now();
  log.debug(`fetching agent config for agent=${agentId}`);
  const res = await providerFetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    headers: { "xi-api-key": apiKey },
  });
  const elapsed = Date.now() - fetchStart;
  log.debug(`agent config response status=${res.status} elapsed=${elapsed}ms`);
  if (!res.ok) {
    const error = await readBoundedProviderBody(res);
    log.error(`agent config error body: ${error}`);
    throw new Error(`Failed to get agent config: ${res.status} ${error}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}


export interface InstantVoiceCloneSample {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

export interface InstantVoiceCloneRequest {
  name: string;
  description?: string | null;
  labels?: Record<string, string>;
  removeBackgroundNoise?: boolean;
  samples: InstantVoiceCloneSample[];
}

export interface InstantVoiceCloneResult {
  voice_id: string;
  requires_verification: boolean;
}

export async function createInstantVoiceClone(input: InstantVoiceCloneRequest): Promise<InstantVoiceCloneResult> {
  const apiKey = await getCredentials();
  const name = input.name.trim();
  if (!name) {
    throw new Error("Voice name is required.");
  }
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    throw new Error("At least one voice sample is required.");
  }

  const form = new FormData();
  form.append("name", name);
  for (const sample of input.samples) {
    form.append(
      "files",
      new Blob([sample.buffer], { type: sample.contentType || "application/octet-stream" }),
      sample.filename || "voice-sample.webm",
    );
  }
  form.append("remove_background_noise", String(input.removeBackgroundNoise === true));
  if (input.description?.trim()) {
    form.append("description", input.description.trim());
  }
  if (input.labels && Object.keys(input.labels).length > 0) {
    form.append("labels", JSON.stringify(input.labels));
  }

  const start = Date.now();
  log.log(`createInstantVoiceClone: uploading ${input.samples.length} sample(s) name=${name}`);
  const res = await providerFetch(`${ELEVENLABS_API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  const elapsed = Date.now() - start;

  if (!res.ok) {
    const error = await readBoundedProviderBody(res);
    log.error(`createInstantVoiceClone failed status=${res.status} elapsed=${elapsed}ms body=${error}`);
    throw new Error(`Failed to create Instant Voice Clone: ${res.status} ${error}`);
  }

  const data = await res.json() as Partial<InstantVoiceCloneResult>;
  if (!data.voice_id || typeof data.requires_verification !== "boolean") {
    throw new Error("ElevenLabs returned an invalid Instant Voice Clone response.");
  }
  log.log(`createInstantVoiceClone: created voice_id=${data.voice_id} requiresVerification=${data.requires_verification} elapsed=${elapsed}ms`);
  return { voice_id: data.voice_id, requires_verification: data.requires_verification };
}

export async function updateAgentVoice(agentId: string, voiceId: string): Promise<void> {
  const apiKey = await getCredentials();
  const res = await providerFetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversation_config: {
        tts: {
          voice_id: voiceId,
        },
      },
    }),
  });

  if (!res.ok) {
    const error = await readBoundedProviderBody(res);
    throw new Error(`Failed to update agent voice: ${res.status} ${error}`);
  }

  cachedVoiceId = voiceId;
}

export async function getAgentStatus(agentId: string): Promise<boolean> {
  try {
    const apiKey = await getCredentials();
    const res = await providerFetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
      headers: { "xi-api-key": apiKey },
    });
    return res.ok;
  } catch (err: any) {
    log.warn(`getAgentStatus failed agentId=${agentId}: ${err?.message || String(err)}`);
    return false;
  }
}
