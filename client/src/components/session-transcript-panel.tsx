// Use createLogger for logging ONLY
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  MoreHorizontal,
  BookOpen,
  Users,
  Target,
  StickyNote,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLinkedEntities, type LinkedEntity } from "@/hooks/use-linked-entities";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSessionActionsMenuItems } from "@/components/session-actions-menu";
import { EditableSessionTitle, type EditableSessionTitleHandle } from "@/components/editable-session-title";
import { SessionDetailsModal } from "@/components/session-details-modal";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { deleteSessionTree, getSessionDeletionDescription } from "@/lib/session-deletion";
import {
  type ChatMessage as Message,
} from "@/components/chat-shared";
import type { QuestionResponseMeta } from "@shared/models/chat";
import type { SessionStreamMap, SessionStreamState } from "@/hooks/use-session-subscription";
import { initialStreamingContent, type StreamingContent } from "@shared/streaming-types";
import { useFocusSessionOptional } from "@/hooks/use-focus-session";
import { emitSessionListChanged, emitSessionChanged } from "@/hooks/use-data-sync";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { useVoiceStreaming } from "@/hooks/use-voice-streaming";
import { SessionTranscriptSurface } from "@/components/session-transcript-surface";
import type { ChatSession as Session } from "@shared/models/chat";
import { useVoiceSessionOptional } from "@/hooks/use-voice-session";
import { usePinnedScroll } from "@/hooks/use-pinned-scroll";
import { useQuestionResponse, useQuestionCancel } from "@/hooks/use-question-response";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { ChatEmptyState } from "@/components/chat-empty-state";
import {
  buildTranscriptProjection,
  sortMessagesByCreatedAt,
  summarizeMessageIds,
  computeStreamingRevision,
  type FrozenStreamHandoff,
} from "@/lib/transcript-projection";

const log = createLogger("SessionTranscriptPanel");

function questionToolCallIdsFromToolCalls(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const ids: string[] = [];
  for (const rawCall of toolCalls) {
    if (!rawCall || typeof rawCall !== "object") continue;
    const call = rawCall as Record<string, unknown>;
    if (call.toolName === "question" && typeof call.toolCallId === "string") {
      ids.push(call.toolCallId);
    }
  }
  return ids;
}

function questionToolCallIdsFromStreaming(streaming: StreamingContent): string[] {
  return Array.from(new Set(streaming.segments.flatMap((segment) =>
    segment.type === "timeline"
      ? questionToolCallIdsFromToolCalls(segment.steps)
      : [],
  )));
}

const ENTITY_CHIP_STYLES: Record<
  LinkedEntity["kind"],
  { label: string; icon: typeof BookOpen; className: string; iconColor: string }
> = {
  library: {
    label: "Page",
    icon: BookOpen,
    className:
      "border-info/20 text-info-foreground hover:bg-info/10",
    iconColor: "text-info-foreground",
  },
  person: {
    label: "Person",
    icon: Users,
    className:
      "border-success/20 text-success-foreground hover:bg-success/10",
    iconColor: "text-success-foreground",
  },
  goal: {
    label: "Goal",
    icon: Target,
    className:
      "border-warning/20 text-warning-foreground dark:text-warning hover:bg-warning/10 dark:hover:bg-warning/10",
    iconColor: "text-warning-foreground",
  },
  note: {
    label: "Note",
    icon: StickyNote,
    className:
      "border-cat-ai/30 text-cat-ai-foreground hover:bg-cat-ai/15",
    iconColor: "text-cat-ai-foreground",
  },
};

