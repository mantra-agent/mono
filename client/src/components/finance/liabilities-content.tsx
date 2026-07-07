import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Plus, Pencil, Trash2, CreditCard, AlertCircle, DollarSign, TrendingDown, ChevronDown, ChevronRight, X, Clock, RefreshCw } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { FreshnessBadge } from "./freshness-badge";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";

interface ManualLiability {
  id: number;
  name: string;
  category: string;
  balance: number;
  aprPercentage: number | null;
  minimumPayment: number | null;
  manualPaymentAmount: number | null;
  nextPaymentDueDate: string | null;
  notes: string | null;
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
  manualPaymentAmount: number | null;
  nextPaymentDueDate: string | null;
  interestRatePercentage: number | null;
  notes: string | null;
  lastUpdated: string;
}

interface DebtPayment {
  id: number;
  liabilityType: string;
  liabilityId: number;
  amount: number;
  date: string;
  fromAccountId: string | null;
  notes: string | null;
  createdAt: string;
  source?: "manual" | "auto";
}

interface PlaidAccountItem {
  accountId: string;
  itemId: string;
  institutionName: string;
  healthy: boolean;
  accounts: Array<{ accountId: string; name: string }>;
}

interface LiabilitiesSummary {
  totalDebt: number;
  totalMinPayments: number;
  totalPaymentsThisMonth: number;
  totalPaymentsLastMonth: number;
  paymentCount: number;
  paymentsThisMonthCount: number;
  paymentsByLiability: Record<string, DebtPayment[]>;
  manualLiabilities: ManualLiability[];
  plaidLiabilities: PlaidLiability[];
}

interface UnifiedLiability {
  type: "plaid" | "manual";
  id: number;
  name: string;
  category: string;
  balance: number;
  aprPercentage: number | null;
  minimumPayment: number | null;
  manualPaymentAmount: number | null;
  nextPaymentDueDate: string | null;
  notes: string | null;
  creditLimit: number | null;
  lastUpdated: string;
  payments: DebtPayment[];
}

const liabilityFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().min(1, "Category is required"),
  balance: z.coerce.number().min(0, "Balance must be positive"),
  aprPercentage: z.string().optional(),
  minimumPayment: z.string().optional(),
  manualPaymentAmount: z.string().optional(),
  nextPaymentDueDate: z.string().optional(),
  notes: z.string().optional(),
});

type LiabilityFormValues = z.infer<typeof liabilityFormSchema>;

const paymentFormSchema = z.object({
  amount: z.coerce.number().min(0.01, "Amount must be positive"),
  date: z.string().min(1, "Date is required"),
  fromAccountId: z.string().optional(),
  notes: z.string().optional(),
});

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

