import WebSocket from "ws";
import { getSecretSync } from "../../secrets-store";
import { createLogger } from "../../log";
import { createSerialAsyncDelivery } from "../../utils/serial-async-delivery";

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
  tryWriteAudio(bytes: Buffer): "accepted" | "blocked" | "closed";
  finish(): Promise<{ outcome: "finished" | "timed_out" }>;
  abort(reason: string): void;
  /** @deprecated Compatibility alias for phone while its boundary remains separate. */
  sendAudio(bytes: Buffer): void;
  /** @deprecated Compatibility alias for phone while its boundary remains separate. */
  close(): void;
}

export function deepgramConfigured(): boolean {
  return Boolean(getSecretSync("DEEPGRAM_API_KEY")?.trim());
}

export async function connectDeepgramStreaming(
  config: DeepgramStreamingConfig,
  onTranscript: (event: DeepgramTranscriptEvent) => void | Promise<void>,
  onError: (error: Error) => void,
  options?: { credential?: string },
): Promise<DeepgramStreamingSession> {
  const apiKey = options?.credential?.trim() || getSecretSync("DEEPGRAM_API_KEY")?.trim();
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
  socket.on("error", () => undefined);
  let closing = false;
  let errorReported = false;
  let closeObserved = false;
  let metadataObserved = false;
  const transcriptDelivery = createSerialAsyncDelivery(onTranscript, {
    label: "Deepgram transcript",
    onFailure: (error) => {
      log.error("Deepgram transcript consumer failed", {
        errorType: error instanceof Error ? error.name : typeof error,
        pending: transcriptDelivery.pending(),
      });
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Deepgram connection timed out")), 10_000);
      timer.unref?.();
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Deepgram connection failed"));
      });
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }

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
      if (message.type === "Metadata") {
        metadataObserved = true;
        return;
      }
      if (message.type !== "Results") return;
      const alternative = message.channel?.alternatives?.[0];
      const text = alternative?.transcript?.trim() || "";
      if (!text) return;
      transcriptDelivery.enqueue({
        text,
        words: alternative?.words || [],
        isFinal: message.is_final === true,
        speechFinal: message.speech_final === true,
        requestId: message.request_id,
        receivedAtMs: Date.now(),
      });
    } catch (error) {
      log.warn("invalid Deepgram recognition message", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  });
  socket.on("error", () => {
    if (closing || errorReported) return;
    errorReported = true;
    onError(new Error("Deepgram recognition transport failed"));
  });
  socket.on("close", (code) => {
    closeObserved = true;
    if (closing || errorReported) return;
    errorReported = true;
    onError(new Error(`Deepgram recognition closed unexpectedly (${code})`));
  });

  const keepalive = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 8_000);
  keepalive.unref();

  let finishPromise: Promise<{ outcome: "finished" | "timed_out" }> | null = null;
  const settleTranscripts = async (): Promise<boolean> => Promise.race([
    new Promise<true>((resolve) => {
      const inspect = (): void => {
        const providerFinished = metadataObserved || closeObserved;
        if (providerFinished && transcriptDelivery.pending() === 0) resolve(true);
        else setTimeout(inspect, 20).unref?.();
      };
      inspect();
    }),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000).unref?.()),
  ]);

  const session: DeepgramStreamingSession = {
    tryWriteAudio(bytes) {
      if (closing || socket.readyState !== WebSocket.OPEN) return "closed";
      if (socket.bufferedAmount >= 512 * 1024) return "blocked";
      if (bytes.length > 0) socket.send(bytes);
      return "accepted";
    },
    finish() {
      if (finishPromise) return finishPromise;
      closing = true;
      clearInterval(keepalive);
      finishPromise = (async () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "CloseStream" }));
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "Audio stream ended");
        }
        const settled = await settleTranscripts();
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Audio stream ended");
        return { outcome: settled ? "finished" as const : "timed_out" as const };
      })();
      return finishPromise;
    },
    abort() {
      if (closing) return;
      closing = true;
      clearInterval(keepalive);
      socket.terminate();
    },
    sendAudio(bytes) {
      session.tryWriteAudio(bytes);
    },
    close() {
      void session.finish();
    },
  };
  return session;
}
