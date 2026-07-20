import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { createLogger } from "../log";
import { chatStorage } from "../integrations/chat/storage";
import {
  DeepgramDiarizingSTTProvider,
  HIGH_QUALITY_SCRIBE_POLICY,
  ScribeRealtimeSTTProvider,
  type STTProvider,
  type STTProviderSession,
  type STTUtterance,
} from "../voice/stt";
import type {
  MeetingRecognitionState,
  MeetingRecognitionStream,
  MeetingSessionMeta,
  MeetingSpeakerPolicy,
} from "@shared/models/chat";
import type { MeetingIngestFn } from "../routes/recall";
import { runWithMeetingOwnerPrincipal } from "./owner-principal";

const log = createLogger("MeetingSTT");
const MAX_PARTICIPANT_STREAMS = 16;
const MAX_PENDING_AUDIO_BYTES = 512 * 1024;
const AUDIO_TOKEN_BYTES = 32;
const audioTokensBySession = new Map<string, string>();

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
      participant?: { id?: number | string; name?: string | null; email?: string | null };
    };
    bot?: { id?: string; metadata?: Record<string, unknown> };
    realtime_endpoint?: { id?: string };
    audio_separate?: { id?: string };
  };
}

interface StreamIdentity {
  sessionId: string;
  transportId: string;
  streamId: string;
  label?: string;
  email?: string;
}

interface ParticipantStream {
  identity: StreamIdentity;
  recognition: MeetingRecognitionStream;
  pendingAudio: Buffer[];
  pendingBytes: number;
  stt?: STTProviderSession;
  connectPromise: Promise<void>;
}

