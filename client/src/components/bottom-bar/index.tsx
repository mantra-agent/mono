import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { Mic, MicOff, ArrowUp, Square, Paperclip, MoreHorizontal, Eye, X, FileText, Bug, Gauge } from "lucide-react";
import { useMentionAutocomplete } from "@/hooks/use-mention-autocomplete";
import { MentionPopover } from "@/components/mention-popover";
import { EditableReferenceInput, type EditableReferenceInputHandle } from "@/components/references/editable-reference-input";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useSessionSubscription, type SessionStatus, type SessionStreamState } from "@/hooks/use-session-subscription";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { useChatSend } from "@/hooks/use-chat-send";
import { useToast } from "@/hooks/use-toast";
import { useVoiceSessionOptional, type VoiceTranscriptEntry } from "@/hooks/use-voice-session";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { deleteSessionTree, getSessionDeletionDescription } from "@/lib/session-deletion";
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
import type { ChatSession as Session, PageContext, SessionModelTierOverride } from "@shared/models/chat";
import { StatusLine } from "./status-line";
import { PreviewChip } from "./preview-chip";
import { ExpandedDialogue } from "./expanded-dialogue";
import type { ExecutionStep, StreamingContent } from "@shared/streaming-types";

const log = createLogger("BottomBar");

type BarState = "idle" | "working" | "complete";

