// Use createLogger for logging ONLY
import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { emitSessionListChanged, emitSessionChanged } from "@/hooks/use-data-sync";

import { stripExpressionTags } from "@/components/chat-shared";
import { Conversation } from "@elevenlabs/client";
import type { AgentVisualState } from "@shared/agent-visualizer";
import { createLogger } from "@/lib/logger";
import { buildDisconnectReason } from "@/lib/ws-close-codes";
import {
  createVoiceStartRequestId,
  fetchVoiceStartFallback,
  fetchVoiceStartStream,
  type VoiceStartPhaseEvent,
  type VoiceStartResponse,
} from "@/lib/voice-start-transport";
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

interface TentativeUserTranscriptDebugEvent {
  type: "tentative_user_transcript";
  tentative_user_transcription_event?: {
    user_transcript?: string;
    event_id?: number;
  };
}

function getTentativeUserTranscript(debugEvent: unknown): { text: string; eventId?: number } | null {
  if (!debugEvent || typeof debugEvent !== "object") return null;
  const event = debugEvent as TentativeUserTranscriptDebugEvent;
  if (event.type !== "tentative_user_transcript") return null;
  const text = event.tentative_user_transcription_event?.user_transcript?.trim() || "";
  if (!text) return null;
  return {
    text,
    eventId: event.tentative_user_transcription_event?.event_id,
  };
}

function compositionMatchesCommit(composition: string, committed: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const active = normalize(composition);
  const final = normalize(committed);
  if (!active || !final) return false;
  return active === final || active.startsWith(final) || final.startsWith(active);
}

const WS_OPEN_TIMEOUT_MS = 10_000;

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

