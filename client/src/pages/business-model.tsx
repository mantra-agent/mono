import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { useAuth } from "@/hooks/use-auth";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { BusinessBudget } from "@shared/models/business-budgets";
import {
  aggregateMonths,
  computeProjection,
  type Assumptions,
  type FinancialModel,
  type PeriodMode,
  type PeriodRow,
} from "@shared/models/business-model";
import type { BusinessHiringProjection } from "@shared/models/business-hiring";
import type { JobRole } from "@shared/models/job-roles";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

const PERIOD_MODES: { key: PeriodMode; label: string }[] = [
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annually", label: "Annually" },
];
const ASSUMPTIONS_DISCLOSURE_KEY = "mantra.forecast.assumptions-open.v1";
const MAX_ASSUMPTION_PREFERENCES = 64;

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

function fmtHours(value: number): string {
  return value >= 0.05 ? `${trimNum(value)} hrs` : "—";
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

interface NumericInputProps {
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
  ariaLabel: string;
}

function NumericInput({ value, onChange, prefix, suffix, min, step, ariaLabel }: NumericInputProps) {
  return (
    <div className="flex h-5 w-40 max-w-full items-center gap-1 rounded-md bg-muted/50 px-1.5 focus-within:ring-1 focus-within:ring-ring sm:w-48">
      {prefix && <span className="shrink-0 text-xs text-muted-foreground">{prefix}</span>}
      <input
        aria-label={ariaLabel}
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-5 min-w-0 flex-1 bg-transparent p-0 text-right text-xs leading-none tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
  usePageLoadActivity("page:business-model", isLoading || isFetching || budgetLoading || budgetFetching || hiringLoading || hiringFetching);
  const assumptionsPreferenceKey = useMemo(() => {
    if (!user?.id || !principal?.accountId || !selectedId) return null;
    return `${principal.accountId}:${user.id}:${selectedId}`;
  }, [principal?.accountId, selectedId, user?.id]);
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [assumptionsOpen, setAssumptionsOpen] = useState(() => readAssumptionsOpen(assumptionsPreferenceKey));
  const [period, setPeriod] = useState<PeriodMode>("monthly");
  const [utilizationOpen, setUtilizationOpen] = useState(true);
  const [accountsOpen, setAccountsOpen] = useState(true);
  const [usersOpen, setUsersOpen] = useState(true);
  const [meetingsOpen, setMeetingsOpen] = useState(true);
  const [grossProfitOpen, setGrossProfitOpen] = useState(true);
  const [revenueOpen, setRevenueOpen] = useState(true);
  const [cogsOpen, setCogsOpen] = useState(true);
  const [opexOpen, setOpexOpen] = useState(false);
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
  }, [assumptionsPreferenceKey]);

  const changeAssumptionsOpen = useCallback((open: boolean) => {
    setAssumptionsOpen(open);
    persistAssumptionsOpen(assumptionsPreferenceKey, open);
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

  const projection = useMemo(() => draft && budget && hiring ? computeProjection(draft, rolesData?.roles ?? hiring.roles, budget.departments, hiring.slots) : null, [budget, draft, rolesData, hiring]);
  const periods = useMemo(() => projection ? aggregateMonths(projection.months, period) : [], [projection, period]);

  if (error || budgetError) {
    return (
      <div className="w-full p-4">
        <p className="text-sm font-medium text-foreground">Forecast unavailable</p>
        <p className="mt-1 text-sm text-muted-foreground">{((error ?? budgetError) as Error).message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-4" disabled={isFetching || budgetFetching} onClick={() => { void refetch(); void refetchBudget(); }}>
          {(isFetching || budgetFetching) && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Try again
        </Button>
      </div>
    );
  }

  if (isLoading || budgetLoading || hiringLoading || !draft || !budget || !hiring || !projection) return null;

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <BusinessPageHeader page="Model" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      <section className="overflow-hidden border-y border-border/20">
        <ProfileDetailSection title="Assumptions" open={assumptionsOpen} onOpenChange={changeAssumptionsOpen} headerAction={<SavedIndicator state={saveState} />}>
          <div className="space-y-0">
            <Driver label="Starting accounts"><NumericInput ariaLabel="Starting paying accounts" value={draft.startingAccounts} min={0} step={1} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} /></Driver>
            <Driver label="Starting users"><NumericInput ariaLabel="Starting users" value={draft.startingUsers} min={0} step={1} onChange={(startingUsers) => updateGlobal({ startingUsers })} /></Driver>
            <Driver label="Q1 new accounts"><NumericInput ariaLabel="Quarter one new accounts" value={draft.quarterOneNewAccounts} min={0} step={1} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} /></Driver>
            <Driver label="Users per new account"><NumericInput ariaLabel="Average users per new account" value={draft.averageUsersPerNewAccount} min={1} step={1} onChange={(averageUsersPerNewAccount) => updateGlobal({ averageUsersPerNewAccount })} /></Driver>
            <Driver label="Annual account churn"><NumericInput ariaLabel="Annual account churn" value={draft.annualAccountChurnPct} min={0} step={1} suffix="%" onChange={(annualAccountChurnPct) => updateGlobal({ annualAccountChurnPct })} /></Driver>
            <Driver label="User contraction"><NumericInput ariaLabel="Annual user contraction within existing accounts" value={draft.annualExistingAccountUserContractionPct} min={0} step={5} suffix="% / yr" onChange={(annualExistingAccountUserContractionPct) => updateGlobal({ annualExistingAccountUserContractionPct })} /></Driver>
            <Driver label="Account upgrades"><NumericInput ariaLabel="Annual account upgrade rate" value={draft.annualAccountUpgradePct} min={0} step={5} suffix="% / yr" onChange={(annualAccountUpgradePct) => updateGlobal({ annualAccountUpgradePct })} /></Driver>
            <Driver label="Base plan"><NumericInput ariaLabel="Base plan monthly price" value={draft.maxSubscriptionMonthly} min={0} step={50} prefix="$" suffix="/ mo" onChange={(maxSubscriptionMonthly) => updateGlobal({ maxSubscriptionMonthly })} /></Driver>
            <Driver label="Upgraded plan"><NumericInput ariaLabel="Upgraded plan monthly price" value={draft.maxPlusSubscriptionMonthly} min={0} step={50} prefix="$" suffix="/ mo" onChange={(maxPlusSubscriptionMonthly) => updateGlobal({ maxPlusSubscriptionMonthly })} /></Driver>
            <Driver label="Additional user"><NumericInput ariaLabel="Additional user monthly price" value={draft.participantSeatMonthly} min={0} step={25} prefix="$" suffix="/ mo" onChange={(participantSeatMonthly) => updateGlobal({ participantSeatMonthly })} /></Driver>
            <Driver label="Hours per user"><NumericInput ariaLabel="Hours used per active user per month" value={draft.hoursUsedPerActiveUser} min={0} step={1} suffix="/ mo" onChange={(hoursUsedPerActiveUser) => updateGlobal({ hoursUsedPerActiveUser })} /></Driver>
            <Driver label="Meetings per hour"><NumericInput ariaLabel="Meetings per hour used" value={draft.meetingsPerHour} min={0} step={0.05} onChange={(meetingsPerHour) => updateGlobal({ meetingsPerHour })} /></Driver>
            <Driver label="Internal meeting share"><NumericInput ariaLabel="Share of meetings that are internal" value={draft.internalMeetingSharePct} min={0} step={5} suffix="%" onChange={(internalMeetingSharePct) => updateGlobal({ internalMeetingSharePct })} /></Driver>
            <Driver label="Accounts per external meeting"><NumericInput ariaLabel="New accounts per external meeting" value={draft.newAccountsPerExternalMeeting} min={0} step={0.01} onChange={(newAccountsPerExternalMeeting) => updateGlobal({ newAccountsPerExternalMeeting })} /></Driver>
            <Driver label="Users per internal meeting"><NumericInput ariaLabel="Expanded users per internal meeting" value={draft.expandedUsersPerInternalMeeting} min={0} step={0.01} onChange={(expandedUsersPerInternalMeeting) => updateGlobal({ expandedUsersPerInternalMeeting })} /></Driver>
            <Driver label="Tokens per hour"><NumericInput ariaLabel="Tokens used per hour" value={draft.tokensUsedPerHour} min={0} step={10000} onChange={(tokensUsedPerHour) => updateGlobal({ tokensUsedPerHour })} /></Driver>
            <Driver label="Token cost"><NumericInput ariaLabel="Blended token cost per million" value={draft.blendedTokenCostPerMillion} min={0} step={0.25} prefix="$" suffix="/ 1M" onChange={(blendedTokenCostPerMillion) => updateGlobal({ blendedTokenCostPerMillion })} /></Driver>
            <Driver label="Loaded comp multiplier"><NumericInput ariaLabel="Fully loaded staff comp multiplier on base salary plus bonus" value={draft.loadedCostMultiplier} min={0.5} step={0.05} suffix="×" onChange={(loadedCostMultiplier) => updateGlobal({ loadedCostMultiplier })} /></Driver>
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
              <DataRow label="Utilization" periods={periods} render={(row) => utilizationOpen ? "" : fmtHours(row.hoursUsed)} onToggle={() => setUtilizationOpen((open) => !open)} open={utilizationOpen} tone={() => "text-foreground"} emphasize />
              {utilizationOpen && <DataRow label="Accounts" indent periods={periods} render={(row) => Math.round(row.activeAccounts).toLocaleString()} onToggle={() => setAccountsOpen((open) => !open)} open={accountsOpen} />}
              {utilizationOpen && accountsOpen && <DataRow label="New Accounts" indent={2} periods={periods} render={(row) => row.newAccounts >= 0.05 ? `+${trimNum(row.newAccounts)}` : "—"} />}
              {utilizationOpen && accountsOpen && <DataRow label="From External Meetings" indent={3} periods={periods} render={(row) => row.newAccountsFromMeetings >= 0.05 ? `+${trimNum(row.newAccountsFromMeetings)}` : "—"} />}
              {utilizationOpen && accountsOpen && <DataRow label="Churned Accounts" indent={2} periods={periods} render={(row) => row.churnedAccounts >= 0.05 ? `-${trimNum(row.churnedAccounts)}` : "—"} tone={() => "text-muted-foreground"} />}
              {utilizationOpen && <DataRow label="Users" indent periods={periods} render={(row) => Math.round(row.activeUsers).toLocaleString()} onToggle={() => setUsersOpen((open) => !open)} open={usersOpen} />}
              {utilizationOpen && usersOpen && <DataRow label="New Users" indent={2} periods={periods} render={(row) => row.newUsers >= 0.05 ? `+${trimNum(row.newUsers)}` : "—"} />}
              {utilizationOpen && usersOpen && <DataRow label="Expanded Users" indent={2} periods={periods} render={(row) => row.expandedUsers >= 0.05 ? `+${trimNum(row.expandedUsers)}` : "—"} />}
              {utilizationOpen && usersOpen && <DataRow label="From Internal Meetings" indent={3} periods={periods} render={(row) => row.expandedUsersFromMeetings >= 0.05 ? `+${trimNum(row.expandedUsersFromMeetings)}` : "—"} />}
              {utilizationOpen && usersOpen && <DataRow label="Contracted Users" indent={2} periods={periods} render={(row) => row.contractedUsers >= 0.05 ? `-${trimNum(row.contractedUsers)}` : "—"} tone={() => "text-muted-foreground"} />}
              {utilizationOpen && <DataRow label="Meetings" indent periods={periods} render={(row) => meetingsOpen ? "" : (row.meetings >= 0.05 ? trimNum(row.meetings) : "—")} onToggle={() => setMeetingsOpen((open) => !open)} open={meetingsOpen} />}
              {utilizationOpen && meetingsOpen && <DataRow label="Internal Meetings" indent={2} periods={periods} render={(row) => row.internalMeetings >= 0.05 ? trimNum(row.internalMeetings) : "—"} />}
              {utilizationOpen && meetingsOpen && <DataRow label="External Meetings" indent={2} periods={periods} render={(row) => row.externalMeetings >= 0.05 ? trimNum(row.externalMeetings) : "—"} />}
              {utilizationOpen && <DataRow label="Hours Used" indent periods={periods} render={(row) => row.hoursUsed >= 0.05 ? trimNum(row.hoursUsed) : "—"} />}
              <DataRow label="Gross Profit" periods={periods} render={(row) => grossProfitOpen ? "" : fmtCurrency(row.grossProfit)} onToggle={() => setGrossProfitOpen((open) => !open)} open={grossProfitOpen} tone={(row) => row.grossProfit < 0 ? "text-destructive" : "text-foreground"} emphasize />
              {grossProfitOpen && <DataRow label="Gross Profit" indent periods={periods} render={(row) => fmtCurrency(row.grossProfit)} tone={(row) => row.grossProfit < 0 ? "text-destructive" : "text-foreground"} />}
              {grossProfitOpen && <DataRow label="Revenue" indent periods={periods} render={(row) => fmtCurrency(row.totalCashRevenue)} onToggle={() => setRevenueOpen((open) => !open)} open={revenueOpen} />}
              {grossProfitOpen && revenueOpen && <DataRow label="Starting Cohort" indent={2} periods={periods} render={(row) => fmtCurrency(row.startingCohortRevenue)} />}
              {grossProfitOpen && revenueOpen && <DataRow label="Account Churn" indent={2} periods={periods} render={(row) => row.churnedRevenue > 0 ? fmtCurrency(-row.churnedRevenue) : "—"} tone={() => "text-muted-foreground"} />}
              {grossProfitOpen && revenueOpen && <DataRow label="Added Users" indent={2} periods={periods} render={(row) => row.userExpansionRevenue > 0 ? `+${fmtCurrency(row.userExpansionRevenue)}` : "—"} />}
              {grossProfitOpen && revenueOpen && <DataRow label="Lost Users" indent={2} periods={periods} render={(row) => row.userContractionRevenue > 0 ? fmtCurrency(-row.userContractionRevenue) : "—"} tone={() => "text-muted-foreground"} />}
              {grossProfitOpen && revenueOpen && <DataRow label="Upgrades" indent={2} periods={periods} render={(row) => row.tierExpansionRevenue > 0 ? `+${fmtCurrency(row.tierExpansionRevenue)}` : "—"} />}
              {grossProfitOpen && revenueOpen && <DataRow label="MRR" indent={2} periods={periods} render={(row) => fmtCurrency(row.mrr)} />}
              {grossProfitOpen && revenueOpen && <DataRow label="NRR" indent={2} periods={periods} render={(row) => row.startingCohortRevenue > 0 ? fmtPercent(row.cohortNrr) : "—"} tone={() => "text-muted-foreground"} />}
              {grossProfitOpen && <DataRow label="COGS" indent periods={periods} render={(row) => fmtCurrency(-row.cogs)} onToggle={() => setCogsOpen((open) => !open)} open={cogsOpen} tone={() => "text-muted-foreground"} />}
              {grossProfitOpen && cogsOpen && <DataRow label="Tokens Used" indent={2} periods={periods} render={(row) => row.tokensUsed >= 0.5 ? formatTokens(row.tokensUsed) : "—"} />}
              {grossProfitOpen && cogsOpen && <DataRow label="Token Cost" indent={2} periods={periods} render={(row) => row.tokenCost >= 0.5 ? fmtCurrency(-row.tokenCost) : "—"} tone={() => "text-muted-foreground"} />}
              {grossProfitOpen && cogsOpen && <DataRow label="Support" indent={2} periods={periods} render={(row) => row.supportCogs >= 0.5 ? fmtCurrency(-row.supportCogs) : "—"} tone={() => "text-muted-foreground"} />}
              <DataRow label="OpEx" periods={periods} render={(row) => fmtCurrency(-row.totalOpex)} onToggle={() => setOpexOpen((open) => !open)} open={opexOpen} emphasize />
              {opexOpen && <DataRow label="Staff" indent periods={periods} render={(row) => fmtCurrency(-row.staffOpex)} tone={() => "text-muted-foreground"} />}
              {opexOpen && budget.departments.map((department) => (
                <DataRow key={department.id} label={department.name} indent periods={periods} render={(row) => fmtCurrency(-(row.departmentOpex[department.id] ?? 0))} tone={() => "text-muted-foreground"} />
              ))}
              <DataRow label="Operating Income" periods={periods} render={(row) => fmtCurrency(row.operatingIncome)} tone={(row) => row.operatingIncome < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Net Cash Flow" periods={periods} render={(row) => fmtCurrency(row.netCashChange)} tone={(row) => row.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Cash Balance" periods={periods} render={(row) => fmtCurrency(row.endingCash)} tone={(row) => row.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
              <DataRow label="ARR" periods={periods} render={(row) => fmtCurrency(row.arr)} />
            </tbody>
          </table>
          </div>
        </ProfileDetailSection>
      </section>
    </div>
  );
}

function Driver({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between hover:bg-accent/70")}>
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <div className="min-w-0 shrink-0">{children}</div>
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
