// Use createLogger for logging ONLY
import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createLogger } from "@/lib/logger";
import { markChatAck, markChatSubmitted } from "@/lib/browser-telemetry";

const log = createLogger("ChatSend");
import type { ChatSession, PageContext } from "@shared/models/chat";
import { apiRequest } from "@/lib/queryClient";
import { GATEWAY_STATUS_KEY } from "@/hooks/use-executor-status";
import { applySessionStatusToCache, emitSessionChanged } from "@/hooks/use-data-sync";
import type { useToast } from "@/hooks/use-toast";

export interface PendingChatTurn {
  clientTurnId: string;
  sessionId: string | null;
  submittedAt: string;
  status: "posting" | "streaming";
  content: string;
  hidden?: boolean;
}

export interface UseChatSendDeps {
  toast: ReturnType<typeof useToast>["toast"];
  voiceSession: { clearTranscript: () => void } | null | undefined;
  isAgentRunning: boolean;
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  setComposing: (v: boolean) => void;
  attachedFiles: File[];
  setAttachedFiles: (fn: (prev: File[]) => File[]) => void;
  createSessionPayload?: () => Record<string, unknown>;
  getMessagePageContext?: () => PageContext | undefined;
  /** When provided, pendingTurn state lives externally (e.g. in a shared context)
   *  instead of in a local useState. This allows multiple components to read the
   *  same pendingTurn — the BottomBar writes it, SessionTranscriptPanel reads it. */
  externalPendingTurn?: [PendingChatTurn | null, (turn: PendingChatTurn | null) => void];
}

