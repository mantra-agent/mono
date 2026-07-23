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
import {
  createSpeechRecognitionHints,
  resolveSpeechRecognitionHints,
  type SpeechRecognitionHints,
} from "../speech-recognition-hints";

const log = createLogger("MeetingSTT");
const MAX_PARTICIPANT_STREAMS = 16;
const MAX_PENDING_AUDIO_BYTES = 512 * 1024;
const AUDIO_TOKEN_TTL_MS = 12 * 60 * 60_000;
const AUDIO_TOKEN_PURPOSE = "meeting-participant-audio";

// A realtime STT provider socket (Scribe/Deepgram) can drop mid-meeting on
// idle silence, provider max-duration limits, or transient network faults.
// Reconnect the participant session with bounded backoff before declaring
// recognition failed, buffering incoming audio across the gap so speech is not
// lost. Without this, a single drop freezes transcript delivery for the rest of
// a long meeting.
const STT_RECONNECT_MAX_ATTEMPTS = 5;
const STT_RECONNECT_BASE_DELAY_MS = 500;
const STT_RECONNECT_MAX_DELAY_MS = 8_000;

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
      participant?: {
        id?: number | string;
        name?: string | null;
        email?: string | null;
        is_host?: boolean | null;
      };
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
  isHost?: boolean;
}

interface ParticipantStream {
  identity: StreamIdentity;
  recognition: MeetingRecognitionStream;
  pendingAudio: Buffer[];
  pendingBytes: number;
  stt?: STTProviderSession;
  connectPromise: Promise<void>;
}

export interface MeetingRecognitionCapabilities {
  participantStreams: { available: boolean; provider: string; model: string };
  sharedRoom: { available: boolean; provider: string; model: string };
}

export function meetingRecognitionCapabilities(): MeetingRecognitionCapabilities {
  const scribe = new ScribeRealtimeSTTProvider();
  const deepgram = new DeepgramDiarizingSTTProvider();
  return {
    participantStreams: {
      available: scribe.isConfigured(),
      provider: scribe.provider,
      model: scribe.model,
    },
    sharedRoom: {
      available: deepgram.isConfigured(),
      provider: deepgram.provider,
      model: deepgram.model,
    },
  };
}

export function unavailableMeetingRecognitionDetail(mode: MeetingAudioSourceMode): string {
  return mode === "shared_room"
    ? "Shared-room speaker separation requires a configured real-time machine-diarization provider. Deepgram Nova-3 is the current adapter."
    : "Participant-stream recognition requires ElevenLabs Scribe Realtime.";
}

