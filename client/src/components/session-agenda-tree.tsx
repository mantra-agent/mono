import { useEffect, useState } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useToast } from "@/hooks/use-toast";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
} from "@/components/hierarchy-section-header";
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

type CreatedSession = { id: string };

interface AgendaDiscussionSource {
  sessionId: string;
  sessionTitle?: string;
  parentSessionId?: string;
  parentSessionTitle?: string;
  agenda: SessionAgenda;
  item: SessionAgendaItem;
}

function agendaItemLine(item: SessionAgendaItem): string {
  return [
    `- ${item.title}`,
    `  - ID: ${item.id}`,
    `  - Description: ${item.description}`,
    `  - Status: ${item.status}`,
    `  - Resolution: ${item.resolution ?? "None"}`,
  ].join("\n");
}

function buildAgendaDiscussionMessage({
  sessionId,
  sessionTitle,
  parentSessionId,
  parentSessionTitle,
  agenda,
  item,
}: AgendaDiscussionSource): string {
  const parts = [
    `Let's discuss this agenda item: **${item.title}**`,
    "",
    "Source conversation:",
    `- Session ID: ${sessionId}`,
  ];
  if (sessionTitle) parts.push(`- Title: ${sessionTitle}`);
  if (parentSessionId) {
    parts.push(`- Parent session ID: ${parentSessionId}`);
    if (parentSessionTitle) parts.push(`- Parent title: ${parentSessionTitle}`);
  }
  parts.push(
    "",
    "Selected agenda item:",
    agendaItemLine(item),
    "",
    "Full agenda:",
    agenda.items.map(agendaItemLine).join("\n"),
  );
  return parts.join("\n");
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
  const [open, setOpen] = useState(() => !allItemsComplete);
  const queryClient = useQueryClient();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const { toast } = useToast();

  const discussMutation = useMutation({
    mutationFn: async (item: SessionAgendaItem) => {
      if (!agenda) throw new Error("Agenda context is unavailable");
      const response = await apiRequest("POST", "/api/sessions", {
        title: item.title.trim().slice(0, 80) || "Agenda Discussion",
      });
      const session: CreatedSession = await response.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
        content: buildAgendaDiscussionMessage({
          sessionId,
          sessionTitle,
          parentSessionId,
          parentSessionTitle,
          agenda,
          item,
        }),
        clientTurnId: `agenda-discuss-${session.id}-${item.id}`.slice(0, 120),
      });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Could not start discussion",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (hasItems) setOpen(!allItemsComplete);
  }, [allItemsComplete, hasItems, sessionId]);

  if (!hasItems) return null;

  const currentItemId = items.find((item) => item.status === "open")?.id;

  return (
    <div className="min-w-0 border-b border-border/20 p-2" data-testid="session-agenda-tree">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
          data-testid="button-agenda-section"
        >
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
          Agenda
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="min-w-0">
            {items.map((item, index) => (
              <AgendaItemRow
                key={item.id}
                item={item}
                current={item.id === currentItemId}
                continues={index < items.length - 1}
                discussPending={discussMutation.isPending && discussMutation.variables?.id === item.id}
                discussDisabled={discussMutation.isPending}
                onDiscuss={(selectedItem) => {
                  if (!discussMutation.isPending) discussMutation.mutate(selectedItem);
                }}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