function sessionIdFromPayload(payload: RecallAudioPayload): string | null {
  const value = payload.data?.bot?.metadata?.sessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function participantId(payload: RecallAudioPayload): string | null {
  const value = payload.data?.data?.participant?.id;
  return value == null ? null : String(value);
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() || "";
}

function isSharedStream(policy: MeetingSpeakerPolicy | undefined, identity: StreamIdentity): boolean {
  if (policy?.mode !== "selected_shared_streams") return false;
  return policy.sharedStreams.some(({ selector }) => {
    const emailMatches = selector.attendeeEmail
      ? normalize(selector.attendeeEmail) === normalize(identity.email)
      : true;
    const labelMatches = selector.participantLabel
      ? normalize(selector.participantLabel) === normalize(identity.label)
      : true;
    return emailMatches && labelMatches;
  });
}

function recognitionStatus(streams: MeetingRecognitionStream[], closing = false): MeetingRecognitionState["status"] {
  if (closing) return "inactive";
  if (streams.some((stream) => stream.status === "failed" || stream.status === "fallback")) return "degraded";
  if (streams.some((stream) => stream.status === "active")) return "active";
  return "waiting";
}

async function persistRecognition(
  sessionId: string,
  meeting: MeetingSessionMeta,
  streams: Map<string, ParticipantStream>,
  closing = false,
): Promise<void> {
  const recognitionStreams = Array.from(streams.values())
    .filter((stream) => stream.identity.sessionId === sessionId)
    .map((stream) => stream.recognition);
  const anyActive = recognitionStreams.some((stream) => stream.status === "active");
  // Meeting meta is user-owned state; this transport runs from a raw WebSocket
  // with no request principal, so every write must restore the meeting owner.
  await runWithMeetingOwnerPrincipal(meeting, () =>
    chatStorage.updateMeetingMeta(sessionId, {
      recognition: {
        mode: meeting.speakerPolicy?.mode || "participant_streams",
        status: recognitionStatus(recognitionStreams, closing),
        streams: recognitionStreams,
      },
      // Claim the canonical source the moment participant audio is live so the
      // transcript-webhook fallback gate holds before the first Scribe
      // utterance arrives, closing the meeting-start duplication race.
      ...(!closing && anyActive
        ? { sttSource: "recall_participant_audio" as const, sttFallback: false }
        : {}),
      sttStatus: closing
        ? "inactive"
        : recognitionStreams.some((stream) => stream.status === "failed" || stream.status === "fallback")
          ? "fallback"
          : anyActive ? "active" : "inactive",
      sttStatusDetail: closing
        ? "Recall participant audio stream closed"
        : `${recognitionStreams.filter((stream) => stream.status === "active").length}/${recognitionStreams.length} participant streams active`,
    }),
  );
}

async function ingestFinalUtterance(
  ingestMeetingEvent: MeetingIngestFn,
  sessionId: string,
  utterance: STTUtterance,
  diarized: boolean,
): Promise<void> {
  const clusterKey = diarized
    ? `${utterance.participant.transportId}:deepgram:${utterance.providerSpeakerId || "unknown"}`
    : `recall:${utterance.participant.transportId}`;
  const result = await ingestMeetingEvent({
    sessionId,
    speakerLabel: diarized ? undefined : utterance.participant.label,
    speaker: {
      key: clusterKey,
      email: diarized ? undefined : utterance.participant.email,
      transportParticipantId: utterance.participant.transportId,
      providerSpeakerId: utterance.providerSpeakerId,
      source: diarized ? "machine_diarization" : "participant_metadata",
    },
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

function appendPendingAudio(stream: ParticipantStream, bytes: Buffer): void {
  stream.pendingAudio.push(bytes);
  stream.pendingBytes += bytes.length;
  while (stream.pendingBytes > MAX_PENDING_AUDIO_BYTES && stream.pendingAudio.length > 0) {
    const dropped = stream.pendingAudio.shift();
    stream.pendingBytes -= dropped?.length || 0;
  }
}

export function registerMeetingSTTAudioTransport(
  deps: { ingestMeetingEvent: MeetingIngestFn },
): (request: IncomingMessage, socket: Socket, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  const scribeProvider = new ScribeRealtimeSTTProvider();
  const deepgramProvider = new DeepgramDiarizingSTTProvider();

  wss.on("connection", (socket: WebSocket) => {
    const streams = new Map<string, ParticipantStream>();
    const meetings = new Map<string, MeetingSessionMeta>();
    let closed = false;

    const loadMeeting = async (sessionId: string): Promise<MeetingSessionMeta> => {
      const cached = meetings.get(sessionId);
      if (cached) return cached;
      const session = await chatStorage.getSession(sessionId);
      if (!session?.meeting) throw new Error(`Meeting session ${sessionId} not found`);
      meetings.set(sessionId, session.meeting);
      return session.meeting;
    };

    const failStream = async (stream: ParticipantStream, detail: string): Promise<void> => {
      stream.recognition = { ...stream.recognition, status: "failed", detail: detail.slice(0, 500) };
      const meeting = meetings.get(stream.identity.sessionId);
      if (meeting) {
        await persistRecognition(stream.identity.sessionId, meeting, streams).catch((error) =>
          log.error(`failed to persist degraded recognition state sessionId=${stream.identity.sessionId}: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      log.warn(`meeting STT stream failed sessionId=${stream.identity.sessionId} stream=${stream.identity.streamId} detail=${detail}`);
    };

    const connectStream = (
      identity: StreamIdentity,
      meeting: MeetingSessionMeta,
      provider: STTProvider,
      diarized: boolean,
    ): ParticipantStream => {
      const recognition: MeetingRecognitionStream = {
        streamKey: identity.streamId,
        transportParticipantId: identity.transportId,
        transportLabel: identity.label,
        attribution: diarized ? "diarized" : "participant",
        provider: provider.provider,
        model: provider.model,
        status: "connecting",
      };
      const stream = {} as ParticipantStream;
      stream.identity = identity;
      stream.recognition = recognition;
      stream.pendingAudio = [];
      stream.pendingBytes = 0;
      stream.connectPromise = (async () => {
        if (!provider.isConfigured()) {
          throw new Error(`${provider.provider} is not configured for ${diarized ? "shared-room" : "participant"} recognition`);
        }
        return provider.connect(
          {
          streamId: `${identity.sessionId}:meeting:${identity.streamId}`,
          participant: {
            transportId: identity.transportId,
            label: identity.label,
            email: identity.email,
          },
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
          channels: 1,
          },
          async (utterance) => {
          if (utterance.isFinal) await ingestFinalUtterance(deps.ingestMeetingEvent, identity.sessionId, utterance, diarized);
          },
          (error) => void failStream(stream, error.message),
        );
      })().then(async (stt) => {
        stream.stt = stt;
        stream.recognition = { ...stream.recognition, status: "active" };
        for (const packet of stream.pendingAudio) stt.sendAudio(packet);
        stream.pendingAudio = [];
        stream.pendingBytes = 0;
        await persistRecognition(identity.sessionId, meeting, streams);
        log.info(`meeting STT participant connected sessionId=${identity.sessionId} participantId=${identity.transportId} provider=${provider.provider} model=${provider.model} attribution=${recognition.attribution}`);
      }).catch((error) => failStream(stream, error instanceof Error ? error.message : String(error)));
      return stream;
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
        let stream = streams.get(`${sessionId}:${transportId}`);
        if (!stream) {
          if (streams.size >= MAX_PARTICIPANT_STREAMS) {
            log.warn(`meeting participant stream cap reached sessionId=${sessionId} cap=${MAX_PARTICIPANT_STREAMS}`);
            return;
          }
          const participant = payload.data?.data?.participant;
          const identity: StreamIdentity = {
            sessionId,
            transportId,
            streamId: payload.data?.audio_separate?.id || payload.data?.realtime_endpoint?.id || `recall:${sessionId}:${transportId}`,
            label: participant?.name || undefined,
            email: participant?.email || undefined,
          };
          const meeting = await loadMeeting(sessionId);
          const diarized = isSharedStream(meeting.speakerPolicy, identity);
          const provider = diarized ? deepgramProvider : scribeProvider;
          stream = connectStream(identity, meeting, provider, diarized);
          streams.set(`${sessionId}:${transportId}`, stream);
          await persistRecognition(sessionId, meeting, streams);
        }
        const bytes = Buffer.from(audioBase64, "base64");
        if (stream.stt) stream.stt.sendAudio(bytes);
        else if (stream.recognition.status === "connecting") appendPendingAudio(stream, bytes);
      } catch (error) {
        log.warn(`invalid Recall audio packet: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      if (closed) return;
      closed = true;
      for (const stream of streams.values()) stream.stt?.close();
      for (const [sessionId, meeting] of meetings) {
        persistRecognition(sessionId, meeting, streams, true).catch((error) =>
          log.error(`failed to persist closed recognition state sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    });
  });

  return (request, socket, head) => {
    const query = new URL(request.url || "", "http://localhost").searchParams;
    const sessionId = query.get("sessionId");
    const authorized = Boolean(sessionId && consumeMeetingSTTAudioToken(sessionId, query.get("token")));
    if (!canonicalMeetingSTTEnabled() || !authorized) {
      log.warn(`Recall audio upgrade rejected configured=${canonicalMeetingSTTEnabled()} authorized=${authorized} fallback=recall_transcript_webhook policy=${HIGH_QUALITY_SCRIBE_POLICY.model}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}

export function canonicalMeetingSTTEnabled(): boolean {
  return new ScribeRealtimeSTTProvider().isConfigured();
}
