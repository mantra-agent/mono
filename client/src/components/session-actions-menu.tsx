import {
  Archive,
  BookOpen,
  CornerUpLeft,
  GitBranch,

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

export function SessionActionsMenuItems({
  sessionId,
  onRename,
  sessionTitle,
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
              title: "Failed to spawn child",
              description: String(err),
              variant: "destructive",
            });
          }
        }}
        data-testid={`${testIdPrefix}-spawn-child`}
      >
        <GitBranch className="h-3.5 w-3.5 mr-2" />
        Spawn Child
      </DropdownMenuItem>
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
