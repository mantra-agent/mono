import crypto from "crypto";
import { finished } from "node:stream/promises";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { streamVoiceAudio, type VoiceAudioStream } from "../voice/synthesis";

const log = createLogger("MeetingOutputMedia");
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const audioQueues = new Map<string, VoiceAudioStream[]>();
const waiters = new Map<string, Array<(audio: VoiceAudioStream | null) => void>>();
const speechLocks = new Map<string, Promise<void>>();

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
  return `${publicUrl}/api/meeting-output/${encodeURIComponent(createOutputMediaToken(sessionId))}`;
}

export function outputMediaSession(token: string): string | null {
  return verifyOutputMediaToken(token)?.sessionId ?? null;
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
    const session = await chatStorage.getSession(sessionId);
    if (!session?.meeting || session.meeting.botStatus !== "live") throw new Error("Meeting bot is not live");
    await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "speaking" });
    try {
      const audio = await streamVoiceAudio(text);
      enqueue(sessionId, audio);
      log.info(`queued speech stream sessionId=${sessionId} provider=${audio.provider}`);
      await finished(audio.stream);
      await chatStorage.updateMeetingMeta(sessionId, {
        speechStatus: "spoken",
        speechStatusDetail: `Spoken via ${audio.provider}`,
      });
      log.info(`completed speech stream sessionId=${sessionId} provider=${audio.provider}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await chatStorage.updateMeetingMeta(sessionId, { speechStatus: "failed", speechStatusDetail: detail });
      log.error(`speech failed sessionId=${sessionId}: ${detail}`);
      throw error;
    }
  });
  speechLocks.set(sessionId, current);
  try {
    await current;
  } finally {
    if (speechLocks.get(sessionId) === current) speechLocks.delete(sessionId);
  }
}

export const OUTPUT_MEDIA_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#050505;display:grid;place-items:center}div{color:#fff;font:600 46px system-ui}</style></head><body><div>Mantra Agent</div><script>const token=location.pathname.split('/').pop();const audioUrl='/api/meeting-output/'+token+'/audio';const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function playNext(){const audio=new Audio();audio.preload='auto';audio.src=audioUrl;await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=()=>reject(new Error('Meeting audio playback failed'));audio.play().catch(reject)});audio.removeAttribute('src');audio.load()}async function loop(){for(;;){try{await playNext()}catch{await sleep(1500)}}}loop()</script></body></html>`;
