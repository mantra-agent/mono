import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Banknote,
  Briefcase,
  Calendar,
  Check,
  ChevronRight,
  Clock3,
  DollarSign,
  Gauge,
  Loader2,
  Percent,
  Plus,
  Repeat2,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  FINANCING_KEYS,
  FINANCING_LABELS,
  aggregateMonths,
  computeProjection,
  type Assumptions,
  type FinancialModel,
  type FinancingEvent,
  type FinancingKey,
  type PeriodMode,
  type PeriodRow,
  type PhaseKey,
  type StageKeyHire,
} from "@shared/models/business-model";
import type { JobRole } from "@shared/models/job-roles";

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

const PERIOD_MODES: { key: PeriodMode; label: string }[] = [
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annually", label: "Annually" },
];

/** Each institutional round is funded by exactly one phase's operating plan. */
const STAGE_PHASE: Record<FinancingKey, PhaseKey> = {
  seed: "phase_1",
  series_a: "phase_2",
  series_b: "phase_3",
};

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

function fmtMultiple(value: number): string {
  return `${value.toFixed(1)}×`;
}

const STAGE_COLOR: Record<FinancingKey, { band: string; text: string; dot: string }> = {
  seed: { band: "bg-[hsl(var(--chart-1)/0.15)]", text: "text-[hsl(var(--chart-1))]", dot: "bg-[hsl(var(--chart-1))]" },
  series_a: { band: "bg-[hsl(var(--chart-3)/0.15)]", text: "text-[hsl(var(--chart-3))]", dot: "bg-[hsl(var(--chart-3))]" },
  series_b: { band: "bg-[hsl(var(--chart-4)/0.15)]", text: "text-[hsl(var(--chart-4))]", dot: "bg-[hsl(var(--chart-4))]" },
};

interface NumericInputProps {
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
  ariaLabel?: string;
  compact?: boolean;
}

