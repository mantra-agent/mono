import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import {
  speechRecognitionStreamCoordinator,
  type CoordinatedSpeechRecognitionStream,
  type ResolvedSpeechRecognitionBinding,
  type SpeechRecognitionCoordinatorState,
} from "../speech-recognition";
import { createLogger } from "../log";
import { chatStorage } from "../integrations/chat/storage";
import {
  DeepgramDiarizingSTTProvider,
  HIGH_QUALITY_SCRIBE_POLICY,
  ScribeRealtimeSTTProvider,
  type STTProvider,
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
import {
  observeMeetingParticipantSpeechEnergy,
  publishMeetingAudioLevel,
  resetMeetingSpeechDetection,
  syncMeetingVisualizerBotStatus,
} from "./output-media";
import {
  createSpeechRecognitionHints,
  resolveSpeechRecognitionHints,
  type SpeechRecognitionHints,
} from "../speech-recognition-hints";
import { getSecretSync } from "../secrets-store";

const log = createLogger("MeetingSTT");
const MAX_PARTICIPANT_STREAMS = 16;
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
  stt?: CoordinatedSpeechRecognitionStream;
  binding?: ResolvedSpeechRecognitionBinding;
}

export interface MeetingRecognitionCapabilities {
  participantStreams: { available: boolean; provider: string; model: string };
  sharedRoom: { available: boolean; provider: string; model: string };
}

