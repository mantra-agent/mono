// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useEffect, useRef, useMemo, useSyncExternalStore, useCallback, type MouseEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import {
  Plus,

  Bot,
  Loader2,
  ChevronRight,
  MoreHorizontal,
  Search,
  User,
  Pin,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  Radio,
  Timer,
} from "lucide-react";
import { isDurablyActiveSession, type ChatSession } from "@shared/models/chat";
import { SessionActionsMenuItems } from "@/components/session-actions-menu";
import { SessionDetailsModal } from "@/components/session-details-modal";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { groupByLocalDay } from "@/lib/local-date";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getSessionDeletionDescription } from "@/lib/session-deletion";
import { useToast } from "@/hooks/use-toast";
import { emitSessionListChanged } from "@/hooks/use-data-sync";
import { useVoiceSessionOptional } from "@/hooks/use-voice-session";

const log = createLogger("ConversationSidebar");

export interface SessionGroup {
  label: string;
  sessions: ChatSession[];
  defaultOpen: boolean;
}

export function sortByUpdated(a: ChatSession, b: ChatSession): number {
  return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
}

export function isLiveTransportSession(session: ChatSession, liveVoiceConversationId?: string | null): boolean {
  return (session.type === "meeting" && (session.meeting?.botStatus === "live" || session.meeting?.botStatus === "leaving")) ||
    (session.type === "voice" && !!liveVoiceConversationId && session.id === liveVoiceConversationId);
}

export function groupSessions(sessions: ChatSession[], opts?: { liveVoiceConversationId?: string | null; recentStickyIds?: Set<string> }): SessionGroup[] {
  const sorted = [...sessions].sort(sortByUpdated);
  const now = new Date();
  const oneHourAgo = now.getTime() - 60 * 60 * 1000;
  const liveVoiceConversationId = opts?.liveVoiceConversationId ?? null;
  const stickyIds = opts?.recentStickyIds ?? new Set<string>();

  const pinned: ChatSession[] = [];
  const review: ChatSession[] = [];
  const live: ChatSession[] = [];
  const active: ChatSession[] = [];
  const recentUrgent: ChatSession[] = []; // "Recent" — unread or < 1h old
  const today: ChatSession[] = [];
  const thisWeek: ChatSession[] = [];
  const past: ChatSession[] = [];
  const snooze: ChatSession[] = [];
  const archive: ChatSession[] = [];

  for (const conv of sorted) {
    // Classification precedence is structural: Archive → Snooze → Live → Review →
    // Active → Pinned → recency buckets. A reminder is an explicit deferral,
    // while transport liveness wins over review and durable active execution.
    if (conv.archivedAt) {
      archive.push(conv);
      continue;
    }
    if (conv.reminder?.active) {
      snooze.push(conv);
      continue;
    }
    if (isLiveTransportSession(conv, liveVoiceConversationId)) {
      live.push(conv);
      continue;
    }
    if (conv.awaitingQuestionResponse) {
      review.push(conv);
      continue;
    }
    // Streaming, actively running, or plan-executing sessions go to "Active".
    // hasActivePlan keeps a session in Active during the gap between plan steps,
    // when no child session is streaming yet. Live transports were already removed above.
    if (isDurablyActiveSession(conv)) {
      active.push(conv);
      continue;
    }
    // Pinned sessions go to "Pinned" after terminal, deferred, review, and active states.
    if (conv.isPinned) {
      pinned.push(conv);
      continue;
    }

    // "Recent" group: unread messages OR created < 1 hour ago, OR sticky from prior qualification
    const updatedMs = new Date(conv.updatedAt || conv.createdAt).getTime();
    const hasUnread = !!conv.hasUnreadResult;
    const isNew = updatedMs > oneHourAgo;
    if (hasUnread || isNew || stickyIds.has(conv.id)) {
      recentUrgent.push(conv);
      continue;
    }

    // Bucket by the user's local calendar day so a 23:59 "yesterday" timestamp
    // and a 00:01 "today" timestamp end up in the right groups across the
    // local-midnight boundary.
    const bucket = groupByLocalDay(conv.updatedAt || conv.createdAt, now);
    if (bucket === "today") {
      today.push(conv);
    } else if (bucket === "yesterday" || bucket === "this-week") {
      thisWeek.push(conv);
    } else {
      past.push(conv);
    }
  }

  const groups: SessionGroup[] = [];
  if (review.length > 0) groups.push({ label: "Review", sessions: review, defaultOpen: true });
  if (live.length > 0) groups.push({ label: "Live", sessions: live, defaultOpen: true });
  if (active.length > 0) groups.push({ label: "Active", sessions: active, defaultOpen: true });
  if (pinned.length > 0) groups.push({ label: "Pinned", sessions: pinned, defaultOpen: true });
  if (recentUrgent.length > 0) groups.push({ label: "Recent", sessions: recentUrgent, defaultOpen: true });
  if (today.length > 0) groups.push({ label: "Today", sessions: today, defaultOpen: true });
  if (thisWeek.length > 0) groups.push({ label: "This Week", sessions: thisWeek, defaultOpen: false });
  if (past.length > 0) groups.push({ label: "Past", sessions: past, defaultOpen: false });
  if (snooze.length > 0) groups.push({ label: "Snooze", sessions: snooze, defaultOpen: false });
  if (archive.length > 0) groups.push({ label: "Archive", sessions: archive, defaultOpen: false });
  return groups;
}

