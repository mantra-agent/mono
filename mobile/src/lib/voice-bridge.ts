/**
 * Voice Bridge Protocol
 *
 * Bidirectional message types between the web client (WebView)
 * and React Native. This file is the single source of truth
 * for the bridge protocol shape.
 *
 * Web → Native: sent via window.ReactNativeWebView.postMessage()
 * Native → Web: sent via webViewRef.injectJavaScript()
 */

// ---------------------------------------------------------------------------
// Web → Native messages
// ---------------------------------------------------------------------------

/** Web requests native to start an ElevenLabs voice session with a signed URL. */
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

/** Web requests native to end the voice session. */
export interface VoiceBridgeEnd {
  type: 'voice.end';
}

/** Web requests native to toggle mute. */
export interface VoiceBridgeMute {
  type: 'voice.mute';
  muted: boolean;
}

/** Web sends a user-activity signal (used during agent thinking state). */
export interface VoiceBridgeUserActivity {
  type: 'voice.userActivity';
}

/** Web asks native to start or stop the local thinking feedback loop. */
export interface VoiceBridgeThinkingAudio {
  type: 'voice.thinkingAudio';
  active: boolean;
}

export type WebToNativeVoiceMessage =
  | VoiceBridgeStart
  | VoiceBridgeEnd
  | VoiceBridgeMute
  | VoiceBridgeUserActivity
  | VoiceBridgeThinkingAudio;

// ---------------------------------------------------------------------------
// Native → Web messages
// ---------------------------------------------------------------------------

/** Native ElevenLabs session connected successfully. */
export interface VoiceBridgeConnected {
  type: 'voice.connected';
}

/** Native ElevenLabs session disconnected. */
export interface VoiceBridgeDisconnected {
  type: 'voice.disconnected';
  code?: number;
  reason?: string;
}

/** An error occurred in the native voice session. */
export interface VoiceBridgeError {
  type: 'voice.error';
  message: string;
  code?: string;
}

/** Agent mode changed (listening vs speaking). */
export interface VoiceBridgeModeChange {
  type: 'voice.modeChange';
  mode: 'listening' | 'speaking';
}

/** User speech was transcribed. */
export interface VoiceBridgeUserTranscript {
  type: 'voice.userTranscript';
  text: string;
  isFinal: boolean;
  eventId?: string;
  turnId?: string;
  sequence?: number;
}

/** Agent speech transcribed (supplementary to SSE/WS channel). */
export interface VoiceBridgeAgentTranscript {
  type: 'voice.agentTranscript';
  text: string;
  isFinal: boolean;
  eventId?: string;
  turnId?: string;
  sequence?: number;
}

/** Status updates for the native voice session lifecycle. */
export interface VoiceBridgeStatus {
  type: 'voice.status';
  status: 'connecting' | 'active' | 'ending' | 'idle';
}

/** Whether the native host is foregrounded and should render live visuals. */
export interface VoiceBridgeHostState {
  type: 'voice.hostState';
  active: boolean;
}

export type NativeToWebVoiceMessage =
  | VoiceBridgeConnected
  | VoiceBridgeDisconnected
  | VoiceBridgeError
  | VoiceBridgeModeChange
  | VoiceBridgeUserTranscript
  | VoiceBridgeAgentTranscript
  | VoiceBridgeStatus
  | VoiceBridgeHostState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard: is this a voice bridge message from the web? */
export function isWebToNativeVoiceMessage(msg: { type?: string }): msg is WebToNativeVoiceMessage {
  return typeof msg.type === 'string' && msg.type.startsWith('voice.');
}