const HIDDEN_ROUTES = new Set(["/login", "/register", "/voice", "/glasses"]);
const MODEL_TIER_OPTIONS: Array<{ value: "auto" | SessionModelTierOverride; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

function normalizeModelTier(value: unknown): "auto" | SessionModelTierOverride {
  return value === "fast" || value === "balanced" || value === "high" || value === "max" ? value : "auto";
}


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

type VoiceInputDisplay = { text: string; state: "empty" | "active" };

function getVoiceInputDisplay(transcript: VoiceTranscriptEntry[]): VoiceInputDisplay {
  const userEntries = transcript.filter((entry) => entry.source === "user" && !entry.isToolCall && entry.message.trim().length > 0);
  if (userEntries.length === 0) return { text: "", state: "empty" };

  const latest = userEntries[userEntries.length - 1];
  if (latest.status !== "provisional") return { text: "", state: "empty" };

  const latestTurnKey = latest.turnKey;
  const latestTurnId = latest.turnId;
  const sameTurn = userEntries.filter((entry) => {
    if (entry.status !== "provisional") return false;
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
    state: "active",
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
  draftModelTier,
  onDraftModelTierChange,
  queueModelTierUpdate,
}: {
  onAttach: () => void;
  disabled: boolean;
  focusedSessionId: string | null;
  onClearFocus: () => void;
  onSelectSession: (id: string) => void;
  onReminderSet?: (id: string) => void;
  draftModelTier: "auto" | SessionModelTierOverride;
  onDraftModelTierChange: (tier: "auto" | SessionModelTierOverride) => void;
  queueModelTierUpdate: (update: () => Promise<void>) => Promise<void>;
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

  const modelTierMutation = useMutation({
    mutationFn: async ({ session, tier }: { session: Session; tier: "auto" | SessionModelTierOverride }) => {
      const key = session.sessionKey || `dashboard:${session.id}`;
      await apiRequest("PATCH", `/api/gateway/sessions/${encodeURIComponent(key)}/tier`, { tier });
      return { id: session.id, tier };
    },
    onMutate: async ({ session, tier }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/sessions"] });
      const prev = queryClient.getQueryData<Session[]>(["/api/sessions"]);
      const modelTier = tier === "auto" ? null : tier;
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) =>
        old?.map((item) => item.id === session.id ? { ...item, modelTier } : item),
      );
      queryClient.setQueryData<Session>(["/api/sessions", session.id], (old) =>
        old ? { ...old, modelTier } : old,
      );
      return { prev };
    },
    onError: (err, _variables, context) => {
      if (context?.prev) queryClient.setQueryData(["/api/sessions"], context.prev);
      toast({ title: "Failed to update model tier", description: String(err), variant: "destructive" });
    },
    onSuccess: ({ id }) => {
      emitSessionChanged(id, "bottom-bar-model-tier");
      emitSessionListChanged("bottom-bar-model-tier");
    },
  });

  const currentModelTier = focusedSession ? normalizeModelTier(focusedSession.modelTier) : draftModelTier;
  const setModelTier = (tier: "auto" | SessionModelTierOverride) => {
    if (!focusedSession) {
      onDraftModelTierChange(tier);
      return;
    }
    void queueModelTierUpdate(async () => {
      await modelTierMutation.mutateAsync({ session: focusedSession, tier });
    }).catch(() => {
      // The mutation owns the user-visible error and optimistic rollback.
    });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSessionTree(id),
    onSuccess: (result) => {
      emitSessionListChanged("bottom-bar-delete");
      if (focusedSessionId && result.deletedSessionIds.includes(focusedSessionId)) onClearFocus();
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Gauge className="h-3.5 w-3.5 mr-2" />
              Model
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={currentModelTier} onValueChange={(value) => setModelTier(normalizeModelTier(value))}>
                {MODEL_TIER_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
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
                parentSessionId={focusedSession?.parentSessionId}
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
              {getSessionDeletionDescription(sessions, deleteConfirmId)}
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
  const { toast } = useToast();

  const contextSessionId = getSessionForRoute(route);
  const focusedSessionId = controlledSessionId !== undefined ? controlledSessionId : contextSessionId;
  const voiceActive = !!(
    voiceSession &&
    focusedSessionId &&
    voiceSession.activeConversationId === focusedSessionId &&
    voiceSession.status !== "idle"
  );
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
  const [draftModelTier, setDraftModelTier] = useState<"auto" | SessionModelTierOverride>("auto");
  const inputRef = useRef<EditableReferenceInputHandle>(null);
  const inputAnchorRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevStatusRef = useRef<SessionStatus>("idle");
  const pendingModelTierUpdateRef = useRef<Promise<void> | null>(null);
  const turnAdmissionRef = useRef<"text" | "voice" | null>(null);
  const [turnAdmissionPending, setTurnAdmissionPending] = useState(false);
  const { data: sessions = [] } = useQuery<Session[]>({ queryKey: ["/api/sessions"], enabled: !!focusedSessionId });
  const focusedSession = focusedSessionId ? sessions.find((session) => session.id === focusedSessionId) : undefined;

  const queueModelTierUpdate = useCallback((update: () => Promise<void>): Promise<void> => {
    const previous = pendingModelTierUpdateRef.current;
    const next = previous
      ? previous.catch(() => undefined).then(update)
      : update();
    pendingModelTierUpdateRef.current = next;
    void next.finally(() => {
      if (pendingModelTierUpdateRef.current === next) {
        pendingModelTierUpdateRef.current = null;
      }
    }).catch(() => {
      // The menu mutation owns error reporting and optimistic rollback.
    });
    return next;
  }, []);

  const waitForModelTierUpdate = useCallback(async (): Promise<void> => {
    const pending = pendingModelTierUpdateRef.current;
    if (pending) await pending;
  }, []);

  const acquireTurnAdmission = useCallback((source: "text" | "voice"): boolean => {
    if (turnAdmissionRef.current) return false;
    turnAdmissionRef.current = source;
    setTurnAdmissionPending(true);
    return true;
  }, []);

  const releaseTurnAdmission = useCallback((source: "text" | "voice") => {
    if (turnAdmissionRef.current !== source) return;
    turnAdmissionRef.current = null;
    setTurnAdmissionPending(false);
  }, []);

  const chatSend = useChatSend({
    toast,
    voiceSession,
    isAgentRunning,
    activeSession: focusedSessionId,
    setActiveSession: setFocusedSessionId,
    setComposing,
    attachedFiles,
    setAttachedFiles,
    createSessionPayload: useCallback(() => ({
      ...(createSessionPayload ? createSessionPayload() : {}),
      ...(draftModelTier !== "auto" ? { modelTier: draftModelTier } : {}),
    }), [createSessionPayload, draftModelTier]),
    getMessagePageContext,
    externalPendingTurn: [contextPendingTurn, setContextPendingTurn],
  });

  // Reset bar state when focused session changes (prevents stale stop button)
  useEffect(() => {
    setBarState("idle");
    setShowPreview(false);
    prevStatusRef.current = "idle";
  }, [focusedSessionId]);

  // Derive bar state from the server runtime projection. Stop is tied to
  // cancellability, not to the transcript's visible Thinking state.
  useEffect(() => {
    const status = sessionSub.status;
    const canStop = sessionSub.canStop;
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (canStop) {
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
    } else if (!canStop && barState === "working") {
      setBarState("idle");
    }
  }, [barState, sessionSub.canStop, sessionSub.status, sessionSub.streamingContent]);

  const voiceInputDisplay = useMemo(() => {
    if (
      !voiceSession ||
      voiceSession.status === "idle" ||
      voiceSession.transcriptSessionId !== focusedSessionId
    ) {
      return { text: "", state: "empty" as const };
    }
    return getVoiceInputDisplay(voiceSession.transcript);
  }, [focusedSessionId, voiceSession?.status, voiceSession?.transcript, voiceSession?.transcriptSessionId]);

  const displayedInputText = voiceActive ? voiceInputDisplay.text : inputText;
  const voiceInputPlaceholder = voiceActive ? getVoiceInputPlaceholder(voiceSession) : undefined;

  useEffect(() => {
    if (bottomBarFocusRequestKey === 0 || voiceActive) return;

    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, [bottomBarFocusRequestKey, voiceActive]);

  const handleMentionChange = useCallback(
    (newValue: string, newCursorPosition: number) => {
      setInputText(newValue);
      cursorRef.current = newCursorPosition;
      requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.setSelectionRange(newCursorPosition);
      });
    },
    [],
  );

  const mention = useMentionAutocomplete({
    value: inputText,
    cursorPosition: cursorRef.current,
    onChange: handleMentionChange,
  });

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if ((!text && attachedFiles.length === 0) || !acquireTurnAdmission("text")) return;
    try {
      await waitForModelTierUpdate();
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
    } catch {
      // The tier mutation owns user-visible error reporting and rollback.
    } finally {
      releaseTurnAdmission("text");
    }
  }, [inputText, attachedFiles, chatSend, toast, isMobile, setWidgetOpen, mention, waitForModelTierUpdate, acquireTurnAdmission, releaseTurnAdmission]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Let mention autocomplete handle keyboard events first
      if (mention.handleKeyDown(e)) return;

      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        const start = cursorRef.current;
        const nextValue = inputText.slice(0, start) + "\n" + inputText.slice(start);
        setInputText(nextValue);

        requestAnimationFrame(() => {
          inputRef.current?.setSelectionRange(start + 1);
        });
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, inputText, mention],
  );


  const handleVoice = useCallback(async () => {
    if (!voiceSession || voiceSession.status !== "idle" || !acquireTurnAdmission("voice")) return;
    try {
      await waitForModelTierUpdate();
      let convId = focusedSessionId;
      if (!convId) {
        try {
          const res = await apiRequest("POST", "/api/sessions", {
            title: "New Session",
            ...(draftModelTier !== "auto" ? { modelTier: draftModelTier } : {}),
          });
          const newConv: Session = await res.json();
          convId = newConv.id;
          setFocusedSessionId(convId);
        } catch (err) {
          log.error("VOICE:SESSION_CREATE_FAILED", err);
          return;
        }
      }
      voiceSession.setActiveConversationId(convId);
      await voiceSession.startSession();
    } catch {
      // The tier mutation and voice session own user-visible error reporting.
    } finally {
      releaseTurnAdmission("voice");
    }
  }, [voiceSession, focusedSessionId, setFocusedSessionId, draftModelTier, waitForModelTierUpdate, acquireTurnAdmission, releaseTurnAdmission]);

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

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }

    // Text paste is owned by EditableReferenceInput so pasted text goes through
    // the same canonical mutation path as typed text. Do not use execCommand
    // here; it mutates the contenteditable DOM behind React and corrupts state.
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
  const isWorking = sessionSub.canStop && !!focusedSessionId;
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
              draftModelTier={draftModelTier}
              onDraftModelTierChange={setDraftModelTier}
              queueModelTierUpdate={queueModelTierUpdate}
            />

            {/* Text input — grows upward, never scrolls */}
            <div ref={inputAnchorRef} className="relative flex flex-1 min-w-0">
              <EditableReferenceInput
                ref={inputRef}
                value={displayedInputText}
                onChange={(value, cursorPosition) => {
                  if (voiceActive) return;
                  setInputText(value);
                  cursorRef.current = cursorPosition;
                  mention.handleInputChange(value, cursorPosition);
                }}
                onCursorChange={voiceActive ? undefined : (cursorPosition) => {
                  cursorRef.current = cursorPosition;
                  mention.handleInputChange(inputText, cursorPosition);
                }}
                onKeyDown={voiceActive ? undefined : handleKeyDown}
                onPaste={voiceActive ? undefined : handlePaste}
                placeholder={voiceInputPlaceholder ?? (isAgentRunning ? "Message Agent…" : "Agent offline")}
                disabled={!isAgentRunning || voiceActive || turnAdmissionPending}
                className={cn(
                  "bg-muted/50 border border-border rounded-[18px] px-3 py-[7px]",
                  voiceActive && "pr-11",
                  "text-sm placeholder:text-muted-foreground",
                  "focus:border-ring focus:ring-1 focus:ring-ring",
                  "disabled:cursor-not-allowed",
                  voiceActive
                    ? cn("disabled:opacity-100", voiceInputDisplay.state === "active" ? "text-active" : "text-muted-foreground")
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
                  anchorRef={inputAnchorRef}
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
                  disabled={!isAgentRunning || turnAdmissionPending}
                  className="shrink-0 flex items-center justify-center h-9 w-9 rounded-full border-[1.5px] border-warning text-warning hover:bg-warning/10 transition-colors"
                  aria-label="Interrupt and send"
                >
                  <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                </button>
              ) : hasContent ? (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!isAgentRunning || turnAdmissionPending}
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
