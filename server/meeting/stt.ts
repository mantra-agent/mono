import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { createLogger } from "../log";
import { chatStorage } from "../integrations/chat/storage";
import {
  HIGH_QUALITY_SCRIBE_POLICY,
  ScribeRealtimeSTTProvider,
  type STTProviderSession,
  type STTUtterance,
} from "../voice/stt";
import type { MeetingIngestFn } from "../routes/recall";

const log = createLogger("MeetingSTT");
const MAX_PARTICIPANT_STREAMS = 16;
const AUDIO_TOKEN_BYTES = 32;
const audioTokensBySession = new Map<string, string>();

/**
 * Issue a short-lived capability token for one meeting session's Recall audio
 * endpoint. This is transport state, not deployment configuration: provider
 * readiness comes from the existing ElevenLabs integration in secrets-store.
 */
export function issueMeetingSTTAudioToken(sessionId: string): string {
  const token = crypto.randomBytes(AUDIO_TOKEN_BYTES).toString("base64url");
  audioTokensBySession.set(sessionId, token);
  return token;
}

function consumeMeetingSTTAudioToken(sessionId: string, suppliedToken: string | null): boolean {
  const expectedToken = audioTokensBySession.get(sessionId);
  if (!expectedToken || !suppliedToken) return false;
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  const authorized = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  if (authorized) audioTokensBySession.delete(sessionId);
  return authorized;
}

interface RecallAudioPayload {
  event?: string;
  data?: {
    data?: {
      buffer?: string;
      timestamp?: { absolute?: string; relative?: number };
      participant?: {
        id?: number | string;
        name?: string | null;
        email?: string | null;
      };
    };
    bot?: { id?: string; metadata?: Record<string, unknown> };
    realtime_endpoint?: { id?: string };
    audio_separate?: { id?: string };
  };
}

interface ParticipantStream {
  stt: STTProviderSession;
  label?: string;
}

function sessionIdFromPayload(payload: RecallAudioPayload): string | null {
  const value = payload.data?.bot?.metadata?.sessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function participantId(payload: RecallAudioPayload): string | null {
  const value = payload.data?.data?.participant?.id;
  return value == null ? null : String(value);
}

async function persistSTTState(
  sessionId: string,
  patch: Parameters<typeof chatStorage.updateMeetingMeta>[1],
): Promise<void> {
  await chatStorage.updateMeetingMeta(sessionId, patch);
}

async function ingestFinalUtterance(
  ingestMeetingEvent: MeetingIngestFn,
  sessionId: string,
  utterance: STTUtterance,
): Promise<void> {
  const result = await ingestMeetingEvent({
    sessionId,
    speakerLabel: utterance.participant.label,
    turnId: utterance.utteranceId,
    text: utterance.text,
    botStatus: "live",
    stt: {
      provider: utterance.provider,
      model: utterance.model,
      source: "recall_participant_audio",
      fallback: false,
    },
  });
  if (!result.ok) throw new Error(result.error);
}

/**
 * Recall separate-audio adapter. Recall owns participant separation and emits
 * 16 kHz mono PCM S16LE. This adapter owns bounded fan-out into the canonical
 * voice-domain STT provider; only final canonical utterances cross meeting
 * ingest and the existing AgentExecutor path.
 */
export function registerMeetingSTTAudioTransport(
  deps: { ingestMeetingEvent: MeetingIngestFn },
): (request: IncomingMessage, socket: Socket, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  const provider = new ScribeRealtimeSTTProvider();

  wss.on("connection", (socket: WebSocket) => {
    const streams = new Map<string, ParticipantStream>();
    const sessionIds = new Set<string>();
    let closed = false;

    const failSession = async (sessionId: string, detail: string): Promise<void> => {
      log.warn(`meeting STT degraded sessionId=${sessionId} provider=${provider.provider} model=${provider.model} detail=${detail}`);
      await persistSTTState(sessionId, {
        sttProvider: provider.provider,
        sttModel: provider.model,
        sttSource: "recall_transcript_webhook",
        sttFallback: true,
        sttStatus: "fallback",
        sttStatusDetail: detail.slice(0, 500),
      });
    };

    socket.on("message", async (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as RecallAudioPayload;
        if (payload.event !== "audio_separate_raw.data") return;
        const sessionId = sessionIdFromPayload(payload);
        const transportId = participantId(payload);
        const audioBase64 = payload.data?.data?.buffer;
        if (!sessionId || !transportId || typeof audioBase64 !== "string") {
          log.warn("Recall participant audio packet missing session, participant, or buffer");
          return;
        }
        sessionIds.add(sessionId);
        let participantStream = streams.get(transportId);
        if (!participantStream) {
          if (streams.size >= MAX_PARTICIPANT_STREAMS) {
            await failSession(sessionId, `participant stream cap ${MAX_PARTICIPANT_STREAMS} reached`);
            return;
          }
          const participant = payload.data?.data?.participant;
          const streamId = payload.data?.audio_separate?.id || payload.data?.realtime_endpoint?.id || `recall:${sessionId}:${transportId}`;
          try {
            const stt = await provider.connect(
              {
                streamId,
                participant: {
                  transportId,
                  label: participant?.name || undefined,
                  email: participant?.email || undefined,
                },
                encoding: "pcm_s16le",
                sampleRateHz: 16000,
                channels: 1,
              },
              async (utterance) => {
                log.debug(`meeting utterance sessionId=${sessionId} participantId=${transportId} provider=${utterance.provider} model=${utterance.model} final=${utterance.isFinal}`);
                if (utterance.isFinal) await ingestFinalUtterance(deps.ingestMeetingEvent, sessionId, utterance);
              },
              (error) => void failSession(sessionId, error.message),
            );
            participantStream = { stt, label: participant?.name || undefined };
            streams.set(transportId, participantStream);
            await persistSTTState(sessionId, {
              sttProvider: provider.provider,
              sttModel: provider.model,
              sttSource: "recall_participant_audio",
              sttFallback: false,
              sttStatus: "active",
              sttStatusDetail: `participant stream ${transportId} connected`,
            });
            log.info(`meeting STT participant connected sessionId=${sessionId} participantId=${transportId} provider=${provider.provider} model=${provider.model}`);
          } catch (error) {
            await failSession(sessionId, error instanceof Error ? error.message : String(error));
            return;
          }
        }
        participantStream.stt.sendAudio(Buffer.from(audioBase64, "base64"));
      } catch (error) {
        log.warn(`invalid Recall audio packet: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      if (closed) return;
      closed = true;
      for (const participant of streams.values()) participant.stt.close();
      streams.clear();
      for (const sessionId of sessionIds) {
        void persistSTTState(sessionId, {
          sttStatus: "inactive",
          sttStatusDetail: "Recall participant audio stream closed",
        });
      }
    });
  });

  return (request, socket, head) => {
    const query = new URL(request.url || "", "http://localhost").searchParams;
    const sessionId = query.get("sessionId");
    const authorized = Boolean(sessionId && consumeMeetingSTTAudioToken(sessionId, query.get("token")));
    if (!provider.isConfigured() || !authorized) {
      log.warn(`Recall audio upgrade rejected configured=${provider.isConfigured()} authorized=${authorized} fallback=recall_transcript_webhook policy=${HIGH_QUALITY_SCRIBE_POLICY.model}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}

export function canonicalMeetingSTTEnabled(): boolean {
  return new ScribeRealtimeSTTProvider().isConfigured();
}
