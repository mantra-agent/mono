// Use createLogger for logging ONLY
import { useState, useRef, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createLogger } from "@/lib/logger";

const log = createLogger("VoiceStreaming");
import { emitSessionChanged } from "@/hooks/use-data-sync";

interface VoiceSessionHandle {
  status: string;
  chatSessionKey: string | null;
  activeConversationId: string | null;
  connectionPhases?: Array<{ name: string; status: string; elapsedMs?: number }>;
  phasePersisted?: boolean;
  clearTranscript: () => void;
  setActiveConversationId: (id: string) => void;
  startSession: () => void;
  endSession: () => Promise<void>;
  toggleMute: () => void;
  isMuted: boolean;
  agentMode?: string;
  transcript: Array<{ source: string; message: string }>;
  voiceThinking?: boolean;
  setVoiceThinking?: (v: boolean) => void;
  addTranscriptEntry?: (entry: { source: "user" | "ai" | "system"; message: string; timestamp: string; isError?: boolean }) => void;
  setVoiceToolHandler?: (handler: ((action: "start" | "done" | "clear", payload: { callId: string; toolName: string; arguments?: Record<string, unknown>; result?: string; error?: boolean | string }) => void) | null) => void;
  setVoiceDiagnosticHandler?: (handler: ((payload: { stepName: string; detail?: string; status?: "active" | "done" | "error"; elapsedMs?: number; turn?: number; timestamp?: number }) => void) | null) => void;
}

export function useVoiceStreaming(
  voiceSession: VoiceSessionHandle | null | undefined,
  activeSessionId: string | null,
) {
  const queryClient = useQueryClient();
  const voiceActive = !!(
    voiceSession &&
    activeSessionId &&
    voiceSession.activeConversationId === activeSessionId &&
    voiceSession.status !== "idle"
  );
  const voiceActiveRef = useRef(false);
  voiceActiveRef.current = voiceActive;

  // Show voice tools briefly after a voice turn completes
  const [showVoiceTools, setShowVoiceTools] = useState(false);
  const voiceToolsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setShowVoiceToolsSafe = useCallback((value: boolean) => {
    if (voiceToolsTimeoutRef.current) {
      clearTimeout(voiceToolsTimeoutRef.current);
      voiceToolsTimeoutRef.current = null;
    }
    setShowVoiceTools(value);
    if (value) {
      voiceToolsTimeoutRef.current = setTimeout(() => {
        log.debug("showVoiceTools zombie cleanup after 60s");
        setShowVoiceTools(false);
        voiceToolsTimeoutRef.current = null;
      }, 60_000);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (voiceToolsTimeoutRef.current) clearTimeout(voiceToolsTimeoutRef.current);
    };
  }, []);

  // Auto-hide voice tools when voice becomes idle
  useEffect(() => {
    if (!voiceActive && showVoiceTools) {
      const timer = setTimeout(() => setShowVoiceToolsSafe(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [voiceActive, showVoiceTools, setShowVoiceToolsSafe]);

  // Stub ref — consumers still reference this for step insert positioning
  const voiceStepsInsertIndexRef = useRef<number>(-1);

  const handleVoiceEnd = useCallback(async () => {
    if (!voiceSession) return;
    await voiceSession.endSession();
    if (activeSessionId) {
      emitSessionChanged(activeSessionId, "voice-cleanup");
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", activeSessionId] });
    }
  }, [voiceSession, activeSessionId, queryClient]);

  return {
    voiceActive,
    voiceActiveRef,
    showVoiceTools,
    setShowVoiceToolsSafe,
    voiceStepsInsertIndexRef,
    handleVoiceEnd,
  };
}
