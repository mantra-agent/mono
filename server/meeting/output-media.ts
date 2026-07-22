import crypto from "crypto";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { finished } from "node:stream/promises";
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

export async function nextMeetingAudio(sessionId: string): Promise<VoiceAudioStream | null> {
  const queue = audioQueues.get(sessionId);
  const audio = queue?.shift();
  if (audio) return audio;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: VoiceAudioStream | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const current = waiters.get(sessionId) ?? [];
      const index = current.indexOf(finish);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) waiters.delete(sessionId);
      resolve(value);
    };
    const list = waiters.get(sessionId) ?? [];
    list.push(finish);
    waiters.set(sessionId, list);
    const timer = setTimeout(() => finish(null), 25_000);
    timer.unref?.();
  });
}

export async function speakMeetingResponse(sessionId: string, text: string): Promise<void> {
  const prior = speechLocks.get(sessionId) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(async () => {
    let speechFailed = false;
    const session = await chatStorage.getSession(sessionId);
    if (!session?.meeting || session.meeting.botStatus !== "live") throw new Error("Meeting bot is not live");
    setMeetingVisualizerState(sessionId, "speech", "speaking");
    await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "speaking" });
    try {
      const maxAttempts = 2;
      let spokenVia = "";
      for (let attempt = 1; ; attempt++) {
        const audio = await streamVoiceAudio(text);
        enqueue(sessionId, audio);
        log.info(`queued speech stream sessionId=${sessionId} provider=${audio.provider} attempt=${attempt}`);
        try {
          await finished(audio.stream);
          spokenVia = audio.provider;
          break;
        } catch (error) {
          if (error instanceof EmptyVoiceStreamError && attempt < maxAttempts) {
            log.warn(`empty speech stream, retrying sessionId=${sessionId} attempt=${attempt}`);
            continue;
          }
          throw error;
        }
      }
      await chatStorage.updateMeetingMeta(sessionId, {
        speechStatus: "spoken",
        speechStatusDetail: `Spoken via ${spokenVia}`,
      });
      log.info(`completed speech stream sessionId=${sessionId} provider=${spokenVia}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "failed", speechStatusDetail: detail });
      speechFailed = true;
      setMeetingVisualizerState(sessionId, "speech", "degraded");
      log.error(`speech failed sessionId=${sessionId}: ${detail}`);
      throw error;
    } finally {
      if (!speechFailed) clearMeetingVisualizerState(sessionId, "speech");
    }
  });
  speechLocks.set(sessionId, current);
  try {
    await current;
  } finally {
    if (speechLocks.get(sessionId) === current) speechLocks.delete(sessionId);
  }
}