export function meetingRecognitionCapabilities(): MeetingRecognitionCapabilities {
  const scribe = new ScribeRealtimeSTTProvider();
  const deepgram = new DeepgramDiarizingSTTProvider();
  // Same secret store as resolveLegacySpeechRecognitionBinding / STT adapters.
  // process.env alone misses managed secrets and falsely reports "not configured."
  return {
    participantStreams: {
      available: Boolean(getSecretSync("ELEVENLABS_API_KEY")?.trim()),
      provider: scribe.provider,
      model: scribe.model,
    },
    sharedRoom: {
      available: Boolean(getSecretSync("DEEPGRAM_API_KEY")?.trim()),
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
    (stream) => stream.status === "failed" || stream.status === "fallback" || stream.detail,
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
        : recognitionStreams.some((stream) => stream.status === "failed")
          ? { sttFallback: true }
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
    ? `recognition:${utterance.attemptId}:speaker:${utterance.providerSpeakerId || "unknown"}`
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
      recognition: {
        attemptId: utterance.attemptId,
        bindingId: utterance.bindingId,
        streamKey: utterance.streamId,
        adapterKind: utterance.adapterKind,
        provider: utterance.provider,
        model: utterance.model,
        configFingerprint: utterance.configFingerprint,
        providerSpeakerId: utterance.providerSpeakerId,
        source: "recall_participant_audio",
      },
    },
  });
  if (!result.ok) throw new Error(result.error);
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

    const coordinatorStateToRecognition = (
      identity: StreamIdentity,
      diarized: boolean,
      state: SpeechRecognitionCoordinatorState,
    ): MeetingRecognitionStream => ({
      streamKey: identity.streamId,
      transportParticipantId: identity.transportId,
      transportLabel: identity.label,
      sourcePolicy: diarized ? "shared_room" : "participant_streams",
      attribution: diarized ? "diarized" : "participant",
      bindingId: state.binding?.bindingId,
      adapterKind: state.binding?.adapterKind,
      attemptId: state.attemptId,
      configFingerprint: state.binding?.configFingerprint,
      provider: state.binding?.provider || (diarized ? "deepgram" : "scribe_realtime"),
      model: state.binding?.model || (diarized ? "nova-3" : "scribe_v2_realtime"),
      status: state.status === "reconnecting" ? "connecting" : state.status,
      ...(state.detail ? { detail: state.detail.slice(0, 500) } : {}),
    });

    const connectStream = (
      identity: StreamIdentity,
      meeting: MeetingSessionMeta,
      route: Extract<StreamRoute, { kind: "participant" | "diarized" }>,
      hints: SpeechRecognitionHints,
      isCurrent: (stream: ParticipantStream) => boolean = () => true,
    ): ParticipantStream => {
      const provider = route.provider;
      const diarized = route.kind === "diarized";
      const stream = {
        identity,
        recognition: coordinatorStateToRecognition(identity, diarized, { status: "connecting" }),
      } as ParticipantStream;
      stream.stt = speechRecognitionStreamCoordinator.open(
        {
          useCase: diarized ? "meeting_shared_room" : "meeting_participant_stream",
          adapterKinds: [provider.adapterKind],
          stream: {
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
            hints,
          },
        },
        {
          onState: (state) => {
            if (!isCurrent(stream) || closed) return;
            stream.binding = state.binding;
            stream.recognition = coordinatorStateToRecognition(identity, diarized, state);
            if (state.status === "active") syncMeetingVisualizerBotStatus(identity.sessionId, "live");
            void persistRecognition(identity.sessionId, meeting, streams).catch((error) =>
              log.error("meeting recognition state persistence failed", {
                sessionId: identity.sessionId,
                streamId: identity.streamId,
                status: state.status,
                errorType: error instanceof Error ? error.name : typeof error,
              }),
            );
          },
          onFailure: (failure) => {
            log.warn("meeting speech recognition failed", {
              sessionId: identity.sessionId,
              streamId: identity.streamId,
              kind: failure.kind,
              retryable: failure.retryable,
            });
          },
          onUtterance: async (utterance) => {
            if (isCurrent(stream)) {
              await ingestFinalUtterance(deps.ingestMeetingEvent, identity.sessionId, utterance, diarized);
            }
          },
        },
      );
      return stream;
    };

    const reconfigureStream = async (
      stream: ParticipantStream,
      mode: MeetingAudioSourceMode,
    ): Promise<void> => {
      const meeting = await loadMeeting(stream.identity.sessionId);
      if (stream.recognition.attribution === "excluded") return;
      if (stream.recognition.sourcePolicy === mode && ["connecting", "active"].includes(stream.recognition.status)) return;
      stream.stt?.abort("Meeting audio source reconfigured");
      const route = routeStream(mode, stream.identity, {
        scribe: scribeProvider,
        deepgram: deepgramProvider,
      });
      if (route.kind === "excluded") return;
      const mapKey = streamMapKey(stream.identity.sessionId, stream.identity.transportId);
      const hints = await recognitionHintsForMeeting(stream.identity.sessionId, meeting);
      const replacement = connectStream(
        stream.identity,
        meeting,
        route,
        hints,
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
    });

    const resetRecognition = async (sessionId: string): Promise<void> => {
      for (const [mapKey, stream] of streams) {
        if (stream.identity.sessionId !== sessionId) continue;
        if (["excluded", "closed"].includes(stream.recognition.status)) continue;
        const meeting = await loadMeeting(sessionId);
        const mode = meeting.audioSourcePolicies?.[stream.identity.streamId]?.mode
          || stream.recognition.sourcePolicy;
        const route = routeStream(mode, stream.identity, {
          scribe: scribeProvider,
          deepgram: deepgramProvider,
        });
        if (route.kind === "excluded") continue;
        stream.stt?.abort("Meeting recognition reset");
        const hints = await recognitionHintsForMeeting(sessionId, meeting);
        const replacement = connectStream(
          stream.identity,
          meeting,
          route,
          hints,
          (candidate) => streams.get(mapKey) === candidate,
        );
        streams.set(mapKey, replacement);
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
      const mapKey = streamMapKey(sessionId, transportId);
      const stream = route.kind === "excluded"
        ? excludeStream(identity, route.detail)
        : connectStream(
            identity,
            meeting,
            route,
            await recognitionHintsForMeeting(sessionId, meeting),
            (candidate) => streams.get(mapKey) === candidate,
          );
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
        const participantEnergy = pcm16Rms(bytes);
        publishMeetingAudioLevel(sessionId, participantEnergy);
        // Same echo-free per-frame energy drives low-latency speech-onset
        // barge-in: a human talking over the agent preempts TTS immediately,
        // instead of waiting for a full transcribed segment to be ingested.
        observeMeetingParticipantSpeechEnergy(sessionId, participantEnergy);
        const writeOutcome = stream.stt?.tryWriteAudio(bytes) || "closed";
        if (writeOutcome === "closed") {
          log.warn("meeting recognition rejected live audio", {
            sessionId,
            streamId: stream.identity.streamId,
            status: stream.recognition.status,
          });
        }
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
        void stream.stt?.finish().then((result) => {
          if (result.outcome === "timed_out") {
            log.warn("meeting recognition finish timed out", {
              sessionId: stream.identity.sessionId,
              attemptId: stream.recognition.attemptId,
            });
          }
        });
      }
      liveConnections.delete(connection);
      for (const sessionId of meetings.keys()) {
        meetingHints.delete(sessionId);
        resetMeetingSpeechDetection(sessionId);
      }
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
