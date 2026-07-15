import { Readable } from "node:stream";
import { fetchAndCacheVoiceId, getCachedVoiceId } from "../elevenlabs";
import { createLogger } from "../log";
import { getDictionaryLocator } from "../pronunciation";
import { getSecret } from "../secrets-store";
import { getTtsConfig } from "../routes/voice-config";

const log = createLogger("VoiceSynthesis");
const MAX_TTS_CHARS = 8_000;
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export interface VoiceAudioStream {
  provider: "elevenlabs";
  contentType: "audio/mpeg";
  stream: Readable;
}

export interface VoiceAudio {
  provider: VoiceAudioStream["provider"];
  contentType: VoiceAudioStream["contentType"];
  bytes: Buffer;
}

function responseBodyStream(
  body: ReadableStream<Uint8Array>,
  modelId: string,
  startedAt: number,
): Readable {
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
          log.info(`streamed portable voice audio model=${modelId} bytes=${byteCount} durationMs=${Date.now() - startedAt}`);
          return;
        }
        byteCount += value.byteLength;
        if (!receivedFirstByte) {
          receivedFirstByte = true;
          log.info(`portable voice first audio byte model=${modelId} latencyMs=${Date.now() - startedAt}`);
        }
        yield Buffer.from(value);
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })());
}

/**
 * Open portable audio with the same voice, model selection, expression-tag
 * policy, pronunciation dictionary, and voice settings as normal voice.
 * Playback transports such as Recall and Twilio do not own speech synthesis
 * configuration. Buffered consumers derive their bytes from this stream.
 */
export async function streamVoiceAudio(text: string): Promise<VoiceAudioStream> {
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

  const query = new URLSearchParams({ output_format: "mp3_44100_128" });
  if (modelId !== "eleven_v3") {
    query.set("optimize_streaming_latency", "3");
  }

  const startedAt = Date.now();
  const response = await fetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: spokenText,
        model_id: modelId,
        voice_settings: {
          speed: config.speed,
          stability: config.stability,
          similarity_boost: config.similarityBoost,
          style: config.style,
        },
        ...(dictionary ? { pronunciation_dictionary_locators: [dictionary] } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`ElevenLabs voice synthesis failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!response.body) {
    throw new Error("ElevenLabs voice synthesis returned no audio stream");
  }

  return {
    provider: "elevenlabs",
    contentType: "audio/mpeg",
    stream: responseBodyStream(response.body, modelId, startedAt),
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
