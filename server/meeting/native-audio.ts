import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import type { MeetingRecognitionStream } from "@shared/models/chat";
import type { MeetingIngestFn } from "../routes/recall";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import {
  speechRecognitionStreamCoordinator,
  type CoordinatedSpeechRecognitionStream,
  type SpeechRecognitionCoordinatorState,
} from "../speech-recognition";
import { principalOwnsMeeting } from "./owner-principal";
import { openConsentedMeetingAudioRecorder, type MeetingAudioRecorder } from "./audio-retention";

const log = createLogger("NativeMeetingAudio");
const SOURCE_KEY = "native:microphone";
const TRANSPORT_PARTICIPANT_ID = "native-microphone";
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

type NativeMeetingRequest = IncomingMessage & { nativeMeetingPrincipal?: Principal };

function recognitionStream(state: SpeechRecognitionCoordinatorState): MeetingRecognitionStream {
  const status: MeetingRecognitionStream["status"] = state.status === "reconnecting"
    ? "connecting"
    : state.status;
  return {
    streamKey: SOURCE_KEY,
    transportParticipantId: TRANSPORT_PARTICIPANT_ID,
    transportLabel: "Shared microphone",
    sourcePolicy: "shared_room",
    attribution: "diarized",
    bindingId: state.binding?.bindingId,
    adapterKind: state.binding?.adapterKind || "deepgram-realtime",
    attemptId: state.attemptId,
    configFingerprint: state.binding?.configFingerprint,
    provider: state.binding?.provider || "deepgram",
    model: state.binding?.model || "nova-3",
    status,
    ...(state.detail ? { detail: state.detail.slice(0, 500) } : {}),
  };
}

function recognitionStatus(state: SpeechRecognitionCoordinatorState): "waiting" | "active" | "degraded" | "inactive" {
  if (state.status === "active") return "active";
  if (state.status === "failed" || state.status === "reconnecting") return "degraded";
  if (state.status === "closed") return "inactive";
  return "waiting";
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

    let recognition: CoordinatedSpeechRecognitionStream | undefined;
    let recorder: MeetingAudioRecorder | null = null;
    let closed = false;
    let audioStarted = false;
    let firstUtteranceReceived = false;
    let audioFrameCount = 0;
    let audioByteCount = 0;
    let latestState: SpeechRecognitionCoordinatorState = { status: "connecting" };
    let statePersistence = Promise.resolve();

    const persistState = (state: SpeechRecognitionCoordinatorState): void => {
      latestState = state;
      statePersistence = statePersistence.then(() => runWithPrincipal(principal, async () => {
        const current = await chatStorage.getSession(sessionId);
        if (
          !current?.meeting
          || current.meeting.transport !== "native"
          || (state.status !== "closed" && current.meeting.botStatus !== "live")
        ) return;
        const stream = recognitionStream(state);
        const detail = state.detail?.slice(0, 500);
        await chatStorage.updateMeetingMeta(sessionId, {
          recognition: {
            mode: "shared_room",
            status: recognitionStatus(state),
            ...(detail ? { detail } : {}),
            streams: [stream],
          },
          ...(state.status === "active" ? {
            sttProvider: stream.provider,
            sttModel: stream.model,
            sttSource: "native_microphone" as const,
            sttFallback: false,
          } : {}),
          sttStatus: state.status === "active"
            ? "active"
            : state.status === "failed" || state.status === "reconnecting"
              ? "fallback"
              : "inactive",
          sttFallback: state.status === "failed" || state.status === "reconnecting",
          sttStatusDetail: detail || (state.status === "closed"
            ? "Microphone disconnected"
            : state.status === "active"
              ? "Shared-room recognition active"
              : "Connecting shared-room recognition"),
        });
      })).catch((error) => {
        log.error("native recognition state persistence failed", {
          sessionId,
          status: state.status,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });
    };

    void runWithPrincipal(principal, async () => {
      const session = await chatStorage.getSession(sessionId);
      if (
        !session
        || !principalOwnsMeeting(principal, session)
        || session.meeting?.transport !== "native"
        || session.meeting.botStatus !== "live"
      ) {
        socket.close(1008, "Meeting unavailable");
        return;
      }

      recorder = await openConsentedMeetingAudioRecorder(sessionId, principal);
      recognition = speechRecognitionStreamCoordinator.open(
        {
          useCase: "meeting_shared_room",
          adapterKinds: ["deepgram-realtime"],
          stream: {
            streamId: `${sessionId}:meeting:${SOURCE_KEY}`,
            participant: {
              transportId: TRANSPORT_PARTICIPANT_ID,
              label: "Shared microphone",
            },
            encoding: "pcm_s16le",
            sampleRateHz: 16000,
            channels: 1,
          },
        },
        {
          onState: persistState,
          onFailure: (failure) => {
            log.warn("native speech recognition failed", {
              sessionId,
              kind: failure.kind,
              retryable: failure.retryable,
            });
            if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Recognition failed");
          },
          onUtterance: async (utterance) => {
            if (closed) return;
            const isFirstUtterance = !firstUtteranceReceived;
            const current = await runWithPrincipal(principal, () => chatStorage.getSession(sessionId));
            if (
              !current?.meeting
              || current.meeting.transport !== "native"
              || current.meeting.botStatus !== "live"
            ) {
              closed = true;
              recognition?.abort("Meeting ended");
              if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Meeting ended");
              return;
            }
            const result = await deps.ingestMeetingEvent({
              sessionId,
              speaker: {
                key: `recognition:${utterance.attemptId}:speaker:${utterance.providerSpeakerId || "unknown"}`,
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
                recognition: {
                  attemptId: utterance.attemptId,
                  bindingId: utterance.bindingId,
                  streamKey: SOURCE_KEY,
                  adapterKind: utterance.adapterKind,
                  provider: utterance.provider,
                  model: utterance.model,
                  configFingerprint: utterance.configFingerprint,
                  providerSpeakerId: utterance.providerSpeakerId,
                  source: "native_microphone",
                },
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
        },
      );

      await recognition.ready;
      if (closed) {
        recognition.abort("Native microphone closed during startup");
        return;
      }
      await statePersistence;
      socket.send(JSON.stringify({ type: "ready", sessionId, sourceKey: SOURCE_KEY }));
      log.info("native meeting audio connected", {
        sessionId,
        adapterKind: recognition.getState().binding?.adapterKind,
      });
    }).catch((error) => {
      log.error("native meeting audio startup failed", {
        sessionId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Transcription startup failed");
    });

    socket.on("message", (raw, isBinary) => {
      if (!isBinary || !recognition || closed) return;
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
      const writeOutcome = recognition.tryWriteAudio(bytes);
      if (writeOutcome !== "accepted") {
        log.warn("native meeting recognition unavailable", { sessionId, writeOutcome });
        socket.close(1013, "Recognition unavailable");
        return;
      }
      audioFrameCount += 1;
      audioByteCount += bytes.length;
      recorder?.append(bytes);
      if (!audioStarted) {
        audioStarted = true;
        log.info("native meeting first audio frame received", {
          sessionId,
          byteLength: bytes.length,
        });
        socket.send(JSON.stringify({ type: "audio_started", sessionId, sourceKey: SOURCE_KEY }));
      }
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
      if (recognition) {
        void recognition.finish().then((result) => {
          if (result.outcome === "timed_out") {
            log.warn("native recognition finish timed out", {
              sessionId,
              attemptId: latestState.attemptId,
            });
          }
        }).finally(() => recorder?.finalize());
      } else {
        void recorder?.finalize();
      }
    });
  });

  return (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}
