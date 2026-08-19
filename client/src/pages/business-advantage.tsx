import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Check, ChevronDown, Loader2, Plus } from "lucide-react";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HierarchySectionHeader,
} from "@/components/hierarchy-section-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import type { BusinessPlan, Goal, Kpi, Metric, ProjectRow } from "@shared/schema";
import { createReferenceRef } from "@shared/references";

const RECENT_BUSINESS_PLAN_KEY = "business-plan:recent-plan-id";

interface MetricsResponse {
  metrics: Metric[];
}

interface KpisResponse {
  kpis: Kpi[];
}

interface GoalsResponse {
  goals: Goal[];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function metricList(value: unknown): Metric[] {
  if (Array.isArray(value)) return value as Metric[];
  if (value && typeof value === "object" && Array.isArray((value as MetricsResponse).metrics)) return (value as MetricsResponse).metrics;
  return [];
}

function kpiList(value: unknown): Kpi[] {
  if (Array.isArray(value)) return value as Kpi[];
  if (value && typeof value === "object" && Array.isArray((value as KpisResponse).kpis)) {
    return (value as KpisResponse).kpis;
  }
  return [];
}

function goalList(value: unknown): Goal[] {
  if (Array.isArray(value)) return value as Goal[];
  if (value && typeof value === "object" && Array.isArray((value as GoalsResponse).goals)) {
    return (value as GoalsResponse).goals;
  }
  return [];
}

function referenceValue(type: "goal" | "project" | "metric" | "kpi", id: string, label: string): ReferencePickerValue {
  return { type, id, label };
}

function AssignControl({
  type,
  label,
  onAssign,
  asAction = false,
}: {
  type: "goal" | "project" | "metric" | "kpi";
  label: string;
  onAssign: (id: string) => void;
  asAction?: boolean;
}) {
  return (
    <div
      className={asAction ? "w-full" : "w-72 p-2"}
      onClick={(event) => event.stopPropagation()}
    >
      <ReferencePicker
        value={[]}
        onChange={(next) => {
          const selected = next[0];
          if (selected) onAssign(selected.id);
        }}
        types={[type]}
        mode="single"
        variant="compact"
        placeholder={label}
        showToken={false}
        className={asAction ? HIERARCHY_PRIMARY_ACTION_CLASS : undefined}
      />
    </div>
  );
}

function ReplaceControl({
  type,
  value,
  label,
  onReplace,
}: {
  type: "goal" | "project" | "metric" | "kpi";
  value: string;
  label: string;
  onReplace: (id: string) => void;
}) {
  return (
    <div className="w-72 p-2" onClick={(event) => event.stopPropagation()}>
      <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
        Change {type === "kpi" ? "KPI" : type}
      </p>
      <ReferencePicker
        value={[referenceValue(type, value, label)]}
        onChange={(next) => {
          const selected = next[0];
          if (selected) onReplace(selected.id);
        }}
        types={[type]}
        mode="single"
        variant="compact"
        placeholder={`Choose ${type === "kpi" ? "KPI" : type}`}
        showToken={false}
      />
    </div>
  );
}

function PlanTitle({
  plan,
  plans,
  onSelect,
  onRename,
  onCreate,
}: {
  plan: BusinessPlan;
  plans: BusinessPlan[];
  onSelect: (id: string) => void;
  onRename: (name: string) => void;
  onCreate: () => void;
}) {
  const [draft, setDraft] = useState(plan.name);
  useEffect(() => setDraft(plan.name), [plan.id, plan.name]);

  const commit = () => {
    const next = draft.trim();
    if (!next) return setDraft(plan.name);
    if (next !== plan.name) onRename(next);
  };

  return (
    <div className="min-w-0 space-y-1">
      <button type="button" onClick={onCreate} className={HIERARCHY_PRIMARY_ACTION_CLASS}>
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Business Plan</span>
      </button>
      <div className="flex min-w-0 items-center gap-1">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(plan.name);
              event.currentTarget.blur();
            }
          }}
          aria-label="Business Plan name"
          className="h-9 min-w-0 max-w-md border-transparent bg-transparent px-2 text-lg font-semibold hover:border-input focus-visible:border-input"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Switch Business Plan">
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>Business Plans</DropdownMenuLabel>
            {plans.map((candidate) => (
              <DropdownMenuItem key={candidate.id} onSelect={() => onSelect(candidate.id)}>
                <Check className={`mr-2 h-3.5 w-3.5 ${candidate.id === plan.id ? "opacity-100" : "opacity-0"}`} />
                <span className="truncate">{candidate.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export default function BusinessPlanPage() {
  const queryClient = useQueryClient();
  // Chip deep links use /business/plan?plan=…; read live search so SPA query changes apply.
  const search = useSearch();
  const routePlanId = useMemo(() => new URLSearchParams(search).get("plan"), [search]);
  const recentPlanId = useMemo(() => {
    try {
      return window.localStorage.getItem(RECENT_BUSINESS_PLAN_KEY);
    } catch {
      return null;
    }
  }, []);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const plansQuery = useQuery<BusinessPlan[]>({ queryKey: ["/api/business/plans"] });
  // Shared keys must tolerate the canonical response envelopes used elsewhere.
  // `/api/business/kpis` is cached as `{ kpis }` by the KPI page; `/api/life-goals`
  // is cached as `{ goals }`. Never assume the shared cache holds a bare array.
  const goalsQuery = useQuery<Goal[] | GoalsResponse>({ queryKey: ["/api/life-goals"] });
  const projectsQuery = useQuery<ProjectRow[]>({ queryKey: ["/api/projects/projects"] });
  const metricsQuery = useQuery<Metric[] | MetricsResponse>({ queryKey: ["/api/business/metrics"] });
  const kpisQuery = useQuery<Kpi[] | KpisResponse>({ queryKey: ["/api/business/kpis"] });

  const plans = asArray<BusinessPlan>(plansQuery.data);

  useEffect(() => {
    if (!plans.length) return setSelectedPlanId(null);
    // Deep link always wins when the plan is visible — including same-route query changes.
    if (routePlanId && plans.some((candidate) => candidate.id === routePlanId)) {
      setSelectedPlanId(routePlanId);
      return;
    }
    if (selectedPlanId && plans.some((candidate) => candidate.id === selectedPlanId)) return;
    if (recentPlanId && plans.some((candidate) => candidate.id === recentPlanId)) {
      setSelectedPlanId(recentPlanId);
      return;
    }
    setSelectedPlanId(plans[0].id);
  }, [plans, recentPlanId, routePlanId, selectedPlanId]);

  useEffect(() => {
    if (!selectedPlanId || !plans.some((candidate) => candidate.id === selectedPlanId)) return;
    try {
      window.localStorage.setItem(RECENT_BUSINESS_PLAN_KEY, selectedPlanId);
    } catch {
      // Selection remains usable when storage is unavailable.
    }
  }, [plans, selectedPlanId]);

  const plan =
    plans.find((candidate) => candidate.id === selectedPlanId) ??
    plans.find((candidate) => candidate.id === routePlanId) ??
    plans.find((candidate) => candidate.id === recentPlanId) ??
    plans[0];
  const initiativeProjectIds = asArray<number>(plan?.initiativeProjectIds);
  const kpiIds = asArray<string>(plan?.kpiIds);
  const measurementBindings = asArray<BusinessPlan["initiativeMeasurementBindings"][number]>(plan?.initiativeMeasurementBindings);

  const goalsById = useMemo(
    () => new Map(goalList(goalsQuery.data).map((goal) => [goal.id, goal])),
    [goalsQuery.data],
  );
  const projectsById = useMemo(
    () => new Map(asArray<ProjectRow>(projectsQuery.data).map((project) => [project.id, project])),
    [projectsQuery.data],
  );
  const metricsById = useMemo(
    () => new Map(metricList(metricsQuery.data).map((metric) => [metric.id, metric])),
    [metricsQuery.data],
  );
  const kpisById = useMemo(
    () => new Map(kpiList(kpisQuery.data).map((kpi) => [kpi.id, kpi])),
    [kpisQuery.data],
  );

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<BusinessPlan> }) => {
      const response = await apiRequest("PATCH", `/api/business/plans/${id}`, patch);
      return response.json() as Promise<BusinessPlan>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<BusinessPlan[]>(["/api/business/plans"], (current) =>
        asArray<BusinessPlan>(current).map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      // New plans stay empty. Never copy thematic goal / initiatives / KPIs from the open plan.
      const response = await apiRequest("POST", "/api/business/plans", {
        name: "New Business Plan",
      });
      return response.json() as Promise<BusinessPlan>;
    },
    onSuccess: (created) => {
      queryClient.setQueryData<BusinessPlan[]>(["/api/business/plans"], (current) => [
        ...asArray<BusinessPlan>(current),
        created,
      ]);
      setSelectedPlanId(created.id);
    },
  });

  if (plansQuery.isLoading || goalsQuery.isLoading || projectsQuery.isLoading || metricsQuery.isLoading || kpisQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!plan) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">No Business Plan is available.</div>;
  }

  const update = (patch: Partial<BusinessPlan>) => updateMutation.mutate({ id: plan.id, patch });
  const thematicGoalId = plan.thematicGoalId ?? null;
  const thematicGoal = thematicGoalId ? goalsById.get(thematicGoalId) : undefined;
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full max-w-xl space-y-1 px-4 py-4 sm:px-6">
        <PlanTitle
          plan={plan}
          plans={plans}
          onSelect={setSelectedPlanId}
          onRename={(name) => update({ name })}
          onCreate={() => createMutation.mutate()}
        />

        {/* key forces a full remount when the selected plan changes so no prior tree state lingers */}
        <div key={plan.id} className="space-y-1">
          <section className="space-y-1">
            <HierarchySectionHeader>Thematic Goal</HierarchySectionHeader>
            <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
              <ProfileTreeRow
                label={
                  thematicGoalId ? (
                    <ReferenceRenderer
                      refValue={createReferenceRef({
                        type: "goal",
                        id: thematicGoalId,
                        metadata: { label: thematicGoal?.shortName ?? thematicGoal?.description ?? "Goal" },
                      })}
                      surface="simple-chip"
                    />
                  ) : (
                    <AssignControl
                      type="goal"
                      label="+ Set Goal"
                      asAction
                      onAssign={(id) => update({ thematicGoalId: id })}
                    />
                  )
                }
                mobileLayout="inline"
                hasValue={Boolean(thematicGoalId)}
                showEmpty
                menuVisibility="hover"
                menuContent={
                  thematicGoalId ? (
                    <ReplaceControl
                      type="goal"
                      value={thematicGoalId}
                      label={thematicGoal?.shortName ?? thematicGoal?.description ?? "Goal"}
                      onReplace={(id) => update({ thematicGoalId: id })}
                    />
                  ) : (
                    <AssignControl
                      type="goal"
                      label="Assign goal…"
                      onAssign={(id) => update({ thematicGoalId: id })}
                    />
                  )
                }
                expandedContent={
                  thematicGoal?.description ? (
                    <p className="text-sm leading-6 text-foreground/90">{thematicGoal.description}</p>
                  ) : null
                }
              />
            </HierarchyTreeRow>
          </section>

          <section className="space-y-1">
            <HierarchySectionHeader>Initiatives</HierarchySectionHeader>
            <div className="min-w-0">
              {initiativeProjectIds.map((projectId, index) => {
                const project = projectsById.get(projectId);
                const binding = measurementBindings.find((candidate) => candidate.initiativeProjectId === projectId);
                const leadingMetric = binding?.leadingMetricId ? metricsById.get(binding.leadingMetricId) : undefined;
                const laggingKpi = binding?.laggingKpiId ? kpisById.get(binding.laggingKpiId) : undefined;
                const replaceBinding = (patch: { leadingMetricId?: string | null; laggingKpiId?: string | null }) => {
                  const next = measurementBindings.filter((candidate) => candidate.initiativeProjectId !== projectId);
                  const replacement = {
                    initiativeProjectId: projectId,
                    leadingMetricId: patch.leadingMetricId !== undefined ? patch.leadingMetricId : binding?.leadingMetricId ?? null,
                    laggingKpiId: patch.laggingKpiId !== undefined ? patch.laggingKpiId : binding?.laggingKpiId ?? null,
                  };
                  if (replacement.leadingMetricId || replacement.laggingKpiId) next.push(replacement);
                  update({ initiativeMeasurementBindings: next });
                };
                return (
                  <HierarchyTreeRow
                    key={`${plan.id}-project-${projectId}-${index}`}
                    continues
                    connectorAnchor="first-row-center"
                  >
                    <ProfileTreeRow
                      label={
                        <ReferenceRenderer
                          refValue={createReferenceRef({
                            type: "project",
                            id: String(projectId),
                            metadata: { label: project?.title ?? `Project ${projectId}` },
                          })}
                          surface="simple-chip"
                        />
                      }
                      mobileLayout="inline"
                      hasValue
                      showEmpty
                      menuVisibility="hover"
                      menuContent={
                        <ReplaceControl
                          type="project"
                          value={String(projectId)}
                          label={project?.title ?? `Project ${projectId}`}
                          onReplace={(id) => {
                            const nextId = Number(id);
                            if (!Number.isFinite(nextId)) return;
                            const next = [...initiativeProjectIds];
                            next[index] = nextId;
                            update({ initiativeProjectIds: next });
                          }}
                        />
                      }
                      expandedContent={
                        <div className="space-y-2">
                          {project?.description ? <p className="text-sm leading-6 text-foreground/90">{project.description}</p> : null}
                          <div className="space-y-1 border-l border-border/20 pl-3">
                            {binding?.leadingMetricId ? (
                              <ReplaceControl type="metric" value={binding.leadingMetricId} label={leadingMetric?.name ?? "Metric"} onReplace={(id) => replaceBinding({ leadingMetricId: id })} />
                            ) : (
                              <AssignControl type="metric" label="+ Leading Metric" onAssign={(id) => replaceBinding({ leadingMetricId: id })} />
                            )}
                            {binding?.laggingKpiId ? (
                              <ReplaceControl type="kpi" value={binding.laggingKpiId} label={laggingKpi?.name ?? "KPI"} onReplace={(id) => replaceBinding({ laggingKpiId: id })} />
                            ) : (
                              <AssignControl type="kpi" label="+ Lagging KPI" onAssign={(id) => replaceBinding({ laggingKpiId: id })} />
                            )}
                          </div>
                        </div>
                      }
                    />
                  </HierarchyTreeRow>
                );
              })}
              <AssignControl
                type="project"
                label="+ Add Initiative"
                asAction
                onAssign={(id) => {
                  const projectId = Number(id);
                  if (!Number.isFinite(projectId)) return;
                  if (initiativeProjectIds.includes(projectId)) return;
                  update({ initiativeProjectIds: [...initiativeProjectIds, projectId] });
                }}
              />
            </div>
          </section>

          <section className="space-y-1">
            <HierarchySectionHeader>Key Performance Indicators</HierarchySectionHeader>
            <div className="min-w-0">
              {kpiIds.map((kpiId, index) => {
                const kpi = kpisById.get(kpiId);
                return (
                  <HierarchyTreeRow
                    key={`${plan.id}-kpi-${kpiId}-${index}`}
                    continues
                    connectorAnchor="first-row-center"
                  >
                    <ProfileTreeRow
                      label={
                        <ReferenceRenderer
                          refValue={createReferenceRef({
                            type: "kpi",
                            id: kpiId,
                            metadata: { label: kpi?.name ?? "KPI" },
                          })}
                          surface="simple-chip"
                        />
                      }
                      mobileLayout="inline"
                      hasValue
                      showEmpty
                      menuVisibility="hover"
                      menuContent={
                        <ReplaceControl
                          type="kpi"
                          value={kpiId}
                          label={kpi?.name ?? "KPI"}
                          onReplace={(id) => {
                            const next = [...kpiIds];
                            next[index] = id;
                            update({ kpiIds: next });
                          }}
                        />
                      }
                      expandedContent={
                        kpi?.description ? (
                          <p className="text-sm leading-6 text-foreground/90">{kpi.description}</p>
                        ) : null
                      }
                    />
                  </HierarchyTreeRow>
                );
              })}
              <AssignControl
                type="kpi"
                label="+ Add KPI"
                asAction
                onAssign={(id) => {
                  if (kpiIds.includes(id)) return;
                  update({ kpiIds: [...kpiIds, id] });
                }}
              />
            </div>
          </section>
        </div>

        {updateMutation.isError || createMutation.isError ? (
          <p className="text-sm text-destructive">The Business Plan could not be saved.</p>
        ) : null}
      </div>
    </div>
  );
}
