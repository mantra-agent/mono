import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock3,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Target,
} from "lucide-react";
import { HierarchySectionHeader, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Button } from "@/components/ui/button";
import { usePageHeader } from "@/hooks/use-page-header";
import { MANTRA_Q3_2026_ADVANTAGE_CYCLE } from "@/lib/advantage-dashboard";
import { cn } from "@/lib/utils";
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

interface ObjectiveTreeRowProps {
  definition: AdvantageObjectiveDefinition;
  goal?: AdvantageGoalProjection;
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

function MeasureTreeRow({ measure, continues }: { measure: ScorecardMeasureDefinition; continues: boolean }) {
  const owner = "instrumentationOwner" in measure.state ? measure.state.instrumentationOwner : null;
  const sourceRef = "sourceRef" in measure.state ? measure.state.sourceRef : null;
  const trend = measure.state.kind === "measured" || measure.state.kind === "stale" ? "Not configured" : "No evidence";
  const freshness = measure.state.kind === "measured"
    ? measure.state.observedAt
    : measure.state.kind === "stale"
      ? `Stale since ${measure.state.observedAt}`
      : "Never measured";

  return (
    <HierarchyTreeRow continues={continues}>
      <ProfileTreeRow
        label={measure.label}
        icon={<Gauge className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        expandedContentClassName="border-l border-border ml-2 pl-3 pb-2"
        expandedContent={(
          <div className="space-y-2 text-muted-foreground">
            <p className="text-sm leading-6 text-foreground">{measure.definition}</p>
            <div className="space-y-1">
              <span>Target · {measure.target}</span>
              <span>Refresh · {measure.cadence}</span>
              {owner ? <span>Instrumentation · {owner}</span> : null}
              <span>Trend · {trend}</span>
              <span>Source · {sourceRef ?? "No canonical source"}</span>
              <span>Freshness · {freshness}</span>
              {measure.state.kind === "unavailable" ? <span>{measure.state.reason}</span> : null}
              {measure.state.kind === "error" ? <span className="text-error">{measure.state.message}</span> : null}
            </div>
          </div>
        )}
      >
        <MeasureState state={measure.state} />
      </ProfileTreeRow>
    </HierarchyTreeRow>
  );
}

function MeasuresBranch({ measures }: { measures: ScorecardMeasureDefinition[] }) {
  return (
    <div className="mt-1">
      {measures.map((measure, index) => (
        <MeasureTreeRow key={measure.key} measure={measure} continues={index < measures.length - 1} />
      ))}
    </div>
  );
}

function ObjectiveTreeRow({ definition, goal }: ObjectiveTreeRowProps) {
  const status = goal?.status ?? "active";
  const StatusIcon = statusIcon(status);

  return (
    <ProfileTreeRow
      label={goal?.shortName ?? <span className="text-error">Goal unavailable</span>}
      icon={<StatusIcon className={cn("h-3.5 w-3.5", goal ? goalStatusClasses[status] : "text-error")} />}
      hasValue
      showEmpty
      mobileLayout="inline"
      expandedContentClassName="px-0 pb-1 pl-0"
      expandedContent={(
        <div className="ml-8 border-l border-border py-1 pl-3">
          <p className="text-sm leading-6 text-muted-foreground">{goal?.description ?? "The canonical child goal could not be loaded."}</p>
          {goal ? (
            <ReferenceRenderer refValue={goalReference(goal)} surface="simple-row" className="mx-0 mt-1" />
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Owner · {definition.owner}</span>
            <span>Next evidence · {definition.nextEvidence}</span>
          </div>
          <MeasuresBranch measures={definition.measures} />
        </div>
      )}
    >
      <span className={cn("truncate", goal ? goalStatusClasses[status] : "text-error")}>{goal ? goalStatusLabels[status] : "Unavailable"}</span>
    </ProfileTreeRow>
  );
}

function HealthDomainTreeRow({ domain }: { domain: AdvantageHealthDomainDefinition }) {
  const measured = domain.measures.filter((measure) => measure.state.kind === "measured").length;
  const attention = domain.measures.filter((measure) => ["stale", "error", "unavailable"].includes(measure.state.kind)).length;
  const stateLabel = attention > 0 ? `${attention} need attention` : measured > 0 ? `${measured} measured` : "Unmeasured";

  return (
    <ProfileTreeRow
      label={domain.label}
      icon={<ShieldCheck className={cn("h-3.5 w-3.5", attention > 0 ? "text-warning" : "text-muted-foreground")} />}
      hasValue
      showEmpty
      mobileLayout="inline"
      expandedContentClassName="px-0 pb-1 pl-0"
      expandedContent={(
        <div className="ml-8 border-l border-border py-1 pl-3">
          <p className="text-xs text-muted-foreground">Instrumentation · {domain.instrumentationOwner}</p>
          <MeasuresBranch measures={domain.measures} />
        </div>
      )}
    >
      <span className={cn("truncate", attention > 0 ? "text-warning" : "text-muted-foreground")}>{stateLabel}</span>
    </ProfileTreeRow>
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
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-active" /></div>;
  }

  if (error) {
    return (
      <div className={cn("w-full", HIERARCHY_TREE_STACK_CLASS)}>
        <HierarchySectionHeader>Operating cycle</HierarchySectionHeader>
        <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-error">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Advantage goals unavailable</span>
          <Button type="button" variant="ghost" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", isFetching && "animate-spin")} />
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("w-full", HIERARCHY_TREE_STACK_CLASS)} data-testid="business-advantage-page">
      <section aria-labelledby="operating-cycle-title">
        <HierarchySectionHeader id="operating-cycle-title">Operating cycle</HierarchySectionHeader>
        <ProfileTreeRow
          label={thematicGoal?.shortName ?? <span className="text-error">Thematic goal unavailable</span>}
          icon={<Target className={cn("h-3.5 w-3.5", thematicGoal ? "text-foreground" : "text-error")} />}
          hasValue
          showEmpty
          defaultOpen
          mobileLayout="inline"
          expandedContentClassName="border-l border-border ml-2 pl-3 pb-2"
          expandedContent={(
            <div className="space-y-3">
              <p className="text-sm leading-6 text-foreground">{cycle.strategicJudgment}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />{cycle.startsOn} – {cycle.endsOn}</span>
                <span>Confidence · {cycle.confidence}</span>
                {thematicGoal ? <ReferenceRenderer refValue={goalReference(thematicGoal)} surface="simple-row" className="mx-0" /> : null}
                <ReferenceRenderer refValue={sourceReference(cycle.sourcePageId)} surface="simple-row" className="mx-0" />
                <span className={hierarchyComplete ? "text-muted-foreground" : "text-warning"}>{hierarchyComplete ? "Goal hierarchy current" : "Goal hierarchy incomplete"}</span>
              </div>
            </div>
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5 shrink-0" />
            {cycle.periodLabel} · {daysRemaining(cycle.endsOn)} days
          </span>
        </ProfileTreeRow>
      </section>

      <section aria-labelledby="defining-objectives-title">
        <HierarchySectionHeader id="defining-objectives-title" className="justify-between">
          <span>Defining objectives</span>
          <span className="normal-case tracking-normal">{canonicalChildren.length} of {cycle.objectives.length} linked</span>
        </HierarchySectionHeader>
        {cycle.objectives.map((objective) => (
          <ObjectiveTreeRow key={objective.goalId} definition={objective} goal={goalsById.get(objective.goalId)} />
        ))}
      </section>

      <section aria-labelledby="operating-health-title">
        <HierarchySectionHeader id="operating-health-title">Operating health</HierarchySectionHeader>
        {cycle.healthDomains.map((domain) => <HealthDomainTreeRow key={domain.key} domain={domain} />)}
      </section>
    </div>
  );
}
