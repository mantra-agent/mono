/**
 * Native Voice Bridge — Client Side
 *
 * Detects when the web client is running inside a React Native WebView
 * and provides helpers to send/receive voice bridge messages.
 *
 * Web → Native: via window.ReactNativeWebView.postMessage()
 * Native → Web: via 'native-voice' custom MessageEvent dispatched by injectJavaScript()
 *
 * Protocol types are defined in mobile/src/lib/voice-bridge.ts (canonical source).
 * These types are duplicated here because mobile and client are separate build targets
 * that cannot share imports.
 */

import { createLogger } from './logger';

const log = createLogger('NativeVoiceBridge');

// ---------------------------------------------------------------------------
// Web → Native message types (mirrors mobile/src/lib/voice-bridge.ts)
// ---------------------------------------------------------------------------

export interface VoiceBridgeStart {
  type: 'voice.start';
  signedUrl: string;
  voiceId: string | null;
  sessionId: string;
  chatSessionId: string | null;
  chatSessionKey?: string;
  agentId?: string;
  overrides?: Record<string, unknown>;
}

export interface VoiceBridgeEnd {
  type: 'voice.end';
}

export interface VoiceBridgeMute {
  type: 'voice.mute';
  muted: boolean;
}

export interface VoiceBridgeUserActivity {
  type: 'voice.userActivity';
}

export type WebToNativeVoiceMessage =
  | VoiceBridgeStart
  | VoiceBridgeEnd
  | VoiceBridgeMute
  | VoiceBridgeUserActivity;

// ---------------------------------------------------------------------------
// Native → Web message types (mirrors mobile/src/lib/voice-bridge.ts)
// ---------------------------------------------------------------------------

export interface VoiceBridgeConnected {
  type: 'voice.connected';
}

export interface VoiceBridgeDisconnected {
  type: 'voice.disconnected';
  code?: number;
  reason?: string;
}

export interface VoiceBridgeError {
  type: 'voice.error';
  message: string;
  code?: string;
}

export interface VoiceBridgeModeChange {
  type: 'voice.modeChange';
  mode: 'listening' | 'speaking';
}

export interface VoiceBridgeUserTranscript {
  type: 'voice.userTranscript';
  text: string;
  isFinal: boolean;
  eventId?: string;
  turnId?: string;
  sequence?: number;
}

export interface VoiceBridgeAgentTranscript {
  type: 'voice.agentTranscript';
  text: string;
  isFinal: boolean;
  eventId?: string;
  turnId?: string;
  sequence?: number;
}

export interface VoiceBridgeStatus {
  type: 'voice.status';
  status: 'connecting' | 'active' | 'ending' | 'idle';
}

export type NativeToWebVoiceMessage =
  | VoiceBridgeConnected
  | VoiceBridgeDisconnected
  | VoiceBridgeError
  | VoiceBridgeModeChange
  | VoiceBridgeUserTranscript
  | VoiceBridgeAgentTranscript
  | VoiceBridgeStatus;

// ---------------------------------------------------------------------------
// Window type augmentation
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage(data: string): void;
    };
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Returns true when running inside a React Native WebView with bridge support. */
export function isNativeVoiceBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.ReactNativeWebView?.postMessage === 'function';
}

// ---------------------------------------------------------------------------
// Web → Native
// ---------------------------------------------------------------------------

/** Send a typed voice message to the native layer. No-op if not in a WebView. */
export function sendToNative(msg: WebToNativeVoiceMessage): void {
  if (!isNativeVoiceBridge()) {
    log.warn('sendToNative called outside WebView, ignoring', { type: msg.type });
    return;
  }
  log.debug('Sending to native', { type: msg.type });
  window.ReactNativeWebView!.postMessage(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Native → Web
// ---------------------------------------------------------------------------

export type NativeVoiceMessageHandler = (msg: NativeToWebVoiceMessage) => void;

const NATIVE_VOICE_EVENT = 'native-voice';

/**
 * Subscribe to voice messages from the native layer.
 * Returns an unsubscribe function.
 */
export function onNativeMessage(handler: NativeVoiceMessageHandler): () => void {
  const listener = (event: Event) => {
    const messageEvent = event as MessageEvent;
    try {
      const data = typeof messageEvent.data === 'string' ? JSON.parse(messageEvent.data) : messageEvent.data;
      if (data && typeof data.type === 'string' && data.type.startsWith('voice.')) {
        log.debug('Received from native', { type: data.type });
        handler(data as NativeToWebVoiceMessage);
      }
    } catch {
      log.warn('Failed to parse native voice message');
    }
  };

  window.addEventListener(NATIVE_VOICE_EVENT, listener);
  return () => window.removeEventListener(NATIVE_VOICE_EVENT, listener);
}
