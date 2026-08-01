import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePageHeader } from "@/hooks/use-page-header";
import { cn } from "@/lib/utils";
import { MANTRA_Q3_2026_ADVANTAGE_CYCLE } from "@/lib/advantage-dashboard";
import { createReferenceRef } from "@shared/references";
import type {
  AdvantageGoalProjection,
  AdvantageHealthDomainDefinition,
  AdvantageObjectiveDefinition,
  ScorecardMeasureDefinition,
  ScorecardMeasureState,
} from "@shared/models/advantage-dashboard";
import type { GoalStatus } from "@shared/models/goals";

interface GoalListResponse {
  goals: AdvantageGoalProjection[];
}

interface ObjectiveCardProps {
  definition: AdvantageObjectiveDefinition;
  goal?: AdvantageGoalProjection;
}

interface HealthDomainCardProps {
  domain: AdvantageHealthDomainDefinition;
}

const goalStatusLabels: Record<GoalStatus, string> = {
  active: "Active",
  on_track: "On track",
  at_risk: "At risk",
  achieved: "Achieved",
  blocked: "Blocked",
  dormant: "Dormant",
};

const goalStatusClasses: Record<GoalStatus, string> = {
  active: "text-foreground",
  on_track: "text-success",
  at_risk: "text-warning",
  achieved: "text-success",
  blocked: "text-error",
  dormant: "text-muted-foreground",
};

function daysRemaining(endDate: string): number {
  const today = new Date();
  const end = new Date(`${endDate}T23:59:59`);
  return Math.max(0, Math.ceil((end.getTime() - today.getTime()) / 86_400_000));
}

function goalReference(goal: AdvantageGoalProjection) {
  return createReferenceRef({
    type: "goal",
    id: goal.id,
    metadata: { label: goal.shortName },
  });
}

function sourceReference(pageId: string) {
  return createReferenceRef({
    type: "page",
    id: pageId,
    metadata: { label: "Operating model" },
  });
}

function statusIcon(status: GoalStatus) {
  if (status === "achieved" || status === "on_track") return CheckCircle2;
  if (status === "at_risk" || status === "blocked") return AlertTriangle;
  return Circle;
}

function MeasureState({ state }: { state: ScorecardMeasureState }) {
  switch (state.kind) {
    case "measured":
      return <span className="font-medium text-foreground">{state.value.toLocaleString()} {state.unit}</span>;
    case "stale":
      return <span className="font-medium text-warning">Stale · {state.value.toLocaleString()} {state.unit}</span>;
    case "unavailable":
      return <span className="font-medium text-muted-foreground">Unavailable</span>;
    case "error":
      return <span className="font-medium text-error">Error</span>;
    case "unmeasured":
    default:
      return <span className="font-medium text-muted-foreground">Unmeasured</span>;
  }
}

function MeasureRow({ measure }: { measure: ScorecardMeasureDefinition }) {
  const owner = "instrumentationOwner" in measure.state ? measure.state.instrumentationOwner : null;
  const sourceRef = "sourceRef" in measure.state ? measure.state.sourceRef : null;

  return (
    <div className="border-t border-border/40 py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start justify-between gap-4 text-sm">
        <span className="min-w-0 font-medium text-foreground">{measure.label}</span>
        <MeasureState state={measure.state} />
      </div>
      <div className="mt-1 grid min-w-0 gap-1 text-sm text-muted-foreground sm:grid-cols-2">
        <span>Target · {measure.target}</span>
        <span className="sm:text-right">Refresh · {measure.cadence}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{measure.definition}</p>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {owner && <span>Instrumentation · {owner}</span>}
        <span>Trend · {measure.state.kind === "measured" || measure.state.kind === "stale" ? "Not configured" : "No evidence"}</span>
        <span>Source · {sourceRef ?? "No canonical source"}</span>
        <span>Freshness · {measure.state.kind === "measured" ? measure.state.observedAt : measure.state.kind === "stale" ? `Stale since ${measure.state.observedAt}` : "Never measured"}</span>
        {measure.state.kind === "unavailable" && <span>{measure.state.reason}</span>}
        {measure.state.kind === "error" && <span>{measure.state.message}</span>}
      </div>
    </div>
  );
}

function ObjectiveCard({ definition, goal }: ObjectiveCardProps) {
  const [open, setOpen] = useState(false);
  const status = goal?.status ?? "active";
  const StatusIcon = statusIcon(status);

  return (
    <Card className="min-w-0 overflow-hidden bg-card">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full min-w-0 items-start gap-3 p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
      >
        <ChevronRight className={cn("mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          {goal ? (
            <ReferenceRenderer refValue={goalReference(goal)} surface="card" className="mx-0" />
          ) : (
            <span className="text-base font-semibold text-error">Goal unavailable</span>
          )}
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{goal?.description ?? "The canonical child goal could not be loaded."}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className={cn("inline-flex items-center gap-1.5", goalStatusClasses[status])}>
              <StatusIcon className="h-3.5 w-3.5" />
              {goal ? goalStatusLabels[status] : "Unavailable"}
            </span>
            <span className="text-muted-foreground">Owner · {definition.owner}</span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-border/40 p-4">
          <p className="text-sm font-medium text-foreground">Next evidence</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{definition.nextEvidence}</p>
          <div className="mt-4">
            {definition.measures.map((measure) => <MeasureRow key={measure.key} measure={measure} />)}
          </div>
        </div>
      )}
    </Card>
  );
}

