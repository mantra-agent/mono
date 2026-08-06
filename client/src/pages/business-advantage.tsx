import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Gauge, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { HierarchySectionHeader } from "@/components/hierarchy-section-header";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import type { BusinessPlan, Goal, Kpi, ProjectRow } from "@shared/schema";
import { createReferenceRef } from "@shared/references";

interface VaultRow {
  id: string;
  name: string;
}

interface VaultSnapshot {
  vaults: VaultRow[];
  visibleVaultIds: string[];
  activeVaultId: string | null;
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

function referenceValue(type: "goal" | "project" | "kpi", id: string, label: string): ReferencePickerValue {
  return { type, id, label };
}

function AssignControl({
  type,
  label,
  onAssign,
}: {
  type: "goal" | "project" | "kpi";
  label: string;
  onAssign: (id: string) => void;
}) {
  return (
    <div className="w-72 p-2" onClick={(event) => event.stopPropagation()}>
      <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">{label}</p>
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
  type: "goal" | "project" | "kpi";
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onCreate}>
            <Plus className="mr-2 h-3.5 w-3.5" /> New Business Plan
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function BusinessAdvantagePage() {
  const queryClient = useQueryClient();
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const plansQuery = useQuery<BusinessPlan[]>({ queryKey: ["/api/business/plans"] });
  const vaultsQuery = useQuery<VaultSnapshot>({ queryKey: ["/api/vaults"] });
  // Shared keys must tolerate the canonical response envelopes used elsewhere.
  // `/api/business/kpis` is cached as `{ kpis }` by the KPI page; `/api/life-goals`
  // is cached as `{ goals }`. Never assume the shared cache holds a bare array.
  const goalsQuery = useQuery<Goal[] | GoalsResponse>({ queryKey: ["/api/life-goals"] });
  const projectsQuery = useQuery<ProjectRow[]>({ queryKey: ["/api/projects/projects"] });
  const kpisQuery = useQuery<Kpi[] | KpisResponse>({ queryKey: ["/api/business/kpis"] });

  const plans = asArray<BusinessPlan>(plansQuery.data);
  // Prefer the user's selected plan; fall back only when selection is missing/stale.
  const plan = (selectedPlanId ? plans.find((candidate) => candidate.id === selectedPlanId) : undefined) ?? plans[0];
  const initiativeProjectIds = asArray<number>(plan?.initiativeProjectIds);
  const kpiIds = asArray<string>(plan?.kpiIds);

  useEffect(() => {
    if (plan && selectedPlanId !== plan.id) setSelectedPlanId(plan.id);
  }, [plan, selectedPlanId]);

  const goalsById = useMemo(
    () => new Map(goalList(goalsQuery.data).map((goal) => [goal.id, goal])),
    [goalsQuery.data],
  );
  const projectsById = useMemo(
    () => new Map(asArray<ProjectRow>(projectsQuery.data).map((project) => [project.id, project])),
    [projectsQuery.data],
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
        vaultId: plan?.vaultId,
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

  if (plansQuery.isLoading || vaultsQuery.isLoading || goalsQuery.isLoading || projectsQuery.isLoading || kpisQuery.isLoading) {
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
  const visibleVaults = asArray<VaultRow>(vaultsQuery.data?.vaults).filter((vault) =>
    asArray<string>(vaultsQuery.data?.visibleVaultIds).includes(vault.id),
  );

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full max-w-xl space-y-6 px-4 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <PlanTitle
            plan={plan}
            plans={plans}
            onSelect={setSelectedPlanId}
            onRename={(name) => update({ name })}
            onCreate={() => createMutation.mutate()}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Business Plan actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Move to Vault</DropdownMenuLabel>
              {visibleVaults.map((vault) => (
                <DropdownMenuItem key={vault.id} onSelect={() => update({ vaultId: vault.id })}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${vault.id === plan.vaultId ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{vault.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* key forces a full remount when the selected plan changes so no prior tree state lingers */}
        <div key={plan.id} className="space-y-6">
          <section className="space-y-3">
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
                    <span className="text-sm text-muted-foreground">No thematic goal assigned</span>
                  )
                }
                mobileLayout="inline"
                hasValue={Boolean(thematicGoalId)}
                showEmpty
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

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <HierarchySectionHeader>Initiatives</HierarchySectionHeader>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-xs">
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <AssignControl
                    type="project"
                    label="Add initiative…"
                    onAssign={(id) => {
                      const projectId = Number(id);
                      if (!Number.isFinite(projectId) || initiativeProjectIds.includes(projectId)) return;
                      update({ initiativeProjectIds: [...initiativeProjectIds, projectId] });
                    }}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="min-w-0">
              {initiativeProjectIds.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">No initiatives assigned</p>
              ) : (
                initiativeProjectIds.map((projectId, index) => {
                  const project = projectsById.get(projectId);
                  return (
                    <HierarchyTreeRow
                      key={`${plan.id}-project-${projectId}-${index}`}
                      continues={index < initiativeProjectIds.length - 1}
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
                        menuContent={
                          <ReplaceControl
                            type="project"
                            value={String(projectId)}
                            label={project?.title ?? `Project ${projectId}`}
                            onReplace={(id) => {
                              const next = [...initiativeProjectIds];
                              next[index] = Number(id);
                              update({ initiativeProjectIds: next });
                            }}
                          />
                        }
                        expandedContent={
                          project?.description ? (
                            <p className="text-sm leading-6 text-foreground/90">{project.description}</p>
                          ) : null
                        }
                      />
                    </HierarchyTreeRow>
                  );
                })
              )}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <HierarchySectionHeader>Key Performance Indicators</HierarchySectionHeader>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-xs">
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <AssignControl
                    type="kpi"
                    label="Add KPI…"
                    onAssign={(id) => {
                      if (kpiIds.includes(id)) return;
                      update({ kpiIds: [...kpiIds, id] });
                    }}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="min-w-0">
              {kpiIds.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">No KPIs assigned</p>
              ) : (
                kpiIds.map((kpiId, index) => {
                  const kpi = kpisById.get(kpiId);
                  return (
                    <HierarchyTreeRow
                      key={`${plan.id}-kpi-${kpiId}-${index}`}
                      continues={index < kpiIds.length - 1}
                      connectorAnchor="first-row-center"
                    >
                      <ProfileTreeRow
                        icon={<Gauge className="h-3.5 w-3.5" />}
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
                })
              )}
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
