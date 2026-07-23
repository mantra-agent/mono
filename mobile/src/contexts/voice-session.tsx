import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { NativeToWebVoiceMessage } from '../lib/voice-bridge';
import Config from '../config';
import Logger from '../lib/logger';

const LOG_TAG = 'VoiceSession';

// ---------------------------------------------------------------------------
// SDK types — extracted from @elevenlabs/react-native v1.2.7 + @elevenlabs/client
// We type only the surface we use so the lazy-load pattern stays intact.
// ---------------------------------------------------------------------------

type SDKConversationStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting';

interface SDKDisconnectionDetails {
  reason: string;
  message?: string;
  closeCode?: number;
  closeReason?: string;
}

interface SDKMessagePayload {
  message: string;
  source: 'user' | 'ai';
  role?: string;
}

interface SDKModeChangePayload {
  mode: 'speaking' | 'listening';
}

interface SDKConversationHook {
  startSession: (options?: Record<string, unknown>) => void;
  endSession: () => void;
  status: SDKConversationStatus;
  isMuted: boolean;
  setMuted: (muted: boolean) => void;
  mode: 'speaking' | 'listening';
  isSpeaking: boolean;
  isListening: boolean;
  message: string | undefined;
  sendUserActivity: () => void;
}

interface ElevenLabsModule {
  ConversationProvider: React.ComponentType<React.PropsWithChildren<Record<string, unknown>>>;
  useConversation: (options?: Record<string, unknown>) => SDKConversationHook;
}

// ---------------------------------------------------------------------------
// Bridge session config — what the WebView sends to start a native session
// ---------------------------------------------------------------------------

export interface NativeVoiceSessionConfig {
  agentId: string;
  signedUrl?: string;
  voiceId?: string | null;
  sessionId?: string;
  chatSessionId?: string | null;
  chatSessionKey?: string;
  overrides?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event listener type for bridge callbacks
// ---------------------------------------------------------------------------

export type VoiceEventListener = (event: NativeToWebVoiceMessage) => void;

// ---------------------------------------------------------------------------
// Context value — backward compatible + new bridge capabilities
// ---------------------------------------------------------------------------

/** Maps SDK status to the legacy status the voice.tsx screen expects. */
type LegacyConversationStatus = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

function toLegacyStatus(sdkStatus: SDKConversationStatus): LegacyConversationStatus {
  if (sdkStatus === 'idle') return 'disconnected';
  return sdkStatus as LegacyConversationStatus;
}

export interface VoiceSessionContextValue {
  // Legacy API (voice.tsx backward compatibility)
  status: LegacyConversationStatus;
  isSpeaking: boolean;
  error: string | null;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  toggle: () => Promise<void>;

