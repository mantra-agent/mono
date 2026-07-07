import Config from '../config';
import { Logger } from './logger';
import type { NativeEnvironment } from '../native/glasses-capabilities';

const GLASSES_AGENT_API_BASE = `${Config.SERVER_URL}/api/glasses-agent`;

export type GlassesSessionRecord = {
  id: string;
  status: 'created' | 'active' | 'completed' | 'failed' | 'abandoned';
  deviceId?: string | null;
  appVersion?: string | null;
  buildNumber?: string | null;
  telemetry: Record<string, unknown>;
};

export type GlassesFrameUploadResult = {
  ok: true;
  frame: {
    id: string;
    source: string;
    dimensions: string;
    format: string;
    captureMode: string;
    linkedUtteranceId: string | null;
    capturedAt: string;
  };
  answer?: {
    text: string;
    latencyMs: number;
    speech?: {
      audioBase64: string;
      contentType: string;
    };
  };
};

export type GlassesSessionEventType = 'diagnostic' | 'route' | 'dat' | 'voice' | 'vision' | 'lifecycle' | 'failure' | 'latency';

export type GlassesSessionEventInput = {
  eventType: GlassesSessionEventType;
  eventName: string;
  routeMetadata?: Record<string, unknown> | null;
  datState?: Record<string, unknown> | null;
  voiceLifecycle?: string | null;
  visionLifecycle?: string | null;
  failureDetails?: Record<string, unknown> | null;
  latencyMs?: number | null;
  telemetry?: Record<string, unknown>;
  occurredAt?: string;
};

export async function createGlassesSession(environment?: NativeEnvironment): Promise<GlassesSessionRecord> {
  const res = await fetch(`${GLASSES_AGENT_API_BASE}/sessions`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'active',
      appVersion: environment?.appVersion ?? null,
      buildNumber: environment?.buildNumber ?? null,
      telemetry: {
        source: 'mobile_glasses_agent_session',
        bundleIdentifier: environment?.bundleIdentifier,
        platform: environment?.platform,
      },
    }),
  });

  if (!res.ok) throw new Error(`Create glasses session failed: ${res.status}`);
  const data = (await res.json()) as { session: GlassesSessionRecord };
  return data.session;
}

export async function updateGlassesSession(
  sessionId: string,
  body: Partial<Pick<GlassesSessionRecord, 'status' | 'deviceId' | 'appVersion' | 'buildNumber' | 'telemetry'>>,
): Promise<void> {
  const res = await fetch(`${GLASSES_AGENT_API_BASE}/sessions/${sessionId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Update glasses session failed: ${res.status}`);
}

export async function appendGlassesSessionEvent(sessionId: string, event: GlassesSessionEventInput): Promise<void> {
  const res = await fetch(`${GLASSES_AGENT_API_BASE}/sessions/${sessionId}/events`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telemetry: {}, ...event }),
  });
  if (!res.ok) {
    Logger.warn('GlassesSession', 'Glasses session event append failed', {
      status: res.status,
      eventName: event.eventName,
    });
  }
}

export async function uploadGlassesVisionFrame(options: {
  sessionId: string;
  fileUrl: string;
  byteCount?: number;
  deviceId?: string;
  linkedUtteranceId?: string;
  respond?: boolean;
}): Promise<GlassesFrameUploadResult> {
  const form = new FormData();
  form.append('source', 'dat_camera');
  form.append('captureMode', 'still');
  form.append('capturedAt', new Date().toISOString());
  form.append('respond', options.respond ? 'true' : 'false');
  if (options.linkedUtteranceId) form.append('linkedUtteranceId', options.linkedUtteranceId);
  form.append('telemetry', JSON.stringify({
    deviceId: options.deviceId,
    byteCount: options.byteCount,
    source: 'GlassesAgentSession',
  }));
  form.append('frame', {
    uri: options.fileUrl,
    name: 'glasses-dat-frame.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);

  const res = await fetch(`${GLASSES_AGENT_API_BASE}/sessions/${options.sessionId}/vision/frame`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  if (!res.ok) throw new Error(`Glasses vision upload failed: ${res.status}`);
  return (await res.json()) as GlassesFrameUploadResult;
}
