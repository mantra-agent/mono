import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
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
    <div className="flex min-h-11 items-center gap-1 rounded-md border border-border bg-muted/30 px-2 focus-within:ring-1 focus-within:ring-ring">
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
        className="min-w-0 flex-1 bg-transparent py-2 text-sm tabular-nums outline-none"
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
  if (state === "saving" || state === "pending") return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving</span>;
  if (state === "saved") return <span className="flex items-center gap-1 text-xs text-success"><Check className="h-3.5 w-3.5" />Saved</span>;
  if (state === "error") return <span className="text-xs text-destructive">Save failed</span>;
  return null;
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warning" | "success" }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums text-foreground", tone === "warning" && "text-warning", tone === "success" && "text-success")}>{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 overflow-hidden rounded-md border border-card-border bg-card", className)}>{children}</div>;
}

function Section({ title, saveState, children, defaultOpen = false }: { title: string; saveState?: SaveState; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group min-w-0 overflow-hidden rounded-md border border-card-border bg-card" open={defaultOpen}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="flex items-center gap-3"><SavedIndicator state={saveState ?? "idle"} /><ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" /></div>
      </summary>
      <div className="border-t border-border/20 p-4">{children}</div>
    </details>
  );
}

function SmallRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="flex items-center justify-between gap-4 py-1 text-sm"><span className="text-muted-foreground">{label}</span><span className={cn("text-right tabular-nums text-foreground", tone)}>{value}</span></div>;
}

