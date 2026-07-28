import {
  Circle,
  CircleCheck,
  Pause,
  SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import type {
  SessionAgenda,
  SessionAgendaItemStatus,
} from "@shared/models/chat";

interface SessionAgendaTreeProps {
  agenda?: SessionAgenda;
}

function AgendaStatusIcon({ status }: { status: SessionAgendaItemStatus }) {
  if (status === "complete") return <CircleCheck className="h-3.5 w-3.5 text-success" />;
  if (status === "skipped") return <SkipForward className="h-3.5 w-3.5 text-muted-foreground" />;
  if (status === "deferred") return <Pause className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />;
}

export function SessionAgendaTree({ agenda }: SessionAgendaTreeProps) {
  if (!agenda?.items.length) return null;

  return (
    <div className="min-w-0 border-b border-border/20 px-2 py-1.5" data-testid="session-agenda-tree">
      <div className="px-2 py-1.5 text-sm font-medium">Agenda</div>
      {agenda.items.map((item, index) => {
        const isResolved = item.status === "complete" || item.status === "skipped";
        return (
          <HierarchyTreeRow key={item.id} continues={index < agenda.items.length - 1}>
            <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-sm">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                <AgendaStatusIcon status={item.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn("min-w-0 flex-1 truncate", isResolved && "text-muted-foreground")}>
                    {item.title}
                  </span>
                  {item.status !== "open" && (
                    <span className="shrink-0 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                      {item.status}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs leading-normal text-muted-foreground">
                  {item.description}
                </p>
                {item.resolution && (
                  <p className="mt-1 text-xs leading-normal text-foreground/80">
                    {item.resolution}
                  </p>
                )}
              </div>
            </div>
          </HierarchyTreeRow>
        );
      })}
    </div>
  );
}