function HealthDomainCard({ domain }: HealthDomainCardProps) {
  const [open, setOpen] = useState(false);
  const measured = domain.measures.filter((measure) => measure.state.kind === "measured").length;
  const attention = domain.measures.filter((measure) => ["stale", "error", "unavailable"].includes(measure.state.kind)).length;
  const stateLabel = attention > 0 ? `${attention} need attention` : measured > 0 ? `${measured} measured` : "Unmeasured";

  return (
    <Card className="min-w-0 overflow-hidden bg-card">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full min-w-0 items-center gap-3 p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{domain.label}</span>
        <span className={cn("shrink-0 text-sm", attention > 0 ? "text-warning" : "text-muted-foreground")}>{stateLabel}</span>
      </button>
      {open && (
        <div className="border-t border-border/40 p-4">
          <p className="mb-4 text-sm text-muted-foreground">Instrumentation · {domain.instrumentationOwner}</p>
          {domain.measures.map((measure) => <MeasureRow key={measure.key} measure={measure} />)}
        </div>
      )}
    </Card>
  );
}

export default function BusinessAdvantagePage() {
  usePageHeader({ title: "Advantage" });
  const cycle = MANTRA_Q3_2026_ADVANTAGE_CYCLE;
  const { data, isLoading, error, refetch, isFetching } = useQuery<GoalListResponse>({
    queryKey: ["/api/life-goals?periodScoped=false&includeDormant=true"],
  });

  const goalsById = useMemo(
    () => new Map((data?.goals ?? []).map((goal) => [goal.id, goal])),
    [data?.goals],
  );
  const thematicGoal = goalsById.get(cycle.thematicGoalId);
  const expectedChildIds = useMemo(() => new Set(cycle.objectives.map((objective) => objective.goalId)), [cycle.objectives]);
  const canonicalChildren = useMemo(
    () => (data?.goals ?? []).filter((goal) => goal.parentId === cycle.thematicGoalId && expectedChildIds.has(goal.id)),
    [cycle.thematicGoalId, data?.goals, expectedChildIds],
  );
  const hierarchyComplete = !!thematicGoal && canonicalChildren.length === cycle.objectives.length;

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (error) {
    return (
      <div className="w-full p-4">
        <Card className="min-w-0 overflow-hidden bg-card p-4">
          <p className="text-base font-semibold text-foreground">Advantage goals unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">The canonical goal hierarchy could not be loaded.</p>
          <Button type="button" variant="outline" size="sm" className="mt-4" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", isFetching && "animate-spin")} />
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-advantage-page">
      <Card className="min-w-0 overflow-hidden bg-card p-4 md:p-6">
        <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />{cycle.periodLabel}</span>
              <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{daysRemaining(cycle.endsOn)} days remaining</span>
              <span>Confidence · {cycle.confidence}</span>
            </div>
            <div className="mt-4">
              {thematicGoal ? (
                <ReferenceRenderer refValue={goalReference(thematicGoal)} surface="expanded" className="mx-0 text-xl font-bold" />
              ) : (
                <h1 className="text-xl font-bold text-error">Thematic goal unavailable</h1>
              )}
            </div>
            <p className="mt-4 text-base leading-7 text-foreground">{cycle.strategicJudgment}</p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
            <ReferenceRenderer refValue={sourceReference(cycle.sourcePageId)} surface="card" className="mx-0" />
            <span className={cn("text-sm", hierarchyComplete ? "text-muted-foreground" : "text-warning")}>
              {hierarchyComplete ? "Goal hierarchy current" : "Goal hierarchy incomplete"}
            </span>
          </div>
        </div>
      </Card>

      <section className="space-y-4" aria-labelledby="defining-objectives-title">
        <div className="flex items-center justify-between gap-4">
          <h2 id="defining-objectives-title" className="text-lg font-semibold text-foreground">Defining objectives</h2>
          <span className="text-sm text-muted-foreground">{canonicalChildren.length} of {cycle.objectives.length} linked</span>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {cycle.objectives.map((objective) => (
            <ObjectiveCard key={objective.goalId} definition={objective} goal={goalsById.get(objective.goalId)} />
          ))}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="operating-health-title">
        <h2 id="operating-health-title" className="text-lg font-semibold text-foreground">Operating health</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {cycle.healthDomains.map((domain) => <HealthDomainCard key={domain.key} domain={domain} />)}
        </div>
      </section>
    </div>
  );
}
