import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, X, Calendar, Tag, ArrowUpDown, ArrowUp, ArrowDown, Upload, ChevronLeft, ChevronRight, Landmark, CalendarRange, RefreshCw, Link2, Link2Off } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useCategoryLabels } from "./category-labels";
import { CSVImportDialog } from "./csv-import-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useFocusContext } from "@/hooks/use-focus-context";
import { fromCivilDate } from "@shared/civil-date";

// Category-aware default spread length. Most lump expenses smooth nicely over a
// year; a couple of categories deserve a different default (medical bills are
// often spread 12 months on payment plans, home improvements 6 months as a
// lighter smoothing window). Users can always override before applying.
function defaultSpreadFor(category: string): number {
  if (!category) return 12;
  const c = category.toUpperCase();
  if (c.includes("MEDICAL") || c.includes("HEALTHCARE")) return 12;
  if (c.includes("HOME_IMPROVEMENT") || c.includes("HOME IMPROVEMENT") || c.includes("HOME_MAINTENANCE")) return 6;
  return 12;
}

interface PlaidTransaction {
  transactionId: string;
  accountId: string;
  date: string;
  amount: number;
  name: string;
  merchantName: string | null;
  categoryPrimary: string | null;
  effectiveCategory: string | null;
  pending: boolean;
  isInternalTransfer?: boolean;
  transferPairId?: string | null;
  transferPairSource?: string | null;
  transferCounterpart?: {
    transactionId: string;
    accountId: string;
    date: string;
    amount: number;
    name: string;
  } | null;
}

interface PairCandidate {
  transactionId: string;
  accountId: string;
  date: string;
  amount: number;
  name: string;
  merchantName: string | null;
  isInternalTransfer: boolean;
  amountDelta: number;
  dayDelta: number;
}

interface PlaidAccountItem {
  accountId: string;
  itemId: string;
  institutionName: string;
  accounts: Array<{
    accountId: string;
    name: string;
    type: string;
    currentBalance: number | null;
  }>;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatDate(date: string): string {
  return fromCivilDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const DATE_RANGES = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "6 months", days: 180 },
  { label: "1 year", days: 365 },
] as const;

const PAGE_SIZE = 50;

type SortField = "name" | "date" | "category" | "account" | "amount";
type SortDirection = "asc" | "desc";

