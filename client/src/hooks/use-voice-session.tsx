// Use createLogger for logging ONLY
import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { emitSessionListChanged, emitSessionChanged } from "@/hooks/use-data-sync";
import { setVisibilityLayer } from "@/hooks/use-visibility-layer";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";

import { stripExpressionTags } from "@/components/chat-shared";
import { Conversation, type AudioAlignmentEvent } from "@elevenlabs/client";
import type { AgentVisualState } from "@shared/agent-visualizer";
import {
  createVoiceInputActivityDetector,
  VOICE_INPUT_SAMPLE_INTERVAL_MS,
} from "@shared/voice-input-activity";
import { createLogger } from "@/lib/logger";
import { buildDisconnectReason } from "@/lib/ws-close-codes";
import {
  createVoiceStartRequestId,
  fetchVoiceStartFallback,
  fetchVoiceStartStream,
  type VoiceStartPhaseEvent,
  type VoiceStartResponse,
} from "@/lib/voice-start-transport";
import { getClientTabId } from "@/lib/client-tab-identity";
import {
  admitVoiceTranscript,
  type VoiceEchoAdmissionEvidence,
} from "@/lib/voice-echo-admission";
import {
  appendVoiceCaptionWords,
  createVoiceCaptionChunk,
  flushVoiceCaptionBuffer,
  VOICE_CAPTION_FINAL_HOLD_MS,
  type VoiceCaptionBuffer,
} from "@/lib/voice-caption-timeline";
import {
  createVoiceFinalizationRequest,
  isVoiceFinalizationResponse,
  type VoiceFinalizationSettlement,
  type VoiceFinalizationSystemStep,
} from "@shared/voice-finalization";
export type { VoiceStartResponse } from "@/lib/voice-start-transport";
import {
  playConnectionChime,
  playDisconnectionChime,
  startVoiceThinkingLoop,
  stopVoiceThinkingLoop,
  unlockVoiceAudioContext,
} from "@/lib/voice-chime";
import { isNativeVoiceBridge, sendToNative, onNativeMessage } from "@/lib/native-voice-bridge";
import {
  reduceVoiceUserTranscript,
  type VoiceTranscriptEntry,
  type VoiceTranscriptStatus,
} from "@/lib/voice-transcript-state";
export type { VoiceTranscriptEntry, VoiceTranscriptStatus } from "@/lib/voice-transcript-state";

const log = createLogger("VoiceSession");

/**
 * Pre-warm Chrome's audio hardware by creating a brief silent AudioContext.
 * Chrome can take several seconds to stabilize its audio pipeline when an
 * AudioContext is created at a non-native sample rate (e.g. 16kHz when
 * hardware runs at 48kHz). Running a throwaway context first forces the
 * hardware initialization so the real session starts cleanly.
 *
 * Returns once the warm-up completes or on any error (non-blocking).
 */
async function warmUpAudioPipeline(): Promise<void> {
  unlockVoiceAudioContext();
  await new Promise(r => setTimeout(r, 100));
}

export type VoiceStatus = "idle" | "connecting" | "active" | "ending" | "reconnecting";



export type ConnectionPhaseStatus = "pending" | "active" | "done" | "error";

export interface ConnectionPhase {
  name: string;
  status: ConnectionPhaseStatus;
  elapsedMs: number;
}



export type VoiceToolEventAction = "start" | "done" | "clear";
export interface VoiceToolEventPayload {
  callId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  result?: string;
  error?: boolean | string;
}

export interface VoiceDiagnosticPayload {
  stepName: string;
  detail?: string;
  status?: "active" | "done" | "error";
  elapsedMs?: number;
  turn?: number;
  timestamp?: number;
}

export interface VoiceSessionContextValue {
  status: VoiceStatus;
  agentMode: "listening" | "speaking";
  userSpeaking: boolean;
  isMuted: boolean;
  transcript: VoiceTranscriptEntry[];
  /** Ephemeral user speech still being extended by the provider. */
  userComposition: string;
  /** Session identity that owns the ephemeral transcript aggregate. */
  transcriptSessionId: string | null;
  voiceThinking: boolean;
  /** Ephemeral agent words synchronized to the provider audio queue. */
  voiceCaption: string;
  visualState: AgentVisualState;
  /** One-shot flag: a fresh voice start is awaiting its renderer-owned entrance. */
  voiceEntrancePending: boolean;
  /** Marks the pending voice entrance as consumed by the orb that played it. */
  consumeVoiceEntrance: () => void;
  /** Native host visibility. Browser hosts remain active. */
  isHostForeground: boolean;
  /** Reads the active SDK AnalyserNode level without driving context re-renders. */
  readAudioLevel: () => number;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  toggleMute: () => void;
  latestMessage: VoiceTranscriptEntry | null;
  setActiveConversationId: (id: string | null) => void;
  clearTranscript: () => void;
  activeConversationId: string | null;
  chatSessionKey: string | null;
  connectionPhases: ConnectionPhase[];
  connectionStartTime: number | null;
  phasePersisted: boolean;
  setVoiceThinking: (v: boolean) => void;
  addTranscriptEntry: (entry: VoiceTranscriptEntry) => void;
  setVoiceToolHandler: (handler: ((action: VoiceToolEventAction, payload: VoiceToolEventPayload) => void) | null) => void;
  setVoiceDiagnosticHandler: (handler: ((payload: VoiceDiagnosticPayload) => void) | null) => void;
}

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

export function useVoiceSession() {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) throw new Error("useVoiceSession must be used within VoiceSessionProvider");
  return ctx;
}

export function useVoiceSessionOptional() {
  return useContext(VoiceSessionContext);
}

const INITIAL_PHASES: ConnectionPhase[] = [
  { name: "signed_url", status: "pending", elapsedMs: 0 },
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

type ClientVoiceSessionOperation =
  | "finalize"
  | "sdk_error"
  | "connection"
  | "event_ws"
  | "start_session"
  | "midsession_disconnect";

type ClientVoiceSessionOperationError = Error & {
  code?: string;
  operation?: ClientVoiceSessionOperation;
  phase?: string;
  reason?: string;
  attempt?: number;
};

function normalizeClientVoiceSessionError(
  value: unknown,
  operation: ClientVoiceSessionOperation,
  fallbackCode: string,
  message?: string,
): ClientVoiceSessionOperationError {
  let error: ClientVoiceSessionOperationError;
  if (value instanceof Error) {
    // Browser/SDK errors are foreign values. Safari's DOMException is an Error,
    // but fields such as `code` are read-only; decorating it masked the real
    // startup failure and prevented lease compensation from running.
    error = new Error(message || value.message || "VoiceSession client operation failed", {
      cause: value,
    }) as ClientVoiceSessionOperationError;
    error.name = value.name || "Error";
    if (value.stack) error.stack = value.stack;
    const source = value as ClientVoiceSessionOperationError;
    if (typeof source.reason === "string") error.reason = source.reason.slice(0, 120);
    if (typeof source.attempt === "number") error.attempt = source.attempt;
    if (typeof source.phase === "string") error.phase = source.phase.slice(0, 80);
    if (typeof source.code === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(source.code)) {
      error.code = source.code;
    }
  } else if (typeof value === "string" && value.trim()) {
    error = new Error(message || value.slice(0, 300)) as ClientVoiceSessionOperationError;
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const reason =
      typeof record.reason === "string"
        ? record.reason
        : typeof record.error === "string"
          ? record.error
          : undefined;
    error = new Error(message || reason || "VoiceSession client operation failed", {
      cause: value,
    }) as ClientVoiceSessionOperationError;
    if (reason) error.reason = reason.slice(0, 120);
    if (typeof record.attempt === "number") error.attempt = record.attempt;
  } else {
    error = new Error(message || "VoiceSession client operation failed", {
      cause: value,
    }) as ClientVoiceSessionOperationError;
  }
  if (!error.code || !/^[A-Z][A-Z0-9_]{1,47}$/.test(String(error.code))) {
    error.code = fallbackCode;
  }
  error.operation = operation;
  return error;
}

function clientVoiceSessionLogContext(options: {
  operation: ClientVoiceSessionOperation;
  phase?: string;
  reason?: string;
  attempt?: number;
  agentMode?: string;
}) {
  return {
    operation: options.operation,
    phase: options.phase,
    reason: options.reason,
    attempt: options.attempt,
    agentMode: options.agentMode,
  };
}

function toBoundedLogError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name || undefined, message: err.message || "Unknown error" };
  }
  if (typeof err === "string") {
    return { message: err.slice(0, 300) };
  }
  return { message: "Unknown error" };
}

function safeDiagnosticText(value: unknown): string {
  return getErrorMessage(value).slice(0, 300);
}

function isTransportError(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === "AbortError");
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

interface ElevenLabsMessage {
  message?: string;
  role?: "user" | "agent";
  /** Compatibility only: removed after every supported SDK emits role. */
  source?: "user" | "user_edited" | "ai";
}

const STRICT_ECHO_ADMISSION_ENABLED = true;

function resolveElevenLabsMessageRole(message: ElevenLabsMessage): "user" | "agent" | null {
  if (message.role === "user" || message.role === "agent") return message.role;
  if (message.source === "user" || message.source === "user_edited") return "user";
  if (message.source === "ai") return "agent";
  return null;
}

function compositionMatchesCommit(composition: string, committed: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const active = normalize(composition);
  const final = normalize(committed);
  if (!active || !final) return false;
  return active === final || active.startsWith(final) || final.startsWith(active);
}

const WS_OPEN_TIMEOUT_MS = 10_000;

function buildBrowserVoiceStartOptions(input: {
  signedUrl: string;
  overrides: Record<string, unknown>;
  sessionId?: string;
  chatSessionId?: string | null;
  callbacks: Record<string, unknown>;
}): Parameters<typeof Conversation.startSession>[0] {
  // The SDK owns and may normalize the object tree passed to startSession.
  // Give every attempt fresh mutable containers; never expose our retained
  // override/identity objects to browser- or SDK-specific mutation.
  const customLlmExtraBody: Record<string, string> = {};
  if (input.sessionId) customLlmExtraBody.sessionId = input.sessionId;
  if (input.chatSessionId) customLlmExtraBody.chatSessionId = input.chatSessionId;

  return {
    signedUrl: input.signedUrl,
    connectionType: "websocket",
    overrides: structuredClone(input.overrides),
    customLlmExtraBody,
    dynamicVariables: input.chatSessionId
      ? { chat_session_id: input.chatSessionId }
      : undefined,
    // Same-origin worklets keep AudioWorklet.addModule inside worker-src /
    // script-src 'self'. The SDK otherwise blobs generated processors and, on
    // iOS output, hardcodes jsDelivr libsamplerate when libsampleratePath is
    // not forwarded (VoiceSessionSetup still drops it on MediaDeviceOutput).
    // `installFirstPartyVoiceWorklets` rewrites that CDN URL as defense in
    // depth; these options remain the preferred explicit paths for input +
    // both processors.
    workletPaths: {
      rawAudioProcessor: "/voice/rawAudioProcessor.worklet.js",
      audioConcatProcessor: "/voice/audioConcatProcessor.worklet.js",
    },
    libsampleratePath: "/voice/libsamplerate.worklet.js",
    ...input.callbacks,
  } as Parameters<typeof Conversation.startSession>[0];
}

