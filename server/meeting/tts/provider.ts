import { getSecret } from "../../secrets-store";
import { getCachedVoiceId } from "../../elevenlabs";
import { createLogger } from "../../log";

const log = createLogger("MeetingTTS");
const MAX_TTS_CHARS = 8_000;

export interface TTSRequest { text: string; }
export interface TTSAudio { provider: "cartesia" | "elevenlabs"; contentType: "audio/mpeg"; bytes: Buffer; }
export interface TTSProvider { readonly name: TTSAudio["provider"]; isConfigured(): Promise<boolean>; synthesize(request: TTSRequest): Promise<TTSAudio>; }

async function audioResponse(res: Response, provider: TTSAudio["provider"]): Promise<TTSAudio> {
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`${provider} TTS failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return { provider, contentType: "audio/mpeg", bytes: Buffer.from(await res.arrayBuffer()) };
}

export class CartesiaTTSProvider implements TTSProvider {
  readonly name = "cartesia" as const;
  async isConfigured() { return !!(await getSecret("CARTESIA_API_KEY")) && !!(await getSecret("CARTESIA_VOICE_ID")); }
  async synthesize({ text }: TTSRequest): Promise<TTSAudio> {
    const apiKey = await getSecret("CARTESIA_API_KEY");
    const voiceId = await getSecret("CARTESIA_VOICE_ID");
    if (!apiKey || !voiceId) throw new Error("Cartesia is not configured");
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": "2025-04-16", "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: "sonic-3.5", transcript: text, voice: { mode: "id", id: voiceId }, output_format: { container: "mp3" }, language: "en" }),
      signal: AbortSignal.timeout(30_000),
    });
    return audioResponse(res, this.name);
  }
}

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = "elevenlabs" as const;
  async isConfigured() { return !!(await getSecret("ELEVENLABS_API_KEY")); }
  async synthesize({ text }: TTSRequest): Promise<TTSAudio> {
    const apiKey = await getSecret("ELEVENLABS_API_KEY");
    if (!apiKey) throw new Error("ElevenLabs is not configured");
    const voiceId = getCachedVoiceId();
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128&optimize_streaming_latency=3`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, Accept: "audio/mpeg", "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_v3" }),
      signal: AbortSignal.timeout(30_000),
    });
    return audioResponse(res, this.name);
  }
}

export class MeetingTTSProvider implements TTSProvider {
  readonly name = "cartesia" as const;
  constructor(private readonly providers: TTSProvider[] = [new CartesiaTTSProvider(), new ElevenLabsTTSProvider()]) {}
  async isConfigured() { for (const p of this.providers) if (await p.isConfigured()) return true; return false; }
  async synthesize({ text }: TTSRequest): Promise<TTSAudio> {
    const normalized = text.trim().slice(0, MAX_TTS_CHARS);
    if (!normalized) throw new Error("Cannot synthesize empty speech");
    const failures: string[] = [];
    for (const provider of this.providers) {
      if (!(await provider.isConfigured())) continue;
      try { return await provider.synthesize({ text: normalized }); }
      catch (error) { const detail = error instanceof Error ? error.message : String(error); failures.push(`${provider.name}: ${detail}`); log.warn(`${provider.name} failed; trying fallback: ${detail}`); }
    }
    throw new Error(failures.length ? `All meeting TTS providers failed (${failures.join("; ")})` : "Meeting TTS is not configured. Add Cartesia or ElevenLabs credentials in Settings → Integrations.");
  }
}

export const meetingTTSProvider = new MeetingTTSProvider();
