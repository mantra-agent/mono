import { getPublicBaseUrl } from "./voice-llm";
import { createLogger } from "./log";
import { getSecretSync, onSecretChange } from "./secrets-store";
import crypto from "crypto";
import { HIGH_QUALITY_SCRIBE_POLICY } from "./voice/stt";
import { buildLanguagePresets, ELEVENLABS_ADDITIONAL_LANGUAGE_CODES } from "./voice/provider-system-tools";

const log = createLogger("ElevenLabs");
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

let cachedApiKey: string | null = null;
let cachedVoiceId: string | null = null;

onSecretChange((name) => {
  if (name === "ELEVENLABS_API_KEY") cachedApiKey = null;
});
let verifiedCascadeTimeoutSeconds: number = 8;
let verifiedSoftTimeoutSeconds: number = 5;

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
    const envCascadeDevOverride = process.env.VOICE_CASCADE_TIMEOUT_SECONDS;
    if (envCascadeDevOverride) {
      const parsed = Number(envCascadeDevOverride);
      if (!isNaN(parsed) && parsed > 0) {
        verifiedCascadeTimeoutSeconds = parsed;
        log.debug(`setupAgentCallbackUrl: CASCADE TIMEOUT ENV OVERRIDE (dev mode) — VOICE_CASCADE_TIMEOUT_SECONDS=${parsed}s`);
      }
    }
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
          prompt: "You are Agent, a personal AI coach and executive assistant.",
          llm: "custom-llm",
          custom_llm: {
            url: callbackUrl,
            model_id: "xyz-voice",
            cascade_timeout_seconds: 15,
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
        cascade_timeout_seconds: 15,
        end_of_speech_silence_ms: 1000,
        interruption_sensitivity: 0.5,
        // Division of labor between EL's soft_timeout_config and our custom
        // cascade keepalive (server/voice-llm.ts: sendCascadeKeepalive /
        // startKeepaliveTimer):
        //   - EL native soft_timeout_config = UX FILLER. When the custom-LLM
        //     SSE has been silent for `timeout_seconds`, EL plays `message`
        //     ("One second. ") server-side so the user doesn't sit in dead
        //     air. EL keeps waiting for the LLM. We do not write anything
        //     for this to fire.
        //   - Custom keepalive = CASCADE LIVENESS only. It writes "... " as
        //     a real `delta.content` SSE chunk to reset EL's
        //     `cascade_timeout_seconds` clock so long single LLM callbacks
        //     don't drop with closeCode=1002. Because EL counts any content
        //     chunk as "LLM is producing", the keepalive ALSO resets EL's
        //     soft-timeout silence clock — therefore the keepalive's
        //     first-fire threshold MUST land comfortably AFTER
        //     `soft_timeout_config.timeout_seconds`, or it will suppress
        //     the native filler. See getSoftTimeoutBufferMs() in voice-llm.ts.
        soft_timeout_config: {
          timeout_seconds: 5,
          message: "One second. ",
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
  const res = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    method: "PATCH",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const patchElapsed = Date.now() - reqStart;
  if (!res.ok) {
    const error = await res.text();
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
  const patchCascade = effectiveLlm?.cascade_timeout_seconds;
  log.debug(`setupAgentCallbackUrl: step 5/6 — PATCH success elapsed=${patchElapsed}ms custom_llm.configured=${Boolean(effectiveLlm?.url)} cascade_timeout_seconds=${patchCascade ?? "(not in response)"} (total=${Date.now() - setupStart}ms)`);

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
  try {
    const getStart = Date.now();
    const getRes = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
      headers: { "xi-api-key": apiKey },
    });
    const getElapsed = Date.now() - getStart;

    if (!getRes.ok) {
      log.warn(`setupAgentCallbackUrl: step 6/6 — GET verification failed status=${getRes.status} elapsed=${getElapsed}ms`);
    } else {
      const rawGetBody = await getRes.text();
      let agentData: Record<string, unknown>;
      try {
        agentData = JSON.parse(rawGetBody) as Record<string, unknown>;
      } catch {
        log.warn(`setupAgentCallbackUrl: step 6/6 — GET response not valid JSON body=${rawGetBody.slice(0, 500)}`);
        agentData = {};
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

      let cascadeInBackupLlms: unknown = undefined;
      const backupLlms = promptConf?.backup_llms as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(backupLlms)) {
        for (const bl of backupLlms) {
          if (bl.cascade_timeout_seconds != null) {
            cascadeInBackupLlms = bl.cascade_timeout_seconds;
            break;
          }
        }
      }

      log.debug(`setupAgentCallbackUrl: step 6/6 — GET verification done elapsed=${getElapsed}ms custom_llm.configured=${Boolean(effectiveUrl)} custom_llm.cascade_timeout_seconds=${cascadeInCustomLlm ?? "(absent)"} turn.cascade_timeout_seconds=${cascadeInTurn ?? "(absent)"} backup_llms.cascade_timeout_seconds=${cascadeInBackupLlms ?? "(absent)"} soft_timeout_config.timeout_seconds=${softTimeoutConfig?.timeout_seconds ?? "(absent)"} language_presets=${configuredLanguageCount}/${ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.length} language_detection=${hasLanguageDetection} (total=${Date.now() - setupStart}ms)`);

      if (!hasLanguageDetection || configuredLanguageCount !== ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.length) {
        log.error(`setupAgentCallbackUrl: MULTILINGUAL CONFIG MISMATCH — language_detection=${hasLanguageDetection} language_presets=${configuredLanguageCount}/${ELEVENLABS_ADDITIONAL_LANGUAGE_CODES.length}`);
      }

      const rawCascade = cascadeInCustomLlm ?? cascadeInTurn ?? cascadeInBackupLlms;
      const effectiveCascade = rawCascade != null ? Number(rawCascade) : undefined;
      const cascadeSource = cascadeInCustomLlm != null ? "custom_llm" : cascadeInTurn != null ? "turn" : cascadeInBackupLlms != null ? "backup_llms" : null;
      if (cascadeSource == null) {
        verifiedCascadeTimeoutSeconds = 15;
        log.warn(`setupAgentCallbackUrl: CASCADE TIMEOUT ABSENT — not found in custom_llm, turn, or backup_llms config. The API may not accept this field via PATCH. Using requested value of 15s for internal calibration. Set it manually via the ElevenLabs dashboard or set VOICE_CASCADE_TIMEOUT_SECONDS env var if different. Code timing constants calibrated to ${verifiedCascadeTimeoutSeconds}s.`);
      } else if (effectiveCascade != null && effectiveCascade > 0) {
        verifiedCascadeTimeoutSeconds = effectiveCascade;
        log.debug(`setupAgentCallbackUrl: CASCADE TIMEOUT VERIFIED at ${verifiedCascadeTimeoutSeconds}s from ${cascadeSource} in API response`);
      } else {
        verifiedCascadeTimeoutSeconds = 15;
        log.warn(`setupAgentCallbackUrl: CASCADE TIMEOUT INVALID — got ${rawCascade ?? "(not set)"} from ${cascadeSource} (parsed=${effectiveCascade}). Using requested value of 15s. Set it manually via the ElevenLabs dashboard or set VOICE_CASCADE_TIMEOUT_SECONDS env var if different.`);
      }

      const envCascadeOverride = process.env.VOICE_CASCADE_TIMEOUT_SECONDS;
      if (envCascadeOverride) {
        const parsed = Number(envCascadeOverride);
        if (!isNaN(parsed) && parsed > 0) {
          log.debug(`setupAgentCallbackUrl: CASCADE TIMEOUT ENV OVERRIDE — VOICE_CASCADE_TIMEOUT_SECONDS=${parsed}s overrides API value of ${verifiedCascadeTimeoutSeconds}s`);
          verifiedCascadeTimeoutSeconds = parsed;
        } else {
          log.warn(`setupAgentCallbackUrl: VOICE_CASCADE_TIMEOUT_SECONDS="${envCascadeOverride}" is not a valid positive number — ignoring env override`);
        }
      }

      log.debug(`setupAgentCallbackUrl: EFFECTIVE_CASCADE_TIMEOUT=${verifiedCascadeTimeoutSeconds}s — all timing constants will calibrate against this value`);

      const rawSoftTimeout = softTimeoutConfig?.timeout_seconds;
      const effectiveSoftTimeout = rawSoftTimeout != null ? Number(rawSoftTimeout) : undefined;
      if (effectiveSoftTimeout == null || effectiveSoftTimeout <= 0) {
        log.error(`setupAgentCallbackUrl: SOFT TIMEOUT MISMATCH — expected positive timeout_seconds (e.g. 5) but agent reports ${rawSoftTimeout ?? "(not set)"} (parsed=${effectiveSoftTimeout}). Soft timeout may not be enabled. Set it manually via the ElevenLabs dashboard. Keeping verifiedSoftTimeoutSeconds=${verifiedSoftTimeoutSeconds}s for keepalive calibration.`);
      } else {
        verifiedSoftTimeoutSeconds = effectiveSoftTimeout;
        log.debug(`setupAgentCallbackUrl: SOFT TIMEOUT VERIFIED at ${verifiedSoftTimeoutSeconds}s — keepalive first-fire threshold will sit between this and cascade timeout (${verifiedCascadeTimeoutSeconds}s)`);
      }

      // Compute keepalive buffer at boot so the KEEPALIVE_BUFFER_NO_ROOM
      // warning surfaces immediately on startup (instead of lazily on the
      // first voice turn). Result is logged for operator visibility.
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
      }
    }
  } catch (verifyErr) {
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    log.warn(`setupAgentCallbackUrl: step 6/6 — GET verification error: ${msg} (total=${Date.now() - setupStart}ms)`);
  }

  log.debug(`setupAgentCallbackUrl: END total=${Date.now() - setupStart}ms`);
}

