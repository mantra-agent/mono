import { useQuery, useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Wallet, DollarSign, CreditCard, PiggyBank, Landmark, AlertCircle, ArrowRight, CalendarRange } from "lucide-react";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";
import { AttentionCard, type AttentionItem } from "./attention-card";
import { CategoryBar, CategoryBarSkeleton } from "./category-bar";
import { ChangeFeedCard, ChangeFeedCardSkeleton, type ChangeFeedItemData } from "./change-feed-card";
import { FreshnessBadge } from "./freshness-badge";
import { useCategoryLabels, humanCategory } from "./category-labels";
import { TrajectorySection, type TrajectoryData } from "./trajectory-section";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatRelativeDate } from "@/lib/local-date";
import { useToast } from "@/hooks/use-toast";
import { fromCivilDate, parseDateString } from "@shared/civil-date";

// Categories considered "recurring" — large spend in these is expected and shouldn't
// be flagged as amortization candidates (rent, debt payments, regular income/transfers).
const RECURRING_CATEGORIES = new Set<string>([
  "RENT_AND_UTILITIES",
  "LOAN_PAYMENTS",
  "INCOME",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "BANK_FEES",
]);

// Category-aware default spread (months). Medical bills typically pay over 12,
// home improvements smooth over 6. Everything else defaults to 12.
function defaultSpreadFor(category: string): number {
  if (!category) return 12;
  const c = category.toUpperCase();
  if (c.includes("MEDICAL") || c.includes("HEALTHCARE")) return 12;
  if (c.includes("HOME_IMPROVEMENT") || c.includes("HOME IMPROVEMENT") || c.includes("HOME_MAINTENANCE")) return 6;
  return 12;
}

