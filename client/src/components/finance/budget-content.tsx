import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { DollarSign, TrendingUp, PiggyBank, ChevronLeft, ChevronRight, Calendar, BarChart3, Check, Loader2, ChevronDown, ChevronUp, Lock, Plus, Pencil, Trash2, CalendarClock, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";
import { useCategoryLabels, humanCategory } from "./category-labels";
import { AmortizationManager } from "./amortization-manager";

interface BudgetEntry {
  id: number;
  category: string;
  monthlyAmount: number;
}

interface MonthlyOverride {
  id: number;
  category: string;
  month: string;
  amount: number;
}

interface IncomeOverride {
  id: number | null;
  monthlyIncome: number | null;
  useOverride: boolean;
}

interface MonthlyIncomeData {
  monthlyGross: number;
  monthlyNet: number;
  hasIncomeSources: boolean;
}

interface ComparisonData {
  mode: string;
  startDate: string;
  endDate: string;
  income: number;
  spending: number;
  spendingByCategory: Record<string, number>;
  monthsWithData?: number;
  internalTransfers?: {
    count: number;
    totalIn: number;
    totalOut: number;
    netAmount: number;
  };
}

interface CategoryTransaction {
  transactionId: string;
  date: string;
  name: string;
  merchantName: string | null;
  amount: number;
}

interface FutureCashEvent {
  id: number;
  category: string;
  amount: number;
  date: string;
  description: string | null;
}

type ComparisonMode = "this_month" | "last_month" | "trailing_avg";

const COMPARISON_LABELS: Record<ComparisonMode, string> = {
  this_month: "This Month (MTD)",
  last_month: "Last Month",
  trailing_avg: "12-Month Average",
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatMonth(month: string): string {
  const [year, m] = month.split("-");
  const date = new Date(parseInt(year), parseInt(m) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatDate(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function BudgetContent() {
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("this_month");
  const [localAmounts, setLocalAmounts] = useState<Record<string, string>>({});
  const [incomeValue, setIncomeValue] = useState<string>("");
  const [useOverride, setUseOverride] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [incomeInitialized, setIncomeInitialized] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [internalTransfersExpanded, setInternalTransfersExpanded] = useState(false);
  const justSavedRef = useRef(false);
  const prevMonthRef = useRef<string | null | undefined>(undefined);
  const overridesLoadedRef = useRef(false);

  const { labels: categoryLabels, categories: dbCategories, isLoading: categoriesLoading } = useCategoryLabels();

  const entriesQuery = useQuery<{ entries: BudgetEntry[] }>({ queryKey: ["/api/finance/budget-entries"] });
  const incomeQuery = useQuery<IncomeOverride>({ queryKey: ["/api/finance/budget-income-override"] });
  const incomeSourcesQuery = useQuery<MonthlyIncomeData>({ queryKey: ["/api/finance/monthly-income"] });
  const liabilityPaymentsQuery = useQuery<{ totalLiabilityPayments: number }>({ queryKey: ["/api/finance/total-liability-payments"] });

  const monthlyOverridesUrl = selectedMonth ? `/api/finance/budget-monthly-overrides?month=${selectedMonth}` : null;
  const monthlyOverridesQuery = useQuery<{ overrides: MonthlyOverride[] }>({
    queryKey: [monthlyOverridesUrl],
    enabled: selectedMonth !== null,
  });

  const comparisonUrl = `/api/finance/budget-comparison?mode=${comparisonMode}`;
  const comparisonQuery = useQuery<ComparisonData>({
    queryKey: [comparisonUrl],
  });

  const entries = useMemo(() => entriesQuery.data?.entries || [], [entriesQuery.data]);
  const monthlyOverrides = useMemo(() => monthlyOverridesQuery.data?.overrides || [], [monthlyOverridesQuery.data]);
  const comparison = comparisonQuery.data;

  const FALLBACK_BUDGET_CATEGORIES = [
    "FOOD_AND_DRINK", "TRANSPORTATION", "RENT_AND_UTILITIES", "GENERAL_MERCHANDISE",
    "ENTERTAINMENT", "PERSONAL_CARE", "GENERAL_SERVICES", "HOME_IMPROVEMENT",
    "TRAVEL", "MEDICAL", "UNCATEGORIZED",
  ];
  const BUDGET_CATEGORIES = useMemo(() => {
    const cats = dbCategories.length > 0
      ? dbCategories.map(c => c.plaidCategory || c.name)
      : [...FALLBACK_BUDGET_CATEGORIES];
    if (comparison?.spendingByCategory) {
      const catSet = new Set(cats);
      for (const key of Object.keys(comparison.spendingByCategory)) {
        if (!catSet.has(key)) {
          cats.push(key);
          catSet.add(key);
        }
      }
    }
    return cats;
  }, [dbCategories, comparison?.spendingByCategory]);

  const isEveryMonth = selectedMonth === null;

  useEffect(() => {
    if (!initialized) return;
    const monthChanged = prevMonthRef.current !== selectedMonth;
    if (monthChanged) {
      prevMonthRef.current = selectedMonth;
      overridesLoadedRef.current = false;
      justSavedRef.current = false;
    }
    if (justSavedRef.current) {
      justSavedRef.current = false;
      return;
    }
    const isFirstOverrideLoad = !isEveryMonth && !overridesLoadedRef.current && monthlyOverrides.length > 0;
    if (!monthChanged && !isFirstOverrideLoad) return;
    if (!isEveryMonth && monthlyOverrides.length > 0) {
      overridesLoadedRef.current = true;
    }
    if (isEveryMonth) {
      const amounts: Record<string, string> = {};
      for (const e of entries) {
        amounts[e.category] = e.monthlyAmount.toString();
      }
      setLocalAmounts(amounts);
    } else {
      const baseAmounts: Record<string, string> = {};
      for (const e of entries) {
        baseAmounts[e.category] = e.monthlyAmount.toString();
      }
      for (const o of monthlyOverrides) {
        baseAmounts[o.category] = o.amount.toString();
      }
      setLocalAmounts(baseAmounts);
    }
  }, [selectedMonth, entries, monthlyOverrides, initialized, isEveryMonth]);

  useEffect(() => {
    if (!initialized && entries.length > 0) {
      const amounts: Record<string, string> = {};
      for (const e of entries) {
        amounts[e.category] = e.monthlyAmount.toString();
      }
      setLocalAmounts(amounts);
      setInitialized(true);
    }
    if (!initialized && entriesQuery.isFetched && entries.length === 0) {
      setInitialized(true);
    }
  }, [initialized, entries, entriesQuery.isFetched]);

  useEffect(() => {
    if (!incomeInitialized && incomeQuery.isFetched && incomeQuery.data) {
      setUseOverride(incomeQuery.data.useOverride);
      setIncomeValue(incomeQuery.data.monthlyIncome?.toString() || "");
      setIncomeInitialized(true);
    }
  }, [incomeInitialized, incomeQuery.isFetched, incomeQuery.data]);

  const budgetMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const cat of BUDGET_CATEGORIES) {
      map[cat] = parseFloat(localAmounts[cat] || "0") || 0;
    }
    return map;
  }, [localAmounts, BUDGET_CATEGORIES]);

  const incomeFromSources = incomeSourcesQuery.data;
  const effectiveMonthlyIncome = (() => {
    if (useOverride && incomeValue) return parseFloat(incomeValue) || 0;
    if (incomeFromSources?.hasIncomeSources) return incomeFromSources.monthlyNet;
    return comparison?.income || 0;
  })();

  const loanPaymentAmount = liabilityPaymentsQuery.data?.totalLiabilityPayments ?? 0;

  const totalBudgeted = useMemo(() => {
    return Object.values(budgetMap).reduce((s, v) => s + v, 0) + loanPaymentAmount;
  }, [budgetMap, loanPaymentAmount]);

  const totalActual = useMemo(() => {
    if (!comparison) return 0;
    return Object.values(comparison.spendingByCategory).reduce((s, v) => s + v, 0);
  }, [comparison]);

  const projectedSavings = effectiveMonthlyIncome - totalBudgeted;
  const projectedSavingsRate = effectiveMonthlyIncome > 0
    ? (projectedSavings / effectiveMonthlyIncome) * 100
    : 0;

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestAmountsRef = useRef(localAmounts);
  const latestSelectedMonthRef = useRef(selectedMonth);
  const latestIncomeValueRef = useRef(incomeValue);
  const latestUseOverrideRef = useRef(useOverride);

  latestAmountsRef.current = localAmounts;
  latestSelectedMonthRef.current = selectedMonth;
  latestIncomeValueRef.current = incomeValue;
  latestUseOverrideRef.current = useOverride;

  const showSaved = useCallback(() => {
    setSaveStatus("saved");
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
  }, []);

  const saveBudgetMutation = useMutation({
    mutationFn: (args: { amounts: Record<string, string>; month: string | null; categories: string[] }) => {
      if (args.month === null) {
        const budgetItems = args.categories.map(cat => ({
          category: cat,
          monthlyAmount: parseFloat(args.amounts[cat] || "0") || 0,
        }));
        return apiRequest("PUT", "/api/finance/budget-entries", { entries: budgetItems });
      } else {
        const overrideItems = args.categories.map(cat => ({
          category: cat,
          amount: parseFloat(args.amounts[cat] || "0") || 0,
        }));
        return apiRequest("PUT", "/api/finance/budget-monthly-overrides", {
          month: args.month,
          entries: overrideItems,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-entries"] });
      if (monthlyOverridesUrl) {
        queryClient.invalidateQueries({ queryKey: [monthlyOverridesUrl] });
      }
      showSaved();
    },
  });

  const saveIncomeMutation = useMutation({
    mutationFn: (args: { monthlyIncome: string; useOverride: boolean }) => {
      return apiRequest("PUT", "/api/finance/budget-income-override", {
        monthlyIncome: parseFloat(args.monthlyIncome) || null,
        useOverride: args.useOverride,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-income-override"] });
      showSaved();
    },
  });

  const saveBudget = useCallback(() => {
    setSaveStatus("saving");
    saveBudgetMutation.mutate({
      amounts: latestAmountsRef.current,
      month: latestSelectedMonthRef.current,
      categories: BUDGET_CATEGORIES,
    });
  }, [BUDGET_CATEGORIES, saveBudgetMutation]);

  const saveIncome = useCallback(() => {
    setSaveStatus("saving");
    saveIncomeMutation.mutate({
      monthlyIncome: latestIncomeValueRef.current,
      useOverride: latestUseOverrideRef.current,
    });
  }, [saveIncomeMutation]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleBudgetAmountChange = useCallback((cat: string, value: string) => {
    setLocalAmounts(prev => ({ ...prev, [cat]: value }));
  }, []);

  const handleBudgetBlurOrEnter = useCallback(() => {
    justSavedRef.current = true;
    saveBudget();
  }, [saveBudget]);

  const handleIncomeValueChange = useCallback((value: string) => {
    setIncomeValue(value);
  }, []);

  const handleIncomeBlurOrEnter = useCallback(() => {
    saveIncome();
  }, [saveIncome]);

  const handleUseOverrideChange = useCallback((checked: boolean) => {
    setUseOverride(checked);
    setSaveStatus("saving");
    setTimeout(() => {
      saveIncomeMutation.mutate({
        monthlyIncome: latestIncomeValueRef.current,
        useOverride: checked,
      });
    }, 100);
  }, [saveIncomeMutation]);

  const toggleCategory = useCallback((cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const isSaving = saveBudgetMutation.isPending || saveIncomeMutation.isPending;
  const isLoading = entriesQuery.isLoading || incomeQuery.isLoading || categoriesLoading || comparisonQuery.isLoading;

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="budget-loading">
        <div className="grid grid-cols-2 @sm:grid-cols-4 gap-3">
          <SummaryMetricCardSkeleton />
          <SummaryMetricCardSkeleton />
          <SummaryMetricCardSkeleton />
          <SummaryMetricCardSkeleton />
        </div>
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-3 animate-pulse space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-3 w-48 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  const currentMonth = getCurrentMonth();

  const hasMonthOverrides = (month: string) => {
    return monthlyOverrides.length > 0 && selectedMonth === month;
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border/50 bg-card p-1">
            <button
              onClick={() => setSelectedMonth(null)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${isEveryMonth ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
              data-testid="button-every-month"
            >
              <Calendar className="h-3 w-3 inline mr-1" />
              Every Month
            </button>
            <div className="w-px h-4 bg-border/50" />
            <button
              onClick={() => setSelectedMonth(prev => prev || currentMonth)}
              className={`rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted/50 transition-colors ${!isEveryMonth ? "hidden" : ""}`}
              data-testid="button-pick-month"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
            {!isEveryMonth && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSelectedMonth(prev => prev ? shiftMonth(prev, -1) : currentMonth)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 transition-colors"
                  data-testid="button-prev-month"
                >
                  <ChevronLeft className="h-3 w-3" />
                </button>
                <span className="text-xs font-medium min-w-[110px] text-center" data-testid="text-selected-month">
                  {formatMonth(selectedMonth!)}
                </span>
                <button
                  onClick={() => setSelectedMonth(prev => prev ? shiftMonth(prev, 1) : currentMonth)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 transition-colors"
                  data-testid="button-next-month"
                >
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={comparisonMode} onValueChange={(v) => setComparisonMode(v as ComparisonMode)}>
            <SelectTrigger className="h-7 text-xs w-[160px]" data-testid="select-comparison-mode">
              <BarChart3 className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="this_month" data-testid="option-this-month">This Month (MTD)</SelectItem>
              <SelectItem value="last_month" data-testid="option-last-month">Last Month</SelectItem>
              <SelectItem value="trailing_avg" data-testid="option-trailing-avg">12-Month Average</SelectItem>
            </SelectContent>
          </Select>
          {saveStatus === "saving" && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-budget-saving">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving...
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="inline-flex items-center gap-1 text-xs text-success-foreground" data-testid="text-budget-saved">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
        </div>
      </div>

      {!isEveryMonth && (
        <div className="rounded-md border border-info/20 bg-info/5 px-3 py-2">
          <p className="text-xs text-info-foreground">
            Setting budget amounts for <span className="font-medium">{formatMonth(selectedMonth!)}</span>. These override the &quot;Every Month&quot; defaults for this month only.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border/50 bg-card px-4 py-2.5 flex items-center justify-between flex-wrap gap-2" data-testid="budget-income-section">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Expected Income</span>
          {useOverride ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">$</span>
              <Input
                type="number"
                step="0.01"
                value={incomeValue}
                onChange={e => handleIncomeValueChange(e.target.value)}
                onBlur={handleIncomeBlurOrEnter}
                onKeyDown={e => { if (e.key === "Enter") handleIncomeBlurOrEnter(); }}
                className="h-7 text-xs max-w-[140px]"
                placeholder="Monthly income"
                data-testid="input-income-override"
              />
              <span className="text-xs text-muted-foreground">/ mo</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-foreground tabular-nums" data-testid="text-auto-income">
                {formatCurrency(effectiveMonthlyIncome)}
              </span>
              <span className="text-xs text-muted-foreground">
                / mo ({incomeFromSources?.hasIncomeSources ? "from income sources" : COMPARISON_LABELS[comparisonMode]})
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Manual override</span>
          <Switch
            checked={useOverride}
            onCheckedChange={handleUseOverrideChange}
            data-testid="switch-income-override"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 @sm:grid-cols-4 gap-3" data-testid="budget-summary">
        <SummaryMetricCard
          label="Total Budget"
          value={formatCurrency(totalBudgeted)}
          secondaryValue={isEveryMonth ? "Default (all months)" : `For ${formatMonth(selectedMonth!)}`}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          testId="metric-total-budget"
        />
        <SummaryMetricCard
          label="Expected Income"
          value={formatCurrency(effectiveMonthlyIncome)}
          secondaryValue={useOverride ? "Manual override" : (incomeFromSources?.hasIncomeSources ? "From income sources" : COMPARISON_LABELS[comparisonMode])}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          testId="metric-expected-income"
        />
        <SummaryMetricCard
          label="Projected Savings"
          value={formatCurrency(projectedSavings)}
          secondaryValue={projectedSavings >= 0 ? "Surplus" : "Deficit"}
          icon={<PiggyBank className="h-3.5 w-3.5" />}
          testId="metric-projected-savings"
        />
        <SummaryMetricCard
          label="Savings Rate"
          value={`${projectedSavingsRate.toFixed(1)}%`}
          secondaryValue={projectedSavingsRate >= 20 ? "On track" : "Below 20% target"}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          testId="metric-savings-rate"
        />
      </div>

      <div data-testid="budget-comparison-table">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Budget vs. Actual ({COMPARISON_LABELS[comparisonMode]}{comparisonMode === "trailing_avg" && comparison?.monthsWithData ? ` — ${comparison.monthsWithData} mo. of data` : ""})
          </h4>
          {!isEveryMonth && (
            <span className="text-xs text-muted-foreground">
              Showing {formatMonth(selectedMonth!)} budget
            </span>
          )}
        </div>
        <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
          <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 px-3 py-2 border-b border-border/50 bg-muted/30">
            <span className="text-xs font-medium text-muted-foreground uppercase">Category</span>
            <span className="text-xs font-medium text-muted-foreground uppercase text-right">Budget</span>
            <span className="text-xs font-medium text-muted-foreground uppercase text-right">Actual</span>
            <span className="text-xs font-medium text-muted-foreground uppercase text-right">Difference</span>
          </div>

          <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 items-center px-3 py-2 border-b border-border/50 bg-success/5" data-testid="budget-row-income">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-foreground font-medium">Income</span>
              <span className="text-xs text-muted-foreground">
                {useOverride ? "Manual override" : (incomeFromSources?.hasIncomeSources ? "From income sources" : "From transactions")}
              </span>
            </div>
            <span className="text-xs font-medium tabular-nums text-foreground text-right" data-testid="text-budgeted-income">
              {formatCurrency(effectiveMonthlyIncome)}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground text-right" data-testid="text-actual-income">
              {formatCurrency(comparison?.income || 0)}
            </span>
            <span className={`text-xs tabular-nums text-right ${(comparison?.income || 0) >= effectiveMonthlyIncome ? "text-success-foreground" : "text-error-foreground"}`} data-testid="text-diff-income">
              {(comparison?.income || 0) >= effectiveMonthlyIncome ? "+" : ""}{formatCurrency((comparison?.income || 0) - effectiveMonthlyIncome)}
            </span>
          </div>

          {BUDGET_CATEGORIES.map(cat => {
            const budgeted = budgetMap[cat] || 0;
            const actual = comparison?.spendingByCategory[cat] || 0;
            const diff = budgeted - actual;
            const diffColor = diff >= 0 ? "text-success-foreground" : "text-error-foreground";
            const defaultAmount = entries.find(e => e.category === cat)?.monthlyAmount || 0;
            const isOverridden = !isEveryMonth && localAmounts[cat] !== undefined && parseFloat(localAmounts[cat] || "0") !== defaultAmount;
            const isExpanded = expandedCategories.has(cat);

            return (
              <div key={cat} data-testid={`budget-row-${cat}`}>
                <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 items-center px-3 py-2 border-b border-border/30 last:border-b-0">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleCategory(cat)}
                        className="flex items-center gap-1 hover:text-primary transition-colors"
                        data-testid={`button-expand-${cat}`}
                      >
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        <span className="text-xs text-foreground">{categoryLabels[cat] || humanCategory(cat)}</span>
                      </button>
                      {isOverridden && (
                        <span className="text-xs px-1 py-0.5 rounded bg-info/10 text-info-foreground">
                          override
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-4">
                      <span className="text-xs text-muted-foreground">$</span>
                      <Input
                        type="number"
                        step="0.01"
                        value={localAmounts[cat] || ""}
                        onChange={e => handleBudgetAmountChange(cat, e.target.value)}
                        onBlur={handleBudgetBlurOrEnter}
                        onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
                        className="h-6 text-xs w-20 px-1"
                        placeholder="0"
                        data-testid={`input-budget-${cat}`}
                      />
                      <span className="text-xs text-muted-foreground">/mo</span>
                    </div>
                  </div>
                  <span className="text-xs font-medium tabular-nums text-foreground text-right" data-testid={`text-budgeted-${cat}`}>
                    {formatCurrency(budgeted)}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground text-right" data-testid={`text-actual-${cat}`}>
                    {formatCurrency(actual)}
                  </span>
                  <span className={`text-xs tabular-nums text-right ${diffColor}`} data-testid={`text-diff-${cat}`}>
                    {diff >= 0 ? "+" : ""}{formatCurrency(diff)}
                  </span>
                </div>
                {isExpanded && (
                  <CategoryTransactions
                    category={cat}
                    comparison={comparison}
                    categoryLabel={categoryLabels[cat] || cat}
                  />
                )}
              </div>
            );
          })}

          {(comparison?.internalTransfers?.count ?? 0) > 0 && (
            <div data-testid="budget-row-internal-transfers">
              <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 items-center px-3 py-2 border-b border-border/30 bg-info/5">
                <button
                  type="button"
                  onClick={() => setInternalTransfersExpanded(v => !v)}
                  className="flex items-center gap-1.5 hover:text-primary transition-colors text-left"
                  data-testid="button-expand-internal-transfers"
                >
                  {internalTransfersExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  <RefreshCw className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-foreground">Internal Transfers</span>
                  <span className="text-xs px-1 py-0.5 rounded bg-muted text-muted-foreground" data-testid="text-internal-transfer-count">
                    {comparison!.internalTransfers!.count} matched
                  </span>
                  <span className="text-xs text-muted-foreground">excluded from totals</span>
                </button>
                <span className="text-xs tabular-nums text-muted-foreground text-right">-</span>
                <span className="text-xs tabular-nums text-muted-foreground text-right" data-testid="text-internal-transfer-net">
                  {formatCurrency(comparison!.internalTransfers!.netAmount)}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground text-right">≈ $0</span>
              </div>
              {internalTransfersExpanded && (
                <div className="px-3 py-2 bg-info/5 border-b border-border/30 text-xs text-muted-foreground">
                  In: {formatCurrency(comparison!.internalTransfers!.totalIn)} · Out: {formatCurrency(comparison!.internalTransfers!.totalOut)} · Net: {formatCurrency(comparison!.internalTransfers!.netAmount)}.
                  These are auto-paired moves between your connected accounts (or marked manually) and are excluded from income and spending so totals reflect real cash flow.
                </div>
              )}
            </div>
          )}

          {(liabilityPaymentsQuery.data?.totalLiabilityPayments ?? 0) > 0 && (
            <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 items-center px-3 py-2 border-b border-border/30 bg-warning/5" data-testid="budget-row-loan-payments">
              <div className="flex items-center gap-1.5">
                <Lock className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-foreground">Loan Payments</span>
                <span className="text-xs px-1 py-0.5 rounded bg-muted text-muted-foreground">from Liabilities</span>
              </div>
              <span className="text-xs font-medium tabular-nums text-foreground text-right" data-testid="text-budgeted-loan-payments">
                {formatCurrency(liabilityPaymentsQuery.data?.totalLiabilityPayments ?? 0)}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground text-right">-</span>
              <span className="text-xs tabular-nums text-muted-foreground text-right">-</span>
            </div>
          )}

          <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 items-center px-3 py-2 border-t border-border/50 bg-muted/20" data-testid="budget-row-expenses-total">
            <span className="text-xs font-semibold text-foreground">Expenses Total</span>
            <span className="text-xs font-semibold tabular-nums text-foreground text-right" data-testid="text-expenses-budget-total">
              {formatCurrency(totalBudgeted)}
            </span>
            <span className="text-xs font-semibold tabular-nums text-foreground text-right" data-testid="text-expenses-actual-total">
              {formatCurrency(totalActual)}
            </span>
            <span className={`text-xs font-semibold tabular-nums text-right ${totalBudgeted - totalActual >= 0 ? "text-success-foreground" : "text-error-foreground"}`} data-testid="text-expenses-diff-total">
              {totalBudgeted - totalActual >= 0 ? "+" : ""}{formatCurrency(totalBudgeted - totalActual)}
            </span>
          </div>

          <div className="grid grid-cols-[1fr_100px_100px_100px] gap-x-2 items-center px-3 py-2 border-t border-border bg-muted/40" data-testid="budget-row-total">
            <span className="text-xs font-bold text-foreground">Total (Income − Expenses)</span>
            <span className="text-xs font-bold tabular-nums text-foreground text-right" data-testid="text-total-budget">
              {formatCurrency(effectiveMonthlyIncome - totalBudgeted)}
            </span>
            <span className="text-xs font-bold tabular-nums text-foreground text-right" data-testid="text-total-actual">
              {formatCurrency((comparison?.income || 0) - totalActual)}
            </span>
            <span className={`text-xs font-bold tabular-nums text-right ${((comparison?.income || 0) - totalActual) - (effectiveMonthlyIncome - totalBudgeted) >= 0 ? "text-success-foreground" : "text-error-foreground"}`} data-testid="text-total-diff">
              {((comparison?.income || 0) - totalActual) >= (effectiveMonthlyIncome - totalBudgeted) ? "+" : ""}{formatCurrency(((comparison?.income || 0) - totalActual) - (effectiveMonthlyIncome - totalBudgeted))}
            </span>
          </div>
        </div>
      </div>

      <FutureCashEventsSection
        budgetCategories={BUDGET_CATEGORIES}
        categoryLabels={categoryLabels}
      />

      <AmortizationManager />

      <div className="grid grid-cols-2 @sm:grid-cols-4 gap-3" data-testid="budget-summary">
        <SummaryMetricCard
          label="Total Budget"
          value={formatCurrency(totalBudgeted)}
          secondaryValue={isEveryMonth ? "Default (all months)" : `For ${formatMonth(selectedMonth!)}`}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          testId="metric-total-budget"
        />
        <SummaryMetricCard
          label="Expected Income"
          value={formatCurrency(effectiveMonthlyIncome)}
          secondaryValue={useOverride ? "Manual override" : (incomeFromSources?.hasIncomeSources ? "From income sources" : COMPARISON_LABELS[comparisonMode])}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          testId="metric-expected-income"
        />
        <SummaryMetricCard
          label="Projected Savings"
          value={formatCurrency(projectedSavings)}
          secondaryValue={projectedSavings >= 0 ? "Surplus" : "Deficit"}
          icon={<PiggyBank className="h-3.5 w-3.5" />}
          testId="metric-projected-savings"
        />
        <SummaryMetricCard
          label="Savings Rate"
          value={`${projectedSavingsRate.toFixed(1)}%`}
          secondaryValue={projectedSavingsRate >= 20 ? "On track" : "Below 20% target"}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          testId="metric-savings-rate"
        />
      </div>
    </div>
  );
}

function FutureCashEventsSection({ budgetCategories, categoryLabels }: { budgetCategories: string[]; categoryLabels: Record<string, string> }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formCategory, setFormCategory] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formDate, setFormDate] = useState("");
  const [formDescription, setFormDescription] = useState("");

  const eventsQuery = useQuery<{ events: FutureCashEvent[] }>({
    queryKey: ["/api/finance/future-cash-events"],
  });

  const events = useMemo(() => {
    const list = eventsQuery.data?.events || [];
    return [...list].sort((a, b) => a.date.localeCompare(b.date));
  }, [eventsQuery.data]);

  const createMutation = useMutation({
    mutationFn: (data: { category: string; amount: number; date: string; description: string | null }) =>
      apiRequest("POST", "/api/finance/future-cash-events", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/future-cash-events"] });
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; category: string; amount: number; date: string; description: string | null }) =>
      apiRequest("PUT", `/api/finance/future-cash-events/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/future-cash-events"] });
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/future-cash-events/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/future-cash-events"] });
    },
  });

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormCategory("");
    setFormAmount("");
    setFormDate("");
    setFormDescription("");
  };

  const startEdit = (evt: FutureCashEvent) => {
    setEditingId(evt.id);
    setFormCategory(evt.category);
    setFormAmount(evt.amount.toString());
    setFormDate(evt.date);
    setFormDescription(evt.description || "");
    setShowForm(true);
  };

  const handleSubmit = () => {
    const amount = parseFloat(formAmount);
    if (!formCategory || isNaN(amount) || amount === 0 || !formDate) return;
    const payload = { category: formCategory, amount, date: formDate, description: formDescription || null };
    if (editingId !== null) {
      updateMutation.mutate({ id: editingId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const today = new Date().toISOString().split("T")[0];
  const isPastEvent = (date: string) => date < today;
  const isPending = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  return (
    <div className="rounded-lg border border-border/50 bg-card" data-testid="future-cash-events-section">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Future Cash Events</h4>
          {events.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{events.length}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => { if (showForm) resetForm(); else setShowForm(true); }}
          data-testid="button-add-future-event"
        >
          <Plus className="h-3 w-3" />
          {showForm ? "Cancel" : "Add Event"}
        </Button>
      </div>

      {showForm && (
        <div className="px-4 py-3 border-b border-border/50 bg-muted/20 space-y-2" data-testid="future-event-form">
          <div className="grid grid-cols-2 @sm:grid-cols-4 gap-2">
            <Select value={formCategory} onValueChange={setFormCategory}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-event-category">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {budgetCategories.map(cat => (
                  <SelectItem key={cat} value={cat} data-testid={`option-event-cat-${cat}`}>
                    {categoryLabels[cat] || cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">$</span>
              <Input
                type="number"
                step="0.01"
                value={formAmount}
                onChange={e => setFormAmount(e.target.value)}
                className="h-8 text-xs"
                placeholder="Amount"
                data-testid="input-event-amount"
              />
            </div>
            <Input
              type="date"
              value={formDate}
              onChange={e => setFormDate(e.target.value)}
              className="h-8 text-xs"
              data-testid="input-event-date"
            />
            <Input
              type="text"
              value={formDescription}
              onChange={e => setFormDescription(e.target.value)}
              className="h-8 text-xs"
              placeholder="Description (optional)"
              data-testid="input-event-description"
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleSubmit}
              disabled={isPending || !formCategory || !formAmount || !formDate}
              data-testid="button-save-event"
            >
              {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              {editingId !== null ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      )}

      {events.length === 0 && !showForm && (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">No future cash events yet. Add one-time expenses or inflows (use a negative amount for money coming in).</p>
        </div>
      )}

      {events.length > 0 && (
        <div className="divide-y divide-border/30">
          {events.map(evt => {
            const past = isPastEvent(evt.date);
            return (
              <div
                key={evt.id}
                className={`grid grid-cols-[1fr_80px_90px_60px] gap-x-2 items-center px-4 py-2 ${past ? "opacity-50" : ""}`}
                data-testid={`future-event-row-${evt.id}`}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-foreground truncate">{categoryLabels[evt.category] || evt.category}</span>
                    {past && (
                      <span className="text-xs px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">past</span>
                    )}
                  </div>
                  {evt.description && (
                    <span className="text-xs text-muted-foreground truncate">{evt.description}</span>
                  )}
                </div>
                <span className={`text-xs font-medium tabular-nums text-right ${evt.amount < 0 ? "text-success-foreground" : "text-foreground"}`} data-testid={`text-event-amount-${evt.id}`}>
                  {evt.amount < 0 ? `+${formatCurrency(Math.abs(evt.amount))}` : formatCurrency(evt.amount)}
                </span>
                <span className="text-xs text-muted-foreground text-right" data-testid={`text-event-date-${evt.id}`}>
                  {formatDate(evt.date)}
                </span>
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => startEdit(evt)}
                    className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                    data-testid={`button-edit-event-${evt.id}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(evt.id)}
                    className="p-1 rounded hover:bg-error/10 dark:hover:bg-error/5 text-muted-foreground hover:text-error-foreground transition-colors"
                    data-testid={`button-delete-event-${evt.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryTransactions({ category, comparison, categoryLabel }: { category: string; comparison: ComparisonData | undefined; categoryLabel: string }) {
  const transactionsQuery = useQuery<{ transactions: CategoryTransaction[] }>({
    queryKey: ["/api/finance/budget-category-transactions", category, comparison?.startDate, comparison?.endDate],
    queryFn: async () => {
      if (!comparison) return { transactions: [] };
      const res = await fetch(`/api/finance/budget-category-transactions?category=${encodeURIComponent(category)}&startDate=${comparison.startDate}&endDate=${comparison.endDate}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!comparison,
  });

  const transactions = transactionsQuery.data?.transactions || [];

  if (transactionsQuery.isLoading) {
    return (
      <div className="px-6 py-2 border-b border-border/30 bg-muted/10">
        <div className="animate-pulse space-y-1">
          <div className="h-3 w-48 bg-muted rounded" />
          <div className="h-3 w-36 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="px-6 py-2 border-b border-border/30 bg-muted/10">
        <p className="text-xs text-muted-foreground italic">No transactions in this period for {categoryLabel}</p>
      </div>
    );
  }

  return (
    <div className="border-b border-border/30 bg-muted/10" data-testid={`category-transactions-${category}`}>
      {transactions.map(txn => (
        <div key={txn.transactionId} className="grid grid-cols-[1fr_100px] gap-x-2 px-6 py-1.5 text-xs border-b border-border/20 last:border-b-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground shrink-0">{formatDate(txn.date)}</span>
            <span className="truncate text-foreground">{txn.merchantName || txn.name}</span>
          </div>
          <span className="text-right tabular-nums text-foreground">{formatCurrency(txn.amount)}</span>
        </div>
      ))}
    </div>
  );
}