export async function getSignedUrl(agentId: string): Promise<string> {
  const apiKey = await getCredentials();
  const fetchStart = Date.now();
  log.debug(`fetching signed URL for agent=${agentId}`);

  const res = await fetch(
    `${ELEVENLABS_API_BASE}/convai/conversation/get-signed-url?agent_id=${agentId}`,
    {
      headers: { "xi-api-key": apiKey },
    }
  );

  const elapsed = Date.now() - fetchStart;
  log.debug(`signed URL response status=${res.status} elapsed=${elapsed}ms`);

  if (!res.ok) {
    const error = await res.text();
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

  const res = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
    headers: { "xi-api-key": apiKey },
  });

  if (!res.ok) {
    const error = await res.text();
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

/**
 * Reapply the v2 custom-LLM config. Called at boot to ensure the agent
 * is in custom-LLM mode with the correct callback URL and TTS settings.
 * Extracted from voice-v3/agent-config.ts during the single-engine cleanup.
 */
export async function provisionV2Agent(agentId: string): Promise<void> {
  await setupAgentCallbackUrl(agentId);
  log.debug(`provisionV2Agent: agent=${agentId} configured for custom-LLM mode`);
}

export async function getAgentConfig(agentId: string): Promise<Record<string, unknown>> {
  const apiKey = await getCredentials();
  const fetchStart = Date.now();
  log.debug(`fetching agent config for agent=${agentId}`);
  const res = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    headers: { "xi-api-key": apiKey },
  });
  const elapsed = Date.now() - fetchStart;
  log.debug(`agent config response status=${res.status} elapsed=${elapsed}ms`);
  if (!res.ok) {
    const error = await res.text();
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
  const res = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  const elapsed = Date.now() - start;

  if (!res.ok) {
    const error = await res.text();
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
  const res = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
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
    const error = await res.text();
    throw new Error(`Failed to update agent voice: ${res.status} ${error}`);
  }

  cachedVoiceId = voiceId;
}

export async function getAgentStatus(agentId: string): Promise<boolean> {
  try {
    const apiKey = await getCredentials();
    const res = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
      headers: { "xi-api-key": apiKey },
    });
    return res.ok;
  } catch (err: any) {
    log.warn(`getAgentStatus failed agentId=${agentId}: ${err?.message || String(err)}`);
    return false;
  }
}
