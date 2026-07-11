import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  BookOpen,
  CornerUpLeft,
  CornerUpRight,
  GitBranch,
  Home,
  Info,
  Pencil,
  Pin,
  StickyNote,
  Target,
  Trash2,
  Users,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SessionReminderPopover } from "@/components/session-reminder";
import type { LinkedEntity } from "@/hooks/use-linked-entities";
import { apiRequest } from "@/lib/queryClient";
import { emitSessionListChanged } from "@/hooks/use-data-sync";
import { useToast } from "@/hooks/use-toast";

const ENTITY_CHIP_STYLES: Record<
  LinkedEntity["kind"],
  { label: string; icon: typeof BookOpen; className: string; iconColor: string }
> = {
  library: {
    label: "Page",
    icon: BookOpen,
    className: "border-info/20 text-info-foreground hover:bg-info/10",
    iconColor: "text-info-foreground",
  },
  person: {
    label: "Person",
    icon: Users,
    className: "border-success/20 text-success-foreground hover:bg-success/10",
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
    className: "border-cat-ai/30 text-cat-ai-foreground hover:bg-cat-ai/15",
    iconColor: "text-cat-ai-foreground",
  },
};

export interface SessionActionsMenuItemsProps {
  sessionId: string;
  sessionTitle?: string | null;
  /** Current parent session ID. When set, the "Move" submenu is shown. */
  parentSessionId?: string | null;
  onRename?: () => void;
  onSelectSession: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  isArchived?: boolean;
  isPinned?: boolean;
  onTogglePin?: (id: string, pinned: boolean) => void;
  onReminderSet?: (id: string) => void;
  onOpenInParent?: () => void;
  linkedEntities?: LinkedEntity[];
  onLinkedEntityClick?: (entity: LinkedEntity) => void;
  /** Show the "Details" menu item. Parent must render SessionDetailsModal separately. */
  onShowDetails?: () => void;
  testIdPrefix?: string;
  stopPropagation?: boolean;
  /** Hide the Rename menu item (e.g. in bottom bar context). */
  hideRename?: boolean;
}

function maybeStopPropagation(event: Event, shouldStop: boolean) {
  if (shouldStop) event.stopPropagation();
}

interface MoveTargetSession {
  id: string;
  title?: string | null;
  parentSessionId?: string | null;
  updatedAt?: string;
}

interface SessionMoveSubmenuProps {
  sessionId: string;
  parentSessionId: string;
  stopPropagation: boolean;
  testIdPrefix: string;
}

/**
 * "Move" submenu for child sessions: reparents the session (and its subtree)
 * under another session, or detaches it to Root. Excludes the session itself,
 * its descendants (cycle prevention), and its current parent from the target
 * list. The server enforces the same invariants.
 */
