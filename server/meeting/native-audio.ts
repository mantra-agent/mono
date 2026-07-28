import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import type { MeetingRecognitionStream } from "@shared/models/chat";
import type { MeetingIngestFn } from "../routes/recall";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { DeepgramDiarizingSTTProvider } from "../voice/stt";
import { principalOwnsMeeting } from "./owner-principal";

const log = createLogger("NativeMeetingAudio");
const SOURCE_KEY = "native:microphone";
const TRANSPORT_PARTICIPANT_ID = "native-microphone";
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

type NativeMeetingRequest = IncomingMessage & { nativeMeetingPrincipal?: Principal };

function recognitionStream(status: MeetingRecognitionStream["status"], detail?: string): MeetingRecognitionStream {
  return {
    streamKey: SOURCE_KEY,
    transportParticipantId: TRANSPORT_PARTICIPANT_ID,
    transportLabel: "Shared microphone",
    sourcePolicy: "shared_room",
    attribution: "diarized",
    provider: "deepgram",
    model: "nova-3",
    status,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
}

export function registerNativeMeetingAudioTransport(
  deps: { ingestMeetingEvent: MeetingIngestFn },
): (request: NativeMeetingRequest, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WebSocket, request: NativeMeetingRequest) => {
    const principal = request.nativeMeetingPrincipal;
    const sessionId = new URL(request.url || "", "http://localhost").searchParams.get("sessionId")?.trim() || "";
    if (!principal?.userId || !principal.accountId || !sessionId) {
      socket.close(1008, "Unauthorized");
      return;
    }

    const provider = new DeepgramDiarizingSTTProvider();
    let providerSession: Awaited<ReturnType<typeof provider.connect>> | undefined;
    let closed = false;
    let audioStarted = false;
    let firstUtteranceReceived = false;
    let audioFrameCount = 0;
    let audioByteCount = 0;

    const persistFailure = async (detail: string): Promise<void> => {
      await runWithPrincipal(principal, () => chatStorage.updateMeetingMeta(sessionId, {
        recognition: {
          mode: "shared_room",
          status: "degraded",
          detail: detail.slice(0, 500),
          streams: [recognitionStream("failed", detail)],
        },
        sttStatus: "fallback",
        sttStatusDetail: detail.slice(0, 500),
      }));
    };

    void runWithPrincipal(principal, async () => {
      const session = await chatStorage.getSession(sessionId);
      if (
        !session ||
        !principalOwnsMeeting(principal, session) ||
        session.meeting?.transport !== "native" ||
        session.meeting.botStatus !== "live"
      ) {
        socket.close(1008, "Meeting unavailable");
        return;
      }
      if (!provider.isConfigured()) {
        socket.close(1013, "Recognition unavailable");
        return;
      }

      await chatStorage.updateMeetingMeta(sessionId, {
        recognition: {
          mode: "shared_room",
          status: "waiting",
          detail: "Connecting shared-room recognition",
          streams: [recognitionStream("connecting")],
        },
        sttStatus: "inactive",
        sttStatusDetail: "Connecting shared-room recognition",
      });

      providerSession = await provider.connect(
        {
          streamId: `${sessionId}:meeting:${SOURCE_KEY}`,
          participant: {
            transportId: TRANSPORT_PARTICIPANT_ID,
            label: "Shared microphone",
          },
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
          channels: 1,
        },
        async (utterance) => {
          if (!utterance.isFinal || closed) return;
          const isFirstUtterance = !firstUtteranceReceived;
          const current = await runWithPrincipal(principal, () => chatStorage.getSession(sessionId));
          if (
            !current?.meeting ||
            current.meeting.transport !== "native" ||
            current.meeting.botStatus !== "live"
          ) {
            closed = true;
            providerSession?.close();
            if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Meeting ended");
            return;
          }
          const result = await deps.ingestMeetingEvent({
            sessionId,
            speaker: {
              key: `stream:${SOURCE_KEY}:${utterance.provider}:${utterance.providerSpeakerId || "unknown"}`,
              transportParticipantId: TRANSPORT_PARTICIPANT_ID,
              providerSpeakerId: utterance.providerSpeakerId,
              source: "machine_diarization",
            },
            turnId: utterance.utteranceId,
            text: utterance.text,
            botStatus: "live",
            stt: {
              provider: utterance.provider,
              model: utterance.model,
              source: "native_microphone",
              fallback: false,
            },
          });
          if (!result.ok) throw new Error(result.error);
          if (isFirstUtterance) {
            firstUtteranceReceived = true;
            log.info("native meeting first utterance persisted", {
              sessionId,
              audioFrameCount,
              audioByteCount,
            });
          }
        },
        (error) => {
          if (closed) return;
          const detail = error.message || "Shared-room recognition failed";
          void persistFailure(detail).catch((persistError) =>
            log.error("native recognition failure persistence failed", {
              sessionId,
              error: persistError instanceof Error ? persistError.message : String(persistError),
            }),
          );
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Recognition failed");
        },
      );

      if (closed) {
        providerSession.close();
        return;
      }
      await chatStorage.updateMeetingMeta(sessionId, {
        recognition: {
          mode: "shared_room",
          status: "active",
          streams: [recognitionStream("active")],
        },
        sttProvider: provider.provider,
        sttModel: provider.model,
        sttSource: "native_microphone",
        sttFallback: false,
        sttStatus: "active",
        sttStatusDetail: "Shared-room recognition active",
      });
      socket.send(JSON.stringify({ type: "ready", sessionId, sourceKey: SOURCE_KEY }));
      log.info("native meeting audio connected", { sessionId, ownerUserId: principal.userId });
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      log.error("native meeting audio startup failed", { sessionId, error: detail });
      void persistFailure(detail).catch(() => undefined);
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Transcription startup failed");
    });

    socket.on("message", (raw, isBinary) => {
      if (!isBinary || !providerSession || closed) return;
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      if (bytes.length === 0) return;
      if (bytes.length > MAX_AUDIO_FRAME_BYTES || bytes.length % 2 !== 0) {
        log.warn("native meeting audio frame rejected", { sessionId, byteLength: bytes.length });
        socket.close(1009, "Invalid audio frame");
        return;
      }
      audioFrameCount += 1;
      audioByteCount += bytes.length;
      if (!audioStarted) {
        audioStarted = true;
        log.info("native meeting first audio frame received", {
          sessionId,
          byteLength: bytes.length,
        });
        socket.send(JSON.stringify({ type: "audio_started", sessionId, sourceKey: SOURCE_KEY }));
      }
      providerSession.sendAudio(bytes);
    });

    socket.on("close", () => {
      if (closed) return;
      closed = true;
      log.info("native meeting audio disconnected", {
        sessionId,
        audioFrameCount,
        audioByteCount,
        firstUtteranceReceived,
      });
      providerSession?.close();
      void runWithPrincipal(principal, async () => {
        const session = await chatStorage.getSession(sessionId);
        if (!session?.meeting || session.meeting.botStatus !== "live") return;
        await chatStorage.updateMeetingMeta(sessionId, {
          recognition: {
            mode: "shared_room",
            status: "inactive",
            detail: "Microphone disconnected",
            streams: [recognitionStream("closed")],
          },
          sttStatus: "inactive",
          sttStatusDetail: "Microphone disconnected",
        });
      }).catch((error) =>
        log.warn("native meeting disconnect persistence failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });

  return (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}
