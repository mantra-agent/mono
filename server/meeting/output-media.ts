import crypto from "crypto";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { finished, pipeline } from "node:stream/promises";
import type { Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentVisualizerEvent, AgentVisualState } from "@shared/agent-visualizer";
import type { MeetingBotStatus } from "@shared/models/chat";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { resolveMeetingTransportSession } from "./owner-principal";
import { EmptyVoiceStreamError, streamVoiceAudio, type VoiceAudioStream, type VoiceSynthesisCorrelation } from "../voice/synthesis";

const log = createLogger("MeetingOutputMedia");
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const AUDIO_FRAME_INTERVAL_MS = 1000 / 15;
interface MeetingAudioClip {
  audio: VoiceAudioStream;
  caption: string;
  correlation?: MeetingSpeechCorrelation;
}

interface MeetingSpeechCorrelation extends VoiceSynthesisCorrelation {
  requestedAt: number;
}

const audioQueues = new Map<string, MeetingAudioClip[]>();
const waiters = new Map<string, Array<(audio: MeetingAudioClip | null) => void>>();
const speechLocks = new Map<string, Promise<void>>();
const visualizerCaptionTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
// Spoken-word pacing for advancing sentence captions. Kept slower than a raw
// reading rate and floored per sentence so each phrase lingers long enough to
// read and does not race ahead of the actual synthesized speech.
const CAPTION_WORDS_PER_MINUTE = 115;
const CAPTION_MIN_SENTENCE_HOLD_MS = 1_800;
const CAPTION_SENTENCE_READ_PADDING_MS = 400;