interface StartFailureClassification {
  reason: string;
  message: string;
  closeCode?: string;
  closeReason?: string;
}

function classifyStartFailure(err: unknown, ctx: { signedUrlReceived: boolean }): StartFailureClassification {
  if (!(err instanceof Error)) {
    return { reason: "unknown", message: "Could not start voice session." };
  }
  const name = err.name || "";
  const msg = err.message || "";
  const lower = msg.toLowerCase();

  if (name === "SecurityError" && /content security policy|\bcsp\b/i.test(msg)) {
    return { reason: "audio_worklet_csp", message: "Voice audio could not load in this browser. Refresh Mantra and try again." };
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || /permission denied|not allowed|microphone access/i.test(msg)) {
    return { reason: "mic_permission", message: "Microphone is blocked. Allow microphone access in your browser settings and try again." };
  }
  if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError" || /no microphone|audio device|getusermedia/i.test(msg)) {
    return { reason: "mic_unavailable", message: "No microphone available. Plug one in or check your audio device and try again." };
  }
  if (msg === "ws_open_timeout" || lower.includes("ws_open_timeout")) {
    return { reason: "ws_open_timeout", message: "Voice connection timed out before opening. Check your network and try again." };
  }
  if (!ctx.signedUrlReceived || lower.includes("agent not configured") || lower.includes("signed url") || /^http \d/i.test(msg) || lower.includes("voice start") || lower.includes("sse stream")) {
    return { reason: "signed_url_rejected", message: msg ? `Voice service rejected the request: ${msg}` : "Voice service rejected the request." };
  }
  if (lower.includes("websocket") || lower.includes("ws ") || lower.includes("network") || lower.includes("connection")) {
    return { reason: "ws_error", message: "Voice connection failed (network or WebSocket error). Check your connection and try again." };
  }
  return { reason: "unknown", message: msg || "Could not start voice session." };
}

