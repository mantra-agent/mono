import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { TrendingUp, TrendingDown, BarChart3, ChevronDown, ChevronRight, Briefcase, DollarSign, PieChart, Plus, Trash2, Edit2, Check, X, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";

interface Holding {
  securityId: string;
  securityName: string | null;
  tickerSymbol: string | null;
  securityType: string | null;
  quantity: number;
  costBasis: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

interface InvestmentAccount {
  accountId: string;
  accountName: string;
  institutionName: string;
  holdings: Holding[];
  subtotal: number;
  subtotalCostBasis: number;
}

interface Manual401kAccount {
  id: number;
  name: string;
  currentBalance: number;
  linkedDeductionId: number | null;
  linkedDeductionName: string | null;
  linkedDeductionAmount: number | null;
  monthlyContribution: number;
}

interface IncomeDeduction {
  id: number;
  sourceId: number;
  name: string;
  amount: number;
  isPreTax: boolean;
}

interface IncomeSource {
  id: number;
  name: string;
  grossPay: number;
  payFrequency: string;
  isActive: boolean;
  deductions: IncomeDeduction[];
}

interface IncomeData {
  sources: IncomeSource[];
}

interface InvestmentData {
  accounts: InvestmentAccount[];
  totals: {
    totalValue: number;
    totalCostBasis: number;
    totalGainLoss: number;
    gainLossPercent: number;
  };
  allocationByType: Record<string, number>;
  manual401kAccounts: Manual401kAccount[];
  manual401kTotal: number;
}

type SortField = "name" | "ticker" | "type" | "quantity" | "costBasis" | "price" | "value" | "gainLoss";
type SortDir = "asc" | "desc";

const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
};

const fmtPct = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
};

const fmtQty = (n: number) => {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(4);
};

const TYPE_LABELS: Record<string, string> = {
  equity: "Stock",
  etf: "ETF",
  "mutual fund": "Mutual Fund",
  cryptocurrency: "Crypto",
  "fixed income": "Bond",
  derivative: "Derivative",
  cash: "Cash",
  "401k": "401k",
  other: "Other",
};

const TYPE_COLORS: Record<string, string> = {
  equity: "bg-info",
  etf: "bg-cat-system",
  "mutual fund": "bg-cat-ai",
  cryptocurrency: "bg-warning",
  "fixed income": "bg-success",
  derivative: "bg-cat-alert",
  cash: "bg-neutral",
  "401k": "bg-cat-system",
  other: "bg-neutral/70",
};

