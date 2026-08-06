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

function referenceValue(type: "goal" | "project" | "kpi", id: string, label: string): ReferencePickerValue {
  return { type, id, label };
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
      <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">Change {type === "kpi" ? "KPI" : type}</p>
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
  const goalsQuery = useQuery<Goal[]>({
    queryKey: ["/api/life-goals"],
    queryFn: async () => {
      const response = await fetch("/api/life-goals", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load goals");
      const payload = await response.json() as Goal[] | { goals?: Goal[] };
      return Array.isArray(payload) ? payload : payload.goals ?? [];
    },
  });
  const projectsQuery = useQuery<ProjectRow[]>({ queryKey: ["/api/projects/projects"] });
  const kpisQuery = useQuery<Kpi[]>({ queryKey: ["/api/business/kpis"] });

  const plans = plansQuery.data ?? [];
  const plan = plans.find((candidate) => candidate.id === selectedPlanId) ?? plans[0];

  useEffect(() => {
    if (plan && selectedPlanId !== plan.id) setSelectedPlanId(plan.id);
  }, [plan, selectedPlanId]);

  const goalsById = useMemo(() => new Map((goalsQuery.data ?? []).map((goal) => [goal.id, goal])), [goalsQuery.data]);
  const projectsById = useMemo(() => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])), [projectsQuery.data]);
  const kpisById = useMemo(() => new Map((kpisQuery.data ?? []).map((kpi) => [kpi.id, kpi])), [kpisQuery.data]);

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<BusinessPlan> }) => {
      const response = await apiRequest("PATCH", `/api/business/plans/${id}`, patch);
      return response.json() as Promise<BusinessPlan>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<BusinessPlan[]>(["/api/business/plans"], (current = []) =>
        current.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/business/plans", {
        name: "New Business Plan",
        vaultId: plan?.vaultId,
        thematicGoalId: plan?.thematicGoalId,
      });
      return response.json() as Promise<BusinessPlan>;
    },
    onSuccess: (created) => {
      queryClient.setQueryData<BusinessPlan[]>(["/api/business/plans"], (current = []) => [...current, created]);
      setSelectedPlanId(created.id);
    },
  });

  if (plansQuery.isLoading || vaultsQuery.isLoading || goalsQuery.isLoading || projectsQuery.isLoading || kpisQuery.isLoading) {
    return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (!plan) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">No Business Plan is available.</div>;
  }

  const update = (patch: Partial<BusinessPlan>) => updateMutation.mutate({ id: plan.id, patch });
  const thematicGoal = goalsById.get(plan.thematicGoalId);
  const visibleVaults = (vaultsQuery.data?.vaults ?? []).filter((vault) => vaultsQuery.data?.visibleVaultIds.includes(vault.id));

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

        <section className="space-y-3">
          <HierarchySectionHeader>Thematic Goal</HierarchySectionHeader>
          <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
            <ProfileTreeRow
              label={<ReferenceRenderer reference={createReferenceRef("goal", plan.thematicGoalId)} showIcon={false} />}
              mobileLayout="inline"
              hasValue
              showEmpty
              defaultOpen
              menuContent={<ReplaceControl type="goal" value={plan.thematicGoalId} label={thematicGoal?.shortName ?? "Goal"} onReplace={(thematicGoalId) => update({ thematicGoalId })} />}
              expandedContent={thematicGoal?.description ? <p className="text-sm leading-6 text-foreground/90">{thematicGoal.description}</p> : null}
            />
          </HierarchyTreeRow>
        </section>

        <section className="space-y-3">
          <HierarchySectionHeader>Initiatives</HierarchySectionHeader>
          <div className="min-w-0">
            {plan.initiativeProjectIds.map((projectId, index) => {
              const project = projectsById.get(projectId);
              return (
                <HierarchyTreeRow key={`${projectId}-${index}`} continues={index < plan.initiativeProjectIds.length - 1} connectorAnchor="first-row-center">
                  <ProfileTreeRow
                    label={<ReferenceRenderer reference={createReferenceRef("project", String(projectId))} showIcon={false} />}
                    mobileLayout="inline"
                    hasValue
                    showEmpty
                    menuContent={
                      <ReplaceControl
                        type="project"
                        value={String(projectId)}
                        label={project?.title ?? `Project ${projectId}`}
                        onReplace={(id) => {
                          const next = [...plan.initiativeProjectIds];
                          next[index] = Number(id);
                          update({ initiativeProjectIds: next });
                        }}
                      />
                    }
                    expandedContent={project?.description ? <p className="text-sm leading-6 text-foreground/90">{project.description}</p> : null}
                  />
                </HierarchyTreeRow>
              );
            })}
          </div>
        </section>

        <section className="space-y-3">
          <HierarchySectionHeader>Key Performance Indicators</HierarchySectionHeader>
          <div className="min-w-0">
            {plan.kpiIds.map((kpiId, index) => {
              const kpi = kpisById.get(kpiId);
              return (
                <HierarchyTreeRow key={`${kpiId}-${index}`} continues={index < plan.kpiIds.length - 1} connectorAnchor="first-row-center">
                  <ProfileTreeRow
                    icon={<Gauge className="h-3.5 w-3.5" />}
                    label={<ReferenceRenderer reference={createReferenceRef("kpi", kpiId)} showIcon={false} />}
                    mobileLayout="inline"
                    hasValue
                    showEmpty
                    menuContent={
                      <ReplaceControl
                        type="kpi"
                        value={kpiId}
                        label={kpi?.name ?? "KPI"}
                        onReplace={(id) => {
                          const next = [...plan.kpiIds];
                          next[index] = id;
                          update({ kpiIds: next });
                        }}
                      />
                    }
                    expandedContent={kpi ? (
                      <div className="space-y-1 text-sm leading-6 text-muted-foreground">
                        <p><span className="font-medium text-foreground/80">Target · </span>{kpi.targetLabel}</p>
                        <p><span className="font-medium text-foreground/80">Cadence · </span>{kpi.cadence}</p>
                        {kpi.description ? <p><span className="font-medium text-foreground/80">Definition · </span>{kpi.description}</p> : null}
                      </div>
                    ) : null}
                  />
                </HierarchyTreeRow>
              );
            })}
          </div>
        </section>

        {updateMutation.isError || createMutation.isError ? (
          <p className="text-sm text-destructive">The Business Plan could not be saved.</p>
        ) : null}
      </div>
    </div>
  );
}
