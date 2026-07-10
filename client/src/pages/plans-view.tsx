/**
 * PlansView — management page for browsing all plans, grouped by status.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChevronDown,
  ChevronRight,
  History,
  Archive,
} from "lucide-react";
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
    <div className="p-4 space-y-3">
      {[1, 2].map(i => (
        <Card key={i} className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Zero State ──────────────────────────────────────────────────────

function PlansZeroState() {
  return <div className="px-2 py-1.5 text-sm text-muted-foreground">No plans yet.</div>;
}

// ─── Plan Row ────────────────────────────────────────────────────────

function PlanRow({ plan }: { plan: PlanSummary }) {
  const isActive = !plan.archivedAt && (plan.status === "executing" || plan.status === "created");

  return (
    <Card className={isActive ? "border-info/20" : undefined}>
      <PlanWidget plan={plan} variant="card" showArchiveAction />
    </Card>
  );
}

// ─── Main Export ─────────────────────────────────────────────────────

export function PlansView() {
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
    <div className="p-4 space-y-3 w-full">
      <span className="text-xs text-muted-foreground">
        {active.length} active{history.length > 0 ? `, ${history.length} completed` : ""}{archived.length > 0 ? `, ${archived.length} archived` : ""}
      </span>

      {/* Active plans */}
      {active.map(p => <PlanRow key={p.id} plan={p} />)}

      {/* History */}
      {history.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground h-7">
              <History className="h-3 w-3" />
              {historyOpen ? "Hide" : "Show"} History ({history.length})
              {historyOpen
                ? <ChevronDown className="h-3 w-3" />
                : <ChevronRight className="h-3 w-3" />
              }
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            {history.map(p => <PlanRow key={p.id} plan={p} />)}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Archived */}
      {archived.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground h-7">
              <Archive className="h-3 w-3" />
              {archivedOpen ? "Hide" : "Show"} Archived ({archived.length})
              {archivedOpen
                ? <ChevronDown className="h-3 w-3" />
                : <ChevronRight className="h-3 w-3" />
              }
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2 opacity-70">
            {archived.map(p => <PlanRow key={p.id} plan={p} />)}
          </CollapsibleContent>
        </Collapsible>
      )}
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
