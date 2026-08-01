import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  FileCode2,
  Heart,
  Loader2,
  Target,
  User,
  XCircle,
} from "lucide-react";
import type { Goal, GoalStatus } from "@shared/models/goals";
import { createReferenceRef } from "@shared/references";
import { ActivityHeatmap, type ActivityHeatmapDay } from "@/components/activity-heatmap";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { usePageHeader } from "@/hooks/use-page-header";
import {
  MANTRA_Q3_ADVANTAGE,
  type AdvantageHealthDomain,
  type AdvantageMetricDefinition,
  type AdvantageObjectiveDefinition,
  type MetricState,
} from "@/lib/advantage-dashboard";
import { cn } from "@/lib/utils";

interface DashboardKpi {
  key: "opportunity_interactions" | "wellness_completions" | "completed_tasks" | "shipped_prs";
  label: string;
  value: number;
}

interface DashboardSeries {
  key: DashboardKpi["key"];
  label: string;
  days: ActivityHeatmapDay[];
}

interface DashboardActivity {
  date: string;
  kpis: DashboardKpi[];
  series: DashboardSeries[];
}

interface GoalsResponse {
  goals: Goal[];
}

const SECTION_PRESENTATION = {
  wellness_completions: {
    title: "WELLNESS",
    order: 0,
    marker: { icon: Heart, criterion: "above-80-percent-of-maximum", filled: true },
  },
  opportunity_interactions: {
    title: "INTERACTIONS",
    order: 1,
    marker: { icon: User, criterion: "above-value", threshold: 5, filled: true },
  },
  completed_tasks: {
    title: "TASKS",
    order: 2,
    marker: { icon: BriefcaseBusiness, criterion: "above-value", threshold: 40, filled: true },
  },
  shipped_prs: {
    title: "CODE",
    order: 3,
    marker: { icon: FileCode2, criterion: "above-value", threshold: 50, filled: true },
  },
} as const;

const GOAL_STATUS_PRESENTATION: Record<GoalStatus, { label: string; icon: typeof Circle; className: string }> = {
  active: { label: "Active", icon: Circle, className: "text-foreground" },
  on_track: { label: "On track", icon: CheckCircle2, className: "text-success" },
  at_risk: { label: "At risk", icon: AlertTriangle, className: "text-warning" },
  achieved: { label: "Achieved", icon: CheckCircle2, className: "text-success" },
  blocked: { label: "Blocked", icon: XCircle, className: "text-destructive" },
  dormant: { label: "Dormant", icon: Circle, className: "text-muted-foreground" },
};

function localDateToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function daysRemaining(endDate: string): number {
  const today = new Date(`${localDateToday()}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  return Math.max(0, Math.ceil((end.getTime() - today.getTime()) / 86_400_000));
}

function sourceReference(pageId: string) {
  return createReferenceRef({ type: "page", id: pageId });
}

function goalReference(goalId: string) {
  return createReferenceRef({ type: "goal", id: goalId });
}

function MetricStateValue({ state }: { state: MetricState }) {
  if (state.kind === "measured") {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {state.value}
        <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
          <Clock3 className="h-3 w-3" />
          {state.freshness}
        </span>
      </span>
    );
  }
  if (state.kind === "stale") {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-warning">
        {state.value}
        <span className="text-xs font-normal">Stale · {state.freshness}</span>
      </span>
    );
  }
  if (state.kind === "unavailable") return <span className="text-sm text-muted-foreground">Unavailable · {state.reason}</span>;
  if (state.kind === "error") return <span className="text-sm text-destructive">Error · {state.message}</span>;
  return <span className="text-sm text-muted-foreground">Unmeasured · {state.instrumentationOwner}</span>;
}

function MetricDetails({ metric }: { metric: AdvantageMetricDefinition }) {
  return (
    <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
      <div className="grid gap-2 sm:grid-cols-2">
        <span>Refresh · {metric.refreshCadence}</span>
        <span className="sm:text-right">Metric · {metric.id}</span>
      </div>
      <ReferenceRenderer refValue={sourceReference(metric.sourcePageId)} surface="card" className="mx-0" />
    </div>
  );
}

function MetricRow({ metric }: { metric: AdvantageMetricDefinition }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-11 w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{metric.label}</span>
          <MetricStateValue state={metric.state} />
        </span>
        {metric.target && <span className="max-w-[42%] shrink-0 text-right text-xs text-muted-foreground">Target · {metric.target}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <MetricDetails metric={metric} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function GoalStatus({ status }: { status: GoalStatus }) {
  const presentation = GOAL_STATUS_PRESENTATION[status];
  const Icon = presentation.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", presentation.className)}>
      <Icon className="h-3.5 w-3.5" />
      {presentation.label}
    </span>
  );
}

function ObjectiveCard({ definition, goal }: { definition: AdvantageObjectiveDefinition; goal: Goal | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="min-w-0 overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex min-h-11 w-full min-w-0 items-start gap-3 p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <ChevronRight className={cn("mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 text-base font-semibold text-foreground">
                {goal ? <ReferenceRenderer refValue={goalReference(goal.id)} surface="card" className="mx-0 text-base" /> : "Goal unavailable"}
              </span>
              {goal ? <GoalStatus status={goal.status} /> : <span className="text-sm text-destructive">Unavailable</span>}
            </span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>{definition.owner}</span>
              <MetricStateValue state={definition.nextEvidence} />
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y divide-border/60 border-t border-border/60">
            {definition.metrics.map((item) => <MetricRow key={item.id} metric={item} />)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function HealthCard({ domain }: { domain: AdvantageHealthDomain }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="min-w-0 overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex min-h-11 w-full min-w-0 items-center gap-3 p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{domain.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">Unmeasured · {domain.instrumentationOwner}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y divide-border/60 border-t border-border/60">
            {domain.metrics.map((item) => <MetricRow key={item.id} metric={item} />)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function renderSeries(series: DashboardSeries[], startingIndex = 0) {
  return [...series]
    .sort((left, right) => SECTION_PRESENTATION[left.key].order - SECTION_PRESENTATION[right.key].order)
    .map((item, index) => (
      <div key={item.key} className={startingIndex + index === 0 ? "" : "pt-6"}>
        <ProfileDetailSection title={SECTION_PRESENTATION[item.key].title} defaultOpen testId={`section-dashboard-${item.key}`}>
          <ActivityHeatmap
            days={item.days}
            marker={SECTION_PRESENTATION[item.key].marker}
            valueLabel={SECTION_PRESENTATION[item.key].title.toLowerCase()}
          />
        </ProfileDetailSection>
      </div>
    ));
}

function ActivityTelemetry({ core, code, hasError }: { core?: DashboardActivity; code?: DashboardActivity; hasError: boolean }) {
  const hasData = Boolean(core || code);
  return (
    <ProfileDetailSection title="ACTIVITY TELEMETRY" defaultOpen={false} testId="section-dashboard-activity">
      {hasError && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          Some activity could not be loaded.
        </div>
      )}
      {hasData ? (
        <div className="min-w-0 overflow-hidden bg-background px-2 py-3">
          {renderSeries(core?.series ?? [])}
          {renderSeries(code?.series ?? [], core?.series.length ?? 0)}
        </div>
      ) : !hasError ? <div className="px-2 py-1.5 text-sm text-muted-foreground">No activity telemetry yet.</div> : null}
    </ProfileDetailSection>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="px-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">{children}</h2>;
}

export default function DashboardPage() {
  usePageHeader({ title: "Dashboard" });
  const date = localDateToday();
  const goalsQuery = useQuery<GoalsResponse>({ queryKey: ["/api/life-goals"] });
  const coreQuery = useQuery<DashboardActivity>({
    queryKey: [`/api/dashboard/activity?date=${encodeURIComponent(date)}&source=core`],
  });
  const codeQuery = useQuery<DashboardActivity>({
    queryKey: [`/api/dashboard/activity?date=${encodeURIComponent(date)}&source=code`],
  });

  const goalsById = useMemo(
    () => new Map((goalsQuery.data?.goals ?? []).map((goal) => [goal.id, goal])),
    [goalsQuery.data?.goals],
  );
  const thematicGoal = goalsById.get(MANTRA_Q3_ADVANTAGE.thematicGoalId);
  const objectiveGoals = MANTRA_Q3_ADVANTAGE.objectives.map((objective) => goalsById.get(objective.goalId)).filter(Boolean);
  const hierarchyIsCanonical = objectiveGoals.length === MANTRA_Q3_ADVANTAGE.objectives.length &&
    objectiveGoals.every((goal) => goal?.parentId === MANTRA_Q3_ADVANTAGE.thematicGoalId);

  if (goalsQuery.isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background p-4 md:p-6">
      <div className="flex min-w-0 flex-col gap-6">
        <Card className="min-w-0 overflow-hidden p-4 md:p-6">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>{MANTRA_Q3_ADVANTAGE.label}</span>
                <span>{daysRemaining(MANTRA_Q3_ADVANTAGE.endsOn)} days remaining</span>
                <span>Confidence · {MANTRA_Q3_ADVANTAGE.confidence}</span>
              </div>
              <div className="flex min-w-0 items-start gap-3">
                <Target className="mt-1 h-5 w-5 shrink-0 text-foreground" />
                <div className="min-w-0">
                  {thematicGoal ? (
                    <ReferenceRenderer refValue={goalReference(thematicGoal.id)} surface="expanded" className="mx-0 text-xl font-semibold" />
                  ) : (
                    <h1 className="text-xl font-semibold text-destructive">The thematic goal is unavailable</h1>
                  )}
                  <p className="mt-2 text-base leading-relaxed text-foreground">{MANTRA_Q3_ADVANTAGE.strategicJudgment}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 lg:items-end">
              {thematicGoal && <GoalStatus status={thematicGoal.status} />}
              <ReferenceRenderer refValue={sourceReference(MANTRA_Q3_ADVANTAGE.sourcePageId)} surface="card" className="mx-0" />
            </div>
          </div>
        </Card>

        {(goalsQuery.isError || !thematicGoal || !hierarchyIsCanonical) && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Canonical goal hierarchy could not be loaded completely.
          </div>
        )}

        <section className="space-y-3">
          <SectionLabel>Defining objectives</SectionLabel>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {MANTRA_Q3_ADVANTAGE.objectives.map((definition) => (
              <ObjectiveCard key={definition.goalId} definition={definition} goal={goalsById.get(definition.goalId)} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <SectionLabel>Operating health</SectionLabel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {MANTRA_Q3_ADVANTAGE.healthDomains.map((domain) => <HealthCard key={domain.id} domain={domain} />)}
          </div>
        </section>

        <section className="space-y-3">
          <SectionLabel>Operating telemetry</SectionLabel>
          <div className="min-w-0">
            <ActivityTelemetry
              core={coreQuery.data}
              code={codeQuery.data}
              hasError={coreQuery.isError || codeQuery.isError}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
