import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Target,
} from "lucide-react";
import {
  HierarchySectionHeader,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import {
  PROFILE_DESCRIPTION_FRAME_CLASS,
  PROFILE_DESCRIPTION_TEXT_CLASS,
} from "@/components/profile-description-style";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import {
  MANTRA_Q3_2026_ADVANTAGE_CYCLE,
  type AdvantageOperatingCycle,
} from "@/lib/advantage-dashboard";
import type { Goal, GoalIndexEntry } from "@shared/schema";
import type {
  AdvantageGoalProjection,
  ScorecardMeasureDefinition,
  ScorecardMeasureState,
} from "@shared/models/advantage-dashboard";
import { createReferenceRef } from "@shared/references";

function extractGoalRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as { goals?: unknown; nodes?: unknown };
    if (Array.isArray(record.goals)) return record.goals;
    if (Array.isArray(record.nodes)) return record.nodes;
  }
  return [];
}

function asGoalList(payload: unknown): AdvantageGoalProjection[] {
  return extractGoalRows(payload)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Partial<GoalIndexEntry> & Partial<Goal> & { id?: unknown };
      if (typeof row.id !== "string" || typeof row.shortName !== "string") return null;
      return {
        id: row.id,
        shortName: row.shortName,
        description: typeof row.description === "string" ? row.description : undefined,
        status: typeof row.status === "string" ? row.status : undefined,
        horizon: typeof row.horizon === "string" ? row.horizon : undefined,
        owner: typeof row.owner === "string" ? row.owner : undefined,
        parentId:
          typeof row.parentId === "string" || row.parentId === null
            ? row.parentId
            : undefined,
      } satisfies AdvantageGoalProjection;
    })
    .filter((row): row is AdvantageGoalProjection => Boolean(row));
}

function asFullGoalMap(payload: unknown): Map<string, AdvantageGoalProjection> {
  const map = new Map<string, AdvantageGoalProjection>();
  for (const goal of asGoalList(payload)) {
    map.set(goal.id, goal);
  }
  return map;
}

function measureTone(state: ScorecardMeasureState): {
  label: string;
  className: string;
  Icon: typeof CheckCircle2;
} {
  switch (state.kind) {
    case "on_track":
      return {
        label: "On track",
        className: "text-emerald-300",
        Icon: CheckCircle2,
      };
    case "at_risk":
      return {
        label: "At risk",
        className: "text-amber-300",
        Icon: AlertTriangle,
      };
    case "off_track":
      return {
        label: "Off track",
        className: "text-rose-300",
        Icon: AlertTriangle,
      };
    case "achieved":
      return {
        label: "Achieved",
        className: "text-emerald-300",
        Icon: ShieldCheck,
      };
    case "blocked":
      return {
        label: "Blocked",
        className: "text-rose-300",
        Icon: AlertTriangle,
      };
    case "unmeasured":
    default:
      return {
        label: "Unmeasured",
        className: "text-muted-foreground",
        Icon: Circle,
      };
  }
}

function GoalReferenceTitle({ goalId }: { goalId: string }) {
  return (
    <span className="min-w-0 max-w-full whitespace-normal break-words">
      <ReferenceRenderer
        refValue={createReferenceRef({ type: "goal", id: goalId })}
        surface="simple-row"
        className="mx-0 max-w-full"
        wrapLabel
      />
    </span>
  );
}

function MeasureRows({
  measures,
  continues,
}: {
  measures: ScorecardMeasureDefinition[];
  continues: boolean;
}) {
  if (measures.length === 0) {
    return (
      <HierarchyTreeRow continues={continues}>
        <ProfileTreeRow
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="No scorecard measures"
          hasValue
          showEmpty
        >
          <span className="text-muted-foreground">—</span>
        </ProfileTreeRow>
      </HierarchyTreeRow>
    );
  }

  return (
    <>
      {measures.map((measure, index) => {
        const tone = measureTone(measure.state);
        const Icon = tone.Icon;
        const isLast = index === measures.length - 1;
        return (
          <HierarchyTreeRow key={measure.key} continues={continues || !isLast}>
            <ProfileTreeRow
              icon={<Target className="h-3.5 w-3.5" />}
              label={measure.label}
              hasValue
              showEmpty
              defaultOpen={false}
              expandedContent={
                <div className="space-y-1.5 text-sm leading-6 text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground/80">Target · </span>
                    {measure.target}
                  </p>
                  <p>
                    <span className="font-medium text-foreground/80">Cadence · </span>
                    {measure.cadence}
                  </p>
                  <p>
                    <span className="font-medium text-foreground/80">Definition · </span>
                    {measure.definition}
                  </p>
                  {"instrumentationOwner" in measure.state && measure.state.instrumentationOwner ? (
                    <p>
                      <span className="font-medium text-foreground/80">Owner · </span>
                      {measure.state.instrumentationOwner}
                    </p>
                  ) : null}
                  {"evidence" in measure.state && measure.state.evidence ? (
                    <p>
                      <span className="font-medium text-foreground/80">Evidence · </span>
                      {measure.state.evidence}
                    </p>
                  ) : null}
                </div>
              }
            >
              <span className={cn("inline-flex items-center gap-1.5 text-xs", tone.className)}>
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{tone.label}</span>
              </span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
        );
      })}
    </>
  );
}

