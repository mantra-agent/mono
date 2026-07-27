import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CheckCircle2, ChevronDown, Loader2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  FINANCING_KEYS,
  FINANCING_LABELS,
  PHASE_KEYS,
  PHASE_LABELS,
  computeProjection,
  type Assumptions,
  type FinancialModel,
  type FinancingEvent,
  type FinancingKey,
  type OperatingCostEntry,
  type PhaseAssumption,
  type PhaseKey,
} from "@shared/models/business-model";

type Month = ReturnType<typeof computeProjection>["months"][number];
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

function trimNum(value: number, digits = 1): string {
  return Number(value.toFixed(digits)).toLocaleString();
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

function fmtMonths(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} mo` : "∞";
}

const PHASE_COLOR: Record<PhaseKey, { band: string; text: string; dot: string }> = {
  phase_0: { band: "bg-[hsl(var(--chart-5)/0.12)]", text: "text-[hsl(var(--chart-5))]", dot: "bg-[hsl(var(--chart-5))]" },
  phase_1: { band: "bg-[hsl(var(--chart-2)/0.12)]", text: "text-[hsl(var(--chart-2))]", dot: "bg-[hsl(var(--chart-2))]" },
  phase_2: { band: "bg-[hsl(var(--chart-1)/0.12)]", text: "text-[hsl(var(--chart-1))]", dot: "bg-[hsl(var(--chart-1))]" },
  phase_3: { band: "bg-[hsl(var(--chart-3)/0.12)]", text: "text-[hsl(var(--chart-3))]", dot: "bg-[hsl(var(--chart-3))]" },
};

const FINANCING_PHASE: Record<FinancingKey, PhaseKey> = {
  pre_seed: "phase_1",
  seed: "phase_2",
  series_a: "phase_3",
  series_b: "phase_3",
};

interface NumericInputProps {
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
  ariaLabel?: string;
}

function NumericInput({ value, onChange, prefix, suffix, min, step, ariaLabel }: NumericInputProps) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
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
        className="min-w-0 flex-1 bg-transparent py-1.5 text-sm tabular-nums outline-none"
      />
      {suffix && <span className="whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
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
    return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Saving…</span>;
  }
  if (state === "saved") {
    return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="h-3 w-3 text-success" />Saved</span>;
  }
  if (state === "error") return <span className="text-xs text-destructive">Save failed</span>;
  return null;
}

function SectionHeader({ title, saveState, action }: { title: string; saveState?: SaveState; action?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-b border-border/20 px-4 py-3">
      <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="flex items-center gap-3">{action}<SavedIndicator state={saveState ?? "idle"} /></div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm tabular-nums text-foreground", tone)}>{value}</span>
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group border-t border-border/20 first:border-t-0">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border/10 p-4">{children}</div>
    </details>
  );
}

export default function BusinessModelPage() {
  usePageHeader({ title: "Business Model" });
  const { toast } = useToast();
  const { data, isLoading, isFetching, error, refetch } = useQuery<FinancialModel>({ queryKey: ["/api/business/model"] });
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showSpreadsheetDetail, setShowSpreadsheetDetail] = useState(false);
  const loadedIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const updatePhase = useCallback((key: PhaseKey, patch: Partial<PhaseAssumption>) => update((current) => ({ ...current, phases: current.phases.map((phase) => phase.key === key ? { ...phase, ...patch } : phase) })), [update]);
  const updateFinancing = useCallback((key: FinancingKey, patch: Partial<FinancingEvent>) => update((current) => ({ ...current, financingEvents: current.financingEvents.map((event) => event.key === key ? { ...event, ...patch } : event) })), [update]);
  const updateCost = useCallback((id: string, patch: Partial<OperatingCostEntry>) => update((current) => ({ ...current, operatingCosts: current.operatingCosts.map((cost) => cost.id === id ? { ...cost, ...patch } : cost) })), [update]);
  const updateCashLane = useCallback((month: number, patch: Partial<Assumptions["monthlyCashLanes"][number]>) => update((current) => ({ ...current, monthlyCashLanes: current.monthlyCashLanes.map((lane) => lane.month === month ? { ...lane, ...patch } : lane) })), [update]);

  const projection = useMemo(() => draft ? computeProjection(draft) : null, [draft]);

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

  const phaseOne = draft.phases.find((phase) => phase.key === "phase_1")!;
  const gateMonth = projection.months[Math.min(phaseOne.endMonth, projection.months.length) - 1];
  const financingMonths = new Set(draft.financingEvents.map((event) => event.month));

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <section className="overflow-hidden rounded-md border border-border/20">
        <SectionHeader title="Assumptions" saveState={saveState} />
        <div className="border-b border-border/20 p-4">
          <div className="mb-3 text-sm font-medium text-foreground">Global</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Field label="Horizon (months)"><NumericInput value={draft.horizonMonths} min={1} step={1} onChange={(horizonMonths) => updateGlobal({ horizonMonths })} /></Field>
            <Field label="Start month"><div className="flex items-center rounded-md border border-border/40 bg-background px-2"><input type="month" value={draft.startCalendarMonth} onChange={(event) => updateGlobal({ startCalendarMonth: event.target.value })} className="w-full bg-transparent py-1.5 text-sm outline-none" /></div></Field>
            <Field label="Opening cash"><NumericInput value={draft.openingCash} min={0} step={1000} prefix="$" onChange={(openingCash) => updateGlobal({ openingCash })} /></Field>
            <Field label="Starting accounts"><NumericInput value={draft.startingAccounts} min={0} step={1} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} /></Field>
            <Field label="Max subscription (mo)"><NumericInput value={draft.maxSubscriptionMonthly} min={0} step={50} prefix="$" onChange={(maxSubscriptionMonthly) => updateGlobal({ maxSubscriptionMonthly })} /></Field>
          </div>
        </div>
        <div className="p-4">
          <div className="mb-3 text-sm font-medium text-foreground">Growth</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Field label="Q1 new accounts"><NumericInput value={draft.quarterOneNewAccounts} min={0} step={1} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} /></Field>
            <Field label="New accounts (× / 90 days)"><NumericInput value={draft.accountExpansion90d} min={0} step={0.1} suffix="×" onChange={(accountExpansion90d) => updateGlobal({ accountExpansion90d })} /></Field>
            <Field label="Annual NRR"><NumericInput value={draft.annualNrrPct} min={0} step={5} suffix="%" onChange={(annualNrrPct) => updateGlobal({ annualNrrPct })} /></Field>
            <Field label="Annual logo retention"><NumericInput value={draft.annualGrossLogoRetentionPct} min={0} step={1} suffix="%" onChange={(annualGrossLogoRetentionPct) => updateGlobal({ annualGrossLogoRetentionPct })} /></Field>
            <Field label="Reserve at next gate"><NumericInput value={draft.reserveAtNextGate} min={0} step={10_000} prefix="$" onChange={(reserveAtNextGate) => updateGlobal({ reserveAtNextGate })} /></Field>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-md border border-border/20">
        <SectionHeader title="Money in now → value later" action={<TrendingUp className="h-4 w-4 text-muted-foreground" />} />
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {FINANCING_KEYS.map((key) => {
            const event = draft.financingEvents.find((item) => item.key === key)!;
            const summary = projection.financing.find((item) => item.key === key)!;
            const color = PHASE_COLOR[FINANCING_PHASE[key]];
            return (
              <div key={key} className="overflow-hidden rounded-md border border-border/30 bg-card">
                <div className={cn("flex items-center justify-between gap-3 border-b border-border/20 px-3 py-2", color.band)}>
                  <div className="flex min-w-0 items-center gap-2"><span className={cn("h-2 w-2 shrink-0 rounded-full", color.dot)} /><span className={cn("truncate text-sm font-semibold", color.text)}>{FINANCING_LABELS[key]}</span></div>
                  <span className="text-xs text-muted-foreground">Month {event.month}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 p-3">
                  <Field label="Round month"><NumericInput value={event.month} min={1} step={1} ariaLabel={`${FINANCING_LABELS[key]} round month`} onChange={(month) => updateFinancing(key, { month })} /></Field>
                  <Field label="Investment"><NumericInput value={event.amount} min={0} step={100_000} prefix="$" ariaLabel={`${FINANCING_LABELS[key]} investment`} onChange={(amount) => updateFinancing(key, { amount })} /></Field>
                  <Field label={event.instrument === "post_money_safe" ? "Post-money cap" : "Pre-money valuation"}><NumericInput value={event.valuation} min={0} step={500_000} prefix="$" ariaLabel={`${FINANCING_LABELS[key]} valuation`} onChange={(valuation) => updateFinancing(key, { valuation })} /></Field>
                  <Field label="Option pool top-up"><NumericInput value={event.optionPoolTopUpPct} min={0} step={1} suffix="%" ariaLabel={`${FINANCING_LABELS[key]} option pool top-up`} onChange={(optionPoolTopUpPct) => updateFinancing(key, { optionPoolTopUpPct })} /></Field>
                </div>
                <div className="space-y-1.5 border-t border-border/20 p-3">
                  <Row label="New ownership" value={fmtPercent(summary.newInvestorOwnership)} />
                  <Row label="Pre-Seed stake" value={`${fmtPercent(summary.preSeedOwnership)} · ${fmtCurrency(summary.preSeedPaperValue)}`} />
                  <Row label="Pre-Seed return" value={`${summary.preSeedReturnMultiple.toFixed(1)}×`} tone="font-semibold" />
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid border-t border-border/20 md:grid-cols-4">
          <SummaryCell label="Raise required" value={fmtCurrency(projection.financingNeed.raiseRequired)} />
          <SummaryCell label="Product ARR at gate" value={fmtCurrency(gateMonth?.productArr ?? 0)} />
          <SummaryCell label="Cash at gate" value={fmtCurrency(gateMonth?.endingCash ?? 0)} />
          <SummaryCell label="Fundraise next" value={`Month ${projection.financingNeed.nextFundraiseStartMonth}`} />
        </div>
      </section>

      <section className="overflow-hidden rounded-md border border-border/20">
        <SectionHeader
          title={`Monthly projection (${projection.months.length} months)`}
          saveState={saveState}
          action={<button type="button" onClick={() => setShowSpreadsheetDetail((current) => !current)} className="min-h-11 px-2 text-xs font-medium text-cta hover:text-active">{showSpreadsheetDetail ? "Hide detail" : "Show detail"}</button>}
        />
        <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead><tr><th className="sticky left-0 z-20 min-w-[9rem] border-b border-r border-border/20 bg-background px-3 py-2 text-left font-medium text-muted-foreground">Month</th>{projection.months.map((month) => <th key={month.month} className={cn("min-w-[4.5rem] border-b border-border/10 px-2 py-2 text-right font-medium text-muted-foreground", financingMonths.has(month.month) && "bg-muted/40 text-foreground")}>{month.label}</th>)}</tr></thead>
            <tbody>
              <tr><td className="sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left font-medium text-muted-foreground">Phase</td>{projection.months.map((month, index) => { const color = PHASE_COLOR[month.phaseKey]; const isStart = index === 0 || projection.months[index - 1].phaseKey !== month.phaseKey; return <td key={month.month} className={cn("px-2 py-1.5 text-right", color.band, color.text)}>{isStart ? <span className="font-medium">{month.phaseLabel}</span> : ""}</td>; })}</tr>
              <DataRow label="Active Accounts" months={projection.months} financingMonths={financingMonths} render={(month) => trimNum(month.activeAccounts)} />
              <DataRow label="New Accounts" months={projection.months} financingMonths={financingMonths} render={(month) => month.newAccounts >= 0.05 ? `+${trimNum(month.newAccounts)}` : "—"} />
              <DataRow label="Product Revenue" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.productRevenue)} />
              <DataRow label="Blended ARPA" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.activeAccounts > 0 ? month.productRevenue / month.activeAccounts : 0)} />
              <DataRow label="Expenses" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.productCogs + month.consultingCogs + month.acquisitionSpend + month.operatingExpense + month.capex)} />
              <DataRow label="Net Cash Flow" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.netCashChange)} tone={(month) => month.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Investment In" months={projection.months} financingMonths={financingMonths} render={(month) => month.financingCash > 0 ? fmtCurrency(month.financingCash) : "—"} />
              <DataRow label="Cash Balance" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.endingCash)} tone={(month) => month.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
              {showSpreadsheetDetail && (
                <>
                  <DataRow label="Subscription MRR" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.subscriptionRevenue)} />
                  <DataRow label="Overage MRR" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.overageRevenue)} />
                  <DataRow label="Product ARR" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.productArr)} emphasize />
                  <EditableDataRow label="Consulting Revenue" months={projection.months} value={(month) => month.consultingRevenue} onChange={(month, consultingRevenue) => updateCashLane(month, { consultingRevenue })} />
                  <DataRow label="Product COGS" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.productCogs)} />
                  <EditableDataRow label="Consulting COGS" months={projection.months} value={(month) => month.consultingCogs} onChange={(month, consultingCogs) => updateCashLane(month, { consultingCogs })} />
                  <DataRow label="Product GM" months={projection.months} financingMonths={financingMonths} render={(month) => fmtPercent(month.productGrossMargin)} tone={(month) => month.productGrossMargin < 0.8 ? "text-warning" : "text-foreground"} />
                  <DataRow label="Acquisition Spend" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.acquisitionSpend)} />
                  <DataRow label="Headcount" months={projection.months} financingMonths={financingMonths} render={(month) => trimNum(month.headcount)} />
                  <DataRow label="Operating Expense" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.operatingExpense)} />
                  <EditableDataRow label="Capex" months={projection.months} value={(month) => month.capex} onChange={(month, capex) => updateCashLane(month, { capex })} />
                  <DataRow label="Runway" months={projection.months} financingMonths={financingMonths} render={(month) => fmtMonths(month.runwayMonths)} />
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-md border border-border/20">
        <SectionHeader title="Model details" saveState={saveState} />
        <Disclosure title="Max and unit economics">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Field label="Included tokens"><NumericInput value={draft.maxIncludedTokensMillions} min={0} step={1} suffix="M / mo" onChange={(maxIncludedTokensMillions) => updateGlobal({ maxIncludedTokensMillions })} /></Field>
            <Field label="Token cost"><NumericInput value={draft.blendedTokenCostPerMillion} min={0} step={0.25} prefix="$" suffix="/ 1M" onChange={(blendedTokenCostPerMillion) => updateGlobal({ blendedTokenCostPerMillion })} /></Field>
            <Field label="Overage markup"><NumericInput value={draft.overageMarkupPct} min={0} step={25} suffix="%" onChange={(overageMarkupPct) => updateGlobal({ overageMarkupPct })} /></Field>
            <Field label="Infrastructure / account"><NumericInput value={draft.infrastructurePerActiveAccount} min={0} step={5} prefix="$" onChange={(infrastructurePerActiveAccount) => updateGlobal({ infrastructurePerActiveAccount })} /></Field>
            <Field label="Support / account"><NumericInput value={draft.supportPerActiveAccount} min={0} step={5} prefix="$" onChange={(supportPerActiveAccount) => updateGlobal({ supportPerActiveAccount })} /></Field>
            <Field label="Payment processing"><NumericInput value={draft.paymentProcessingPct} min={0} step={0.5} suffix="%" onChange={(paymentProcessingPct) => updateGlobal({ paymentProcessingPct })} /></Field>
          </div>
          <div className="mt-4 grid gap-3 border-t border-border/20 pt-3 md:grid-cols-4">
            <Row label="Subscription MRR at gate" value={fmtCurrency(gateMonth?.subscriptionRevenue ?? 0)} />
            <Row label="Overage MRR at gate" value={fmtCurrency(gateMonth?.overageRevenue ?? 0)} />
            <Row label="Overage gross margin" value={fmtPercent(gateMonth?.overageGrossMargin ?? 0)} />
            <Row label="Product gross margin" value={fmtPercent(gateMonth?.productGrossMargin ?? 0)} />
          </div>
        </Disclosure>
        <Disclosure title="Acquisition and operating costs">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Field label="PLG share"><NumericInput value={draft.plgSharePct} min={0} step={5} suffix="%" onChange={(plgSharePct) => updateGlobal({ plgSharePct })} /></Field>
            <Field label="PLG CAC"><NumericInput value={draft.plgCac} min={0} step={50} prefix="$" onChange={(plgCac) => updateGlobal({ plgCac })} /></Field>
            <Field label="Top-down CAC"><NumericInput value={draft.topDownCac} min={0} step={100} prefix="$" onChange={(topDownCac) => updateGlobal({ topDownCac })} /></Field>
            <Field label="Onboarding / account"><NumericInput value={draft.onboardingCostPerNewAccount} min={0} step={50} prefix="$" onChange={(onboardingCostPerNewAccount) => updateGlobal({ onboardingCostPerNewAccount })} /></Field>
            <Row label="Blended CAC" value={fmtCurrency(gateMonth?.blendedCac ?? 0)} />
            <Row label="Entry payback" value={fmtMonths(projection.baselineCacPaybackMonths)} />
          </div>
          <div className="mt-4 overflow-x-auto rounded-md border border-border/20">
            <table className="w-full min-w-[700px] text-sm"><thead><tr className="border-b border-border/20 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Cost</th><th className="px-3 py-2 font-medium">Class</th><th className="px-3 py-2 font-medium">Start</th><th className="px-3 py-2 font-medium">End</th><th className="px-3 py-2 font-medium">Headcount</th><th className="px-3 py-2 font-medium">Monthly</th></tr></thead><tbody>{draft.operatingCosts.map((cost) => <tr key={cost.id} className="border-t border-border/10"><td className="px-3 py-2 text-foreground">{cost.label}</td><td className="px-3 py-2 text-muted-foreground">{cost.classification === "product_cogs" ? "Product COGS" : "Opex"}</td><td className="w-24 px-2 py-1"><NumericInput value={cost.startMonth} min={1} step={1} ariaLabel={`${cost.label} start month`} onChange={(startMonth) => updateCost(cost.id, { startMonth })} /></td><td className="w-24 px-2 py-1"><NumericInput value={cost.endMonth} min={1} step={1} ariaLabel={`${cost.label} end month`} onChange={(endMonth) => updateCost(cost.id, { endMonth })} /></td><td className="w-28 px-2 py-1"><NumericInput value={cost.headcount} min={0} step={1} ariaLabel={`${cost.label} headcount`} onChange={(headcount) => updateCost(cost.id, { headcount })} /></td><td className="w-40 px-2 py-1"><NumericInput value={cost.monthlyAmount} min={0} step={1000} prefix="$" ariaLabel={`${cost.label} monthly cost`} onChange={(monthlyAmount) => updateCost(cost.id, { monthlyAmount })} /></td></tr>)}</tbody></table>
          </div>
        </Disclosure>
        <Disclosure title="Phase gates">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {PHASE_KEYS.map((key) => {
              const phase = draft.phases.find((item) => item.key === key)!;
              const gate = projection.gates.find((item) => item.phaseKey === key)!;
              const color = PHASE_COLOR[key];
              return (
                <div key={key} className="overflow-hidden rounded-md border border-border/30 bg-card">
                  <div className={cn("flex items-center justify-between gap-3 border-b border-border/20 px-3 py-2", color.band)}><span className={cn("truncate text-sm font-semibold", color.text)}>{PHASE_LABELS[key]}</span>{gate.status === "achieved" ? <CheckCircle2 className="h-4 w-4 text-success" /> : <span className="text-xs text-muted-foreground">Month {phase.endMonth}</span>}</div>
                  <div className="space-y-3 p-3">
                    <Row label="Funded by" value={phase.fundedBy} />
                    <Field label="Gate month"><NumericInput value={phase.endMonth} min={0} step={1} onChange={(endMonth) => updatePhase(key, { endMonth })} /></Field>
                    <Field label="ARR floor"><NumericInput value={phase.productArrMin} min={0} step={100_000} prefix="$" onChange={(productArrMin) => updatePhase(key, { productArrMin })} /></Field>
                    <div className="grid grid-cols-2 gap-3"><Field label="NRR floor"><NumericInput value={phase.annualNrrMinPct} min={0} step={5} suffix="%" onChange={(annualNrrMinPct) => updatePhase(key, { annualNrrMinPct })} /></Field><Field label="GLR floor"><NumericInput value={phase.annualGlrMinPct} min={0} step={5} suffix="%" onChange={(annualGlrMinPct) => updatePhase(key, { annualGlrMinPct })} /></Field></div>
                  </div>
                </div>
              );
            })}
          </div>
        </Disclosure>
        <Disclosure title="Cash policy">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Round increment"><NumericInput value={draft.roundIncrement} min={1} step={10_000} prefix="$" onChange={(roundIncrement) => updateGlobal({ roundIncrement })} /></Field>
            <Field label="Fundraising lead"><NumericInput value={draft.fundraisingLeadMonths} min={0} step={1} suffix="months" onChange={(fundraisingLeadMonths) => updateGlobal({ fundraisingLeadMonths })} /></Field>
            <Field label="Trailing burn window"><NumericInput value={draft.trailingBurnMonths} min={1} step={1} suffix="months" onChange={(trailingBurnMonths) => updateGlobal({ trailingBurnMonths })} /></Field>
            <Row label="Cash without raise at gate" value={fmtCurrency(projection.financingNeed.cashAtGateWithoutRaise)} />
          </div>
        </Disclosure>
      </section>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return <div className="border-t border-border/20 p-4 first:border-t-0 md:border-l md:border-t-0 md:first:border-l-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div></div>;
}

function DataRow({ label, months, financingMonths, render, tone, emphasize }: { label: string; months: Month[]; financingMonths: Set<number>; render: (month: Month) => string; tone?: (month: Month) => string; emphasize?: boolean }) {
  return <tr className="border-t border-border/10"><td className={cn("sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left text-muted-foreground", emphasize && "font-medium text-foreground")}>{label}</td>{months.map((month) => <td key={month.month} className={cn("px-2 py-1.5 text-right text-foreground", financingMonths.has(month.month) && "bg-muted/20", tone?.(month))}>{render(month)}</td>)}</tr>;
}

function EditableDataRow({ label, months, value, onChange }: { label: string; months: Month[]; value: (month: Month) => number; onChange: (month: number, value: number) => void }) {
  return <tr className="border-t border-border/10"><td className="sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left text-muted-foreground">{label}</td>{months.map((month) => <td key={month.month} className="px-1 py-1"><input aria-label={`${label} ${month.label}`} type="number" min={0} step={1000} value={value(month)} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(month.month, next); }} className="min-h-9 w-[4.5rem] rounded border border-border/30 bg-muted/20 px-1 text-right text-xs tabular-nums outline-none focus:ring-1 focus:ring-ring" /></td>)}</tr>;
}
