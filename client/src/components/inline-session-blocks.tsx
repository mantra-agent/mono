import { useState, useMemo, useRef, useCallback, useEffect, memo } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { emitSessionListChanged } from "@/hooks/use-data-sync";
import {
  Bot,
  ChevronRight,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { formatCost } from "@/lib/format-utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { stripMessageTimestamp } from "@/components/chat-shared";
import { useEventStream } from "@/hooks/use-event-stream";
import {
  segmentsFromSavedMessage,
  type ChatMessage,
  type ChildSessionBlockMeta,
  type CrossSessionMeta,
} from "@/components/chat-shared";
import { SegmentStream } from "@/components/segment-stream";
import { useSessionSubscription, type SessionStreamState } from "@/hooks/use-session-subscription";
import { useVisibilityLayer } from "@/hooks/use-visibility-layer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageSegment } from "@shared/streaming-types";
import { ActiveStatusSpinner } from "@/components/nav-dot";

interface ChildSessionPayload {
  title?: string | null;
  status?: string | null;
  messages?: ChatMessage[];
}

function hasTimelineActivity(segments: MessageSegment[]): boolean {
  return segments.some((segment) => segment.type === "timeline" && segment.steps.length > 0);
}

function latestContentFromSegments(segments: MessageSegment[]): string | null {
  for (const segment of [...segments].reverse()) {
    if (segment.type === "content") {
      const text = stripMessageTimestamp(segment.content).trim().replace(/\s+/g, " ");
      if (text) return text;
    }

    const latestStep = [...segment.steps].reverse().find((step) => {
      return Boolean(step.narrative || step.systemStepDetail || step.thinking || step.toolName || step.systemStepName);
    });
    if (!latestStep) continue;

    const text = (
      latestStep.narrative ||
      latestStep.systemStepDetail ||
      latestStep.thinking ||
      (latestStep.toolName ? `Using ${latestStep.toolName}` : null) ||
      latestStep.systemStepName ||
      null
    )?.trim().replace(/\s+/g, " ");
    if (text) return text;
  }

  return null;
}

export const ChildSessionBlock = memo(function ChildSessionBlock({
  meta,
  sessionKey,
  depth = 0,
  sessionTitleById,
  childStream,
}: {
  meta: ChildSessionBlockMeta;
  sessionKey?: string | null;
  depth?: number;
  sessionTitleById?: Record<string, string>;
  childStream?: SessionStreamState;
}) {
  const { layer } = useVisibilityLayer();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const turnsRef = useRef<HTMLDivElement | null>(null);

  const { data: childSession, isLoading: childSessionLoading, isFetching: childSessionFetching } = useQuery<ChildSessionPayload>({
    queryKey: ["/api/sessions", meta.childSessionId],
    enabled: !deleted,
    refetchInterval: (childSession) => childSession.state.data?.status === "streaming" || expanded ? 3000 : false,
  });

  const isChildStreaming = childSession?.status === "streaming" || childStream?.status === "streaming";

  // Active child sessions must update their collapsed preview too.
  // The persisted session row status is the activity authority, matching the Session Menu.
  const subscriptionId = isChildStreaming && depth < 2 && !childStream ? meta.childSessionId : null;
  const fallbackChildSub = useSessionSubscription(subscriptionId);
  const childSub = childStream ?? fallbackChildSub;

  const deleteChildSession = useMutation({
    mutationFn: async () => {
      await apiRequest(
        "DELETE",
        `/api/sessions/${encodeURIComponent(meta.parentSessionId)}/child-blocks/${encodeURIComponent(meta.childSessionId)}`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", meta.parentSessionId] });
      queryClient.removeQueries({ queryKey: ["/api/sessions", meta.childSessionId] });
      emitSessionListChanged("inline-child-delete");
      setDeleted(true);
      setDeleteConfirmOpen(false);
    },
    onError: (err) => {
      toast({
        title: "Failed to delete child session",
        description: String(err),
        variant: "destructive",
      });
    },
  });

  const childMessages = childSession?.messages ?? [];
  const childTurnsLoading = !childSession && (childSessionLoading || childSessionFetching);
  // Prefer the spawn-time title (meta.role) when it carries a step prefix,
  // because orient may overwrite the live session title mid-execution.
  const spawnTitle = meta.role;
  const liveTitle = childSession?.title || sessionTitleById?.[meta.childSessionId];
  const displayTitle = (spawnTitle && /^Step \d+:/.test(spawnTitle))
    ? spawnTitle
    : (liveTitle || spawnTitle || meta.childSessionId);
  const hasError = Boolean(meta.error);
  const iconClass = hasError
    ? "text-destructive"
    : "text-muted-foreground/60";
  const tileClass = hasError
    ? "border-destructive/50 bg-destructive/10"
    : "border-border/60 bg-muted/20";
  const titleClass = hasError
    ? "text-destructive"
    : isChildStreaming
      ? "text-active animate-pulse"
      : "";

  const segments: MessageSegment[] = useMemo(() => {
    if (isChildStreaming && childSub.streamingContent) {
      return childSub.streamingContent.segments;
    }
    if (childMessages.length > 0) {
      return childMessages
        .filter(m => m.role === "assistant")
        .flatMap(m => segmentsFromSavedMessage(m));
    }
    return [];
  }, [isChildStreaming, childSub.streamingContent, childMessages]);

  const latestLine = useMemo(() => {
    const streamingLine = isChildStreaming ? latestContentFromSegments(childSub.streamingContent?.segments ?? []) : null;
    if (streamingLine) return streamingLine;

    const latest = [...childMessages]
      .reverse()
      .find((message) => message.role === "assistant" || message.role === "user");
    const text = stripMessageTimestamp(latest?.content || meta.summary || "").trim().replace(/\s+/g, " ");
    return text || (isChildStreaming ? "Starting..." : "Open child session");
  }, [isChildStreaming, childSub.streamingContent, childMessages, meta.summary]);

  const hasExecutionActivity = useMemo(() => hasTimelineActivity(segments), [segments]);

  useEffect(() => {
    if (!expanded || !turnsRef.current) return;
    turnsRef.current.scrollTop = turnsRef.current.scrollHeight;
  }, [expanded, segments.length, childMessages.length]);

  const childHref = `/session?c=${encodeURIComponent(meta.childSessionId)}`;

  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  const modelLabel = meta.model ? meta.model.split("/").pop() : null;

  if (deleted) return null;

  return (
    <div
      id={`child-session-${meta.childSessionId}`}
      className={`border rounded-md my-1 scroll-mt-20 ${tileClass} ${expanded ? "" : "cursor-pointer"}`}
      onClick={!expanded ? toggleExpanded : undefined}
      data-testid={`child-session-block-${meta.childSessionId}`}
    >
      <div
        className="flex items-center gap-2 px-3 py-2"
        data-testid={`button-toggle-child-${meta.childSessionId}`}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0 text-sm text-foreground/90">
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded();
            }}
            aria-label={expanded ? "Collapse child session" : "Expand child session"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          {isChildStreaming && !hasError ? (
            <ActiveStatusSpinner className="h-3.5 w-3.5" />
          ) : (
            <Bot className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} data-testid={`icon-child-agent-${meta.childSessionId}`} />
          )}
          <Link
            href={childHref}
            className={`min-w-0 truncate flex-1 text-left hover:underline underline-offset-2 ${hasError ? "hover:text-destructive" : "hover:text-cat-ai"} ${titleClass}`}
            onClick={(event) => event.stopPropagation()}
            data-testid={`link-child-session-${meta.childSessionId}`}
            title="Open child session"
          >
            <span className="truncate" data-testid={`text-child-role-${meta.childSessionId}`}>
              {displayTitle}
            </span>
          </Link>
          {modelLabel && (
            <span className="text-xs text-muted-foreground/70 truncate" data-testid={`text-child-model-${meta.childSessionId}`}>
              · {modelLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(event) => event.stopPropagation()}
                aria-label="Child session actions"
                data-testid={`button-child-session-menu-${meta.childSessionId}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteConfirmOpen(true);
                }}
                data-testid={`button-delete-child-session-${meta.childSessionId}`}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {(meta.cost != null && meta.cost > 0) && (
            <span className="text-xs tabular-nums text-muted-foreground/60" data-testid={`text-child-cost-${meta.childSessionId}`}>
              {formatCost(meta.cost)}
            </span>
          )}
        </div>
      </div>

      {meta.error && (
        <div className="px-3 pb-2 text-xs text-destructive" data-testid={`text-child-error-${meta.childSessionId}`}>
          {meta.error}
        </div>
      )}

      {!expanded && (
        <div className="px-8 pb-2 min-h-7" data-testid={`text-child-summary-${meta.childSessionId}`}>
          {hasExecutionActivity ? (
            <div className="max-h-7 overflow-hidden">
              <SegmentStream
                segments={segments}
                isStreaming={isChildStreaming && childSub.status === "streaming"}
                layer={1}
                suppressTrailingThinking
              />
            </div>
          ) : (
            <div className="text-xs leading-6 text-muted-foreground truncate">
              {latestLine}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div ref={turnsRef} className="border-t border-border/40 max-h-32 overflow-y-auto scrollbar-thin px-3 py-2" data-testid={`child-turns-${meta.childSessionId}`}>
          {segments.length === 0 && isChildStreaming ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
              <Loader2 className="h-3 w-3 animate-spin" />
              Starting...
            </div>
          ) : segments.length === 0 && childTurnsLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading turns...
            </div>
          ) : segments.length === 0 ? (
            <div className="text-xs text-muted-foreground/70">
              No saved turns yet.
            </div>
          ) : (
            <SegmentStream
              segments={segments}
              isStreaming={isChildStreaming && childSub.status === "streaming"}
              layer={Math.max(layer, 2) as 2 | 3 | 4}
            />
          )}
        </div>
      )}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent onClick={(event) => event.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete inline session</AlertDialogTitle>
            <AlertDialogDescription>
              Delete this inline session widget and its associated child session? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-child-${meta.childSessionId}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.stopPropagation();
                deleteChildSession.mutate();
              }}
              data-testid={`button-confirm-delete-child-${meta.childSessionId}`}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

function shortSessionLabel(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export const CrossSessionAnnotation = memo(function CrossSessionAnnotation({
  meta,
  content,
  perspective,
  sessionTitleById,
}: {
  meta: CrossSessionMeta;
  content: string;
  perspective: "sender" | "receiver";
  sessionTitleById?: Record<string, string>;
}) {
  const isSender = perspective === "sender";
  const sessionId = meta.fromSessionId;
  const sessionTitle = meta.fromLabel ?? sessionTitleById?.[sessionId] ?? shortSessionLabel(sessionId);
  const directionLabel = "From";
  const bubbleTone = isSender
    ? "bg-info/10 border-info/20"
    : "bg-cta/10 border-cta/20";
  const headerTone = isSender ? "text-info-foreground" : "text-cta";

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1"
      data-testid={`cross-session-${meta.fromSessionId}-${meta.toSessionId}`}
    >
      <div className={`rounded-lg border px-3 py-2 ${bubbleTone}`}>
        <div className={`mb-1.5 flex min-w-0 items-baseline gap-1.5 text-xs font-medium ${headerTone}`}>
          <span className="shrink-0 font-semibold uppercase tracking-wider" data-testid="text-cross-session-label">
            {directionLabel}
          </span>
          <span className="shrink-0 text-muted-foreground/35">·</span>
          <span className="min-w-0 truncate" data-testid="text-cross-session-title">{sessionTitle}</span>
        </div>
        <div className="text-xs text-muted-foreground/85 leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_*]:text-muted-foreground/85 [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:font-mono [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold" data-testid="text-cross-session-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
});

export interface LiveChildBlock {
  meta: ChildSessionBlockMeta;
  receivedAt: number;
}

export interface LiveCrossMessage {
  id: string;
  meta: CrossSessionMeta;
  content: string;
  receivedAt: number;
}

export function useLiveSessionBlocks(parentSessionId: string | null | undefined) {
  const { events } = useEventStream();
  const seenChildKeys = useRef<Map<string, number>>(new Map());

  return useMemo(() => {
    const childMap = new Map<string, LiveChildBlock>();
    const crossList: LiveCrossMessage[] = [];
    const seenCrossKeys = new Set<string>();
    if (!parentSessionId) return { childBlocks: [] as LiveChildBlock[], crossMessages: crossList };

    for (const ev of events) {
      if (ev.category !== "chat") continue;
      if (ev.event !== "chat.child_lifecycle" && ev.event !== "chat.cross_session_message") continue;
      const payload = ev.payload;
      if (!payload || typeof payload !== "object") continue;

      if (payload.type === "child_session_block" && payload.block) {
        const block = payload.block as ChildSessionBlockMeta;
        if (block.parentSessionId !== parentSessionId) continue;
        if (block.error === "Deleted") {
          childMap.delete(block.childSessionId);
          continue;
        }
        const existing = childMap.get(block.childSessionId);
        if (!existing || ev.timestamp >= existing.receivedAt) {
          childMap.set(block.childSessionId, { meta: block, receivedAt: ev.timestamp });
        }
      } else if (payload.type === "cross_session" && payload.cross) {
        const cross = payload.cross as CrossSessionMeta;
        if (cross.fromSessionId !== parentSessionId && cross.toSessionId !== parentSessionId) continue;
        const content = typeof payload.content === "string" ? payload.content : "";
        const crossKey = `${cross.fromSessionId}:${cross.toSessionId}:${cross.chainId ?? ""}:${cross.depth ?? 0}`;
        if (seenCrossKeys.has(crossKey)) continue;
        seenCrossKeys.add(crossKey);
        crossList.push({ id: ev.id, meta: cross, content, receivedAt: ev.timestamp });
      } else if (payload.type === "cross_session_message") {
        const cross: CrossSessionMeta = {
          fromSessionId: String(payload.fromSessionId ?? ""),
          toSessionId: String(payload.toSessionId ?? ""),
          direction: payload.direction === "parent" || payload.direction === "child" || payload.direction === "sibling" || payload.direction === "direct" ? payload.direction : "sibling",
          chainId: typeof payload.chainId === "string" ? payload.chainId : undefined,
          depth: typeof payload.depth === "number" ? payload.depth : undefined,
          fromLabel: typeof payload.fromLabel === "string" ? payload.fromLabel : undefined,
          toLabel: typeof payload.toLabel === "string" ? payload.toLabel : undefined,
        };
        if (cross.fromSessionId !== parentSessionId && cross.toSessionId !== parentSessionId) continue;
        const content = typeof payload.content === "string" ? payload.content : "";
        const crossKey = `${cross.fromSessionId}:${cross.toSessionId}:${cross.chainId ?? ""}:${cross.depth ?? 0}`;
        if (seenCrossKeys.has(crossKey)) continue;
        seenCrossKeys.add(crossKey);
        crossList.push({ id: ev.id, meta: cross, content, receivedAt: ev.timestamp });
      }
    }

    return {
      childBlocks: Array.from(childMap.values()).sort((a, b) => a.receivedAt - b.receivedAt),
      crossMessages: crossList,
    };
  }, [events, parentSessionId]);
}
