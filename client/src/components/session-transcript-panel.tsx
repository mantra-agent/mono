// Use createLogger for logging ONLY
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Mic,
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
import { SessionActionsMenuItems } from "@/components/session-actions-menu";
import { SessionDetailsModal } from "@/components/session-details-modal";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { deleteSessionTree, getSessionDeletionDescription } from "@/lib/session-deletion";
import {
  type ChatMessage as Message,
} from "@/components/chat-shared";
import type { QuestionResponseMeta } from "@shared/models/chat";
import type { SessionStreamMap, SessionStreamState } from "@/hooks/use-session-subscription";
import { initialStreamingContent } from "@shared/streaming-types";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { useFocusSessionOptional } from "@/hooks/use-focus-session";
import { emitSessionListChanged, emitSessionChanged } from "@/hooks/use-data-sync";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { useVoiceStreaming } from "@/hooks/use-voice-streaming";
import { SessionTranscriptSurface } from "@/components/session-transcript-surface";
import type { ChatSession as Session } from "@shared/models/chat";
import { useVoiceSessionOptional } from "@/hooks/use-voice-session";
import { useWorkflowForSession } from "@/hooks/use-workflow-for-session";
import { usePinnedScroll } from "@/hooks/use-pinned-scroll";
import { useQuestionResponse } from "@/hooks/use-question-response";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { ChatEmptyState } from "@/components/chat-empty-state";
import {
  buildTranscriptProjection,
  sortMessagesByCreatedAt,
  hasCompactionBoundary,
  summarizeMessageIds,
  computeStreamingRevision,
  type FrozenStreamHandoff,
  type TranscriptSnapshot,
} from "@/lib/transcript-projection";