const LIABILITY_CATEGORIES = ["Credit Card", "Student Loan", "Mortgage", "Auto Loan", "Personal Loan", "Medical Debt", "Other"];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatCurrencyPrecise(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatLiabilityType(type: string): string {
  const labels: Record<string, string> = { credit: "Credit Card", student: "Student Loan", mortgage: "Mortgage" };
  return labels[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

interface PlaidAccount {
  accountId: string;
  name: string;
  type: string;
}

function LiabilityCard({
  liability,
  onEdit,
  onDelete,
  onLogPayment,
  expanded,
  onToggle,
}: {
  liability: UnifiedLiability;
  onEdit?: () => void;
  onDelete?: () => void;
  onLogPayment: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [editingApr, setEditingApr] = useState(false);
  const [aprValue, setAprValue] = useState(String(liability.aprPercentage ?? ""));
  const [editingPayment, setEditingPayment] = useState(false);
  const [paymentValue, setPaymentValue] = useState(String(liability.manualPaymentAmount ?? ""));
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(liability.notes ?? "");

  const updateFieldMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => {
      if (liability.type === "plaid") {
        return apiRequest("PATCH", `/api/finance/plaid-liabilities/${liability.id}`, data);
      }
      return apiRequest("PUT", `/api/finance/manual-liabilities/${liability.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-liabilities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/total-liability-payments"] });
      setEditingApr(false);
      setEditingPayment(false);
      setEditingNotes(false);
    },
  });

  const deletePaymentMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/debt-payments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-liabilities"] });
    },
  });

  const utilization = liability.creditLimit && liability.creditLimit > 0
    ? Math.min(100, (liability.balance / liability.creditLimit) * 100)
    : null;

  const totalPaid = liability.payments.reduce((s, p) => s + p.amount, 0);
  const originalBalance = totalPaid + liability.balance;
  const payoffProgress = originalBalance > 0 ? Math.min(100, (totalPaid / originalBalance) * 100) : 0;

  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden" data-testid={`liability-card-${liability.type}-${liability.id}`}>
      <div
        className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
        data-testid={`liability-toggle-${liability.type}-${liability.id}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium text-foreground truncate" data-testid={`text-liability-name-${liability.type}-${liability.id}`}>
                {liability.name}
              </h4>
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                liability.type === "plaid"
                  ? "bg-info/10 text-info-foreground"
                  : "bg-warning/10 dark:bg-warning/10 text-warning-foreground dark:text-warning"
              }`}>
                {liability.type === "plaid" ? "Plaid" : "Manual"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5 flex-wrap">
              <span>{liability.category}</span>
              {liability.aprPercentage !== null && (
                <><span className="text-border">·</span><span>{liability.aprPercentage}% APR</span></>
              )}
              {liability.minimumPayment !== null && (
                <><span className="text-border">·</span><span>{formatCurrency(liability.minimumPayment)}/mo min</span></>
              )}
              {liability.manualPaymentAmount !== null && liability.manualPaymentAmount > 0 && (
                <><span className="text-border">·</span><span className="text-primary font-medium">{formatCurrency(liability.manualPaymentAmount)}/mo actual</span></>
              )}
              {liability.nextPaymentDueDate && (
                <><span className="text-border">·</span><span>Due {liability.nextPaymentDueDate}</span></>
              )}
              {liability.payments.length > 0 && (
                <><span className="text-border">·</span><span>{liability.payments.length} payment{liability.payments.length !== 1 ? "s" : ""}</span></>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-2">
          <div className="text-right">
            <div className="text-sm font-medium tabular-nums text-foreground" data-testid={`text-balance-${liability.type}-${liability.id}`}>
              {formatCurrency(liability.balance)}
            </div>
            {utilization !== null && (
              <div className="text-xs text-muted-foreground">{utilization.toFixed(0)}% used</div>
            )}
            {totalPaid > 0 && (
              <div className="flex items-center gap-1.5 mt-1" data-testid={`payoff-progress-${liability.type}-${liability.id}`}>
                <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-success rounded-full transition-all" style={{ width: `${payoffProgress}%` }} />
                </div>
                <span className="text-xs text-success-foreground tabular-nums">{payoffProgress.toFixed(0)}%</span>
              </div>
            )}
          </div>
          {liability.type === "manual" && (
            <div className="flex items-center gap-1">
              {onEdit && (
                <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="text-muted-foreground hover:text-foreground p-1" data-testid={`button-edit-liability-${liability.id}`}>
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {onDelete && (
                <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-muted-foreground hover:text-destructive p-1" data-testid={`button-delete-liability-${liability.id}`}>
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3">
          <div className="flex items-center gap-4 text-xs flex-wrap">
            {liability.creditLimit !== null && (
              <div><span className="text-muted-foreground">Credit Limit:</span> <span className="font-medium">{formatCurrency(liability.creditLimit)}</span></div>
            )}
            {totalPaid > 0 && (
              <div><span className="text-muted-foreground">Total Paid:</span> <span className="font-medium text-success-foreground">{formatCurrencyPrecise(totalPaid)}</span></div>
            )}
            <FreshnessBadge lastUpdated={liability.lastUpdated} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">APR %</span>
              {editingApr ? (
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    step="0.01"
                    value={aprValue}
                    onChange={e => setAprValue(e.target.value)}
                    onBlur={() => {
                      const val = parseFloat(aprValue);
                      updateFieldMutation.mutate({ aprPercentage: isNaN(val) ? null : val });
                    }}
                    onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } if (e.key === "Escape") setEditingApr(false); }}
                    className="h-6 text-xs w-20"
                    autoFocus
                    data-testid={`input-apr-${liability.type}-${liability.id}`}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setAprValue(String(liability.aprPercentage ?? "")); setEditingApr(true); }}
                  className="text-xs font-medium hover:text-primary transition-colors flex items-center gap-1"
                  data-testid={`button-edit-apr-${liability.type}-${liability.id}`}
                >
                  {liability.aprPercentage !== null ? `${liability.aprPercentage}%` : "Not set"}
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                </button>
              )}
            </div>
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Payment</span>
              {editingPayment ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">$</span>
                  <Input
                    type="number"
                    step="0.01"
                    value={paymentValue}
                    onChange={e => setPaymentValue(e.target.value)}
                    onBlur={() => {
                      const val = parseFloat(paymentValue);
                      updateFieldMutation.mutate({ manualPaymentAmount: isNaN(val) || val <= 0 ? null : val });
                    }}
                    onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } if (e.key === "Escape") setEditingPayment(false); }}
                    className="h-6 text-xs w-20"
                    autoFocus
                    data-testid={`input-manual-payment-${liability.type}-${liability.id}`}
                  />
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setPaymentValue(String(liability.manualPaymentAmount ?? "")); setEditingPayment(true); }}
                  className="text-xs font-medium hover:text-primary transition-colors flex items-center gap-1"
                  data-testid={`button-edit-payment-${liability.type}-${liability.id}`}
                >
                  {liability.manualPaymentAmount !== null && liability.manualPaymentAmount > 0
                    ? formatCurrency(liability.manualPaymentAmount)
                    : liability.minimumPayment !== null ? `${formatCurrency(liability.minimumPayment)} (min)` : "Not set"}
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                </button>
              )}
              {liability.minimumPayment !== null && liability.manualPaymentAmount !== null && liability.manualPaymentAmount > 0 && (
                <span className="text-xs text-muted-foreground">Min: {formatCurrency(liability.minimumPayment)}</span>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</span>
            {editingNotes ? (
              <div className="flex items-center gap-1">
                <Input
                  value={notesValue}
                  onChange={e => setNotesValue(e.target.value)}
                  onBlur={() => {
                    const val = notesValue.trim();
                    updateFieldMutation.mutate({ notes: val || null });
                    setEditingNotes(false);
                  }}
                  onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } if (e.key === "Escape") setEditingNotes(false); }}
                  className="h-6 text-xs flex-1"
                  autoFocus
                  placeholder="Add a note..."
                  data-testid={`input-notes-${liability.type}-${liability.id}`}
                />
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setNotesValue(liability.notes ?? ""); setEditingNotes(true); }}
                className="text-xs hover:text-primary transition-colors flex items-center gap-1 italic text-muted-foreground"
                data-testid={`button-edit-notes-${liability.type}-${liability.id}`}
              >
                {liability.notes || "No notes"}
                <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between">
            <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Clock className="h-3 w-3" /> Payment History
            </h5>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs px-2"
              onClick={(e) => { e.stopPropagation(); onLogPayment(); }}
              data-testid={`button-log-payment-${liability.type}-${liability.id}`}
            >
              <DollarSign className="h-3 w-3 mr-1" /> Log Payment
            </Button>
          </div>

          {liability.payments.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic" data-testid="text-no-payments">No payments recorded yet</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {liability.payments.slice(0, 10).map(p => (
                <div key={`${p.source || "manual"}-${p.id}`} className="flex items-center justify-between py-1 group text-xs" data-testid={`payment-${p.source || "manual"}-${p.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground tabular-nums">{new Date(p.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}</span>
                    {p.source === "auto" ? (
                      <span className="text-xs px-1 py-0.5 rounded bg-info/10 text-info-foreground font-medium" data-testid={`badge-auto-${p.id}`}>Auto-detected</span>
                    ) : (
                      <span className="text-xs px-1 py-0.5 rounded bg-neutral/10 text-neutral-foreground font-medium" data-testid={`badge-manual-${p.id}`}>Manual</span>
                    )}
                    {p.notes && <span className="text-muted-foreground/70 truncate max-w-[120px]">{p.notes}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium tabular-nums text-success-foreground">{formatCurrencyPrecise(p.amount)}</span>
                    {(!p.source || p.source === "manual") && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deletePaymentMutation.mutate(p.id); }}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                        data-testid={`button-delete-payment-${p.id}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {liability.payments.length > 10 && (
                <p className="text-xs text-muted-foreground/50 text-center">+ {liability.payments.length - 10} more payments</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LiabilitiesContent() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManualLiability | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<UnifiedLiability | null>(null);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  const summaryQuery = useQuery<LiabilitiesSummary>({ queryKey: ["/api/finance/liabilities-summary"] });
  const accountsQuery = useQuery<PlaidAccountItem[]>({ queryKey: ["/api/plaid/accounts"] });

  const summary = summaryQuery.data;
  const plaidItems = accountsQuery.data || [];

  const institutionByItemId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of plaidItems) map[item.itemId] = item.institutionName;
    return map;
  }, [plaidItems]);

  const unifiedLiabilities = useMemo((): UnifiedLiability[] => {
    if (!summary) return [];
    const list: UnifiedLiability[] = [];

    for (const p of summary.plaidLiabilities) {
      const key = `plaid:${p.id}`;
      list.push({
        type: "plaid",
        id: p.id,
        name: `${formatLiabilityType(p.liabilityType)}${institutionByItemId[p.itemId] ? ` — ${institutionByItemId[p.itemId]}` : ""}`,
        category: formatLiabilityType(p.liabilityType),
        balance: p.balance || 0,
        aprPercentage: p.aprPercentage,
        minimumPayment: p.minimumPayment,
        manualPaymentAmount: p.manualPaymentAmount,
        nextPaymentDueDate: p.nextPaymentDueDate,
        notes: p.notes ?? null,
        creditLimit: p.creditLimit,
        lastUpdated: p.lastUpdated,
        payments: summary.paymentsByLiability[key] || [],
      });
    }

    for (const m of summary.manualLiabilities) {
      const key = `manual:${m.id}`;
      list.push({
        type: "manual",
        id: m.id,
        name: m.name,
        category: m.category,
        balance: m.balance,
        aprPercentage: m.aprPercentage,
        minimumPayment: m.minimumPayment,
        manualPaymentAmount: m.manualPaymentAmount,
        nextPaymentDueDate: m.nextPaymentDueDate,
        notes: m.notes,
        creditLimit: null,
        lastUpdated: m.lastUpdated,
        payments: summary.paymentsByLiability[key] || [],
      });
    }

    return list.sort((a, b) => b.balance - a.balance);
  }, [summary, institutionByItemId]);

  const form = useForm<LiabilityFormValues>({
    resolver: zodResolver(liabilityFormSchema),
    defaultValues: { name: "", category: "", balance: 0, aprPercentage: "", minimumPayment: "", nextPaymentDueDate: "", notes: "" },
  });

  const paymentForm = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: { amount: 0, date: new Date().toISOString().split("T")[0], fromAccountId: "", notes: "" },
  });

  const allAccounts = useMemo(() => {
    const accts: PlaidAccount[] = [];
    for (const item of plaidItems) {
      if (Array.isArray(item.accounts)) {
        for (const a of item.accounts) {
          accts.push({ accountId: a.accountId, name: a.name, type: "depository" });
        }
      }
    }
    return accts;
  }, [plaidItems]);

  const openNew = () => {
    setEditing(null);
    form.reset({ name: "", category: "", balance: 0, aprPercentage: "", minimumPayment: "", manualPaymentAmount: "", nextPaymentDueDate: "", notes: "" });
    setDialogOpen(true);
  };

  const openEdit = (item: ManualLiability) => {
    setEditing(item);
    form.reset({
      name: item.name,
      category: item.category,
      balance: item.balance,
      aprPercentage: item.aprPercentage !== null ? String(item.aprPercentage) : "",
      minimumPayment: item.minimumPayment !== null ? String(item.minimumPayment) : "",
      manualPaymentAmount: item.manualPaymentAmount !== null ? String(item.manualPaymentAmount) : "",
      nextPaymentDueDate: item.nextPaymentDueDate || "",
      notes: item.notes || "",
    });
    setDialogOpen(true);
  };

  const openPayment = (liability: UnifiedLiability) => {
    setPaymentTarget(liability);
    paymentForm.reset({ amount: liability.minimumPayment || 0, date: new Date().toISOString().split("T")[0], fromAccountId: "", notes: "" });
    setPaymentDialogOpen(true);
  };

  const toggleCard = (key: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiRequest("POST", "/api/finance/manual-liabilities", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-liabilities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/total-liability-payments"] });
      setDialogOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown> & { id: number }) => apiRequest("PUT", `/api/finance/manual-liabilities/${data.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-liabilities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/total-liability-payments"] });
      setDialogOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/manual-liabilities/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-liabilities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/total-liability-payments"] });
    },
  });

  const logPaymentMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiRequest("POST", "/api/finance/debt-payments", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-liabilities"] });
      setPaymentDialogOpen(false);
    },
  });

  const onSubmit = (values: LiabilityFormValues) => {
    const aprStr = (values.aprPercentage ?? "").trim();
    const minStr = (values.minimumPayment ?? "").trim();
    const manualPayStr = (values.manualPaymentAmount ?? "").trim();
    const payload: Record<string, unknown> = {
      name: values.name,
      category: values.category,
      balance: values.balance,
      aprPercentage: aprStr !== "" ? Number(aprStr) : null,
      minimumPayment: minStr !== "" ? Number(minStr) : null,
      manualPaymentAmount: manualPayStr !== "" ? Number(manualPayStr) : null,
      nextPaymentDueDate: values.nextPaymentDueDate || null,
      notes: values.notes || null,
    };
    if (editing) {
      updateMutation.mutate({ ...payload, id: editing.id });
    } else {
      createMutation.mutate(payload);
    }
  };

  const onSubmitPayment = (values: PaymentFormValues) => {
    if (!paymentTarget) return;
    logPaymentMutation.mutate({
      liabilityType: paymentTarget.type,
      liabilityId: paymentTarget.id,
      amount: values.amount,
      date: values.date,
      fromAccountId: values.fromAccountId && values.fromAccountId !== "none" ? values.fromAccountId : null,
      notes: values.notes || null,
    });
  };

  const refreshLiabilitiesMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/plaid/refresh-liabilities"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/liabilities-summary"] });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const isLoading = summaryQuery.isLoading;
  const hasError = summaryQuery.isError;

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="liabilities-loading">
        <div className="grid grid-cols-2 @sm:grid-cols-4 gap-3">
          <SummaryMetricCardSkeleton /><SummaryMetricCardSkeleton /><SummaryMetricCardSkeleton /><SummaryMetricCardSkeleton />
        </div>
        {[1, 2].map(i => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-3 animate-pulse space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-3 w-48 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="liabilities-error">
        <AlertCircle className="h-6 w-6 text-destructive mb-2" />
        <p className="text-sm text-muted-foreground">Unable to load liabilities data.</p>
      </div>
    );
  }

  const debtReduction = summary ? summary.totalPaymentsLastMonth > 0
    ? ((summary.totalPaymentsThisMonth - summary.totalPaymentsLastMonth) / summary.totalPaymentsLastMonth * 100)
    : null
    : null;

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 @sm:grid-cols-4 gap-3">
        <SummaryMetricCard
          label="Total Debt"
          value={formatCurrency(summary?.totalDebt || 0)}
          icon={<CreditCard className="h-3.5 w-3.5" />}
          testId="metric-total-debt"
        />
        <SummaryMetricCard
          label="Min. Payments Due"
          value={formatCurrency(summary?.totalMinPayments || 0)}
          secondaryValue="/mo"
          testId="metric-min-payments"
        />
        <SummaryMetricCard
          label="Paid This Month"
          value={formatCurrency(summary?.totalPaymentsThisMonth || 0)}
          secondaryValue={`${summary?.paymentsThisMonthCount || 0} payment${(summary?.paymentsThisMonthCount || 0) !== 1 ? "s" : ""}`}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          testId="metric-paid-this-month"
        />
        <SummaryMetricCard
          label="MoM Change"
          value={debtReduction !== null ? `${debtReduction > 0 ? "+" : ""}${debtReduction.toFixed(0)}%` : "—"}
          secondaryValue={summary?.totalPaymentsLastMonth ? `vs ${formatCurrency(summary.totalPaymentsLastMonth)} last mo` : undefined}
          icon={<TrendingDown className="h-3.5 w-3.5" />}
          testId="metric-mom-change"
        />
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          All Liabilities ({unifiedLiabilities.length})
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refreshLiabilitiesMutation.mutate()}
            disabled={refreshLiabilitiesMutation.isPending}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            data-testid="button-refresh-liabilities"
          >
            <RefreshCw className={`h-3 w-3 ${refreshLiabilitiesMutation.isPending ? "animate-spin" : ""}`} />
            {refreshLiabilitiesMutation.isPending ? "Refreshing..." : "Refresh"}
          </button>
          <button onClick={openNew} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="button-add-liability">
            <Plus className="h-3 w-3" /> Add Manual
          </button>
        </div>
      </div>

      {unifiedLiabilities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card/50 p-6 text-center" data-testid="liabilities-empty">
          <CreditCard className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
          <p className="text-sm text-muted-foreground">No liabilities tracked</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Link a Plaid account or add manual liabilities to track your debt</p>
        </div>
      ) : (
        <div className="space-y-2">
          {unifiedLiabilities.map(l => {
            const key = `${l.type}:${l.id}`;
            return (
              <LiabilityCard
                key={key}
                liability={l}
                expanded={expandedCards.has(key)}
                onToggle={() => toggleCard(key)}
                onLogPayment={() => openPayment(l)}
                onEdit={l.type === "manual" ? () => {
                  const manual = summary?.manualLiabilities.find(m => m.id === l.id);
                  if (manual) openEdit(manual);
                } : undefined}
                onDelete={l.type === "manual" ? () => deleteMutation.mutate(l.id) : undefined}
              />
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">{editing ? "Edit Liability" : "Add Manual Liability"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Name</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-liability-name" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Category</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger className="h-8 text-xs" data-testid="select-liability-category"><SelectValue placeholder="Select category" /></SelectTrigger></FormControl>
                    <SelectContent>{LIABILITY_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="balance" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Balance ($)</FormLabel>
                  <FormControl><Input type="number" step="0.01" {...field} className="h-8 text-xs" data-testid="input-liability-balance" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="aprPercentage" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">APR %</FormLabel>
                    <FormControl><Input type="number" step="0.01" placeholder="Optional" {...field} className="h-8 text-xs" data-testid="input-liability-apr" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="minimumPayment" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Min. Payment ($)</FormLabel>
                    <FormControl><Input type="number" step="0.01" placeholder="Optional" {...field} className="h-8 text-xs" data-testid="input-liability-min-payment" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="manualPaymentAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Actual Monthly Payment ($)</FormLabel>
                  <FormControl><Input type="number" step="0.01" placeholder="What you actually pay (optional)" {...field} className="h-8 text-xs" data-testid="input-liability-manual-payment" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="nextPaymentDueDate" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Next Due Date</FormLabel>
                  <FormControl><Input type="date" {...field} className="h-8 text-xs" data-testid="input-liability-due-date" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Notes (optional)</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-liability-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(false)} data-testid="button-cancel-liability">Cancel</Button>
                <Button type="submit" size="sm" disabled={isPending} data-testid="button-save-liability">
                  {isPending ? "Saving..." : editing ? "Update" : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Log Payment — {paymentTarget?.name}</DialogTitle>
          </DialogHeader>
          <Form {...paymentForm}>
            <form onSubmit={paymentForm.handleSubmit(onSubmitPayment)} className="space-y-3">
              <FormField control={paymentForm.control} name="amount" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Amount ($)</FormLabel>
                  <FormControl><Input type="number" step="0.01" {...field} className="h-8 text-xs" data-testid="input-payment-amount" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={paymentForm.control} name="date" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Date</FormLabel>
                  <FormControl><Input type="date" {...field} className="h-8 text-xs" data-testid="input-payment-date" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {allAccounts.length > 0 && (
                <FormField control={paymentForm.control} name="fromAccountId" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">From Account (optional)</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger className="h-8 text-xs" data-testid="select-payment-account">
                          <SelectValue placeholder="Select source account" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">No account</SelectItem>
                        {allAccounts.map(a => (
                          <SelectItem key={a.accountId} value={a.accountId}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <FormField control={paymentForm.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Notes (optional)</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" placeholder="e.g. Extra payment toward principal" data-testid="input-payment-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setPaymentDialogOpen(false)} data-testid="button-cancel-payment">Cancel</Button>
                <Button type="submit" size="sm" disabled={logPaymentMutation.isPending} data-testid="button-save-payment">
                  {logPaymentMutation.isPending ? "Saving..." : "Log Payment"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
