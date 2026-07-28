import { useEffect, useState } from "react";
import {
  ChevronRight,
  Circle,
  CircleCheck,
  Pause,
  SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import type {
  SessionAgenda,
  SessionAgendaItem,
  SessionAgendaItemStatus,
} from "@shared/models/chat";

interface SessionAgendaTreeProps {
  sessionId: string;
  agenda?: SessionAgenda;
}

interface AgendaItemRowProps {
  item: SessionAgendaItem;
  current: boolean;
  continues: boolean;
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

function AgendaItemRow({ item, current, continues }: AgendaItemRowProps) {
  const [open, setOpen] = useState(false);
  const isResolved = item.status === "complete" || item.status === "skipped";

  return (
    <HierarchyTreeRow continues={continues} connectorAnchor="first-row-center">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            HIERARCHY_SESSION_ROW_CLASS,
            "min-w-0 hover:bg-accent/70",
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

export function SessionAgendaTree({ sessionId, agenda }: SessionAgendaTreeProps) {
  const items = agenda?.items ?? [];
  const hasItems = items.length > 0;
  const allItemsComplete = hasItems && items.every((item) => item.status === "complete");
  const [open, setOpen] = useState(() => !allItemsComplete);

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
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