function SessionMoveSubmenu({
  sessionId,
  parentSessionId,
  stopPropagation,
  testIdPrefix,
}: SessionMoveSubmenuProps) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: sessions = [] } = useQuery<MoveTargetSession[]>({
    queryKey: ["/api/sessions"],
  });

  const targets = useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    for (const s of sessions) {
      if (!s.parentSessionId) continue;
      const list = childrenByParent.get(s.parentSessionId) ?? [];
      list.push(s.id);
      childrenByParent.set(s.parentSessionId, list);
    }
    const excluded = new Set<string>([sessionId, parentSessionId]);
    const pending = [...(childrenByParent.get(sessionId) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (excluded.has(next)) continue;
      excluded.add(next);
      pending.push(...(childrenByParent.get(next) ?? []));
    }
    return sessions
      .filter((s) => !excluded.has(s.id))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [sessions, sessionId, parentSessionId]);

  const query = search.trim().toLowerCase();
  const filtered = query
    ? targets.filter((s) => (s.title || "Untitled").toLowerCase().includes(query))
    : targets;

  const move = async (newParentId: string | null) => {
    try {
      await apiRequest("POST", `/api/sessions/${sessionId}/move`, {
        newParentId,
      });
      emitSessionListChanged("move-session");
    } catch (err) {
      toast({
        title: "Failed to move session",
        description: String(err),
        variant: "destructive",
      });
    }
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={`${testIdPrefix}-move`}>
        <CornerUpRight className="h-3.5 w-3.5 mr-2" />
        Move
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <div className="p-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search sessions..."
            className="h-7 text-xs"
            data-testid={`${testIdPrefix}-move-search`}
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          <DropdownMenuItem
            onClick={(event) => {
              maybeStopPropagation(event, stopPropagation);
              void move(null);
            }}
            data-testid={`${testIdPrefix}-move-root`}
          >
            <Home className="h-3.5 w-3.5 mr-2" />
            Root
          </DropdownMenuItem>
          {filtered.length > 0 && <DropdownMenuSeparator />}
          {filtered.map((target) => (
            <DropdownMenuItem
              key={target.id}
              onClick={(event) => {
                maybeStopPropagation(event, stopPropagation);
                void move(target.id);
              }}
              data-testid={`${testIdPrefix}-move-target-${target.id}`}
            >
              <span className="truncate">{target.title || "Untitled"}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function SessionActionsMenuItems({
  sessionId,
  onRename,
  sessionTitle,
  parentSessionId,
  onSelectSession,
  onArchive,
  onDelete,
  isArchived = false,
  isPinned = false,
  onTogglePin,
  onReminderSet,
  onOpenInParent,
  linkedEntities = [],
  onLinkedEntityClick,
  onShowDetails,
  testIdPrefix = "session-action",
  stopPropagation = false,
  hideRename = false,
}: SessionActionsMenuItemsProps) {
  const { toast } = useToast();

  return (
    <>
      {onTogglePin && (
        <DropdownMenuItem
          onClick={(event) => {
            maybeStopPropagation(event, stopPropagation);
            onTogglePin(sessionId, !isPinned);
          }}
          data-testid={`${testIdPrefix}-pin`}
        >
          <Pin
            className={cn("h-3.5 w-3.5 mr-2", isPinned ? "text-foreground" : "text-muted-foreground")}
            {...(isPinned ? { fill: "currentColor" } : {})}
          />
          {isPinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
      )}
      {!hideRename && onRename && (
        <DropdownMenuItem
          onClick={(event) => {
            maybeStopPropagation(event, stopPropagation);
            onRename();
          }}
          data-testid={`${testIdPrefix}-rename`}
        >
          <Pencil className="h-3.5 w-3.5 mr-2" />
          Rename
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={async (event) => {
          maybeStopPropagation(event, stopPropagation);
          try {
            const res = await apiRequest(
              "POST",
              `/api/sessions/${sessionId}/spawn-child`,
            );
            const child = await res.json();
            emitSessionListChanged("spawn-child");
            onSelectSession(child.id);
          } catch (err) {
            toast({
              title: "Failed to fork",
              description: String(err),
              variant: "destructive",
            });
          }
        }}
        data-testid={`${testIdPrefix}-fork`}
      >
        <GitBranch className="h-3.5 w-3.5 mr-2" />
        Fork
      </DropdownMenuItem>
      {parentSessionId && (
        <SessionMoveSubmenu
          sessionId={sessionId}
          parentSessionId={parentSessionId}
          stopPropagation={stopPropagation}
          testIdPrefix={testIdPrefix}
        />
      )}
      <SessionReminderPopover sessionId={sessionId} sessionTitle={sessionTitle} onReminderSet={onReminderSet} />
      {onOpenInParent && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(event) => {
              maybeStopPropagation(event, stopPropagation);
              onOpenInParent();
            }}
            data-testid={`${testIdPrefix}-open-in-parent`}
          >
            <CornerUpLeft className="h-3.5 w-3.5 mr-2" />
            Open in parent context
          </DropdownMenuItem>
        </>
      )}


      {linkedEntities.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid={`${testIdPrefix}-references`}>
            References
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {linkedEntities.map((entity) => {
              const style = ENTITY_CHIP_STYLES[entity.kind];
              const Icon = style.icon;
              return (
                <DropdownMenuItem
                  key={`${entity.kind}-${entity.id}`}
                  onClick={(event) => {
                    maybeStopPropagation(event, stopPropagation);
                    onLinkedEntityClick?.(entity);
                  }}
                  data-testid={`${testIdPrefix}-reference-${entity.kind}-${entity.id}`}
                >
                  {entity.emoji ? (
                    <span className="mr-2">{entity.emoji}</span>
                  ) : (
                    <Icon className={cn("h-3.5 w-3.5 mr-2", style.iconColor)} />
                  )}
                  <span className="truncate">{entity.title}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {onShowDetails && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(event) => {
              maybeStopPropagation(event, stopPropagation);
              onShowDetails();
            }}
            data-testid={`${testIdPrefix}-details`}
          >
            <Info className="h-3.5 w-3.5 mr-2" />
            Details
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuItem
        onClick={(event) => {
          maybeStopPropagation(event, stopPropagation);
          onArchive(sessionId);
        }}
        data-testid={`${testIdPrefix}-archive`}
      >
        <Archive className="h-3.5 w-3.5 mr-2" />
        {isArchived ? "Unarchive" : "Archive"}
      </DropdownMenuItem>
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={(event) => {
          maybeStopPropagation(event, stopPropagation);
          onDelete(sessionId);
        }}
        data-testid={`${testIdPrefix}-delete`}
      >
        <Trash2 className="h-3.5 w-3.5 mr-2" />
        Delete
      </DropdownMenuItem>

    </>
  );
}