  // Bridge API (new)
  startSessionWithConfig: (config: NativeVoiceSessionConfig) => void;
  setMuted: (muted: boolean) => void;
  isMuted: boolean;
  sendUserActivity: () => void;
  addBridgeListener: (listener: VoiceEventListener) => () => void;
  preload: () => void;
}

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

// ---------------------------------------------------------------------------
// Unavailable provider — rendered when native module hasn't loaded yet
// ---------------------------------------------------------------------------

function UnavailableVoiceSessionProvider({
  children,
  error,
  loadModule,
  setPendingConfig,
}: {
  children: React.ReactNode;
  error: string | null;
  loadModule: () => Promise<void>;
  setPendingConfig: (config: NativeVoiceSessionConfig | null) => void;
}) {
  const listenersRef = useRef<Set<VoiceEventListener>>(new Set());

  const startSession = useCallback(async () => {
    Logger.info(LOG_TAG, 'Module not loaded, loading lazily for startSession');
    await loadModule();
  }, [loadModule]);

  const startSessionWithConfig = useCallback((config: NativeVoiceSessionConfig) => {
    Logger.info(LOG_TAG, 'Module not loaded, loading lazily for startSessionWithConfig');
    setPendingConfig(config);
    loadModule().catch((err) => {
      Logger.error(LOG_TAG, 'Failed to load module for startSessionWithConfig', { error: String(err) });
      setPendingConfig(null);
    });
  }, [loadModule, setPendingConfig]);

  const preload = useCallback(() => {
    Logger.debug(LOG_TAG, 'Preloading voice module');
    loadModule().catch((err) => {
      Logger.warn(LOG_TAG, 'Voice module preload failed', { error: String(err) });
    });
  }, [loadModule]);

  const endSession = useCallback(async () => {}, []);
  const noop = useCallback(() => {}, []);
  const addBridgeListener = useCallback((listener: VoiceEventListener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const value: VoiceSessionContextValue = {
    status: 'disconnected',
    isSpeaking: false,
    error,
    startSession,
    endSession,
    toggle: startSession,
    startSessionWithConfig,
    setMuted: noop,
    isMuted: false,
    sendUserActivity: noop,
    addBridgeListener,
    preload,
  };

  return <VoiceSessionContext.Provider value={value}>{children}</VoiceSessionContext.Provider>;
}

// ---------------------------------------------------------------------------
// Active provider — inner component that uses the SDK hooks
// (Must be rendered inside ConversationProvider)
// ---------------------------------------------------------------------------

function VoiceSessionInner({
  children,
  module,
  pendingConfig,
  clearPendingConfig,
}: {
  children: React.ReactNode;
  module: ElevenLabsModule;
  pendingConfig: NativeVoiceSessionConfig | null;
  clearPendingConfig: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const listenersRef = useRef<Set<VoiceEventListener>>(new Set());

  const emit = useCallback((event: NativeToWebVoiceMessage) => {
    for (const listener of listenersRef.current) {
      try { listener(event); }
      catch (err) { Logger.warn(LOG_TAG, 'Bridge listener error', { error: String(err) }); }
    }
  }, []);

  const bridgeEventSeqRef = useRef(0);
  const nextBridgeEvent = (role: 'user' | 'agent') => {
    const sequence = ++bridgeEventSeqRef.current;
    return {
      eventId: `native-${role}-${Date.now()}-${sequence}`,
      turnId: `native-${role}-${sequence}`,
      sequence,
    };
  };

  const conversation = module.useConversation({
    onConnect: (_props: { conversationId: string }) => {
      Logger.info(LOG_TAG, 'ElevenLabs connected');
      setError(null);
      emit({ type: 'voice.connected' });
      emit({ type: 'voice.status', status: 'active' });
    },

    onDisconnect: (details: SDKDisconnectionDetails) => {
      Logger.info(LOG_TAG, 'ElevenLabs disconnected', {
        reason: details?.reason,
        closeCode: details?.closeCode,
      });
      emit({
        type: 'voice.disconnected',
        code: details?.closeCode,
        reason: details?.closeReason || details?.reason,
      });
      emit({ type: 'voice.status', status: 'idle' });
    },

    onError: (message: string, _context?: unknown) => {
      const msg = typeof message === 'string' ? message : String(message);
      Logger.error(LOG_TAG, 'ElevenLabs error', { error: msg });
      setError(msg);
      emit({ type: 'voice.error', message: msg });
    },

    onModeChange: (data: SDKModeChangePayload) => {
      Logger.debug(LOG_TAG, 'Mode change', { mode: data.mode });
      emit({ type: 'voice.modeChange', mode: data.mode });
    },

    onMessage: (payload: SDKMessagePayload) => {
      if (payload.source === 'user' && payload.message) {
        emit({ type: 'voice.userTranscript', text: payload.message, isFinal: true, ...nextBridgeEvent('user') });
      }
      if (payload.source === 'ai' && payload.message) {
        emit({ type: 'voice.agentTranscript', text: payload.message, isFinal: true, ...nextBridgeEvent('agent') });
      }
    },
  });

  // ------- Apply pending config from lazy-load -------

  useEffect(() => {
    if (pendingConfig && conversation.status === 'idle') {
      Logger.info(LOG_TAG, 'Applying pending config after module load', {
        agentId: pendingConfig.agentId,
      });
      clearPendingConfig();

      if (!pendingConfig.agentId) {
        Logger.error(LOG_TAG, 'No agentId in pending config — cannot start session');
        emit({ type: 'voice.error', message: 'No agentId provided' });
        return;
      }

      // Defer slightly to ensure ConversationProvider is fully mounted
      const timer = setTimeout(() => {
        try {
          // React Native MUST use agentId (WebRTC), not signedUrl (WebSocket).
          conversation.startSession({
            agentId: pendingConfig.agentId,
            overrides: pendingConfig.overrides || {
              tts: { voiceId: pendingConfig.voiceId || undefined },
            },
            customLlmExtraBody: {
              sessionId: pendingConfig.sessionId,
              chatSessionId: pendingConfig.chatSessionId,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          Logger.error(LOG_TAG, 'Failed to apply pending config', { error: msg });
          setError(msg);
          emit({ type: 'voice.error', message: msg });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pendingConfig, conversation, clearPendingConfig, emit]);

  // ------- Bridge API -------

  const startSessionWithConfig = useCallback((config: NativeVoiceSessionConfig) => {
    Logger.info(LOG_TAG, 'Starting session with config', {
      agentId: config.agentId,
      hasSignedUrl: Boolean(config.signedUrl),
      hasVoiceId: Boolean(config.voiceId),
      hasSessionId: Boolean(config.sessionId),
    });

    emit({ type: 'voice.status', status: 'connecting' });

    // React Native MUST use WebRTC (agentId), not WebSocket (signedUrl).
    // signedUrl forces WebSocket transport which lacks Web Audio API in RN.
    // agentId connects via WebRTC using native AVAudioSession.
    // The server's custom LLM callback URL receives sessionId/chatSessionId
    // via customLlmExtraBody, providing full conversation context.
    if (!config.agentId) {
      const msg = 'No agentId provided — cannot start native voice session';
      Logger.error(LOG_TAG, msg);
      setError(msg);
      emit({ type: 'voice.error', message: msg });
      emit({ type: 'voice.status', status: 'idle' });
      return;
    }

    try {
      conversation.startSession({
        agentId: config.agentId,
        overrides: config.overrides || {
          tts: { voiceId: config.voiceId || undefined },
        },
        customLlmExtraBody: {
          sessionId: config.sessionId,
          chatSessionId: config.chatSessionId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.error(LOG_TAG, 'Failed to start session', { error: msg });
      setError(msg);
      emit({ type: 'voice.error', message: msg });
      emit({ type: 'voice.status', status: 'idle' });
    }
  }, [conversation, emit]);

  // ------- Legacy API (voice.tsx backward compatibility) -------

  const startSession = useCallback(async () => {
    startSessionWithConfig({ agentId: Config.ELEVENLABS_AGENT_ID });
  }, [startSessionWithConfig]);

  const endSession = useCallback(async () => {
    Logger.info(LOG_TAG, 'Ending session');
    emit({ type: 'voice.status', status: 'ending' });
    try { conversation.endSession(); }
    catch (err) { Logger.warn(LOG_TAG, 'End session error', { error: String(err) }); }
  }, [conversation, emit]);

  const toggle = useCallback(async () => {
    if (conversation.status === 'connected') {
      await endSession();
    } else if (conversation.status === 'idle') {
      await startSession();
    }
  }, [conversation.status, startSession, endSession]);

  const setMuted = useCallback((muted: boolean) => {
    Logger.debug(LOG_TAG, 'Set muted', { muted });
    conversation.setMuted(muted);
  }, [conversation]);

  const sendUserActivity = useCallback(() => {
    conversation.sendUserActivity();
  }, [conversation]);

  const addBridgeListener = useCallback((listener: VoiceEventListener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const preload = useCallback(() => {
    Logger.debug(LOG_TAG, 'Voice module already loaded; preload skipped');
  }, []);

  const value: VoiceSessionContextValue = {
    status: toLegacyStatus(conversation.status),
    isSpeaking: conversation.isSpeaking,
    error,
    startSession,
    endSession,
    toggle,
    startSessionWithConfig,
    setMuted,
    isMuted: conversation.isMuted,
    sendUserActivity,
    addBridgeListener,
    preload,
  };

  return <VoiceSessionContext.Provider value={value}>{children}</VoiceSessionContext.Provider>;
}

// ---------------------------------------------------------------------------
// Active provider wrapper — renders ConversationProvider around inner
// ---------------------------------------------------------------------------

function ActiveVoiceSessionProvider({
  children,
  module,
  pendingConfig,
  clearPendingConfig,
}: {
  children: React.ReactNode;
  module: ElevenLabsModule;
  pendingConfig: NativeVoiceSessionConfig | null;
  clearPendingConfig: () => void;
}) {
  const Provider = module.ConversationProvider;
  return (
    <Provider>
      <VoiceSessionInner module={module} pendingConfig={pendingConfig} clearPendingConfig={clearPendingConfig}>
        {children}
      </VoiceSessionInner>
    </Provider>
  );
}

// ---------------------------------------------------------------------------
// Root provider — lazy-loads the native module
// ---------------------------------------------------------------------------

export function VoiceSessionProvider({ children }: { children: React.ReactNode }) {
  const [module, setModule] = useState<ElevenLabsModule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfig, setPendingConfig] = useState<NativeVoiceSessionConfig | null>(null);
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const clearPendingConfig = useCallback(() => setPendingConfig(null), []);

  const loadModule = useCallback(async () => {
    if (module) {
      return;
    }

    if (loadPromiseRef.current) {
      Logger.debug(LOG_TAG, 'Voice module load already in progress');
      return loadPromiseRef.current;
    }

    const loadPromise = (async () => {
      try {
        setError(null);

        // Register WebRTC globals BEFORE importing @elevenlabs/react-native.
        //
        // ElevenLabs' RN entry (index.react-native.js) calls registerGlobals()
        // at module scope during import. If native WebRTC module init fails
        // (e.g. iOS 26 AudioUnit incompatibility), a module-scope throw is
        // uncatchable by our try/catch. Calling registerGlobals() explicitly
        // first means: (a) we get error handling around native init, and
        // (b) ElevenLabs' module-scope call becomes a safe no-op since the
        // globals are already registered.
        //
        // Mic permissions are handled by the OS via NSMicrophoneUsageDescription
        // in Info.plist — no need for expo-av.
        // Force-install web-streams-polyfill globals BEFORE registerGlobals().
        // iOS 26 has native ReadableStream/WritableStream but they're
        // incompatible with LiveKit's internals. Conditional guards
        // (typeof === 'undefined') skip installation because natives exist,
        // then registerGlobals → shimWebstreams crashes. Unconditional
        // overwrite with the polyfill matches debug option 8 which works.
        Logger.info(LOG_TAG, 'Installing web-streams-polyfill globals');
        const polyfill = require('web-streams-polyfill');
        const g = global as any;
        g.WritableStream = polyfill.WritableStream;
        g.ReadableStream = polyfill.ReadableStream;
        g.TransformStream = polyfill.TransformStream;
        g.CountQueuingStrategy = polyfill.CountQueuingStrategy;
        Logger.info(LOG_TAG, 'Web streams globals installed');

        Logger.info(LOG_TAG, 'Registering WebRTC globals');
        const { registerGlobals } = await import('@livekit/react-native');
        registerGlobals();
        Logger.info(LOG_TAG, 'WebRTC globals registered');

        Logger.info(LOG_TAG, 'Loading @elevenlabs/react-native module lazily');
        const loaded = await import('@elevenlabs/react-native');
        setModule(loaded as unknown as ElevenLabsModule);
        Logger.info(LOG_TAG, 'Module loaded successfully');
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        Logger.error(LOG_TAG, 'Module load failed', { error: message });
        setError(message);
        throw new Error(`Voice module unavailable: ${message}`);
      } finally {
        loadPromiseRef.current = null;
      }
    })();

    loadPromiseRef.current = loadPromise;
    return loadPromise;
  }, [module]);

  // Module loads lazily on first voice interaction (startSession / startSessionWithConfig).
  // Eagerly loading @elevenlabs/react-native triggers Turbo Module init which crashes
  // on some iOS versions (observed iOS 26.5.1 SIGABRT on turbomodulemanager queue).

  if (!module) {
    return (
      <UnavailableVoiceSessionProvider error={error} loadModule={loadModule} setPendingConfig={setPendingConfig}>
        {children}
      </UnavailableVoiceSessionProvider>
    );
  }

  return (
    <ActiveVoiceSessionProvider module={module} pendingConfig={pendingConfig} clearPendingConfig={clearPendingConfig}>
      {children}
    </ActiveVoiceSessionProvider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceSession(): VoiceSessionContextValue {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) throw new Error('useVoiceSession must be used within VoiceSessionProvider');
  return ctx;
}