export function VoiceSessionProvider({ children }: { children: ReactNode }) {
  const isNative = isNativeVoiceBridge();
  const nativeListenerCleanupRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [agentMode, setAgentMode] = useState<"listening" | "speaking">("listening");
  const [isMuted, setIsMuted] = useState(false);
  const [voiceThinking, setVoiceThinking] = useState(false);
  const [activeVoiceToolCount, setActiveVoiceToolCount] = useState(0);
  const [userSpeaking, setUserSpeaking] = useState(false);
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
  const transcriptRef = useRef<VoiceTranscriptEntry[]>([]);
  const reconnectAttemptRef = useRef(0);
  const intentionalEndRef = useRef(false);
  const connectSessionRef = useRef<(isReconnect: boolean) => Promise<boolean>>(async () => false);
  const connectAbortRef = useRef<AbortController | null>(null);
  const voiceRequestIdRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    // Grace period before the sound may fade in. Fast turns that resolve inside
    // this window never play it at all, so the bed only signals a genuinely long
    // "still processing" pause rather than firing on every turn.
    const ONSET_GRACE_MS = 1000;

    const shouldPlayThinkingAudio =
      status === "active" &&
      voiceThinking &&
      agentMode !== "speaking" &&
      !userSpeaking;

    const startPlayback = () => {
      thinkingAudioPlayingRef.current = true;
      if (isNative) {
        sendToNative({ type: "voice.thinkingAudio", active: true });
      } else {
        startVoiceThinkingLoop();
      }
    };

    const stopPlayback = (immediate: boolean) => {
      if (thinkingAudioGraceTimerRef.current !== null) {
        clearTimeout(thinkingAudioGraceTimerRef.current);
        thinkingAudioGraceTimerRef.current = null;
      }
      if (!thinkingAudioPlayingRef.current) return;
      thinkingAudioPlayingRef.current = false;
      if (isNative) {
        // Native stopThinkingAudioLoop() halts immediately, satisfying barge-in.
        sendToNative({ type: "voice.thinkingAudio", active: false });
      } else {
        stopVoiceThinkingLoop({ immediate });
      }
    };

    if (shouldPlayThinkingAudio) {
      // Already playing or already counting down — don't re-arm the grace timer.
      if (thinkingAudioPlayingRef.current || thinkingAudioGraceTimerRef.current !== null) {
        return;
      }
      thinkingAudioGraceTimerRef.current = setTimeout(() => {
        thinkingAudioGraceTimerRef.current = null;
        startPlayback();
      }, ONSET_GRACE_MS);
      return;
    }

    // User speech demands an instant kill; other stops (agent speaking, session
    // ending) may use the gentler fade.
    stopPlayback(userSpeaking);
  }, [agentMode, isNative, status, voiceThinking, userSpeaking]);

  useEffect(() => () => {
    if (thinkingAudioGraceTimerRef.current !== null) {
      clearTimeout(thinkingAudioGraceTimerRef.current);
      thinkingAudioGraceTimerRef.current = null;
    }
    thinkingAudioPlayingRef.current = false;
    stopVoiceThinkingLoop({ immediate: true });
    if (isNative) sendToNative({ type: "voice.thinkingAudio", active: false });
  }, [isNative]);

  const playDisconnectChimeOnce = useCallback(() => {
    if (disconnectChimePlayedRef.current) return;
    disconnectChimePlayedRef.current = true;
    playDisconnectionChime();
  }, []);

  const emitVoiceDiag = useCallback((stepName: string, detail: string, status: "active" | "done" | "error") => {
    voiceDiagnosticHandlerRef.current?.({ stepName, detail, status });
    if (status === "done" || status === "error") {
      accumulatedVoiceStepsRef.current.push({ name: `voice_${stepName}`, status, detail });
    }
  }, []);

  const maxReconnectAttempts = 3;

  const resetEphemeralVoiceState = useCallback((options?: { clearTranscript?: boolean }) => {
    agentModeRef.current = "listening";
    setAgentMode("listening");
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
  }, []);

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

  const finalizeSession = useCallback((convId: string, sessionId: string | null, retryCount = 0, errorMessage?: string, systemSteps?: Array<{ name: string; status: "done" | "error"; detail?: string }>) => {
    const payload: Record<string, unknown> = {};
    if (sessionId) payload.sessionId = sessionId;
    if (errorMessage) payload.errorMessage = errorMessage;
    if (systemSteps && systemSteps.length > 0) payload.systemSteps = systemSteps;
    const body = Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined;
    fetch(`/api/sessions/${convId}/voice-finalize`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
    })
      .then((res) => {
        if (!res.ok) {
          return res.json().then((data) => {
            throw new Error(data?.error || `HTTP ${res.status}`);
          });
        }
        emitSessionListChanged("voice-finalize");
        emitSessionChanged(convId, "voice-finalize");
      })
      .catch((err: unknown) => {
        const msg = getErrorMessage(err);
        const logFinalizeFailure = retryCount === 0 ? log.warn : log.error;
        logFinalizeFailure("VOICE:FINALIZE:FAILED", { hasConversationId: Boolean(convId), attempt: retryCount + 1, error: msg.slice(0, 300) });
        phoneDiag("finalize_failed", { convId, attempt: retryCount + 1, error: msg }, { critical: true });

        if (retryCount === 0) {
          setTimeout(() => {
            log.debug("VOICE:FINALIZE:RETRY", { hasConversationId: Boolean(convId), attempt: retryCount + 2 });
            finalizeSession(convId, sessionId, 1, errorMessage, systemSteps);
          }, 2000);
        } else {
          toast({
            title: "Session not saved",
            description: "The voice session couldn't be saved cleanly. Your conversation may be incomplete.",
            variant: "destructive",
          });
        }
      });
  }, [queryClient, toast, phoneDiag]);

  const cleanupSession = useCallback((reason: string, errorMessage?: string) => {
    log.info("VOICE:CLEANUP", { reason, hasError: Boolean(errorMessage) });
    reconnectInProgressRef.current = false;
    const cid = chatConversationIdRef.current;
    const sid = voiceSessionIdRef.current;
    const steps = accumulatedVoiceStepsRef.current.length > 0 ? [...accumulatedVoiceStepsRef.current] : undefined;
    accumulatedVoiceStepsRef.current = [];
    if (cid) {
      finalizeSession(cid, sid, 0, errorMessage, steps);
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
  }, [finalizeSession, invalidateVoiceRelatedQueries, resetEphemeralVoiceState]);

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
      setVoiceThinking(false);
      setStatus("reconnecting");
      setPhasePersisted(false);

      const delay = Math.min(1000 * attempt, 3000);
      log.debug("VOICE:RECONNECT:SCHEDULED", { delayMs: delay, attempt });
      retryTimerRef.current = setTimeout(async () => {
        try {
          if (intentionalEndRef.current) {
            log.debug("VOICE:RECONNECT:CANCELLED", { reason: "intentional_end", attempt });
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
      const persistedErrorMsg = "Voice session ended unexpectedly. Your conversation has been saved.";
      cleanupSession(`${source}-max-reached`, persistedErrorMsg);
    }
  }, [toast, phoneDiag, cleanupSession, emitVoiceDiag]);

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
    log.error("VOICE:ERROR", { error: errorMsg.slice(0, 300), agentMode: agentModeRef.current });
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
        finalizeSession(cid, sid, 0, `Voice error: ${errorMsg || "An error occurred in the voice session."}`);
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
            playConnectionChime();
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
            setUserSpeaking(false);
            if (newMode === "speaking") {
              setVoiceThinking(false);
              activeVoiceToolIdsRef.current.clear();
              setActiveVoiceToolCount(0);
            }
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
    return Conversation.startSession({
      signedUrl,
      overrides: overridesPayload,
      customLlmExtraBody: {
        sessionId: overrideOpts?.sessionId,
        chatSessionId: overrideOpts?.chatSessionId,
      },
      // Plumb the active chat session into ElevenLabs so its native LLM
      // can substitute `{{chat_session_id}}` into per-tool request_headers
      // (`X-Chat-Session-Id`). Without this, the v3 webhook never knows
      // which chat the tool call belongs to and `recordV3ToolCall` drops
      // every record silently — the user's session window then shows no
      // tools even though Sonnet successfully called them. Only relevant
      // for v3 (custom LLM paths use customLlmExtraBody instead), but
      // sending it for all engines is harmless.
      dynamicVariables: overrideOpts?.chatSessionId
        ? { chat_session_id: overrideOpts.chatSessionId }
        : undefined,
      // Self-host the audio worklets so we don't race the jsDelivr CDN at
      // call start (cause of the chipmunk first-second + initial pops). The
      // playback worklet here is a vendored fork of the SDK's stock one with
      // a 750ms prebuffer and linear-interpolation resampler; libsamplerate
      // is the unmodified upstream worklet served from our own origin.
      libsampleratePath: "/voice/libsamplerate.worklet.js",
      workletPaths: {
        audioConcatProcessor: "/voice/audioConcatProcessor.worklet.js",
      },
      onConnect: () => {
        const elapsed = Date.now() - sessionStartTs;
        connectionEstablishedAtRef.current = Date.now();
        playConnectionChime();
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
      onMessage: (message: { source: string; message: string }) => {
        lastActivityRef.current = Date.now();
        log.debug("VOICE:MESSAGE", { source: message.source, messageLength: message.message?.length || 0 });
        if (message.source === "user" || message.source === "user_edited") {
          setUserSpeaking(true);
          // ElevenLabs onMessage is the finalized user-transcript boundary.
          // Committed transcript history remains server-owned via voice_user_transcript.
          setUserComposition("");
        }
        if (message.source === "ai") {
          // Assistant transcript arrives via the custom-LLM SSE pipeline (ChatStream).
          // The EL-emitted "ai" message is a duplicate — skip it.
          log.debug("VOICE:MESSAGE:AI_TRANSCRIPT_SKIPPED", { reason: "chatstream_authoritative" });
          return;
        }
        if (!firstUserSpeechFiredRef.current) {
          firstUserSpeechFiredRef.current = true;
          const connectedAt = connectionEstablishedAtRef.current;
          const elapsedSinceConnect = connectedAt > 0 ? Date.now() - connectedAt : -1;
          const detail = elapsedSinceConnect >= 0
            ? `First user speech ${elapsedSinceConnect}ms after connect`
            : "First user speech (connect time unknown)";
          emitVoiceDiag("first_user_speech", detail, "done");
          phoneDiag("first_user_speech", { elapsedSinceConnect });
        }
        if (message.message?.trim()) {
          log.debug("VOICE:MESSAGE:USER_TRANSCRIPT_FINAL", {
            messageLength: message.message.length,
          });
        }
      },
      onError: handleVoiceError,
      onDebug: (debugEvent: unknown) => {
        // @elevenlabs/client 0.14 routes raw tentative_user_transcript wire
        // events through onDebug. Adapt that event into explicit composer state;
        // finalized transcript history still arrives through our server event.
        const tentative = getTentativeUserTranscript(debugEvent);
        if (!tentative) return;
        lastActivityRef.current = Date.now();
        setUserSpeaking(true);
        setUserComposition(tentative.text);
        if (!firstUserSpeechFiredRef.current) {
          firstUserSpeechFiredRef.current = true;
          const connectedAt = connectionEstablishedAtRef.current;
          const elapsedSinceConnect = connectedAt > 0 ? Date.now() - connectedAt : -1;
          const detail = elapsedSinceConnect >= 0
            ? `First user speech ${elapsedSinceConnect}ms after connect`
            : "First user speech (connect time unknown)";
          emitVoiceDiag("first_user_speech", detail, "done");
          phoneDiag("first_user_speech", { elapsedSinceConnect });
        }
        log.debug("VOICE:MESSAGE:USER_COMPOSITION", {
          eventId: tentative.eventId,
          messageLength: tentative.text.length,
        });
      },
      onModeChange: (mode: { mode: string }) => {
        lastActivityRef.current = Date.now();
        const newMode = mode.mode === "speaking" ? "speaking" : "listening";
        agentModeRef.current = newMode;
        log.debug("VOICE:MODE_CHANGE", { mode: mode.mode });
        phoneDiag("mode_change", { mode: mode.mode });
        setAgentMode(newMode);
        setUserSpeaking(false);
        if (newMode === "speaking") {
          setVoiceThinking(false);
          activeVoiceToolIdsRef.current.clear();
          setActiveVoiceToolCount(0);
        }
      },
    });
  }, [isNative, toast, phoneDiag, startUIRefresh, handleVoiceDisconnect, handleVoiceError, handleUserTranscript, attemptReconnect, emitVoiceDiag]);

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

      // Tell the vendored output worklet the actual source sample rate from
      // the server metadata. The SDK's A.create() sends `setFormat` with
      // only the format string ("pcm"/"ulaw") but not the sourceRate. Our
      // vendored worklet defaults to 16kHz, which is correct when the
      // AudioContext also runs at 16kHz. But if Chrome's AudioContext ended
      // up at a different rate (e.g. hardware default 48kHz), the resampling
      // ratio would be wrong without this explicit correction.
      try {
        const conv = conversation as unknown as {
          output?: { worklet?: { port?: MessagePort }; context?: { sampleRate?: number } };
          connection?: { outputFormat?: { sampleRate?: number } };
        };
        const sourceRate = conv?.connection?.outputFormat?.sampleRate;
        const ctxRate = conv?.output?.context?.sampleRate;
        if (sourceRate && conv?.output?.worklet?.port) {
          conv.output.worklet.port.postMessage({ type: "setSourceRate", rate: sourceRate });
          log.debug("VOICE:AUDIO:SOURCE_RATE_SET", { sourceRate, audioContextRate: ctxRate });
        }
      } catch {
        // Non-critical: worklet will use its default source rate
      }

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
      const stack = err instanceof Error ? err.stack : "";
      log.error("VOICE:CONNECTION:FAILED", { error: msg.slice(0, 300), hasStack: Boolean(stack) });
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
  }, [toast, queryClient, phoneDiag, cleanupSession, applyVoiceStartPhase, initElevenLabsSession]);

  useEffect(() => { connectSessionRef.current = connectSession; }, [connectSession]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectAttempts = 0;
    let lastMessageAt = Date.now();
    let lastVoiceEventId: string | null = null;
    let lastVoiceEventTimestamp = 0;
    const appliedVoiceEventIds = new Set<string>();
    let disposed = false;

    const HEARTBEAT_INTERVAL_MS = 15_000;
    const HEARTBEAT_TIMEOUT_MS = 30_000;
    const RECONNECT_BASE_MS = 1_000;
    const RECONNECT_MAX_MS = 10_000;

    const getReconnectDelay = (): number => {
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
      return delay;
    };

    const clearHeartbeat = () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };

    const startHeartbeat = () => {
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const sinceLastMessage = Date.now() - lastMessageAt;
        if (sinceLastMessage >= HEARTBEAT_TIMEOUT_MS) {
          log.warn("VOICE:EVENT_WS:HEARTBEAT_TIMEOUT", { sinceLastMessageMs: sinceLastMessage });
          ws.close();
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = getReconnectDelay();
      log.debug("VOICE:EVENT_WS:RECONNECT_SCHEDULED", { delayMs: delay, attempt: reconnectAttempts + 1 });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempts++;
        connectEventWs();
      }, delay);
    };

    const connectEventWs = () => {
      if (disposed) return;
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);

      ws.onopen = () => {
        log.info("VOICE:EVENT_WS:CONNECTED", { reconnectAttempts });
        reconnectAttempts = 0;
        lastMessageAt = Date.now();
        startHeartbeat();
        ws?.send(JSON.stringify({
          type: "events.resume",
          afterEventId: lastVoiceEventId,
          category: "voice",
          chatSessionId: chatConversationIdRef.current,
        }));
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

      ws.onmessage = (e) => {
        lastMessageAt = Date.now();
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "event" && msg.event) {
            applyVoiceEvent(msg.event);
          } else if (msg.type === "history" && Array.isArray(msg.events)) {
            for (const event of msg.events) applyVoiceEvent(event);
          } else if (msg.type === "events.resume.complete") {
            log.debug("VOICE:EVENT_WS:RESUME_COMPLETE", {
              cursorFound: Boolean(msg.cursorFound),
              replayed: Number(msg.replayed || 0),
            });
          } else if (msg.type === "events.resume.error") {
            log.warn("VOICE:EVENT_WS:RESUME_FAILED", { message: String(msg.message || "unknown") });
          }
        } catch (err: unknown) {
          log.error("VOICE:EVENT_WS:MESSAGE_PROCESSING_FAILED", toBoundedLogError(err));
        }
      };

      ws.onclose = (ev) => {
        log.info("VOICE:EVENT_WS:CLOSED", { code: ev.code, hasReason: Boolean(ev.reason), reason: ev.reason.slice(0, 160) });
        ws = null;
        clearHeartbeat();
        scheduleReconnect();
      };
      ws.onerror = () => { ws?.close(); };
    };

    connectEventWs();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearHeartbeat();
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [queryClient, stopUIRefresh, finalizeSession, cleanupSession, playDisconnectChimeOnce]);

  const startSession = useCallback(async () => {
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
      const stack = err instanceof Error ? err.stack : "";
      log.error("VOICE:START_SESSION:FAILED", { error: rawMsg.slice(0, 300), hasStack: Boolean(stack) });
      toast({ title: "Failed to Start", description: userMsg, variant: "destructive" });
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
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      if (heartbeatIntervalRef.current) { clearInterval(heartbeatIntervalRef.current); heartbeatIntervalRef.current = null; }
      stopUIRefresh();
      setStatus("ending");
      playDisconnectChimeOnce();
      try { await conversationRef.current.endSession(); } catch (err: unknown) { log.warn("VOICE:END_SESSION:CLEANUP_FAILED", toBoundedLogError(err)); }
      conversationRef.current = null;

      cleanupSession("user-end");
    }
  }, [queryClient, stopUIRefresh, finalizeSession, cleanupSession, playDisconnectChimeOnce]);

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
    if (status === "reconnecting") return "degraded";
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
  }), [status, agentMode, userSpeaking, isMuted, transcript, userComposition, transcriptSessionId, voiceThinking, visualState, voiceEntrancePending, consumeVoiceEntrance, isHostForeground, readAudioLevel, startSession, endSession, toggleMute, latestMessage, setActiveConversationId, clearTranscript, activeConversationId, chatSessionKey, connectionPhases, connectionStartTime, phasePersisted, setVoiceThinking, addTranscriptEntry, setVoiceToolHandler, setVoiceDiagnosticHandler]);

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}
