import WebSocket from "ws";
import { getSecretSync } from "../../secrets-store";
import { createLogger } from "../../log";

const log = createLogger("DeepgramStreaming");

export interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number;
}

export interface DeepgramTranscriptEvent {
  text: string;
  words: DeepgramWord[];
  isFinal: boolean;
  speechFinal: boolean;
  requestId?: string;
  receivedAtMs: number;
}

export interface DeepgramStreamingConfig {
  encoding: "mulaw" | "linear16";
  sampleRateHz: 8000 | 16000;
  model?: string;
  language?: string;
  endpointingMs?: number;
  diarize?: boolean;
  keyterms?: string[];
}

export interface DeepgramStreamingSession {
  sendAudio(bytes: Buffer): void;
  close(): void;
}

export function deepgramConfigured(): boolean {
  return Boolean(getSecretSync("DEEPGRAM_API_KEY")?.trim());
}

export async function connectDeepgramStreaming(
  config: DeepgramStreamingConfig,
  onTranscript: (event: DeepgramTranscriptEvent) => void | Promise<void>,
  onError: (error: Error) => void,
): Promise<DeepgramStreamingSession> {
  const apiKey = getSecretSync("DEEPGRAM_API_KEY")?.trim();
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");

  const params = new URLSearchParams({
    model: config.model || "nova-3",
    language: config.language || "en-US",
    encoding: config.encoding,
    sample_rate: String(config.sampleRateHz),
    channels: "1",
    interim_results: "true",
    endpointing: String(config.endpointingMs ?? 400),
    punctuate: "true",
    smart_format: "true",
  });
  if (config.diarize) params.set("diarize_model", "latest");
  for (const keyterm of config.keyterms || []) {
    const trimmed = keyterm.trim();
    if (trimmed) params.append("keyterm", trimmed);
  }

  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  let closing = false;
  let errorReported = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Deepgram connection timed out")), 10_000);
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
      const message = JSON.parse(data.toString()) as {
        type?: string;
        request_id?: string;
        is_final?: boolean;
        speech_final?: boolean;
        channel?: {
          alternatives?: Array<{
            transcript?: string;
            words?: DeepgramWord[];
          }>;
        };
      };
      if (message.type !== "Results") return;
      const alternative = message.channel?.alternatives?.[0];
      const text = alternative?.transcript?.trim() || "";
      if (!text) return;
      void onTranscript({
        text,
        words: alternative?.words || [],
        isFinal: message.is_final === true,
        speechFinal: message.speech_final === true,
        requestId: message.request_id,
        receivedAtMs: Date.now(),
      });
    } catch (error) {
      log.warn(`invalid Deepgram message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  socket.on("error", (error) => {
    if (closing || errorReported) return;
    errorReported = true;
    onError(error);
  });
  socket.on("close", (code, reason) => {
    if (closing || errorReported || code === 1000) return;
    errorReported = true;
    onError(new Error(`Deepgram closed code=${code} reason=${reason.toString()}`));
  });

  const keepalive = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 8_000);
  keepalive.unref();

  return {
    sendAudio(bytes) {
      if (socket.readyState === WebSocket.OPEN && bytes.length > 0) socket.send(bytes);
    },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(keepalive);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CloseStream" }));
        socket.close(1000, "Audio stream ended");
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "Audio stream ended");
      }
    },
  };
}
