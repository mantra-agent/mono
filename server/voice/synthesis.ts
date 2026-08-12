import { Readable } from "node:stream";
import { fetchAndCacheVoiceId, getCachedVoiceId } from "../elevenlabs";
import { createLogger } from "../log";
import { providerFetch, readBoundedProviderBody } from "../integrations/provider-http";
import { getDictionaryLocator } from "../pronunciation";
import { getSecret } from "../secrets-store";
import { getTtsConfig } from "../routes/voice-config";

const log = createLogger("VoiceSynthesis");

/** The provider returned a 200 stream that ended without a single audio byte.
 * Distinguished so consumers can retry: nothing was audibly played. */
export class EmptyVoiceStreamError extends Error {
  override name = "EmptyVoiceStreamError";
}
const MAX_TTS_CHARS = 8_000;
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export interface VoiceAudioStream {
  provider: "elevenlabs";
  contentType: "audio/mpeg";
  stream: Readable;
}

export interface VoiceSynthesisCorrelation {
  runId?: string;
  turnId?: string;
  assistantMessageId?: string;
}

export interface VoiceAudio {
  provider: VoiceAudioStream["provider"];
  contentType: VoiceAudioStream["contentType"];
  bytes: Buffer;
}

export interface VoiceAlignment {
  /** Spoken characters in order, exactly as synthesized. */
  characters: string[];
  /** Start time of each character in milliseconds from clip start. */
  startTimesMs: number[];
}

export interface VoiceAudioWithAlignment {
  provider: "elevenlabs";
  contentType: "audio/mpeg";
  bytes: Buffer;
  alignment: VoiceAlignment;
}

function responseBodyStream(
  body: ReadableStream<Uint8Array>,
  modelId: string,
  startedAt: number,
  correlation?: VoiceSynthesisCorrelation,
): Readable {
  const correlationLog = correlation
    ? ` runId=${correlation.runId || "none"} turnId=${correlation.turnId || "none"} assistantMessageId=${correlation.assistantMessageId || "none"}`
    : "";
  return Readable.from((async function* () {
    const reader = body.getReader();
    let byteCount = 0;
    let completed = false;
    let receivedFirstByte = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          if (byteCount === 0) {
            log.error(`voice synthesis stream ended with zero audio bytes model=${modelId} durationMs=${Date.now() - startedAt}`);
            throw new EmptyVoiceStreamError(
              `Voice synthesis returned an empty audio stream (model=${modelId})`,
            );
          }
          log.info(`streamed portable voice audio model=${modelId} bytes=${byteCount} durationMs=${Date.now() - startedAt}${correlationLog}`);
          return;
        }
        byteCount += value.byteLength;
        if (!receivedFirstByte) {
          receivedFirstByte = true;
          log.info(`portable voice first audio byte model=${modelId} latencyMs=${Date.now() - startedAt}${correlationLog}`);
        }
        yield Buffer.from(value);
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })());
}

interface ResolvedTtsRequest {
  apiKey: string;
  voiceId: string;
  modelId: string;
  spokenText: string;
  body: Record<string, unknown>;
  optimizeLatency: boolean;
}

/**
 * Resolve the shared ElevenLabs request identity (credentials, voice, model,
 * expression-tag policy, pronunciation dictionary, and voice settings) used by
 * every meeting and portable synthesis path, so the streaming and timestamped
 * endpoints cannot drift apart.
 */
async function resolveTtsRequest(text: string): Promise<ResolvedTtsRequest> {
  const normalized = text.trim().slice(0, MAX_TTS_CHARS);
  if (!normalized) throw new Error("Cannot synthesize empty speech");

  const apiKey = await getSecret("ELEVENLABS_API_KEY");
  if (!apiKey) {
    throw new Error("ElevenLabs voice is not configured. Add ElevenLabs credentials in Settings → Integrations.");
  }

  const config = await getTtsConfig();
  const agentId = await getSecret("ELEVENLABS_AGENT_ID");
  const voiceId = agentId ? await fetchAndCacheVoiceId(agentId) : getCachedVoiceId();
  const modelId = config.modelId === "eleven_v3_conversational"
    ? "eleven_v3"
    : "eleven_flash_v2_5";
  const spokenText = config.expressiveEnabled && config.modelId === "eleven_v3_conversational"
    ? normalized
    : normalized.replace(/\[(?:excited|calm|sighs|laughs|pause|nervous|cheerfully|whispers|curious|gravitas)\]\s*/gi, "");
  const dictionary = await getDictionaryLocator();

  return {
    apiKey,
    voiceId,
    modelId,
    spokenText,
    optimizeLatency: modelId !== "eleven_v3",
    body: {
      text: spokenText,
      model_id: modelId,
      voice_settings: {
        speed: config.speed,
        stability: config.stability,
        similarity_boost: config.similarityBoost,
        style: config.style,
      },
      ...(dictionary ? { pronunciation_dictionary_locators: [dictionary] } : {}),
    },
  };
}

