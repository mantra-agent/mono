import WebSocket from "ws";
import { getSecretSync } from "../../secrets-store";
import { createLogger } from "../../log";

function getDeepgramApiKey(): string | null { return getSecretSync("DEEPGRAM_API_KEY")?.trim() || null; }

const log = createLogger("DeepgramSTT");

export interface STTTranscript {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  eventId?: string;
  occurredAtMs?: number;
  receivedAtMs?: number;
}

export interface STTStream {
  sendAudio(bytes: Buffer): void;
  close(): void;
}

export interface STTProvider {
  readonly name: string;
  isConfigured(): boolean;
  connect(onTranscript: (result: STTTranscript) => void, onError: (error: Error) => void): Promise<STTStream>;
}

export class DeepgramSTTProvider implements STTProvider {
  readonly name = "deepgram";
  isConfigured(): boolean { return Boolean(getDeepgramApiKey()); }

  async connect(onTranscript: (result: STTTranscript) => void, onError: (error: Error) => void): Promise<STTStream> {
    const apiKey = getDeepgramApiKey();
    if (!apiKey) throw new Error("Deepgram is not configured");
    const params = new URLSearchParams({
      model: "nova-3", language: "en-US", encoding: "mulaw", sample_rate: "8000",
      channels: "1", interim_results: "true", endpointing: "400", punctuate: "true", smart_format: "true",
    });
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Deepgram connection timed out")), 10_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string; is_final?: boolean; speech_final?: boolean;
          channel?: { alternatives?: Array<{ transcript?: string }> };
        };
        if (message.type !== "Results") return;
        const text = message.channel?.alternatives?.[0]?.transcript?.trim() || "";
        if (text) {
          const receivedAtMs = Date.now();
          onTranscript({
            text,
            isFinal: message.is_final === true,
            speechFinal: message.speech_final === true,
            receivedAtMs,
          });
        }
      } catch (error) {
        log.warn(`invalid Deepgram message: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    socket.on("error", (error) => onError(error));
    socket.on("close", (code, reason) => {
      if (code !== 1000) onError(new Error(`Deepgram closed code=${code} reason=${reason.toString()}`));
    });
    const keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8_000);
    keepalive.unref();
    return {
      sendAudio(bytes) { if (socket.readyState === WebSocket.OPEN) socket.send(bytes); },
      close() {
        clearInterval(keepalive);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
        socket.close(1000);
      },
    };
  }
}