export default function BusinessModelPage() {
  usePageHeader({ title: "Business Model" });
  const { toast } = useToast();
  const { data, isLoading, isFetching, error, refetch } = useQuery<FinancialModel>({ queryKey: ["/api/business/model"] });
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
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
    onSuccess: (model) => { queryClient.setQueryData(["/api/business/model"], model); setSaveState("saved"); },
    onError: (saveError: Error) => { setSaveState("error"); toast({ title: "Failed to save model", description: saveError.message, variant: "destructive" }); },
  });

  const scheduleSave = useCallback((assumptions: Assumptions) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("pending");
    saveTimer.current = setTimeout(() => save.mutate(assumptions), 600);
  }, [save]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const update = useCallback((producer: (current: Assumptions) => Assumptions) => {
    setDraft((current) => {
      if (!current) return current;
      const next = producer(current);
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const updateGlobal = useCallback((patch: Partial<Assumptions>) => update((current) => ({ ...current, ...patch })), [update]);
  const updatePhase = useCallback((key: PhaseAssumption["key"], patch: Partial<PhaseAssumption>) => update((current) => ({ ...current, phases: current.phases.map((phase) => phase.key === key ? { ...phase, ...patch } : phase) })), [update]);
  const updateFinancing = useCallback((key: FinancingKey, patch: Partial<FinancingEvent>) => update((current) => ({ ...current, financingEvents: current.financingEvents.map((event) => event.key === key ? { ...event, ...patch } : event) })), [update]);
  const updateCost = useCallback((id: string, patch: Partial<OperatingCostEntry>) => update((current) => ({ ...current, operatingCosts: current.operatingCosts.map((cost) => cost.id === id ? { ...cost, ...patch } : cost) })), [update]);
  const updateCashLane = useCallback((month: number, patch: Partial<Assumptions["monthlyCashLanes"][number]>) => update((current) => ({ ...current, monthlyCashLanes: current.monthlyCashLanes.map((lane) => lane.month === month ? { ...lane, ...patch } : lane) })), [update]);

  const projection = useMemo(() => draft ? computeProjection(draft) : null, [draft]);

  if (error) return (
    <div className="w-full p-4"><Card className="p-4"><p className="text-sm font-medium">Financial model unavailable</p><p className="mt-1 text-sm text-muted-foreground">{(error as Error).message}</p><Button variant="outline" size="sm" className="mt-4" disabled={isFetching} onClick={() => void refetch()}>{isFetching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Try again</Button></Card></div>
  );
  if (isLoading || !draft || !projection) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const phaseOne = draft.phases.find((phase) => phase.key === "phase_1")!;
  const gateMonth = projection.months[Math.min(phaseOne.endMonth, projection.months.length) - 1];
  const phaseOneGate = projection.gates.find((gate) => gate.phaseKey === "phase_1")!;
  const preSeed = projection.financing.find((event) => event.key === "pre_seed")!;
  const gateGap = Math.max(0, phaseOne.productArrMin - (gateMonth?.productArr ?? 0));
  const raiseCoverage = projection.financingNeed.plannedRaise - projection.financingNeed.raiseRequired;

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <Card>
        <div className="grid gap-6 p-4 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Raise now" value={fmtCurrency(projection.financingNeed.raiseRequired)} detail={`${FINANCING_LABELS.pre_seed} · month ${projection.financingNeed.fundingMonth}`} tone={raiseCoverage < 0 ? "warning" : undefined} />
          <Metric label="Ownership sold" value={fmtPercent(preSeed.newInvestorOwnership)} detail={`${fmtCurrency(preSeed.valuation)} post-money cap`} />
          <Metric label="Cash at gate" value={fmtCurrency(gateMonth?.endingCash ?? 0)} detail={`${fmtMonths(gateMonth?.runwayMonths ?? 0)} runway`} tone={(gateMonth?.endingCash ?? 0) < draft.reserveAtNextGate ? "warning" : undefined} />
          <Metric label="Product ARR at gate" value={fmtCurrency(gateMonth?.productArr ?? 0)} detail={`${trimNum(gateMonth?.activeAccounts ?? 0)} active paying accounts`} tone={gateGap > 0 ? "warning" : "success"} />
          <Metric label="Phase 1 gate" value={phaseOneGate.status === "achieved" ? "Achieved" : phaseOneGate.status === "missed" ? "Missed" : "Not yet observable"} detail={phaseOneGate.firstAchievedMonth ? `First true in month ${phaseOneGate.firstAchievedMonth}` : `${fmtCurrency(gateGap)} ARR gap`} tone={phaseOneGate.status === "achieved" ? "success" : "warning"} />
        </div>
        <div className="grid border-t border-border/20 md:grid-cols-3">
          <div className="p-4 md:border-r md:border-border/20"><div className="text-xs font-medium text-muted-foreground">Money in now</div><SmallRow label="Planned Pre-Seed" value={fmtCurrency(projection.financingNeed.plannedRaise)} /><SmallRow label="Derived requirement" value={fmtCurrency(projection.financingNeed.raiseRequired)} tone={raiseCoverage < 0 ? "text-warning" : undefined} /><SmallRow label="Fundraise next" value={`Month ${projection.financingNeed.nextFundraiseStartMonth}`} /></div>
          <div className="border-t border-border/20 p-4 md:border-r md:border-t-0 md:border-border/20"><div className="text-xs font-medium text-muted-foreground">Milestones and growth</div><SmallRow label="Quarterly new-logo expansion" value={`${draft.accountExpansion90d.toFixed(2)}×`} /><SmallRow label="Annual NRR / GLR" value={`${trimNum(draft.annualNrrPct, 0)}% / ${trimNum(draft.annualGrossLogoRetentionPct, 0)}%`} /><SmallRow label="Implied retained ARPA" value={`${trimNum(projection.impliedRetainedAccountArpaExpansionPct)}%`} /></div>
          <div className="border-t border-border/20 p-4 md:border-t-0"><div className="text-xs font-medium text-muted-foreground">Money out later</div><SmallRow label="Product gross margin" value={fmtPercent(gateMonth?.productGrossMargin ?? 0)} tone={(gateMonth?.productGrossMargin ?? 0) < 0.8 ? "text-warning" : undefined} /><SmallRow label="Entry CAC payback" value={fmtMonths(projection.baselineCacPaybackMonths)} /><SmallRow label="Pre-Seed paper value" value={fmtCurrency(projection.financing.at(-1)?.preSeedPaperValue ?? 0)} /></div>
        </div>
      </Card>

      {(raiseCoverage < 0 || (gateMonth?.productGrossMargin ?? 0) < 0.8) && (
        <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div><span className="font-medium text-foreground">The model is exposing the risk.</span><span className="text-muted-foreground"> {raiseCoverage < 0 ? `Planned financing is ${fmtCurrency(Math.abs(raiseCoverage))} below the burn-to-gate requirement. ` : ""}{(gateMonth?.productGrossMargin ?? 0) < 0.8 ? `Phase 1 exits at ${fmtPercent(gateMonth?.productGrossMargin ?? 0)} product gross margin.` : ""}</span></div>
        </div>
      )}

      <Section title="Capital and phase gates" saveState={saveState} defaultOpen>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="border-border/20 bg-muted/20 p-4">
            <div className="mb-4 text-sm font-medium">Cash policy</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Opening cash"><NumericInput value={draft.openingCash} min={0} step={1000} prefix="$" onChange={(openingCash) => updateGlobal({ openingCash })} /></Field>
              <Field label="Reserve at gate"><NumericInput value={draft.reserveAtNextGate} min={0} step={10_000} prefix="$" onChange={(reserveAtNextGate) => updateGlobal({ reserveAtNextGate })} /></Field>
              <Field label="Round increment"><NumericInput value={draft.roundIncrement} min={1} step={10_000} prefix="$" onChange={(roundIncrement) => updateGlobal({ roundIncrement })} /></Field>
              <Field label="Lead time"><NumericInput value={draft.fundraisingLeadMonths} min={0} step={1} suffix="months" onChange={(fundraisingLeadMonths) => updateGlobal({ fundraisingLeadMonths })} /></Field>
            </div>
          </Card>
          <Card className="border-border/20 bg-muted/20 p-4">
            <div className="mb-4 text-sm font-medium">Model period</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Horizon"><NumericInput value={draft.horizonMonths} min={1} step={1} suffix="months" onChange={(horizonMonths) => updateGlobal({ horizonMonths })} /></Field>
              <Field label="Burn window"><NumericInput value={draft.trailingBurnMonths} min={1} step={1} suffix="months" onChange={(trailingBurnMonths) => updateGlobal({ trailingBurnMonths })} /></Field>
              <Field label="Start month"><div className="flex min-h-11 items-center rounded-md border border-border bg-muted/30 px-2"><input type="month" value={draft.startCalendarMonth} onChange={(event) => updateGlobal({ startCalendarMonth: event.target.value })} className="w-full bg-transparent py-2 text-sm outline-none" /></div></Field>
              <Field label="Phase 1 duration"><NumericInput value={phaseOne.endMonth} min={1} step={1} suffix="months" onChange={(endMonth) => updatePhase("phase_1", { endMonth })} /></Field>
            </div>
          </Card>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {PHASE_KEYS.map((key) => {
            const phase = draft.phases.find((item) => item.key === key)!;
            const gate = projection.gates.find((item) => item.phaseKey === key)!;
            return <Card key={key} className="border-border/20 bg-muted/20 p-4"><div className="mb-3 flex items-center justify-between gap-3"><span className="text-sm font-medium">{PHASE_LABELS[key]}</span>{gate.status === "achieved" ? <CheckCircle2 className="h-4 w-4 text-success" /> : <span className="text-xs text-muted-foreground">Month {phase.endMonth}</span>}</div><SmallRow label="Funded by" value={phase.fundedBy} /><Field label="ARR floor"><NumericInput value={phase.productArrMin} min={0} step={100_000} prefix="$" onChange={(productArrMin) => updatePhase(key, { productArrMin })} /></Field><div className="mt-3 grid grid-cols-2 gap-3"><Field label="NRR floor"><NumericInput value={phase.annualNrrMinPct} min={0} step={5} suffix="%" onChange={(annualNrrMinPct) => updatePhase(key, { annualNrrMinPct })} /></Field><Field label="GLR floor"><NumericInput value={phase.annualGlrMinPct} min={0} step={5} suffix="%" onChange={(annualGlrMinPct) => updatePhase(key, { annualGlrMinPct })} /></Field></div></Card>;
          })}
        </div>
      </Section>

      <Section title="Growth and Max economics" saveState={saveState}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Starting accounts"><NumericInput value={draft.startingAccounts} min={0} step={1} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} /></Field>
          <Field label="Q1 new accounts"><NumericInput value={draft.quarterOneNewAccounts} min={0} step={1} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} /></Field>
          <Field label="New-logo expansion"><NumericInput value={draft.accountExpansion90d} min={0} step={0.1} suffix="× / 90d" onChange={(accountExpansion90d) => updateGlobal({ accountExpansion90d })} /></Field>
          <Field label="Annual GLR"><NumericInput value={draft.annualGrossLogoRetentionPct} min={0} step={1} suffix="%" onChange={(annualGrossLogoRetentionPct) => updateGlobal({ annualGrossLogoRetentionPct })} /></Field>
          <Field label="Annual NRR"><NumericInput value={draft.annualNrrPct} min={0} step={5} suffix="%" onChange={(annualNrrPct) => updateGlobal({ annualNrrPct })} /></Field>
          <Field label="Max subscription"><NumericInput value={draft.maxSubscriptionMonthly} min={0} step={50} prefix="$" suffix="/ month" onChange={(maxSubscriptionMonthly) => updateGlobal({ maxSubscriptionMonthly })} /></Field>
          <Field label="Included tokens"><NumericInput value={draft.maxIncludedTokensMillions} min={0} step={1} suffix="M / month" onChange={(maxIncludedTokensMillions) => updateGlobal({ maxIncludedTokensMillions })} /></Field>
          <Field label="Blended token cost"><NumericInput value={draft.blendedTokenCostPerMillion} min={0} step={0.25} prefix="$" suffix="/ 1M" onChange={(blendedTokenCostPerMillion) => updateGlobal({ blendedTokenCostPerMillion })} /></Field>
          <Field label="Overage markup"><NumericInput value={draft.overageMarkupPct} min={0} step={25} suffix="% on cost" onChange={(overageMarkupPct) => updateGlobal({ overageMarkupPct })} /></Field>
          <Field label="Infrastructure / account"><NumericInput value={draft.infrastructurePerActiveAccount} min={0} step={5} prefix="$" onChange={(infrastructurePerActiveAccount) => updateGlobal({ infrastructurePerActiveAccount })} /></Field>
          <Field label="Support / account"><NumericInput value={draft.supportPerActiveAccount} min={0} step={5} prefix="$" onChange={(supportPerActiveAccount) => updateGlobal({ supportPerActiveAccount })} /></Field>
          <Field label="Payment processing"><NumericInput value={draft.paymentProcessingPct} min={0} step={0.5} suffix="%" onChange={(paymentProcessingPct) => updateGlobal({ paymentProcessingPct })} /></Field>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4"><Metric label="Gate subscription MRR" value={fmtCurrency(gateMonth?.subscriptionRevenue ?? 0)} /><Metric label="Gate overage MRR" value={fmtCurrency(gateMonth?.overageRevenue ?? 0)} detail={`${trimNum(gateMonth?.requiredOverageTokensMillions ?? 0)}M overage tokens`} /><Metric label="Overage gross margin" value={fmtPercent(gateMonth?.overageGrossMargin ?? 0)} /><Metric label="Retained-account ARPA burden" value={`${trimNum(projection.impliedRetainedAccountArpaExpansionPct)}%`} detail="Annual NRR ÷ annual GLR" /></div>
      </Section>

      <Section title="Acquisition, hiring, and burn" saveState={saveState}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="PLG share"><NumericInput value={draft.plgSharePct} min={0} step={5} suffix="%" onChange={(plgSharePct) => updateGlobal({ plgSharePct })} /></Field>
          <Field label="PLG CAC"><NumericInput value={draft.plgCac} min={0} step={50} prefix="$" onChange={(plgCac) => updateGlobal({ plgCac })} /></Field>
          <Field label="Top-down CAC"><NumericInput value={draft.topDownCac} min={0} step={100} prefix="$" onChange={(topDownCac) => updateGlobal({ topDownCac })} /></Field>
          <Field label="Onboarding / account"><NumericInput value={draft.onboardingCostPerNewAccount} min={0} step={50} prefix="$" onChange={(onboardingCostPerNewAccount) => updateGlobal({ onboardingCostPerNewAccount })} /></Field>
          <Metric label="Blended CAC" value={fmtCurrency(gateMonth?.blendedCac ?? 0)} />
          <Metric label="Entry payback" value={fmtMonths(projection.baselineCacPaybackMonths)} />
        </div>
        <div className="mt-4 overflow-x-auto rounded-md border border-border/20">
          <table className="w-full min-w-[700px] text-sm"><thead><tr className="border-b border-border/20 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Cost</th><th className="px-3 py-2 font-medium">Class</th><th className="px-3 py-2 font-medium">Start</th><th className="px-3 py-2 font-medium">End</th><th className="px-3 py-2 font-medium">Headcount</th><th className="px-3 py-2 font-medium">Monthly</th></tr></thead><tbody>{draft.operatingCosts.map((cost) => <tr key={cost.id} className="border-t border-border/10"><td className="px-3 py-2 text-foreground">{cost.label}</td><td className="px-3 py-2 text-muted-foreground">{cost.classification === "product_cogs" ? "Product COGS" : "Opex"}</td><td className="w-24 px-2 py-1"><NumericInput value={cost.startMonth} min={1} step={1} ariaLabel={`${cost.label} start month`} onChange={(startMonth) => updateCost(cost.id, { startMonth })} /></td><td className="w-24 px-2 py-1"><NumericInput value={cost.endMonth} min={1} step={1} ariaLabel={`${cost.label} end month`} onChange={(endMonth) => updateCost(cost.id, { endMonth })} /></td><td className="w-28 px-2 py-1"><NumericInput value={cost.headcount} min={0} step={1} ariaLabel={`${cost.label} headcount`} onChange={(headcount) => updateCost(cost.id, { headcount })} /></td><td className="w-40 px-2 py-1"><NumericInput value={cost.monthlyAmount} min={0} step={1000} prefix="$" ariaLabel={`${cost.label} monthly cost`} onChange={(monthlyAmount) => updateCost(cost.id, { monthlyAmount })} /></td></tr>)}</tbody></table>
        </div>
      </Section>

      <Section title="Valuation and dilution" saveState={saveState}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{FINANCING_KEYS.map((key) => { const event = draft.financingEvents.find((item) => item.key === key)!; const summary = projection.financing.find((item) => item.key === key)!; return <Card key={key} className="border-border/20 bg-muted/20 p-4"><div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium">{FINANCING_LABELS[key]}</span><span className="text-xs text-muted-foreground">{event.instrument === "post_money_safe" ? "Post-money SAFE" : "Priced round"}</span></div><div className="grid grid-cols-2 gap-3"><Field label="Month"><NumericInput value={event.month} min={1} step={1} onChange={(month) => updateFinancing(key, { month })} /></Field><Field label="Investment"><NumericInput value={event.amount} min={0} step={100_000} prefix="$" onChange={(amount) => updateFinancing(key, { amount })} /></Field><Field label={event.instrument === "post_money_safe" ? "Post-money cap" : "Pre-money valuation"}><NumericInput value={event.valuation} min={0} step={500_000} prefix="$" onChange={(valuation) => updateFinancing(key, { valuation })} /></Field><Field label="Option pool top-up"><NumericInput value={event.optionPoolTopUpPct} min={0} step={1} suffix="%" onChange={(optionPoolTopUpPct) => updateFinancing(key, { optionPoolTopUpPct })} /></Field></div><div className="mt-3 border-t border-border/20 pt-2"><SmallRow label="New ownership" value={fmtPercent(summary.newInvestorOwnership)} /><SmallRow label="Pre-Seed remaining" value={fmtPercent(summary.preSeedOwnership)} /><SmallRow label="Paper value" value={fmtCurrency(summary.preSeedPaperValue)} /></div></Card>; })}</div>
      </Section>

      <Card>
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3"><h2 className="text-sm font-semibold">Monthly spreadsheet</h2><SavedIndicator state={saveState} /></div>
        <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead><tr><th className="sticky left-0 z-20 min-w-[10rem] border-b border-r border-border/20 bg-card px-3 py-2 text-left font-medium text-muted-foreground">Month</th>{projection.months.map((month) => <th key={month.month} className="min-w-[5rem] border-b border-border/10 px-2 py-2 text-right font-medium text-muted-foreground">{month.label}</th>)}</tr></thead>
            <tbody>
              <DataRow label="Phase" months={projection.months} render={(month, index) => index === 0 || projection.months[index - 1].phaseKey !== month.phaseKey ? month.phaseLabel.replace(/ .*/, "") : ""} />
              <DataRow label="New accounts" months={projection.months} render={(month) => trimNum(month.newAccounts)} />
              <DataRow label="Active accounts" months={projection.months} render={(month) => trimNum(month.activeAccounts)} />
              <DataRow label="Subscription MRR" months={projection.months} render={(month) => fmtCurrency(month.subscriptionRevenue)} />
              <DataRow label="Overage MRR" months={projection.months} render={(month) => fmtCurrency(month.overageRevenue)} />
              <DataRow label="Product ARR" months={projection.months} render={(month) => fmtCurrency(month.productArr)} emphasize />
              <EditableDataRow label="Consulting revenue" months={projection.months} value={(month) => month.consultingRevenue} onChange={(month, consultingRevenue) => updateCashLane(month, { consultingRevenue })} />
              <DataRow label="Product COGS" months={projection.months} render={(month) => fmtCurrency(month.productCogs)} />
              <EditableDataRow label="Consulting COGS" months={projection.months} value={(month) => month.consultingCogs} onChange={(month, consultingCogs) => updateCashLane(month, { consultingCogs })} />
              <DataRow label="Product GM" months={projection.months} render={(month) => fmtPercent(month.productGrossMargin)} tone={(month) => month.productGrossMargin < 0.8 ? "text-warning" : "text-foreground"} />
              <DataRow label="Acquisition spend" months={projection.months} render={(month) => fmtCurrency(month.acquisitionSpend)} />
              <DataRow label="Headcount" months={projection.months} render={(month) => trimNum(month.headcount)} />
              <DataRow label="Operating expense" months={projection.months} render={(month) => fmtCurrency(month.operatingExpense)} />
              <EditableDataRow label="Capex" months={projection.months} value={(month) => month.capex} onChange={(month, capex) => updateCashLane(month, { capex })} />
              <DataRow label="Net cash change" months={projection.months} render={(month) => fmtCurrency(month.netCashChange)} tone={(month) => month.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Financing in" months={projection.months} render={(month) => month.financingCash > 0 ? fmtCurrency(month.financingCash) : "—"} />
              <DataRow label="Ending cash" months={projection.months} render={(month) => fmtCurrency(month.endingCash)} tone={(month) => month.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
              <DataRow label="Runway" months={projection.months} render={(month) => fmtMonths(month.runwayMonths)} />
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function DataRow({ label, months, render, tone, emphasize }: { label: string; months: Month[]; render: (month: Month, index: number) => string; tone?: (month: Month) => string; emphasize?: boolean }) {
  return <tr className="border-t border-border/10"><td className={cn("sticky left-0 z-10 border-r border-border/20 bg-card px-3 py-2 text-left text-muted-foreground", emphasize && "font-medium text-foreground")}>{label}</td>{months.map((month, index) => <td key={month.month} className={cn("px-2 py-2 text-right text-foreground", tone?.(month))}>{render(month, index)}</td>)}</tr>;
}

function EditableDataRow({ label, months, value, onChange }: { label: string; months: Month[]; value: (month: Month) => number; onChange: (month: number, value: number) => void }) {
  return <tr className="border-t border-border/10"><td className="sticky left-0 z-10 border-r border-border/20 bg-card px-3 py-2 text-left text-muted-foreground">{label}</td>{months.map((month) => <td key={month.month} className="px-1 py-1"><input aria-label={`${label} ${month.label}`} type="number" min={0} step={1000} value={value(month)} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(month.month, next); }} className="min-h-9 w-[4.5rem] rounded border border-border/30 bg-muted/20 px-1 text-right text-xs tabular-nums outline-none focus:ring-1 focus:ring-ring" /></td>)}</tr>;
}