function ThematicGoalDetails({
  goalId,
  description,
}: {
  goalId: string;
  description: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(description);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(description);
  }, [goalId, description]);

  const saveMutation = useMutation({
    mutationFn: async (nextDescription: string) => {
      const res = await apiRequest("PATCH", `/api/life-goals/${goalId}`, {
        description: nextDescription,
      });
      return res.json() as Promise<Goal>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      setEditing(false);
    },
  });

  const save = () => {
    const next = draft.trim();
    if (!next) return;
    if (next === description.trim()) {
      setEditing(false);
      setDraft(description);
      return;
    }
    saveMutation.mutate(next);
  };

  return (
    <ProfileDetailSection title="Details" defaultOpen testId="advantage-thematic-details">
      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(description);
                setEditing(false);
              }
            }}
            disabled={saveMutation.isPending}
            className={cn(
              PROFILE_DESCRIPTION_FRAME_CLASS,
              PROFILE_DESCRIPTION_TEXT_CLASS,
              "min-h-[96px] resize-y",
            )}
            data-testid="advantage-thematic-details-editor"
            autoFocus
          />
          {saveMutation.isError ? (
            <p className="text-xs text-rose-300">Could not save details. Try again.</p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cn(
            PROFILE_DESCRIPTION_FRAME_CLASS,
            PROFILE_DESCRIPTION_TEXT_CLASS,
            "w-full text-left transition-colors hover:border-primary/40",
          )}
          data-testid="advantage-thematic-details-display"
        >
          {description.trim() || "Add details…"}
        </button>
      )}
    </ProfileDetailSection>
  );
}

function ObjectiveBranch({
  objective,
  goal,
  continues,
}: {
  objective: AdvantageOperatingCycle["definingObjectives"][number];
  goal: AdvantageGoalProjection | Goal | undefined;
  continues: boolean;
}) {
  const description =
    (goal && "description" in goal && typeof goal.description === "string"
      ? goal.description
      : "") ||
    objective.intent ||
    "";

  return (
    <HierarchyTreeRow continues={continues}>
      <ProfileTreeRow
        icon={<Target className="h-3.5 w-3.5" />}
        label={<GoalReferenceTitle goalId={objective.goalId} />}
        hasValue
        showEmpty
        defaultOpen
        expandedContentClassName="pt-1"
        expandedContent={
          <div className="space-y-3">
            {description ? (
              <p className="whitespace-normal text-sm leading-6 text-foreground/90">
                {description}
              </p>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                No description on the linked goal yet.
              </p>
            )}
            <div className={HIERARCHY_TREE_STACK_CLASS}>
              <HierarchyTreeRow continues={objective.measures.length > 0}>
                <ProfileTreeRow
                  icon={<ShieldCheck className="h-3.5 w-3.5" />}
                  label="Owner"
                  hasValue
                  showEmpty
                >
                  <span className="text-xs text-muted-foreground">{objective.owner}</span>
                </ProfileTreeRow>
              </HierarchyTreeRow>
              <MeasureRows measures={objective.measures} continues={false} />
            </div>
          </div>
        }
      >
        {goal ? (
          <span className="text-xs text-muted-foreground">{goal.status ?? "active"}</span>
        ) : (
          <span className="text-xs text-rose-300">Missing</span>
        )}
      </ProfileTreeRow>
    </HierarchyTreeRow>
  );
}

