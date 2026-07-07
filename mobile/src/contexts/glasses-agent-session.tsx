import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  captureDatPhoto,
  connectDatDevice,
  getNativeEnvironment,
  configureDat,
  playBase64Audio,
  requestDatCameraPermission,
  selectHfpInput,
  startAudioRouteObservers,
  type DatResult,
} from '../native/glasses-capabilities';
import { useVoiceSession } from './voice-session';
import { Logger } from '../lib/logger';
import {
  appendGlassesSessionEvent,
  createGlassesSession,
  updateGlassesSession,
  uploadGlassesVisionFrame,
  type GlassesSessionRecord,
} from '../lib/glasses-session-api';

type GlassesAgentPhase = 'idle' | 'preparing_voice' | 'voice_ready' | 'capturing_vision' | 'answer_ready' | 'zero_interface_ready' | 'error';

type DisplayState = {
  title: string;
  body: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
  updatedAt: string;
};

type GlassesAgentSessionContextValue = {
  phase: GlassesAgentPhase;
  sessionId: string | null;
  displayState: DisplayState | null;
  isBusy: boolean;
  error: string | null;
  rehearseVoiceOnly: () => Promise<void>;
  runQuickVision: () => Promise<void>;
  enableZeroInterface: () => Promise<void>;
  endGlassesSession: () => Promise<void>;
};

const GlassesAgentSessionContext = createContext<GlassesAgentSessionContextValue | null>(null);