export interface SessionTranscriptPanelProps {
  activeSession: string | null;
  setActiveSession: (id: string | null) => void;
  composing: boolean;
  setComposing: (v: boolean) => void;
  sessions: Session[];
  voice: ReturnType<typeof useVoiceStreaming>;
  /** Server-authoritative session streaming state — single subscription lifted from parent. */
  sessionSub: SessionStreamState;
  /** Parent-owned stream cache for live sessions. Child widgets read from this instead of opening duplicate WS subscriptions. */
  sessionStreams?: SessionStreamMap;
  /** Variant of the panel. "widget" uses compact styling suited for the floating Focus widget. */
  mode?: "full" | "widget";
  /** Optional callback fired when a topic menu item is clicked. */
  /** Override of the empty-state message. Useful for the Focus widget. */
  emptyStateMessage?: React.ReactNode;
  /** When set in widget mode, suppresses the mobile-only back row and the desktop
   *  full-page styling — the parent renders its own chrome around the panel. */
  showBackButton?: boolean;
  /** Optional controls rendered immediately before the titlebar menu. */
  titlebarActions?: ReactNode;
  /** Archive the active session through the parent-owned session menu mutation. */
  onArchiveSession?: (id: string) => void;
  /** Toggle the active session's pinned state through the parent-owned mutation. */
  onTogglePinSession?: (id: string, pinned: boolean) => void;
  /** Called after a reminder is set for the active session. */
  onSessionReminderSet?: (id: string) => void;
  /**
   * Owns whether this panel may imperatively pin its message scroller.
   * Full-page transcript enables this by default; embedded/widget surfaces opt in
   * explicitly when their container should follow active chat turns.
   */
  enableAutoScroll?: boolean;
}