export function useChatSend(deps: UseChatSendDeps) {
  const queryClient = useQueryClient();
  const {
    toast, voiceSession, isAgentRunning,
    activeSession, setActiveSession, setComposing,
    attachedFiles, setAttachedFiles, createSessionPayload, getMessagePageContext,
    externalPendingTurn,
  } = deps;

  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef(false);
  const [localPendingTurn, setLocalPendingTurn] = useState<PendingChatTurn | null>(null);
  // Use external state when provided (shared context), otherwise local useState.
  const pendingTurn = externalPendingTurn ? externalPendingTurn[0] : localPendingTurn;
  const setPendingTurn = externalPendingTurn ? externalPendingTurn[1] : setLocalPendingTurn;

  const uploadAttachedFiles = useCallback(async (messageText: string, files: File[]): Promise<string> => {
    if (files.length === 0) return messageText;
    try {
      const formData = new FormData();
      files.forEach(f => formData.append("files", f));
      const uploadRes = await fetch("/api/chat/upload", { method: "POST", body: formData });
      if (uploadRes.ok) {
        const { files: uploaded } = await uploadRes.json();
        const parts: string[] = [];
        for (const f of uploaded) {
          if (f.isText && f.content) {
            parts.push(`\n\n--- File: ${f.name} (workspace: ${f.path}) ---\n${f.content.slice(0, 50000)}\n--- End of ${f.name} ---`);
          } else {
            parts.push(`\n\n[Attached file: ${f.name} (workspace: ${f.path}, ${(f.size / 1024).toFixed(1)}KB)]`);
          }
        }
        return messageText + parts.join("");
      }
    } catch (err) {
      log.error("File upload failed:", err);
    }
    return messageText;
  }, []);

  const ensureConversation = useCallback(async (convId: string | null): Promise<string | null> => {
    if (convId) return convId;
    try {
      const extra = createSessionPayload ? createSessionPayload() : {};
      const payload = { title: "New Chat", ...extra };
      const res = await apiRequest("POST", "/api/sessions", payload);
      const newConv: ChatSession = await res.json();
      return newConv.id;
    } catch (err) {
      log.error("ensureConversation failed:", err);
      toast({ title: "Failed to start session", description: String(err), variant: "destructive" });
      return null;
    }
  }, [toast, createSessionPayload]);

  const sendMessage = useCallback(async (text: string): Promise<boolean> => {
    if (!text.trim() || !isAgentRunning || isSending || sendInFlightRef.current) return false;

    // React state is not a concurrency primitive. Flip the ref before any state
    // update or await so repeated UI events in the same tick cannot create
    // multiple logical turns.
    sendInFlightRef.current = true;
    const submittedAt = new Date().toISOString();
    const clientTurnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    log.debug("STREAM:SEND:START", { clientTurnId, sessionId: activeSession, submittedAt, attachedFileCount: attachedFiles.length });
    markChatSubmitted(clientTurnId, activeSession);
    setIsSending(true);
    const messageText = text.trim();
    setPendingTurn({ clientTurnId, sessionId: activeSession, submittedAt, status: "posting", content: messageText });
    voiceSession?.clearTranscript();
    const filesToUpload = [...attachedFiles];
    setAttachedFiles(() => []);
    let admittedSessionId: string | null = null;

    try {
      const fullMessage = await uploadAttachedFiles(messageText, filesToUpload);
      const convId = await ensureConversation(activeSession);
      if (!convId) {
        setPendingTurn(null);
        return false;
      }
      setPendingTurn({ clientTurnId, sessionId: convId, submittedAt, status: "posting", content: fullMessage });

      if (!activeSession) {
        queryClient.setQueryData(
          ["/api/sessions", convId],
          (old: any) => old || { id: convId, title: "New Session", status: "saved", sessionKey: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] },
        );
        queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => {
          const entry = { id: convId, title: "New Session", status: "saved", sessionKey: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as ChatSession;
          if (!old) return [entry];
          if (old.some(c => c.id === convId)) return old;
          return [entry, ...old];
        });
        setActiveSession(convId);
        setComposing(false);
      }

      const pageContext = getMessagePageContext?.();
      admittedSessionId = convId;
      applySessionStatusToCache(convId, "streaming");
      log.debug("STREAM:SEND:STATUS_ADMITTED", { clientTurnId, sessionId: convId });
      const response = await fetch(`/api/sessions/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: fullMessage, clientTurnId, ...(pageContext ? { pageContext } : {}) }),
      });

      if (response.status === 409) {
        setPendingTurn(null);
        toast({ title: "Still working on your previous message", description: "Please wait for the current response to finish.", variant: "default" });
        return false;
      }
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(errBody?.error || "Failed to send message");
      }

      markChatAck(clientTurnId, convId);

      const responseBody = await response.json() as {
        sessionKey?: string;
        streamStartedAt?: string;
        queued?: boolean;
        interrupted?: number;
      };

      // A 202 interrupt response means the user message is durable and the
      // server owns the replacement run. Keep the optimistic turn alive across
      // the old run's terminal snapshot so the next server stream has the right
      // causal anchor instead of falling back to the interrupted turn.
      setPendingTurn({ clientTurnId, sessionId: convId, submittedAt, status: "streaming", content: fullMessage });
      if (response.status === 202 && responseBody.queued) {
        log.info("STREAM:SEND:INTERRUPT_ACCEPTED", {
          clientTurnId,
          sessionId: convId,
          interrupted: responseBody.interrupted ?? 0,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/sessions", convId] });
        queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      }

      const { sessionKey } = responseBody;

      if (sessionKey) {
        // Update session cache with the new sessionKey
        queryClient.setQueryData<ChatSession>(["/api/sessions", convId], (old) =>
          old ? { ...old, sessionKey, status: "streaming" } : old,
        );

        // WS subscription handled by useSessionSubscription — server-side SessionManager manages streaming state
      }

      emitSessionChanged(convId, "message-sent");
      return true;
    } catch (err: any) {
      setPendingTurn(null);
      if (admittedSessionId) {
        queryClient.invalidateQueries({ queryKey: ["/api/sessions", admittedSessionId] });
        queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      }
      log.error("sendMessage failed:", err);
      toast({ title: "Failed to send message", description: err.message, variant: "destructive" });
      return false;
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
      queryClient.invalidateQueries({ queryKey: GATEWAY_STATUS_KEY });
    }
  }, [attachedFiles, activeSession, isAgentRunning, isSending, queryClient, voiceSession, setActiveSession, uploadAttachedFiles, ensureConversation, toast, setAttachedFiles, setComposing, getMessagePageContext]);

  const handleAbort = useCallback(async () => {
    if (!activeSession) return;
    try {
      await fetch(`/api/sessions/${activeSession}/abort`, { method: "POST" });
    } catch (err) {
      log.error("abort request failed:", err);
    }
    emitSessionChanged(activeSession, "aborted");
    queryClient.invalidateQueries({ queryKey: GATEWAY_STATUS_KEY });
  }, [activeSession, queryClient]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachedFiles((prev: File[]) => [...prev, ...Array.from(e.target.files!)]);
    }
  }, [setAttachedFiles]);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev: File[]) => prev.filter((_: File, i: number) => i !== index));
  }, [setAttachedFiles]);

  const addFiles = useCallback((files: File[]) => {
    setAttachedFiles((prev: File[]) => [...prev, ...files]);
  }, [setAttachedFiles]);

  return {
    sendMessage,
    handleAbort,
    handleFileSelect,
    addFiles,
    removeFile,
    isSending,
    pendingTurn,
    clearPendingTurn: () => setPendingTurn(null),
  };
}
