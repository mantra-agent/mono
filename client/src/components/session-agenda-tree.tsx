import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Circle,
  CircleCheck,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pause,
  SkipForward,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useAgendaDiscussion } from "@/hooks/use-agenda-discussion";
import { buildSessionAgendaDiscussionMessage } from "@/lib/agenda-discussion";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
} from "@/components/hierarchy-section-header";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  SessionAgenda,
  SessionAgendaItem,
  SessionAgendaItemStatus,
} from "@shared/models/chat";

const AGENDA_SECTION_OPEN_KEY = "mantra.session.agenda-section-open.v1";
const MAX_PRINCIPALS = 12;
const MAX_SESSIONS_PER_PRINCIPAL = 64;

type SessionOpenMap = Record<string, boolean>;
type PrincipalOpenMap = Record<string, SessionOpenMap>;

function readOpenMap(): PrincipalOpenMap {
  try {
    const raw = window.localStorage.getItem(AGENDA_SECTION_OPEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const principals: PrincipalOpenMap = {};
    for (const [principalKey, value] of Object.entries(parsed).slice(-MAX_PRINCIPALS)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const sessions: SessionOpenMap = {};
      for (const [sessionKey, open] of Object.entries(value).slice(-MAX_SESSIONS_PER_PRINCIPAL)) {
        if (typeof open === "boolean") sessions[sessionKey] = open;
      }
      principals[principalKey] = sessions;
    }
    return principals;
  } catch {
    return {};
  }
}

function readAgendaSectionOpen(
  principalKey: string | null,
  sessionId: string,
): boolean | null {
  if (!principalKey) return null;
  const value = readOpenMap()[principalKey]?.[sessionId];
  return typeof value === "boolean" ? value : null;
}

function persistAgendaSectionOpen(
  principalKey: string,
  sessionId: string,
  open: boolean,
): void {
  try {
    const current = readOpenMap();
    const sessions = {
      ...(current[principalKey] ?? {}),
      [sessionId]: open,
    };
    const boundedSessions = Object.fromEntries(
      Object.entries(sessions).slice(-MAX_SESSIONS_PER_PRINCIPAL),
    );
    delete current[principalKey];
    current[principalKey] = boundedSessions;
    const boundedPrincipals = Object.fromEntries(
      Object.entries(current).slice(-MAX_PRINCIPALS),
    );
    window.localStorage.setItem(AGENDA_SECTION_OPEN_KEY, JSON.stringify(boundedPrincipals));
  } catch {
    // Browser storage is optional chrome. Agenda remains usable without it.
  }
}

function defaultAgendaSectionOpen(allItemsComplete: boolean): boolean {
  return !allItemsComplete;
}

interface SessionAgendaTreeProps {
  sessionId: string;
  sessionTitle?: string;
  parentSessionId?: string;
  parentSessionTitle?: string;
  agenda?: SessionAgenda;
}

interface AgendaItemRowProps {
  item: SessionAgendaItem;
  current: boolean;
  continues: boolean;
  discussPending: boolean;
  discussDisabled: boolean;
  onDiscuss: (item: SessionAgendaItem) => void;
}

function AgendaStatusIcon({
  status,
  current,
}: {
  status: SessionAgendaItemStatus;
  current: boolean;
}) {
  if (status === "complete") return <CircleCheck className="h-3.5 w-3.5 text-success" />;
  if (status === "skipped") return <SkipForward className="h-3.5 w-3.5 text-muted-foreground" />;
  if (status === "deferred") return <Pause className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Circle className={cn("h-3.5 w-3.5", current ? "text-active" : "text-muted-foreground/50")} />;
}

function AgendaItemRow({
  item,
  current,
  continues,
  discussPending,
  discussDisabled,
  onDiscuss,
}: AgendaItemRowProps) {
  const [open, setOpen] = useState(false);
  const isResolved = item.status === "complete" || item.status === "skipped";

  return (
    <HierarchyTreeRow continues={continues} connectorAnchor="first-row-center">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group relative min-w-0">
          <CollapsibleTrigger
            className={cn(
              HIERARCHY_SESSION_ROW_CLASS,
              "min-w-0 pr-9 hover:bg-accent/70",
              current && "bg-accent font-medium text-foreground",
              isResolved && !current && "text-muted-foreground",
            )}
            data-testid={`button-agenda-item-${item.id}`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
              <AgendaStatusIcon status={item.status} current={current} />
            </span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <ChevronRight
              className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                  current && "bg-accent text-foreground",
                )}
                data-testid={`button-agenda-menu-${item.id}`}
                onClick={(event) => event.stopPropagation()}
                aria-label={`Actions for ${item.title}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[140px]"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenuItem
                disabled={discussDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscuss(item);
                }}
                data-testid={`menu-agenda-discuss-${item.id}`}
              >
                {discussPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MessageSquare className="mr-2 h-3.5 w-3.5" />
                )}
                Discuss
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          <div className="pb-2 pl-10 pr-2 text-sm leading-normal">
            <p className="text-muted-foreground">{item.description}</p>
            {item.resolution && (
              <p className="mt-1.5 text-foreground/80">{item.resolution}</p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </HierarchyTreeRow>
  );
}

export function SessionAgendaTree({
  sessionId,
  sessionTitle,
  parentSessionId,
  parentSessionTitle,
  agenda,
}: SessionAgendaTreeProps) {
  const items = agenda?.items ?? [];
  const hasItems = items.length > 0;
  const allItemsComplete = hasItems && items.every((item) => item.status === "complete");
  const { user, principal } = useAuth();
  const principalKey = useMemo(() => {
    if (!user?.id || !principal?.accountId) return null;
    return `${principal.accountId}:${user.id}`;
  }, [principal?.accountId, user?.id]);
  const [open, setOpenState] = useState(() => {
    const stored = readAgendaSectionOpen(principalKey, sessionId);
    if (stored !== null) return stored;
    return defaultAgendaSectionOpen(allItemsComplete);
  });
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const discussMutation = useAgendaDiscussion();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const clearMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/sessions/${sessionId}/agenda`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (err) => {
      toast({ title: "Failed to clear agenda", description: String(err), variant: "destructive" });
    },
  });

  useEffect(() => {
    if (!hasItems) return;
    const stored = readAgendaSectionOpen(principalKey, sessionId);
    setOpenState(stored !== null ? stored : defaultAgendaSectionOpen(allItemsComplete));
  }, [allItemsComplete, hasItems, principalKey, sessionId]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (principalKey) persistAgendaSectionOpen(principalKey, sessionId, next);
  }, [principalKey, sessionId]);

  if (!hasItems) return null;

  const currentItem = items.find((item) => item.status === "open") ?? null;
  const currentItemId = currentItem?.id;

  return (
    <div className="min-w-0 border-b border-border/20 p-2" data-testid="session-agenda-tree">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group relative min-w-0">
          <CollapsibleTrigger
            className={cn(HIERARCHY_SECTION_HEADER_CLASS, "pr-9 hover-elevate")}
            data-testid="button-agenda-section"
          >
            <ChevronRight
              className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
              aria-hidden="true"
            />
            Agenda
          </CollapsibleTrigger>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                )}
                data-testid="button-agenda-section-menu"
                onClick={(event) => event.stopPropagation()}
                aria-label="Agenda actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[140px]"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={clearMutation.isPending}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowClearConfirm(true);
                }}
                data-testid="menu-agenda-clear"
              >
                {clearMutation.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                )}
                Clear agenda
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {!open && currentItem && (
          <div
            className={cn(
              HIERARCHY_SESSION_ROW_CLASS,
              "min-w-0 bg-accent font-medium text-foreground",
            )}
            data-testid="agenda-active-step-preview"
            aria-label={`Current agenda step: ${currentItem.title}`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
              <AgendaStatusIcon status={currentItem.status} current />
            </span>
            <span className="min-w-0 flex-1 truncate">{currentItem.title}</span>
          </div>
        )}
        <CollapsibleContent>
          <div className="min-w-0">
            {items.map((item, index) => (
              <AgendaItemRow
                key={item.id}
                item={item}
                current={item.id === currentItemId}
                continues={index < items.length - 1}
                discussPending={discussMutation.isPending && discussMutation.variables?.pendingKey === item.id}
                discussDisabled={discussMutation.isPending}
                onDiscuss={(selectedItem) => {
                  if (discussMutation.isPending || !agenda) return;
                  discussMutation.mutate({
                    pendingKey: selectedItem.id,
                    title: selectedItem.title,
                    message: buildSessionAgendaDiscussionMessage({
                      sessionId,
                      sessionTitle,
                      parentSessionId,
                      parentSessionTitle,
                      agenda,
                      item: selectedItem,
                    }),
                    clientTurnSuffix: selectedItem.id,
                  });
                }}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear agenda</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the agenda from this session. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-agenda-clear-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                clearMutation.mutate();
                setShowClearConfirm(false);
              }}
              data-testid="button-agenda-clear-confirm"
            >
              Clear agenda
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
