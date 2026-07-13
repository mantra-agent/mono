import WebSocket from "ws";
import { getSecretSync } from "../secrets-store";
import { createLogger } from "../log";

const log = createLogger("VoiceSTT");

/** Canonical participant identity supplied by an upstream audio transport. */
export interface STTParticipant {
  transportId: string;
  label?: string;
  email?: string;
}

/** Provider-neutral PCM stream accepted by the voice recognition boundary. */
export interface STTAudioStream {
  streamId: string;
  participant: STTParticipant;
  encoding: "pcm_s16le";
  sampleRateHz: 16000;
  channels: 1;
}

/** Canonical recognition result. Consumers act only on final utterances. */
export interface STTUtterance {
  utteranceId: string;
  streamId: string;
  participant: STTParticipant;
  text: string;
  isFinal: boolean;
  startedAt?: string;
  endedAt?: string;
  confidence?: number;
  provider: string;
  model: string;
  fallback: boolean;
}

export interface STTProviderSession {
  sendAudio(bytes: Buffer): void;
  close(): void;
}

export interface STTProvider {
  readonly provider: string;
  readonly model: string;
  isConfigured(): boolean;
  connect(
    stream: STTAudioStream,
    onUtterance: (utterance: STTUtterance) => void | Promise<void>,
    onError: (error: Error) => void,
  ): Promise<STTProviderSession>;
}

/** Shared high-quality recognition policy used by normal voice and meetings. */
export const HIGH_QUALITY_SCRIBE_POLICY = {
  provider: "scribe_realtime",
  model: "scribe_v2_realtime",
  audioFormat: "pcm_16000",
  sampleRateHz: 16000,
  commitStrategy: "vad",
  vadSilenceThresholdSecs: 1.0,
  vadThreshold: 0.4,
  minSpeechDurationMs: 100,
  minSilenceDurationMs: 100,
  languageCode: "en",
} as const;

interface ScribeMessage {
  message_type?: string;
  text?: string;
  session_id?: string;
  words?: Array<{
    start?: number;
    end?: number;
    start_timestamp?: number;
    end_timestamp?: number;
  }>;
  error?: string;
  error_message?: string;
}

function secondsToIso(baseMs: number, seconds: number | undefined): string | undefined {
  return Number.isFinite(seconds) ? new Date(baseMs + Number(seconds) * 1000).toISOString() : undefined;
}

/**
 * Server-side ElevenLabs Scribe v2 realtime provider.
 *
 * ElevenLabs' supported realtime WebSocket accepts external PCM streams with
 * API-key authentication. Recall's participant audio already matches the
 * recommended 16 kHz mono signed little-endian PCM contract, so no transcoder
 * or diarization layer sits between the two providers.
 */
export class ScribeRealtimeSTTProvider implements STTProvider {
  readonly provider = HIGH_QUALITY_SCRIBE_POLICY.provider;
  readonly model = HIGH_QUALITY_SCRIBE_POLICY.model;

  isConfigured(): boolean {
    return Boolean(getSecretSync("ELEVENLABS_API_KEY")?.trim());
  }

  async connect(
    stream: STTAudioStream,
    onUtterance: (utterance: STTUtterance) => void | Promise<void>,
    onError: (error: Error) => void,
  ): Promise<STTProviderSession> {
    const apiKey = getSecretSync("ELEVENLABS_API_KEY")?.trim();
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");
    if (
      stream.encoding !== "pcm_s16le" ||
      stream.sampleRateHz !== HIGH_QUALITY_SCRIBE_POLICY.sampleRateHz ||
      stream.channels !== 1
    ) {
      throw new Error("Scribe meeting STT requires mono PCM S16LE at 16 kHz");
    }

    const params = new URLSearchParams({
      model_id: this.model,
      audio_format: HIGH_QUALITY_SCRIBE_POLICY.audioFormat,
      commit_strategy: HIGH_QUALITY_SCRIBE_POLICY.commitStrategy,
      vad_silence_threshold_secs: String(HIGH_QUALITY_SCRIBE_POLICY.vadSilenceThresholdSecs),
      vad_threshold: String(HIGH_QUALITY_SCRIBE_POLICY.vadThreshold),
      min_speech_duration_ms: String(HIGH_QUALITY_SCRIBE_POLICY.minSpeechDurationMs),
      min_silence_duration_ms: String(HIGH_QUALITY_SCRIBE_POLICY.minSilenceDurationMs),
      language_code: HIGH_QUALITY_SCRIBE_POLICY.languageCode,
      include_timestamps: "true",
    });
    const socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
      headers: { "xi-api-key": apiKey },
    });
    const connectedAtMs = Date.now();
    let sessionId = "pending";
    let sequence = 0;
    let reportedClose = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Scribe realtime connection timed out")), 10_000);
      timer.unref?.();
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ScribeMessage;
        if (message.message_type === "session_started") {
          sessionId = message.session_id || sessionId;
          log.info(`scribe session started streamId=${stream.streamId} participantId=${stream.participant.transportId}`);
          return;
        }
        // With include_timestamps=true ElevenLabs sends BOTH committed_transcript and
        // committed_transcript_with_timestamps for every committed segment. Treat only the
        // with_timestamps variant (the one carrying word timings we request) as final so
        // each utterance is emitted exactly once.
        const isFinal = message.message_type === "committed_transcript_with_timestamps";
        const isPartial = message.message_type === "partial_transcript";
        if (!isFinal && !isPartial) {
          if (message.message_type?.includes("error")) {
            onError(new Error(message.error_message || message.error || message.message_type));
          }
          return;
        }
        const text = message.text?.trim() || "";
        if (!text) return;
        const words = message.words || [];
        const first = words[0];
        const last = words.at(-1);
        const startSeconds = first?.start_timestamp ?? first?.start;
        const endSeconds = last?.end_timestamp ?? last?.end;
        const utteranceId = `scribe:${sessionId}:${stream.participant.transportId}:${++sequence}`;
        void onUtterance({
          utteranceId,
          streamId: stream.streamId,
          participant: stream.participant,
          text,
          isFinal,
          startedAt: secondsToIso(connectedAtMs, startSeconds),
          endedAt: secondsToIso(connectedAtMs, endSeconds),
          provider: this.provider,
          model: this.model,
          fallback: false,
        });
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", onError);
    socket.on("close", (code, reason) => {
      if (!reportedClose && code !== 1000) {
        reportedClose = true;
        onError(new Error(`Scribe realtime closed code=${code} reason=${reason.toString()}`));
      }
    });

    return {
      sendAudio(bytes) {
        if (socket.readyState !== WebSocket.OPEN || bytes.length === 0) return;
        socket.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: bytes.toString("base64"),
          sample_rate: stream.sampleRateHz,
        }));
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Audio stream ended");
      },
    };
  }
}
