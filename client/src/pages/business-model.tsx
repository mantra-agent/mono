import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Loader2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  STAGE_KEYS,
  computeProjection,
  type Assumptions,
  type FinancialModel,
  type Stage,
  type StageKey,
} from "@shared/models/business-model";

// ── Formatting ────────────────────────────────────────────────────
function trimNum(x: number): string {
  return (Math.round(x * 10) / 10).toString();
}

/** Compact currency, e.g. $40k, $1.2M, -$900k, $500. */
function fmtCurrency(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${trimNum(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trimNum(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function fmtPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function fmtMultiple(n: number): string {
  return `${n.toFixed(1)}×`;
}

// ── Stage color bands ─────────────────────────────────────────────
const STAGE_COLOR: Record<StageKey, { band: string; text: string; dot: string }> = {
  pre_seed: { band: "bg-sky-500/15", text: "text-sky-300", dot: "bg-sky-400" },
  seed: { band: "bg-emerald-500/15", text: "text-emerald-300", dot: "bg-emerald-400" },
  series_a: { band: "bg-violet-500/15", text: "text-violet-300", dot: "bg-violet-400" },
  series_b: { band: "bg-amber-500/15", text: "text-amber-300", dot: "bg-amber-400" },
};

// ── Numeric input ─────────────────────────────────────────────────
function NumericInput({
  value,
  onChange,
  prefix,
  suffix,
  min,
  step,
  testId,
}: {
  value: number;
  onChange: (n: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  step?: number;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
      <input
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const raw = e.target.value;
          const next = raw === "" ? 0 : Number(raw);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="w-full bg-transparent py-1.5 text-sm tabular-nums outline-none"
        data-testid={testId}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ── Save state indicator ──────────────────────────────────────────
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

function SavedIndicator({ state }: { state: SaveState }) {
  if (state === "saving" || state === "pending") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="save-indicator-saving">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="save-indicator-saved">
        <Check className="h-3 w-3 text-emerald-400" /> Saved
      </span>
    );
  }
  if (state === "error") {
    return <span className="text-xs text-destructive" data-testid="save-indicator-error">Save failed</span>;
  }
  return null;
}

// ── Page ──────────────────────────────────────────────────────────
export default function BusinessModelPage() {
  usePageHeader({ title: "Business Model" });
  const { toast } = useToast();

  const { data, isLoading, isFetching, error, refetch } = useQuery<FinancialModel>({ queryKey: ["/api/business/model"] });

  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const loadedIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the local draft once per model id; refetches of the same model don't clobber edits.
  useEffect(() => {
    if (data && loadedIdRef.current !== data.id) {
      loadedIdRef.current = data.id;
      setDraft(data.assumptions);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async (assumptions: Assumptions) =>
      (await apiRequest("PATCH", "/api/business/model", assumptions)).json() as Promise<FinancialModel>,
    onMutate: () => setSaveState("saving"),
    onSuccess: (model) => {
      queryClient.setQueryData(["/api/business/model"], model);
      setSaveState("saved");
    },
    onError: (err: Error) => {
      setSaveState("error");
      toast({ title: "Failed to save model", description: err.message, variant: "destructive" });
    },
  });

  const scheduleSave = useCallback(
    (assumptions: Assumptions) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("pending");
      saveTimer.current = setTimeout(() => save.mutate(assumptions), 600);
    },
    [save],
  );

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const updateGlobal = useCallback(
    (partial: Partial<Assumptions>) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...partial };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const updateStage = useCallback(
    (key: StageKey, patch: Partial<Omit<Stage, "key">>) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev, stages: prev.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const projection = useMemo(() => (draft ? computeProjection(draft) : null), [draft]);
  const stageByKey = useMemo(() => {
    const map = new Map<StageKey, Stage>();
    if (draft) for (const s of draft.stages) map.set(s.key, s);
    return map;
  }, [draft]);

  if (error) {
    return (
      <div className="w-full p-4">
        <div className="rounded-md border border-destructive/30 p-4">
          <p className="text-sm font-medium text-foreground">Financial model unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">{(error as Error).message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !draft || !projection) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { months, stages: summaries } = projection;

  return (
    <div className="w-full space-y-6 p-4" data-testid="business-model-page">
      {/* Assumptions */}
      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Assumptions</h2>
          <SavedIndicator state={saveState} />
        </div>

        {/* Global */}
        <div className="border-b border-border/20 p-4">
          <div className="mb-3 text-sm font-medium text-foreground">Global</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Field label="Horizon (months)">
              <NumericInput value={draft.horizonMonths} min={1} step={1} onChange={(n) => updateGlobal({ horizonMonths: n })} testId="input-horizon" />
            </Field>
            <Field label="Start month">
              <div className="flex items-center rounded-md border border-border/40 bg-background px-2">
                <input
                  type="month"
                  value={draft.startCalendarMonth}
                  onChange={(e) => updateGlobal({ startCalendarMonth: e.target.value })}
                  className="w-full bg-transparent py-1.5 text-sm outline-none"
                  data-testid="input-start-month"
                />
              </div>
            </Field>
            <Field label="Starting cash">
              <NumericInput value={draft.startingCash} min={0} step={1000} prefix="$" onChange={(n) => updateGlobal({ startingCash: n })} testId="input-starting-cash" />
            </Field>
            <Field label="Starting customers">
              <NumericInput value={draft.startingCustomers} min={0} step={1} onChange={(n) => updateGlobal({ startingCustomers: n })} testId="input-starting-customers" />
            </Field>
            <Field label="Revenue / customer (mo)">
              <NumericInput value={draft.revenuePerCustomerMonthly} min={0} step={50} prefix="$" onChange={(n) => updateGlobal({ revenuePerCustomerMonthly: n })} testId="input-revenue-per-customer" />
            </Field>
          </div>
        </div>

        {/* Stage cards */}
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {STAGE_KEYS.map((key) => {
            const stage = stageByKey.get(key)!;
            const color = STAGE_COLOR[key];
            return (
              <div key={key} className="rounded-md border border-border/30" data-testid={`stage-card-${key}`}>
                <div className={cn("flex items-center gap-2 rounded-t-md border-b border-border/20 px-3 py-2", color.band)}>
                  <span className={cn("h-2 w-2 rounded-full", color.dot)} />
                  <span className={cn("text-sm font-semibold", color.text)}>{summaries.find((s) => s.key === key)?.label}</span>
                </div>
                <div className="space-y-3 p-3">
                  <Field label="Round month">
                    <NumericInput value={stage.roundMonth} min={1} step={1} onChange={(n) => updateStage(key, { roundMonth: n })} testId={`input-${key}-round-month`} />
                  </Field>
                  <Field label="Investment">
                    <NumericInput value={stage.investmentAmount} min={0} step={100000} prefix="$" onChange={(n) => updateStage(key, { investmentAmount: n })} testId={`input-${key}-investment`} />
                  </Field>
                  <Field label="Pre-money valuation">
                    <NumericInput value={stage.preMoneyValuation} min={0} step={500000} prefix="$" onChange={(n) => updateStage(key, { preMoneyValuation: n })} testId={`input-${key}-premoney`} />
                  </Field>
                  <Field label="Monthly growth">
                    <NumericInput value={stage.monthlyGrowthRatePct} step={1} suffix="%" onChange={(n) => updateStage(key, { monthlyGrowthRatePct: n })} testId={`input-${key}-growth`} />
                  </Field>
                  <Field label="Monthly expenses">
                    <NumericInput value={stage.monthlyExpenses} min={0} step={10000} prefix="$" onChange={(n) => updateStage(key, { monthlyExpenses: n })} testId={`input-${key}-expenses`} />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Investor story strip */}
      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="flex items-center gap-2 border-b border-border/20 px-4 py-3">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Money in now → value later</h2>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
          {summaries.map((s) => {
            const color = STAGE_COLOR[s.key];
            return (
              <div key={s.key} className="rounded-md border border-border/30" data-testid={`investor-card-${s.key}`}>
                <div className={cn("flex items-center justify-between rounded-t-md border-b border-border/20 px-3 py-2", color.band)}>
                  <span className={cn("text-sm font-semibold", color.text)}>{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.roundMonthLabel}</span>
                </div>
                <div className="space-y-1.5 p-3 text-sm">
                  <Row label="Investment" value={fmtCurrency(s.investment)} />
                  <Row label="Pre-money" value={fmtCurrency(s.preMoney)} />
                  <Row label="Post-money" value={fmtCurrency(s.postMoney)} />
                  <Row label="Pre-Seed stake" value={`${fmtPercent(s.preSeedOwnership)} · ${fmtCurrency(s.preSeedStakeValue)}`} />
                  <div className="mt-2 flex items-center justify-between border-t border-border/20 pt-2">
                    <span className="text-xs text-muted-foreground">Return on Pre-Seed</span>
                    <span className="text-base font-semibold text-emerald-300" data-testid={`return-${s.key}`}>{fmtMultiple(s.preSeedReturnMultiple)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Spreadsheet */}
      <section className="overflow-hidden rounded-md border border-border/20">
        <div className="border-b border-border/20 px-4 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Monthly projection ({months.length} months)
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-max border-collapse text-xs tabular-nums" data-testid="projection-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 min-w-[8.5rem] border-b border-r border-border/20 bg-background px-3 py-2 text-left font-medium text-muted-foreground">
                  Month
                </th>
                {months.map((m) => (
                  <th
                    key={m.month}
                    className={cn(
                      "min-w-[4rem] border-b border-border/10 px-2 py-2 text-right font-medium text-muted-foreground",
                      m.isRoundMonth && "bg-muted/40 text-foreground",
                    )}
                  >
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Stage band row */}
              <tr>
                <td className="sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left font-medium text-muted-foreground">
                  Stage
                </td>
                {months.map((m, i) => {
                  const color = STAGE_COLOR[m.stageKey];
                  const isStart = i === 0 || months[i - 1].stageKey !== m.stageKey;
                  return (
                    <td key={m.month} className={cn("px-2 py-1.5 text-right", color.band, color.text)}>
                      {isStart ? <span className="font-medium">{m.stageLabel}</span> : ""}
                    </td>
                  );
                })}
              </tr>

              <DataRow label="Customers" months={months} render={(m) => Math.round(m.customers).toLocaleString()} />
              <DataRow label="Revenue" months={months} render={(m) => fmtCurrency(m.revenue)} />
              <DataRow label="Expenses" months={months} render={(m) => fmtCurrency(m.expenses)} />
              <DataRow
                label="Net Cash Flow"
                months={months}
                render={(m) => fmtCurrency(m.netCashFlow)}
                tone={(m) => (m.netCashFlow < 0 ? "text-destructive" : "text-foreground")}
              />
              <DataRow label="Investment In" months={months} render={(m) => (m.investmentIn > 0 ? fmtCurrency(m.investmentIn) : "—")} />
              <DataRow
                label="Cash Balance"
                months={months}
                render={(m) => fmtCurrency(m.cashBalance)}
                tone={(m) => (m.cashBalance < 0 ? "text-destructive font-medium" : "text-foreground")}
                emphasize
              />
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function DataRow({
  label,
  months,
  render,
  tone,
  emphasize,
}: {
  label: string;
  months: ReturnType<typeof computeProjection>["months"];
  render: (m: ReturnType<typeof computeProjection>["months"][number]) => string;
  tone?: (m: ReturnType<typeof computeProjection>["months"][number]) => string;
  emphasize?: boolean;
}) {
  return (
    <tr className="border-t border-border/10">
      <td
        className={cn(
          "sticky left-0 z-10 border-r border-border/20 bg-background px-3 py-1.5 text-left text-muted-foreground",
          emphasize && "font-medium text-foreground",
        )}
      >
        {label}
      </td>
      {months.map((m) => (
        <td
          key={m.month}
          className={cn(
            "px-2 py-1.5 text-right text-foreground",
            m.isRoundMonth && "bg-muted/20",
            tone?.(m),
          )}
        >
          {render(m)}
        </td>
      ))}
    </tr>
  );
}