function AllocationBar({ allocation }: { allocation: Record<string, number> }) {
  const entries = Object.entries(allocation).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-card p-4" data-testid="allocation-breakdown">
      <div className="flex items-center gap-2 mb-3">
        <PieChart className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Allocation by Type</span>
      </div>
      <div className="flex h-3 rounded-full overflow-hidden mb-3">
        {entries.map(([type, pct]) => (
          <div
            key={type}
            className={`${TYPE_COLORS[type] || TYPE_COLORS.other} transition-all`}
            style={{ width: `${pct}%` }}
            title={`${TYPE_LABELS[type] || type}: ${pct}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {entries.map(([type, pct]) => (
          <div key={type} className="flex items-center gap-1.5 text-xs">
            <div className={`h-2.5 w-2.5 rounded-full ${TYPE_COLORS[type] || TYPE_COLORS.other}`} />
            <span className="text-muted-foreground">{TYPE_LABELS[type] || type}</span>
            <span className="font-medium text-foreground">{pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HoldingsTable({ holdings, sortField, sortDir, onSort }: {
  holdings: Holding[];
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const sorted = useMemo(() => {
    const copy = [...holdings];
    copy.sort((a, b) => {
      let av: number | string | null = null;
      let bv: number | string | null = null;
      switch (sortField) {
        case "name": av = a.securityName || ""; bv = b.securityName || ""; break;
        case "ticker": av = a.tickerSymbol || ""; bv = b.tickerSymbol || ""; break;
        case "type": av = a.securityType || ""; bv = b.securityType || ""; break;
        case "quantity": av = a.quantity; bv = b.quantity; break;
        case "costBasis": av = a.costBasis ?? 0; bv = b.costBasis ?? 0; break;
        case "price": av = a.currentPrice ?? 0; bv = b.currentPrice ?? 0; break;
        case "value": av = a.currentValue ?? 0; bv = b.currentValue ?? 0; break;
        case "gainLoss": av = a.gainLoss ?? 0; bv = b.gainLoss ?? 0; break;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const na = av as number;
      const nb = bv as number;
      return sortDir === "asc" ? na - nb : nb - na;
    });
    return copy;
  }, [holdings, sortField, sortDir]);

  const SortHeader = ({ field, label, align }: { field: SortField; label: string; align?: string }) => (
    <th
      className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none ${align || "text-left"}`}
      onClick={() => onSort(field)}
      data-testid={`sort-${field}`}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {sortField === field && <span className="text-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="holdings-table">
        <thead>
          <tr className="border-b border-border/50">
            <SortHeader field="name" label="Security" />
            <SortHeader field="ticker" label="Ticker" />
            <SortHeader field="type" label="Type" />
            <SortHeader field="quantity" label="Qty" align="text-right" />
            <SortHeader field="costBasis" label="Cost Basis" align="text-right" />
            <SortHeader field="price" label="Price" align="text-right" />
            <SortHeader field="value" label="Value" align="text-right" />
            <SortHeader field="gainLoss" label="Gain/Loss" align="text-right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((h) => {
            const isGain = h.gainLoss !== null && h.gainLoss >= 0;
            const glColor = h.gainLoss === null ? "text-muted-foreground" : isGain ? "text-success-foreground" : "text-error-foreground";
            return (
              <tr key={h.securityId} className="border-b border-border/30 hover:bg-muted/30" data-testid={`holding-row-${h.securityId}`}>
                <td className="px-3 py-2.5 font-medium text-foreground max-w-[200px] truncate">{h.securityName || "Unknown"}</td>
                <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs">{h.tickerSymbol || "—"}</td>
                <td className="px-3 py-2.5">
                  <Badge variant="secondary" className="text-xs font-normal" data-testid={`type-badge-${h.securityId}`}>
                    {TYPE_LABELS[h.securityType || "other"] || h.securityType || "Other"}
                  </Badge>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{fmtQty(h.quantity)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{fmt(h.costBasis)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-foreground">{fmt(h.currentPrice)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium text-foreground">{fmt(h.currentValue)}</td>
                <td className={`px-3 py-2.5 text-right font-mono ${glColor}`}>
                  <div>{fmt(h.gainLoss)}</div>
                  <div className="text-xs">{fmtPct(h.gainLossPercent)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Manual401kSection({ accounts, deductions }: { accounts: Manual401kAccount[]; deductions: IncomeDeduction[] }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editBalance, setEditBalance] = useState("");
  const [editDeductionId, setEditDeductionId] = useState("");
  const [newName, setNewName] = useState("");
  const [newBalance, setNewBalance] = useState("");
  const [newDeductionId, setNewDeductionId] = useState("");

  const preTaxDeductions = deductions.filter(d => d.isPreTax);

  const createMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/finance/manual-401k", {
      name: newName,
      currentBalance: parseFloat(newBalance) || 0,
      linkedDeductionId: newDeductionId && newDeductionId !== "none" ? parseInt(newDeductionId) : null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/investments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-401k"] });
      setShowAddForm(false);
      setNewName("");
      setNewBalance("");
      setNewDeductionId("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PUT", `/api/finance/manual-401k/${id}`, {
      name: editName,
      currentBalance: parseFloat(editBalance) || 0,
      linkedDeductionId: editDeductionId && editDeductionId !== "none" ? parseInt(editDeductionId) : null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/investments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-401k"] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/manual-401k/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/investments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-401k"] });
    },
  });

  const startEdit = (acct: Manual401kAccount) => {
    setEditingId(acct.id);
    setEditName(acct.name);
    setEditBalance(acct.currentBalance.toString());
    setEditDeductionId(acct.linkedDeductionId?.toString() || "");
  };

  return (
    <div className="space-y-3" data-testid="manual-401k-section">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-cat-system" />
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">401k Accounts</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAddForm(!showAddForm)}
          data-testid="button-add-401k"
        >
          <Plus className="h-3 w-3 mr-1" />
          Add 401k
        </Button>
      </div>

      {showAddForm && (
        <div className="rounded-lg border border-border/50 bg-card p-4 space-y-3" data-testid="form-add-401k">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase">Account Name</label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="h-8 text-xs mt-1"
                placeholder="My 401k"
                data-testid="input-401k-name"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase">Current Balance</label>
              <Input
                type="number"
                step="0.01"
                value={newBalance}
                onChange={e => setNewBalance(e.target.value)}
                className="h-8 text-xs mt-1"
                placeholder="50000.00"
                data-testid="input-401k-balance"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase">Linked Pre-Tax Deduction</label>
            <Select value={newDeductionId} onValueChange={setNewDeductionId}>
              <SelectTrigger className="h-8 text-xs mt-1" data-testid="select-401k-deduction">
                <SelectValue placeholder="Select a deduction (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {preTaxDeductions.map(d => (
                  <SelectItem key={d.id} value={d.id.toString()}>{d.name} (${d.amount}/period)</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)} data-testid="button-cancel-401k">
              <X className="h-3 w-3 mr-1" />Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={!newName || !newBalance || createMutation.isPending}
              data-testid="button-save-401k"
            >
              <Check className="h-3 w-3 mr-1" />{createMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {accounts.length === 0 && !showAddForm && (
        <div className="rounded-lg border border-dashed border-border bg-card/50 p-4 text-center" data-testid="401k-empty-state">
          <Shield className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
          <p className="text-xs text-muted-foreground">No 401k accounts tracked</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Add a manual 401k account and link it to a pre-tax deduction from your income</p>
        </div>
      )}

      {accounts.map(acct => (
        <div key={acct.id} className="rounded-lg border border-border/50 bg-card overflow-hidden" data-testid={`401k-account-${acct.id}`}>
          {editingId === acct.id ? (
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase">Name</label>
                  <Input value={editName} onChange={e => setEditName(e.target.value)} className="h-8 text-xs mt-1" data-testid={`input-edit-401k-name-${acct.id}`} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase">Balance</label>
                  <Input type="number" step="0.01" value={editBalance} onChange={e => setEditBalance(e.target.value)} className="h-8 text-xs mt-1" data-testid={`input-edit-401k-balance-${acct.id}`} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase">Linked Deduction</label>
                <Select value={editDeductionId} onValueChange={setEditDeductionId}>
                  <SelectTrigger className="h-8 text-xs mt-1" data-testid={`select-edit-401k-deduction-${acct.id}`}>
                    <SelectValue placeholder="Select a deduction" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {preTaxDeductions.map(d => (
                      <SelectItem key={d.id} value={d.id.toString()}>{d.name} (${d.amount}/period)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} data-testid={`button-cancel-edit-401k-${acct.id}`}>
                  <X className="h-3 w-3 mr-1" />Cancel
                </Button>
                <Button size="sm" onClick={() => updateMutation.mutate(acct.id)} disabled={updateMutation.isPending} data-testid={`button-save-edit-401k-${acct.id}`}>
                  <Check className="h-3 w-3 mr-1" />Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground" data-testid={`text-401k-name-${acct.id}`}>{acct.name}</div>
                <div className="text-xs text-muted-foreground">
                  {acct.linkedDeductionName ? (
                    <span>Linked to: {acct.linkedDeductionName} · {fmt(acct.monthlyContribution)}/mo contribution</span>
                  ) : (
                    <span>No linked deduction</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-right">
                  <div className="text-sm font-semibold text-foreground" data-testid={`text-401k-balance-${acct.id}`}>{fmt(acct.currentBalance)}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => startEdit(acct)} data-testid={`button-edit-401k-${acct.id}`}>
                  <Edit2 className="h-3 w-3 text-muted-foreground" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(acct.id)} disabled={deleteMutation.isPending} data-testid={`button-delete-401k-${acct.id}`}>
                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function InvestmentsContent() {
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string> | "all">("all");
  const [sortField, setSortField] = useState<SortField>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading, error } = useQuery<InvestmentData>({
    queryKey: ["/api/finance/investments"],
  });

  const incomeQuery = useQuery<IncomeData>({ queryKey: ["/api/finance/income-sources"] });
  const allDeductions = useMemo(() => {
    return incomeQuery.data?.sources.flatMap(s => s.deductions) || [];
  }, [incomeQuery.data]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const toggleAccount = (id: string) => {
    setExpandedAccounts(prev => {
      if (prev === "all") {
        const allIds = new Set(data?.accounts.map(a => a.accountId) || []);
        allIds.delete(id);
        return allIds;
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allHoldings = useMemo(() => data?.accounts.flatMap(a => a.holdings) || [], [data]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="investments-loading">
        <div className="grid grid-cols-1 @sm:grid-cols-2 @lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <SummaryMetricCardSkeleton key={i} />)}
        </div>
        <div className="h-48 bg-muted/30 rounded-lg animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center text-error" data-testid="investments-error">
        Failed to load investment data. Please try again.
      </div>
    );
  }

  const manual401kList = data?.manual401kAccounts || [];
  const manual401kTotal = data?.manual401kTotal || 0;

  if (!data || (data.accounts.length === 0 && manual401kList.length === 0)) {
    return (
      <div className="p-4 space-y-6" data-testid="investments-empty">
        <Manual401kSection accounts={manual401kList} deductions={allDeductions} />
        <div className="flex flex-col items-center justify-center h-48 gap-3">
          <Briefcase className="h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No investment accounts connected</p>
          <p className="text-xs text-muted-foreground">Link a brokerage or retirement account through Plaid to see your holdings here.</p>
        </div>
      </div>
    );
  }

  const { totals, allocationByType } = data;
  const isOverallGain = totals.totalGainLoss >= 0;

  return (
    <div className="p-4 space-y-4" data-testid="investments-content">
      <div className="grid grid-cols-1 @sm:grid-cols-2 @lg:grid-cols-4 gap-3">
        <SummaryMetricCard
          label="Total Investment Value"
          value={fmt(totals.totalValue)}
          icon={<Briefcase className="h-3.5 w-3.5" />}
          testId="metric-total-value"
        />
        <SummaryMetricCard
          label="Total Cost Basis"
          value={fmt(totals.totalCostBasis)}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          testId="metric-cost-basis"
        />
        <SummaryMetricCard
          label="Total Gain/Loss"
          value={fmt(totals.totalGainLoss)}
          secondaryValue={fmtPct(totals.gainLossPercent)}
          icon={isOverallGain ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          delta={totals.gainLossPercent}
          testId="metric-gain-loss"
        />
        <SummaryMetricCard
          label="Holdings"
          value={allHoldings.length.toString()}
          secondaryValue={`${data.accounts.length} account${data.accounts.length !== 1 ? "s" : ""}`}
          icon={<BarChart3 className="h-3.5 w-3.5" />}
          testId="metric-holdings-count"
        />
      </div>

      <AllocationBar allocation={allocationByType} />

      <Manual401kSection accounts={manual401kList} deductions={allDeductions} />

      <div className="space-y-3">
        {data.accounts.map((acct) => {
          const isExpanded = expandedAccounts === "all" || expandedAccounts.has(acct.accountId);
          const acctGainLoss = acct.subtotalCostBasis > 0 ? acct.subtotal - acct.subtotalCostBasis : 0;
          const acctGainPct = acct.subtotalCostBasis > 0 ? (acctGainLoss / acct.subtotalCostBasis) * 100 : 0;
          const acctIsGain = acctGainLoss >= 0;
          const glColor = acctIsGain ? "text-success-foreground" : "text-error-foreground";

          return (
            <div key={acct.accountId} className="rounded-lg border border-border/50 bg-card overflow-hidden" data-testid={`account-group-${acct.accountId}`}>
              <button
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
                onClick={() => toggleAccount(acct.accountId)}
                data-testid={`toggle-account-${acct.accountId}`}
              >
                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                <div className="flex-1 text-left min-w-0">
                  <div className="font-medium text-sm text-foreground truncate">{acct.accountName}</div>
                  <div className="text-xs text-muted-foreground">{acct.institutionName} · {acct.holdings.length} holding{acct.holdings.length !== 1 ? "s" : ""}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-foreground">{fmt(acct.subtotal)}</div>
                  <div className={`text-xs ${glColor}`}>{fmt(acctGainLoss)} ({fmtPct(acctGainPct)})</div>
                </div>
              </button>
              {isExpanded && (
                <div className="border-t border-border/30">
                  <HoldingsTable holdings={acct.holdings} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
