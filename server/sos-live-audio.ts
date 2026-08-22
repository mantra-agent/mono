import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  speechRecognitionStreamCoordinator,
  type CoordinatedSpeechRecognitionStream,
} from "./speech-recognition";

const log = createLogger("SosLiveAudio");
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

type SosLiveAudioRequest = IncomingMessage & { sosPrincipal?: Principal };

/**
 * Ephemeral SOS diagnostic transport. Audio and recognition output exist only
 * for this WebSocket lifetime: no meeting, transcript, or raw-audio storage.
 */
export function registerSosLiveAudioTransport(): (
  request: SosLiveAudioRequest,
  socket: Duplex,
  head: Buffer,
) => void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WebSocket, request: SosLiveAudioRequest) => {
    const principal = request.sosPrincipal;
    if (!principal?.userId || !principal.accountId) {
      socket.close(1008, "Unauthorized");
      return;
    }

    const streamId = `sos:${principal.accountId}:${crypto.randomUUID()}`;
    let recognition: CoordinatedSpeechRecognitionStream | undefined;
    let closed = false;

    const send = (payload: object): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    try {
      recognition = speechRecognitionStreamCoordinator.open(
        {
          useCase: "meeting_shared_room",
          adapterKinds: ["deepgram-realtime"],
          stream: {
            streamId,
            participant: { transportId: "sos-room-microphone", label: "Room mic" },
            encoding: "pcm_s16le",
            sampleRateHz: 16000,
            channels: 1,
          },
        },
        {
          onState: (state) => send({ type: "state", status: state.status, detail: state.detail }),
          onFailure: (failure) => {
            log.warn("SOS live recognition failed", {
              accountId: principal.accountId,
              kind: failure.kind,
              retryable: failure.retryable,
            });
            send({ type: "error", message: failure.message });
            if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Recognition failed");
          },
          onUtterance: (utterance) => {
            if (closed) return;
            send({
              type: "utterance",
              utterance: {
                id: utterance.utteranceId,
                text: utterance.text,
                isFinal: utterance.isFinal,
                startedAt: utterance.startedAt,
                endedAt: utterance.endedAt,
                speakerId: utterance.providerSpeakerId || "unknown",
              },
            });
          },
        },
      );

      void recognition.ready.then(() => {
        if (closed) return recognition?.abort("SOS socket closed during startup");
        send({ type: "ready" });
        log.info("SOS live listening connected", { accountId: principal.accountId });
      }).catch((error) => {
        log.warn("SOS live listening startup failed", {
          accountId: principal.accountId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        send({ type: "error", message: "Transcription startup failed" });
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Transcription startup failed");
      });
    } catch (error) {
      log.warn("SOS live listening open failed", {
        accountId: principal.accountId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      socket.close(1011, "Transcription startup failed");
    }

    socket.on("message", (raw, isBinary) => {
      if (!isBinary || !recognition || closed) return;
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      if (bytes.length === 0 || bytes.length > MAX_AUDIO_FRAME_BYTES) {
        socket.close(1009, "Invalid audio frame");
        return;
      }
      recognition.write(bytes);
    });

    const teardown = (): void => {
      if (closed) return;
      closed = true;
      recognition?.abort("SOS live listening disconnected");
      log.info("SOS live listening disconnected", { accountId: principal.accountId });
    };
    socket.on("close", teardown);
    socket.on("error", teardown);
  });

  return (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}