function isConfigurationError(detail: string): boolean {
  return /not configured/i.test(detail);
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
    ? `stream:${utterance.streamId}:${utterance.provider}:${utterance.providerSpeakerId || "unknown"}`
    : `recall:${utterance.participant.transportId}`;
  const result = await ingestMeetingEvent({
    sessionId,
    speakerLabel: diarized ? undefined : utterance.participant.label,
    speaker: {
      key: clusterKey,
      email: diarized ? undefined : utterance.participant.email,
      isHost: diarized ? undefined : utterance.participant.isHost,
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
  const meetingHints = new Map<string, Promise<SpeechRecognitionHints>>();
  const recognitionHintsForMeeting = (
    sessionId: string,
    meeting: MeetingSessionMeta,
  ): Promise<SpeechRecognitionHints> => {
    const existing = meetingHints.get(sessionId);
    if (existing) return existing;
    const fallback = createSpeechRecognitionHints([
      "Mantra",
      meeting.title,
      ...meeting.participants.flatMap((participant) => [participant.label, participant.providerLabel]),
    ]);
    const resolution = runWithMeetingOwnerPrincipal(meeting, () =>
      resolveSpeechRecognitionHints({
        participants: meeting.participants,
        contextTerms: [meeting.title],
      }),
    ).catch((error) => {
      log.warn("meeting recognition vocabulary resolution failed; using meeting-local hints", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    });
    meetingHints.set(sessionId, resolution);
    return resolution;
  };
  const liveConnections = new Set<{
    meetings: Map<string, MeetingSessionMeta>;
    streams: Map<string, ParticipantStream>;
    reconfigureStream: (stream: ParticipantStream, mode: MeetingAudioSourceMode) => Promise<void>;
    resetRecognition: (sessionId: string) => Promise<void>;
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

  // In-place recovery: the meeting Reset control asks a still-live bot to
  // re-arm speech recognition without leaving/rejoining. Mirrors the
  // owner-audience gating used for source-policy changes.
  const onRecognitionReset = (busEvent: BusEvent): void => {
    if (busEvent.event !== "meeting.recognition.reset") return;
    const sessionId = typeof busEvent.payload.sessionId === "string" ? busEvent.payload.sessionId : "";
    if (!sessionId) return;
    for (const connection of liveConnections) {
      const meeting = connection.meetings.get(sessionId);
      if (!meeting) continue;
      if (
        busEvent.audience.scope !== "user" ||
        busEvent.audience.ownerUserId !== meeting.ownerUserId ||
        busEvent.audience.accountId !== meeting.principalAccountId
      ) continue;
      void connection.resetRecognition(sessionId).catch((error) =>
        log.error("meeting recognition reset failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  eventBus.on("event", onRecognitionReset);

  wss.on("connection", (socket: WebSocket) => {
    const streams = new Map<string, ParticipantStream>();
    const streamInitializations = new Map<string, Promise<ParticipantStream>>();
    const meetings = new Map<string, MeetingSessionMeta>();
    const policyRefreshes = new Map<string, Promise<MeetingSessionMeta>>();
    const policyRefreshedAt = new Map<string, number>();
    // Reconnect budget + pending timers per participant stream (keyed by
    // streamMapKey), stable across in-place session rebuilds. The attempt count
    // resets whenever a stream reaches "active" so each independent drop over a
    // long meeting gets a fresh, bounded retry budget.
    const sttReconnectAttempts = new Map<string, number>();
    const sttReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
            isHost: identity.isHost,
          },
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
          channels: 1,
          hints: await recognitionHintsForMeeting(identity.sessionId, meeting),
          },
          async (utterance) => {
          if (utterance.isFinal && isCurrent(stream)) {
            await ingestFinalUtterance(deps.ingestMeetingEvent, identity.sessionId, utterance, diarized);
          }
          },
          (error) => void scheduleSttReconnect(stream, error.message),
        );
      })().then(async (stt) => {
        stream.stt = stt;
        stream.recognition = { ...stream.recognition, status: "active" };
        sttReconnectAttempts.delete(streamMapKey(identity.sessionId, identity.transportId));
        syncMeetingVisualizerBotStatus(identity.sessionId, "live");
        for (const packet of stream.pendingAudio) stt.sendAudio(packet);
        stream.pendingAudio = [];
        stream.pendingBytes = 0;
        await persistRecognition(identity.sessionId, meeting, streams);
        log.info(`meeting STT participant connected sessionId=${identity.sessionId} participantId=${identity.transportId} provider=${provider.provider} model=${provider.model} attribution=${recognition.attribution}`);
      }).catch((error) => scheduleSttReconnect(stream, error instanceof Error ? error.message : String(error)));
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
      // A deliberate mode change supersedes any in-flight reconnect for this
      // stream. Cancel the pending timer and reset the budget so the fresh
      // session starts clean.
      const pendingReconnect = sttReconnectTimers.get(mapKey);
      if (pendingReconnect) {
        clearTimeout(pendingReconnect);
        sttReconnectTimers.delete(mapKey);
      }
      sttReconnectAttempts.delete(mapKey);
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

    // Rebuild a dropped participant STT session in place, preserving the map
    // slot, stream identity, and any audio buffered during the outage so speech
    // is replayed in order once the provider reconnects.
    const reconnectStreamNow = async (
      previous: ParticipantStream,
      mapKey: string,
    ): Promise<void> => {
      sttReconnectTimers.delete(mapKey);
      if (
        closed ||
        streams.get(mapKey) !== previous ||
        ["closed", "excluded"].includes(previous.recognition.status)
      ) {
        return;
      }
      let meeting: MeetingSessionMeta;
      try {
        meeting = await loadMeeting(previous.identity.sessionId);
      } catch (error) {
        await failStream(
          previous,
          `meeting unavailable during STT reconnect: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      // Re-check after the async gap: a lifecycle terminal or stream swap may
      // have superseded this reconnect.
      if (closed || streams.get(mapKey) !== previous) return;
      const mode = meeting.audioSourcePolicies?.[previous.identity.streamId]?.mode
        || previous.recognition.sourcePolicy;
      const route = routeStream(mode, previous.identity, {
        scribe: scribeProvider,
        deepgram: deepgramProvider,
      });
      if (route.kind === "excluded") {
        streams.set(mapKey, excludeStream(previous.identity, route.detail));
        await persistRecognition(previous.identity.sessionId, meeting, streams).catch((error) =>
          log.error(`failed to persist excluded recognition during reconnect sessionId=${previous.identity.sessionId}: ${error instanceof Error ? error.message : String(error)}`),
        );
        return;
      }
      const replacement = connectStream(
        previous.identity,
        meeting,
        route,
        (candidate) => streams.get(mapKey) === candidate,
      );
      // Carry buffered audio forward (shared array reference) so speech during
      // the outage is flushed in order when the replacement connects.
      replacement.pendingAudio = previous.pendingAudio;
      replacement.pendingBytes = previous.pendingBytes;
      streams.set(mapKey, replacement);
      await persistRecognition(previous.identity.sessionId, meeting, streams).catch((error) =>
        log.error(`failed to persist reconnecting recognition state sessionId=${previous.identity.sessionId}: ${error instanceof Error ? error.message : String(error)}`),
      );
      log.info(`meeting STT reconnecting sessionId=${previous.identity.sessionId} participantId=${previous.identity.transportId} stream=${previous.identity.streamId} mode=${mode}`);
    };

    // Bounded, replay-safe recovery for a provider drop or connect failure.
    // A terminal meeting lifecycle is a clean stop, not a fault to retry. Once
    // the bounded budget is exhausted the stream is marked failed via the
    // canonical failStream boundary.
    const scheduleSttReconnect = async (
      stream: ParticipantStream,
      detail: string,
    ): Promise<void> => {
      const mapKey = streamMapKey(stream.identity.sessionId, stream.identity.transportId);
      if (
        closed ||
        streams.get(mapKey) !== stream ||
        ["closed", "excluded"].includes(stream.recognition.status)
      ) {
        log.debug(
          `ignored meeting STT reconnect after stream close sessionId=${stream.identity.sessionId} stream=${stream.identity.streamId} detail=${detail}`,
        );
        return;
      }
      const meeting = meetings.get(stream.identity.sessionId);
      if (meeting) {
        const currentMeeting = await runWithMeetingOwnerPrincipal(
          meeting,
          () => chatStorage.getSession(stream.identity.sessionId),
        )
          .then((session) => session?.meeting)
          .catch(() => undefined);
        if (
          currentMeeting &&
          ["leaving", "ended", "denied", "failed"].includes(currentMeeting.botStatus)
        ) {
          await failStream(stream, detail);
          return;
        }
      }
      if (isConfigurationError(detail)) {
        await failStream(stream, detail);
        return;
      }
      const attempts = (sttReconnectAttempts.get(mapKey) ?? 0) + 1;
      if (attempts > STT_RECONNECT_MAX_ATTEMPTS) {
        sttReconnectAttempts.delete(mapKey);
        log.error(
          `meeting STT reconnect exhausted sessionId=${stream.identity.sessionId} stream=${stream.identity.streamId} attempts=${STT_RECONNECT_MAX_ATTEMPTS} detail=${detail}`,
        );
        await failStream(
          stream,
          `${detail} (recognition reconnect exhausted after ${STT_RECONNECT_MAX_ATTEMPTS} attempts)`,
        );
        return;
      }
      sttReconnectAttempts.set(mapKey, attempts);
      // Tear down the dead provider session and enter a visible recovering
      // state. Incoming audio buffers via the connecting-status branch in the
      // socket message handler until the replacement connects.
      stream.stt?.close();
      stream.stt = undefined;
      stream.recognition = {
        ...stream.recognition,
        status: "connecting",
        detail: `Reconnecting speech recognition after provider drop (attempt ${attempts}/${STT_RECONNECT_MAX_ATTEMPTS}): ${detail}`.slice(0, 500),
      };
      if (meeting) {
        await persistRecognition(stream.identity.sessionId, meeting, streams).catch((error) =>
          log.error(`failed to persist reconnecting recognition state sessionId=${stream.identity.sessionId}: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      const delay = Math.min(
        STT_RECONNECT_MAX_DELAY_MS,
        STT_RECONNECT_BASE_DELAY_MS * 2 ** (attempts - 1),
      );
      log.warn(
        `meeting STT reconnect scheduled sessionId=${stream.identity.sessionId} stream=${stream.identity.streamId} attempt=${attempts}/${STT_RECONNECT_MAX_ATTEMPTS} delayMs=${delay} detail=${detail}`,
      );
      const existingTimer = sttReconnectTimers.get(mapKey);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        void reconnectStreamNow(stream, mapKey);
      }, delay);
      timer.unref?.();
      sttReconnectTimers.set(mapKey, timer);
    };

    // Force an immediate, budget-resetting rebuild of every live recognition
    // stream for one meeting. The in-place recovery path for the meeting Reset
    // control: used when the bot is still in the call but recognition is wedged
    // (e.g. reconnect budget exhausted). Buffered audio and stream identity are
    // preserved by reconnectStreamNow.
    const resetRecognition = async (sessionId: string): Promise<void> => {
      for (const [mapKey, stream] of streams) {
        if (stream.identity.sessionId !== sessionId) continue;
        if (["excluded", "closed"].includes(stream.recognition.status)) continue;
        const timer = sttReconnectTimers.get(mapKey);
        if (timer) {
          clearTimeout(timer);
          sttReconnectTimers.delete(mapKey);
        }
        sttReconnectAttempts.delete(mapKey);
        await reconnectStreamNow(stream, mapKey).catch((error) =>
          log.error(
            `meeting recognition reset rebuild failed sessionId=${sessionId} stream=${stream.identity.streamId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };

    const connection = { meetings, streams, reconfigureStream, resetRecognition };
    liveConnections.add(connection);

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
        isHost: participant?.is_host === true,
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
      for (const timer of sttReconnectTimers.values()) clearTimeout(timer);
      sttReconnectTimers.clear();
      sttReconnectAttempts.clear();
      for (const stream of streams.values()) {
        if (stream.recognition.status !== "excluded") {
          stream.recognition = { ...stream.recognition, status: "closed", detail: undefined };
        }
        stream.stt?.close();
      }
      liveConnections.delete(connection);
      for (const sessionId of meetings.keys()) meetingHints.delete(sessionId);
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

/**
 * Map a recognition launch plan to the meeting-meta recognition/STT fields.
 * Single source of truth for how a launch decision is written to meeting
 * state, shared by initial join and reset/rejoin so both start recognition
 * from an identical, waiting-for-audio baseline.
 */
export function meetingRecognitionLaunchMeta(
  launch: MeetingRecognitionLaunchPlan,
): Pick<
  MeetingSessionMeta,
  | "recognition"
  | "sttProvider"
  | "sttModel"
  | "sttSource"
  | "sttFallback"
  | "sttStatus"
  | "sttStatusDetail"
> {
  return {
    recognition: {
      mode: launch.mode,
      status: launch.recognitionStatus,
      reasonCode: launch.reasonCode,
      detail: launch.detail,
      streams: [] as MeetingRecognitionStream[],
    },
    sttProvider: launch.provider,
    sttModel: launch.model,
    sttSource: launch.source,
    sttFallback: launch.fallback,
    sttStatus: launch.sttStatus,
    sttStatusDetail: launch.detail,
  };
}

/** Canonical readiness and launch decision for meeting recognition. */
export function createMeetingRecognitionLaunchPlan(
  policy?: MeetingSpeakerPolicy,
): MeetingRecognitionLaunchPlan {
  const mode = meetingDefaultAudioSourceMode(policy);
  const capabilities = meetingRecognitionCapabilities();
  const requested = mode === "shared_room"
    ? capabilities.sharedRoom
    : capabilities.participantStreams;
  const participantFallback = mode === "shared_room" && capabilities.participantStreams.available
    ? capabilities.participantStreams
    : null;

  if (requested.available || participantFallback) {
    return {
      outcome: "participant_audio",
      mode: requested.available ? mode : "participant_streams",
      provider: requested.available ? requested.provider : participantFallback!.provider,
      model: requested.available ? requested.model : participantFallback!.model,
      source: "recall_participant_audio",
      fallback: !requested.available,
      sttStatus: requested.available ? "inactive" : "fallback",
      recognitionStatus: requested.available ? "waiting" : "degraded",
      reasonCode: requested.available
        ? "participant_audio_ready"
        : "shared_room_recognition_unavailable",
      detail: requested.available
        ? `Waiting for Recall participant audio for ${mode === "shared_room" ? "shared-room" : "participant"} recognition`
        : `${unavailableMeetingRecognitionDetail(mode)} Starting in Individual mode so transcription remains active.`,
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
    reasonCode: sharedRoom
      ? "shared_room_recognition_unavailable"
      : "participant_recognition_unavailable",
    detail: sharedRoom
      ? `${unavailableMeetingRecognitionDetail("shared_room")} Transcript capture continues through Recall, but people sharing one microphone will not be separated.`
      : "Participant-audio recognition is unavailable because ElevenLabs Scribe Realtime is not configured. Transcript capture continues through Recall.",
  };
}