const expandedSessionIds = new Set<string>();
const expansionSubscribers = new Set<() => void>();

function notifyExpansionChange() {
  expansionSubscribers.forEach((fn) => fn());
}

export function useSessionExpanded(id: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    expansionSubscribers.add(cb);
    return () => { expansionSubscribers.delete(cb); };
  }, []);
  const getSnapshot = useCallback(() => expandedSessionIds.has(id), [id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function toggleSessionExpanded(id: string) {
  if (expandedSessionIds.has(id)) {
    expandedSessionIds.delete(id);
  } else {
    expandedSessionIds.add(id);
  }
  notifyExpansionChange();
}

const MAX_INDENT_PX = 96;
const INDENT_STEP_PX = 16;

function buildHoverTitle(conv: ChatSession): string {
  const parts: string[] = [];
  const role = conv.sessionType ? `${conv.sessionType} session` : "session";
  parts.push(role);
  if (conv.spawnReason) parts.push(`spawned: ${conv.spawnReason}`);
  if (conv.spawnerTool) parts.push(`via ${conv.spawnerTool}`);
  if (conv.pinReason) parts.push(`pin: ${conv.pinReason}`);
  if (conv.errorSeverity) parts.push(`error: ${conv.errorSeverity}`);
  if (conv.topics && conv.topics.length > 0) parts.push(`topics: ${conv.topics.slice(0, 3).join(", ")}`);
  return parts.join(" • ");
}

export function ConversationItem({
  conv,
  isActive,
  isLive,
  isTransportLive,
  childCount = 0,
  sessions,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onOpenInParent,
  onTogglePin,
}: {
  conv: ChatSession;
  isActive: boolean;
  isLive: boolean;
  isTransportLive: boolean;
  childCount?: number;
  sessions: ChatSession[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onOpenInParent?: () => void;
  onTogglePin?: (id: string, pinned: boolean) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conv.title);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [iconHovered, setIconHovered] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const startRename = useCallback(() => {
    if (!isActive) return;
    setRenameValue(conv.title);
    setIsRenaming(true);
    requestAnimationFrame(() => {
      const input = renameInputRef.current;
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }, [conv.title, isActive]);

  const prevLiveRef = useRef(isLive);
  useEffect(() => {
    if (prevLiveRef.current !== isLive) {
      log.debug(`sidebar live-state transition convId=${conv.id} type=${conv.sessionType} isLive=${isLive} status=${conv.status}`);
      prevLiveRef.current = isLive;
    }
  }, [isLive, conv.id, conv.sessionType, conv.status]);

  const submitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== conv.title) {
      onRename(conv.id, trimmed);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setRenameValue(conv.title);
    setIsRenaming(false);
  };

  const hasUnreadResult = !!conv.hasUnreadResult;
  const isLastSenderAgent = conv.lastMessageRole === "assistant" || conv.lastMessageRole === "tool";
  const isPinned = !!conv.isPinned;

  // Build status text class — error/active are semantic states; unread uses foreground.
  // Read/already-viewed sessions are muted, including pinned sessions.
  const isAwaitingQuestion = !!conv.awaitingQuestionResponse;
  const statusTextClass = conv.errorSeverity === "error" && !isLive
    ? "text-error"
    : isLive
      ? "text-active font-medium motion-safe:animate-pulse"
      : isAwaitingQuestion
        ? "text-active font-medium"
        : conv.hasActiveDescendant || conv.hasActivePlan
          ? "text-active font-medium motion-safe:animate-pulse"
          : hasUnreadResult
            ? "text-foreground font-medium"
            : "text-muted-foreground";

  // Build container class — selected uses bg-sidebar-accent but keeps status color
  const containerClass = cn(
    "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden",
    isActive ? "bg-accent" : "hover:bg-accent/70",
    statusTextClass
  );

  // Determine which icon to show:
  // - Live/active descendant + NOT hovering icon: spinner
  // - Hovering icon area OR pinned (when not live): pin icon (clickable)
  // - Default: Bot or User icon
  const isWaiting = conv.status === "waiting";
  const isMeeting = conv.type === "meeting";
  const isVoice = conv.type === "voice";
  const isSpinning = !isWaiting && !isMeeting && !isVoice && !isAwaitingQuestion && (isLive || !!conv.hasActiveDescendant || !!conv.hasActivePlan);
  const showPinIcon = (isPinned && !isSpinning && !isWaiting) || iconHovered;
  const isIconInteractive = iconHovered || (isPinned && !isSpinning);

  const handleIconClick = (e: MouseEvent) => {
    if (isIconInteractive && onTogglePin) {
      e.stopPropagation();
      onTogglePin(conv.id, !isPinned);
    }
  };

  const renderIcon = () => {
    if (isWaiting && !iconHovered) {
      return <Timer className="h-3.5 w-3.5 shrink-0 text-active" data-testid={`icon-conversation-waiting-${conv.id}`} />;
    }
    if (isAwaitingQuestion && !iconHovered && !isLive) {
      return <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-active" data-testid={`icon-conversation-question-${conv.id}`} />;
    }
    if (isSpinning && !iconHovered) {
      return <ActiveStatusSpinner className="h-3.5 w-3.5" />;
    }
    if (showPinIcon) {
      return (
        <Pin
          className={cn("h-3.5 w-3.5 shrink-0 transition-colors", isPinned ? "text-foreground" : "text-muted-foreground")}
          {...(isPinned ? { fill: "currentColor" } : {})}
          data-testid={`icon-conversation-pin-${conv.id}`}
        />
      );
    }
    if (isMeeting) {
      return (
        <Radio
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isTransportLive ? "text-active motion-safe:animate-pulse" : "text-muted-foreground",
          )}
          data-testid={`icon-conversation-meeting-${conv.id}`}
        />
      );
    }
    if (isVoice) {
      return (
        <Mic
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isTransportLive ? "text-active motion-safe:animate-pulse" : "text-muted-foreground",
          )}
          data-testid={`icon-conversation-voice-${conv.id}`}
        />
      );
    }
    if (conv.errorSeverity === "error") {
      return isLastSenderAgent
        ? <Bot className="h-3.5 w-3.5 shrink-0 text-destructive" data-testid={`icon-conversation-xyz-${conv.id}`} />
        : <User className="h-3.5 w-3.5 shrink-0 text-destructive" data-testid={`icon-conversation-user-${conv.id}`} />;
    }
    return isLastSenderAgent
      ? <Bot className="h-3.5 w-3.5 shrink-0" data-testid={`icon-conversation-xyz-${conv.id}`} />
      : <User className="h-3.5 w-3.5 shrink-0" data-testid={`icon-conversation-user-${conv.id}`} />;
  };

  return (
    <div
      className={containerClass}
      onClick={() => !isRenaming && onSelect(conv.id)}
      title={isRenaming ? undefined : conv.title + " • " + buildHoverTitle(conv)}
      data-testid={`session-item-${conv.id}`}
    >
      <span
        className={cn("flex items-center justify-center shrink-0", isIconInteractive && "cursor-pointer")}
        onMouseEnter={() => setIconHovered(true)}
        onMouseLeave={() => setIconHovered(false)}
        onClick={handleIconClick}
        data-testid={`icon-area-${conv.id}`}
      >
        {renderIcon()}
      </span>
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="flex-1 min-w-0 bg-transparent border-b border-primary outline-none text-sm"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          onBlur={submitRename}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid={`input-rename-conversation-${conv.id}`}
        />
      ) : (
        <span className="flex-1 min-w-0 pr-6">
          <button
            type="button"
            className={cn(
              "inline-flex max-w-full min-w-0 items-baseline text-left align-baseline",
              isActive ? "cursor-text" : "cursor-pointer",
              conv.sessionType === "autonomous" && "italic"
            )}
            onClick={(e) => {
              if (!isActive) return;
              e.stopPropagation();
              startRename();
            }}
            aria-label={isActive ? `Rename ${conv.title}` : conv.title}
            data-testid={`button-rename-title-${conv.id}`}
          >
            <span className="truncate">
              {conv.title && conv.title.length > 30 ? conv.title.slice(0, 30) + "…" : conv.title}
            </span>
            {childCount > 0 && (
              <span
                className="ml-1 shrink-0 text-xs tabular-nums text-muted-foreground/70 font-normal"
                data-testid={`badge-child-count-${conv.id}`}
              >
                ({childCount})
              </span>
            )}
          </button>
        </span>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center h-6 w-6 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent ${
              isActive ? "bg-accent" : "bg-accent/50"
            }`}
            onClick={(e) => e.stopPropagation()}
            data-testid={`button-conversation-menu-${conv.id}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
          <SessionActionsMenuItems
            sessionId={conv.id}
            sessionTitle={conv.title}
            parentSessionId={conv.parentSessionId}
            onRename={startRename}
            onSelectSession={onSelect}
            onArchive={onArchive}
            onDelete={setDeleteConfirmId}
            isArchived={!!conv.archivedAt}
            isPinned={isPinned}
            onTogglePin={onTogglePin}
            onOpenInParent={onOpenInParent}
            onShowDetails={() => setDetailsOpen(true)}
            testIdPrefix={`button-conversation-${conv.id}`}
            stopPropagation
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation</AlertDialogTitle>
            <AlertDialogDescription>
              {getSessionDeletionDescription(sessions, deleteConfirmId)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirmId) onDelete(deleteConfirmId);
                setDeleteConfirmId(null);
              }}
              data-testid="button-delete-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SessionDetailsModal
        sessionId={conv.id}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        onNavigateSession={(id) => {
          setDetailsOpen(false);
          onSelect(id);
        }}
      />
    </div>
  );
}

