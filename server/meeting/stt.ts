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
  MeetingAudioSourceMode,
  MeetingRecognitionState,
  MeetingRecognitionStream,
  MeetingSessionMeta,
  MeetingSpeakerPolicy,
  type CanonicalMeetingSpeakerPolicy,
  type MeetingRecognitionReasonCode,
} from "@shared/models/chat";
import { meetingDefaultAudioSourceMode } from "@shared/models/chat";
import { eventBus, type BusEvent } from "../event-bus";
import type { MeetingIngestFn } from "../routes/recall";
import {
  resolveMeetingTransportSession,
  runWithMeetingOwnerPrincipal,
} from "./owner-principal";
import { publishMeetingAudioLevel, syncMeetingVisualizerBotStatus } from "./output-media";

const log = createLogger("MeetingSTT");
const MAX_PARTICIPANT_STREAMS = 16;
const MAX_PENDING_AUDIO_BYTES = 512 * 1024;
const AUDIO_TOKEN_TTL_MS = 12 * 60 * 60_000;
const AUDIO_TOKEN_PURPOSE = "meeting-participant-audio";

function audioTokenSignature(sessionId: string, expiresAt: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for meeting participant audio");
  return crypto
    .createHmac("sha256", secret)
    .update(`${AUDIO_TOKEN_PURPOSE}.${sessionId}.${expiresAt}`)
    .digest("base64url");
}

/** Stateless grant survives Recall reconnects and multi-process routing. */
export function issueMeetingSTTAudioToken(
  sessionId: string,
  expiresAt = Date.now() + AUDIO_TOKEN_TTL_MS,
): string {
  return Buffer.from(JSON.stringify({
    sessionId,
    expiresAt,
    signature: audioTokenSignature(sessionId, expiresAt),
  })).toString("base64url");
}

