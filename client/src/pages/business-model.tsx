import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HIERARCHY_SESSION_ROW_CLASS } from "@/components/hierarchy-section-header";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { Button } from "@/components/ui/button";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  aggregateMonths,
  computeProjection,
  type Assumptions,
  type FinancialModel,
  type PeriodMode,
  type PeriodRow,
} from "@shared/models/business-model";
import type { JobRole } from "@shared/models/job-roles";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

const PERIOD_MODES: { key: PeriodMode; label: string }[] = [
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annually", label: "Annually" },
];

function trimNum(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString();
}

function fmtCurrency(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${sign}$${trimNum(absolute / 1_000_000)}M`;
  if (absolute >= 1_000) return `${sign}$${trimNum(absolute / 1_000)}k`;
  return `${sign}$${Math.round(absolute).toLocaleString()}`;
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
  const { toast } = useToast();
  const modelUrl = selectedId ? `/api/business/model?businessId=${encodeURIComponent(selectedId)}` : "/api/business/model";
  const { data, isLoading, isFetching, error, refetch } = useQuery<FinancialModel>({ queryKey: [modelUrl], enabled: Boolean(selectedId) });
  const { data: rolesData } = useQuery<{ roles: JobRole[] }>({ queryKey: ["/api/business/roles"] });
  usePageLoadActivity("page:business-model", isLoading || isFetching);
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [period, setPeriod] = useState<PeriodMode>("monthly");
  const [revenueOpen, setRevenueOpen] = useState(true);
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

  const projection = useMemo(() => draft ? computeProjection(draft, rolesData?.roles ?? []) : null, [draft, rolesData]);
  const periods = useMemo(() => projection ? aggregateMonths(projection.months, period) : [], [projection, period]);

  if (error) {
    return (
      <div className="w-full p-4">
        <p className="text-sm font-medium text-foreground">Forecast unavailable</p>
        <p className="mt-1 text-sm text-muted-foreground">{(error as Error).message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-4" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Try again
        </Button>
      </div>
    );
  }

  if (isLoading || !draft || !projection) return null;

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <BusinessPageHeader page="Model" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      <section className="overflow-hidden border-y border-border/20">
        <ProfileDetailSection title="Assumptions" defaultOpen headerAction={<SavedIndicator state={saveState} />}>
          <div className="space-y-0">
            <Driver label="Starting accounts"><NumericInput ariaLabel="Starting paying accounts" value={draft.startingAccounts} min={0} step={1} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} /></Driver>
            <Driver label="Starting users"><NumericInput ariaLabel="Starting users" value={draft.startingUsers} min={0} step={1} onChange={(startingUsers) => updateGlobal({ startingUsers })} /></Driver>
            <Driver label="Q1 new accounts"><NumericInput ariaLabel="Quarter one new accounts" value={draft.quarterOneNewAccounts} min={0} step={1} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} /></Driver>
            <Driver label="Users per new account"><NumericInput ariaLabel="Average users per new account" value={draft.averageUsersPerNewAccount} min={1} step={1} onChange={(averageUsersPerNewAccount) => updateGlobal({ averageUsersPerNewAccount })} /></Driver>
            <Driver label="New account growth"><NumericInput ariaLabel="New account growth every 90 days" value={draft.accountExpansion90d} min={0} step={0.05} suffix="× / 90d" onChange={(accountExpansion90d) => updateGlobal({ accountExpansion90d })} /></Driver>
            <Driver label="Annual account churn"><NumericInput ariaLabel="Annual account churn" value={draft.annualAccountChurnPct} min={0} step={1} suffix="%" onChange={(annualAccountChurnPct) => updateGlobal({ annualAccountChurnPct })} /></Driver>
            <Driver label="Existing-account user growth"><NumericInput ariaLabel="Annual user growth within existing accounts" value={draft.annualExistingAccountUserGrowthPct} min={0} step={5} suffix="% / yr" onChange={(annualExistingAccountUserGrowthPct) => updateGlobal({ annualExistingAccountUserGrowthPct })} /></Driver>
            <Driver label="Account upgrades"><NumericInput ariaLabel="Annual account upgrade rate" value={draft.annualAccountUpgradePct} min={0} step={5} suffix="% / yr" onChange={(annualAccountUpgradePct) => updateGlobal({ annualAccountUpgradePct })} /></Driver>
            <Driver label="Base plan"><NumericInput ariaLabel="Base plan monthly price" value={draft.maxSubscriptionMonthly} min={0} step={50} prefix="$" suffix="/ mo" onChange={(maxSubscriptionMonthly) => updateGlobal({ maxSubscriptionMonthly })} /></Driver>
            <Driver label="Upgraded plan"><NumericInput ariaLabel="Upgraded plan monthly price" value={draft.maxPlusSubscriptionMonthly} min={0} step={50} prefix="$" suffix="/ mo" onChange={(maxPlusSubscriptionMonthly) => updateGlobal({ maxPlusSubscriptionMonthly })} /></Driver>
            <Driver label="Additional user"><NumericInput ariaLabel="Additional user monthly price" value={draft.participantSeatMonthly} min={0} step={25} prefix="$" suffix="/ mo" onChange={(participantSeatMonthly) => updateGlobal({ participantSeatMonthly })} /></Driver>
          </div>
        </ProfileDetailSection>
      </section>

      <section className="overflow-hidden border-y border-border/20">
        <ProfileDetailSection
          title="Forecast"
          defaultOpen
          headerAction={(
            <div className="flex items-center gap-1 rounded-md border border-border/40 p-0.5">
              {PERIOD_MODES.map((mode) => (
                <button key={mode.key} type="button" onClick={() => setPeriod(mode.key)} className={cn("min-h-8 rounded px-3 text-xs font-medium normal-case tracking-normal transition-colors", period === mode.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {mode.label}
                </button>
              ))}
            </div>
          )}
        >
          <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 min-w-[11rem] border-b border-r border-border/20 bg-background px-3 py-2 text-left font-medium text-muted-foreground">{periods.length} {period === "monthly" ? "months" : period === "quarterly" ? "quarters" : "years"}</th>
                {periods.map((row) => <th key={row.key} className="min-w-[4.75rem] border-b border-border/10 px-2 py-2 text-right font-medium text-muted-foreground">{row.label}</th>)}
              </tr>
            </thead>
            <tbody>
              <DataRow label="Paying Accounts" periods={periods} render={(row) => Math.round(row.activeAccounts).toLocaleString()} emphasize />
              <DataRow label="New Accounts" periods={periods} render={(row) => row.newAccounts >= 0.05 ? `+${trimNum(row.newAccounts)}` : "—"} />
              <DataRow label="Churned Accounts" periods={periods} render={(row) => row.churnedAccounts >= 0.05 ? `-${trimNum(row.churnedAccounts)}` : "—"} tone={() => "text-muted-foreground"} />
              <DataRow label="Users" periods={periods} render={(row) => Math.round(row.activeUsers).toLocaleString()} emphasize />
              <DataRow label="New Users" periods={periods} render={(row) => row.newUsers >= 0.05 ? `+${trimNum(row.newUsers)}` : "—"} />
              <DataRow label="Net Revenue Retention" periods={periods} render={(row) => row.startingCohortRevenue > 0 ? fmtPercent(row.cohortNrr) : "—"} emphasize />
              <DataRow label="Revenue" periods={periods} render={(row) => fmtCurrency(row.totalCashRevenue)} onToggle={() => setRevenueOpen((open) => !open)} open={revenueOpen} />
              {revenueOpen && <DataRow label="Starting Cohort" indent periods={periods} render={(row) => fmtCurrency(row.startingCohortRevenue)} />}
              {revenueOpen && <DataRow label="Churn / Downgrades" indent periods={periods} render={(row) => row.churnedRevenue > 0 ? fmtCurrency(-row.churnedRevenue) : "—"} tone={() => "text-muted-foreground"} />}
              {revenueOpen && <DataRow label="Added Users" indent periods={periods} render={(row) => row.userExpansionRevenue > 0 ? `+${fmtCurrency(row.userExpansionRevenue)}` : "—"} />}
              {revenueOpen && <DataRow label="Upgrades" indent periods={periods} render={(row) => row.tierExpansionRevenue > 0 ? `+${fmtCurrency(row.tierExpansionRevenue)}` : "—"} />}
              <DataRow label="COGS" periods={periods} render={(row) => fmtCurrency(-row.cogs)} tone={() => "text-muted-foreground"} />
              <DataRow label="Gross Profit" periods={periods} render={(row) => fmtCurrency(row.grossProfit)} tone={(row) => row.grossProfit < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="OpEx" periods={periods} render={(row) => fmtCurrency(-row.totalOpex)} onToggle={() => setOpexOpen((open) => !open)} open={opexOpen} />
              {opexOpen && <DataRow label="Staff" indent periods={periods} render={(row) => fmtCurrency(-row.staffOpex)} tone={() => "text-muted-foreground"} />}
              {opexOpen && <DataRow label="Marketing / S&M" indent periods={periods} render={(row) => fmtCurrency(-row.marketingOpex)} tone={() => "text-muted-foreground"} />}
              {opexOpen && <DataRow label="G&A" indent periods={periods} render={(row) => fmtCurrency(-row.gaOpex)} tone={() => "text-muted-foreground"} />}
              <DataRow label="Operating Income" periods={periods} render={(row) => fmtCurrency(row.operatingIncome)} tone={(row) => row.operatingIncome < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Net Cash Flow" periods={periods} render={(row) => fmtCurrency(row.netCashChange)} tone={(row) => row.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Cash Balance" periods={periods} render={(row) => fmtCurrency(row.endingCash)} tone={(row) => row.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
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
  indent?: boolean;
  onToggle?: () => void;
  open?: boolean;
}

function DataRow({ label, periods, render, tone, emphasize, indent, onToggle, open }: DataRowProps) {
  return (
    <tr className="border-t border-border/10">
      <td className={cn("sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left text-muted-foreground", emphasize && "font-medium text-foreground", indent && "pl-6 text-muted-foreground/80")}>
        {onToggle ? <button type="button" onClick={onToggle} className="flex min-h-8 items-center gap-1 text-left hover:text-foreground"><ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />{label}</button> : label}
      </td>
      {periods.map((row) => <td key={row.key} className={cn("px-2 py-1.5 text-right text-foreground", indent && "text-muted-foreground/80", tone?.(row))}>{render(row)}</td>)}
    </tr>
  );
}