function splitCaptionSentences(text: string): string[] {
  return text.trim().match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function clearScheduledVisualizerCaptions(sessionId: string): void {
  const timers = visualizerCaptionTimers.get(sessionId);
  if (!timers) return;
  timers.forEach((timer) => clearTimeout(timer));
  visualizerCaptionTimers.delete(sessionId);
}
// Per-session barge-in state. The active speech turn registers its abort
// controller and every synthesized stream it owns (queued or currently piping)
// so a user speaking can preempt in-flight agent audio immediately.
const speechAbortControllers = new Map<string, AbortController>();
const liveSpeechStreams = new Map<string, Set<VoiceAudioStream>>();

/**
 * Raised when meeting speech is preempted by user barge-in. Distinguished from
 * synthesis faults so the speech loop treats interruption as a clean stop
 * rather than a failure that degrades the visualizer or logs an error.
 */
export class MeetingSpeechInterruptedError extends Error {
  override name = "MeetingSpeechInterruptedError";
}

function trackSpeechStream(sessionId: string, audio: VoiceAudioStream): void {
  const set = liveSpeechStreams.get(sessionId) ?? new Set<VoiceAudioStream>();
  set.add(audio);
  liveSpeechStreams.set(sessionId, set);
}

function untrackSpeechStream(sessionId: string, audio: VoiceAudioStream): void {
  const set = liveSpeechStreams.get(sessionId);
  if (!set) return;
  set.delete(audio);
  if (set.size === 0) liveSpeechStreams.delete(sessionId);
}

/**
 * Barge-in primitive: preempt any queued or currently-playing agent speech for
 * a meeting session. Aborts the active speech turn (stopping retries), drops
 * queued-but-unplayed audio so a waiting poll cannot start it, and tears down
 * the stream currently piping to the transport so playback stops mid-utterance.
 * Idempotent and cheap: a no-op when the agent is not speaking. Returns whether
 * any in-flight speech was actually interrupted.
 */
export function interruptMeetingSpeech(sessionId: string, reason = "user_speech"): boolean {
  const controller = speechAbortControllers.get(sessionId);
  const queued = audioQueues.get(sessionId);
  const live = liveSpeechStreams.get(sessionId);
  const hadSpeech =
    Boolean(controller && !controller.signal.aborted) ||
    (queued?.length ?? 0) > 0 ||
    (live?.size ?? 0) > 0;
  if (!hadSpeech) return false;

  const interruption = new MeetingSpeechInterruptedError(`Meeting speech interrupted: ${reason}`);
  if (controller && !controller.signal.aborted) controller.abort(interruption);
  if (queued) {
    for (const clip of queued) clip.audio.stream.destroy(interruption);
    audioQueues.delete(sessionId);
  }
  if (live) {
    for (const audio of live) audio.stream.destroy(interruption);
  }
  clearMeetingVisualizerState(sessionId, "speech");
  clearMeetingVisualizerCaption(sessionId);
  log.info(`meeting speech interrupted sessionId=${sessionId} reason=${reason}`);
  return true;
}

/**
 * Whether the agent currently owns active or queued meeting speech for a
 * session. Cheap process-local check over the same barge-in state
 * interruptMeetingSpeech acts on. Used to gate speech-onset detection so a
 * human talking while the agent is silent is treated as ordinary input, not an
 * interruption.
 */
function isMeetingSpeaking(sessionId: string): boolean {
  const controller = speechAbortControllers.get(sessionId);
  if (controller && !controller.signal.aborted) return true;
  if ((audioQueues.get(sessionId)?.length ?? 0) > 0) return true;
  if ((liveSpeechStreams.get(sessionId)?.size ?? 0) > 0) return true;
  return false;
}

// Speech-onset barge-in. The transcript-bound interrupt call fires only after a
// full diarized segment is ingested — seconds late, and silent during the exact
// overlap where a speaker talks over the agent. This detector runs on the same
// per-frame participant energy already computed for the visualizer, so it can
// preempt agent speech the moment a human starts talking. The bot's own output
// never reaches this path (its stream returns as "excluded" upstream before
// energy is measured), so the agent cannot interrupt itself. Threshold and
// sustain are the sensitivity knobs: sustain rejects transient clicks, and the
// gap reset stops interleaved silent frames from other participants from
// breaking an in-progress onset.
const MEETING_BARGE_IN_ENERGY_THRESHOLD = 0.15;
const MEETING_BARGE_IN_SUSTAIN_MS = 150;
const MEETING_BARGE_IN_GAP_RESET_MS = 400;
const speechOnsetState = new Map<string, { onsetStartedAt: number; lastLoudAt: number }>();

/**
 * Feed one participant audio frame's RMS energy into speech-onset barge-in.
 * A no-op unless the agent is currently speaking. Fires interruptMeetingSpeech
 * once sustained human energy proves the speaker is talking over the agent;
 * idempotency in interruptMeetingSpeech makes repeat frames cheap no-ops.
 */
export function observeMeetingParticipantSpeechEnergy(sessionId: string, energy: number): void {
  if (!isMeetingSpeaking(sessionId)) {
    speechOnsetState.delete(sessionId);
    return;
  }
  if (energy < MEETING_BARGE_IN_ENERGY_THRESHOLD) return;
  const now = Date.now();
  const state = speechOnsetState.get(sessionId);
  if (!state || now - state.lastLoudAt > MEETING_BARGE_IN_GAP_RESET_MS) {
    speechOnsetState.set(sessionId, { onsetStartedAt: now, lastLoudAt: now });
    return;
  }
  state.lastLoudAt = now;
  if (now - state.onsetStartedAt >= MEETING_BARGE_IN_SUSTAIN_MS) {
    speechOnsetState.delete(sessionId);
    interruptMeetingSpeech(sessionId, "meeting_participant_vad");
  }
}

/** Clear per-session speech-onset state when a meeting audio connection ends. */
export function resetMeetingSpeechDetection(sessionId: string): void {
  speechOnsetState.delete(sessionId);
}

const visualizerClients = new Map<string, Set<WebSocket>>();
const visualizerSignals = new Map<string, Map<VisualizerStateSource, AgentVisualState>>();
const visualizerStates = new Map<string, AgentVisualState>();
const visualizerCaptions = new Map<string, string>();
const lastAudioFrameAt = new Map<string, number>();
let visualizerSequence = 0;

type VisualizerStateSource = "lifecycle" | "turn" | "tool" | "speech";

const STATE_PRIORITY: Record<AgentVisualState, number> = {
  idle: 0,
  listening: 10,
  thinking: 20,
  tool_call: 30,
  speaking: 40,
  degraded: 50,
};

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for meeting output media");
  return secret;
}

function payload(sessionId: string, expiresAt: number) {
  return `${sessionId}.${expiresAt}`;
}

function signature(sessionId: string, expiresAt: number) {
  return crypto.createHmac("sha256", signingSecret()).update(payload(sessionId, expiresAt)).digest("base64url");
}

export function createOutputMediaToken(sessionId: string, expiresAt = Date.now() + TOKEN_TTL_MS): string {
  return Buffer.from(JSON.stringify({ sessionId, expiresAt, signature: signature(sessionId, expiresAt) })).toString("base64url");
}

export function verifyOutputMediaToken(token: string): { sessionId: string } | null {
  try {
    const data = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      sessionId?: string;
      expiresAt?: number;
      signature?: string;
    };
    if (!data.sessionId || !data.expiresAt || !data.signature || data.expiresAt < Date.now()) return null;
    const expected = signature(data.sessionId, data.expiresAt);
    const a = Buffer.from(data.signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? { sessionId: data.sessionId } : null;
  } catch {
    return null;
  }
}