function validateMeetingSTTAudioToken(sessionId: string, suppliedToken: string | null): boolean {
  if (!suppliedToken) return false;
  try {
    const grant = JSON.parse(Buffer.from(suppliedToken, "base64url").toString("utf8")) as {
      sessionId?: string;
      expiresAt?: number;
      signature?: string;
    };
    if (grant.sessionId !== sessionId || !grant.expiresAt || grant.expiresAt <= Date.now() || !grant.signature) {
      return false;
    }
    const expected = Buffer.from(audioTokenSignature(sessionId, grant.expiresAt));
    const supplied = Buffer.from(grant.signature);
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
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

const RECALL_OUTPUT_PARTICIPANT_ID = "2147483647";

type StreamRoute =
  | { kind: "excluded"; detail: string }
  | { kind: "diarized"; provider: STTProvider }
  | { kind: "participant"; provider: STTProvider };

function routeStream(
  sourceMode: MeetingAudioSourceMode,
  identity: StreamIdentity,
  providers: { scribe: STTProvider; deepgram: STTProvider },
): StreamRoute {
  const normalizedLabel = identity.label?.trim().toLowerCase();
  if (identity.transportId === RECALL_OUTPUT_PARTICIPANT_ID || normalizedLabel === "mantra agent") {
    return { kind: "excluded", detail: "Mantra output excluded from human transcript ingestion" };
  }
  return sourceMode === "shared_room"
    ? { kind: "diarized", provider: providers.deepgram }
    : { kind: "participant", provider: providers.scribe };
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
  const degradedDetail = recognitionStreams.find(
    (stream) => stream.status === "failed" || stream.status === "fallback",
  )?.detail;
  // Meeting meta is user-owned state; this transport runs from a raw WebSocket
  // with no request principal, so every write must restore the meeting owner.
  await runWithMeetingOwnerPrincipal(meeting, () =>
    chatStorage.updateMeetingMeta(sessionId, {
      recognition: {
        mode: meetingDefaultAudioSourceMode(meeting.speakerPolicy),
        status: recognitionStatus(recognitionStreams, closing),
        ...(degradedDetail ? { detail: degradedDetail } : {}),
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
        : `${recognitionStreams.filter((stream) => stream.status === "active").length} active, ${recognitionStreams.filter((stream) => stream.status === "excluded").length} excluded, ${recognitionStreams.length} total audio streams`,
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
    ? `stream:${utterance.streamId}:deepgram:${utterance.providerSpeakerId || "unknown"}`
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

function pcm16Rms(bytes: Buffer): number {
  const sampleCount = Math.floor(bytes.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSquares / sampleCount) * 4.5);
}

export function registerMeetingSTTAudioTransport(
  deps: { ingestMeetingEvent: MeetingIngestFn },
): (request: IncomingMessage, socket: Socket, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  const scribeProvider = new ScribeRealtimeSTTProvider();
  const deepgramProvider = new DeepgramDiarizingSTTProvider();
  const liveConnections = new Set<{
    meetings: Map<string, MeetingSessionMeta>;
    streams: Map<string, ParticipantStream>;
    reconfigureStream: (stream: ParticipantStream, mode: MeetingAudioSourceMode) => Promise<void>;
  }>();

  const onSourcePolicyUpdated = (busEvent: BusEvent): void => {
    if (busEvent.event !== "meeting.audio_source_policy.updated") return;
    const sessionId = typeof busEvent.payload.sessionId === "string" ? busEvent.payload.sessionId : "";
    const sourceKey = typeof busEvent.payload.sourceKey === "string" ? busEvent.payload.sourceKey : "";
    const mode = busEvent.payload.mode;
    if (mode !== "participant_streams" && mode !== "shared_room") return;
    for (const connection of liveConnections) {
      const meeting = connection.meetings.get(sessionId);
      const stream = Array.from(connection.streams.values()).find(
        (candidate) => candidate.identity.sessionId === sessionId && candidate.identity.streamId === sourceKey,
      );
      if (!stream || !meeting) continue;
      if (
        busEvent.audience.scope !== "user" ||
        busEvent.audience.ownerUserId !== meeting.ownerUserId ||
        busEvent.audience.accountId !== meeting.principalAccountId
      ) continue;
      void connection.reconfigureStream(stream, mode).catch((error) =>
        log.error("meeting audio source reconfiguration failed", {
          sessionId,
          sourceKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  eventBus.on("event", onSourcePolicyUpdated);

  wss.on("connection", (socket: WebSocket) => {
    const streams = new Map<string, ParticipantStream>();
    const streamInitializations = new Map<string, Promise<ParticipantStream>>();
    const meetings = new Map<string, MeetingSessionMeta>();
    const policyRefreshes = new Map<string, Promise<MeetingSessionMeta>>();
    const policyRefreshedAt = new Map<string, number>();
    let closed = false;

    const streamMapKey = (sessionId: string, transportId: string): string => `${sessionId}:${transportId}`;

    const loadMeeting = async (sessionId: string): Promise<MeetingSessionMeta> => {
      const cached = meetings.get(sessionId);
      if (cached) return cached;
      const session = await resolveMeetingTransportSession(sessionId);
      if (!session?.meeting) throw new Error(`Meeting session ${sessionId} not found`);
      meetings.set(sessionId, session.meeting);
      return session.meeting;
    };

    const refreshMeetingPolicy = async (sessionId: string): Promise<MeetingSessionMeta> => {
      const cached = meetings.get(sessionId);
      if (cached && Date.now() - (policyRefreshedAt.get(sessionId) || 0) < 1_000) return cached;
      const inFlight = policyRefreshes.get(sessionId);
      if (inFlight) return inFlight;
      if (!cached) return loadMeeting(sessionId);
      const refresh = runWithMeetingOwnerPrincipal(cached, async () => {
        const session = await chatStorage.getSession(sessionId);
        if (!session?.meeting) throw new Error(`Meeting session ${sessionId} not found`);
        meetings.set(sessionId, session.meeting);
        policyRefreshedAt.set(sessionId, Date.now());
        return session.meeting;
      }).finally(() => policyRefreshes.delete(sessionId));
      policyRefreshes.set(sessionId, refresh);
      return refresh;
    };

    const failStream = async (stream: ParticipantStream, detail: string): Promise<void> => {
      const mapKey = streamMapKey(stream.identity.sessionId, stream.identity.transportId);
      if (
        closed ||
        streams.get(mapKey) !== stream ||
        ["closed", "excluded"].includes(stream.recognition.status)
      ) {
        log.debug(
          `ignored meeting STT error after stream close sessionId=${stream.identity.sessionId} stream=${stream.identity.streamId} detail=${detail}`,
        );
        return;
      }
      const meeting = meetings.get(stream.identity.sessionId);
      if (meeting) {
        const currentSession = await runWithMeetingOwnerPrincipal(
          meeting,
          () => chatStorage.getSession(stream.identity.sessionId),
        );
        const currentMeeting = currentSession?.meeting;
        if (
          currentMeeting &&
          ["leaving", "ended", "denied", "failed"].includes(currentMeeting.botStatus)
        ) {
          meetings.set(stream.identity.sessionId, currentMeeting);
          stream.recognition = { ...stream.recognition, status: "closed", detail: undefined };
          await persistRecognition(stream.identity.sessionId, currentMeeting, streams, true).catch((error) =>
            log.error(`failed to persist closed recognition state sessionId=${stream.identity.sessionId}: ${error instanceof Error ? error.message : String(error)}`),
          );
          log.info(
            `meeting STT stream closed with meeting lifecycle sessionId=${stream.identity.sessionId} stream=${stream.identity.streamId} botStatus=${currentMeeting.botStatus}`,
          );
          return;
        }
      }
      stream.recognition = { ...stream.recognition, status: "failed", detail: detail.slice(0, 500) };
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
      route: Extract<StreamRoute, { kind: "participant" | "diarized" }>,
      isCurrent: (stream: ParticipantStream) => boolean = () => true,
    ): ParticipantStream => {
      const provider = route.provider;
      const diarized = route.kind === "diarized";
      const recognition: MeetingRecognitionStream = {
        streamKey: identity.streamId,
        transportParticipantId: identity.transportId,
        transportLabel: identity.label,
        sourcePolicy: diarized ? "shared_room" : "participant_streams",
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
          if (utterance.isFinal && isCurrent(stream)) {
            await ingestFinalUtterance(deps.ingestMeetingEvent, identity.sessionId, utterance, diarized);
          }
          },
          (error) => void failStream(stream, error.message),
        );
      })().then(async (stt) => {
        stream.stt = stt;
        stream.recognition = { ...stream.recognition, status: "active" };
        syncMeetingVisualizerBotStatus(identity.sessionId, "live");
        for (const packet of stream.pendingAudio) stt.sendAudio(packet);
        stream.pendingAudio = [];
        stream.pendingBytes = 0;
        await persistRecognition(identity.sessionId, meeting, streams);
        log.info(`meeting STT participant connected sessionId=${identity.sessionId} participantId=${identity.transportId} provider=${provider.provider} model=${provider.model} attribution=${recognition.attribution}`);
      }).catch((error) => failStream(stream, error instanceof Error ? error.message : String(error)));
      return stream;
    };

    const reconfigureStream = async (
      stream: ParticipantStream,
      mode: MeetingAudioSourceMode,
    ): Promise<void> => {
      const meeting = await loadMeeting(stream.identity.sessionId);
      if (stream.recognition.attribution === "excluded") return;
      if (stream.recognition.sourcePolicy === mode && ["connecting", "active"].includes(stream.recognition.status)) {
        return;
      }
      stream.stt?.close();
      stream.stt = undefined;
      stream.pendingAudio = [];
      stream.pendingBytes = 0;
      const route = routeStream(mode, stream.identity, {
        scribe: scribeProvider,
        deepgram: deepgramProvider,
      });
      if (route.kind === "excluded") return;
      const mapKey = streamMapKey(stream.identity.sessionId, stream.identity.transportId);
      let replacement: ParticipantStream;
      replacement = connectStream(
        stream.identity,
        meeting,
        route,
        (candidate) => streams.get(mapKey) === candidate,
      );
      streams.set(mapKey, replacement);
      await persistRecognition(stream.identity.sessionId, meeting, streams);
      log.info("meeting audio source reconfigured", {
        sessionId: stream.identity.sessionId,
        sourceKey: stream.identity.streamId,
        mode,
      });
    };

    const connection = { meetings, streams, reconfigureStream };
    liveConnections.add(connection);

    const excludeStream = (identity: StreamIdentity, detail: string): ParticipantStream => ({
      identity,
      recognition: {
        streamKey: identity.streamId,
        transportParticipantId: identity.transportId,
        transportLabel: identity.label,
        sourcePolicy: "participant_streams",
        attribution: "excluded",
        provider: "none",
        model: "bot_output_exclusion",
        status: "excluded",
        detail,
      },
      pendingAudio: [],
      pendingBytes: 0,
      connectPromise: Promise.resolve(),
    });

    const initializeStream = async (
      sessionId: string,
      transportId: string,
      payload: RecallAudioPayload,
    ): Promise<ParticipantStream> => {
      const participant = payload.data?.data?.participant;
      const identity: StreamIdentity = {
        sessionId,
        transportId,
        streamId: `${payload.data?.audio_separate?.id || payload.data?.realtime_endpoint?.id || `recall:${sessionId}`}:participant:${transportId}`,
        label: participant?.name || undefined,
        email: participant?.email || undefined,
      };
      let meeting = await loadMeeting(sessionId);
      const existingPolicy = meeting.audioSourcePolicies?.[identity.streamId];
      const legacySelectedShared = meeting.speakerPolicy?.mode === "selected_shared_streams"
        && meeting.speakerPolicy.sharedStreams.some((candidate) => {
          const selectorEmail = candidate.selector.attendeeEmail?.trim().toLowerCase();
          return !!selectorEmail && selectorEmail === identity.email?.trim().toLowerCase();
        });
      const sourceMode = existingPolicy?.mode
        || (legacySelectedShared ? "shared_room" : meetingDefaultAudioSourceMode(meeting.speakerPolicy));
      if (!existingPolicy) {
        const initialized = await runWithMeetingOwnerPrincipal(meeting, () =>
          chatStorage.initializeMeetingAudioSourcePolicy(sessionId, identity.streamId, sourceMode),
        );
        if (initialized?.meeting) {
          meeting = initialized.meeting;
          meetings.set(sessionId, meeting);
        }
      }
      const route = routeStream(sourceMode, identity, {
        scribe: scribeProvider,
        deepgram: deepgramProvider,
      });
      const stream = route.kind === "excluded"
        ? excludeStream(identity, route.detail)
        : connectStream(identity, meeting, route);
      streams.set(streamMapKey(sessionId, transportId), stream);
      await persistRecognition(sessionId, meeting, streams);
      log.info(`meeting audio stream routed sessionId=${sessionId} participantId=${transportId} route=${route.kind} stream=${identity.streamId}`);
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
        const streamKey = streamMapKey(sessionId, transportId);
        let stream = streams.get(streamKey);
        if (!stream) {
          let initialization = streamInitializations.get(streamKey);
          if (!initialization) {
            if (streams.size + streamInitializations.size >= MAX_PARTICIPANT_STREAMS) {
              log.warn(`meeting participant stream cap reached sessionId=${sessionId} cap=${MAX_PARTICIPANT_STREAMS}`);
              return;
            }
            initialization = initializeStream(sessionId, transportId, payload)
              .finally(() => streamInitializations.delete(streamKey));
            streamInitializations.set(streamKey, initialization);
          }
          stream = await initialization;
        }
        stream = streams.get(streamKey) || stream;
        const currentMeeting = await refreshMeetingPolicy(sessionId);
        const currentMode = currentMeeting.audioSourcePolicies?.[stream.identity.streamId]?.mode
          || stream.recognition.sourcePolicy;
        if (currentMode !== stream.recognition.sourcePolicy) {
          await reconfigureStream(stream, currentMode);
          stream = streams.get(streamKey) || stream;
        }
        if (stream.recognition.status === "excluded") return;
        const bytes = Buffer.from(audioBase64, "base64");
        publishMeetingAudioLevel(sessionId, pcm16Rms(bytes));
        if (stream.stt) stream.stt.sendAudio(bytes);
        else if (stream.recognition.status === "connecting") appendPendingAudio(stream, bytes);
      } catch (error) {
        log.warn(`invalid Recall audio packet: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      if (closed) return;
      closed = true;
      for (const stream of streams.values()) {
        if (stream.recognition.status !== "excluded") {
          stream.recognition = { ...stream.recognition, status: "closed", detail: undefined };
        }
        stream.stt?.close();
      }
      liveConnections.delete(connection);
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
    const authorized = Boolean(sessionId && validateMeetingSTTAudioToken(sessionId, query.get("token")));
    if (!authorized) {
      log.warn("Recall audio upgrade rejected authorized=false fallback=recall_transcript_webhook");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}

export interface MeetingRecognitionLaunchPlan {
  outcome: "participant_audio" | "transcript_fallback";
  mode: CanonicalMeetingSpeakerPolicy["mode"];
  provider: string;
  model: string;
  source: "recall_participant_audio" | "recall_transcript_webhook";
  fallback: boolean;
  sttStatus: "fallback" | "inactive";
  recognitionStatus: MeetingRecognitionState["status"];
  reasonCode: MeetingRecognitionReasonCode;
  detail: string;
}

/** Canonical readiness and launch decision for meeting recognition. */
export function createMeetingRecognitionLaunchPlan(
  policy?: MeetingSpeakerPolicy,
): MeetingRecognitionLaunchPlan {
  const mode = meetingDefaultAudioSourceMode(policy);
  const scribe = new ScribeRealtimeSTTProvider();
  const deepgram = new DeepgramDiarizingSTTProvider();
  const provider = mode === "shared_room" ? deepgram : scribe;
  const alternateProvider = mode === "shared_room" ? scribe : deepgram;

  if (provider.isConfigured() || alternateProvider.isConfigured()) {
    const requestedReady = provider.isConfigured();
    return {
      outcome: "participant_audio",
      mode,
      provider: requestedReady ? provider.provider : alternateProvider.provider,
      model: requestedReady ? provider.model : alternateProvider.model,
      source: "recall_participant_audio",
      fallback: !requestedReady,
      sttStatus: requestedReady ? "inactive" : "fallback",
      recognitionStatus: requestedReady ? "waiting" : "degraded",
      reasonCode: requestedReady
        ? "participant_audio_ready"
        : mode === "shared_room" ? "deepgram_not_configured" : "scribe_not_configured",
      detail: requestedReady
        ? `Waiting for Recall participant audio for ${mode === "shared_room" ? "shared-room" : "participant"} recognition`
        : `${mode === "shared_room" ? "Shared-room" : "Participant"} recognition is unavailable because ${mode === "shared_room" ? "DEEPGRAM_API_KEY" : "ELEVENLABS_API_KEY"} is not configured. Live audio sources remain available and can be switched to the configured recognition mode.`,
    };
  }

  const sharedRoom = mode === "shared_room";
  return {
    outcome: "transcript_fallback",
    mode,
    provider: "recallai_streaming",
    model: "prioritize_low_latency",
    source: "recall_transcript_webhook",
    fallback: true,
    sttStatus: "fallback",
    recognitionStatus: "degraded",
    reasonCode: sharedRoom ? "deepgram_not_configured" : "scribe_not_configured",
    detail: sharedRoom
      ? "Shared-room speaker recognition is unavailable because DEEPGRAM_API_KEY is not configured. Transcript capture continues through Recall, but people sharing one microphone will not be separated. Configure DEEPGRAM_API_KEY and start a new meeting."
      : "Participant-audio recognition is unavailable because ELEVENLABS_API_KEY is not configured. Transcript capture continues through Recall. Configure ELEVENLABS_API_KEY and start a new meeting.",
  };
}