/**
 * Open portable audio with the same voice, model selection, expression-tag
 * policy, pronunciation dictionary, and voice settings as normal voice.
 * Playback transports such as Recall and Twilio do not own speech synthesis
 * configuration. Buffered consumers derive their bytes from this stream.
 */
export async function streamVoiceAudio(
  text: string,
  correlation?: VoiceSynthesisCorrelation,
): Promise<VoiceAudioStream> {
  const req = await resolveTtsRequest(text);

  const query = new URLSearchParams({ output_format: "mp3_44100_128" });
  if (req.optimizeLatency) {
    query.set("optimize_streaming_latency", "3");
  }

  const startedAt = Date.now();
  const response = await providerFetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(req.voiceId)}/stream?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": req.apiKey,
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      timeoutMs: 30_000,
    },
  );

  if (!response.ok) {
    const detail = await readBoundedProviderBody(response, 500).catch(() => "");
    throw new Error(`ElevenLabs voice synthesis failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!response.body) {
    throw new Error("ElevenLabs voice synthesis returned no audio stream");
  }

  return {
    provider: "elevenlabs",
    contentType: "audio/mpeg",
    stream: responseBodyStream(response.body, req.modelId, startedAt, correlation),
  };
}

export async function synthesizeVoiceAudio(text: string): Promise<VoiceAudio> {
  const audio = await streamVoiceAudio(text);
  const chunks: Buffer[] = [];
  for await (const chunk of audio.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { provider: audio.provider, contentType: audio.contentType, bytes: Buffer.concat(chunks) };
}

/**
 * Synthesize a complete utterance with ElevenLabs character-level timing. Unlike
 * streamVoiceAudio this buffers the whole clip, because the with-timestamps
 * endpoint returns audio and alignment together in one JSON response. That
 * alignment is the same real-clock timing normal voice captions use, so meeting
 * captions can be pinned to actual speech instead of a word-count estimate.
 */
export async function synthesizeVoiceWithAlignment(
  text: string,
  correlation?: VoiceSynthesisCorrelation,
): Promise<VoiceAudioWithAlignment> {
  const req = await resolveTtsRequest(text);

  const query = new URLSearchParams({ output_format: "mp3_44100_128" });
  if (req.optimizeLatency) {
    query.set("optimize_streaming_latency", "3");
  }

  const startedAt = Date.now();
  const response = await providerFetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": req.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      timeoutMs: 30_000,
    },
  );

  if (!response.ok) {
    const detail = await readBoundedProviderBody(response, 500).catch(() => "");
    throw new Error(`ElevenLabs timestamped voice synthesis failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const payload = (await response.json()) as {
    audio_base64?: string;
    alignment?: { characters?: string[]; character_start_times_seconds?: number[] };
    normalized_alignment?: { characters?: string[]; character_start_times_seconds?: number[] };
  };

  const audioBase64 = payload.audio_base64 ?? "";
  if (!audioBase64) {
    log.error(`timestamped voice synthesis returned zero audio model=${req.modelId} durationMs=${Date.now() - startedAt}`);
    throw new EmptyVoiceStreamError(`Voice synthesis returned an empty audio payload (model=${req.modelId})`);
  }
  const bytes = Buffer.from(audioBase64, "base64");

  const source = payload.alignment ?? payload.normalized_alignment;
  const characters = Array.isArray(source?.characters) ? source!.characters : [];
  const starts = Array.isArray(source?.character_start_times_seconds) ? source!.character_start_times_seconds : [];
  const count = Math.min(characters.length, starts.length);
  const alignment: VoiceAlignment = {
    characters: characters.slice(0, count),
    startTimesMs: starts.slice(0, count).map((seconds) => Math.max(0, Math.round(seconds * 1000))),
  };

  const correlationLog = correlation
    ? ` runId=${correlation.runId || "none"} turnId=${correlation.turnId || "none"} assistantMessageId=${correlation.assistantMessageId || "none"}`
    : "";
  log.info(`timestamped voice audio model=${req.modelId} bytes=${bytes.length} alignedChars=${count} durationMs=${Date.now() - startedAt}${correlationLog}`);

  return { provider: "elevenlabs", contentType: "audio/mpeg", bytes, alignment };
}