export default function BusinessAdvantagePage() {
  const cycle = MANTRA_Q3_2026_ADVANTAGE_CYCLE;

  const goalsQuery = useQuery<unknown>({
    queryKey: ["/api/life-goals", { periodScoped: false, includeDormant: false }],
  });
  const graphQuery = useQuery<unknown>({
    queryKey: ["/api/life-goals/graph"],
  });

  const goalsById = useMemo(() => {
    const map = new Map<string, AdvantageGoalProjection>();
    for (const goal of asGoalList(goalsQuery.data)) {
      map.set(goal.id, goal);
    }
    // Graph payload includes description on each goal entry.
    for (const [id, goal] of asFullGoalMap(graphQuery.data)) {
      const existing = map.get(id);
      map.set(id, existing ? { ...existing, ...goal } : goal);
    }
    return map;
  }, [goalsQuery.data, graphQuery.data]);

  const thematicGoal = goalsById.get(cycle.thematicGoalId);
  const thematicDescription =
    (thematicGoal &&
    "description" in thematicGoal &&
    typeof thematicGoal.description === "string"
      ? thematicGoal.description
      : "") ||
    cycle.thematicGoalStatement ||
    "";

  const definingObjectives = Array.isArray(cycle.definingObjectives)
    ? cycle.definingObjectives
    : [];
  const standingObjectives = Array.isArray(cycle.standingOperatingObjectives)
    ? cycle.standingOperatingObjectives
    : [];
  const isLoading = goalsQuery.isLoading || graphQuery.isLoading;
  const isError = goalsQuery.isError && graphQuery.isError;

  return (
    <div className="h-full overflow-auto" data-testid="page-business-advantage">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Business · Advantage
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {cycle.label}
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Thematic goal, defining objectives, standing operating objectives, and the
              scorecard that proves whether the quarter is working.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              void goalsQuery.refetch();
              void graphQuery.refetch();
            }}
            disabled={goalsQuery.isFetching || graphQuery.isFetching}
            data-testid="button-refresh-advantage"
          >
            {goalsQuery.isFetching || graphQuery.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </header>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading goal hierarchy…
          </div>
        ) : null}

        {isError ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            Could not load goals for this operating cycle.
          </div>
        ) : null}

        <section className="space-y-3" data-testid="advantage-thematic-goal">
          <HierarchySectionHeader>Thematic Goal</HierarchySectionHeader>
          <div className={HIERARCHY_TREE_STACK_CLASS}>
            <HierarchyTreeRow continues={false}>
              <ProfileTreeRow
                icon={<Target className="h-3.5 w-3.5" />}
                label={<GoalReferenceTitle goalId={cycle.thematicGoalId} />}
                hasValue
                showEmpty
                defaultOpen
                expandedContentClassName="pt-1"
                expandedContent={
                  <ThematicGoalDetails
                    goalId={cycle.thematicGoalId}
                    description={thematicDescription}
                  />
                }
              >
                {thematicGoal ? (
                  <span className="text-xs text-muted-foreground">
                    {thematicGoal.status ?? "active"}
                  </span>
                ) : (
                  <span className="text-xs text-rose-300">Missing</span>
                )}
              </ProfileTreeRow>
            </HierarchyTreeRow>
          </div>
        </section>

        <section className="space-y-3" data-testid="advantage-defining-objectives">
          <HierarchySectionHeader>Defining Objectives</HierarchySectionHeader>
          <div className={HIERARCHY_TREE_STACK_CLASS}>
            {definingObjectives.map((objective, index) => (
              <ObjectiveBranch
                key={objective.goalId}
                objective={objective}
                goal={goalsById.get(objective.goalId)}
                continues={index < definingObjectives.length - 1}
              />
            ))}
          </div>
        </section>

        <section className="space-y-3" data-testid="advantage-standing-objectives">
          <HierarchySectionHeader>Standing Operating Objectives</HierarchySectionHeader>
          <div className={HIERARCHY_TREE_STACK_CLASS}>
            {standingObjectives.map((item, index) => {
              const tone = measureTone(item.health);
              const Icon = tone.Icon;
              const isLast = index === standingObjectives.length - 1;
              return (
                <HierarchyTreeRow key={item.key} continues={!isLast}>
                  <ProfileTreeRow
                    icon={<ShieldCheck className="h-3.5 w-3.5" />}
                    label={item.label}
                    hasValue
                    showEmpty
                    defaultOpen={false}
                    expandedContent={
                      <div className="space-y-1.5 text-sm leading-6 text-muted-foreground">
                        <p>
                          <span className="font-medium text-foreground/80">Owner · </span>
                          {item.owner}
                        </p>
                        <p>
                          <span className="font-medium text-foreground/80">Cadence · </span>
                          {item.cadence}
                        </p>
                        <p className="whitespace-normal">{item.definition}</p>
                        {"evidence" in item.health && item.health.evidence ? (
                          <p>
                            <span className="font-medium text-foreground/80">
                              Evidence ·{" "}
                            </span>
                            {item.health.evidence}
                          </p>
                        ) : null}
                      </div>
                    }
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-xs",
                        tone.className,
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span>{tone.label}</span>
                    </span>
                  </ProfileTreeRow>
                </HierarchyTreeRow>
              );
            })}
          </div>
        </section>

        <section className="space-y-3" data-testid="advantage-source">
          <HierarchySectionHeader>Source</HierarchySectionHeader>
          <div className={HIERARCHY_TREE_STACK_CLASS}>
            <HierarchyTreeRow continues={false}>
              <ProfileTreeRow
                icon={<Gauge className="h-3.5 w-3.5" />}
                label="Operating cycle"
                hasValue
                showEmpty
              >
                <ReferenceRenderer
                  refValue={createReferenceRef({ type: "page", id: cycle.sourcePageId })}
                  surface="simple-row"
                />
              </ProfileTreeRow>
            </HierarchyTreeRow>
          </div>
        </section>
      </div>
    </div>
  );
}