export function VoiceSessionProvider({
  children,
  onboardingToken,
  suppressChimes = false,
}: {
  children: ReactNode;
  onboardingToken?: string;
  /**
   * Silence connection/disconnection chimes for a deliberate transport handoff.
   * The provisional entrance enables this only after claim, preventing a
   * redundant disconnect tone while navigation mounts the authenticated app.
   * Defaults false — ordinary voice behavior is unchanged.
   */
  suppressChimes?: boolean;
}) {
  const isNative = isNativeVoiceBridge();
  const nativeListenerCleanupRef = useRef<(() => void) | null>(null);
  const suppressChimesRef = useRef(suppressChimes);
  useEffect(() => {
    suppressChimesRef.current = suppressChimes;
  }, [suppressChimes]);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [agentMode, setAgentMode] = useState<"listening" | "speaking">("listening");
  const [isMuted, setIsMuted] = useState(false);
  const [voiceThinking, setVoiceThinking] = useState(false);
  const [voiceCaption, setVoiceCaption] = useState("");
  const [activeVoiceToolCount, setActiveVoiceToolCount] = useState(0);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [nativeInputActivityAvailable, setNativeInputActivityAvailable] = useState(false);
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [userComposition, setUserComposition] = useState("");
  const [transcriptSessionId, setTranscriptSessionId] = useState<string | null>(null);
  const [connectionPhases, setConnectionPhases] = useState<ConnectionPhase[]>([]);
  const [connectionStartTime, setConnectionStartTime] = useState<number | null>(null);
  const [phasePersisted, setPhasePersisted] = useState(false);
  const [isHostForeground, setIsHostForeground] = useState(true);
  // Armed at the canonical real voice start (startSession) and consumed by the
  // orb that plays the black voice entrance, so the one-shot fires once per
  // start rather than on every voice-surface/orb remount.
  const [voiceEntrancePending, setVoiceEntrancePending] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isNative) return;
    return onNativeMessage((message) => {
      if (message.type !== "voice.hostState") return;
      log.debug("VOICE:NATIVE:HOST_STATE", { active: message.active });
      setIsHostForeground(message.active);
    });
  }, [isNative]);

  const conversationRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);
  const captionTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const captionQueueEndRef = useRef(0);
  const captionBufferRef = useRef<VoiceCaptionBuffer>({ pendingWords: [] });
  const transcriptRef = useRef<VoiceTranscriptEntry[]>([]);
  const reconnectAttemptRef = useRef(0);
  const intentionalEndRef = useRef(false);
  const connectSessionRef = useRef<(isReconnect: boolean) => Promise<boolean>>(async () => false);
  const connectAbortRef = useRef<AbortController | null>(null);
  const voiceRequestIdRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectVisibilityCleanupRef = useRef<(() => void) | null>(null);
  const chatConversationIdRef = useRef<string | null>(null);
  const voiceSessionIdRef = useRef<string | null>(null);
  const sessionPersonaRef = useRef<{ id: number; name: string; icon: string } | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectInProgressRef = useRef(false);
  const disconnectGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStartTsRef = useRef<number>(0);
  const agentModeRef = useRef<"listening" | "speaking">("listening");
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  const [chatSessionKey, setChatSessionKey] = useState<string | null>(null);
  const voiceToolHandlerRef = useRef<((action: VoiceToolEventAction, payload: VoiceToolEventPayload) => void) | null>(null);
  const activeVoiceToolIdsRef = useRef(new Set<string>());
  const voiceDiagnosticHandlerRef = useRef<((payload: VoiceDiagnosticPayload) => void) | null>(null);
  const accumulatedVoiceStepsRef = useRef<Array<{ name: string; status: "done" | "error"; detail?: string }>>([]);
  const firstUserSpeechFiredRef = useRef(false);
  const connectionEstablishedAtRef = useRef<number>(0);
  const wsConnectResolveRef = useRef<(() => void) | null>(null);
  const startFailureMessageRef = useRef<string | null>(null);
  // Synchronous start guard (task-923 step 1d). React state setters are
  // async, so two startSession() calls in the same React tick both observe
  // status === "idle" and both proceed. A ref flips synchronously inside
  // the callback itself, so the second call is a hard no-op.
  const isStartingRef = useRef(false);
  const disconnectChimePlayedRef = useRef(false);
  // Onset-grace timer and playing flag for the thinking-audio bed. This effect
  // is the single producer of thinking-sound playback for BOTH the web synth and
  // the native (WebView→RN bridge) synth, so delayed onset and instant barge-in
  // kill are enforced once here rather than patched per surface.
  const thinkingAudioGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingAudioPlayingRef = useRef(false);
  const inputActivityDetectorRef = useRef(createVoiceInputActivityDetector());
  const inputActiveRef = useRef(false);
  const recentAssistantTextRef = useRef("");
  const echoAdmissionSequenceRef = useRef(0);

  const stopThinkingAudioPlayback = useCallback((immediate: boolean) => {
    if (thinkingAudioGraceTimerRef.current !== null) {
      clearTimeout(thinkingAudioGraceTimerRef.current);
      thinkingAudioGraceTimerRef.current = null;
    }
    thinkingAudioPlayingRef.current = false;
    if (isNative) {
      sendToNative({ type: "voice.thinkingAudio", active: false });
    } else {
      stopVoiceThinkingLoop({ immediate });
    }
  }, [isNative]);

  useEffect(() => {
    // Grace period before the sound may fade in. Fast turns that resolve inside
    // this window never play it at all, so the bed only signals a genuinely long
    // "still processing" pause rather than firing on every turn.
    const ONSET_GRACE_MS = 1000;

    const shouldPlayThinkingAudio =
      status === "active" &&
      voiceThinking &&
      agentMode !== "speaking" &&
      !userSpeaking &&
      (!isNative || nativeInputActivityAvailable);

    const startPlayback = () => {
      thinkingAudioPlayingRef.current = true;
      if (isNative) {
        sendToNative({ type: "voice.thinkingAudio", active: true });
      } else {
        startVoiceThinkingLoop();
      }
    };

    const stopPlayback = (immediate: boolean) => {
      if (!thinkingAudioPlayingRef.current && thinkingAudioGraceTimerRef.current === null) return;
      stopThinkingAudioPlayback(immediate);
    };

    if (shouldPlayThinkingAudio) {
      // Already playing or already counting down — don't re-arm the grace timer.
      if (thinkingAudioPlayingRef.current || thinkingAudioGraceTimerRef.current !== null) {
        return;
      }
      thinkingAudioGraceTimerRef.current = setTimeout(() => {
        thinkingAudioGraceTimerRef.current = null;
        if (
          status !== "active"
          || !voiceThinking
          || agentMode === "speaking"
          || userSpeaking
          || (isNative && !nativeInputActivityAvailable)
        ) {
          return;
        }
        startPlayback();
      }, ONSET_GRACE_MS);
      return;
    }

    // User speech demands an instant kill; other stops (agent speaking, session
    // ending) may use the gentler fade.
    stopPlayback(userSpeaking);
  }, [agentMode, isNative, nativeInputActivityAvailable, status, stopThinkingAudioPlayback, voiceThinking, userSpeaking]);

  useEffect(() => {
    if (isNative || status !== "active" || isMuted) {
      if (isMuted || status !== "active") {
        inputActivityDetectorRef.current.reset();
        setUserSpeaking(false);
      }
      return;
    }

    setUserSpeaking(true);
    let cancelled = false;
    const interval = window.setInterval(() => {
      const conversation = conversationRef.current;
      if (!conversation) return;
      let level = 0;
      try {
        level = conversation.getInputVolume();
      } catch {
        level = 0;
      }
      if (cancelled) return;
      const active = inputActivityDetectorRef.current.sample(level);
      inputActiveRef.current = active;
      setUserSpeaking((current) => current === active ? current : active);
    }, VOICE_INPUT_SAMPLE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isMuted, isNative, status]);

  useEffect(() => () => {
    stopThinkingAudioPlayback(true);
  }, [stopThinkingAudioPlayback]);

  const playDisconnectChimeOnce = useCallback(() => {
    if (disconnectChimePlayedRef.current) return;
    disconnectChimePlayedRef.current = true;
    if (suppressChimesRef.current) return;
    playDisconnectionChime();
  }, []);

  const emitVoiceDiag = useCallback((stepName: string, detail: string, status: "active" | "done" | "error") => {
    voiceDiagnosticHandlerRef.current?.({ stepName, detail, status });
    if (status === "done" || status === "error") {
      accumulatedVoiceStepsRef.current.push({ name: `voice_${stepName}`, status, detail });
    }
  }, []);

  const maxReconnectAttempts = 3;

  const clearVoiceCaption = useCallback(() => {
    captionTimersRef.current.forEach((timer) => clearTimeout(timer));
    captionTimersRef.current = [];
    captionQueueEndRef.current = 0;
    captionBufferRef.current = { pendingWords: [] };
    setVoiceCaption("");
  }, []);

  const queueVoiceCaption = useCallback((alignment: AudioAlignmentEvent) => {
    const chunk = createVoiceCaptionChunk(alignment);
    if (chunk.words.length === 0) return;

    const now = performance.now();
    const chunkStartsAt = Math.max(captionQueueEndRef.current, now + 80);
    captionQueueEndRef.current = chunkStartsAt + chunk.durationMs;
    const timedWords = chunk.words.map((word) => ({
      ...word,
      atMs: chunkStartsAt + word.atMs,
    }));
    const nextCards = appendVoiceCaptionWords(captionBufferRef.current, timedWords);
    captionBufferRef.current = nextCards.buffer;

    for (const card of nextCards.cards) {
      const delay = Math.max(0, card.atMs - now);
      captionTimersRef.current.push(setTimeout(() => {
        setVoiceCaption(card.text);
      }, delay));
    }

    const queuedEnd = captionQueueEndRef.current;
    const clearDelay = Math.max(0, queuedEnd + 650 - now);
    captionTimersRef.current.push(setTimeout(() => {
      if (captionQueueEndRef.current !== queuedEnd) return;
      const finalCards = flushVoiceCaptionBuffer(captionBufferRef.current);
      captionBufferRef.current = finalCards.buffer;
      const finalCard = finalCards.cards[0];
      if (finalCard) {
        setVoiceCaption(finalCard.text);
        captionTimersRef.current = [setTimeout(clearVoiceCaption, VOICE_CAPTION_FINAL_HOLD_MS)];
        return;
      }
      setVoiceCaption("");
      captionTimersRef.current = [];
      captionQueueEndRef.current = 0;
      captionBufferRef.current = { pendingWords: [] };
    }, clearDelay));
  }, [clearVoiceCaption]);

  const resetEphemeralVoiceState = useCallback((options?: { clearTranscript?: boolean }) => {
    clearVoiceCaption();
    agentModeRef.current = "listening";
    setAgentMode("listening");
    inputActivityDetectorRef.current.reset();
    inputActiveRef.current = false;
    echoAdmissionSequenceRef.current += 1;
    setNativeInputActivityAvailable(false);
    setUserSpeaking(false);
    setVoiceThinking(false);
    activeVoiceToolIdsRef.current.clear();
    setActiveVoiceToolCount(0);
    setUserComposition("");
    lastActivityRef.current = Date.now();

    if (options?.clearTranscript) {
      transcriptRef.current = [];
      setTranscript([]);
    }
  }, [clearVoiceCaption]);

  const setActiveConversationId = useCallback((id: string | null) => {
    const previousId = chatConversationIdRef.current;
    chatConversationIdRef.current = id;
    setActiveConversationIdState(id);

    if (previousId === id) return;

    // Transcript is one session-owned aggregate. Changing its owner and clearing
    // its entries happen together so delayed cleanup is never the correctness
    // boundary between two conversations.
    setTranscriptSessionId(id);
    transcriptRef.current = [];
    setTranscript([]);
    setUserComposition("");
    log.debug("VOICE:TRANSCRIPT:OWNER_CHANGED", {
      previousSessionId: previousId,
      nextSessionId: id,
    });
  }, []);

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);

  useEffect(() => {
    if (phasePersisted && status === "active") {
      log.debug("VOICE:CONNECTION_PHASES:CLEARED", { reason: "persisted_active" });
      setConnectionPhases([]);
    }
  }, [phasePersisted, status]);

  useEffect(() => {
    return () => {
      if (conversationRef.current) {
        try { conversationRef.current.endSession(); } catch (err: unknown) { log.warn("VOICE:CLEANUP:END_SESSION_FAILED", toBoundedLogError(err)); }
        conversationRef.current = null;
      }
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (listInvalidationTimerRef.current) {
        clearTimeout(listInvalidationTimerRef.current);
        listInvalidationTimerRef.current = null;
      }
      if (disconnectGraceTimerRef.current) {
        clearTimeout(disconnectGraceTimerRef.current);
        disconnectGraceTimerRef.current = null;
      }
      if (reconnectVisibilityCleanupRef.current) {
        reconnectVisibilityCleanupRef.current();
        reconnectVisibilityCleanupRef.current = null;
      }
      if (nativeListenerCleanupRef.current) {
        nativeListenerCleanupRef.current();
        nativeListenerCleanupRef.current = null;
      }
    };
  }, []);

  const listInvalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidateVoiceRelatedQueries = useCallback((reason: string) => {
    queryClient.invalidateQueries({ queryKey: ["/api/goals/today"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects/tasks"] });
    if (listInvalidationTimerRef.current) return;
    listInvalidationTimerRef.current = setTimeout(() => {
      listInvalidationTimerRef.current = null;
      emitSessionListChanged(`voice-${reason}`);
    }, 2000);
  }, [queryClient]);

  const startUIRefresh = useCallback(() => {
    if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current);
    refreshIntervalRef.current = setInterval(() => {
      invalidateVoiceRelatedQueries("ui-refresh");
    }, 30000);
  }, [invalidateVoiceRelatedQueries]);

  const stopUIRefresh = useCallback(() => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
  }, []);

  const phoneDiag = useCallback((event: string, details?: Record<string, unknown>, opts?: { critical?: boolean }) => {
    const sendDiag = (retryCount = 0) => {
      try {
        const payload = JSON.stringify({ event, details: details || {} });
        fetch("/api/voice/diagnostic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch((err: unknown) => {
          log.warn("VOICE:DIAGNOSTIC:POST_FAILED", { event, attempt: retryCount + 1, error: safeDiagnosticText(err) });
          if (opts?.critical && retryCount === 0) {
            setTimeout(() => sendDiag(1), 2000);
          }
        });
      } catch (err) {
        log.warn("VOICE:DIAGNOSTIC:SERIALIZATION_FAILED", toBoundedLogError(err));
      }
    };
    sendDiag();
  }, []);

  const reconcileFinalization = useCallback(async (
    convId: string,
    voiceSessionId: string,
  ): Promise<VoiceFinalizationSettlement> => {
    try {
      const response = await fetch(`/api/sessions/${convId}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 404) {
        return { outcome: "not_finalized", reason: "session_not_found" };
      }
      if (!response.ok) {
        return { outcome: "unknown", reason: `reconciliation_http_${response.status}` };
      }
      const session = await parseJsonResponse(response) as {
        status?: unknown;
        voiceSessionId?: unknown;
      } | null;
      if (session?.status === "saved" && session.voiceSessionId === voiceSessionId) {
        return { outcome: "finalized", source: "reconciliation" };
      }
      return {
        outcome: "unknown",
        reason: session?.voiceSessionId === voiceSessionId
          ? `persisted_status_${String(session.status || "missing")}`
          : "voice_finalization_identity_unconfirmed",
      };
    } catch (error) {
      return {
        outcome: "unknown",
        reason: isTransportError(error) ? "reconciliation_transport" : "reconciliation_error",
      };
    }
  }, []);

  const finalizeSession = useCallback(async (
    convId: string,
    sessionId: string | null,
    errorMessage?: string,
    systemSteps?: VoiceFinalizationSystemStep[],
  ): Promise<VoiceFinalizationSettlement> => {
    if (!sessionId) {
      const settlement = { outcome: "unknown", reason: "missing_voice_session_id" } as const;
      log.warn("VOICE:FINALIZE:UNCONFIRMED", settlement);
      toast({
        title: "Save not yet confirmed",
        description: "The conversation may already be saved; confirmation was interrupted.",
      });
      return settlement;
    }

    const request = createVoiceFinalizationRequest({ sessionId, errorMessage, systemSteps });
    const body = JSON.stringify(request);
    let lastUnknownReason = "transport_acknowledgement_lost";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(`/api/sessions/${convId}/voice-finalize`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body,
          keepalive: true,
        });
        const payload = await parseJsonResponse(response);
        if (isVoiceFinalizationResponse(payload)) {
          if (payload.outcome === "finalized") {
            const settlement = {
              outcome: "finalized",
              source: "response",
              replayed: payload.replayed,
            } as const;
            log.info("VOICE:FINALIZE:SETTLED", { attempt, ...settlement });
            emitSessionListChanged("voice-finalize");
            emitSessionChanged(convId, "voice-finalize");
            return settlement;
          }
          if (payload.outcome === "not_finalized") {
            const settlement = { outcome: "not_finalized", reason: payload.reason } as const;
            const error = normalizeClientVoiceSessionError(
              settlement,
              "finalize",
              "VOICE_FINALIZE_NOT_FINALIZED",
              "voice finalize not finalized",
            );
            error.attempt = attempt;
            error.reason = payload.reason;
            log.error(error, clientVoiceSessionLogContext({
              operation: "finalize",
              reason: payload.reason,
              attempt,
            }));
            phoneDiag("finalize_not_finalized", { attempt, reason: payload.reason }, { critical: true });
            toast({
              title: "Session not saved",
              description: "The server could not finalize this voice session.",
              variant: "destructive",
            });
            return settlement;
          }
          lastUnknownReason = payload.reason;
        } else {
          lastUnknownReason = `invalid_response_http_${response.status}`;
        }
      } catch (error) {
        lastUnknownReason = isTransportError(error)
          ? "transport_acknowledgement_lost"
          : "finalization_request_error";
        log.warn("VOICE:FINALIZE:ACK_UNKNOWN", {
          attempt,
          reason: lastUnknownReason,
          error: safeDiagnosticText(error),
        });
      }

      if (attempt === 1) {
        log.debug("VOICE:FINALIZE:RETRY", { attempt: 2, reason: lastUnknownReason });
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    const reconciled = await reconcileFinalization(convId, sessionId);
    if (reconciled.outcome === "finalized") {
      log.info("VOICE:FINALIZE:RECONCILED", reconciled);
      emitSessionListChanged("voice-finalize-reconciled");
      emitSessionChanged(convId, "voice-finalize-reconciled");
      return reconciled;
    }
    if (reconciled.outcome === "not_finalized") {
      const error = normalizeClientVoiceSessionError(
        reconciled,
        "finalize",
        "VOICE_FINALIZE_NOT_FINALIZED",
        "voice finalize not finalized after reconcile",
      );
      error.reason = reconciled.reason;
      log.error(error, clientVoiceSessionLogContext({
        operation: "finalize",
        reason: reconciled.reason,
      }));
      phoneDiag("finalize_not_finalized", reconciled, { critical: true });
      toast({
        title: "Session not saved",
        description: "The saved conversation is no longer available.",
        variant: "destructive",
      });
      return reconciled;
    }

    const settlement = {
      outcome: "unknown",
      reason: `${lastUnknownReason}:${reconciled.reason}`,
    } as const;
    log.warn("VOICE:FINALIZE:UNCONFIRMED", settlement);
    phoneDiag("finalize_unconfirmed", settlement, { critical: true });
    toast({
      title: "Save not yet confirmed",
      description: "The conversation may already be saved; confirmation was interrupted.",
    });
    return settlement;
  }, [phoneDiag, reconcileFinalization, toast]);

  const cleanupSession = useCallback((reason: string, errorMessage?: string) => {
    log.info("VOICE:CLEANUP", { reason, hasError: Boolean(errorMessage) });
    // iOS may throttle React effects after screen lock. Stop the persistent
    // media element synchronously before any asynchronous finalization path.
    stopThinkingAudioPlayback(true);
    reconnectVisibilityCleanupRef.current?.();
    reconnectVisibilityCleanupRef.current = null;
    reconnectInProgressRef.current = false;
    const cid = chatConversationIdRef.current;
    const sid = voiceSessionIdRef.current;
    const steps = accumulatedVoiceStepsRef.current.length > 0 ? [...accumulatedVoiceStepsRef.current] : undefined;
    accumulatedVoiceStepsRef.current = [];
    if (cid) {
      void finalizeSession(cid, sid, errorMessage, steps);
    }
    invalidateVoiceRelatedQueries(`cleanup-${reason}`);
    chatConversationIdRef.current = null;
    voiceSessionIdRef.current = null;
    voiceRequestIdRef.current = null;
    setActiveConversationIdState(null);
    setChatSessionKey(null);
    setConnectionStartTime(null);
    setConnectionPhases([]);
    setPhasePersisted(false);
    resetEphemeralVoiceState();
    setStatus("idle");
    // Tear down native bridge listener if active
    if (nativeListenerCleanupRef.current) {
      nativeListenerCleanupRef.current();
      nativeListenerCleanupRef.current = null;
    }
  }, [finalizeSession, invalidateVoiceRelatedQueries, resetEphemeralVoiceState, stopThinkingAudioPlayback]);

  const applyVoiceStartPhase = useCallback((event: VoiceStartPhaseEvent) => {
    setConnectionPhases((previous) => {
      const exists = previous.some((phase) => phase.name === event.phase);
      const status = event.status === "started" ? "active" : event.status as ConnectionPhaseStatus;
      if (!exists) {
        // A dedicated SSE error frame historically only marked an existing
        // phase. Ordinary phase frames may introduce newly discovered phases.
        if (event.source === "error") return previous;
        const newPhase: ConnectionPhase = { name: event.phase, status, elapsedMs: event.elapsedMs };
        const signedUrlIndex = previous.findIndex((phase) => phase.name === "signed_url");
        if (signedUrlIndex >= 0) {
          const updated = [...previous];
          updated.splice(signedUrlIndex, 0, newPhase);
          return updated;
        }
        return [...previous, newPhase];
      }
      return previous.map((phase) => {
        if (phase.name !== event.phase || phase.status === "done") return phase;
        return { ...phase, status, elapsedMs: event.elapsedMs };
      });
    });
  }, []);

  const handleUserTranscript = useCallback((message: {
    source: string;
    message: string;
    turnId?: string;
    turnKey?: string;
    sequence?: number;
    status: VoiceTranscriptStatus;
    transcriptId?: string;
  }) => {
    const turnId = message.turnId || `voice-user-${Date.now()}`;
    setTranscript((previous) => {
      const mutation = reduceVoiceUserTranscript(previous, {
        message: message.message || "",
        turnId,
        turnKey: message.turnKey,
        sequence: message.sequence,
        status: message.status,
        transcriptId: message.transcriptId,
        timestamp: new Date().toISOString(),
      });
      if (mutation.reason === "committed_duplicate") {
        log.debug("VOICE:TRANSCRIPT:RECENT_DUPLICATE_SKIPPED", {
          messageLength: mutation.messageLength,
          turnId: mutation.turnId,
        });
      }
      return mutation.transcript;
    });
  }, []);

  const attemptReconnect = useCallback((source: string, context: Record<string, unknown>) => {
    if (reconnectInProgressRef.current) {
      log.debug("VOICE:RECONNECT:SKIPPED", { source, reason: "already_in_progress" });
      return;
    }

    const disconnectReason = buildDisconnectReason(
      String(context.closeCode ?? ""),
      String(context.closeReason ?? ""),
      String(context.reason ?? ""),
    );

    if (reconnectAttemptRef.current < maxReconnectAttempts) {
      reconnectInProgressRef.current = true;
      reconnectAttemptRef.current++;
      const attempt = reconnectAttemptRef.current;
      log.debug("VOICE:RECONNECT:TRIGGERED", { source, attempt, maxAttempts: maxReconnectAttempts });
      phoneDiag(`reconnect_scheduled_${source}`, { attempt, ...context });
      emitVoiceDiag("reconnect_attempt", `Connection lost — ${disconnectReason}. Attempt ${attempt}/${maxReconnectAttempts}`, "active");
      // Spec: silent reconnect — keep last live conversational status/visual until exhaustion.
      // Internal retry flag only; do not map to orb "degraded" or "Reconnecting voice…".
      setVoiceThinking(false);
      clearVoiceCaption();
      setPhasePersisted(false);

      const delay = Math.min(1000 * attempt, 3000);
      log.debug("VOICE:RECONNECT:SCHEDULED", { delayMs: delay, attempt });
      retryTimerRef.current = setTimeout(async () => {
        try {
          if (intentionalEndRef.current) {
            log.debug("VOICE:RECONNECT:CANCELLED", { reason: "intentional_end", attempt });
            return;
          }
          if (!isNative && document.visibilityState === "hidden") {
            log.info("VOICE:RECONNECT:DEFERRED_HIDDEN", { attempt });
            const resumeWhenVisible = () => {
              if (document.visibilityState !== "visible") return;
              reconnectVisibilityCleanupRef.current?.();
              reconnectVisibilityCleanupRef.current = null;
              reconnectInProgressRef.current = false;
              reconnectAttemptRef.current = Math.max(0, reconnectAttemptRef.current - 1);
              attemptReconnect(`${source}-foreground`, { ...context, deferredWhileHidden: true });
            };
            reconnectVisibilityCleanupRef.current?.();
            document.addEventListener("visibilitychange", resumeWhenVisible);
            reconnectVisibilityCleanupRef.current = () => document.removeEventListener("visibilitychange", resumeWhenVisible);
            return;
          }
          log.debug("VOICE:RECONNECT:START", { attempt, maxAttempts: maxReconnectAttempts });
          const success = await connectSessionRef.current(true);
          log.debug("VOICE:RECONNECT:RESULT", { attempt, success });
          phoneDiag(`reconnect_result_${source}`, { attempt, success, ...context });
          emitVoiceDiag("reconnect_result", success ? `Voice session resumed successfully (attempt ${attempt})` : `Reconnect failed — ${disconnectReason} (attempt ${attempt})`, success ? "done" : "error");
          if (!success && reconnectAttemptRef.current >= maxReconnectAttempts) {
            log.warn("VOICE:RECONNECT:EXHAUSTED", { attempts: maxReconnectAttempts });
            phoneDiag(`reconnect_exhausted_${source}`, { attempts: maxReconnectAttempts, ...context });
            emitVoiceDiag("reconnect_exhausted", `All ${maxReconnectAttempts} reconnect attempts failed — ${disconnectReason}`, "error");
            setTranscript(prev => [...prev, {
              source: "system" as const,
              message: "Voice session ended — could not reconnect",
              timestamp: new Date().toISOString(),
              status: "committed" as const,
              isError: true,
            }]);
            setVoiceThinking(false);
            const terminalDisconnectError = normalizeClientVoiceSessionError(
              `voice mid-session disconnect: reconnect exhausted after ${maxReconnectAttempts} attempts — ${disconnectReason}`,
              "midsession_disconnect",
              "VOICE_MIDSESSION_DISCONNECT",
              "voice mid-session disconnect: reconnect exhausted",
            );
            log.error(terminalDisconnectError, clientVoiceSessionLogContext({
              operation: "midsession_disconnect",
              phase: String(context.closeCode ?? ""),
              reason: disconnectReason,
              attempt: maxReconnectAttempts,
            }));
            const persistedErrorMsg = "Voice session disconnected unexpectedly. Your conversation has been saved.";
            cleanupSession(`${source}-exhausted`, persistedErrorMsg);
          }
        } finally {
          reconnectInProgressRef.current = false;
        }
      }, delay);
    } else {
      log.warn("VOICE:RECONNECT:MAX_ATTEMPTS", { source, attempts: maxReconnectAttempts });
      phoneDiag(`reconnect_exhausted_${source}`, { attempts: maxReconnectAttempts, ...context });
      emitVoiceDiag("reconnect_exhausted", `All ${maxReconnectAttempts} reconnect attempts failed — ${disconnectReason}`, "error");
      setTranscript(prev => [...prev, {
        source: "system" as const,
        message: "Voice session ended — could not reconnect",
        timestamp: new Date().toISOString(),
        status: "committed" as const,
        isError: true,
      }]);
      setVoiceThinking(false);
      const terminalDisconnectError = normalizeClientVoiceSessionError(
        `voice mid-session disconnect: reconnect exhausted after ${maxReconnectAttempts} attempts — ${disconnectReason}`,
        "midsession_disconnect",
        "VOICE_MIDSESSION_DISCONNECT",
        "voice mid-session disconnect: reconnect exhausted",
      );
      log.error(terminalDisconnectError, clientVoiceSessionLogContext({
        operation: "midsession_disconnect",
        phase: String(context.closeCode ?? ""),
        reason: disconnectReason,
        attempt: maxReconnectAttempts,
      }));
      const persistedErrorMsg = "Voice session ended unexpectedly. Your conversation has been saved.";
      cleanupSession(`${source}-max-reached`, persistedErrorMsg);
    }
  }, [toast, phoneDiag, cleanupSession, emitVoiceDiag, clearVoiceCaption]);

  const handleVoiceDisconnect = useCallback((sessionStartTs: number, details?: Record<string, unknown>) => {
    const elapsed = Date.now() - sessionStartTs;
    const currentMode = agentModeRef.current;
    const turnCount = transcriptRef.current.length;
    const msSinceLastActivity = Date.now() - lastActivityRef.current;
    const reason = (details?.reason || details?.type || "(unknown)") as string;
    const closeCode = String(details?.closeCode ?? details?.code ?? "");
    const closeReason = (details?.closeReason || "") as string;
    const message = (details?.message || "") as string;
    const wasClean = details?.wasClean !== undefined ? String(details.wasClean) : "";
    log.info("VOICE:DISCONNECT", { elapsedMs: elapsed, agentMode: currentMode, turnCount, msSinceLastActivity, intentionalEnd: intentionalEndRef.current, reconnectAttempt: reconnectAttemptRef.current, reason, closeCode, closeReason: closeReason.slice(0, 160), message: message.slice(0, 160), wasClean, detailKeys: Object.keys(details || {}) });
    if (intentionalEndRef.current) {
      playDisconnectChimeOnce();
    }
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    phoneDiag("disconnected", { elapsed, agentMode: currentMode, turnCount, msSinceLastActivity, intentionalEnd: intentionalEndRef.current, reconnectAttempt: reconnectAttemptRef.current, reason, closeCode, closeReason, message, wasClean, chatSessionId: chatConversationIdRef.current || undefined, elevenLabsDetails: details || {} });
    emitVoiceDiag("disconnect", `Disconnected — ${buildDisconnectReason(closeCode, closeReason, reason)}`, "error");
    stopUIRefresh();
    if (intentionalEndRef.current) {
      conversationRef.current = null;
      return;
    }

    const isBargeIn = currentMode === "speaking" && msSinceLastActivity < 5000;
    const isTransientClose = closeCode === "1000" || closeCode === "1001" || wasClean === "true";

    if (isBargeIn || isTransientClose) {
      log.debug("VOICE:DISCONNECT:GRACE_WINDOW", { agentMode: currentMode, msSinceLastActivity, closeCode, wasClean, isBargeIn, isTransientClose });
      phoneDiag("disconnect_grace_window", { isBargeIn, isTransientClose, elapsed, closeCode, currentMode, msSinceLastActivity });
      emitVoiceDiag("grace_window", `Grace window (${isBargeIn ? "barge-in" : "transient"})`, "active");

      if (disconnectGraceTimerRef.current) {
        clearTimeout(disconnectGraceTimerRef.current);
      }
      const disconnectTimestamp = Date.now();
      disconnectGraceTimerRef.current = setTimeout(() => {
        disconnectGraceTimerRef.current = null;
        if (intentionalEndRef.current) {
          log.debug("VOICE:DISCONNECT:GRACE_EXPIRED_INTENTIONAL_END");
          return;
        }
        const activitySinceDisconnect = lastActivityRef.current > disconnectTimestamp;
        if (activitySinceDisconnect && conversationRef.current) {
          log.debug("VOICE:DISCONNECT:GRACE_RECOVERED", { activitySinceDisconnect: true });
          phoneDiag("disconnect_grace_recovered", { isBargeIn, isTransientClose, elapsed, activitySinceDisconnect });
          startUIRefresh();
          return;
        }
        log.debug("VOICE:DISCONNECT:GRACE_EXPIRED_RECONNECT", { reason, closeCode });
        conversationRef.current = null;
        attemptReconnect("disconnect", { reason, closeCode, closeReason, message, elapsed, bargeIn: isBargeIn, transient: isTransientClose });
      }, 2500);
      return;
    }

    conversationRef.current = null;
    attemptReconnect("disconnect", { reason, closeCode, closeReason, message, elapsed });
  }, [phoneDiag, stopUIRefresh, startUIRefresh, attemptReconnect, playDisconnectChimeOnce]);

  const handleVoiceError = useCallback((error: string) => {
    const errorMsg = typeof error === "string" ? error : JSON.stringify(error);
    const normalized = normalizeClientVoiceSessionError(
      errorMsg,
      "sdk_error",
      "VOICE_SDK_ERROR",
      "voice SDK error",
    );
    log.error(normalized, clientVoiceSessionLogContext({
      operation: "sdk_error",
      agentMode: agentModeRef.current,
    }));
    phoneDiag("error", { error: errorMsg, agentMode: agentModeRef.current });
    emitVoiceDiag("error", errorMsg || "Voice error", "error");

    setTranscript(prev => [...prev, {
      source: "system" as const,
      message: errorMsg || "An error occurred in the voice session.",
      timestamp: new Date().toISOString(),
      status: "committed" as const,
      isError: true,
    }]);
    setVoiceThinking(false);

    conversationRef.current = null;
    if (heartbeatIntervalRef.current) { clearInterval(heartbeatIntervalRef.current); heartbeatIntervalRef.current = null; }
    stopUIRefresh();

    if (!intentionalEndRef.current) {
      attemptReconnect("error", { error: errorMsg });
    } else {
      const cid = chatConversationIdRef.current;
      const sid = voiceSessionIdRef.current;
      if (cid) {
        void finalizeSession(cid, sid, `Voice error: ${errorMsg || "An error occurred in the voice session."}`);
      }
      setStatus("idle");
    }
  }, [toast, phoneDiag, stopUIRefresh, attemptReconnect, finalizeSession]);

  const initElevenLabsSession = useCallback(async (
    signedUrl: string,
    isReconnect: boolean,
    overrideOpts?: { agentId?: string; voiceId?: string; sessionId?: string; chatSessionId?: string; systemPrompt?: string; firstMessage?: string; recognitionKeyterms?: string[] },
  ): Promise<Awaited<ReturnType<typeof Conversation.startSession>>> => {
    const sessionStartTs = Date.now();
    const overrideSummary = {
      agentId: overrideOpts?.agentId,
      voiceId: overrideOpts?.voiceId,
      sessionId: overrideOpts?.sessionId,
      chatSessionId: overrideOpts?.chatSessionId,
      firstMessage: overrideOpts?.firstMessage ? `<${overrideOpts.firstMessage.length} chars>` : undefined,
      systemPrompt: overrideOpts?.systemPrompt
        ? `<${overrideOpts.systemPrompt.length} chars>`
        : undefined,
      recognitionKeytermCount: overrideOpts?.recognitionKeyterms?.length || 0,
    };
    log.debug("VOICE:START_SESSION:SIGNED_URL_RECEIVED", { hasSignedUrl: Boolean(signedUrl), isReconnect, overrides: overrideSummary });

    // Skip browser audio warm-up in native mode — native handles audio pipeline
    if (!isNative && !isReconnect) {
      await warmUpAudioPipeline();
    }

    const overridesPayload: {
      agent: { prompt?: { prompt: string }; firstMessage?: string };
      asr?: { keywords: string[] };
      tts: { voiceId?: string };
    } = {
      agent: {},
      ...(overrideOpts?.recognitionKeyterms?.length
        ? { asr: { keywords: overrideOpts.recognitionKeyterms } }
        : {}),
      tts: {
        voiceId: overrideOpts?.voiceId || undefined,
      },
    };
    if (overrideOpts?.systemPrompt) {
      overridesPayload.agent.prompt = { prompt: overrideOpts.systemPrompt };
    }
    if (overrideOpts?.firstMessage) {
      overridesPayload.agent.firstMessage = overrideOpts.firstMessage;
    }
    phoneDiag("session_start_overrides", {
      overrides: {
        agent: overridesPayload.agent,
        tts: overridesPayload.tts,
        asrKeywordCount: overridesPayload.asr?.keywords.length || 0,
      },
      customLlmExtraBody: { sessionId: overrideOpts?.sessionId, chatSessionId: overrideOpts?.chatSessionId },
      isReconnect,
    });

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/voice/diagnostic",
          new Blob([JSON.stringify({
            event: "session_start_overrides_beacon",
            details: {
              overrides: {
                agent: overridesPayload.agent,
                tts: overridesPayload.tts,
                asrKeywordCount: overridesPayload.asr?.keywords.length || 0,
              },
              customLlmExtraBody: { sessionId: overrideOpts?.sessionId, chatSessionId: overrideOpts?.chatSessionId },
              isReconnect,
              ts: new Date().toISOString(),
            },
          })], { type: "application/json" }),
        );
      }
    } catch (err: unknown) {
      log.debug("VOICE:BEACON:SESSION_START_OVERRIDES_FAILED", toBoundedLogError(err));
    }

    // ---------------------------------------------------------------
    // Native bridge path — delegate to React Native via the bridge
    // ---------------------------------------------------------------
    if (isNative) {
      // Clean up any previous native listener
      nativeListenerCleanupRef.current?.();

      // Register persistent listener for native → web voice messages.
      // This stays active for the entire session duration and maps
      // native events to the same state updates the browser SDK callbacks use.
      const unsubscribe = onNativeMessage((msg) => {
        switch (msg.type) {
          case "voice.connected": {
            const elapsed = Date.now() - sessionStartTs;
            connectionEstablishedAtRef.current = Date.now();
            if (!suppressChimesRef.current) playConnectionChime();
            if (wsConnectResolveRef.current) {
              wsConnectResolveRef.current();
              wsConnectResolveRef.current = null;
            }
            log.info("VOICE:NATIVE:CONNECT", { elapsedMs: elapsed, isReconnect });
            phoneDiag("native_connected", { elapsed, isReconnect });

            if (disconnectGraceTimerRef.current) {
              clearTimeout(disconnectGraceTimerRef.current);
              disconnectGraceTimerRef.current = null;
            }

            setStatus("active");
            reconnectAttemptRef.current = 0;
            lastActivityRef.current = Date.now();
            sessionStartTsRef.current = sessionStartTs;
            agentModeRef.current = "listening";
            setAgentMode("listening");
            setUserSpeaking(false);
            setVoiceThinking(false);
            startUIRefresh();

            if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
            heartbeatIntervalRef.current = setInterval(() => {
              const sessionDuration = Date.now() - sessionStartTsRef.current;
              const msSinceLastActivity = Date.now() - lastActivityRef.current;
              const turnCount = transcriptRef.current.length;
              const currentMode = agentModeRef.current;
              phoneDiag("heartbeat", { sessionDuration, agentMode: currentMode, msSinceLastActivity, turnCount });
              if (msSinceLastActivity > 60_000) {
                emitVoiceDiag("session_health", `No activity for ${Math.round(msSinceLastActivity / 1000)}s`, "error");
              }
            }, 30000);

            if (isReconnect) reconnectAttemptRef.current = 0;
            break;
          }
          case "voice.modeChange": {
            lastActivityRef.current = Date.now();
            const newMode = msg.mode === "speaking" ? "speaking" as const : "listening" as const;
            agentModeRef.current = newMode;
            log.debug("VOICE:NATIVE:MODE_CHANGE", { mode: newMode });
            phoneDiag("mode_change", { mode: newMode });
            setAgentMode(newMode);
            if (newMode === "speaking") {
              setVoiceThinking(false);
              activeVoiceToolIdsRef.current.clear();
              setActiveVoiceToolCount(0);
            }
            break;
          }
          case "voice.inputActivity": {
            setNativeInputActivityAvailable(true);
            setUserSpeaking(msg.active);
            break;
          }
          case "voice.userTranscript": {
            lastActivityRef.current = Date.now();
            if (msg.text) {
              if (!firstUserSpeechFiredRef.current) {
                firstUserSpeechFiredRef.current = true;
                const connectedAt = connectionEstablishedAtRef.current;
                const elapsedSinceConnect = connectedAt > 0 ? Date.now() - connectedAt : -1;
                emitVoiceDiag("first_user_speech", `First user speech ${elapsedSinceConnect}ms after connect`, "done");
                phoneDiag("first_user_speech", { elapsedSinceConnect });
              }
              setUserSpeaking(true);
              setUserComposition(msg.isFinal ? "" : msg.text);
              log.debug("VOICE:NATIVE:USER_COMPOSITION", {
                messageLength: msg.text.length,
                providerFinal: msg.isFinal,
              });
            }
            break;
          }
          case "voice.disconnected": {
            handleVoiceDisconnect(sessionStartTs, {
              reason: msg.reason || "disconnected",
              closeCode: String(msg.code ?? ""),
              closeReason: msg.reason || "",
            });
            break;
          }
          case "voice.error": {
            handleVoiceError(msg.message || "Native voice error");
            break;
          }
          case "voice.status": {
            log.debug("VOICE:NATIVE:STATUS", { status: msg.status });
            break;
          }
          case "voice.hostState":
            // Host lifecycle is owned by the provider-level listener so it
            // remains current between voice sessions.
            break;
        }
      });
      nativeListenerCleanupRef.current = unsubscribe;

      // Send voice.start to native layer.
      // Include agentId for WebRTC connection (React Native needs WebRTC,
      // signedUrl is WebSocket-only and won't work in React Native).
      sendToNative({
        type: "voice.start",
        signedUrl,
        agentId: overrideOpts?.agentId,
        voiceId: overrideOpts?.voiceId || null,
        sessionId: overrideOpts?.sessionId || "",
        chatSessionId: overrideOpts?.chatSessionId || null,
        overrides: overridesPayload,
      });

      // Return a proxy that mimics the Conversation API surface used
      // throughout the provider (endSession, setMicMuted, sendUserActivity).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {
        endSession: async () => { sendToNative({ type: "voice.end" }); },
        setMicMuted: (muted: boolean) => { sendToNative({ type: "voice.mute", muted }); },
        sendUserActivity: () => { sendToNative({ type: "voice.userActivity" }); },
      } as any;
    }

    // ---------------------------------------------------------------
    // Browser path — use ElevenLabs SDK directly (unchanged)
    // ---------------------------------------------------------------
    return Conversation.startSession(buildBrowserVoiceStartOptions({
      signedUrl,
      overrides: overridesPayload,
      sessionId: overrideOpts?.sessionId,
      chatSessionId: overrideOpts?.chatSessionId,
      callbacks: {
      onConnect: () => {
        const elapsed = Date.now() - sessionStartTs;
        connectionEstablishedAtRef.current = Date.now();
        if (!suppressChimesRef.current) playConnectionChime();
        if (wsConnectResolveRef.current) {
          wsConnectResolveRef.current();
          wsConnectResolveRef.current = null;
        }
        log.info("VOICE:CONNECT", { elapsedMs: elapsed, isReconnect, wsEstablishmentMs: elapsed });
        phoneDiag("connected", { elapsed, isReconnect, wsEstablishmentMs: elapsed });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon("/api/voice/diagnostic", JSON.stringify({
              event: "ws_establishment_timing",
              details: { wsEstablishmentMs: elapsed, isReconnect, ts: new Date().toISOString() },
            }));
          }
        } catch (err: unknown) { log.debug("VOICE:BEACON:WS_ESTABLISHMENT_TIMING_FAILED", toBoundedLogError(err)); }

        if (disconnectGraceTimerRef.current) {
          log.debug("VOICE:CONNECT:GRACE_RECOVERED", { isReconnect });
          clearTimeout(disconnectGraceTimerRef.current);
          disconnectGraceTimerRef.current = null;
          phoneDiag("disconnect_grace_recovered_onConnect", { elapsed, isReconnect });
        }

        setStatus("active");
        reconnectAttemptRef.current = 0;
        lastActivityRef.current = Date.now();
        sessionStartTsRef.current = sessionStartTs;
        agentModeRef.current = "listening";
        setAgentMode("listening");
        setUserSpeaking(false);
        setVoiceThinking(false);
        startUIRefresh();

        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
        }
        heartbeatIntervalRef.current = setInterval(() => {
          const sessionDuration = Date.now() - sessionStartTsRef.current;
          const msSinceLastActivity = Date.now() - lastActivityRef.current;
          const turnCount = transcriptRef.current.length;
          const currentMode = agentModeRef.current;
          phoneDiag("heartbeat", { sessionDuration, agentMode: currentMode, msSinceLastActivity, turnCount });
          if (msSinceLastActivity > 60_000) {
            emitVoiceDiag("session_health", `No activity for ${Math.round(msSinceLastActivity / 1000)}s`, "error");
          }
        }, 30000);

        if (isReconnect) {
          reconnectAttemptRef.current = 0;
        }
      },
      onDisconnect: (details?: Record<string, unknown>) => {
        handleVoiceDisconnect(sessionStartTs, details);
      },
      onMessage: (message: ElevenLabsMessage) => {
        lastActivityRef.current = Date.now();
        const role = resolveElevenLabsMessageRole(message);
        const transcriptText = message.message?.trim() || "";
        log.debug("VOICE:MESSAGE", { role, messageLength: transcriptText.length });

        if (role === "agent") {
          recentAssistantTextRef.current = transcriptText.slice(-1_200);
          // Assistant transcript remains authoritative through ChatStream.
          log.debug("VOICE:MESSAGE:AGENT_TRANSCRIPT_SKIPPED", { reason: "chatstream_authoritative" });
          return;
        }
        if (role !== "user" || !transcriptText) return;

        const sequence = ++echoAdmissionSequenceRef.current;
        const playbackActive = agentModeRef.current === "speaking";
        const conversation = conversationRef.current;
        void admitVoiceTranscript({
          transcript: transcriptText,
          playbackActive,
          recentAssistantText: recentAssistantTextRef.current,
          canaryEnabled: STRICT_ECHO_ADMISSION_ENABLED,
          interruptPlayback: () => {
            conversation?.sendUserActivity();
            agentModeRef.current = "listening";
            setAgentMode("listening");
          },
          isInputActive: () => inputActiveRef.current,
        }).then((evidence: VoiceEchoAdmissionEvidence) => {
          if (sequence !== echoAdmissionSequenceRef.current) return;
          log.debug("VOICE:ECHO_ADMISSION", {
            outcome: evidence.outcome,
            playbackActive: evidence.playbackActive,
            interruptedPlayback: evidence.interruptedPlayback,
            postInterruptionSpeechMs: evidence.postInterruptionSpeechMs,
            assistantSimilarity: Number(evidence.assistantSimilarity.toFixed(3)),
          });
          phoneDiag("echo_admission", {
            outcome: evidence.outcome,
            playbackActive: evidence.playbackActive,
            interruptedPlayback: evidence.interruptedPlayback,
            postInterruptionSpeechMs: evidence.postInterruptionSpeechMs,
            assistantSimilarity: Number(evidence.assistantSimilarity.toFixed(3)),
          });
          if (evidence.outcome.startsWith("rejected_")) {
            setUserComposition("");
            setUserSpeaking(false);
            return;
          }

          inputActivityDetectorRef.current.corroborate();
          inputActiveRef.current = true;
          setUserSpeaking(true);
          // Canonical committed history remains server-owned via voice_user_transcript.
          setUserComposition("");
          if (!firstUserSpeechFiredRef.current) {
            firstUserSpeechFiredRef.current = true;
            const connectedAt = connectionEstablishedAtRef.current;
            const elapsedSinceConnect = connectedAt > 0 ? Date.now() - connectedAt : -1;
            emitVoiceDiag("first_user_speech", `First user speech ${elapsedSinceConnect}ms after connect`, "done");
            phoneDiag("first_user_speech", { elapsedSinceConnect });
          }
          log.debug("VOICE:MESSAGE:USER_TRANSCRIPT_FINAL", {
            messageLength: transcriptText.length,
          });
        }).catch((error: unknown) => {
          log.warn("VOICE:ECHO_ADMISSION:FAILED_CLOSED", toBoundedLogError(error));
          setUserComposition("");
          setUserSpeaking(false);
        });
      },
      onError: handleVoiceError,
      onAudioAlignment: queueVoiceCaption,
      onModeChange: (mode: { mode: string }) => {
        lastActivityRef.current = Date.now();
        const newMode = mode.mode === "speaking" ? "speaking" : "listening";
        agentModeRef.current = newMode;
        log.debug("VOICE:MODE_CHANGE", { mode: mode.mode });
        phoneDiag("mode_change", { mode: mode.mode });
        setAgentMode(newMode);
        if (newMode === "listening") clearVoiceCaption();
        if (newMode === "speaking") {
          setVoiceThinking(false);
          activeVoiceToolIdsRef.current.clear();
          setActiveVoiceToolCount(0);
        }
      },
      },
    }));
  }, [isNative, toast, phoneDiag, startUIRefresh, handleVoiceDisconnect, handleVoiceError, handleUserTranscript, attemptReconnect, emitVoiceDiag, queueVoiceCaption, clearVoiceCaption]);

  const connectSession = useCallback(async (isReconnect: boolean = false): Promise<boolean> => {
    const fetchStart = Date.now();
    let signedUrlReceived = false;
    try {
      log.debug("VOICE:START_FETCH", { hasChatSessionId: Boolean(chatConversationIdRef.current), isReconnect });
      phoneDiag("start_fetch", { chatSessionId: chatConversationIdRef.current, isReconnect });

      let startData: VoiceStartResponse | null = null;
      const abortController = new AbortController();
      connectAbortRef.current = abortController;
      const requestId = createVoiceStartRequestId();
      voiceRequestIdRef.current = requestId;
      const startRequest = {
        chatSessionId: chatConversationIdRef.current,
        isReconnect,
        requestId,
        onboardingToken,
        clientId: onboardingToken ? undefined : getClientTabId(),
      };
      const transportCallbacks = {
        onPhase: applyVoiceStartPhase,
        onPhasePersisted: setPhasePersisted,
      };

      try {
        startData = await fetchVoiceStartStream(startRequest, abortController.signal, transportCallbacks);
      } catch (sseErr: unknown) {
        if (startData) { /* already got complete data, proceed */ }
        else {
          const sseMsg = getErrorMessage(sseErr);
          if (sseMsg && !sseMsg.includes("Failed to fetch")) {
            throw sseErr;
          }
          startData = await fetchVoiceStartFallback(startRequest);
        }
      }

      if (!startData) throw new Error("No response from voice start");
      signedUrlReceived = true;

      const fetchElapsed = Date.now() - fetchStart;
      log.debug("VOICE:START_RESPONSE", { elapsedMs: fetchElapsed });
      phoneDiag("start_response", { elapsed: fetchElapsed });
      const { signedUrl } = startData;
      sessionPersonaRef.current = startData.persona || sessionPersonaRef.current;
      if (startData.chatSessionKey) {
        setChatSessionKey(startData.chatSessionKey);
        log.debug("VOICE:START_RESPONSE:CHAT_SESSION_KEY", { hasChatSessionKey: true });
      }
      if (startData.sessionId) {
        voiceSessionIdRef.current = startData.sessionId;
        log.debug("VOICE:START_RESPONSE:VOICE_SESSION_ID", { hasVoiceSessionId: true });
      }

      if (isReconnect && startData.serverTranscript) {
        const st = startData.serverTranscript;
        log.debug("VOICE:RECONNECT:SERVER_TRANSCRIPT_APPLIED", { entryCount: st.length });
        const mapped: VoiceTranscriptEntry[] = st
          .filter(m => m.content && m.content.trim())
          .map(m => ({
            source: (m.role === "user" ? "user" : "ai") as "user" | "ai",
            message: m.content,
            timestamp: m.timestamp || new Date().toISOString(),
            status: "committed" as const,
            persona: m.persona || (m.role === "assistant" ? sessionPersonaRef.current || undefined : undefined),
          }));
        if (mapped.length > 0) {
          setTranscript(mapped);
        }
      }

      const conversation = await initElevenLabsSession(signedUrl, isReconnect, {
        agentId: startData.agentId || undefined,
        voiceId: startData.voiceId || undefined,
        sessionId: startData.sessionId || undefined,
        chatSessionId: startData.chatSessionId || undefined,
        firstMessage: startData.firstMessage || undefined,
        recognitionKeyterms: startData.recognitionKeyterms,
      });
      conversationRef.current = conversation;

      if (!isReconnect && connectionEstablishedAtRef.current === 0) {
        await new Promise<void>((resolve, reject) => {
          if (connectionEstablishedAtRef.current > 0) { resolve(); return; }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const finishOk = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            wsConnectResolveRef.current = null;
            resolve();
          };
          wsConnectResolveRef.current = finishOk;
          timer = setTimeout(() => {
            if (wsConnectResolveRef.current !== finishOk) return;
            wsConnectResolveRef.current = null;
            if (connectionEstablishedAtRef.current > 0) {
              resolve();
            } else {
              const err = new Error("ws_open_timeout");
              err.name = "WsOpenTimeout";
              reject(err);
            }
          }, WS_OPEN_TIMEOUT_MS);
        });
      }
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        log.debug("VOICE:CONNECTION:ABORTED", { reason: "abort_error" });
        return false;
      }
      const msg = getErrorMessage(err);
      const normalized = normalizeClientVoiceSessionError(
        err,
        "connection",
        "VOICE_CONNECTION_FAILED",
        "voice connection failed",
      );
      log.error(normalized, clientVoiceSessionLogContext({
        operation: "connection",
        reason: msg.slice(0, 120),
      }));
      phoneDiag("connection_failed", { error: msg });

      if (!isReconnect) {
        const classification = classifyStartFailure(err, { signedUrlReceived });
        const elapsedMs = Date.now() - fetchStart;
        log.warn("VOICE:START_FAILED", { reason: classification.reason, elapsedMs, message: classification.message.slice(0, 300) });
        phoneDiag("start_failed", {
          chatSessionId: chatConversationIdRef.current || undefined,
          voiceSessionId: voiceSessionIdRef.current || undefined,
          reason: classification.reason,
          closeCode: classification.closeCode || "",
          closeReason: classification.closeReason || "",
          message: msg,
          elapsedMs,
          signedUrlReceived,
        }, { critical: true });
        const failedVoiceSessionId = voiceSessionIdRef.current;
        const failedChatSessionId = chatConversationIdRef.current;
        if (failedVoiceSessionId && failedChatSessionId) {
          try {
            const cleanupResponse = await fetch("/api/voice/sessions/start-failed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                sessionId: failedVoiceSessionId,
                chatSessionId: failedChatSessionId,
                reason: classification.reason,
              }),
            });
            if (!cleanupResponse.ok) {
              throw new Error(`voice_start_compensation_http_${cleanupResponse.status}`);
            }
          } catch (cleanupError: unknown) {
            log.warn("VOICE:START_FAILURE_COMPENSATION_FAILED", toBoundedLogError(cleanupError));
          }
        }

        startFailureMessageRef.current = classification.message;

        // Tear down any half-initialized ElevenLabs conversation locally
        if (conversationRef.current) {
          try { await conversationRef.current.endSession(); } catch (e: unknown) { log.warn("VOICE:START_FAILED:LOCAL_TEARDOWN_FAILED", toBoundedLogError(e)); }
          conversationRef.current = null;
        }
        if (wsConnectResolveRef.current) {
          wsConnectResolveRef.current = null;
        }
      }
      return false;
    } finally {
      connectAbortRef.current = null;
    }
  }, [toast, queryClient, phoneDiag, cleanupSession, applyVoiceStartPhase, initElevenLabsSession, onboardingToken]);

  useEffect(() => { connectSessionRef.current = connectSession; }, [connectSession]);

  useEffect(() => {
    if (onboardingToken) return;

    const ownerId = "voiceSession";
    const handlerId = "voiceSessionEvents";
    const sharedWS = acquireSharedWS(ownerId);
    const appliedVoiceEventIds = new Set<string>();
    let lastVoiceEventId: string | null = null;
    let lastVoiceEventTimestamp = 0;

    const resumeVoiceEvents = () => {
      sharedWS.send({
        type: "events.resume",
        ...(lastVoiceEventId ? { afterEventId: lastVoiceEventId } : {}),
        category: "voice",
        ...(chatConversationIdRef.current ? { chatSessionId: chatConversationIdRef.current } : {}),
      });
    };

    const applyVoiceEvent = (event: Record<string, any>) => {
        if (event?.category !== "voice") return;
        const activeChatSessionId = chatConversationIdRef.current;
        const eventChatSessionId = typeof event?.payload?.chatSessionId === "string"
          ? event.payload.chatSessionId
          : null;
        if (!activeChatSessionId || eventChatSessionId !== activeChatSessionId) return;
        const eventId = typeof event.id === "string" ? event.id : null;
        if (eventId && appliedVoiceEventIds.has(eventId)) return;
        if (eventId) {
          appliedVoiceEventIds.add(eventId);
          const eventTimestamp = typeof event.timestamp === "number" ? event.timestamp : 0;
          if (eventChatSessionId === activeChatSessionId && eventTimestamp >= lastVoiceEventTimestamp) {
            lastVoiceEventTimestamp = eventTimestamp;
            lastVoiceEventId = eventId;
          }
          if (appliedVoiceEventIds.size > 500) {
            const oldest = appliedVoiceEventIds.values().next().value;
            if (oldest) appliedVoiceEventIds.delete(oldest);
          }
        }

          if (event?.event === "voice_thinking") {
            const eventChatSessionId = event?.payload?.chatSessionId;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!eventChatSessionId || eventChatSessionId === activeChatSessionId)) {
              setTranscript(prev => {
                const lastEntry = prev[prev.length - 1];
                if (lastEntry && lastEntry.source === "user") return prev;
                return [...prev, {
                  source: "user" as const,
                  message: "…",
                  timestamp: new Date().toISOString(),
                  status: "placeholder" as const,
                }];
              });
              setVoiceThinking(true);
              activeVoiceToolIdsRef.current.clear();
              setActiveVoiceToolCount(0);
              voiceToolHandlerRef.current?.("clear", { callId: "", toolName: "" });
              if (conversationRef.current) {
                try {
                  conversationRef.current.sendUserActivity();
                  log.debug("VOICE:THINKING:USER_ACTIVITY_SENT");
                } catch (err: unknown) {
                  log.warn("VOICE:THINKING:USER_ACTIVITY_FAILED", toBoundedLogError(err));
                }
              }
            }
          }

          if (event?.event === "voice_user_transcript") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              const text = typeof p.text === "string" ? p.text : "";
              // The server event is the canonical coalescer commitment boundary.
              // Only retire compatible composition text so a delayed commit for
              // turn N cannot erase tentative speech already arriving for N+1.
              setUserComposition((current) => compositionMatchesCommit(current, text) ? "" : current);
              if (text.trim()) {
                handleUserTranscript({
                  source: "user",
                  message: text,
                  turnId: typeof p.turnId === "string" ? p.turnId : (typeof p.turn === "number" ? `server-turn-${p.turn}` : undefined),
                  turnKey: typeof p.turnKey === "string" ? p.turnKey : undefined,
                  sequence: typeof p.seq === "number" ? p.seq : undefined,
                  status: "committed",
                });
              }
            }
          }

          if (event?.event === "voice_v3_tool_call") {
            // Live tool-call event from the v3 webhook layer
            // (`recordV3ToolCall` → eventBus → SharedWS). Render a
            // synthetic system entry so the user can see what Sonnet is
            // doing during the turn instead of waiting for end-of-turn
            // persistence + chat-session refetch. The same record is
            // ALSO attached to the assistant message via
            // `persistV3Turn`, so the chat history is unchanged on
            // reload — we just stop the UI from looking frozen.
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              const name = typeof p.name === "string" ? p.name : "";
              const callId = typeof p.callId === "string" ? p.callId : "";
              const isError = !!p.error;
              if (name) {
                const label = isError
                  ? `Tool ${name} failed`
                  : `Called ${name}`;
                setTranscript(prev => {
                  // De-dupe: if the same callId was already rendered (a
                  // re-broadcast on reconnect), skip. Otherwise insert
                  // the tool line BEFORE any in-flight tentative
                  // assistant entry so the visual order matches what
                  // Sonnet did (tool first, then it spoke about the
                  // result).
                  const existing = prev.find(
                    e => e.isToolCall && callId && e.message.includes(callId),
                  );
                  if (existing) return prev;
                  const entry: VoiceTranscriptEntry = {
                    source: "system" as const,
                    message: callId ? `${label} [${callId}]` : label,
                    timestamp: typeof p.timestamp === "string" ? p.timestamp : new Date().toISOString(),
                    status: "committed",
                    isToolCall: true,
                    isError,
                  };
                  const last = prev[prev.length - 1];
                  if (last && last.source === "ai" && last.isTentative) {
                    return [...prev.slice(0, -1), entry, last];
                  }
                  return [...prev, entry];
                });
                lastActivityRef.current = Date.now();
              }
            }
          }

          if (event?.event === "voice_diagnostic") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              const stepName = typeof p.stepName === "string" ? p.stepName : "";
              const detail = typeof p.detail === "string" ? p.detail : undefined;
              const status = (p.status as "active" | "done" | "error") || "done";
              const elapsedMs = typeof p.elapsedMs === "number" ? p.elapsedMs : undefined;
              const turn = typeof p.turn === "number" ? p.turn : undefined;
              if (stepName) {
                voiceDiagnosticHandlerRef.current?.({ stepName, detail, status, elapsedMs, turn });
              }
            }
          }

          if (event?.event === "voice_connection_dropped") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              const detail = typeof p.detail === "string" ? p.detail : "Connection dropped";
              setTranscript(prev => [...prev, {
                source: "system" as const,
                message: detail,
                timestamp: new Date().toISOString(),
                status: "committed" as const,
                isError: true,
              }]);
            }
          }

          if (event?.event === "voice_duplicate_detected") {
            // task-923 step 6 (defense in depth). The server eliminated
            // a duplicate session for this chat — if we're holding two
            // local Conversation objects (an orphan from the silent-9.7s
            // window before the fix shipped, or any future similar
            // race), tear down the older one. We trigger ONLY on this
            // explicit signal, NOT on every reconnect, because
            // attemptReconnect's clean swap legitimately replaces
            // conversationRef.current.
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            const localSessionId = voiceSessionIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              const supersededIds: string[] = Array.isArray(p.supersededSessionIds) ? p.supersededSessionIds : [];
              const primaryId: string | undefined = p.primarySessionId;
              log.warn("VOICE:DUPLICATE_DETECTED", { hasPrimarySessionId: Boolean(primaryId), supersededCount: supersededIds.length, localSessionSuperseded: Boolean(localSessionId && supersededIds.includes(localSessionId)) });
              // If our local session matches one that the server just
              // killed, our Conversation is orphaned — tear it down so
              // we don't keep an audio pipe open against a dead server
              // session.
              if (localSessionId && supersededIds.includes(localSessionId) && conversationRef.current) {
                log.warn("VOICE:DUPLICATE:LOCAL_SUPERSEDED", { action: "teardown_orphan_conversation" });
                try {
                  intentionalEndRef.current = true;
                  conversationRef.current.endSession().catch((err: unknown) => {
                    log.warn("VOICE:DUPLICATE:ORPHAN_END_SESSION_FAILED", toBoundedLogError(err));
                  });
                } catch (err: unknown) {
                  log.warn("VOICE:DUPLICATE:ORPHAN_TEARDOWN_THROW", toBoundedLogError(err));
                }
                conversationRef.current = null;
              }
            }
          }

          if (event?.event === "voice_reconnect_lifecycle") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              if (p.status === "resumed") {
                setTranscript(prev => [...prev, {
                  source: "system" as const,
                  message: "Connection restored",
                  timestamp: new Date().toISOString(),
                  status: "committed" as const,
                  isError: false,
                }]);
              } else if (p.status === "resume_failed_fresh") {
                setTranscript(prev => [...prev, {
                  source: "system" as const,
                  message: "Reconnect failed — starting fresh session",
                  timestamp: new Date().toISOString(),
                  status: "committed" as const,
                  isError: true,
                }]);
              }
            }
          }

          if (event?.event === "voice_tool_start") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              setVoiceThinking(false);
              if (typeof p.callId === "string" && p.callId) {
                activeVoiceToolIdsRef.current.add(p.callId);
                setActiveVoiceToolCount(activeVoiceToolIdsRef.current.size);
              }
              voiceToolHandlerRef.current?.("start", {
                callId: p.callId,
                toolName: p.toolName,
                arguments: p.arguments,
              });
            }
          }

          if (event?.event === "voice_tool_done") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              if (typeof p.callId === "string" && p.callId) {
                activeVoiceToolIdsRef.current.delete(p.callId);
                setActiveVoiceToolCount(activeVoiceToolIdsRef.current.size);
                if (activeVoiceToolIdsRef.current.size === 0) setVoiceThinking(true);
              }
              voiceToolHandlerRef.current?.("done", {
                callId: p.callId,
                toolName: p.toolName,
                result: p.result,
                error: p.error,
              });
            }
          }

          if (event?.event === "voice_tools_cleared") {
            const p = event.payload;
            const activeChatSessionId = chatConversationIdRef.current;
            if (activeChatSessionId && (!p.chatSessionId || p.chatSessionId === activeChatSessionId)) {
              log.debug("VOICE:TOOLS:CLEARED", { reason: String(p.reason || "unknown").slice(0, 80), turn: p.turn });
              activeVoiceToolIdsRef.current.clear();
              setActiveVoiceToolCount(0);
              voiceToolHandlerRef.current?.("clear", { callId: "", toolName: "" });
            }
          }

          if (event?.event === "session_end") {
            log.info("VOICE:SERVER_END_DETECTED", { action: "mark_intentional_end" });
            try { navigator.sendBeacon("/api/voice/diagnostic", new Blob([JSON.stringify({ event: "server_end_detected", details: {} })], { type: "application/json" })); } catch (err: unknown) { log.debug("VOICE:BEACON:SERVER_END_DETECTED_FAILED", toBoundedLogError(err)); }
            intentionalEndRef.current = true;
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
            stopUIRefresh();

            if (conversationRef.current) {
              try { conversationRef.current.endSession(); } catch (err: unknown) { log.warn("VOICE:SERVER_END:END_SESSION_FAILED", toBoundedLogError(err)); }
              conversationRef.current = null;
            }

            cleanupSession("server-end");
          }
      };

    sharedWS.addMessageHandler(handlerId, (message) => {
      try {
        const msg = message as { type?: unknown; event?: unknown; events?: unknown };
        if (msg.type === "event" && msg.event && typeof msg.event === "object") {
          applyVoiceEvent(msg.event as Record<string, any>);
        } else if (msg.type === "history" && Array.isArray(msg.events)) {
          for (const event of msg.events) {
            if (event && typeof event === "object") applyVoiceEvent(event as Record<string, any>);
          }
        }
      } catch (err: unknown) {
        const normalized = normalizeClientVoiceSessionError(
          err,
          "event_ws",
          "VOICE_EVENT_WS_MESSAGE_FAILED",
          "voice event websocket message processing failed",
        );
        log.error(normalized, clientVoiceSessionLogContext({ operation: "event_ws" }));
      }
    });
    sharedWS.addOpenHandler(handlerId, resumeVoiceEvents);
    if (sharedWS.getReadyState() === WebSocket.OPEN) resumeVoiceEvents();

    return () => {
      sharedWS.removeMessageHandler(handlerId);
      sharedWS.removeOpenHandler(handlerId);
      releaseSharedWS(ownerId);
    };
  }, [queryClient, stopUIRefresh, finalizeSession, cleanupSession, playDisconnectChimeOnce, onboardingToken]);

  const startSession = useCallback(async () => {
    if (!isNative && document.visibilityState === "hidden") {
      log.warn("VOICE:START_SESSION:IGNORED", { reason: "document_hidden" });
      return;
    }
    // Synchronous guard. Set BEFORE any async work or React state updates
    // so a second invocation in the same React tick observes the flag and
    // bails — this is the part that can't rely on `status !== "idle"`
    // (a state setter) or any later check, both of which are async.
    if (isStartingRef.current) {
      log.warn("VOICE:START_SESSION:IGNORED", { reason: "already_starting" });
      return;
    }
    if (conversationRef.current) {
      log.warn("VOICE:START_SESSION:IGNORED", { reason: "conversation_exists" });
      return;
    }
    isStartingRef.current = true;
    if (!isNative) {
      unlockVoiceAudioContext();
    }

    resetEphemeralVoiceState({ clearTranscript: true });
    setStatus("connecting");
    void setVisibilityLayer(0);
    // Arm the one-shot black voice entrance at the real start. Both browser and
    // native voice flow through startSession, so this is the single canonical
    // place the entrance is armed; reconnects never pass here.
    setVoiceEntrancePending(true);
    setConnectionPhases(INITIAL_PHASES.map(p => ({ ...p })));
    setConnectionStartTime(Date.now());
    setPhasePersisted(false);
    reconnectAttemptRef.current = 0;
    intentionalEndRef.current = false;
    accumulatedVoiceStepsRef.current = [];
    firstUserSpeechFiredRef.current = false;
    connectionEstablishedAtRef.current = 0;
    startFailureMessageRef.current = null;
    disconnectChimePlayedRef.current = false;

    try {
      log.info("VOICE:START_SESSION:INITIATED");
      const success = await connectSession(false);
      if (!success) {
        throw new Error(startFailureMessageRef.current || "Could not establish voice session");
      }
      log.info("VOICE:START_SESSION:SUCCEEDED");
    } catch (err: unknown) {
      if ((err instanceof Error && err.name === "AbortError") || intentionalEndRef.current) {
        log.info("VOICE:START_SESSION:CANCELLED", { reason: "intentional_or_abort" });
        return;
      }
      const rawMsg = getErrorMessage(err);
      const userMsg = startFailureMessageRef.current || rawMsg || "Could not start voice session";
      startFailureMessageRef.current = null;
      const normalized = normalizeClientVoiceSessionError(
        err,
        "start_session",
        "VOICE_START_SESSION_FAILED",
        "voice start session failed",
      );
      log.error(normalized, clientVoiceSessionLogContext({
        operation: "start_session",
        reason: rawMsg.slice(0, 120),
      }));
      if (!onboardingToken) {
        toast({ title: "Failed to Start", description: userMsg, variant: "destructive" });
      }
      resetEphemeralVoiceState();
      setStatus("idle");
      setConnectionPhases([]);
      setConnectionStartTime(null);
    } finally {
      isStartingRef.current = false;
    }
  }, [connectSession, toast, resetEphemeralVoiceState]);

  const endSession = useCallback(async () => {
    if (disconnectGraceTimerRef.current) {
      clearTimeout(disconnectGraceTimerRef.current);
      disconnectGraceTimerRef.current = null;
    }
    if (reconnectVisibilityCleanupRef.current) {
      reconnectVisibilityCleanupRef.current();
      reconnectVisibilityCleanupRef.current = null;
    }
    if (connectAbortRef.current) {
      log.info("VOICE:END_SESSION:ABORT_IN_FLIGHT_CONNECTION");
      connectAbortRef.current.abort();
      connectAbortRef.current = null;
      if (!conversationRef.current) {
        intentionalEndRef.current = true;
        setConnectionStartTime(null);
        setStatus("idle");
        return;
      }
    }
    if (conversationRef.current) {
      log.info("VOICE:END_SESSION:INITIATED", { reason: "user" });
      intentionalEndRef.current = true;
      stopThinkingAudioPlayback(true);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      if (heartbeatIntervalRef.current) { clearInterval(heartbeatIntervalRef.current); heartbeatIntervalRef.current = null; }
      stopUIRefresh();
      setStatus("ending");
      playDisconnectChimeOnce();
      try { await conversationRef.current.endSession(); } catch (err: unknown) { log.warn("VOICE:END_SESSION:CLEANUP_FAILED", toBoundedLogError(err)); }
      conversationRef.current = null;

      cleanupSession("user-end");
    }
  }, [queryClient, stopUIRefresh, finalizeSession, cleanupSession, playDisconnectChimeOnce, stopThinkingAudioPlayback]);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
    transcriptRef.current = [];
  }, []);

  const addTranscriptEntry = useCallback((entry: VoiceTranscriptEntry) => {
    setTranscript(prev => [...prev, entry]);
  }, []);

  const consumeVoiceEntrance = useCallback(() => {
    setVoiceEntrancePending(false);
  }, []);

  const toggleMute = useCallback(() => {
    if (conversationRef.current) {
      const newMuted = !isMuted;
      conversationRef.current.setMicMuted(newMuted);
      setIsMuted(newMuted);
    }
  }, [isMuted]);

  const latestMessage = transcript.length > 0 ? transcript[transcript.length - 1] : null;

  const visualState = useMemo<AgentVisualState>(() => {
    // In-progress reconnect is not user-facing degraded theater while attempts remain.
    if (status === "reconnecting") {
      if (agentMode === "speaking") return "speaking";
      if (activeVoiceToolCount > 0) return "tool_call";
      if (voiceThinking) return "thinking";
      return "listening";
    }
    if (status !== "active") return "idle";
    if (agentMode === "speaking") return "speaking";
    if (activeVoiceToolCount > 0) return "tool_call";
    if (voiceThinking) return "thinking";
    return "listening";
  }, [activeVoiceToolCount, agentMode, status, voiceThinking]);

  const readAudioLevel = useCallback((): number => {
    if (isNative || status !== "active") return 0;
    const conversation = conversationRef.current;
    if (!conversation) return 0;

    try {
      // ElevenLabs owns the live WebAudio graph. These methods expose its
      // mic/TTS AnalyserNode data, so visualization never opens a second stream.
      const frequencyData = agentModeRef.current === "speaking"
        ? conversation.getOutputByteFrequencyData()
        : conversation.getInputByteFrequencyData();
      if (frequencyData.length > 0) {
        let energy = 0;
        for (const bin of frequencyData) {
          const normalized = bin / 255;
          energy += normalized * normalized;
        }
        return Math.min(1, Math.sqrt(energy / frequencyData.length) * 2.4);
      }
      const volume = agentModeRef.current === "speaking"
        ? conversation.getOutputVolume()
        : conversation.getInputVolume();
      return Math.max(0, Math.min(1, volume));
    } catch {
      return 0;
    }
  }, [isNative, status]);

  const setVoiceToolHandler = useCallback((handler: ((action: VoiceToolEventAction, payload: VoiceToolEventPayload) => void) | null) => {
    voiceToolHandlerRef.current = handler;
  }, []);

  const setVoiceDiagnosticHandler = useCallback((handler: ((payload: VoiceDiagnosticPayload) => void) | null) => {
    voiceDiagnosticHandlerRef.current = handler;
  }, []);

  const value = useMemo<VoiceSessionContextValue>(() => ({
    status,
    agentMode,
    userSpeaking,
    isMuted,
    transcript,
    userComposition,
    transcriptSessionId,
    voiceThinking,
    voiceCaption,
    visualState,
    voiceEntrancePending,
    consumeVoiceEntrance,
    isHostForeground,
    readAudioLevel,
    startSession,
    endSession,
    toggleMute,
    latestMessage,
    setActiveConversationId,
    clearTranscript,
    activeConversationId,
    chatSessionKey,
    connectionPhases,
    connectionStartTime,
    phasePersisted,
    setVoiceThinking,
    addTranscriptEntry,
    setVoiceToolHandler,
    setVoiceDiagnosticHandler,
  }), [status, agentMode, userSpeaking, isMuted, transcript, userComposition, transcriptSessionId, voiceThinking, voiceCaption, visualState, voiceEntrancePending, consumeVoiceEntrance, isHostForeground, readAudioLevel, startSession, endSession, toggleMute, latestMessage, setActiveConversationId, clearTranscript, activeConversationId, chatSessionKey, connectionPhases, connectionStartTime, phasePersisted, setVoiceThinking, addTranscriptEntry, setVoiceToolHandler, setVoiceDiagnosticHandler]);

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}