const log = createLogger("SessionTranscriptPanel");

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
  const { data: agentStatus } = useExecutorStatus();
  const isAgentRunning = agentStatus?.status === "running";
  const voiceSession = useVoiceSessionOptional();
  const isWidget = mode === "widget";
  const sessionTitleById = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  // BottomBar is the sole normal composer. It writes pending turns into the
  // shared FocusSession context; SessionTranscriptPanel only reads them so the transcript
  // anchor stays correct during the optimistic phase.
  const focusCtx = useFocusSessionOptional();
  const contextPendingTurn = focusCtx?.pendingTurn ?? null;

  const [isTitleRenaming, setIsTitleRenaming] = useState(false);
  const [titleRenameValue, setTitleRenameValue] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleRenameCommittedRef = useRef(false);
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
    voiceActive, showVoiceTools, voiceStepsInsertIndexRef, handleVoiceEnd,
  } = voice;

  const { data: sessionData, isLoading: msgsLoading } = useQuery<{ messages: Message[] } & Session>({
    queryKey: ["/api/sessions", activeSession],
    enabled: !!activeSession,
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
  });

  const ownedSessionData = sessionData?.id === activeSession ? sessionData : undefined;
  const persistedMessages = ownedSessionData?.messages || [];
  const activeWorkflowId = (ownedSessionData as any)?.activeWorkflow?.id ?? null;

  useEffect(() => {
    if (!sessionData || sessionData.id === activeSession) return;
    log.warn("SESSION_DATA_OWNER_MISMATCH", {
      activeSession,
      receivedSessionId: sessionData.id,
    });
  }, [activeSession, sessionData]);
  const { workflow } = useWorkflowForSession(persistedMessages, activeWorkflowId);

  useEffect(() => {
    if (!activeSession) return;
    const refreshDurableSession = (reason: string) => {
      log.debug("STREAM:DURABLE_SESSION_REFRESH", { activeSession, reason });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", activeSession] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    };
    const handleVisibilityResume = () => {
      if (document.visibilityState === "visible") {
        refreshDurableSession("visibility-visible");
      }
    };
    const handlePageShow = () => refreshDurableSession("pageshow");
    const handleWindowFocus = () => refreshDurableSession("window-focus");
    document.addEventListener("visibilitychange", handleVisibilityResume);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityResume);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [activeSession]);

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
  const transcriptSnapshotRef = useRef<TranscriptSnapshot | null>(null);

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
      previousTranscript: transcriptSnapshotRef.current,
      messagesContainCompactionBoundary: hasCompactionBoundary(messages),
    });
  }, [activeSession, messages, rawStreaming, ownedSessionData?.status, sessionSub.runActive, sessionSub.status, sessionSub.updatedAt, contextPendingTurn, frozenStreamHandoff]);

  // Update the transcript snapshot ref for next render cycle
  transcriptSnapshotRef.current = projection.transcriptSnapshot;

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
    enabled: isAgentRunning,
    busy: isSessionActive,
    pendingTurn: contextPendingTurn,
    setPendingTurn: focusCtx?.setPendingTurn,
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
          message={emptyStateMessage ?? (isAgentRunning
            ? "What's next?"
            : "The agent isn't running. Start it from Settings to chat.")}
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
          const commitTitleRename = () => {
            if (titleRenameCommittedRef.current) return;
            titleRenameCommittedRef.current = true;
            const trimmed = titleRenameValue.trim();
            if (trimmed && trimmed !== titleText && activeSession) {
              renameConversation.mutate({ id: activeSession, title: trimmed });
            }
            setIsTitleRenaming(false);
          };
          const startTitleRename = () => {
            titleRenameCommittedRef.current = false;
            setTitleRenameValue(titleText);
            setIsTitleRenaming(true);
            setTimeout(() => titleInputRef.current?.focus({ preventScroll: true }), 0);
          };
          return (
            <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
              {titleIsStreaming && !isTitleRenaming && <ActiveStatusSpinner className="h-3.5 w-3.5" />}
              {isTitleRenaming ? (
                <input
                  ref={titleInputRef}
                  className="text-sm font-medium bg-transparent border border-border rounded px-1.5 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring min-w-0 flex-shrink"
                  value={titleRenameValue}
                  onChange={(e) => setTitleRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTitleRename();
                    } else if (e.key === "Escape") {
                      titleRenameCommittedRef.current = true;
                      setIsTitleRenaming(false);
                    }
                  }}
                  onBlur={commitTitleRename}
                  data-testid="input-title-rename"
                />
              ) : (
                <span
                  className={cn("text-sm font-medium truncate cursor-pointer hover:underline", titleIsStreaming && "text-active animate-pulse")}
                  onClick={startTitleRename}
                  data-testid="text-chat-title"
                >
                  {titleText}
                </span>
              )}

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
          {voiceActive && (
            <span className="flex items-center gap-1 text-xs text-primary">
              <Mic className="h-3 w-3 animate-pulse" />
              Voice
            </span>
          )}
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
              {(() => {
                const active = sessions.find((session) => session.id === activeSession);
                if (!activeSession || !active) return null;
                return (
                  <SessionActionsMenuItems
                    sessionId={activeSession}
                    sessionTitle={active.title}
                    parentSessionId={active.parentSessionId}
                    onRename={() => {
                      const title = active.title || "Chat";
                      titleRenameCommittedRef.current = false;
                      setTitleRenameValue(title);
                      setIsTitleRenaming(true);
                      setTimeout(() => titleInputRef.current?.focus({ preventScroll: true }), 0);
                    }}
                    onSelectSession={setActiveSession}
                    onArchive={(id) => onArchiveSession?.(id)}
                    onDelete={() => setShowDeleteConfirm(true)}
                    isArchived={!!active.archivedAt}
                    isPinned={!!active.isPinned}
                    onTogglePin={onTogglePinSession}
                    onReminderSet={onSessionReminderSet}
                    onOpenInParent={
                      active.parentSessionId
                        ? () => setActiveSession(active.parentSessionId!)
                        : undefined
                    }
                    onShowDetails={() => setShowDetails(true)}
                    linkedEntities={isWidget ? [] : linkedEntities}
                    onLinkedEntityClick={navigateToEntity}
                    testIdPrefix="menuitem-titlebar"
                  />
                );
              })()}
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
        messages={displayMessages}
        streaming={displayStreaming}
        isSessionStreaming={isStreaming}
        runActive={isSessionActive}
        msgsLoading={msgsLoading}
        voiceActive={voiceActive}
        showVoiceTools={showVoiceTools}
        voiceStepsInsertIndex={voiceStepsInsertIndexRef.current}
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
        workflow={workflow}
        meeting={ownedSessionData?.meeting}
        sessionTitle={ownedSessionData?.title}
        scrollContainerRef={scrollContainerRef}
        onUserScrollIntent={handleUserScrollIntent}
        onScroll={handleScroll}
        compactReferences={isWidget}
        questionResponses={questionResponses}
        questionSubmissionDisabled={!isAgentRunning || isSessionActive || Boolean(contextPendingTurn)}
        onQuestionSubmit={submitQuestionResponse}
      />
    </div>
  );
}
