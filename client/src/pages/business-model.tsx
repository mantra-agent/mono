import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, ChevronRight, Loader2, MoreHorizontal } from "lucide-react";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HIERARCHY_SESSION_ROW_CLASS } from "@/components/hierarchy-section-header";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { ReferencePicker } from "@/components/references/reference-picker";
import { useAuth } from "@/hooks/use-auth";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { BusinessBudget } from "@shared/models/business-budgets";
import {
  aggregateMonths,
  applyAssumptionSamples,
  computeProjection,
  FINANCING_LABELS,
  type Assumptions,
  type FinancingKey,
  type FinancialModel,
  type PeriodMode,
  type PeriodRow,
} from "@shared/models/business-model";
import type { Kpi } from "@shared/models/metrics";
import type { BusinessHiringProjection } from "@shared/models/business-hiring";
import type { BusinessPricing } from "@shared/models/business-pricing";
import type { JobRole } from "@shared/models/job-roles";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

const PERIOD_MODES: { key: PeriodMode; label: string }[] = [
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annually", label: "Annually" },
];
const ASSUMPTIONS_DISCLOSURE_KEY = "mantra.forecast.assumptions-open.v1";
const FORECAST_TREE_KEY = "mantra.forecast.tree-open.v1";
const MAX_ASSUMPTION_PREFERENCES = 64;
const FORECAST_TREE_ROWS = ["utilization", "accounts", "newAccounts", "users", "expandedUsers", "meetings", "grossProfit", "revenue", "cogs", "opex", "staff"] as const;
type ForecastTreeRow = (typeof FORECAST_TREE_ROWS)[number];
type ForecastTreeState = Record<ForecastTreeRow, boolean>;

function readAssumptionsPreferences(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ASSUMPTIONS_DISCLOSURE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean").slice(-MAX_ASSUMPTION_PREFERENCES));
  } catch {
    return {};
  }
}

function readAssumptionsOpen(preferenceKey: string | null): boolean {
  return preferenceKey ? readAssumptionsPreferences()[preferenceKey] ?? false : false;
}

function persistAssumptionsOpen(preferenceKey: string | null, open: boolean): void {
  if (!preferenceKey) return;
  try {
    const preferences = readAssumptionsPreferences();
    delete preferences[preferenceKey];
    preferences[preferenceKey] = open;
    window.localStorage.setItem(ASSUMPTIONS_DISCLOSURE_KEY, JSON.stringify(Object.fromEntries(Object.entries(preferences).slice(-MAX_ASSUMPTION_PREFERENCES))));
  } catch {
    // Browser storage is an optional preference layer. The section remains closed by default.
  }
}

function emptyForecastTree(): ForecastTreeState {
  return Object.fromEntries(FORECAST_TREE_ROWS.map((row) => [row, false])) as ForecastTreeState;
}

function readForecastTreePreferences(): Record<string, ForecastTreeState> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FORECAST_TREE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ForecastTreeState] => {
      const value = entry[1];
      return Boolean(value && typeof value === "object" && !Array.isArray(value) && FORECAST_TREE_ROWS.every((row) => typeof (value as Record<string, unknown>)[row] === "boolean"));
    }).slice(-MAX_ASSUMPTION_PREFERENCES));
  } catch {
    return {};
  }
}

function readForecastTree(preferenceKey: string | null): ForecastTreeState {
  return preferenceKey ? readForecastTreePreferences()[preferenceKey] ?? emptyForecastTree() : emptyForecastTree();
}

function persistForecastTree(preferenceKey: string | null, tree: ForecastTreeState): void {
  if (!preferenceKey) return;
  try {
    const preferences = readForecastTreePreferences();
    delete preferences[preferenceKey];
    preferences[preferenceKey] = tree;
    window.localStorage.setItem(FORECAST_TREE_KEY, JSON.stringify(Object.fromEntries(Object.entries(preferences).slice(-MAX_ASSUMPTION_PREFERENCES))));
  } catch {
    // Browser storage is an optional preference layer. The tree remains closed by default.
  }
}

function trimNum(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString();
}

function fmtScaled(value: number, suffix: string): string {
  return `${(Math.round(value * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${suffix}`;
}

function fmtCurrency(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const amount = absolute >= 1_000_000 ? fmtScaled(absolute / 1_000_000, "M") : absolute >= 1_000 ? fmtScaled(absolute / 1_000, "k") : fmtScaled(absolute, "");
  return sign + String.fromCharCode(36) + amount;
}

