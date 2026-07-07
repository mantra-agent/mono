import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { Mic, MicOff, ArrowUp, Square, Paperclip, MoreHorizontal, Eye, X, FileText, Bug } from "lucide-react";
import { useMentionAutocomplete } from "@/hooks/use-mention-autocomplete";
import { MentionPopover } from "@/components/mention-popover";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useSessionSubscription, type SessionStatus, type SessionStreamState } from "@/hooks/use-session-subscription";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { useChatSend } from "@/hooks/use-chat-send";
import { useToast } from "@/hooks/use-toast";
import { useVoiceSessionOptional, type VoiceTranscriptEntry } from "@/hooks/use-voice-session";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { emitSessionChanged, emitSessionListChanged } from "@/hooks/use-data-sync";
import { useInterfaceMode } from "@/hooks/use-interface-mode";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useVisibilityLayer,
  LAYER_LABELS,
  type VisibilityLayer,
} from "@/hooks/use-visibility-layer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import type { ChatSession as Session, PageContext } from "@shared/models/chat";
import { StatusLine } from "./status-line";
import { PreviewChip } from "./preview-chip";
import { ExpandedDialogue } from "./expanded-dialogue";
import type { ExecutionStep, StreamingContent } from "@shared/streaming-types";
import { parseReferenceText } from "@shared/reference-parser";

const log = createLogger("BottomBar");

type BarState = "idle" | "working" | "complete";

const HIDDEN_ROUTES = new Set(["/login", "/register", "/voice", "/glasses"]);

function getLatestStep(content: StreamingContent | null): ExecutionStep | null {
  if (!content || !content.steps || content.steps.length === 0) return null;
  return content.steps[content.steps.length - 1];
}

function getLastAssistantText(content: StreamingContent | null): string {
  if (!content) return "";
  const textSegments = content.segments
    .filter((s) => s.type === "text" && s.content)
    .map((s) => s.content);
  return textSegments.join("").trim();
}

type VoiceInputDisplay = { text: string; state: "empty" | "active" | "committed" };

function getVoiceInputDisplay(transcript: VoiceTranscriptEntry[]): VoiceInputDisplay {
  const userEntries = transcript.filter((entry) => entry.source === "user" && entry.isFinal !== true && entry.message.trim().length > 0);
  if (userEntries.length === 0) return { text: "", state: "empty" };

  const latest = userEntries[userEntries.length - 1];
  const latestTurnKey = latest.turnKey;
  const latestTurnId = latest.turnId;
  const sameTurn = userEntries.filter((entry) => {
    if (latestTurnKey) return entry.turnKey === latestTurnKey;
    if (latestTurnId) return entry.turnId === latestTurnId;
    return entry === latest;
  });
  const bySequence = sameTurn
    .filter((entry) => typeof entry.sequence === "number")
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  const displayEntry = bySequence.at(-1) ?? sameTurn.at(-1) ?? latest;
  return {
    text: displayEntry.message,
    state: displayEntry.isFinal === true ? "committed" : "active",
  };
}

function getVoiceInputPlaceholder(voiceSession: NonNullable<ReturnType<typeof useVoiceSessionOptional>> | null): string {
  if (!voiceSession) return "Listening…";
  if (voiceSession.status === "connecting") return "Connecting voice…";
  if (voiceSession.status === "reconnecting") return "Reconnecting voice…";
  if (voiceSession.status === "ending") return "Ending voice…";
  if (voiceSession.agentMode === "speaking") return "Agent speaking…";
  return voiceSession.userSpeaking ? "Hearing you…" : "Listening…";
}