export function GlassesAgentSessionProvider({ children }: { children: React.ReactNode }) {
  const voice = useVoiceSession();
  const [phase, setPhase] = useState<GlassesAgentPhase>('idle');
  const [session, setSession] = useState<GlassesSessionRecord | null>(null);
  const [displayState, setDisplayState] = useState<DisplayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<GlassesSessionRecord | null>(null);
  const busyRef = useRef(false);
  const [isBusy, setIsBusy] = useState(false);

  const runExclusive = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsBusy(true);
    try {
      await operation();
    } finally {
      busyRef.current = false;
      setIsBusy(false);
    }
  }, []);

  const ensureSession = useCallback(async (): Promise<GlassesSessionRecord> => {
    if (sessionRef.current) return sessionRef.current;
    const environment = await getNativeEnvironment();
    const created = await createGlassesSession(environment);
    sessionRef.current = created;
    setSession(created);
    await appendGlassesSessionEvent(created.id, {
      eventType: 'lifecycle',
      eventName: 'glasses_agent_session_created',
      telemetry: { source: 'mobile' },
    });
    return created;
  }, []);

  const fail = useCallback(async (sessionId: string | null, operation: string, caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    setError(message);
    setPhase('error');
    setDisplayState({
      title: 'Glasses session blocked',
      body: message,
      tone: 'error',
      updatedAt: new Date().toISOString(),
    });
    Logger.error('GlassesSession', `${operation} failed`, { message });
    if (sessionId) {
      await appendGlassesSessionEvent(sessionId, {
        eventType: 'failure',
        eventName: `${operation}_failed`,
        failureDetails: { message },
      });
    }
  }, []);

  const rehearseVoiceOnly = useCallback(async () => runExclusive(async () => {
    setError(null);
    setPhase('preparing_voice');
    const active = await ensureSession();
    try {
      const route = await startAudioRouteObservers();
      const selection = await selectHfpInput();
      await appendGlassesSessionEvent(active.id, {
        eventType: 'route',
        eventName: 'hfp_route_prepared',
        routeMetadata: {
          input: route.preferredInput?.name,
          output: route.currentOutputs[0]?.name,
          selected: selection.selected,
          fallback: selection.fallback,
        },
      });

      if (voice.error) {
        throw new Error(`Voice module unavailable: ${voice.error}`);
      }

      if (voice.status !== 'connected') {
        await voice.startSession();
      }

      setPhase('voice_ready');
      setDisplayState({
        title: 'Voice rehearsal live',
        body: selection.selected
          ? 'Speak through the glasses. Agent should answer through the glasses.'
          : 'Voice is live, but HFP glasses mic was not selected. Check Bluetooth route.',
        tone: selection.selected ? 'success' : 'warning',
        updatedAt: new Date().toISOString(),
      });
      await appendGlassesSessionEvent(active.id, {
        eventType: 'voice',
        eventName: 'voice_only_rehearsal_started',
        voiceLifecycle: 'started',
        telemetry: { voiceStatus: voice.status },
      });
    } catch (caught) {
      await fail(active.id, 'voice_rehearsal', caught);
    }
  }), [ensureSession, fail, runExclusive, voice]);

  const runQuickVision = useCallback(async () => runExclusive(async () => {
    setError(null);
    setPhase('capturing_vision');
    const active = await ensureSession();
    try {
      await appendGlassesSessionEvent(active.id, {
        eventType: 'vision',
        eventName: 'quick_vision_requested',
        visionLifecycle: 'requested',
      });

      await configureDat();
      const deviceState = await connectDatDevice(null);
      const permission = await requestDatCameraPermission();
      if (isErrorResult(permission) || permission.granted === false) {
        throw new Error(isErrorResult(permission) ? permission.error : `Camera permission ${permission.status}`);
      }

      const photo = await captureDatPhoto();
      if (isErrorResult(photo)) throw new Error(photo.error);
      if (!photo.fileUrl) throw new Error('DAT photo capture succeeded without a file URL');

      const upload = await uploadGlassesVisionFrame({
        sessionId: active.id,
        fileUrl: photo.fileUrl,
        byteCount: photo.byteCount,
        deviceId: photo.deviceId,
        respond: true,
      });

      await updateGlassesSession(active.id, {
        deviceId: photo.deviceId,
        telemetry: {
          lastFrameId: upload.frame.id,
          datState: isErrorResult(deviceState) ? { error: deviceState.error } : deviceState,
        },
      });

      if (upload.answer?.speech?.audioBase64) {
        await playBase64Audio(upload.answer.speech.audioBase64, 'mp3');
        await appendGlassesSessionEvent(active.id, {
          eventType: 'voice',
          eventName: 'quick_vision_answer_spoken',
          voiceLifecycle: 'played',
          telemetry: { contentType: upload.answer.speech.contentType },
        });
      }

      setPhase('answer_ready');
      setDisplayState({
        title: 'What you are looking at',
        body: upload.answer?.text ?? 'Frame uploaded. Vision answer was not returned by the backend.',
        tone: upload.answer?.text ? 'success' : 'warning',
        updatedAt: new Date().toISOString(),
      });
      await appendGlassesSessionEvent(active.id, {
        eventType: 'vision',
        eventName: 'quick_vision_answer_displayed',
        visionLifecycle: 'answered',
        latencyMs: upload.answer?.latencyMs ?? null,
        telemetry: { frameId: upload.frame.id, hasAnswer: Boolean(upload.answer?.text) },
      });
    } catch (caught) {
      await fail(active.id, 'quick_vision', caught);
    }
  }), [ensureSession, fail, runExclusive]);

  const enableZeroInterface = useCallback(async () => runExclusive(async () => {
    const active = await ensureSession();
    if (phase !== 'answer_ready' && phase !== 'voice_ready' && phase !== 'zero_interface_ready') {
      setDisplayState({
        title: 'Not ready yet',
        body: 'Pass voice-only and quick vision before treating this as a Zero Interface surface.',
        tone: 'warning',
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    setPhase('zero_interface_ready');
    setDisplayState((current) => ({
      title: current?.title ?? 'Glasses session ready',
      body: current?.body ?? 'Voice and quick vision are ready for the Zero Interface surface.',
      tone: current?.tone ?? 'success',
      updatedAt: new Date().toISOString(),
    }));
    await appendGlassesSessionEvent(active.id, {
      eventType: 'lifecycle',
      eventName: 'zero_interface_surface_enabled',
      telemetry: { priorPhase: phase },
    });
  }), [ensureSession, phase, runExclusive]);

  const endGlassesSession = useCallback(async () => runExclusive(async () => {
    const active = sessionRef.current;
    if (voice.status === 'connected') await voice.endSession();
    if (active) {
      await updateGlassesSession(active.id, { status: 'completed' });
      await appendGlassesSessionEvent(active.id, {
        eventType: 'lifecycle',
        eventName: 'glasses_agent_session_completed',
      });
    }
    sessionRef.current = null;
    setSession(null);
    setPhase('idle');
    setDisplayState(null);
    setError(null);
  }), [runExclusive, voice]);

  const value = useMemo<GlassesAgentSessionContextValue>(() => ({
    phase,
    sessionId: session?.id ?? null,
    displayState,
    isBusy,
    error,
    rehearseVoiceOnly,
    runQuickVision,
    enableZeroInterface,
    endGlassesSession,
  }), [displayState, enableZeroInterface, endGlassesSession, error, isBusy, phase, rehearseVoiceOnly, runQuickVision, session?.id]);

  return <GlassesAgentSessionContext.Provider value={value}>{children}</GlassesAgentSessionContext.Provider>;
}

export function useGlassesAgentSession(): GlassesAgentSessionContextValue {
  const ctx = useContext(GlassesAgentSessionContext);
  if (!ctx) throw new Error('useGlassesAgentSession must be used within GlassesAgentSessionProvider');
  return ctx;
}

function isErrorResult<T>(result: T | DatResult): result is Extract<T | DatResult, { error: string }> {
  return typeof result === 'object' && result !== null && 'error' in result;
}