function NumericInput({ value, onChange, prefix, suffix, min, step, ariaLabel, compact = false }: NumericInputProps) {
  return (
    <div
      className={cn(
        "relative flex items-center rounded-md focus-within:ring-1 focus-within:ring-ring",
        compact ? "h-5 w-48 max-w-full bg-muted/50" : "gap-1 border border-border/40 bg-background px-2",
      )}
    >
      {prefix && (
        <span className={cn("pointer-events-none text-xs text-muted-foreground", compact && "absolute left-1.5 z-10")}>{prefix}</span>
      )}
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
        className={cn(
          "w-full min-w-0 bg-transparent py-1.5 text-sm tabular-nums outline-none",
          compact && "!h-5 !w-full !bg-transparent !py-0 !text-right !text-xs !leading-none",
          compact && prefix && "!pl-5",
          compact && suffix && (suffix.length > 4 ? "!pr-16" : suffix.length > 2 ? "!pr-10" : "!pr-5"),
        )}
      />
      {suffix && (
        <span className={cn("pointer-events-none whitespace-nowrap text-xs text-muted-foreground", compact && "absolute right-1.5 z-10")}>{suffix}</span>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SavedIndicator({ state }: { state: SaveState }) {
  if (state === "saving" || state === "pending") {
    return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</span>;
  }
  if (state === "saved") {
    return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="h-3 w-3 text-success" /> Saved</span>;
  }
  if (state === "error") return <span className="text-xs text-destructive">Save failed</span>;
  return null;
}

export default function BusinessModelPage() {
  usePageHeader({ title: "Business Model" });
  const { toast } = useToast();
  const { data, isLoading, isFetching, error, refetch } = useQuery<FinancialModel>({ queryKey: ["/api/business/model"] });
  const { data: rolesData } = useQuery<{ roles: JobRole[] }>({ queryKey: ["/api/business/roles"] });
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [period, setPeriod] = useState<PeriodMode>("monthly");
  const [opexOpen, setOpexOpen] = useState(false);
  const loadedIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const roles = useMemo(() => rolesData?.roles ?? [], [rolesData]);
  const roleMap = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);

  useEffect(() => {
    if (data && loadedIdRef.current !== data.id) {
      loadedIdRef.current = data.id;
      setDraft(data.assumptions);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async (assumptions: Assumptions) => (await apiRequest("PATCH", "/api/business/model", assumptions)).json() as Promise<FinancialModel>,
    onMutate: () => setSaveState("saving"),
    onSuccess: (model) => {
      queryClient.setQueryData(["/api/business/model"], model);
      setSaveState("saved");
    },
    onError: (saveError: Error) => {
      setSaveState("error");
      toast({ title: "Failed to save model", description: saveError.message, variant: "destructive" });
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

  const update = useCallback((producer: (current: Assumptions) => Assumptions) => {
    setDraft((current) => {
      if (!current) return current;
      const next = producer(current);
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const updateGlobal = useCallback((patch: Partial<Assumptions>) => update((current) => ({ ...current, ...patch })), [update]);
  const updateFinancing = useCallback((key: FinancingKey, patch: Partial<FinancingEvent>) => update((current) => ({
    ...current,
    financingEvents: current.financingEvents.map((event) => event.key === key ? { ...event, ...patch } : event),
  })), [update]);
  const updateHires = useCallback((phaseKey: PhaseKey, hires: StageKeyHire[]) => update((current) => ({
    ...current,
    phases: current.phases.map((phase) => phase.key === phaseKey ? { ...phase, keyHires: hires } : phase),
  })), [update]);

  const projection = useMemo(() => draft ? computeProjection(draft, roles) : null, [draft, roles]);
  const periods = useMemo(() => projection ? aggregateMonths(projection.months, period) : [], [projection, period]);

  if (error) {
    return (
      <div className="w-full p-4">
        <div className="rounded-md border border-destructive/30 p-4">
          <p className="text-sm font-medium text-foreground">Financial model unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">{(error as Error).message}</p>
          <Button type="button" variant="outline" size="sm" className="mt-4" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !draft || !projection) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Assumptions</h2>
          <SavedIndicator state={saveState} />
        </div>

        <div className="border-b border-border/20 p-4">
          <AssumptionGroup label="Global">
            <ProfileTreeRow label="Horizon" icon={<Clock3 className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-horizon">
              <NumericInput compact ariaLabel="Horizon in months" value={draft.horizonMonths} min={1} step={1} suffix="months" onChange={(horizonMonths) => updateGlobal({ horizonMonths })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Start month" icon={<Calendar className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-start-month">
              <input
                aria-label="Start month"
                type="month"
                value={draft.startCalendarMonth}
                onChange={(event) => updateGlobal({ startCalendarMonth: event.target.value })}
                className="w-48 max-w-full rounded-md border-0 bg-muted/50 px-1.5 text-right text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </ProfileTreeRow>
            <ProfileTreeRow label="Starting cash" icon={<Banknote className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-starting-cash">
              <NumericInput compact ariaLabel="Starting cash" value={draft.openingCash} min={0} step={1000} prefix="$" onChange={(openingCash) => updateGlobal({ openingCash })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Starting accounts" icon={<Users className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-starting-accounts">
              <NumericInput compact ariaLabel="Starting accounts" value={draft.startingAccounts} min={0} step={1} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Base subscription" icon={<DollarSign className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-base-subscription">
              <NumericInput compact ariaLabel="Base monthly subscription per account" value={draft.maxSubscriptionMonthly} min={0} step={50} prefix="$" suffix="/ mo" onChange={(maxSubscriptionMonthly) => updateGlobal({ maxSubscriptionMonthly })} />
            </ProfileTreeRow>
            <ProfileTreeRow
              label="Loaded cost"
              icon={<Gauge className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="row-assumption-loaded-cost"
              expandedContent="Applied to base salary midpoint plus bonus for every Key Hire. Set to 1.0× for raw compensation."
            >
              <NumericInput compact ariaLabel="Loaded cost multiplier" value={draft.loadedCostMultiplier} min={0.5} step={0.05} suffix="×" onChange={(loadedCostMultiplier) => updateGlobal({ loadedCostMultiplier })} />
            </ProfileTreeRow>
          </AssumptionGroup>
        </div>

        <div className="border-b border-border/20 p-4">
          <AssumptionGroup label="Growth">
            <ProfileTreeRow label="Q1 new accounts" icon={<Users className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-q1-accounts">
              <NumericInput compact ariaLabel="Q1 new accounts" value={draft.quarterOneNewAccounts} min={0} step={1} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Account expansion" icon={<TrendingUp className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-account-expansion">
              <NumericInput compact ariaLabel="New account expansion every 90 days" value={draft.accountExpansion90d} min={0} step={0.1} suffix="× / 90d" onChange={(accountExpansion90d) => updateGlobal({ accountExpansion90d })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Annual NRR" icon={<Repeat2 className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-nrr">
              <NumericInput compact ariaLabel="Annual net revenue retention" value={draft.annualNrrPct} min={0} step={5} suffix="%" onChange={(annualNrrPct) => updateGlobal({ annualNrrPct })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Logo retention" icon={<Percent className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-logo-retention">
              <NumericInput compact ariaLabel="Annual gross logo retention" value={draft.annualGrossLogoRetentionPct} min={0} step={1} suffix="%" onChange={(annualGrossLogoRetentionPct) => updateGlobal({ annualGrossLogoRetentionPct })} />
            </ProfileTreeRow>
            <ProfileTreeRow label="Gate reserve" icon={<Banknote className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-assumption-gate-reserve">
              <NumericInput compact ariaLabel="Reserve at next gate" value={draft.reserveAtNextGate} min={0} step={10_000} prefix="$" onChange={(reserveAtNextGate) => updateGlobal({ reserveAtNextGate })} />
            </ProfileTreeRow>
          </AssumptionGroup>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {FINANCING_KEYS.map((key) => {
            const event = draft.financingEvents.find((item) => item.key === key)!;
            const summary = projection.financing.find((item) => item.key === key)!;
            const phaseKey = STAGE_PHASE[key];
            const phase = draft.phases.find((item) => item.key === phaseKey);
            const color = STAGE_COLOR[key];
            return (
              <div key={key} className="overflow-hidden rounded-md border border-border/30">
                <div className={cn("flex items-center gap-2 border-b border-border/20 px-3 py-2", color.band)}>
                  <span className={cn("h-2 w-2 rounded-full", color.dot)} />
                  <span className={cn("text-sm font-semibold", color.text)}>{FINANCING_LABELS[key]}</span>
                </div>
                <div className="space-y-3 p-3">
                  <Field label="Round month"><NumericInput value={event.month} min={1} step={1} ariaLabel={`${FINANCING_LABELS[key]} round month`} onChange={(month) => updateFinancing(key, { month })} /></Field>
                  <Field label="Investment"><NumericInput value={event.amount} min={0} step={100_000} prefix="$" ariaLabel={`${FINANCING_LABELS[key]} investment`} onChange={(amount) => updateFinancing(key, { amount })} /></Field>
                  <Field label={event.instrument === "post_money_safe" ? "Post-money cap" : "Pre-money valuation"}><NumericInput value={event.valuation} min={0} step={500_000} prefix="$" ariaLabel={`${FINANCING_LABELS[key]} valuation`} onChange={(valuation) => updateFinancing(key, { valuation })} /></Field>
                  <Field label="Option pool top-up"><NumericInput value={event.optionPoolTopUpPct} min={0} step={1} suffix="%" ariaLabel={`${FINANCING_LABELS[key]} option pool top-up`} onChange={(optionPoolTopUpPct) => updateFinancing(key, { optionPoolTopUpPct })} /></Field>
                  <Row label="New investor ownership" value={fmtPercent(summary.newInvestorOwnership)} />
                  <Row label="Founding stake remaining" value={fmtPercent(summary.foundingOwnership)} />
                  {phase && (
                    <KeyHiresEditor
                      phaseKey={phase.key}
                      hires={phase.keyHires}
                      roles={roles}
                      roleMap={roleMap}
                      onChange={updateHires}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="flex items-center gap-2 border-b border-border/20 px-4 py-3">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Money in now → value later</h2>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {projection.financing.map((summary) => {
            const color = STAGE_COLOR[summary.key];
            return (
              <div key={summary.key} className="overflow-hidden rounded-md border border-border/30">
                <div className={cn("flex items-center justify-between border-b border-border/20 px-3 py-2", color.band)}>
                  <span className={cn("text-sm font-semibold", color.text)}>{summary.label}</span>
                  <span className="text-xs text-muted-foreground">Month {summary.month}</span>
                </div>
                <div className="space-y-1.5 p-3 text-sm">
                  <Row label="Investment" value={fmtCurrency(summary.investment)} />
                  <Row label={summary.instrument === "post_money_safe" ? "Post-money cap" : "Pre-money"} value={fmtCurrency(summary.valuation)} />
                  <Row label="Post-money" value={fmtCurrency(summary.postMoneyValuation)} />
                  <Row label="Founding stake" value={`${fmtPercent(summary.foundingOwnership)} · ${fmtCurrency(summary.foundingPaperValue)}`} />
                  <div className="mt-2 flex items-center justify-between border-t border-border/20 pt-2">
                    <span className="text-xs text-muted-foreground">Return on founding</span>
                    <span className={cn("text-base font-semibold", color.text)}>{fmtMultiple(summary.foundingReturnMultiple)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="flex items-center justify-between gap-3 border-b border-border/20 px-4 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Projection ({periods.length} {period === "monthly" ? "months" : period === "quarterly" ? "quarters" : "years"})</h2>
          <div className="flex items-center gap-1 rounded-md border border-border/40 p-0.5">
            {PERIOD_MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                onClick={() => setPeriod(mode.key)}
                className={cn(
                  "rounded px-2 py-1 text-xs font-medium transition-colors",
                  period === mode.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 min-w-[9.5rem] border-b border-r border-border/20 bg-background px-3 py-2 text-left font-medium text-muted-foreground">Period</th>
                {periods.map((row) => <th key={row.key} className={cn("min-w-[4.5rem] border-b border-border/10 px-2 py-2 text-right font-medium text-muted-foreground", row.financingCash > 0 && "bg-muted/40 text-foreground")}>{row.label}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left font-medium text-muted-foreground">Stage</td>
                {periods.map((row, index) => {
                  const color = STAGE_COLOR[row.financingKey];
                  const isStart = index === 0 || periods[index - 1].financingKey !== row.financingKey;
                  return <td key={row.key} className={cn("px-2 py-1.5 text-right", color.band, color.text)}>{isStart ? <span className="font-medium">{FINANCING_LABELS[row.financingKey]}</span> : ""}</td>;
                })}
              </tr>
              <DataRow label="Accounts" periods={periods} render={(row) => Math.round(row.activeAccounts).toLocaleString()} />
              <DataRow label="New Accounts" periods={periods} render={(row) => row.newAccounts >= 0.05 ? `+${trimNum(row.newAccounts)}` : "—"} />
              <DataRow label="Gross Revenue" periods={periods} render={(row) => fmtCurrency(row.totalCashRevenue)} />
              <DataRow label="COGS" periods={periods} render={(row) => fmtCurrency(-row.cogs)} tone={() => "text-muted-foreground"} />
              <DataRow label="Gross Profit" periods={periods} render={(row) => fmtCurrency(row.grossProfit)} tone={(row) => row.grossProfit < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow
                label="OpEx"
                periods={periods}
                render={(row) => fmtCurrency(-row.totalOpex)}
                onToggle={() => setOpexOpen((open) => !open)}
                open={opexOpen}
              />
              {opexOpen && <DataRow label="Staff" indent periods={periods} render={(row) => fmtCurrency(-row.staffOpex)} tone={() => "text-muted-foreground"} />}
              {opexOpen && <DataRow label="Marketing / S&M" indent periods={periods} render={(row) => fmtCurrency(-row.marketingOpex)} tone={() => "text-muted-foreground"} />}
              {opexOpen && <DataRow label="G&A" indent periods={periods} render={(row) => fmtCurrency(-row.gaOpex)} tone={() => "text-muted-foreground"} />}
              <DataRow label="Operating Income" periods={periods} render={(row) => fmtCurrency(row.operatingIncome)} tone={(row) => row.operatingIncome < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Net Cash Flow" periods={periods} render={(row) => fmtCurrency(row.netCashChange)} tone={(row) => row.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Investment In" periods={periods} render={(row) => row.financingCash > 0 ? fmtCurrency(row.financingCash) : "—"} />
              <DataRow label="Cash Balance" periods={periods} render={(row) => fmtCurrency(row.endingCash)} tone={(row) => row.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AssumptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 px-2 text-sm font-medium text-foreground">{label}</h3>
      <div className="overflow-hidden rounded-md border border-border/20">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{label}</span><span className="text-sm tabular-nums text-foreground">{value}</span></div>;
}

interface KeyHiresEditorProps {
  phaseKey: PhaseKey;
  hires: StageKeyHire[];
  roles: JobRole[];
  roleMap: Map<string, JobRole>;
  onChange: (phaseKey: PhaseKey, hires: StageKeyHire[]) => void;
}

function KeyHiresEditor({ phaseKey, hires, roles, roleMap, onChange }: KeyHiresEditorProps) {
  const taken = new Set(hires.map((hire) => hire.roleId));
  const available = roles.filter((role) => !taken.has(role.id));

  const addRole = (roleId: string) => {
    if (!roleId || taken.has(roleId)) return;
    onChange(phaseKey, [...hires, { roleId }]);
  };
  const removeRole = (roleId: string) => onChange(phaseKey, hires.filter((hire) => hire.roleId !== roleId));

  return (
    <div className="space-y-2 border-t border-border/20 pt-2">
      <span className="text-xs font-medium text-muted-foreground">Key hires</span>
      <div className="flex flex-wrap gap-1.5">
        {hires.length === 0 && <span className="text-xs text-muted-foreground/70">No hires yet</span>}
        {hires.map((hire) => {
          const role = roleMap.get(hire.roleId);
          return (
            <span key={hire.roleId} className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 text-xs text-foreground">
              <Briefcase className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[10rem] truncate">{role?.title ?? hire.roleId}</span>
              <button type="button" aria-label={`Remove ${role?.title ?? "hire"}`} className="text-muted-foreground hover:text-destructive" onClick={() => removeRole(hire.roleId)}>
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
      </div>
      {available.length > 0 && (
        <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background px-1.5">
          <Plus className="h-3 w-3 text-muted-foreground" />
          <select
            aria-label="Add key hire"
            value=""
            onChange={(event) => addRole(event.target.value)}
            className="w-full min-w-0 bg-transparent py-1 text-xs text-foreground outline-none"
          >
            <option value="">Add hire…</option>
            {available.map((role) => <option key={role.id} value={role.id}>{role.title}</option>)}
          </select>
        </div>
      )}
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
        {onToggle ? (
          <button type="button" onClick={onToggle} className="flex items-center gap-1 text-left hover:text-foreground">
            <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
            {label}
          </button>
        ) : label}
      </td>
      {periods.map((row) => <td key={row.key} className={cn("px-2 py-1.5 text-right text-foreground", row.financingCash > 0 && "bg-muted/20", indent && "text-muted-foreground/80", tone?.(row))}>{render(row)}</td>)}
    </tr>
  );
}