function fmtWhole(value: number): string {
  return Math.round(value).toLocaleString();
}

function fmtHours(value: number): string {
  return value >= 0.5 ? `${fmtWhole(value)} hrs` : "—";
}

function ceilMeetings(value: number): number {
  return value > 0 ? Math.ceil(value) : 0;
}

function fmtMeetings(value: number): string {
  const count = ceilMeetings(value);
  return count > 0 ? count.toLocaleString() : "—";
}

function fmtRunway(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value >= 0.5 ? `${fmtWhole(value)} mo` : "—";
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${trimNum(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimNum(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNum(value / 1_000)}k`;
  return Math.round(value).toLocaleString();
}

function fmtPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCatalogMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatCatalogCount(value: number | null): string {
  return value === null ? "Unlimited" : String(value);
}

interface NumericInputProps {
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
  ariaLabel: string;
  disabled?: boolean;
}

function NumericInput({ value, onChange, prefix, suffix, min, step, ariaLabel, disabled }: NumericInputProps) {
  return (
    <div className="flex h-5 w-40 max-w-full items-center gap-1 rounded-md bg-muted/50 px-1.5 focus-within:ring-1 focus-within:ring-ring sm:w-48">
      {prefix && <span className="shrink-0 text-xs text-muted-foreground">{prefix}</span>}
      <input
        aria-label={ariaLabel}
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        disabled={disabled}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-5 min-w-0 flex-1 bg-transparent p-0 text-right text-xs leading-none tabular-nums outline-none [appearance:textfield] disabled:cursor-default disabled:text-muted-foreground [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {suffix && <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function SavedIndicator({ state }: { state: SaveState }) {
  if (state === "saving" || state === "pending") return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</span>;
  if (state === "saved") return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="h-3 w-3 text-success" /> Saved</span>;
  if (state === "error") return <span className="text-xs text-destructive">Save failed</span>;
  return null;
}

export default function BusinessModelPage() {
  const { businesses, selectedId, setSelectedId } = useSelectedBusiness();
  const { user, principal } = useAuth();
  const { toast } = useToast();
  const modelUrl = selectedId ? `/api/business/model?businessId=${encodeURIComponent(selectedId)}` : "/api/business/model";
  const budgetUrl = selectedId ? `/api/business/budgets?businessId=${encodeURIComponent(selectedId)}` : "/api/business/budgets";
  const { data, isLoading, isFetching, error, refetch } = useQuery<FinancialModel>({ queryKey: [modelUrl], enabled: Boolean(selectedId) });
  const { data: budget, isLoading: budgetLoading, isFetching: budgetFetching, error: budgetError, refetch: refetchBudget } = useQuery<BusinessBudget>({
    queryKey: ["/api/business/budgets", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => (await apiRequest("GET", budgetUrl)).json(),
  });
  const { data: rolesData } = useQuery<{ roles: JobRole[] }>({ queryKey: ["/api/business/roles"] });
  const hiringUrl = selectedId ? `/api/business/hiring?businessId=${encodeURIComponent(selectedId)}` : "/api/business/hiring";
  const { data: hiring, isLoading: hiringLoading, isFetching: hiringFetching } = useQuery<BusinessHiringProjection>({
    queryKey: ["/api/business/hiring", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => (await apiRequest("GET", hiringUrl)).json(),
  });
  const pricingUrl = selectedId ? `/api/business/pricing?businessId=${encodeURIComponent(selectedId)}` : "/api/business/pricing";
  const { data: pricing, isLoading: pricingLoading, isFetching: pricingFetching, error: pricingError, refetch: refetchPricing } = useQuery<BusinessPricing>({
    queryKey: ["/api/business/pricing", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => (await apiRequest("GET", pricingUrl)).json(),
  });
  const kpisUrl = selectedId ? `/api/business/kpis?businessId=${encodeURIComponent(selectedId)}` : "/api/business/kpis";
  const { data: kpisData } = useQuery<{ kpis: Kpi[] }>({ queryKey: [kpisUrl], enabled: Boolean(selectedId) });
  usePageLoadActivity("page:business-model", isLoading || isFetching || budgetLoading || budgetFetching || hiringLoading || hiringFetching || pricingLoading || pricingFetching);
  const assumptionsPreferenceKey = useMemo(() => {
    if (!user?.id || !principal?.accountId || !selectedId) return null;
    return `${principal.accountId}:${user.id}:${selectedId}`;
  }, [principal?.accountId, selectedId, user?.id]);
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [assumptionsOpen, setAssumptionsOpen] = useState(() => readAssumptionsOpen(assumptionsPreferenceKey));
  const [period, setPeriod] = useState<PeriodMode>("monthly");
  const [tree, setTree] = useState<ForecastTreeState>(() => readForecastTree(assumptionsPreferenceKey));
  const loadedIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data && loadedIdRef.current !== data.id) {
      loadedIdRef.current = data.id;
      setDraft(data.assumptions);
    }
  }, [data]);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    loadedIdRef.current = null;
    setDraft(null);
    setSaveState("idle");
  }, [selectedId]);

  useEffect(() => {
    setAssumptionsOpen(readAssumptionsOpen(assumptionsPreferenceKey));
    setTree(readForecastTree(assumptionsPreferenceKey));
  }, [assumptionsPreferenceKey]);

  const changeAssumptionsOpen = useCallback((open: boolean) => {
    setAssumptionsOpen(open);
    persistAssumptionsOpen(assumptionsPreferenceKey, open);
  }, [assumptionsPreferenceKey]);

  const toggleTree = useCallback((row: ForecastTreeRow) => {
    setTree((current) => {
      const next = { ...current, [row]: !current[row] };
      persistForecastTree(assumptionsPreferenceKey, next);
      return next;
    });
  }, [assumptionsPreferenceKey]);

  const save = useMutation({
    mutationFn: async (assumptions: Assumptions) => {
      if (!selectedId) throw new Error("Select a Business first");
      return (await apiRequest("PATCH", `/api/business/model?businessId=${encodeURIComponent(selectedId)}`, assumptions)).json() as Promise<FinancialModel>;
    },
    onMutate: () => setSaveState("saving"),
    onSuccess: (model) => {
      queryClient.setQueryData([modelUrl], model);
      setSaveState("saved");
    },
    onError: (saveError: Error) => {
      setSaveState("error");
      toast({ title: "Failed to save forecast", description: saveError.message, variant: "destructive" });
    },
  });

  const scheduleSave = useCallback((assumptions: Assumptions) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("pending");
    saveTimer.current = setTimeout(() => save.mutate(assumptions), 600);
  }, [save]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const updateGlobal = useCallback((patch: Partial<Assumptions>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const updateFinancing = useCallback((key: FinancingKey, amount: number) => {
    setDraft((current) => {
      if (!current) return current;
      const next = {
        ...current,
        financingEvents: current.financingEvents.map((event) => event.key === key ? { ...event, amount } : event),
      };
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const linkAssumption = useCallback((key: string, kpiId: string | null) => {
    setDraft((current) => {
      if (!current) return current;
      const assumptionKpis = { ...(current.assumptionKpis ?? {}) };
      if (kpiId) assumptionKpis[key] = kpiId;
      else delete assumptionKpis[key];
      const next = { ...current, assumptionKpis };
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const kpiById = useMemo(() => new Map((kpisData?.kpis ?? []).map((kpi) => [kpi.id, kpi])), [kpisData]);
  const assumptionSamples = useMemo(() => Object.fromEntries(
    (kpisData?.kpis ?? []).flatMap((kpi) => Number.isFinite(kpi.score?.value) ? [[kpi.id, kpi.score!.value as number]] : []),
  ), [kpisData]);
  const liveAssumptions = useMemo(() => draft ? applyAssumptionSamples(draft, assumptionSamples) : null, [assumptionSamples, draft]);
  const sampled = useCallback((key: string) => {
    const kpiId = draft?.assumptionKpis?.[key];
    return Boolean(kpiId) && Number.isFinite(kpiById.get(kpiId!)?.score?.value);
  }, [draft, kpiById]);
  const projection = useMemo(() => liveAssumptions && budget && hiring && pricing ? computeProjection(liveAssumptions, rolesData?.roles ?? hiring.roles, budget.departments, hiring.slots, pricing) : null, [budget, hiring, liveAssumptions, pricing, rolesData]);
  const periods = useMemo(() => projection ? aggregateMonths(projection.months, period) : [], [projection, period]);
  const staffRoles = useMemo(() => {
    if (!draft || !hiring || periods.length === 0) return [];
    const labels = new Map<string, string>(hiring.roles.map((role) => [role.id, role.title]));
    for (const cost of draft.operatingCosts) {
      if (cost.classification === "opex" && (cost.opexCategory ?? "g_and_a") === "staff") labels.set(cost.id, cost.label);
    }
    return [...new Set(periods.flatMap((row) => Object.keys(row.staffByRole)))].map((id) => ({ id, label: labels.get(id) ?? id })).sort((left, right) => left.label.localeCompare(right.label));
  }, [draft, hiring, periods]);

  if (error || budgetError || pricingError) {
    return (
      <div className="w-full p-4">
        <p className="text-sm font-medium text-foreground">Forecast unavailable</p>
        <p className="mt-1 text-sm text-muted-foreground">{((error ?? budgetError ?? pricingError) as Error).message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-4" disabled={isFetching || budgetFetching || pricingFetching} onClick={() => { void refetch(); void refetchBudget(); void refetchPricing(); }}>
          {(isFetching || budgetFetching || pricingFetching) && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Try again
        </Button>
      </div>
    );
  }

  if (isLoading || budgetLoading || hiringLoading || pricingLoading || !draft || !liveAssumptions || !budget || !hiring || !pricing || !projection) return null;

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <BusinessPageHeader page="Model" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      <section className="overflow-hidden border-y border-border/20">
        <ProfileDetailSection title="Assumptions" open={assumptionsOpen} onOpenChange={changeAssumptionsOpen} headerAction={<SavedIndicator state={saveState} />}>
          <div className="space-y-0">
            <ProfileDetailSection title="Tiers" defaultOpen testId="assumptions-tiers">
              {pricing.packages.map((pkg) => (
                <ProfileDetailSection key={pkg.key} title={pkg.name} defaultOpen testId={`tier-${pkg.key}`}>
                  <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                    <span className="min-w-0 truncate text-muted-foreground">Year 1</span>
                    <span className="tabular-nums text-sm text-foreground">{formatCatalogMoney(pkg.yearOneMonthly)} / mo</span>
                  </div>
                  <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                    <span className="min-w-0 truncate text-muted-foreground">Year 2</span>
                    <span className="tabular-nums text-sm text-foreground">{formatCatalogMoney(pkg.yearTwoMonthly)} / mo</span>
                  </div>
                  <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                    <span className="min-w-0 truncate text-muted-foreground">Included Participants</span>
                    <span className="tabular-nums text-sm text-foreground">{formatCatalogCount(pkg.includedParticipants)}</span>
                  </div>
                  <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                    <span className="min-w-0 truncate text-muted-foreground">Included tokens</span>
                    <span className="tabular-nums text-sm text-foreground">{pkg.includedTokensMillions}M</span>
                  </div>
                  <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                    <span className="min-w-0 truncate text-muted-foreground">Extra Participant</span>
                    <span className="tabular-nums text-sm text-foreground">{pkg.extraParticipantMonthly === null ? "—" : `${formatCatalogMoney(pkg.extraParticipantMonthly)} / mo`}</span>
                  </div>
                </ProfileDetailSection>
              ))}
              <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                <span className="min-w-0 truncate text-muted-foreground">Token cost</span>
                <span className="tabular-nums text-sm text-foreground">{formatCatalogMoney(pricing.extras.workhorseInputPerMillion)} / 1M</span>
              </div>
              <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
                <span className="min-w-0 truncate text-muted-foreground">Extra usage</span>
                <span className="tabular-nums text-sm text-foreground">{formatCatalogMoney(pricing.extras.extraUsagePerMillion)} / 1M</span>
              </div>
              <AssumptionDriver assumptionKey="factoryPlusEntrySharePct" label="Factory+ entry share" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
                <NumericInput ariaLabel="Factory+ entry volume share" value={liveAssumptions.factoryPlusEntrySharePct} min={0} step={5} suffix="%" disabled={sampled("factoryPlusEntrySharePct")} onChange={(factoryPlusEntrySharePct) => updateGlobal({ factoryPlusEntrySharePct, enterpriseEntrySharePct: factoryPlusEntrySharePct })} />
              </AssumptionDriver>
              <Link href="/business/pricing" className={cn(HIERARCHY_SESSION_ROW_CLASS, "text-cta hover:text-active")}>
                Edit catalog on Pricing
              </Link>
            </ProfileDetailSection>
            <AssumptionDriver assumptionKey="startingAccounts" label="Starting accounts" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Starting paying accounts" value={liveAssumptions.startingAccounts} min={0} step={1} disabled={sampled("startingAccounts")} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="startingUsers" label="Starting users" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Starting users" value={liveAssumptions.startingUsers} min={0} step={1} disabled={sampled("startingUsers")} onChange={(startingUsers) => updateGlobal({ startingUsers })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="quarterOneNewAccounts" label="Q1 new accounts" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Quarter one new accounts" value={liveAssumptions.quarterOneNewAccounts} min={0} step={1} disabled={sampled("quarterOneNewAccounts")} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="averageUsersPerNewAccount" label="Users per new account" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Average users per new account" value={liveAssumptions.averageUsersPerNewAccount} min={1} step={1} disabled={sampled("averageUsersPerNewAccount")} onChange={(averageUsersPerNewAccount) => updateGlobal({ averageUsersPerNewAccount })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="annualAccountChurnPct" label="Annual account churn" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Annual account churn" value={liveAssumptions.annualAccountChurnPct} min={0} step={1} suffix="%" disabled={sampled("annualAccountChurnPct")} onChange={(annualAccountChurnPct) => updateGlobal({ annualAccountChurnPct })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="annualExistingAccountUserContractionPct" label="User contraction" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Annual user contraction within existing accounts" value={liveAssumptions.annualExistingAccountUserContractionPct} min={0} step={5} suffix="% / yr" disabled={sampled("annualExistingAccountUserContractionPct")} onChange={(annualExistingAccountUserContractionPct) => updateGlobal({ annualExistingAccountUserContractionPct })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="annualAccountUpgradePct" label="Account upgrades" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Annual account upgrade rate" value={liveAssumptions.annualAccountUpgradePct} min={0} step={5} suffix="% / yr" disabled={sampled("annualAccountUpgradePct")} onChange={(annualAccountUpgradePct) => updateGlobal({ annualAccountUpgradePct })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="hoursUsedPerActiveUser" label="Hours per user" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Hours used per active user per month" value={liveAssumptions.hoursUsedPerActiveUser} min={0} step={1} suffix="/ mo" disabled={sampled("hoursUsedPerActiveUser")} onChange={(hoursUsedPerActiveUser) => updateGlobal({ hoursUsedPerActiveUser })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="meetingsPerHour" label="Meetings per hour" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Meetings per hour used" value={liveAssumptions.meetingsPerHour} min={0} step={0.05} disabled={sampled("meetingsPerHour")} onChange={(meetingsPerHour) => updateGlobal({ meetingsPerHour })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="internalMeetingSharePct" label="Internal meeting share" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Share of meetings that are internal" value={liveAssumptions.internalMeetingSharePct} min={0} step={5} suffix="%" disabled={sampled("internalMeetingSharePct")} onChange={(internalMeetingSharePct) => updateGlobal({ internalMeetingSharePct })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="newAccountsPerExternalMeeting" label="Accounts per external meeting" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="New accounts per external meeting" value={liveAssumptions.newAccountsPerExternalMeeting} min={0} step={0.01} disabled={sampled("newAccountsPerExternalMeeting")} onChange={(newAccountsPerExternalMeeting) => updateGlobal({ newAccountsPerExternalMeeting })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="expandedUsersPerInternalMeeting" label="Users per internal meeting" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Expanded users per internal meeting" value={liveAssumptions.expandedUsersPerInternalMeeting} min={0} step={0.01} disabled={sampled("expandedUsersPerInternalMeeting")} onChange={(expandedUsersPerInternalMeeting) => updateGlobal({ expandedUsersPerInternalMeeting })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="tokensUsedPerHour" label="Tokens per hour" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Tokens used per hour" value={liveAssumptions.tokensUsedPerHour} min={0} step={10000} disabled={sampled("tokensUsedPerHour")} onChange={(tokensUsedPerHour) => updateGlobal({ tokensUsedPerHour })} />
            </AssumptionDriver>
            <AssumptionDriver assumptionKey="loadedCostMultiplier" label="Loaded comp multiplier" draft={draft} kpiById={kpiById} onLink={linkAssumption}>
              <NumericInput ariaLabel="Fully loaded staff comp multiplier on base salary plus bonus" value={liveAssumptions.loadedCostMultiplier} min={0.5} step={0.05} suffix="×" disabled={sampled("loadedCostMultiplier")} onChange={(loadedCostMultiplier) => updateGlobal({ loadedCostMultiplier })} />
            </AssumptionDriver>
            {draft.financingEvents.map((event) => {
              const liveEvent = liveAssumptions.financingEvents.find((candidate) => candidate.key === event.key) ?? event;
              return (
                <AssumptionDriver key={event.key} assumptionKey={event.key} label={FINANCING_LABELS[event.key]} draft={draft} kpiById={kpiById} onLink={linkAssumption}>
                  <NumericInput ariaLabel={`${FINANCING_LABELS[event.key]} investment`} value={liveEvent.amount} min={0} step={50000} prefix="$" disabled={sampled(event.key)} onChange={(amount) => updateFinancing(event.key, amount)} />
                </AssumptionDriver>
              );
            })}
          </div>
        </ProfileDetailSection>
      </section>

      <section className="overflow-hidden border-y border-border/20">
        <ProfileDetailSection
          title="Forecast"
          defaultOpen
          headerAction={(
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="Forecast options" className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Cadence</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {PERIOD_MODES.map((mode) => (
                      <DropdownMenuCheckboxItem key={mode.key} checked={period === mode.key} onCheckedChange={() => setPeriod(mode.key)}>
                        {mode.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        >
          <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 min-w-[11rem] h-8 border-b border-r border-border/20 bg-background px-3 py-0 text-left font-medium text-muted-foreground" />
                {periods.map((row) => <th key={row.key} className="min-w-[4.75rem] h-8 border-b border-border/10 px-2 py-0 text-right font-medium text-muted-foreground">{row.label}</th>)}
              </tr>
            </thead>
            <tbody>
              <DataRow label="Utilization" periods={periods} render={(row) => tree.utilization ? "" : fmtHours(row.hoursUsed)} onToggle={() => toggleTree("utilization")} open={tree.utilization} tone={() => "text-foreground"} emphasize />
              {tree.utilization && <DataRow label="Accounts" indent periods={periods} render={(row) => Math.round(row.activeAccounts).toLocaleString()} onToggle={() => toggleTree("accounts")} open={tree.accounts} />}
              {tree.utilization && tree.accounts && <DataRow label="New Accounts" indent={2} periods={periods} render={(row) => row.newAccounts >= 0.05 ? `+${trimNum(row.newAccounts)}` : "—"} onToggle={() => toggleTree("newAccounts")} open={tree.newAccounts} />}
              {tree.utilization && tree.accounts && tree.newAccounts && <DataRow label="From External Meetings" indent={3} periods={periods} render={(row) => row.newAccountsFromMeetings >= 0.05 ? `+${trimNum(row.newAccountsFromMeetings)}` : "—"} />}
              {tree.utilization && tree.accounts && <DataRow label="Churned Accounts" indent={2} periods={periods} render={(row) => row.churnedAccounts >= 0.05 ? `-${trimNum(row.churnedAccounts)}` : "—"} tone={() => "text-muted-foreground"} />}
              {tree.utilization && <DataRow label="Users" indent periods={periods} render={(row) => Math.round(row.activeUsers).toLocaleString()} onToggle={() => toggleTree("users")} open={tree.users} />}
              {tree.utilization && tree.users && <DataRow label="New Users" indent={2} periods={periods} render={(row) => row.newUsers >= 0.05 ? `+${trimNum(row.newUsers)}` : "—"} />}
              {tree.utilization && tree.users && <DataRow label="Expanded Users" indent={2} periods={periods} render={(row) => row.expandedUsers >= 0.05 ? `+${trimNum(row.expandedUsers)}` : "—"} onToggle={() => toggleTree("expandedUsers")} open={tree.expandedUsers} />}
              {tree.utilization && tree.users && tree.expandedUsers && <DataRow label="From Internal Meetings" indent={3} periods={periods} render={(row) => row.expandedUsersFromMeetings >= 0.05 ? `+${trimNum(row.expandedUsersFromMeetings)}` : "—"} />}
              {tree.utilization && tree.users && <DataRow label="Contracted Users" indent={2} periods={periods} render={(row) => row.contractedUsers >= 0.05 ? `-${trimNum(row.contractedUsers)}` : "—"} tone={() => "text-muted-foreground"} />}
              {tree.utilization && <DataRow label="Meetings" indent periods={periods} render={(row) => tree.meetings ? "" : fmtMeetings(row.meetings)} onToggle={() => toggleTree("meetings")} open={tree.meetings} />}
              {tree.utilization && tree.meetings && <DataRow label="Internal Meetings" indent={2} periods={periods} render={(row) => fmtMeetings(Math.min(row.internalMeetings, ceilMeetings(row.meetings)))} />}
              {tree.utilization && tree.meetings && <DataRow label="External Meetings" indent={2} periods={periods} render={(row) => fmtMeetings(ceilMeetings(row.meetings) - ceilMeetings(Math.min(row.internalMeetings, ceilMeetings(row.meetings))))} />}
              {tree.utilization && <DataRow label="Hours Used" indent periods={periods} render={(row) => row.hoursUsed >= 0.5 ? fmtWhole(row.hoursUsed) : "—"} />}
              <DataRow label="Gross Profit" periods={periods} render={(row) => tree.grossProfit ? "" : fmtCurrency(row.grossProfit)} onToggle={() => toggleTree("grossProfit")} open={tree.grossProfit} tone={(row) => row.grossProfit < 0 ? "text-destructive" : "text-foreground"} emphasize />
              {tree.grossProfit && <DataRow label="Revenue" indent periods={periods} render={(row) => fmtCurrency(row.totalCashRevenue)} onToggle={() => toggleTree("revenue")} open={tree.revenue} />}
              {tree.grossProfit && tree.revenue && <DataRow label="Starting Cohort" indent={2} periods={periods} render={(row) => fmtCurrency(row.startingCohortRevenue)} />}
              {tree.grossProfit && tree.revenue && <DataRow label="Account Churn" indent={2} periods={periods} render={(row) => row.churnedRevenue > 0 ? fmtCurrency(-row.churnedRevenue) : "—"} tone={() => "text-muted-foreground"} />}
              {tree.grossProfit && tree.revenue && <DataRow label="Added Users" indent={2} periods={periods} render={(row) => row.userExpansionRevenue > 0 ? `+${fmtCurrency(row.userExpansionRevenue)}` : "—"} />}
              {tree.grossProfit && tree.revenue && <DataRow label="Lost Users" indent={2} periods={periods} render={(row) => row.userContractionRevenue > 0 ? fmtCurrency(-row.userContractionRevenue) : "—"} tone={() => "text-muted-foreground"} />}
              {tree.grossProfit && tree.revenue && <DataRow label="Upgrades" indent={2} periods={periods} render={(row) => row.tierExpansionRevenue > 0 ? `+${fmtCurrency(row.tierExpansionRevenue)}` : "—"} />}
              {tree.grossProfit && tree.revenue && <DataRow label="MRR" indent={2} periods={periods} render={(row) => fmtCurrency(row.mrr)} />}
              {tree.grossProfit && tree.revenue && <DataRow label="NRR" indent={2} periods={periods} render={(row) => row.startingCohortRevenue > 0 ? fmtPercent(row.cohortNrr) : "—"} tone={() => "text-muted-foreground"} />}
              {tree.grossProfit && <DataRow label="COGS" indent periods={periods} render={(row) => fmtCurrency(-row.cogs)} onToggle={() => toggleTree("cogs")} open={tree.cogs} tone={() => "text-muted-foreground"} />}
              {tree.grossProfit && tree.cogs && <DataRow label="Tokens Used" indent={2} periods={periods} render={(row) => row.tokensUsed >= 0.5 ? formatTokens(row.tokensUsed) : "—"} />}
              {tree.grossProfit && tree.cogs && <DataRow label="Token Cost" indent={2} periods={periods} render={(row) => row.tokenCost >= 0.5 ? fmtCurrency(-row.tokenCost) : "—"} tone={() => "text-muted-foreground"} />}
              {tree.grossProfit && tree.cogs && <DataRow label="Support" indent={2} periods={periods} render={(row) => row.supportCogs >= 0.5 ? fmtCurrency(-row.supportCogs) : "—"} tone={() => "text-muted-foreground"} />}
              {tree.grossProfit && <DataRow label="Gross Profit" indent periods={periods} render={(row) => fmtCurrency(row.grossProfit)} tone={(row) => row.grossProfit < 0 ? "text-destructive" : "text-foreground"} />}
              <DataRow label="OpEx" periods={periods} render={(row) => fmtCurrency(-row.totalOpex)} onToggle={() => toggleTree("opex")} open={tree.opex} emphasize />
              {tree.opex && <DataRow label="Staff" indent periods={periods} render={(row) => tree.staff ? "" : fmtCurrency(-row.staffOpex)} onToggle={() => toggleTree("staff")} open={tree.staff} tone={() => "text-muted-foreground"} />}
              {tree.opex && tree.staff && staffRoles.map((role) => (
                <DataRow key={role.id} label={role.label} indent={2} periods={periods} render={(row) => (row.staffByRole[role.id] ?? 0) >= 0.5 ? fmtCurrency(-(row.staffByRole[role.id] ?? 0)) : "—"} tone={() => "text-muted-foreground"} />
              ))}
              {tree.opex && budget.departments.map((department) => (
                <DataRow key={department.id} label={department.name} indent periods={periods} render={(row) => fmtCurrency(-(row.departmentOpex[department.id] ?? 0))} tone={() => "text-muted-foreground"} />
              ))}
              <DataRow label="Operating Income" periods={periods} render={(row) => fmtCurrency(row.operatingIncome)} tone={(row) => row.operatingIncome < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Net Cash Flow" periods={periods} render={(row) => fmtCurrency(row.netCashChange)} tone={(row) => row.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Investment" periods={periods} render={(row) => row.financingCash > 0 ? fmtCurrency(row.financingCash) : "—"} />
              <DataRow label="Cash Balance" periods={periods} render={(row) => fmtCurrency(row.endingCash)} tone={(row) => row.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
              <DataRow label="Runway" periods={periods} render={(row) => fmtRunway(row.runwayMonths)} />
              <DataRow label="ARR" periods={periods} render={(row) => fmtCurrency(row.arr)} />
            </tbody>
          </table>
          </div>
        </ProfileDetailSection>
      </section>
    </div>
  );
}

function AssumptionDriver({
  assumptionKey,
  label,
  draft,
  kpiById,
  onLink,
  children,
}: {
  assumptionKey: string;
  label: string;
  draft: Assumptions;
  kpiById: Map<string, Kpi>;
  onLink: (key: string, kpiId: string | null) => void;
  children: ReactNode;
}) {
  const kpiId = draft.assumptionKpis?.[assumptionKey];
  const kpi = kpiId ? kpiById.get(kpiId) : undefined;
  const sampled = Boolean(kpiId) && Number.isFinite(kpi?.score?.value);
  const fallback = Boolean(kpiId) && !sampled;
  return (
    <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
      <span className="min-w-0 truncate text-muted-foreground">
        {label}
        {kpi && <span className="ml-1.5 text-xs text-muted-foreground/80">{sampled ? kpi.name : `${kpi.name} · custom`}</span>}
        {kpiId && !kpi && <span className="ml-1.5 text-xs text-muted-foreground/80">Missing KPI · custom</span>}
      </span>
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`${label} assumption options`} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="overflow-visible" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="w-72 p-2" onClick={(event) => event.stopPropagation()}>
              <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">{kpiId ? "Change KPI" : "Link KPI"}</p>
              <ReferencePicker
                value={kpi ? [{ type: "kpi", id: kpi.id, label: kpi.name }] : []}
                onChange={(next) => onLink(assumptionKey, next[0]?.id ?? null)}
                types={["kpi"]}
                mode="single"
                variant="compact"
                placeholder="Choose KPI"
                showToken={false}
              />
              {fallback && <p className="mt-2 px-1 text-xs text-muted-foreground">Unmeasured · using custom</p>}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

interface DataRowProps {
  label: string;
  periods: PeriodRow[];
  render: (row: PeriodRow) => string;
  tone?: (row: PeriodRow) => string;
  emphasize?: boolean;
  indent?: boolean | number;
  onToggle?: () => void;
  open?: boolean;
}

function DataRow({ label, periods, render, tone, emphasize, indent, onToggle, open }: DataRowProps) {
  const indentLevel = indent === true ? 1 : indent === false || indent == null ? 0 : indent;
  return (
    <tr className="h-8 border-t border-border/10">
      <td className={cn("sticky left-0 z-10 h-8 border-r border-border/20 bg-background px-3 py-0 text-left text-muted-foreground", emphasize && "font-medium text-foreground", indentLevel > 0 && "text-muted-foreground/80", indentLevel === 1 && "pl-6", indentLevel === 2 && "pl-9", indentLevel >= 3 && "pl-12")}>
        {onToggle ? <button type="button" onClick={onToggle} className={cn("flex h-8 items-center gap-1 text-left hover:text-foreground", emphasize && "text-foreground")}><ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />{label}</button> : label}
      </td>
      {periods.map((row) => <td key={row.key} className={cn("h-8 px-2 py-0 text-right text-foreground", indentLevel > 0 && "text-muted-foreground/80", tone?.(row))}>{render(row)}</td>)}
    </tr>
  );
}
