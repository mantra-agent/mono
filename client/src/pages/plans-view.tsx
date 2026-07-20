/**
 * PlansView — management page for browsing all plans, grouped by status.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { PlanWidget } from "@/components/plan-widget";
import type { PlanData, PlanStatus, PlanStep } from "@/components/plan-shared";
import { usePlanEvents } from "@/hooks/use-plan-events";
import { queryClient } from "@/lib/queryClient";

// ─── Types ───────────────────────────────────────────────────────────

interface PlanSummary extends PlanData {
  status: PlanStatus;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

interface PlansListResponse {
  active: PlanSummary[];
  completed: PlanSummary[];
  failed: PlanSummary[];
  archived: PlanSummary[];
}

// ─── Skeleton ────────────────────────────────────────────────────────

function PlansSkeleton() {
  return (
    <div className="p-2 space-y-1">
      {[1, 2, 3].map(i => (
        <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <Skeleton className="h-3.5 w-3.5 rounded-full" />
          <Skeleton className="h-4 w-48" />
        </div>
      ))}
    </div>
  );
}

// ─── Zero State ──────────────────────────────────────────────────────

function PlansZeroState() {
  return <div className="px-2 py-1.5 text-sm text-muted-foreground">No plans yet.</div>;
}

function PlanGroup({
  label,
  plans,
  open,
  onOpenChange,
  muted = false,
}: {
  label: string;
  plans: PlanSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  muted?: boolean;
}) {
  if (plans.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover-elevate">
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span>{label}</span>
        <span className="font-normal tabular-nums text-muted-foreground/70">({plans.length})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={muted ? "space-y-1 opacity-70" : "space-y-1"}>
          {plans.map(plan => (
            <PlanWidget key={plan.id} plan={plan} showArchiveAction />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Main Export ─────────────────────────────────────────────────────

export function PlansView() {
  const [activeOpen, setActiveOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const { data, isLoading } = useQuery<PlansListResponse>({
    queryKey: ["/api/plans"],
    refetchInterval: (query) => {
      const active = query.state.data?.active || [];
      return active.length > 0 ? 10000 : false;
    },
  });

  // Invalidate on any plan event
  usePlanEvents(useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
  }, []));

  if (isLoading) return <PlansSkeleton />;

  const active = data?.active || [];
  const completed = data?.completed || [];
  const failed = data?.failed || [];
  const archived = data?.archived || [];
  const history = [...completed, ...failed];
  const hasAny = active.length > 0 || history.length > 0 || archived.length > 0;

  if (!hasAny) return <PlansZeroState />;

  return (
    <div className="w-full min-w-0 p-2 space-y-1">
      <PlanGroup label="Active" plans={active} open={activeOpen} onOpenChange={setActiveOpen} />
      <PlanGroup label="History" plans={history} open={historyOpen} onOpenChange={setHistoryOpen} />
      <PlanGroup label="Archive" plans={archived} open={archivedOpen} onOpenChange={setArchivedOpen} muted />
    </div>
  );
}

// ─── Hook for active plan detection (used by thought indicator) ─────

export function useHasActivePlans(): boolean {
  const { data } = useQuery<PlansListResponse>({
    queryKey: ["/api/plans"],
    refetchInterval: (query) => {
      const active = query.state.data?.active || [];
      return active.length > 0 ? 10000 : false;
    },
  });
  const active = data?.active || [];
  return active.some(p => p.status === "executing");
}