export function SessionTranscriptPanel({
  activeSession,
  setActiveSession,
  composing,
  setComposing,
  sessions,
  voice,
  sessionSub,
  sessionStreams,
  mode = "full",
  emptyStateMessage,
  showBackButton = true,
  titlebarActions,
  onArchiveSession,
  onTogglePinSession,
  onSessionReminderSet,
  enableAutoScroll = mode !== "widget",
}: SessionTranscriptPanelProps) {
  const { toast } = useToast();
  const voiceSession = useVoiceSessionOptional();
  const isWidget = mode === "widget";
  const panelInstanceIdRef = useRef(`panel-${Math.random().toString(36).slice(2, 10)}`);
  const sessionTitleById = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  // BottomBar is the sole normal composer. It writes pending turns into the
  // shared FocusSession context; SessionTranscriptPanel only reads them so the transcript
  // anchor stays correct during the optimistic phase.
  const focusCtx = useFocusSessionOptional();
  const contextPendingTurn = focusCtx?.pendingTurn ?? null;

  const titleRenameRef = useRef<EditableSessionTitleHandle>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDetails, setShowDetails] = useState(false);


  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const previousTraceRef = useRef<{
    sessionId: string | null;
    persistedIds: string[];
    displayIds: string[];
    renderRevision: string | null;
    scrollTop: number | null;
    scrollHeight: number | null;
    clientHeight: number | null;
  } | null>(null);


  // Local refs that replace the old machine prop
  const activeSessionIdRef = useRef<string | null>(activeSession);

  useEffect(() => {
    activeSessionIdRef.current = activeSession;
  }, [activeSession]);

  // When the session transitions to "saved", immediately invalidate the
  // messages query so persisted content replaces streaming segments without
  // waiting for the 5-second refetchInterval poll.
  const prevSessionSubStatus = useRef(sessionSub.status);
  useEffect(() => {
    if (prevSessionSubStatus.current !== "saved" && sessionSub.status === "saved" && activeSession) {
      emitSessionChanged(activeSession, "session-saved");
    }
    prevSessionSubStatus.current = sessionSub.status;
  }, [sessionSub.status, activeSession]);

  // WS connectivity for transport-health banner and voice control bar
  const [wsConnected, setWsConnected] = useState(true);
  useEffect(() => {
    const id = "session-transcript-health";
    const ws = acquireSharedWS(id);
    setWsConnected(ws.getReadyState() === WebSocket.OPEN);
    ws.addOpenHandler(id, () => setWsConnected(true));
    ws.addCloseHandler(id, () => setWsConnected(false));
    ws.addReconnectHandler(id, () => setWsConnected(true));
    return () => {
      ws.removeOpenHandler(id);
      ws.removeCloseHandler(id);
      ws.removeReconnectHandler(id);
      releaseSharedWS(id);
    };
  }, []);

  const {
    voiceActive,
  } = voice;

  const {
    data: sessionData,
    isLoading: msgsLoading,
    isError: msgsError,
    dataUpdatedAt,
  } = useQuery<{
    messages: Message[];
    reviewPlan?: { id: string; pageId: string; status: string } | null;
  } & Session>({
    queryKey: ["/api/sessions", activeSession],
    enabled: !!activeSession,
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
  });

  const ownedSessionData = sessionData?.id === activeSession ? sessionData : undefined;
  const persistedMessages = ownedSessionData?.messages || [];
  const historyCatchupBaselineRef = useRef<{ sessionId: string; dataUpdatedAt: number } | null>(null);
  if (!activeSession) {
    historyCatchupBaselineRef.current = null;
  } else if (historyCatchupBaselineRef.current?.sessionId !== activeSession) {
    const cachedState = queryClient.getQueryState(["/api/sessions", activeSession]);
    const cached = cachedState?.data as { id?: string; messages?: unknown[] } | undefined;
    const hasPrefix = cached?.id === activeSession && Array.isArray(cached.messages) && cached.messages.length > 0;
    historyCatchupBaselineRef.current = hasPrefix
      ? { sessionId: activeSession, dataUpdatedAt: cachedState?.dataUpdatedAt ?? 0 }
      : null;
  }

  useEffect(() => {
    if (!activeSession || historyCatchupBaselineRef.current?.sessionId !== activeSession) return;
    void queryClient.refetchQueries({
      queryKey: ["/api/sessions", activeSession],
      type: "active",
    });
  }, [activeSession]);

  useEffect(() => {
    if (
      !activeSession ||
      sessionSub.handoffPhase !== "durable" ||
      sessionSub.durableRevision === null ||
      (ownedSessionData?.durableRevision ?? 0) >= sessionSub.durableRevision
    ) return;
    log.debug("STREAM:DURABLE_REVISION_REFRESH", {
      activeSession,
      terminalDurableRevision: sessionSub.durableRevision,
      persistedDurableRevision: ownedSessionData?.durableRevision ?? 0,
    });
    queryClient.refetchQueries({
      queryKey: ["/api/sessions", activeSession],
      type: "active",
    });
  }, [activeSession, ownedSessionData?.durableRevision, sessionSub.durableRevision, sessionSub.handoffPhase]);

  useEffect(() => {
    if (!sessionData || sessionData.id === activeSession) return;
    log.warn("SESSION_DATA_OWNER_MISMATCH", {
      activeSession,
      receivedSessionId: sessionData.id,
    });
  }, [activeSession, sessionData]);
  const messages = useMemo(() => sortMessagesByCreatedAt(persistedMessages), [persistedMessages]);

  const linkedEntities = useLinkedEntities(persistedMessages);
  const [, setLocation] = useLocation();
  const navigateToLibraryPage = useCallback((slug: string) => {
    if (!slug) return;
    const targetHash = `library?page=${slug}`;
    if (window.location.pathname === "/info") {
      window.location.hash = targetHash;
    } else {
      setLocation("/info");
      setTimeout(() => { window.location.hash = targetHash; }, 0);
    }
  }, [setLocation]);
  const navigateToNote = useCallback((id: string) => {
    if (!id) return;
    const targetHash = `notes?id=${id}`;
    if (window.location.pathname === "/info") {
      window.location.hash = targetHash;
    } else {
      setLocation("/info");
      setTimeout(() => { window.location.hash = targetHash; }, 0);
    }
  }, [setLocation]);
  const navigateToEntity = useCallback((entity: LinkedEntity) => {
    switch (entity.kind) {
      case "library":
        if (entity.slug) navigateToLibraryPage(entity.slug);
        break;
      case "person":
        setLocation(`/people/${entity.id}`);
        break;
      case "goal":
        setLocation(`/goals/${entity.id}`);
        break;
      case "note":
        navigateToNote(entity.id);
        break;
    }
  }, [navigateToLibraryPage, navigateToNote, setLocation]);
  const activeMenuSession = sessions.find((session) => session.id === activeSession);
  const sessionActionItems = useSessionActionsMenuItems({
    sessionId: activeSession ?? "",
    sessionTitle: activeMenuSession?.title,
    sessionVaultId: activeMenuSession?.vaultId,
    sessionType: activeMenuSession?.type,
    parentSessionId: activeMenuSession?.parentSessionId,
    onRename: () => titleRenameRef.current?.startEditing(),
    onSelectSession: setActiveSession,
    onArchive: (id) => onArchiveSession?.(id),
    onDelete: () => setShowDeleteConfirm(true),
    isArchived: !!activeMenuSession?.archivedAt,
    isPinned: !!activeMenuSession?.isPinned,
    onTogglePin: onTogglePinSession,
    onReminderSet: onSessionReminderSet,
    onOpenInParent: activeMenuSession?.parentSessionId
      ? () => setActiveSession(activeMenuSession.parentSessionId!)
      : undefined,
    onShowDetails: () => setShowDetails(true),
    linkedEntities: isWidget ? [] : linkedEntities,
    onLinkedEntityClick: navigateToEntity,
    testIdPrefix: "menuitem-titlebar",
  });

  const deleteConversation = useMutation({
    mutationFn: (id: string) => deleteSessionTree(id),
    onSuccess: (result) => {
      emitSessionListChanged("delete-mutation");
      if (activeSession && result.deletedSessionIds.includes(activeSession)) {
        setActiveSession(null);
      }
    },
    onError: (err) => {
      toast({ title: "Failed to delete session", description: String(err), variant: "destructive" });
    },
  });

  const renameConversation = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const response = await apiRequest("PATCH", "/api/sessions/" + id, { title });
      return response.json() as Promise<Session>;
    },
    onSuccess: (renamed, { id }) => {
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) => {
        if (!old) return old;
        return old.map((session) => {
          if (session.id !== id) return session;
          const merged = { ...session, ...renamed };
          if (session.status === "streaming" && renamed.status !== "streaming") {
            return { ...merged, status: "streaming", sessionKey: renamed.sessionKey ?? session.sessionKey };
          }
          return merged;
        });
      });
      queryClient.setQueryData<Session>(["/api/sessions", id], (old) => old ? { ...old, ...renamed } : old);
      emitSessionChanged(id, "rename-mutation");
    },
    onError: (err) => {
      toast({ title: "Failed to rename session", description: String(err), variant: "destructive" });
    },
  });

  const clearPendingTurn = useCallback(() => {
    focusCtx?.setPendingTurn(null);
  }, [focusCtx]);

  // --- Transcript projection via pure reducer ---
  const [frozenStreamHandoff, setFrozenStreamHandoff] = useState<FrozenStreamHandoff | null>(null);

  const rawStreaming = sessionSub.streamingContent ?? initialStreamingContent;

  const projection = useMemo(() => {
    return buildTranscriptProjection({
      activeSession,
      persistedMessages: messages,
      rawStreaming,
      persistedSessionStatus: ownedSessionData?.status ?? null,
      subRunActive: sessionSub.runActive,
      subStatus: sessionSub.status,
      subUpdatedAt: sessionSub.updatedAt ?? null,
      pendingTurn: contextPendingTurn,
      postSending: false,
      frozenStreamHandoff,
      persistedDurableRevision: ownedSessionData?.durableRevision ?? 0,
      terminalDurableRevision: sessionSub.durableRevision,
      handoffPhase: sessionSub.handoffPhase,
    });
  }, [activeSession, messages, rawStreaming, ownedSessionData?.status, ownedSessionData?.durableRevision, sessionSub.runActive, sessionSub.status, sessionSub.updatedAt, sessionSub.durableRevision, sessionSub.handoffPhase, contextPendingTurn, frozenStreamHandoff]);

  // --- Side effects driven by projection decisions ---

  // Capture frozen stream handoff when projection says to
  useEffect(() => {
    if (projection.shouldCaptureFrozenHandoff && projection.newFrozenHandoff) {
      setFrozenStreamHandoff(projection.newFrozenHandoff);
    }
  }, [projection.shouldCaptureFrozenHandoff, projection.newFrozenHandoff]);

  // Clear frozen handoff when projection says to
  useEffect(() => {
    if (projection.shouldClearFrozenHandoff) {
      setFrozenStreamHandoff(null);
    }
  }, [projection.shouldClearFrozenHandoff]);

  // Clear pending turn when projection says to
  useEffect(() => {
    if (projection.shouldClearPendingTurn) {
      clearPendingTurn();
    }
  }, [projection.shouldClearPendingTurn, clearPendingTurn]);

  // --- Voice revision appended to render revision for scroll pinning ---
  const voiceTranscriptOwnsSession = voiceSession?.transcriptSessionId === activeSession;
  const voiceRevision = voiceSession && voiceTranscriptOwnsSession
    ? `${voiceSession.status}:${voiceSession.transcript.length}:${voiceSession.voiceThinking ? 1 : 0}`
    : "voice:none";
  const renderRevision = `${projection.renderRevision}::${voiceRevision}`;

  // Destructure projection values for rendering
  const {
    displayMessages,
    displayStreaming,
    isSessionActive,
    renderPendingTurn,
    displayLiveStreamRenderId,
    isStreaming,
  } = projection;
  const revisionCatchingUp =
    sessionSub.handoffPhase === "durable" &&
    sessionSub.durableRevision !== null &&
    (ownedSessionData?.durableRevision ?? 0) < sessionSub.durableRevision;
  const selectCatchupPending =
    !msgsError &&
    historyCatchupBaselineRef.current?.sessionId === activeSession &&
    dataUpdatedAt <= historyCatchupBaselineRef.current.dataUpdatedAt;
  const historyCatchingUp =
    !isStreaming &&
    !msgsLoading &&
    displayMessages.length > 0 &&
    (selectCatchupPending || revisionCatchingUp);

  const questionProjectionTrace = useMemo(() => {
    const persistedCarriers = displayMessages.flatMap((message) =>
      questionToolCallIdsFromToolCalls(message.toolCalls).map((questionToolCallId) => ({
        questionToolCallId,
        messageId: message.id,
        turnId: message.turnId ?? null,
        assistantRunId: message.assistantRunId ?? null,
      })),
    );
    const responseIds = Array.from(new Set(displayMessages.flatMap((message) =>
      message.questionResponse?.questionToolCallId
        ? [message.questionResponse.questionToolCallId]
        : [],
    )));
    const rawStreamQuestionIds = questionToolCallIdsFromStreaming(rawStreaming);
    const displayStreamQuestionIds = questionToolCallIdsFromStreaming(displayStreaming);
    const questionIds = Array.from(new Set([
      ...persistedCarriers.map((carrier) => carrier.questionToolCallId),
      ...responseIds,
      ...rawStreamQuestionIds,
      ...displayStreamQuestionIds,
    ])).sort();
    return {
      questionIds,
      persistedCarriers,
      responseIds,
      rawStreamQuestionIds,
      displayStreamQuestionIds,
    };
  }, [displayMessages, rawStreaming, displayStreaming]);
  const questionProjectionSignature = JSON.stringify({
    activeSession,
    mode,
    ...questionProjectionTrace,
    subStatus: sessionSub.status,
    subRunActive: sessionSub.runActive,
    handoffPhase: sessionSub.handoffPhase,
    terminalDurableRevision: sessionSub.durableRevision,
    persistedDurableRevision: ownedSessionData?.durableRevision ?? 0,
    frozenRenderId: frozenStreamHandoff?.renderId ?? null,
    captureFrozen: projection.shouldCaptureFrozenHandoff,
    clearFrozen: projection.shouldClearFrozenHandoff,
    displayLiveStreamRenderId,
  });
  const previousQuestionProjectionSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (questionProjectionTrace.questionIds.length === 0) return;
    if (previousQuestionProjectionSignatureRef.current === questionProjectionSignature) return;
    previousQuestionProjectionSignatureRef.current = questionProjectionSignature;
    log.info("QUESTION_TRACE:PROJECTION", {
      panelInstanceId: panelInstanceIdRef.current,
      activeSession,
      mode,
      ...questionProjectionTrace,
      subStatus: sessionSub.status,
      subRunActive: sessionSub.runActive,
      handoffPhase: sessionSub.handoffPhase,
      terminalDurableRevision: sessionSub.durableRevision,
      persistedDurableRevision: ownedSessionData?.durableRevision ?? 0,
      frozenRenderId: frozenStreamHandoff?.renderId ?? null,
      captureFrozen: projection.shouldCaptureFrozenHandoff,
      clearFrozen: projection.shouldClearFrozenHandoff,
      displayLiveStreamRenderId,
      tracedAt: Date.now(),
    });
  }, [
    activeSession,
    mode,
    questionProjectionSignature,
    questionProjectionTrace,
    sessionSub.status,
    sessionSub.runActive,
    sessionSub.handoffPhase,
    sessionSub.durableRevision,
    ownedSessionData?.durableRevision,
    frozenStreamHandoff?.renderId,
    projection.shouldCaptureFrozenHandoff,
    projection.shouldClearFrozenHandoff,
    displayLiveStreamRenderId,
  ]);

  // The visible pending turn for the optimistic user bubble
  const visiblePendingTurn = contextPendingTurn && (
    contextPendingTurn.sessionId === null ||
    contextPendingTurn.sessionId === activeSession ||
    activeSession === null
  ) ? contextPendingTurn : null;

  const questionResponses = useMemo(() => {
    const responses = new Map<string, QuestionResponseMeta>();
    for (const message of messages) {
      if (message.questionResponse) {
        responses.set(message.questionResponse.questionToolCallId, message.questionResponse);
      }
    }
    return responses;
  }, [messages]);

  const submitQuestionResponse = useQuestionResponse({
    sessionId: activeSession,
    toast,
  });

  const cancelQuestion = useQuestionCancel({
    sessionId: activeSession,
    toast,
  });

  const autoScrollEnabled = enableAutoScroll && !!activeSession && !msgsLoading;
  const { onScroll: handleScroll, onUserScrollIntent: handleUserScrollIntent, forcePin } = usePinnedScroll({
    containerRef: scrollContainerRef,
    revision: renderRevision,
    enabled: autoScrollEnabled,
    resetKey: activeSession,
  });

  useEffect(() => {
    if (!autoScrollEnabled) return;
    if (visiblePendingTurn?.clientTurnId) {
      log.verbose(() => `FORCE_PIN_ON_PENDING session=${activeSession} turn=${visiblePendingTurn.clientTurnId}`);
      forcePin();
    }
  }, [activeSession, autoScrollEnabled, forcePin, visiblePendingTurn?.clientTurnId]);

  useLayoutEffect(() => {
    if (!activeSession) return;
    const container = scrollContainerRef.current;
    const persistedIds = messages.map((message) => message.id);
    const displayIds = displayMessages.map((message) => message.id);
    const scrollTop = container?.scrollTop ?? null;
    const scrollHeight = container?.scrollHeight ?? null;
    const clientHeight = container?.clientHeight ?? null;
    const prev = previousTraceRef.current?.sessionId === activeSession ? previousTraceRef.current : null;
    const missingFromDisplay = persistedIds.filter((id) => !displayIds.includes(id));
    const retainedInDisplay = displayIds.filter((id) => !persistedIds.includes(id));
    const disappearedSincePrev = prev?.displayIds.filter((id) => !displayIds.includes(id)) ?? [];
    const appearedSincePrev = displayIds.filter((id) => !(prev?.displayIds ?? []).includes(id));
    const renderRevisionChanged = prev?.renderRevision !== renderRevision;
    const shouldLog =
      renderRevisionChanged ||
      disappearedSincePrev.length > 0 ||
      appearedSincePrev.length > 0 ||
      missingFromDisplay.length > 0 ||
      retainedInDisplay.length > 0;
    if (shouldLog) {
      log.debug("CHAT_TRACE:PANEL_RENDER", {
        activeSession,
        isStreaming,
        hasLiveStreamingState: projection.assistantActivity === "streaming",
        hasFrozenHandoff: projection.assistantActivity === "frozen",
        assistantActivity: projection.assistantActivity,
        pendingTurn: visiblePendingTurn?.clientTurnId ?? null,
        pendingStatus: visiblePendingTurn?.status ?? null,
        streamSource: displayStreaming.source,
        segments: displayStreaming.segments.length,
        persisted: messages.length,
        display: displayMessages.length,
        missingFromDisplay,
        retainedInDisplay,
        disappearedSincePrev,
        appearedSincePrev,
        persistedTail: summarizeMessageIds(messages).slice(-8),
        displayTail: summarizeMessageIds(displayMessages).slice(-8),
        scrollTop,
        scrollHeight,
        clientHeight,
        revChanged: renderRevisionChanged,
      });
    }
    previousTraceRef.current = {
      sessionId: activeSession,
      persistedIds,
      displayIds,
      renderRevision,
      scrollTop,
      scrollHeight,
      clientHeight,
    };
  });


  if (!activeSession) {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background" data-testid={isWidget ? "session-transcript-empty-widget" : "session-transcript-empty"}>
        {composing && showBackButton && (
          <div className="flex items-center gap-2 p-2 border-b md:hidden">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setComposing(false)}
              data-testid="button-back-to-chats-compose"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium">New Session</span>
          </div>
        )}
        <ChatEmptyState
          compact={isWidget}
          className={cn("flex-1", isWidget ? "p-4" : "p-8")}
          message={emptyStateMessage ?? "What's next?"}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 overflow-hidden bg-background">
      <div className={cn("flex items-center gap-2 h-[42px] px-2 py-0 border-b bg-background md:hidden", isWidget && "hidden")}>
        {showBackButton && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => { setActiveSession(null); setComposing(false); }}
            className="md:hidden shrink-0"
            data-testid="button-back-to-chats"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}

        {(() => {
          const activeSessionData = sessions.find(c => c.id === activeSession);
          const titleText = activeSessionData?.title || "Chat";
          const titleIsStreaming = activeSessionData?.status === "streaming" || sessionSub.status === "streaming";
          return (
            <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
              {titleIsStreaming && <ActiveStatusSpinner className="h-3.5 w-3.5" />}
              <EditableSessionTitle
                ref={titleRenameRef}
                title={titleText}
                canEdit={!!activeSession}
                onCommit={(title) =>
                  activeSession && renameConversation.mutate({ id: activeSession, title })
                }
                isStreaming={titleIsStreaming}
                className={cn("min-w-0 flex-shrink", titleIsStreaming && "animate-pulse")}
              />
            </div>
          );
        })()}
        {linkedEntities.length > 0 && !isWidget && (
          <div
            className="hidden md:flex items-center gap-1 overflow-hidden min-w-0"
            data-testid="row-linked-entities"
          >
            {linkedEntities.map((e) => {
              const style = ENTITY_CHIP_STYLES[e.kind];
              const Icon = style.icon;
              return (
                <Button
                  key={`${e.kind}-${e.id}`}
                  size="sm"
                  variant="outline"
                  className={cn(
                    "h-6 px-1.5 text-xs gap-1 shrink-0",
                    style.className,
                  )}
                  onClick={() => navigateToEntity(e)}
                  data-testid={`chip-linked-${e.kind}-${e.id}`}
                  title={`${style.label}: ${e.title}`}
                >
                  {e.emoji ? (
                    <span className="text-xs leading-none">{e.emoji}</span>
                  ) : (
                    <Icon className="h-3 w-3" />
                  )}
                  <span>{e.title}</span>
                </Button>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-1 shrink-0">
          {titlebarActions}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 md:hidden"
                data-testid="button-titlebar-menu"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {activeSession && activeMenuSession ? sessionActionItems : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete conversation</AlertDialogTitle>
                <AlertDialogDescription>
                  {getSessionDeletionDescription(sessions, activeSession)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-titlebar-delete-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    if (activeSession) deleteConversation.mutate(activeSession);
                    setShowDeleteConfirm(false);
                  }}
                  data-testid="button-titlebar-delete-confirm"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {activeSession && (
            <SessionDetailsModal
              sessionId={activeSession}
              open={showDetails}
              onOpenChange={setShowDetails}
              onNavigateSession={(id) => {
                setShowDetails(false);
                setActiveSession(id);
              }}
            />
          )}
        </div>
      </div>
      <SessionTranscriptSurface
        key={activeSession}
        activeSession={activeSession}
        sessionKey={ownedSessionData?.sessionKey}
        reviewPlanId={ownedSessionData?.reviewPlan?.id}
        messages={displayMessages}
        streaming={displayStreaming}
        isSessionStreaming={isStreaming}
        runActive={isSessionActive}
        msgsLoading={msgsLoading}
        historyCatchingUp={historyCatchingUp}
        voiceActive={voiceActive}
        voiceSession={voiceTranscriptOwnsSession ? voiceSession : null}
        voiceStatus={voiceTranscriptOwnsSession ? voiceSession?.status ?? "idle" : "idle"}
        voiceTranscript={voiceTranscriptOwnsSession ? voiceSession?.transcript ?? [] : []}
        voiceThinking={voiceTranscriptOwnsSession ? voiceSession?.voiceThinking ?? false : false}
        sessionTitleById={sessionTitleById}
        pendingTurn={renderPendingTurn}
        optimisticUserTurn={visiblePendingTurn}
        liveStreamRenderId={displayLiveStreamRenderId}
        sessionStreams={sessionStreams}
        wsConnected={wsConnected}
        sessionStatus={ownedSessionData?.status}
        meeting={ownedSessionData?.meeting}
        agenda={ownedSessionData?.agenda}
        sessionTitle={ownedSessionData?.title}
        parentSessionId={ownedSessionData?.parentSessionId}
        parentSessionTitle={ownedSessionData?.parentSessionId ? sessionTitleById[ownedSessionData.parentSessionId] : undefined}
        scrollContainerRef={scrollContainerRef}
        onUserScrollIntent={handleUserScrollIntent}
        onScroll={handleScroll}
        compactReferences={isWidget}
        questionResponses={questionResponses}
        onQuestionSubmit={submitQuestionResponse}
        onQuestionCancel={cancelQuestion}
      />
    </div>
  );
}