export function TransactionsContent() {
  const { toast } = useToast();
  const [searchText, setSearchText] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [noCategoryFilter, setNoCategoryFilter] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState(30);
  const [recategorizingTxn, setRecategorizingTxn] = useState<string | null>(null);
  const [amortizingTxn, setAmortizingTxn] = useState<string | null>(null);
  const [amortSpread, setAmortSpread] = useState<string>("12");
  const [amortStartMonth, setAmortStartMonth] = useState<string>("");
  const [pairingTxn, setPairingTxn] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [showImport, setShowImport] = useState(false);
  const [page, setPage] = useState(0);

  const { labels: catLabels, categories: allCategoryList } = useCategoryLabels();
  const humanCat = useCallback((cat: string) => {
    return catLabels[cat] || cat.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
  }, [catLabels]);

  const recategorizeMutation = useMutation({
    mutationFn: (args: { merchantName: string; categoryId: number }) =>
      apiRequest("PUT", "/api/finance/merchant-overrides", args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/merchant-overrides"] });
      setRecategorizingTxn(null);
      toast({ title: "Category updated for this merchant" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const amortizeMutation = useMutation({
    mutationFn: (args: { transactionId: string; originalAmount: number; spreadMonths: number; startMonth: string; category: string }) =>
      apiRequest("POST", "/api/finance/amortizations", { ...args, isActive: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/amortizations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-comparison"] });
      setAmortizingTxn(null);
      toast({ title: "Amortization created", description: "The expense will now be spread across months in budget and forecast views." });
    },
    onError: (err: Error) => toast({ title: "Amortize failed", description: err.message, variant: "destructive" }),
  });

  const markInternalMutation = useMutation({
    mutationFn: (args: { transactionId: string; pairWith?: string }) =>
      apiRequest("POST", `/api/finance/transactions/${args.transactionId}/mark-internal`, { pairWith: args.pairWith }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-comparison"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      setPairingTxn(null);
      toast({ title: "Marked as internal transfer" });
    },
    onError: (err: Error) => toast({ title: "Mark failed", description: err.message, variant: "destructive" }),
  });

  const unmarkInternalMutation = useMutation({
    mutationFn: (transactionId: string) =>
      apiRequest("POST", `/api/finance/transactions/${transactionId}/unmark-internal`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-comparison"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      toast({ title: "Removed from internal transfers" });
    },
    onError: (err: Error) => toast({ title: "Unmark failed", description: err.message, variant: "destructive" }),
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category");
    if (category) {
      setSelectedCategories(new Set(category.split(",")));
    }
    const account = params.get("account");
    if (account) {
      setSelectedAccounts(new Set(account.split(",")));
    }
    const days = params.get("days");
    if (days) {
      const d = parseInt(days);
      if (!isNaN(d) && d > 0) setDateRange(d);
    }
    const q = params.get("search");
    if (q) {
      setSearchText(q);
    }
    const url = new URL(window.location.href);
    ["category", "account", "days", "search"].forEach(k => url.searchParams.delete(k));
    window.history.replaceState({}, "", url.toString());
  }, []);

  const startDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - dateRange);
    return d.toISOString().split("T")[0];
  }, [dateRange]);

  const offset = page * PAGE_SIZE;

  const transactionsQuery = useQuery<{ transactions: PlaidTransaction[]; total: number }>({
    queryKey: ["/api/plaid/transactions", `?startDate=${startDate}&limit=${PAGE_SIZE}&offset=${offset}`],
  });

  const accountsQuery = useQuery<PlaidAccountItem[]>({
    queryKey: ["/api/plaid/accounts"],
  });

  const transactions = transactionsQuery.data?.transactions || [];
  const totalCount = transactionsQuery.data?.total || 0;

  const activeTxnId = recategorizingTxn || amortizingTxn || pairingTxn || null;
  const activeTxn = useMemo(
    () => (activeTxnId ? transactions.find(t => t.transactionId === activeTxnId) || null : null),
    [transactions, activeTxnId]
  );
  const focusState = useMemo(() => {
    const s: Record<string, string> = {};
    if (searchText.trim()) s.search = searchText.trim();
    if (selectedCategories.size) s.categories = String(selectedCategories.size);
    if (selectedAccounts.size) s.accounts = String(selectedAccounts.size);
    if (noCategoryFilter) s.uncategorized = "1";
    s.dateRangeDays = String(dateRange);
    s.sort = `${sortField}:${sortDirection}`;
    if (page > 0) s.page = String(page);
    return s;
  }, [searchText, selectedCategories, selectedAccounts, noCategoryFilter, dateRange, sortField, sortDirection, page]);
  useFocusContext({
    subView: "transactions",
    state: focusState,
    entity: activeTxn
      ? {
          type: "transaction",
          id: activeTxn.transactionId,
          label: `${activeTxn.merchantName || activeTxn.name} · ${activeTxn.date} · ${activeTxn.amount}`,
        }
      : undefined,
  });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const allAccounts = useMemo(() => {
    const items = accountsQuery.data || [];
    return items.flatMap(item => item.accounts.map(a => ({ ...a, institutionName: item.institutionName })));
  }, [accountsQuery.data]);

  const accountNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of allAccounts) {
      map[a.accountId] = a.name;
    }
    return map;
  }, [allAccounts]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of transactions) {
      const cat = t.effectiveCategory || t.categoryPrimary;
      if (cat) set.add(cat);
    }
    return Array.from(set).sort();
  }, [transactions]);

  const toggleCategory = useCallback((cat: string) => {
    setSelectedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
    setNoCategoryFilter(false);
  }, []);

  const toggleNoCategoryFilter = useCallback(() => {
    setNoCategoryFilter(prev => !prev);
    setSelectedCategories(new Set());
  }, []);

  const toggleAccount = useCallback((id: string) => {
    setSelectedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSort = useCallback((field: SortField) => {
    setSortField(prev => {
      if (prev === field) {
        setSortDirection(d => d === "asc" ? "desc" : "asc");
        return field;
      }
      setSortDirection(field === "date" ? "desc" : "asc");
      return field;
    });
  }, []);

  const filtered = useMemo(() => {
    let list = transactions;
    if (noCategoryFilter) {
      list = list.filter(t => !t.effectiveCategory && !t.categoryPrimary);
    } else if (selectedCategories.size > 0) {
      list = list.filter(t => {
        const cat = t.effectiveCategory || t.categoryPrimary;
        return cat && selectedCategories.has(cat);
      });
    }
    if (selectedAccounts.size > 0) {
      list = list.filter(t => selectedAccounts.has(t.accountId));
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.merchantName && t.merchantName.toLowerCase().includes(q))
      );
    }
    return list;
  }, [transactions, selectedCategories, noCategoryFilter, selectedAccounts, searchText]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortDirection === "asc" ? 1 : -1;
    list.sort((a, b) => {
      switch (sortField) {
        case "name": {
          const na = (a.merchantName || a.name).toLowerCase();
          const nb = (b.merchantName || b.name).toLowerCase();
          return dir * na.localeCompare(nb);
        }
        case "date":
          return dir * a.date.localeCompare(b.date);
        case "category": {
          const ca = (a.effectiveCategory || a.categoryPrimary || "").toLowerCase();
          const cb = (b.effectiveCategory || b.categoryPrimary || "").toLowerCase();
          return dir * ca.localeCompare(cb);
        }
        case "account": {
          const aa = (accountNameMap[a.accountId] || "").toLowerCase();
          const ab = (accountNameMap[b.accountId] || "").toLowerCase();
          return dir * aa.localeCompare(ab);
        }
        case "amount":
          return dir * (a.amount - b.amount);
        default:
          return 0;
      }
    });
    return list;
  }, [filtered, sortField, sortDirection, accountNameMap]);

  const subtotal = useMemo(() => filtered.reduce((sum, t) => sum + t.amount, 0), [filtered]);

  const activeFilterCount = selectedCategories.size + selectedAccounts.size + (searchText.trim() ? 1 : 0) + (noCategoryFilter ? 1 : 0);

  const clearFilters = useCallback(() => {
    setSelectedCategories(new Set());
    setSelectedAccounts(new Set());
    setSearchText("");
    setNoCategoryFilter(false);
  }, []);

  useEffect(() => {
    setPage(0);
  }, [dateRange]);

  useEffect(() => {
    if (page >= totalPages && totalPages > 0) {
      setPage(totalPages - 1);
    }
  }, [totalPages, page]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 ml-0.5 opacity-40" />;
    return sortDirection === "asc"
      ? <ArrowUp className="h-3 w-3 ml-0.5" />
      : <ArrowDown className="h-3 w-3 ml-0.5" />;
  };

  if (transactionsQuery.isLoading) {
    return (
      <div className="p-4 space-y-3" data-testid="transactions-loading">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} className="flex items-center justify-between px-3 py-3 animate-pulse rounded-lg border border-border/50 bg-card">
            <div className="flex flex-col gap-1.5">
              <div className="h-3.5 w-32 bg-muted rounded" />
              <div className="h-2.5 w-20 bg-muted rounded" />
            </div>
            <div className="h-3.5 w-16 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (transactionsQuery.isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="transactions-error">
        <p className="text-sm text-muted-foreground">Unable to load transactions.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search transactions..."
            className="pl-8 h-8 text-xs"
            data-testid="input-search-transactions"
          />
          {searchText && (
            <button onClick={() => setSearchText("")} className="absolute right-2 top-1/2 -translate-y-1/2" data-testid="button-clear-search">
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowImport(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium border border-border/50 bg-card hover:bg-muted transition-colors"
          data-testid="button-import-csv"
        >
          <Upload className="h-3 w-3" />
          Import CSV
        </button>
      </div>

      <div className="rounded-lg border border-border/50 bg-card p-3 space-y-3" data-testid="filters-panel">
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Date Range</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {DATE_RANGES.map(r => (
              <button
                key={r.days}
                onClick={() => setDateRange(r.days)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  dateRange === r.days ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
                }`}
                data-testid={`button-range-${r.days}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Tag className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Categories</span>
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={toggleNoCategoryFilter}
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                noCategoryFilter ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50"
              }`}
              data-testid="button-category-no-category"
            >
              No Category
            </button>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => toggleCategory(cat)}
                className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                  selectedCategories.has(cat) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50"
                }`}
                data-testid={`button-category-${cat}`}
              >
                {humanCat(cat)}
              </button>
            ))}
          </div>
        </div>

        {allAccounts.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Landmark className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">Accounts</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {allAccounts.map(a => (
                <button
                  key={a.accountId}
                  onClick={() => toggleAccount(a.accountId)}
                  className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                    selectedAccounts.has(a.accountId) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50"
                  }`}
                  data-testid={`button-account-${a.accountId}`}
                >
                  {a.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeFilterCount > 0 && (
          <button onClick={clearFilters} className="text-xs text-primary hover:underline" data-testid="button-clear-filters">
            Clear all filters
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span data-testid="text-transaction-count">{filtered.length} transaction{filtered.length !== 1 ? "s" : ""} (page {page + 1} of {totalPages}, {totalCount} total)</span>
        <span data-testid="text-transaction-subtotal">Subtotal: {formatCurrency(subtotal)}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="transactions-empty">
          <p className="text-sm text-muted-foreground">No transactions match your filters.</p>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs text-primary mt-2 hover:underline" data-testid="button-clear-empty">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
          <div className="grid grid-cols-[1fr_90px_110px_100px_70px_90px] gap-x-2 px-3 py-2 border-b border-border/50 bg-muted/30">
            <button
              onClick={() => handleSort("name")}
              className="flex items-center text-xs font-medium text-muted-foreground uppercase hover:text-foreground transition-colors text-left"
              data-testid="sort-name"
            >
              Name <SortIcon field="name" />
            </button>
            <button
              onClick={() => handleSort("date")}
              className="flex items-center text-xs font-medium text-muted-foreground uppercase hover:text-foreground transition-colors text-left"
              data-testid="sort-date"
            >
              Date <SortIcon field="date" />
            </button>
            <button
              onClick={() => handleSort("category")}
              className="flex items-center text-xs font-medium text-muted-foreground uppercase hover:text-foreground transition-colors text-left"
              data-testid="sort-category"
            >
              Category <SortIcon field="category" />
            </button>
            <button
              onClick={() => handleSort("account")}
              className="flex items-center text-xs font-medium text-muted-foreground uppercase hover:text-foreground transition-colors text-left"
              data-testid="sort-account"
            >
              Account <SortIcon field="account" />
            </button>
            <span className="text-xs font-medium text-muted-foreground uppercase text-center">Type</span>
            <button
              onClick={() => handleSort("amount")}
              className="flex items-center justify-end text-xs font-medium text-muted-foreground uppercase hover:text-foreground transition-colors"
              data-testid="sort-amount"
            >
              Amount <SortIcon field="amount" />
            </button>
          </div>

          <div className="divide-y divide-border/50">
            {sorted.map(txn => {
              const categoryUpper = (txn.effectiveCategory || txn.categoryPrimary || "").toUpperCase();
              const isTransferCategory = categoryUpper.includes("TRANSFER");
              const isTransferIn = txn.amount < 0 && isTransferCategory;
              const isTransferOut = txn.amount > 0 && isTransferCategory;

              return (
                <div key={txn.transactionId} data-testid={`txn-row-${txn.transactionId}`}>
                  <div className="grid grid-cols-[1fr_90px_110px_100px_70px_90px] gap-x-2 items-center px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-medium text-foreground truncate block flex items-center gap-1" data-testid={`txn-name-${txn.transactionId}`}>
                        {txn.merchantName || txn.name}
                        {txn.isInternalTransfer && (
                          <span
                            className="inline-flex items-center gap-0.5 text-xs text-info-foreground shrink-0"
                            title={
                              txn.transferCounterpart
                                ? `Paired with ${accountNameMap[txn.transferCounterpart.accountId] || "another account"} on ${formatDate(txn.transferCounterpart.date)} (${formatCurrency(Math.abs(txn.transferCounterpart.amount))})`
                                : "Internal transfer (excluded from totals)"
                            }
                            data-testid={`badge-internal-${txn.transactionId}`}
                          >
                            <RefreshCw className="h-2.5 w-2.5" />
                            Internal
                          </span>
                        )}
                      </span>
                      {txn.pending && (
                        <Badge variant="outline" className="text-xs px-1 py-0 h-3.5 mt-0.5">Pending</Badge>
                      )}
                    </div>
                    <span className="text-muted-foreground" data-testid={`txn-date-${txn.transactionId}`}>
                      {formatDate(txn.date)}
                    </span>
                    <div className="min-w-0">
                      {(txn.effectiveCategory || txn.categoryPrimary) ? (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-0.5 truncate max-w-full"
                          onClick={(e) => { e.stopPropagation(); setRecategorizingTxn(recategorizingTxn === txn.transactionId ? null : txn.transactionId); }}
                          data-testid={`button-recategorize-${txn.transactionId}`}
                        >
                          <Tag className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{humanCat(txn.effectiveCategory || txn.categoryPrimary || "")}</span>
                          {txn.effectiveCategory && txn.effectiveCategory !== txn.categoryPrimary && (
                            <span className="text-xs text-primary/70 shrink-0">(custom)</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </div>
                    <span className="text-muted-foreground truncate" data-testid={`txn-account-${txn.transactionId}`}>
                      {accountNameMap[txn.accountId] || "—"}
                    </span>
                    <span className="text-center" data-testid={`txn-type-${txn.transactionId}`}>
                      {isTransferIn ? (
                        <Badge variant="outline" className="text-xs px-1 py-0 h-4 text-success-foreground border-success/30 dark:text-success dark:border-success/50">In</Badge>
                      ) : isTransferOut ? (
                        <Badge variant="outline" className="text-xs px-1 py-0 h-4 text-cat-event-foreground border-cat-event/30">Out</Badge>
                      ) : null}
                    </span>
                    <span className={`font-medium tabular-nums text-right ${txn.amount < 0 ? "text-success-foreground" : "text-foreground"}`} data-testid={`txn-amount-${txn.transactionId}`}>
                      {formatCurrency(Math.abs(txn.amount))}
                    </span>
                  </div>
                  {recategorizingTxn === txn.transactionId && txn.merchantName && (
                    <div className="flex items-center gap-1.5 px-3 pb-2 bg-muted/20" data-testid={`recategorize-picker-${txn.transactionId}`}>
                      <span className="text-xs text-muted-foreground shrink-0">Assign &quot;{txn.merchantName}&quot; to:</span>
                      <select
                        className="h-6 text-xs rounded-md border border-input bg-background px-1.5"
                        defaultValue=""
                        onChange={e => {
                          const catId = parseInt(e.target.value);
                          if (!isNaN(catId) && txn.merchantName) {
                            recategorizeMutation.mutate({ merchantName: txn.merchantName, categoryId: catId });
                          }
                        }}
                        data-testid={`select-recategorize-${txn.transactionId}`}
                      >
                        <option value="">Select category...</option>
                        {allCategoryList.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-3 px-3 pb-1">
                    {txn.isInternalTransfer ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          unmarkInternalMutation.mutate(txn.transactionId);
                        }}
                        className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                        title="Remove internal transfer marking"
                        data-testid={`button-unmark-internal-${txn.transactionId}`}
                      >
                        <Link2Off className="h-2.5 w-2.5" />
                        Unmark internal
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPairingTxn(pairingTxn === txn.transactionId ? null : txn.transactionId);
                        }}
                        className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                        title="Mark as internal transfer between accounts"
                        data-testid={`button-mark-internal-${txn.transactionId}`}
                      >
                        <Link2 className="h-2.5 w-2.5" />
                        {pairingTxn === txn.transactionId ? "Cancel" : "Mark internal"}
                      </button>
                    )}
                    {txn.amount > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (amortizingTxn === txn.transactionId) {
                            setAmortizingTxn(null);
                          } else {
                            setAmortizingTxn(txn.transactionId);
                            const cat = txn.effectiveCategory || txn.categoryPrimary || "";
                            setAmortSpread(String(defaultSpreadFor(cat)));
                            setAmortStartMonth(txn.date.substring(0, 7));
                          }
                        }}
                        className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                        title="Spread this expense across months"
                        data-testid={`button-amortize-${txn.transactionId}`}
                      >
                        <CalendarRange className="h-2.5 w-2.5" />
                        {amortizingTxn === txn.transactionId ? "Cancel" : "Amortize"}
                      </button>
                    )}
                  </div>
                  {pairingTxn === txn.transactionId && !txn.isInternalTransfer && (
                    <PairPicker
                      txn={txn}
                      accountNameMap={accountNameMap}
                      onPair={(pairWith) => markInternalMutation.mutate({ transactionId: txn.transactionId, pairWith })}
                      onMarkOnly={() => markInternalMutation.mutate({ transactionId: txn.transactionId })}
                      isPending={markInternalMutation.isPending}
                    />
                  )}
                  {amortizingTxn === txn.transactionId && (
                    <div className="flex items-center gap-1.5 px-3 pb-2 bg-muted/20 flex-wrap" data-testid={`amortize-form-${txn.transactionId}`}>
                      <span className="text-xs text-muted-foreground shrink-0">Spread {formatCurrency(txn.amount)} across</span>
                      <input
                        type="number"
                        min={1}
                        max={120}
                        value={amortSpread}
                        onChange={e => setAmortSpread(e.target.value)}
                        className="h-6 w-16 text-xs rounded-md border border-input bg-background px-1.5"
                        data-testid={`input-amortize-spread-${txn.transactionId}`}
                      />
                      <span className="text-xs text-muted-foreground">months starting</span>
                      <input
                        type="month"
                        value={amortStartMonth}
                        onChange={e => setAmortStartMonth(e.target.value)}
                        className="h-6 text-xs rounded-md border border-input bg-background px-1.5"
                        data-testid={`input-amortize-start-${txn.transactionId}`}
                      />
                      <button
                        type="button"
                        disabled={amortizeMutation.isPending}
                        onClick={() => {
                          const sm = parseInt(amortSpread);
                          if (isNaN(sm) || sm < 1 || sm > 120) {
                            toast({ title: "Spread must be 1-120 months", variant: "destructive" });
                            return;
                          }
                          if (!/^\d{4}-\d{2}$/.test(amortStartMonth)) {
                            toast({ title: "Start month must be YYYY-MM", variant: "destructive" });
                            return;
                          }
                          amortizeMutation.mutate({
                            transactionId: txn.transactionId,
                            originalAmount: txn.amount,
                            spreadMonths: sm,
                            startMonth: amortStartMonth,
                            category: txn.effectiveCategory || txn.categoryPrimary || "UNCATEGORIZED",
                          });
                        }}
                        className="h-6 px-2 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        data-testid={`button-confirm-amortize-${txn.transactionId}`}
                      >
                        Apply
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2" data-testid="pagination-controls">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium border border-border/50 bg-card hover:bg-muted transition-colors disabled:opacity-40 disabled:pointer-events-none"
            data-testid="button-prev-page"
          >
            <ChevronLeft className="h-3 w-3" />
            Previous
          </button>
          <span className="text-xs text-muted-foreground" data-testid="text-page-indicator">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium border border-border/50 bg-card hover:bg-muted transition-colors disabled:opacity-40 disabled:pointer-events-none"
            data-testid="button-next-page"
          >
            Next
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}

      <CSVImportDialog open={showImport} onClose={() => setShowImport(false)} />
    </div>
  );
}

interface PairPickerProps {
  txn: PlaidTransaction;
  accountNameMap: Record<string, string>;
  onPair: (pairWith: string) => void;
  onMarkOnly: () => void;
  isPending: boolean;
}

function PairPicker({ txn, accountNameMap, onPair, onMarkOnly, isPending }: PairPickerProps) {
  const { data, isLoading } = useQuery<{ candidates: PairCandidate[] }>({
    queryKey: ["/api/finance/transactions", txn.transactionId, "pair-candidates"],
  });

  const candidates = data?.candidates || [];

  return (
    <div className="px-3 pb-2 bg-muted/20 space-y-1.5" data-testid={`pair-picker-${txn.transactionId}`}>
      <div className="text-xs text-muted-foreground">
        Find the matching transaction on another account, or mark as internal without a pair.
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading candidates…</div>
      ) : candidates.length === 0 ? (
        <div className="text-xs text-muted-foreground">No matching counterpart found within ±7 days.</div>
      ) : (
        <div className="space-y-1">
          {candidates.slice(0, 5).map(c => (
            <button
              key={c.transactionId}
              type="button"
              disabled={isPending}
              onClick={() => onPair(c.transactionId)}
              className="w-full text-left text-xs px-2 py-1 rounded border border-border/50 bg-background hover:bg-muted disabled:opacity-50 flex items-center justify-between gap-2"
              data-testid={`button-pair-with-${c.transactionId}`}
            >
              <span className="truncate">
                {c.merchantName || c.name} · {accountNameMap[c.accountId] || c.accountId.slice(0, 6)} · {c.date}
              </span>
              <span className={`tabular-nums shrink-0 ${c.amount < 0 ? "text-success-foreground" : "text-foreground"}`}>
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(c.amount))}
              </span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={isPending}
        onClick={onMarkOnly}
        className="text-xs text-muted-foreground hover:text-primary disabled:opacity-50"
        data-testid={`button-mark-internal-only-${txn.transactionId}`}
      >
        Mark as internal without a counterpart
      </button>
    </div>
  );
}