export function outputMediaPageUrl(publicUrl: string, sessionId: string): string {
  const token = encodeURIComponent(createOutputMediaToken(sessionId));
  return `${publicUrl}/visualizer?token=${token}`;
}

export function outputMediaSession(token: string): string | null {
  return verifyOutputMediaToken(token)?.sessionId ?? null;
}

function broadcastVisualizerEvent(sessionId: string, event: AgentVisualizerEvent): void {
  const encoded = JSON.stringify(event);
  for (const client of visualizerClients.get(sessionId) ?? []) {
    if (client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

function nextVisualizerEvent(
  event: Omit<AgentVisualizerEvent, "sequence" | "occurredAt">,
): AgentVisualizerEvent {
  return {
    ...event,
    sequence: ++visualizerSequence,
    occurredAt: Date.now(),
  } as AgentVisualizerEvent;
}

function resolvedVisualizerState(sessionId: string): AgentVisualState {
  const signals = visualizerSignals.get(sessionId);
  if (!signals || signals.size === 0) return "idle";
  return Array.from(signals.values()).reduce<AgentVisualState>(
    (highest, state) => STATE_PRIORITY[state] > STATE_PRIORITY[highest] ? state : highest,
    "idle",
  );
}

function publishResolvedVisualizerState(sessionId: string): void {
  const state = resolvedVisualizerState(sessionId);
  if (visualizerStates.get(sessionId) === state) return;
  visualizerStates.set(sessionId, state);
  broadcastVisualizerEvent(sessionId, nextVisualizerEvent({ type: "agent.state", state }));
  log.debug(`visualizer state sessionId=${sessionId} state=${state}`);
}

export function setMeetingVisualizerState(
  sessionId: string,
  source: VisualizerStateSource,
  state: AgentVisualState,
): void {
  const signals = visualizerSignals.get(sessionId) ?? new Map<VisualizerStateSource, AgentVisualState>();
  signals.set(source, state);
  visualizerSignals.set(sessionId, signals);
  publishResolvedVisualizerState(sessionId);
}

export function clearMeetingVisualizerState(sessionId: string, source: VisualizerStateSource): void {
  const signals = visualizerSignals.get(sessionId);
  if (!signals) return;
  signals.delete(source);
  if (signals.size === 0) visualizerSignals.delete(sessionId);
  publishResolvedVisualizerState(sessionId);
}

/**
 * Project the currently audible agent phrase onto the outbound bot tile. The
 * caption rides the same visualizer socket as orb state so the tile every
 * meeting participant sees is captioned, without touching the audio path or
 * depending on any per-user preference (the tile has no authenticated user).
 */
export function setMeetingVisualizerCaption(sessionId: string, caption: string): void {
  const text = caption.trim();
  clearScheduledVisualizerCaptions(sessionId);
  if (!text) {
    clearMeetingVisualizerCaption(sessionId);
    return;
  }

  const sentences = splitCaptionSentences(text);
  let elapsedMs = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  sentences.forEach((sentence, index) => {
    if (index > 0) {
      const previousSentence = sentences[index - 1] ?? "";
      const spokenMs = (previousSentence.split(/\s+/).length / CAPTION_WORDS_PER_MINUTE) * 60_000;
      elapsedMs += Math.max(CAPTION_MIN_SENTENCE_HOLD_MS, spokenMs) + CAPTION_SENTENCE_READ_PADDING_MS;
    }
    const timer = setTimeout(() => {
      if (index === sentences.length - 1) visualizerCaptionTimers.delete(sessionId);
      if (visualizerCaptions.get(sessionId) === sentence) return;
      visualizerCaptions.set(sessionId, sentence);
      broadcastVisualizerEvent(sessionId, nextVisualizerEvent({ type: "agent.caption", caption: sentence }));
    }, elapsedMs);
    timers.push(timer);
  });
  visualizerCaptionTimers.set(sessionId, timers);
}

export function clearMeetingVisualizerCaption(sessionId: string): void {
  clearScheduledVisualizerCaptions(sessionId);
  if (!visualizerCaptions.has(sessionId)) return;
  visualizerCaptions.delete(sessionId);
  broadcastVisualizerEvent(sessionId, nextVisualizerEvent({ type: "agent.caption", caption: "" }));
}

export function syncMeetingVisualizerBotStatus(sessionId: string, status: MeetingBotStatus): void {
  if (status === "live") {
    setMeetingVisualizerState(sessionId, "lifecycle", "listening");
    return;
  }
  if (status === "failed" || status === "denied" || status === "ended") {
    setMeetingVisualizerState(sessionId, "lifecycle", "degraded");
    return;
  }
  setMeetingVisualizerState(sessionId, "lifecycle", "idle");
}

export function publishMeetingAudioLevel(sessionId: string, rawLevel: number): void {
  const now = Date.now();
  if (now - (lastAudioFrameAt.get(sessionId) ?? 0) < AUDIO_FRAME_INTERVAL_MS) return;
  lastAudioFrameAt.set(sessionId, now);
  const level = Math.max(0, Math.min(1, rawLevel));
  broadcastVisualizerEvent(sessionId, nextVisualizerEvent({ type: "audio.level", level }));
}

export function registerMeetingVisualizerTransport(): (
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (client: WebSocket, request: IncomingMessage) => {
    const query = new URL(request.url || "", "http://localhost").searchParams;
    const sessionId = outputMediaSession(query.get("token") || "");
    if (!sessionId) {
      client.close(1008, "invalid token");
      return;
    }
    const clients = visualizerClients.get(sessionId) ?? new Set<WebSocket>();
    clients.add(client);
    visualizerClients.set(sessionId, clients);
    log.info(`visualizer socket connected sessionId=${sessionId} clients=${clients.size}`);
    if (!visualizerStates.has(sessionId)) {
      void resolveMeetingTransportSession(sessionId).then((session) => {
        if (!session?.meeting) {
          client.close(1008, "meeting not found");
          return;
        }
        syncMeetingVisualizerBotStatus(sessionId, session.meeting.botStatus);
      }).catch((error) => {
        log.warn(`visualizer session hydrate failed sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        setMeetingVisualizerState(sessionId, "lifecycle", "degraded");
      });
    }
    const state = visualizerStates.get(sessionId) ?? resolvedVisualizerState(sessionId);
    client.send(JSON.stringify(nextVisualizerEvent({ type: "agent.state", state })));
    const caption = visualizerCaptions.get(sessionId);
    if (caption) client.send(JSON.stringify(nextVisualizerEvent({ type: "agent.caption", caption })));
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) {
        log.warn(`visualizer socket keepalive expired sessionId=${sessionId}`);
        client.terminate();
        return;
      }
      awaitingPong = true;
      client.ping();
    }, 25_000);
    heartbeat.unref?.();
    client.on("pong", () => {
      awaitingPong = false;
    });
    client.on("error", (error) => {
      log.warn(`visualizer socket error sessionId=${sessionId}: ${error.message}`);
    });
    client.on("close", (code, reason) => {
      clearInterval(heartbeat);
      clients.delete(client);
      if (clients.size === 0) visualizerClients.delete(sessionId);
      log.info(`visualizer socket closed sessionId=${sessionId} code=${code} reason=${reason.toString() || "none"} clients=${clients.size}`);
    });
  });

  return (request, socket, head) => {
    const query = new URL(request.url || "", "http://localhost").searchParams;
    const sessionId = outputMediaSession(query.get("token") || "");
    if (!sessionId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  };
}

function enqueue(
  sessionId: string,
  audio: VoiceAudioStream,
  caption: string,
  correlation?: MeetingSpeechCorrelation,
) {
  const clip = { audio, caption, correlation };
  const waiter = waiters.get(sessionId)?.shift();
  if (waiter) {
    waiter(clip);
    return;
  }
  const queue = audioQueues.get(sessionId) ?? [];
  queue.push(clip);
  if (queue.length > 3) {
    queue.shift()?.audio.stream.destroy(new Error("Meeting audio queue overflow"));
    log.warn(`dropped oldest speech stream sessionId=${sessionId} queueLimit=3`);
  }
  audioQueues.set(sessionId, queue);
}

export async function nextMeetingAudio(
  sessionId: string,
  signal?: AbortSignal,
): Promise<MeetingAudioClip | null> {
  const queue = audioQueues.get(sessionId);
  const audio = queue?.shift();
  if (audio) return audio;
  if (signal?.aborted) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: MeetingAudioClip | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const current = waiters.get(sessionId) ?? [];
      const index = current.indexOf(finish);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) waiters.delete(sessionId);
      resolve(value);
    };
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    const list = waiters.get(sessionId) ?? [];
    list.push(finish);
    waiters.set(sessionId, list);
    const timer = setTimeout(() => finish(null), 25_000);
    timer.unref?.();
  });
}

export async function sendNextMeetingAudio(
  sessionId: string,
  res: Response,
  signal?: AbortSignal,
): Promise<void> {
  const clip = await nextMeetingAudio(sessionId, signal);
  res.setHeader("Cache-Control", "no-store");
  if (!clip) {
    res.setHeader("X-Meeting-Audio-State", "idle");
    res.status(204).end();
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", clip.audio.contentType);
  res.setHeader("Accept-Ranges", "none");
  const encodedCaption = Buffer.from(clip.caption, "utf8").toString("base64url");
  if (encodedCaption.length <= 6_000) res.setHeader("X-Meeting-Caption", encodedCaption);
  clip.audio.stream.once("data", () => {
    log.info(
      `first meeting transport byte sessionId=${sessionId} runId=${clip.correlation?.runId || "none"} turnId=${clip.correlation?.turnId || "none"} assistantMessageId=${clip.correlation?.assistantMessageId || "none"} speechRequestLatencyMs=${clip.correlation ? Date.now() - clip.correlation.requestedAt : "unknown"}`,
    );
  });
  await pipeline(clip.audio.stream, res);
}

export async function speakMeetingResponse(
  sessionId: string,
  text: string,
  correlation?: MeetingSpeechCorrelation,
): Promise<void> {
  const prior = speechLocks.get(sessionId) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(async () => {
    const session = await chatStorage.getSession(sessionId);
    if (!session?.meeting || session.meeting.botStatus !== "live") throw new Error("Meeting bot is not live");

    // One interruption controller per speech turn. User barge-in aborts it,
    // which stops synthesis retries and lets the loop unwind as a clean stop.
    const abort = new AbortController();
    speechAbortControllers.set(sessionId, abort);
    let outcome: "spoken" | "interrupted" | "failed" = "failed";
    setMeetingVisualizerState(sessionId, "speech", "speaking");
    setMeetingVisualizerCaption(sessionId, text);
    await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "speaking" });
    try {
      const maxAttempts = 2;
      let spokenVia = "";
      for (let attempt = 1; ; attempt++) {
        if (abort.signal.aborted) throw new MeetingSpeechInterruptedError("Meeting speech interrupted before synthesis");
        const audio = await streamVoiceAudio(text, correlation);
        if (abort.signal.aborted) {
          audio.stream.destroy();
          throw new MeetingSpeechInterruptedError("Meeting speech interrupted before playback");
        }
        trackSpeechStream(sessionId, audio);
        enqueue(sessionId, audio, text, correlation);
        log.info(`queued speech stream sessionId=${sessionId} provider=${audio.provider} attempt=${attempt} runId=${correlation?.runId || "none"} turnId=${correlation?.turnId || "none"} assistantMessageId=${correlation?.assistantMessageId || "none"} speechRequestLatencyMs=${correlation ? Date.now() - correlation.requestedAt : "unknown"}`);
        try {
          await finished(audio.stream);
          spokenVia = audio.provider;
          break;
        } catch (error) {
          if (abort.signal.aborted) {
            throw new MeetingSpeechInterruptedError("Meeting speech interrupted during playback");
          }
          if (error instanceof EmptyVoiceStreamError && attempt < maxAttempts) {
            log.warn(`empty speech stream, retrying sessionId=${sessionId} attempt=${attempt}`);
            continue;
          }
          throw error;
        } finally {
          untrackSpeechStream(sessionId, audio);
        }
      }
      outcome = "spoken";
      await chatStorage.updateMeetingMeta(sessionId, {
        speechStatus: "spoken",
        speechStatusDetail: `Spoken via ${spokenVia}`,
      });
      log.info(`completed speech stream sessionId=${sessionId} provider=${spokenVia}`);
    } catch (error) {
      if (error instanceof MeetingSpeechInterruptedError || abort.signal.aborted) {
        outcome = "interrupted";
        await chatStorage.updateMeetingMeta(sessionId, {
          speechStatus: "interrupted",
          speechStatusDetail: "Interrupted by speaker",
        });
        log.info(`speech interrupted sessionId=${sessionId}`);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "failed", speechStatusDetail: detail });
      setMeetingVisualizerState(sessionId, "speech", "degraded");
      log.error(`speech failed sessionId=${sessionId}: ${detail}`);
      throw error;
    } finally {
      if (speechAbortControllers.get(sessionId) === abort) speechAbortControllers.delete(sessionId);
      if (outcome !== "failed") clearMeetingVisualizerState(sessionId, "speech");
      clearMeetingVisualizerCaption(sessionId);
    }
  });
  speechLocks.set(sessionId, current);
  try {
    await current;
  } finally {
    if (speechLocks.get(sessionId) === current) speechLocks.delete(sessionId);
  }
}