function navigateToParentContext(parentId: string, childId: string, onSelect: (id: string) => void) {
  onSelect(parentId);
  if (typeof window !== "undefined") {
    const anchor = `child-session-${childId}`;
    window.location.hash = anchor;
    setTimeout(() => {
      const el = document.getElementById(anchor);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  }
}

export function SessionTreeNode({
  conv,
  sessions,
  depth,
  activeSession,
  liveVoiceConversationId,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onTogglePin,
}: {
  conv: ChatSession;
  sessions: ChatSession[];
  depth: number;
  activeSession: string | null;
  liveVoiceConversationId?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onTogglePin?: (id: string, pinned: boolean) => void;
}) {
  const childCount = conv.directChildCount ?? 0;
  const hasChildren = childCount > 0;
  const expanded = useSessionExpanded(conv.id);
  const indentPx = Math.min(depth * INDENT_STEP_PX, MAX_INDENT_PX);

  const { data: children = [], isLoading: childrenLoading } = useQuery<ChatSession[]>({
    queryKey: ["/api/sessions", conv.id, "children"],
    enabled: expanded && hasChildren,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const isTransportLive = isLiveTransportSession(conv, liveVoiceConversationId);

  return (
    <div className="min-w-0" data-testid={`tree-node-${conv.id}`}>
      <div className="flex min-w-0 items-stretch" style={{ paddingLeft: indentPx }}>
        {depth > 0 && (
          <div className="shrink-0 w-5 self-stretch relative mr-1" aria-hidden="true">
            <div className="absolute left-1/2 top-0 bottom-1/2 -translate-x-px border-l border-border" />
            <div className="absolute left-1/2 top-1/2 right-0 border-t border-border" />
          </div>
        )}
        <div className="flex-1 min-w-0 relative overflow-hidden">
          <ConversationItem
            conv={conv}
            isActive={activeSession === conv.id}
            isLive={conv.status === "streaming" || isTransportLive}
            isTransportLive={isTransportLive}
            childCount={childCount}
            sessions={sessions}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
            onArchive={onArchive}
            onTogglePin={onTogglePin}
            onOpenInParent={
              conv.parentSessionId
                ? () => navigateToParentContext(conv.parentSessionId!, conv.id, onSelect)
                : undefined
            }
          />
          {hasChildren && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleSessionExpanded(conv.id);
              }}
              className="absolute right-8 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors z-10"
              aria-label={expanded ? "Collapse children" : "Expand children"}
              data-testid={`button-tree-twisty-${conv.id}`}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
            </button>
          )}
        </div>
      </div>
      {expanded && hasChildren && (
        <div className="space-y-0 mt-0" data-testid={`tree-children-${conv.id}`}>
          {childrenLoading && children.length === 0 ? (
            <div className="flex items-center pl-6 py-1" style={{ paddingLeft: indentPx + 24 }}>
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
            </div>
          ) : (
            [...children]
              .sort(sortByUpdated)
              .map((child) => (
                <SessionTreeNode
                  key={child.id}
                  conv={child}
                  sessions={sessions}
                  depth={depth + 1}
                  activeSession={activeSession}
                  liveVoiceConversationId={liveVoiceConversationId}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                  onArchive={onArchive}
                  onTogglePin={onTogglePin}
                />
              ))
          )}
        </div>
      )}
    </div>
  );
}

export function SessionGroupSection({
  group,
  sessions,
  activeSession,
  liveVoiceConversationId,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onTogglePin,
}: {
  group: SessionGroup;
  sessions: ChatSession[];
  activeSession: string | null;
  liveVoiceConversationId?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onTogglePin?: (id: string, pinned: boolean) => void;
}) {
  const hasLiveConv = group.sessions.some(isDurablyActiveSession);
  const hasActiveSess = !!activeSession && group.sessions.some(c => c.id === activeSession);
  const staysCollapsedByDefault = group.label === "Snooze" || group.label === "Archive";
  const [open, setOpen] = useState(
    !staysCollapsedByDefault && (group.defaultOpen || hasLiveConv || hasActiveSess),
  );

  useEffect(() => {
    if (!staysCollapsedByDefault && (hasLiveConv || hasActiveSess)) setOpen(true);
  }, [staysCollapsedByDefault, hasLiveConv, hasActiveSess]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md" data-testid={`button-group-${group.label.toLowerCase()}`}>
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {group.label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0 mt-0">
          {group.sessions.map((conv) => (
            <SessionTreeNode
              key={conv.id}
              conv={conv}
              sessions={sessions}
              depth={0}
              activeSession={activeSession}
              liveVoiceConversationId={liveVoiceConversationId}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              onArchive={onArchive}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Autonomous sessions group at the bottom — collapsed by default, shows last 48h with Load More. */
function AutoSessionsGroup({
  sessions,
  activeSession,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onTogglePin,
}: {
  sessions: ChatSession[];
  activeSession: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onTogglePin?: (id: string, pinned: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Filter autonomous sessions from the already-loaded sessions list
  const allAutoSessions = useMemo(() =>
    sessions
      .filter(s => s.sessionType === "autonomous")
      .sort(sortByUpdated),
    [sessions]
  );

  // Show only last 48h by default, all when "Load More" is clicked
  const fortyEightHoursAgo = useMemo(() => Date.now() - 48 * 60 * 60 * 1000, []);
  const recentAutoSessions = useMemo(() =>
    allAutoSessions.filter(s => new Date(s.updatedAt || s.createdAt).getTime() > fortyEightHoursAgo),
    [allAutoSessions, fortyEightHoursAgo]
  );

  const autoSessions = showAll ? allAutoSessions : recentAutoSessions;
  const hasOlder = allAutoSessions.length > recentAutoSessions.length;
  const hasLive = allAutoSessions.some(s => s.status === "streaming");

  if (allAutoSessions.length === 0 && !open) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md" data-testid="button-group-system">
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex items-center gap-1.5">
          System
          {hasLive && <ActiveStatusSpinner className="h-3 w-3" />}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0 mt-0">
          {autoSessions.map((conv) => (
            <SessionTreeNode
              key={conv.id}
              conv={conv}
              sessions={sessions}
              depth={0}
              activeSession={activeSession}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              onArchive={onArchive}
              onTogglePin={onTogglePin}
            />
          ))}
          {!showAll && hasOlder && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowAll(true);
              }}
              className="w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md transition-colors text-center"
              data-testid="button-auto-load-more"
            >
              Load More…
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConversationSidebar({
  sessions,
  convsLoading,
  activeSession,
  isAgentRunning,
  hideForSessionTranscript,
  searchQuery,
  setSearchQuery,

  onSelect,
  onDelete,
  onRename,
  onArchive,
  onStartNewChat,
  scrollResetKey,
}: {
  sessions: ChatSession[];
  convsLoading: boolean;
  activeSession: string | null;
  isAgentRunning: boolean;
  hideForSessionTranscript: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onStartNewChat: () => void;
  scrollResetKey?: number;
}) {
  const { toast } = useToast();
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const voiceSession = useVoiceSessionOptional();
  const liveVoiceConversationId = voiceSession?.status === "active"
    ? voiceSession.activeConversationId
    : null;

  const togglePin = useMutation({
    mutationFn: async ({ id, isPinned }: { id: string; isPinned: boolean }) => {
      await apiRequest("PATCH", `/api/gateway/conversations/${id}/attention`, { isPinned });
    },
    onMutate: async ({ id, isPinned }) => {
      const key = ["/api/sessions"];
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<ChatSession[]>(key, (old) =>
        old?.map(s => s.id === id ? { ...s, isPinned } : s)
      );
    },
    onError: (_err) => {
      toast({ title: "Failed to toggle pin", description: String(_err), variant: "destructive" });
    },
    onSettled: () => {
      emitSessionListChanged("pin-toggle");
    },
  });

  const handleTogglePin = useCallback((id: string, pinned: boolean) => {
    togglePin.mutate({ id, isPinned: pinned });
  }, [togglePin]);

  const sessionsWithChildCounts = useMemo(() => {
    const visibleIds = new Set(sessions.map(s => s.id));
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (s.parentSessionId && visibleIds.has(s.parentSessionId)) {
        counts.set(s.parentSessionId, (counts.get(s.parentSessionId) || 0) + 1);
      }
    }
    return sessions.map(s => {
      const parentMissing = s.parentMissing ?? (!!s.parentSessionId && !visibleIds.has(s.parentSessionId));
      const directChildCount = s.directChildCount ?? (counts.get(s.id) || 0);
      return { ...s, parentMissing, directChildCount };
    });
  }, [sessions]);

  // Filter: exclude autonomous sessions from main groups (they go to System section)
  // Also exclude child sessions (shown via tree expansion)
  const filteredConversations = useMemo(() => {
    const queryTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return sessionsWithChildCounts.filter(c => {
      if (c.parentSessionId && !c.parentMissing && !c.archivedAt && !c.reminder?.active) return false;
      // Exclude autonomous sessions — they go to the System group at the bottom
      if (c.sessionType === "autonomous") return false;
      if (queryTokens.length > 0) {
        const title = (c.title || "").toLowerCase();
        const topicsText = (c.topics || []).join(" ").toLowerCase();
        if (!queryTokens.every(token => title.includes(token) || topicsText.includes(token))) return false;
      }
      return true;
    });
  }, [sessionsWithChildCounts, searchQuery]);

  // Sticky set: sessions that qualified for "Recent" on initial load stay there
  // until the next page refresh (not removed mid-session when unread clears / age > 1h).
  const recentStickyIds = useRef(new Set<string>());
  useMemo(() => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    for (const c of filteredConversations) {
      const updatedMs = new Date(c.updatedAt || c.createdAt).getTime();
      if (c.hasUnreadResult || updatedMs > oneHourAgo) {
        recentStickyIds.current.add(c.id);
      }
    }
  }, [filteredConversations]);

  const groups = groupSessions(filteredConversations, { liveVoiceConversationId, recentStickyIds: recentStickyIds.current });

  useEffect(() => {
    if (scrollResetKey === undefined) return;
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]"
    );
    viewport?.scrollTo({ top: 0, left: 0 });
  }, [scrollResetKey]);

  return (
    <div className={`w-full min-w-0 flex flex-col overflow-hidden bg-background text-foreground ${hideForSessionTranscript ? "hidden md:flex" : "flex"}`}>

      <ScrollArea ref={scrollAreaRef} className="flex-1 min-w-0">
        <div className="min-w-0 p-2 space-y-1">
          <HierarchySearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            inputTestId="input-search-sessions"
            clearTestId="button-clear-search"
            ariaLabel="Search sessions"
          />
          {/* + New Session button */}
          <button
            type="button"
            onClick={onStartNewChat}
            disabled={!isAgentRunning}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-new-chat"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Session</span>
          </button>
          {convsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 px-4">
              <MessageSquare className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No sessions yet</p>
            </div>
          ) : groups.length === 0 && searchQuery.trim() ? (
            <div className="text-center py-8 px-4">
              <Search className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No sessions match "{searchQuery.trim()}"</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="text-center py-8 px-4">
              <MessageSquare className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No matching sessions</p>
            </div>
          ) : (
            groups.map((group) => (
              <SessionGroupSection
                key={group.label}
                group={group}
                sessions={sessionsWithChildCounts}
                activeSession={activeSession}
                liveVoiceConversationId={liveVoiceConversationId}
                onSelect={onSelect}
                onDelete={(id) => onDelete(id)}
                onRename={(id, title) => onRename(id, title)}
                onArchive={(id) => onArchive(id)}
                onTogglePin={handleTogglePin}
              />
            ))
          )}
          {/* System sessions group at the bottom */}
          {!convsLoading && sessions.length > 0 && (
            <AutoSessionsGroup
              sessions={sessionsWithChildCounts}
              activeSession={activeSession}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              onArchive={onArchive}
              onTogglePin={handleTogglePin}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