/** Square thumbnail preview for attached files — matches the old chat input area style. */
function AttachedFileThumbnail({ file, index, onRemove }: { file: File; index: number; onRemove: (i: number) => void }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith("image/");

  useEffect(() => {
    if (!isImage) { setImageUrl(null); return; }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div
      className="group relative h-20 w-20 overflow-hidden rounded-md border border-border bg-card"
      title={file.name}
    >
      {isImage && imageUrl ? (
        <img src={imageUrl} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-muted-foreground">
          <FileText className="h-5 w-5" aria-hidden="true" />
          <span className="line-clamp-2 max-w-full break-words text-[10px] leading-tight">{file.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background/90 text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={`Remove ${file.name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** "..." menu left of the text input — contains Attach, Visibility, and session actions for the focused session. */
function BottomBarMenu({
  onAttach,
  disabled,
  focusedSessionId,
  onClearFocus,
  onSelectSession,
  onReminderSet,
}: {
  onAttach: () => void;
  disabled: boolean;
  focusedSessionId: string | null;
  onClearFocus: () => void;
  onSelectSession: (id: string) => void;
  onReminderSet?: (id: string) => void;
}) {
  const { layer, setLayer } = useVisibilityLayer();
  const { toast } = useToast();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Look up focused session metadata from the sessions cache for parentSessionId
  const { data: sessions = [] } = useQuery<Session[]>({
    queryKey: ["/api/sessions"],
    enabled: !!focusedSessionId,
  });
  const focusedSession = focusedSessionId
    ? sessions.find((s) => s.id === focusedSessionId)
    : null;

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const session = sessions.find((item) => item.id === id);
      await apiRequest("PATCH", `/api/sessions/${id}/archive`, { archived: !session?.archivedAt });
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/sessions"] });
      const prev = queryClient.getQueryData<Session[]>(["/api/sessions"]);
      const session = prev?.find((item) => item.id === id);
      const archivedAt = session?.archivedAt ? null : new Date().toISOString();
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) =>
        old?.map((item) =>
          item.id === id ? { ...item, archivedAt, isPinned: archivedAt ? false : item.isPinned } : item,
        ),
      );
      return { prev };
    },
    onSuccess: (_data, id) => {
      emitSessionListChanged("bottom-bar-archive-toggle");
      if (focusedSessionId === id) onClearFocus();
    },
    onError: (err, _id, context) => {
      if (context?.prev) queryClient.setQueryData(["/api/sessions"], context.prev);
      toast({ title: "Failed to update archive state", description: String(err), variant: "destructive" });
    },
  });

  const toggleAttention = useMutation({
    mutationFn: async ({ id, isPinned }: { id: string; isPinned: boolean }) => {
      await apiRequest("PATCH", `/api/gateway/conversations/${id}/attention`, { isPinned });
    },
    onMutate: async ({ id, isPinned }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/sessions"] });
      const prev = queryClient.getQueryData<Session[]>(["/api/sessions"]);
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) =>
        old?.map((session) => session.id === id ? { ...session, isPinned } : session),
      );
      return { prev };
    },
    onError: (err, _variables, context) => {
      if (context?.prev) queryClient.setQueryData(["/api/sessions"], context.prev);
      toast({ title: "Failed to toggle pin", description: String(err), variant: "destructive" });
    },
    onSettled: () => {
      emitSessionListChanged("bottom-bar-pin-toggle");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/sessions/${id}`);
    },
    onSuccess: (_data, id) => {
      emitSessionListChanged("bottom-bar-delete");
      if (focusedSessionId === id) onClearFocus();
    },
    onError: (err) => {
      toast({ title: "Failed to delete session", description: String(err), variant: "destructive" });
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="shrink-0 flex items-center justify-center h-9 w-9 rounded-full bg-muted/50 border-[1.5px] border-border text-muted-foreground hover:bg-muted/70 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="More options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={4}>
          <DropdownMenuItem onClick={onAttach}>
            <Paperclip className="h-3.5 w-3.5 mr-2" />
            Attach file
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Eye className="h-3.5 w-3.5 mr-2" />
              Visibility
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={String(layer)}
                onValueChange={(value) => setLayer(Number(value) as VisibilityLayer)}
              >
                {([1, 2, 3, 4] as VisibilityLayer[]).map((v) => (
                  <DropdownMenuRadioItem key={v} value={String(v)}>
                    {LAYER_LABELS[v]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {typeof window !== "undefined" && (window as any).ReactNativeWebView && (
            <DropdownMenuItem
              onClick={() => {
                (window as any).ReactNativeWebView.postMessage(
                  JSON.stringify({ type: "voice.diagnostics.open" }),
                );
              }}
            >
              <Bug className="h-3.5 w-3.5 mr-2" />
              Voice Debug
            </DropdownMenuItem>
          )}
          {focusedSessionId && (
            <>
              <DropdownMenuSeparator />
              <SessionActionsMenuItems
                sessionId={focusedSessionId}
                sessionTitle={focusedSession?.title}
                hideRename
                onSelectSession={onSelectSession}
                onArchive={(id) => archiveMutation.mutate(id)}
                onDelete={(id) => setDeleteConfirmId(id)}
                isArchived={!!focusedSession?.archivedAt}
                isPinned={!!focusedSession?.isPinned}
                onTogglePin={(id, pinned) => toggleAttention.mutate({ id, isPinned: pinned })}
                onReminderSet={onReminderSet}
                onOpenInParent={
                  focusedSession?.parentSessionId
                    ? () => onSelectSession(focusedSession.parentSessionId!)
                    : undefined
                }
                onShowDetails={() => setDetailsOpen(true)}
                testIdPrefix="bottom-bar-action"
              />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the conversation and all its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirmId) deleteMutation.mutate(deleteConfirmId);
                setDeleteConfirmId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Session details modal */}
      {focusedSessionId && (
        <SessionDetailsModal
          sessionId={focusedSessionId}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          onNavigateSession={onSelectSession}
        />
      )}
    </>
  );
}

interface BottomBarProps {
  contained?: boolean;
  /** When embedded in the Session Window, the parent owns the visible session identity. */
  sessionId?: string | null;
  /** Parent-owned stream state for the visible session. Avoids a second single-session subscription. */
  sessionSub?: SessionStreamState;
  /** Parent-owned session setter for embedded mode. */
  setSessionId?: (id: string | null) => void;
  /** Payload override forwarded to useChatSend when BottomBar creates a session. */
  createSessionPayload?: () => Record<string, unknown>;
  /** Fresh page context included with every message POST. */
  getMessagePageContext?: () => PageContext | undefined;
}

export function BottomBar({
  contained,
  sessionId: controlledSessionId,
  sessionSub: controlledSessionSub,
  setSessionId: controlledSetSessionId,
  createSessionPayload,
  getMessagePageContext,
}: BottomBarProps) {
  const [location] = useLocation();
  const [interfaceMode] = useInterfaceMode();
  const isMobile = useIsMobile();
  const mobileSurfaceActive = interfaceMode === "mobile_detail" || interfaceMode === "mobile_simple";
  const {
    route,
    setWidgetOpen,
    getSessionForRoute,
    setSessionForRoute,
    clearSessionForRoute,
    requestSessionMenuReset,
    bottomBarFocusRequestKey,
    pendingTurn: contextPendingTurn,
    setPendingTurn: setContextPendingTurn,
  } = useFocusSession();
  const { data: agentStatus } = useExecutorStatus();
  const isAgentRunning = agentStatus?.status === "running";
  const voiceSession = useVoiceSessionOptional();
  const voiceActive = !!(voiceSession && voiceSession.status !== "idle");
  const { toast } = useToast();

  const contextSessionId = getSessionForRoute(route);
  const focusedSessionId = controlledSessionId !== undefined ? controlledSessionId : contextSessionId;
  const fallbackSessionSub = useSessionSubscription(controlledSessionSub ? null : focusedSessionId);
  const sessionSub = controlledSessionSub ?? fallbackSessionSub;
  const showMobileSessionMenu = useCallback(() => {
    if (!isMobile) return;
    setWidgetOpen(true);
    requestSessionMenuReset();
  }, [isMobile, setWidgetOpen, requestSessionMenuReset]);

  const setFocusedSessionId = useCallback((id: string | null) => {
    if (controlledSetSessionId) {
      controlledSetSessionId(id);
      return;
    }
    if (id) setSessionForRoute(route, id);
    else clearSessionForRoute(route);
  }, [controlledSetSessionId, route, setSessionForRoute, clearSessionForRoute]);

  const [inputText, setInputText] = useState("");
  const [barState, setBarState] = useState<BarState>("idle");
  const [lastResponseText, setLastResponseText] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [showExpanded, setShowExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevStatusRef = useRef<SessionStatus>("idle");

  const chatSend = useChatSend({
    toast,
    voiceSession,
    isAgentRunning,
    activeSession: focusedSessionId,
    setActiveSession: setFocusedSessionId,
    setComposing,
    attachedFiles,
    setAttachedFiles,
    createSessionPayload,
    getMessagePageContext,
    externalPendingTurn: [contextPendingTurn, setContextPendingTurn],
  });

  // Reset bar state when focused session changes (prevents stale stop button)
  useEffect(() => {
    setBarState("idle");
    setShowPreview(false);
    prevStatusRef.current = "idle";
  }, [focusedSessionId]);

  // Derive bar state from streaming status
  useEffect(() => {
    const status = sessionSub.status;
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "streaming") {
      setBarState("working");
      setShowPreview(false);
    } else if (prevStatus === "streaming" && (status === "saved" || status === "idle")) {
      const text = getLastAssistantText(sessionSub.streamingContent);
      if (text) {
        setLastResponseText(text);
        setShowPreview(true);
      }
      setBarState("complete");
      const timer = setTimeout(() => setBarState("idle"), 30000);
      return () => clearTimeout(timer);
    } else if (status === "error") {
      toast({ title: "Something went wrong", description: "Try sending your message again.", variant: "destructive" });
      setBarState("idle");
    }
  }, [sessionSub.status, sessionSub.streamingContent]);

  // Auto-resize textarea — grows upward, never shows scrollbar
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // No max height cap — textarea grows as needed, no scrollbar
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const voiceInputDisplay = useMemo(() => {
    if (!voiceSession || voiceSession.status === "idle") return { text: "", state: "empty" as const };
    return getVoiceInputDisplay(voiceSession.transcript);
  }, [voiceSession?.status, voiceSession?.transcript]);

  const displayedInputText = voiceActive ? voiceInputDisplay.text : inputText;
  const displayedInputHasReferences = useMemo(
    () => parseReferenceText(displayedInputText).some((part) => part.kind === "reference"),
    [displayedInputText],
  );
  const voiceInputPlaceholder = voiceActive ? getVoiceInputPlaceholder(voiceSession) : undefined;

  useEffect(() => {
    adjustTextareaHeight();
  }, [displayedInputText, adjustTextareaHeight]);

  useEffect(() => {
    if (bottomBarFocusRequestKey === 0 || voiceActive) return;

    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, [bottomBarFocusRequestKey, voiceActive]);

  const handleMentionChange = useCallback(
    (newValue: string, newCursorPosition: number) => {
      setInputText(newValue);
      cursorRef.current = newCursorPosition;
      requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (!target) return;
        target.focus({ preventScroll: true });
        target.selectionStart = newCursorPosition;
        target.selectionEnd = newCursorPosition;
        adjustTextareaHeight();
      });
    },
    [adjustTextareaHeight],
  );

  const mention = useMentionAutocomplete({
    value: inputText,
    cursorPosition: cursorRef.current,
    onChange: handleMentionChange,
  });

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text && attachedFiles.length === 0) return;
    setInputText("");
    mention.dismiss();
    setAttachedFiles([]);
    setShowPreview(false);
    setBarState("idle");

    const success = await chatSend.sendMessage(text);
    if (!success) {
      toast({ title: "Failed to send message", variant: "destructive" });
    } else if (isMobile) {
      // On mobile, auto-navigate to the session window after sending
      setWidgetOpen(true);
    }
  }, [inputText, attachedFiles, chatSend, toast, isMobile, setWidgetOpen, mention]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Let mention autocomplete handle keyboard events first
      if (mention.handleKeyDown(e)) return;

      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        const el = textareaRef.current;
        if (!el) return;

        const start = el.selectionStart;
        const end = el.selectionEnd;
        const nextValue = inputText.slice(0, start) + "\n" + inputText.slice(end);
        setInputText(nextValue);

        requestAnimationFrame(() => {
          el.selectionStart = start + 1;
          el.selectionEnd = start + 1;
          adjustTextareaHeight();
        });
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [adjustTextareaHeight, handleSend, inputText, mention],
  );


  const handleVoice = useCallback(async () => {
    if (!voiceSession || voiceSession.status !== "idle") return;
    let convId = focusedSessionId;
    if (!convId) {
      try {
        const res = await apiRequest("POST", "/api/sessions", { title: "New Session" });
        const newConv: Session = await res.json();
        convId = newConv.id;
        setFocusedSessionId(convId);
      } catch (err) {
        log.error("VOICE:SESSION_CREATE_FAILED", err);
        return;
      }
    }
    voiceSession.setActiveConversationId(convId);
    voiceSession.startSession();
  }, [voiceSession, focusedSessionId, setFocusedSessionId]);

  const handleVoiceEnd = useCallback(async () => {
    if (!voiceSession) return;
    await voiceSession.endSession();
    const convId = voiceSession.activeConversationId;
    if (convId) {
      emitSessionChanged(convId, "voice-cleanup");
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", convId] });
    }
  }, [voiceSession]);

  const handleAbort = useCallback(() => {
    chatSend.handleAbort();
  }, [chatSend]);

  const handleOpenInSessions = useCallback(() => {
    setShowExpanded(false);
    setWidgetOpen(true);
  }, [setWidgetOpen]);

  const dismissPreview = useCallback(() => {
    setShowPreview(false);
    setBarState("idle");
  }, []);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...files]);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    addFiles(Array.from(files));
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }, [addFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length === 0) return;

    e.preventDefault();
    addFiles(files);
  }, [addFiles]);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Measure bottom bar height and expose as CSS custom property so the sidebar
  // and focus widget can position themselves above it.
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (contained) return; // Contained mode doesn't need the global CSS variable
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      document.documentElement.style.setProperty("--bottom-bar-height", `${Math.ceil(h)}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--bottom-bar-height");
    };
  }, [contained]);

  if (HIDDEN_ROUTES.has(location)) {
    // Clear the property when the bar is hidden so consumers fall back to 0
    if (!contained) document.documentElement.style.setProperty("--bottom-bar-height", "0px");
    return null;
  }

  const latestStep = getLatestStep(sessionSub.streamingContent);
  const isWorking = barState === "working" && !!focusedSessionId;
  const hasText = inputText.trim().length > 0;
  const hasContent = !voiceActive && (hasText || attachedFiles.length > 0);
  const voiceEnding = voiceSession?.status === "ending";
  const voiceButtonActive = voiceActive && voiceSession?.status === "active";

  return (
    <>
      <div
        ref={barRef}
        className={cn(
          contained
            ? "shrink-0 bg-background"
            : mobileSurfaceActive
              ? "absolute bottom-0 inset-x-0 bg-background"
              : "fixed bottom-0 inset-x-0 bg-background",
          !contained && "z-50",
        )}
      >
        <StatusLine step={latestStep} visible={isWorking} />
        <PreviewChip
          text={lastResponseText}
          visible={showPreview && barState === "complete"}
          onExpand={() => setShowExpanded(true)}
          onDismiss={dismissPreview}
        />

        <>
          {/* Attached files preview — square thumbnails */}
          {!voiceActive && attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2 pt-2">
              {attachedFiles.map((file, i) => (
                <AttachedFileThumbnail key={`${file.name}-${file.size}-${i}`} file={file} index={i} onRemove={removeFile} />
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 px-2 py-2 md:justify-center">
            <div className="flex items-center gap-1.5 w-full md:max-w-2xl">
            {/* File upload (hidden input) */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />

            {/* More menu: Attach + Visibility + Session actions */}
            <BottomBarMenu
              onAttach={() => fileInputRef.current?.click()}
              disabled={!isAgentRunning || voiceActive}
              focusedSessionId={focusedSessionId ?? null}
              onClearFocus={() => {
                setFocusedSessionId(null);
                showMobileSessionMenu();
              }}
              onSelectSession={(id) => setFocusedSessionId(id)}
              onReminderSet={(id) => {
                if (focusedSessionId !== id) return;
                setFocusedSessionId(null);
                showMobileSessionMenu();
              }}
            />

            {/* Text input — grows upward, never scrolls */}
            <div className="relative flex flex-1 min-w-0">
              {displayedInputHasReferences && (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 whitespace-pre-wrap break-words",
                    "min-h-9 rounded-[18px] border border-transparent px-3 py-[7px] text-sm",
                    "overflow-hidden text-foreground",
                    voiceActive && "pr-11",
                  )}
                  aria-hidden="true"
                >
                  <InlineReferenceText text={displayedInputText} />
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={displayedInputText}
                onChange={(e) => {
                  if (voiceActive) return;
                  const value = e.target.value;
                  setInputText(value);
                  cursorRef.current = e.target.selectionStart;
                  mention.handleInputChange(value, e.target.selectionStart);
                }}
                onKeyDown={voiceActive ? undefined : handleKeyDown}
                onSelect={voiceActive ? undefined : (e) => {
                  const el = e.target as HTMLTextAreaElement;
                  cursorRef.current = el.selectionStart;
                  mention.handleInputChange(el.value, el.selectionStart);
                }}
                onPaste={voiceActive ? undefined : handlePaste}
                placeholder={voiceInputPlaceholder ?? (isAgentRunning ? "Message Agent…" : "Agent offline")}
                disabled={!isAgentRunning || voiceActive}
                rows={1}
                className={cn(
                  "w-full min-h-9 resize-none bg-muted/50 border border-border rounded-[18px] px-3 py-[7px]",
                  voiceActive && "pr-11",
                  "text-sm placeholder:text-muted-foreground",
                  displayedInputHasReferences && "text-transparent caret-foreground",
                  "focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring",
                  "disabled:cursor-not-allowed",
                  voiceActive
                    ? cn("disabled:opacity-100", voiceInputDisplay.state === "committed" ? "text-muted-foreground" : "text-foreground")
                    : "disabled:opacity-50",
                  "overflow-hidden",
                )}
              />
              {!voiceActive && (
                <MentionPopover
                  trigger={mention.trigger}
                  suggestions={mention.suggestions}
                  isLoading={mention.isLoading}
                  activeIndex={mention.activeIndex}
                  onSelect={mention.insertSuggestion}
                  onHover={mention.setActiveIndex}
                  anchorRef={textareaRef}
                  testIdSuffix="-bottom-bar"
                />
              )}
              {voiceActive && voiceSession && (
                <button
                  type="button"
                  onClick={voiceSession.toggleMute}
                  disabled={voiceEnding}
                  className={cn(
                    "absolute right-1.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full transition-colors",
                    voiceSession.isMuted
                      ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    voiceEnding && "opacity-50 cursor-not-allowed",
                  )}
                  aria-label={voiceSession.isMuted ? "Unmute microphone" : "Mute microphone"}
                >
                  {voiceSession.isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
            </div>

            {/* Action button: Send (has content) > Active voice > Stop (working) > Voice (idle+empty) */}
            {hasContent && isWorking ? (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!isAgentRunning}
                  className="shrink-0 flex items-center justify-center h-9 w-9 rounded-full border-[1.5px] border-warning text-warning hover:bg-warning/10 transition-colors"
                  aria-label="Interrupt and send"
                >
                  <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                </button>
              ) : hasContent ? (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!isAgentRunning}
                  className={cn(
                    "shrink-0 flex items-center justify-center h-9 w-9 rounded-full border-[1.5px] transition-colors",
                    isAgentRunning
                      ? "bg-cta border-cta text-cta-foreground hover:bg-cta/85"
                      : "border-muted text-muted-foreground cursor-not-allowed",
                  )}
                  aria-label="Send message"
                >
                  <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                </button>
              ) : voiceActive ? (
                <button
                  type="button"
                  onClick={handleVoiceEnd}
                  disabled={voiceEnding}
                  className={cn(
                    "relative shrink-0 flex items-center justify-center h-9 w-9 rounded-full border-[1.5px] transition-colors overflow-visible",
                    voiceButtonActive && "shadow-[0_0_12px_hsl(var(--cta)/0.45)]",
                    voiceEnding
                      ? "border-muted bg-muted text-muted-foreground cursor-not-allowed"
                      : "border-cta bg-cta text-cta-foreground hover:bg-cta/85",
                  )}
                  aria-label="End voice conversation"
                >
                  {voiceButtonActive && (
                    <span
                      className="absolute inset-[-2px] rounded-full border border-cta/60 bg-cta/20 animate-ping"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={cn(
                      "absolute inset-0 rounded-full bg-cta/30 opacity-0",
                      voiceButtonActive && "animate-pulse opacity-100",
                    )}
                    aria-hidden="true"
                  />
                  <Mic className={cn("relative h-5 w-5", voiceButtonActive && "animate-pulse")} strokeWidth={2} />
                </button>
              ) : isWorking ? (
                <button
                  type="button"
                  onClick={handleAbort}
                  className="relative shrink-0 flex items-center justify-center h-9 w-9 rounded-full border-[1.5px] border-cta bg-cta text-cta-foreground shadow-[0_0_12px_hsl(var(--cta)/0.45)] hover:bg-cta/85 transition-colors overflow-visible"
                  aria-label="Stop"
                >
                  <span
                    className="absolute inset-[-2px] rounded-full border border-cta/60 bg-cta/20 animate-ping"
                    aria-hidden="true"
                  />
                  <span
                    className="absolute inset-0 rounded-full bg-cta/30 animate-pulse opacity-100"
                    aria-hidden="true"
                  />
                  <Square className="relative h-4 w-4 animate-pulse" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleVoice}
                  className="shrink-0 flex items-center justify-center h-9 w-9 rounded-full border-[1.5px] border-cta text-cta hover:bg-cta/10 transition-colors"
                  aria-label="Voice mode"
                >
                  <Mic className="h-5 w-5" strokeWidth={2} />
                </button>
              )}
              </div>
            </div>
          </>
      </div>

      <ExpandedDialogue
        content={lastResponseText}
        visible={showExpanded}
        onClose={() => setShowExpanded(false)}
        onOpenInSessions={handleOpenInSessions}
      />
    </>
  );
}
