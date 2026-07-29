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
import { EmptyVoiceStreamError, streamVoiceAudio, type VoiceAudioStream } from "../voice/synthesis";

const log = createLogger("MeetingOutputMedia");
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const AUDIO_FRAME_INTERVAL_MS = 1000 / 15;
const audioQueues = new Map<string, VoiceAudioStream[]>();
const waiters = new Map<string, Array<(audio: VoiceAudioStream | null) => void>>();
const speechLocks = new Map<string, Promise<void>>();
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
    for (const audio of queued) audio.stream.destroy(interruption);
    audioQueues.delete(sessionId);
  }
  if (live) {
    for (const audio of live) audio.stream.destroy(interruption);
  }
  bargeInState.delete(sessionId);
  // Destroying the server stream ends the HTTP response, but the visualizer
  // page's <audio> element keeps playing whatever it already buffered. Tell it
  // to stop now so barge-in is audible, not just structural.
  broadcastVisualizerEvent(sessionId, nextVisualizerEvent({ type: "speech.interrupt", reason }));
  clearMeetingVisualizerState(sessionId, "speech");
  log.info(`meeting speech interrupted sessionId=${sessionId} reason=${reason}`);
  return true;
}

// Low-latency barge-in trigger, driven by raw per-participant audio energy
// (pre-transcription, pre-echo-drop, pre-turn-classification). The prior design
// only fired off the STT/turn pipeline, which lands 5–10s late — after the
// speech stream has already completed — making barge-in a no-op. Onset detection
// here reacts within ~200ms of the user actually speaking over the agent.
const BARGE_IN_RMS_THRESHOLD = 0.18;
const BARGE_IN_ONSET_MS = 200;
const BARGE_IN_COOLDOWN_MS = 1200;
type BargeInState = { activeMs: number; lastInterruptAt: number };
const bargeInState = new Map<string, BargeInState>();

/**
 * Feed one participant audio frame's energy into barge-in onset detection. Cheap
 * no-op unless the agent is currently speaking, so it stays safe on the hot
 * per-frame ingest path. Sustained speech-level energy for BARGE_IN_ONSET_MS
 * preempts the agent's in-flight speech via the single interrupt primitive.
 * Semantically free: any speech onset interrupts, including "stop talking" that
 * the turn classifier marks shouldRespond=false.
 */
export function noteMeetingParticipantAudio(sessionId: string, rms: number, frameMs: number): void {
  const controller = speechAbortControllers.get(sessionId);
  const speaking =
    Boolean(controller && !controller.signal.aborted) ||
    (audioQueues.get(sessionId)?.length ?? 0) > 0 ||
    (liveSpeechStreams.get(sessionId)?.size ?? 0) > 0;
  if (!speaking) {
    if (bargeInState.has(sessionId)) bargeInState.delete(sessionId);
    return;
  }

  const state = bargeInState.get(sessionId) ?? { activeMs: 0, lastInterruptAt: 0 };
  if (rms < BARGE_IN_RMS_THRESHOLD) {
    state.activeMs = 0;
    bargeInState.set(sessionId, state);
    return;
  }
  state.activeMs += frameMs;
  const now = Date.now();
  if (state.activeMs >= BARGE_IN_ONSET_MS && now - state.lastInterruptAt >= BARGE_IN_COOLDOWN_MS) {
    state.lastInterruptAt = now;
    state.activeMs = 0;
    bargeInState.set(sessionId, state);
    if (interruptMeetingSpeech(sessionId, "participant_voice_activity")) {
      log.info(`meeting barge-in via voice activity sessionId=${sessionId} rms=${rms.toFixed(3)}`);
    }
    return;
  }
  bargeInState.set(sessionId, state);
}

const visualizerClients = new Map<string, Set<WebSocket>>();
const visualizerSignals = new Map<string, Map<VisualizerStateSource, AgentVisualState>>();
const visualizerStates = new Map<string, AgentVisualState>();
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

function enqueue(sessionId: string, audio: VoiceAudioStream) {
  const waiter = waiters.get(sessionId)?.shift();
  if (waiter) {
    waiter(audio);
    return;
  }
  const queue = audioQueues.get(sessionId) ?? [];
  queue.push(audio);
  if (queue.length > 3) {
    queue.shift()?.stream.destroy(new Error("Meeting audio queue overflow"));
    log.warn(`dropped oldest speech stream sessionId=${sessionId} queueLimit=3`);
  }
  audioQueues.set(sessionId, queue);
}

export async function nextMeetingAudio(
  sessionId: string,
  signal?: AbortSignal,
): Promise<VoiceAudioStream | null> {
  const queue = audioQueues.get(sessionId);
  const audio = queue?.shift();
  if (audio) return audio;
  if (signal?.aborted) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: VoiceAudioStream | null) => {
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
  const audio = await nextMeetingAudio(sessionId, signal);
  res.setHeader("Cache-Control", "no-store");
  if (!audio) {
    res.setHeader("X-Meeting-Audio-State", "idle");
    res.status(204).end();
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", audio.contentType);
  res.setHeader("Accept-Ranges", "none");
  await pipeline(audio.stream, res);
}

export async function speakMeetingResponse(sessionId: string, text: string): Promise<void> {
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
    await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "speaking" });
    try {
      const maxAttempts = 2;
      let spokenVia = "";
      for (let attempt = 1; ; attempt++) {
        if (abort.signal.aborted) throw new MeetingSpeechInterruptedError("Meeting speech interrupted before synthesis");
        const audio = await streamVoiceAudio(text);
        if (abort.signal.aborted) {
          audio.stream.destroy();
          throw new MeetingSpeechInterruptedError("Meeting speech interrupted before playback");
        }
        trackSpeechStream(sessionId, audio);
        enqueue(sessionId, audio);
        log.info(`queued speech stream sessionId=${sessionId} provider=${audio.provider} attempt=${attempt}`);
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
    }
  });
  speechLocks.set(sessionId, current);
  try {
    await current;
  } finally {
    if (speechLocks.get(sessionId) === current) speechLocks.delete(sessionId);
  }
}