function nextMonth(d: Date): string {
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

interface AmortizationRow {
  id: number;
  transactionId: string;
  originalAmount: number;
  spreadMonths: number;
  startMonth: string;
  category: string;
  isActive: boolean;
  txnMonth: string | null;
  orphaned: boolean;
}

interface FinanceSummary {
  netWorth: number;
  savingsRate: number | null;
  spendingByCategory: Record<string, number>;
  investmentAllocation: Record<string, number>;
  recurringObligations: number;
  totalAssets: number;
  totalLiabilities: number;
  accountCount: number;
  manualAssetTotal: number;
  manualLiabilityTotal: number;
  plaidAssetTotal: number;
  plaidLiabilityTotal: number;
  trajectory?: TrajectoryData | null;
}

interface PlaidAccountItem {
  accountId: string;
  itemId: string;
  institutionName: string;
  healthy: boolean;
  accounts: Array<{
    accountId: string;
    name: string;
    type: string;
    subtype: string | null;
    currentBalance: number | null;
    availableBalance: number | null;
    lastUpdated: string | null;
  }>;
}

interface PlaidTransaction {
  transactionId: string;
  accountId: string;
  date: string;
  amount: number;
  name: string;
  merchantName: string | null;
  categoryPrimary: string | null;
  pending: boolean;
}

interface ManualLiability {
  id: number;
  name: string;
  category: string;
  balance: number;
  aprPercentage: number | null;
  minimumPayment: number | null;
  nextPaymentDueDate: string | null;
  lastUpdated: string;
}

interface PlaidLiability {
  id: number;
  accountId: string;
  itemId: string;
  liabilityType: string;
  balance: number | null;
  creditLimit: number | null;
  aprPercentage: number | null;
  aprType: string | null;
  minimumPayment: number | null;
  nextPaymentDueDate: string | null;
  interestRatePercentage: number | null;
  lastUpdated: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatCurrencyFull(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatAccountType(type: string, subtype: string | null): string {
  if (subtype) {
    return subtype.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatLiabilityType(type: string): string {
  const labels: Record<string, string> = {
    credit: "Credit Card",
    mortgage: "Mortgage",
    student: "Student Loan",
    auto: "Auto Loan",
    personal: "Personal Loan",
  };
  return labels[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

function formatChangeFeedDate(dateStr: string): string {
  return formatRelativeDate(dateStr, {
    capitalize: true,
    fallbackAfterDays: 6,
    fallback: (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  });
}

interface FinanceHomeContentProps {
  onTabChange: (tab: string) => void;
}

export function FinanceHomeContent({ onTabChange }: FinanceHomeContentProps) {
  const { labels: catLabels } = useCategoryLabels();
  const { toast } = useToast();
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const [suggestSpread, setSuggestSpread] = useState<string>("12");
  const [suggestStartMonth, setSuggestStartMonth] = useState<string>("");
  const humanCategory = useCallback((cat: string) => {
    return catLabels[cat] || cat.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
  }, [catLabels]);

  const summaryQuery = useQuery<FinanceSummary>({
    queryKey: ["/api/finance/summary"],
  });

  const amortizationsQuery = useQuery<{ amortizations: AmortizationRow[] }>({
    queryKey: ["/api/finance/amortizations"],
  });
  const activeAmortizations = useMemo(
    () => (amortizationsQuery.data?.amortizations || []).filter(a => a.isActive && !a.orphaned),
    [amortizationsQuery.data?.amortizations],
  );
  const amortizedTxnIds = useMemo(
    () => new Set(activeAmortizations.map(a => a.transactionId)),
    [activeAmortizations],
  );

  const amortizeMutation = useMutation({
    mutationFn: async (payload: { transactionId: string; originalAmount: number; spreadMonths: number; startMonth: string; category: string }) => {
      return apiRequest("POST", "/api/finance/amortizations", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/amortizations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-comparison"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      toast({ title: "Spread applied", description: "This expense will now be amortized in your budget and forecast." });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't apply spread", description: err?.message || "Try again from the Transactions tab.", variant: "destructive" });
    },
  });

  const accountsQuery = useQuery<PlaidAccountItem[]>({
    queryKey: ["/api/plaid/accounts"],
  });

  const transactionsQuery = useQuery<{ transactions: PlaidTransaction[] }>({
    queryKey: ["/api/plaid/transactions"],
  });

  const manualLiabilitiesQuery = useQuery<{ liabilities: ManualLiability[] }>({
    queryKey: ["/api/finance/manual-liabilities"],
  });

  const plaidLiabilitiesQuery = useQuery<{ liabilities: PlaidLiability[] }>({
    queryKey: ["/api/plaid/liabilities"],
  });

  const summary = summaryQuery.data;
  const accounts = accountsQuery.data || [];
  const transactions = transactionsQuery.data?.transactions || [];
  const manualLiabilities = manualLiabilitiesQuery.data?.liabilities || [];
  const plaidLiabilities = plaidLiabilitiesQuery.data?.liabilities || [];

  const isLoading = summaryQuery.isLoading;
  const isTransactionsLoading = transactionsQuery.isLoading;
  const hasError = summaryQuery.isError;
  const hasAccountsError = accountsQuery.isError;
  const hasTransactionsError = transactionsQuery.isError;
  const hasLiabilitiesError = manualLiabilitiesQuery.isError || plaidLiabilitiesQuery.isError;
  const hasNoData = !isLoading && summary?.accountCount === 0 && (summary?.manualAssetTotal === 0) && (summary?.manualLiabilityTotal === 0);

  const handleGoToTransactions = useCallback(() => onTabChange("transactions"), [onTabChange]);
  const handleGoToTransactionsWithFilter = useCallback((category: string) => {
    onTabChange("transactions");
    const url = new URL(window.location.href);
    url.searchParams.set("category", category);
    window.history.replaceState({}, "", url.toString());
  }, [onTabChange]);
  const handleGoToAccounts = useCallback(() => onTabChange("accounts"), [onTabChange]);
  const handleGoToLiabilities = useCallback(() => onTabChange("liabilities"), [onTabChange]);

  const liquidCash = useMemo(() => accounts.reduce((sum, item) => {
    return sum + item.accounts
      .filter(a => a.type === "depository")
      .reduce((s, a) => s + (a.availableBalance ?? a.currentBalance ?? 0), 0);
  }, 0), [accounts]);

  const newestAccountUpdate = useMemo(() => {
    let newest: string | null = null;
    for (const item of accounts) {
      for (const acct of item.accounts) {
        if (acct.lastUpdated && (!newest || new Date(acct.lastUpdated) > new Date(newest))) {
          newest = acct.lastUpdated;
        }
      }
    }
    return newest;
  }, [accounts]);

  const newestTransactionDate = useMemo(() => {
    if (transactions.length === 0) return null;
    return transactions.reduce((latest, t) => {
      return !latest || t.date > latest ? t.date : latest;
    }, "" as string);
  }, [transactions]);

  const activityQuery = useQuery<{ lastActivityAt: string | null }>({
    queryKey: ["/api/finance/activity"],
    refetchInterval: 30000,
  });

  const newestLiabilityUpdate = useMemo(() => {
    let latest: string | null = null;
    for (const l of manualLiabilities) {
      if (!latest || new Date(l.lastUpdated) > new Date(latest)) latest = l.lastUpdated;
    }
    for (const l of plaidLiabilities) {
      if (!latest || new Date(l.lastUpdated) > new Date(latest)) latest = l.lastUpdated;
    }
    return latest;
  }, [manualLiabilities, plaidLiabilities]);

  const newestSyncActivity = useMemo(() => {
    const candidates: number[] = [];
    if (newestAccountUpdate) candidates.push(new Date(newestAccountUpdate).getTime());
    if (newestLiabilityUpdate) candidates.push(new Date(newestLiabilityUpdate).getTime());
    if (activityQuery.data?.lastActivityAt) candidates.push(new Date(activityQuery.data.lastActivityAt).getTime());
    const valid = candidates.filter(n => Number.isFinite(n));
    if (valid.length === 0) return null;
    return new Date(Math.max(...valid)).toISOString();
  }, [newestAccountUpdate, newestLiabilityUpdate, activityQuery.data?.lastActivityAt]);

  const { currentPeriodSpending, priorPeriodSpending, currentTotalSpending, priorTotalSpending, currentTotalIncome, priorTotalIncome } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);

    const current: Record<string, number> = {};
    const prior: Record<string, number> = {};
    let curSpend = 0, priorSpend = 0, curIncome = 0, priorIncome = 0;

    for (const txn of transactions) {
      const txnDate = fromCivilDate(txn.date);
      if (txnDate >= thirtyDaysAgo) {
        if (txn.amount > 0) {
          const cat = txn.categoryPrimary || "UNCATEGORIZED";
          current[cat] = (current[cat] || 0) + txn.amount;
          curSpend += txn.amount;
        } else {
          curIncome += Math.abs(txn.amount);
        }
      } else if (txnDate >= sixtyDaysAgo && txnDate < thirtyDaysAgo) {
        if (txn.amount > 0) {
          const cat = txn.categoryPrimary || "UNCATEGORIZED";
          prior[cat] = (prior[cat] || 0) + txn.amount;
          priorSpend += txn.amount;
        } else {
          priorIncome += Math.abs(txn.amount);
        }
      }
    }

    return {
      currentPeriodSpending: current,
      priorPeriodSpending: prior,
      currentTotalSpending: curSpend,
      priorTotalSpending: priorSpend,
      currentTotalIncome: curIncome,
      priorTotalIncome: priorIncome,
    };
  }, [transactions]);

  const savingsRateAnnual = useMemo(() => {
    if (currentTotalIncome === 0) return null;
    const rate30d = ((currentTotalIncome - currentTotalSpending) / currentTotalIncome) * 100;
    return rate30d;
  }, [currentTotalIncome, currentTotalSpending]);

  const netWorthDelta = useMemo(() => {
    if (priorTotalSpending === 0 && priorTotalIncome === 0) return undefined;
    const priorNet = priorTotalIncome - priorTotalSpending;
    const currentNet = currentTotalIncome - currentTotalSpending;
    if (priorNet === 0) return undefined;
    return ((currentNet - priorNet) / Math.abs(priorNet)) * 100;
  }, [currentTotalIncome, currentTotalSpending, priorTotalIncome, priorTotalSpending]);

  const spendingDelta = useMemo(() => {
    if (priorTotalSpending === 0) return undefined;
    return ((currentTotalSpending - priorTotalSpending) / priorTotalSpending) * 100;
  }, [currentTotalSpending, priorTotalSpending]);

  const changeFeed = useMemo(() =>
    buildChangeFeed(transactions, accounts, manualLiabilities),
    [transactions, accounts, manualLiabilities]
  );

  const attentionItems = useMemo(() =>
    buildAttentionItems(accounts, manualLiabilities, transactions, plaidLiabilities),
    [accounts, manualLiabilities, transactions, plaidLiabilities]
  );

  // Amortization candidates: transactions > $500 in non-recurring categories from
  // the last 30 days that haven't already been amortized or dismissed by the user.
  const amortizationCandidates = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    return transactions
      .filter(t => {
        if (t.amount <= 500 || t.pending) return false;
        if (amortizedTxnIds.has(t.transactionId)) return false;
        if (dismissedSuggestions.has(t.transactionId)) return false;
        const cat = t.categoryPrimary || "UNCATEGORIZED";
        if (RECURRING_CATEGORIES.has(cat)) return false;
        const txnDate = fromCivilDate(t.date);
        return txnDate >= thirtyDaysAgo;
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3);
  }, [transactions, amortizedTxnIds, dismissedSuggestions]);

  const handleExpandSuggestion = useCallback((txn: PlaidTransaction) => {
    if (expandedSuggestion === txn.transactionId) {
      setExpandedSuggestion(null);
      return;
    }
    const cat = txn.categoryPrimary || "UNCATEGORIZED";
    setSuggestSpread(String(defaultSpreadFor(cat)));
    // Default the spread to start in the txn's own month so the active month
    // includes its first slice (and the lump is offset there). The user can
    // still pick a later start before applying.
    const txnMonth = (txn.date || "").substring(0, 7);
    setSuggestStartMonth(/^\d{4}-\d{2}$/.test(txnMonth) ? txnMonth : nextMonth(new Date()));
    setExpandedSuggestion(txn.transactionId);
  }, [expandedSuggestion]);

  const handleApplySuggestion = useCallback((txn: PlaidTransaction) => {
    const sm = parseInt(suggestSpread);
    if (isNaN(sm) || sm < 1 || sm > 120) {
      toast({ title: "Spread must be 1-120 months", variant: "destructive" });
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(suggestStartMonth)) {
      toast({ title: "Start month must be YYYY-MM", variant: "destructive" });
      return;
    }
    amortizeMutation.mutate(
      {
        transactionId: txn.transactionId,
        originalAmount: txn.amount,
        spreadMonths: sm,
        startMonth: suggestStartMonth,
        category: txn.categoryPrimary || "UNCATEGORIZED",
      },
      { onSuccess: () => setExpandedSuggestion(null) },
    );
  }, [suggestSpread, suggestStartMonth, amortizeMutation, toast]);

  const handleDismissCandidate = useCallback((txnId: string) => {
    setDismissedSuggestions(prev => {
      const next = new Set(prev);
      next.add(txnId);
      return next;
    });
  }, []);

  // Spending Snapshot: apply active amortization overlay so the home view reflects
  // smoothed spend rather than raw lump sums. Uses the same semantics as the server
  // helper: always subtract the lump when the txn month falls in the trailing 30-day
  // window (independent of where the spread starts), and add the monthly slice when
  // the current month is covered by the spread.
  const { topCategories, maxCategoryAmount, amortizationAdjustmentCount, amortizationAdjustmentTotal } = useMemo(() => {
    const raw = { ...(summary?.spendingByCategory || {}) };
    const adjusted: Record<string, number> = { ...raw };

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    let count = 0;
    let totalAdjustment = 0;

    function monthsBetweenInclusive(startMonth: string, spread: number): string[] {
      const out: string[] = [];
      const [y, m] = startMonth.split("-").map(Number);
      for (let i = 0; i < spread; i++) {
        const d = new Date(y, m - 1 + i, 1);
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      return out;
    }

    for (const a of activeAmortizations) {
      const months = monthsBetweenInclusive(a.startMonth, a.spreadMonths);
      // Subtract the lump if the original txn fell within the 30-day window
      if (a.txnMonth) {
        const txnDate = fromCivilDate(`${a.txnMonth}-15`);
        if (txnDate >= thirtyDaysAgo) {
          adjusted[a.category] = (adjusted[a.category] || 0) - a.originalAmount;
          totalAdjustment -= a.originalAmount;
        }
      }
      // Add the monthly slice if the current month is covered by the spread
      if (months.includes(currentMonth)) {
        const slice = a.originalAmount / a.spreadMonths;
        adjusted[a.category] = (adjusted[a.category] || 0) + slice;
        totalAdjustment += slice;
      }
      count += 1;
    }
    for (const k of Object.keys(adjusted)) {
      if (Math.abs(adjusted[k]) < 0.005) delete adjusted[k];
    }

    const top = Object.entries(adjusted)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const max = top.length > 0 ? top[0][1] : 0;
    return {
      topCategories: top,
      maxCategoryAmount: max,
      amortizationAdjustmentCount: count,
      amortizationAdjustmentTotal: totalAdjustment,
    };
  }, [summary?.spendingByCategory, activeAmortizations]);

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="finance-error-state">
        <AlertCircle className="h-8 w-8 text-destructive mb-3" />
        <h2 className="text-lg font-semibold text-foreground mb-1">Unable to load finance data</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          There was a problem fetching your financial data. Please try refreshing the page.
        </p>
      </div>
    );
  }

  if (hasNoData) {
    return <EmptyState onGoToAccounts={handleGoToAccounts} />;
  }

  return (
    <div className="flex flex-col gap-6 p-4 pb-8">
      <TrajectorySection
        data={summary?.trajectory ?? null}
        isLoading={isLoading}
        humanCategory={humanCategory}
        onViewForecast={() => onTabChange("forecast")}
      />

      <section data-testid="section-change-feed">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">What Changed</h3>
          <FreshnessBadge lastUpdated={newestSyncActivity || newestAccountUpdate} />
        </div>
        {isTransactionsLoading ? (
          <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
            <ChangeFeedCardSkeleton />
            <ChangeFeedCardSkeleton />
            <ChangeFeedCardSkeleton />
          </div>
        ) : hasTransactionsError ? (
          <SectionError message="Unable to load recent changes." testId="error-change-feed" />
        ) : changeFeed.length > 0 ? (
          <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
            {changeFeed.map(item => (
              <ChangeFeedCard
                key={item.id}
                item={item}
                onClick={() => {
                  if (item.link?.tab) {
                    if (item.link.filter) {
                      handleGoToTransactionsWithFilter(item.link.filter);
                    } else {
                      onTabChange(item.link.tab);
                    }
                  }
                }}
                testId={`change-feed-${item.id}`}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 bg-card px-3 py-4">
            <p className="text-xs text-muted-foreground text-center">No notable changes in the last 7 days.</p>
          </div>
        )}
      </section>

      {(attentionItems.length > 0 || amortizationCandidates.length > 0) && (
        <section data-testid="section-attention">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Needs Attention</h3>
          <div className="flex flex-col gap-2">
            {amortizationCandidates.map(txn => (
              <AmortizeSuggestionCard
                key={`amortize-${txn.transactionId}`}
                txn={txn}
                humanCategory={humanCategory}
                isPending={amortizeMutation.isPending}
                isExpanded={expandedSuggestion === txn.transactionId}
                spread={suggestSpread}
                startMonth={suggestStartMonth}
                onSpreadChange={setSuggestSpread}
                onStartMonthChange={setSuggestStartMonth}
                onToggle={() => handleExpandSuggestion(txn)}
                onApply={() => handleApplySuggestion(txn)}
                onDismiss={() => handleDismissCandidate(txn.transactionId)}
              />
            ))}
            {attentionItems.map(item => (
              <AttentionCard
                key={item.id}
                item={item}
                onClick={
                  item.link === "accounts" ? handleGoToAccounts
                  : item.link === "liabilities" ? handleGoToLiabilities
                  : item.link === "transactions" ? handleGoToTransactions
                  : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      <section data-testid="section-spending">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Spending Snapshot</h3>
            {amortizationAdjustmentCount > 0 && (
              <span
                className="text-xs px-1.5 py-0.5 rounded-full bg-info/5 text-info-foreground border border-info/20 inline-flex items-center gap-1"
                title={`Spend smoothed by ${amortizationAdjustmentTotal >= 0 ? "+" : "-"}$${Math.abs(Math.round(amortizationAdjustmentTotal)).toLocaleString()} via amortization overlay`}
                data-testid="badge-amortization-applied"
              >
                <CalendarRange className="h-2.5 w-2.5" />
                {amortizationAdjustmentCount} amortization{amortizationAdjustmentCount > 1 ? "s" : ""} applied
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <FreshnessBadge lastUpdated={newestSyncActivity || newestAccountUpdate} />
            <button
              type="button"
              onClick={handleGoToTransactions}
              className="text-xs text-primary flex items-center gap-1 hover:underline"
              data-testid="link-view-transactions"
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
        {isLoading || isTransactionsLoading ? (
          <div className="rounded-lg border border-border/50 bg-card p-3 flex flex-col">
            <CategoryBarSkeleton />
            <CategoryBarSkeleton />
            <CategoryBarSkeleton />
            <CategoryBarSkeleton />
            <CategoryBarSkeleton />
          </div>
        ) : hasTransactionsError ? (
          <SectionError message="Unable to load spending data." testId="error-spending" />
        ) : topCategories.length > 0 ? (
          <div className="rounded-lg border border-border/50 bg-card p-3 flex flex-col">
            {topCategories.map(([cat, amount]) => {
              const priorAmount = priorPeriodSpending[cat] || 0;
              const delta = priorAmount > 0 ? ((amount - priorAmount) / priorAmount) * 100 : undefined;
              return (
                <CategoryBar
                  key={cat}
                  category={cat}
                  amount={amount}
                  annualized={amount * 12}
                  maxAmount={maxCategoryAmount}
                  delta={delta}
                  onClick={() => handleGoToTransactionsWithFilter(cat)}
                  testId={`category-${cat.toLowerCase()}`}
                />
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 bg-card px-3 py-4">
            <p className="text-xs text-muted-foreground text-center">No spending data available yet.</p>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 @md:grid-cols-2 gap-4">
        <section data-testid="section-accounts-snapshot">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Accounts</h3>
            <div className="flex items-center gap-2">
              <FreshnessBadge lastUpdated={newestAccountUpdate} />
              <button
                type="button"
                onClick={handleGoToAccounts}
                className="text-xs text-primary flex items-center gap-1 hover:underline"
                data-testid="link-view-accounts"
              >
                Manage <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-border/50 bg-card p-3">
            {accountsQuery.isLoading ? (
              <div className="space-y-2 animate-pulse">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-3 w-48 bg-muted rounded" />
                <div className="h-3 w-40 bg-muted rounded" />
              </div>
            ) : hasAccountsError ? (
              <SectionError message="Unable to load accounts." testId="error-accounts" />
            ) : accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No accounts connected yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {accounts.map(item => (
                  <div key={item.accountId} className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Landmark className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-xs font-medium text-foreground">{item.institutionName}</span>
                      {!item.healthy && <AlertCircle className="h-3 w-3 text-warning shrink-0" />}
                    </div>
                    {item.accounts.map(acct => (
                      <div key={acct.accountId} className="flex items-center justify-between pl-5 text-xs gap-2" data-testid={`account-${acct.accountId}`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-foreground truncate">{acct.name}</span>
                          <span className="text-muted-foreground/60 text-xs shrink-0">{formatAccountType(acct.type, acct.subtype)}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-foreground font-medium">{formatCurrencyFull(acct.currentBalance ?? 0)}</span>
                          <FreshnessBadge lastUpdated={acct.lastUpdated} className="hidden @sm:inline-flex" />
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section data-testid="section-debt-snapshot">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Debt</h3>
            <div className="flex items-center gap-2">
              <FreshnessBadge lastUpdated={newestLiabilityUpdate} />
              <button
                type="button"
                onClick={handleGoToLiabilities}
                className="text-xs text-primary flex items-center gap-1 hover:underline"
                data-testid="link-view-liabilities"
              >
                Details <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-border/50 bg-card p-3">
            {isLoading || manualLiabilitiesQuery.isLoading || plaidLiabilitiesQuery.isLoading ? (
              <div className="space-y-2 animate-pulse">
                <div className="h-5 w-24 bg-muted rounded" />
                <div className="h-3 w-40 bg-muted rounded" />
              </div>
            ) : hasLiabilitiesError ? (
              <SectionError message="Unable to load liabilities." testId="error-debt" />
            ) : (summary?.totalLiabilities ?? 0) === 0 && manualLiabilities.length === 0 && plaidLiabilities.length === 0 ? (
              <p className="text-xs text-muted-foreground">No liabilities recorded.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Total Debt</span>
                  <span className="text-sm font-semibold text-foreground">{formatCurrency(summary?.totalLiabilities ?? 0)}</span>
                </div>
                {plaidLiabilities.map(liability => (
                  <div key={`plaid-${liability.id}`} className="flex items-center justify-between text-xs pl-2 border-l-2 border-border gap-2" data-testid={`debt-plaid-${liability.id}`}>
                    <div className="flex flex-col min-w-0">
                      <span className="text-foreground truncate">{formatLiabilityType(liability.liabilityType)}</span>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        {liability.aprPercentage !== null && <span>{liability.aprPercentage}% APR</span>}
                        {liability.nextPaymentDueDate && (
                          <>
                            {liability.aprPercentage !== null && <span>·</span>}
                            <span>Due {formatChangeFeedDate(liability.nextPaymentDueDate)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <span className="text-foreground font-medium">{formatCurrencyFull(liability.balance ?? 0)}</span>
                      {liability.minimumPayment !== null && (
                        <span className="text-muted-foreground">{formatCurrency(liability.minimumPayment)}/mo min</span>
                      )}
                    </div>
                  </div>
                ))}
                {manualLiabilities.map(liability => (
                  <div key={`manual-${liability.id}`} className="flex items-center justify-between text-xs pl-2 border-l-2 border-border gap-2" data-testid={`debt-manual-${liability.id}`}>
                    <div className="flex flex-col min-w-0">
                      <span className="text-foreground truncate">{liability.name}</span>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        {liability.aprPercentage !== null && <span>{liability.aprPercentage}% APR</span>}
                        {liability.nextPaymentDueDate && (
                          <>
                            {liability.aprPercentage !== null && <span>·</span>}
                            <span>Due {formatChangeFeedDate(liability.nextPaymentDueDate)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <span className="text-foreground font-medium">{formatCurrencyFull(liability.balance)}</span>
                      {liability.minimumPayment !== null && (
                        <span className="text-muted-foreground">{formatCurrency(liability.minimumPayment)}/mo min</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <section data-testid="section-recent-transactions">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Transactions</h3>
          <div className="flex items-center gap-2">
            <FreshnessBadge lastUpdated={newestTransactionDate} />
            <button
              type="button"
              onClick={handleGoToTransactions}
              className="text-xs text-primary flex items-center gap-1 hover:underline"
              data-testid="link-view-all-transactions"
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
        {isTransactionsLoading ? (
          <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center justify-between px-3 py-2 animate-pulse">
                <div className="flex flex-col gap-1">
                  <div className="h-3 w-28 bg-muted rounded" />
                  <div className="h-2.5 w-16 bg-muted rounded" />
                </div>
                <div className="h-3 w-14 bg-muted rounded" />
              </div>
            ))}
          </div>
        ) : hasTransactionsError ? (
          <SectionError message="Unable to load transactions." testId="error-transactions" />
        ) : transactions.length > 0 ? (
          <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
            {transactions.slice(0, 8).map(txn => (
              <div key={txn.transactionId} className="flex items-center justify-between px-3 py-2 text-xs" data-testid={`txn-${txn.transactionId}`}>
                <div className="flex flex-col min-w-0">
                  <span className="text-foreground truncate">{txn.merchantName || txn.name}</span>
                  <span className="text-muted-foreground">{txn.date}{txn.pending ? " · Pending" : ""}</span>
                </div>
                <span className={`font-medium shrink-0 ${txn.amount < 0 ? "text-success-foreground" : "text-foreground"}`}>
                  {txn.amount < 0 ? "+" : "-"}{formatCurrencyFull(Math.abs(txn.amount))}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 bg-card px-3 py-4">
            <p className="text-xs text-muted-foreground text-center">No transactions yet.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function buildChangeFeed(
  transactions: PlaidTransaction[],
  accounts: PlaidAccountItem[],
  _manualLiabilities: ManualLiability[],
): ChangeFeedItemData[] {
  const items: ChangeFeedItemData[] = [];

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const recentTxns = transactions.filter(t => fromCivilDate(t.date) >= sevenDaysAgo);
  const largeInflows = recentTxns.filter(t => t.amount < -200);
  const largeOutflows = recentTxns.filter(t => t.amount > 200);

  if (largeInflows.length > 0) {
    const totalInflow = largeInflows.reduce((s, t) => s + Math.abs(t.amount), 0);
    items.push({
      id: "large-inflows",
      icon: "up",
      title: `${formatCurrency(totalInflow)} received`,
      description: largeInflows.slice(0, 3).map(t => t.merchantName || t.name).join(", "),
      timestamp: formatChangeFeedDate(largeInflows[0].date),
      link: { tab: "transactions" },
    });
  }

  if (largeOutflows.length > 0) {
    const totalOutflow = largeOutflows.reduce((s, t) => s + t.amount, 0);
    items.push({
      id: "large-outflows",
      icon: "down",
      title: `${formatCurrency(totalOutflow)} spent`,
      description: largeOutflows.slice(0, 3).map(t => t.merchantName || t.name).join(", "),
      timestamp: formatChangeFeedDate(largeOutflows[0].date),
      link: { tab: "transactions" },
    });
  }

  const categorySpending: Record<string, number> = {};
  for (const txn of recentTxns) {
    if (txn.amount > 0) {
      const cat = txn.categoryPrimary || "UNCATEGORIZED";
      categorySpending[cat] = (categorySpending[cat] || 0) + txn.amount;
    }
  }
  const topCat = Object.entries(categorySpending).sort((a, b) => b[1] - a[1])[0];
  if (topCat && topCat[1] > 100) {
    items.push({
      id: "top-category",
      icon: "info",
      title: `Top spending: ${humanCategory(topCat[0])}`,
      description: `${formatCurrency(topCat[1])} in the last 7 days`,
      timestamp: "This week",
      link: { tab: "transactions", filter: topCat[0] },
    });
  }

  const unhealthyAccounts = accounts.filter(a => !a.healthy);
  if (unhealthyAccounts.length > 0) {
    items.push({
      id: "stale-data",
      icon: "alert",
      title: "Data may be stale",
      description: `${unhealthyAccounts.map(a => a.institutionName).join(", ")} connection needs attention`,
      timestamp: "Now",
      link: { tab: "accounts" },
    });
  }

  return items.slice(0, 5);
}

function buildAttentionItems(
  accounts: PlaidAccountItem[],
  manualLiabilities: ManualLiability[],
  transactions: PlaidTransaction[],
  plaidLiabs: PlaidLiability[] = [],
): AttentionItem[] {
  const items: AttentionItem[] = [];

  const unhealthyItems = accounts.filter(a => !a.healthy);
  if (unhealthyItems.length > 0) {
    items.push({
      id: "stale-sync",
      severity: "warning",
      title: "Connection Issue",
      description: `${unhealthyItems.map(i => i.institutionName).join(", ")} ${unhealthyItems.length === 1 ? "needs" : "need"} reconnection.`,
      action: "Reconnect in Accounts",
      link: "accounts",
    });
  }

  const now = new Date();
  const upcomingManual = manualLiabilities.filter(l => {
    if (!l.nextPaymentDueDate) return false;
    const due = parseDateString(l.nextPaymentDueDate);
    const diff = due.getTime() - now.getTime();
    return diff > 0 && diff < 7 * 86400000;
  });
  const upcomingPlaid = plaidLiabs.filter(l => {
    if (!l.nextPaymentDueDate) return false;
    const due = parseDateString(l.nextPaymentDueDate);
    const diff = due.getTime() - now.getTime();
    return diff > 0 && diff < 7 * 86400000;
  });

  const upcomingDescriptions = [
    ...upcomingManual.map(p => `${p.name} (${formatCurrency(p.minimumPayment ?? p.balance)})`),
    ...upcomingPlaid.map(p => `${formatLiabilityType(p.liabilityType)} (${formatCurrency(p.minimumPayment ?? p.balance ?? 0)})`),
  ];

  if (upcomingDescriptions.length > 0) {
    items.push({
      id: "upcoming-payments",
      severity: "info",
      title: "Upcoming Payments",
      description: `${upcomingDescriptions.join(", ")} due this week.`,
      action: "View Liabilities",
      link: "liabilities",
    });
  }

  const recentLarge = transactions.filter(t => {
    if (t.amount <= 500 || t.pending) return false;
    const txnDate = fromCivilDate(t.date);
    const now = new Date();
    return (now.getTime() - txnDate.getTime()) < 3 * 86400000;
  });
  if (recentLarge.length > 0) {
    items.push({
      id: "large-transactions",
      severity: "info",
      title: `${recentLarge.length} Large Transaction${recentLarge.length > 1 ? "s" : ""}`,
      description: recentLarge.slice(0, 3).map(t => `${t.merchantName || t.name}: ${formatCurrency(Math.abs(t.amount))}`).join(", "),
      action: "Review in Transactions",
      link: "transactions",
    });
  }

  return items;
}

function AmortizeSuggestionCard({
  txn,
  humanCategory,
  isPending,
  isExpanded,
  spread,
  startMonth,
  onSpreadChange,
  onStartMonthChange,
  onToggle,
  onApply,
  onDismiss,
}: {
  txn: PlaidTransaction;
  humanCategory: (cat: string) => string;
  isPending: boolean;
  isExpanded: boolean;
  spread: string;
  startMonth: string;
  onSpreadChange: (v: string) => void;
  onStartMonthChange: (v: string) => void;
  onToggle: () => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const cat = txn.categoryPrimary || "UNCATEGORIZED";
  const suggested = defaultSpreadFor(cat);
  const previewSpread = parseInt(spread);
  const monthlySlice = !isNaN(previewSpread) && previewSpread > 0 ? txn.amount / previewSpread : txn.amount / suggested;
  return (
    <div
      className="rounded-lg border border-info/20 bg-info/5 p-3"
      data-testid={`amortize-suggestion-${txn.transactionId}`}
    >
      <div className="flex items-start gap-3">
        <CalendarRange className="h-4 w-4 mt-0.5 shrink-0 text-info-foreground" />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground">
            One-time {formatCurrency(txn.amount)} expense — spread it?
          </span>
          <span className="text-xs text-muted-foreground">
            {txn.merchantName || txn.name} · {humanCategory(cat)} · {txn.date}
          </span>
          <span className="text-xs text-muted-foreground mt-1">
            Treating this as a single-month cost distorts your savings rate. Suggested: spread over {suggested} months (~{formatCurrency(txn.amount / suggested)}/mo).
          </span>
        </div>
      </div>
      {!isExpanded ? (
        <div className="flex items-center gap-2 mt-2 pl-7 flex-wrap">
          <button
            type="button"
            onClick={onToggle}
            className="h-7 px-2.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 inline-flex items-center gap-1"
            data-testid={`button-amortize-suggest-${txn.transactionId}`}
          >
            <CalendarRange className="h-3 w-3" />
            Spread over {suggested} months?
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="h-7 px-2.5 text-xs rounded-md text-muted-foreground hover:bg-muted ml-auto"
            data-testid={`button-dismiss-amortize-${txn.transactionId}`}
          >
            Dismiss
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-2 pl-7" data-testid={`amortize-suggest-form-${txn.transactionId}`}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">Spread {formatCurrency(txn.amount)} across</span>
            <input
              type="number"
              min={1}
              max={120}
              value={spread}
              onChange={e => onSpreadChange(e.target.value)}
              className="h-7 w-16 text-xs rounded-md border border-input bg-background px-1.5"
              data-testid={`input-suggest-spread-${txn.transactionId}`}
            />
            <span className="text-xs text-muted-foreground">months starting</span>
            <input
              type="month"
              value={startMonth}
              onChange={e => onStartMonthChange(e.target.value)}
              className="h-7 text-xs rounded-md border border-input bg-background px-1.5"
              data-testid={`input-suggest-start-${txn.transactionId}`}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            ≈ {formatCurrency(monthlySlice)}/mo. The original {formatCurrency(txn.amount)} comes out of {txn.date.substring(0, 7)}; slices land from {startMonth || "start"} forward.
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={isPending}
              onClick={onApply}
              className="h-7 px-2.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              data-testid={`button-confirm-suggest-${txn.transactionId}`}
            >
              Apply
            </button>
            <button
              type="button"
              onClick={onToggle}
              className="h-7 px-2.5 text-xs rounded-md text-muted-foreground hover:bg-muted"
              data-testid={`button-cancel-suggest-${txn.transactionId}`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="h-7 px-2.5 text-xs rounded-md text-muted-foreground hover:bg-muted ml-auto"
              data-testid={`button-dismiss-amortize-${txn.transactionId}`}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionError({ message, testId }: { message: string; testId: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card px-3 py-4 flex items-center gap-2" data-testid={testId}>
      <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

function EmptyState({ onGoToAccounts }: { onGoToAccounts: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="finance-empty-state">
      <div className="rounded-full bg-primary/10 p-4 mb-4">
        <Wallet className="h-8 w-8 text-primary" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-1">Welcome to Finance</h2>
      <p className="text-sm text-muted-foreground max-w-sm mb-6">
        Connect your bank accounts or add manual entries to see your complete financial picture — net worth, spending, liabilities, and goals all in one place.
      </p>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onGoToAccounts}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          data-testid="button-get-started"
        >
          <Landmark className="h-4 w-4" />
          Get Started
        </button>
        <span className="text-xs text-muted-foreground">Connect a bank or add assets manually</span>
      </div>
    </div>
  );
}
