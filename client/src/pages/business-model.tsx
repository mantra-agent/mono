import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Loader2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  FINANCING_KEYS,
  FINANCING_LABELS,
  computeProjection,
  type Assumptions,
  type FinancialModel,
  type FinancingEvent,
  type FinancingKey,
  type PhaseKey,
} from "@shared/models/business-model";

type Month = ReturnType<typeof computeProjection>["months"][number];
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

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
  pre_seed: { band: "bg-[hsl(var(--chart-2)/0.15)]", text: "text-[hsl(var(--chart-2))]", dot: "bg-[hsl(var(--chart-2))]" },
  seed: { band: "bg-[hsl(var(--chart-1)/0.15)]", text: "text-[hsl(var(--chart-1))]", dot: "bg-[hsl(var(--chart-1))]" },
  series_a: { band: "bg-[hsl(var(--chart-3)/0.15)]", text: "text-[hsl(var(--chart-3))]", dot: "bg-[hsl(var(--chart-3))]" },
  series_b: { band: "bg-[hsl(var(--chart-4)/0.15)]", text: "text-[hsl(var(--chart-4))]", dot: "bg-[hsl(var(--chart-4))]" },
};

const PHASE_STAGE: Record<PhaseKey, FinancingKey> = {
  phase_0: "pre_seed",
  phase_1: "pre_seed",
  phase_2: "seed",
  phase_3: "series_a",
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
        className="w-full min-w-0 bg-transparent py-1.5 text-sm tabular-nums outline-none"
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

  const financingMonths = new Set(draft.financingEvents.map((event) => event.month));

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Assumptions</h2>
          <SavedIndicator state={saveState} />
        </div>

        <div className="border-b border-border/20 p-4">
          <div className="mb-3 text-sm font-medium text-foreground">Global</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Field label="Horizon (months)"><NumericInput value={draft.horizonMonths} min={1} step={1} onChange={(horizonMonths) => updateGlobal({ horizonMonths })} /></Field>
            <Field label="Start month"><div className="flex items-center rounded-md border border-border/40 bg-background px-2"><input type="month" value={draft.startCalendarMonth} onChange={(event) => updateGlobal({ startCalendarMonth: event.target.value })} className="w-full bg-transparent py-1.5 text-sm outline-none" /></div></Field>
            <Field label="Starting cash"><NumericInput value={draft.openingCash} min={0} step={1000} prefix="$" onChange={(openingCash) => updateGlobal({ openingCash })} /></Field>
            <Field label="Starting accounts"><NumericInput value={draft.startingAccounts} min={0} step={1} onChange={(startingAccounts) => updateGlobal({ startingAccounts })} /></Field>
            <Field label="Base subscription / account (mo)"><NumericInput value={draft.maxSubscriptionMonthly} min={0} step={50} prefix="$" onChange={(maxSubscriptionMonthly) => updateGlobal({ maxSubscriptionMonthly })} /></Field>
          </div>
        </div>

        <div className="border-b border-border/20 p-4">
          <div className="mb-3 text-sm font-medium text-foreground">Growth</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Field label="Q1 new accounts"><NumericInput value={draft.quarterOneNewAccounts} min={0} step={1} onChange={(quarterOneNewAccounts) => updateGlobal({ quarterOneNewAccounts })} /></Field>
            <Field label="New accounts (× / 90 days)"><NumericInput value={draft.accountExpansion90d} min={0} step={0.1} suffix="×" onChange={(accountExpansion90d) => updateGlobal({ accountExpansion90d })} /></Field>
            <Field label="Annual NRR"><NumericInput value={draft.annualNrrPct} min={0} step={5} suffix="%" onChange={(annualNrrPct) => updateGlobal({ annualNrrPct })} /></Field>
            <Field label="Annual logo retention"><NumericInput value={draft.annualGrossLogoRetentionPct} min={0} step={1} suffix="%" onChange={(annualGrossLogoRetentionPct) => updateGlobal({ annualGrossLogoRetentionPct })} /></Field>
            <Field label="Reserve at next gate"><NumericInput value={draft.reserveAtNextGate} min={0} step={10_000} prefix="$" onChange={(reserveAtNextGate) => updateGlobal({ reserveAtNextGate })} /></Field>
          </div>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {FINANCING_KEYS.map((key) => {
            const event = draft.financingEvents.find((item) => item.key === key)!;
            const summary = projection.financing.find((item) => item.key === key)!;
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
                  <Row label="Pre-Seed remaining" value={fmtPercent(summary.preSeedOwnership)} />
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
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
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
                  <Row label="Pre-Seed stake" value={`${fmtPercent(summary.preSeedOwnership)} · ${fmtCurrency(summary.preSeedPaperValue)}`} />
                  <div className="mt-2 flex items-center justify-between border-t border-border/20 pt-2">
                    <span className="text-xs text-muted-foreground">Return on Pre-Seed</span>
                    <span className={cn("text-base font-semibold", color.text)}>{fmtMultiple(summary.preSeedReturnMultiple)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="border-b border-border/20 px-4 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Monthly projection ({projection.months.length} months)</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 min-w-[8.5rem] border-b border-r border-border/20 bg-background px-3 py-2 text-left font-medium text-muted-foreground">Month</th>
                {projection.months.map((month) => <th key={month.month} className={cn("min-w-[4rem] border-b border-border/10 px-2 py-2 text-right font-medium text-muted-foreground", financingMonths.has(month.month) && "bg-muted/40 text-foreground")}>{month.label}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left font-medium text-muted-foreground">Phase</td>
                {projection.months.map((month, index) => {
                  const stageKey = PHASE_STAGE[month.phaseKey];
                  const color = STAGE_COLOR[stageKey];
                  const isStart = index === 0 || projection.months[index - 1].phaseKey !== month.phaseKey;
                  return <td key={month.month} className={cn("px-2 py-1.5 text-right", color.band, color.text)}>{isStart ? <span className="font-medium">{FINANCING_LABELS[stageKey]}</span> : ""}</td>;
                })}
              </tr>
              <DataRow label="Accounts" months={projection.months} financingMonths={financingMonths} render={(month) => Math.round(month.activeAccounts).toLocaleString()} />
              <DataRow label="New Accounts" months={projection.months} financingMonths={financingMonths} render={(month) => month.newAccounts >= 0.05 ? `+${trimNum(month.newAccounts)}` : "—"} />
              <DataRow label="Revenue" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.productRevenue)} />
              <DataRow label="Blended ARPU" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.activeAccounts > 0 ? month.productRevenue / month.activeAccounts : 0)} />
              <DataRow label="Expenses" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.productCogs + month.consultingCogs + month.acquisitionSpend + month.operatingExpense + month.capex)} />
              <DataRow label="Net Cash Flow" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.netCashChange)} tone={(month) => month.netCashChange < 0 ? "text-destructive" : "text-foreground"} />
              <DataRow label="Investment In" months={projection.months} financingMonths={financingMonths} render={(month) => month.financingCash > 0 ? fmtCurrency(month.financingCash) : "—"} />
              <DataRow label="Cash Balance" months={projection.months} financingMonths={financingMonths} render={(month) => fmtCurrency(month.endingCash)} tone={(month) => month.endingCash < 0 ? "font-medium text-destructive" : "text-foreground"} emphasize />
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{label}</span><span className="text-sm tabular-nums text-foreground">{value}</span></div>;
}

interface DataRowProps {
  label: string;
  months: Month[];
  financingMonths: Set<number>;
  render: (month: Month) => string;
  tone?: (month: Month) => string;
  emphasize?: boolean;
}

function DataRow({ label, months, financingMonths, render, tone, emphasize }: DataRowProps) {
  return (
    <tr className="border-t border-border/10">
      <td className={cn("sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left text-muted-foreground", emphasize && "font-medium text-foreground")}>{label}</td>
      {months.map((month) => <td key={month.month} className={cn("px-2 py-1.5 text-right text-foreground", financingMonths.has(month.month) && "bg-muted/20", tone?.(month))}>{render(month)}</td>)}
    </tr>
  );
}
