import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { DollarSign, TrendingUp, Plus, Trash2, Edit2, Check, X, Briefcase, Receipt, Landmark } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";

interface IncomeDeduction {
  id: number;
  sourceId: number;
  name: string;
  amount: number;
  isPreTax: boolean;
  category?: string;
  monthlyAmount: number;
}

interface IncomeDeposit {
  id: number;
  sourceId: number;
  accountId: string | null;
  accountLabel: string | null;
  amount: number;
}

interface EnrichedIncomeSource {
  id: number;
  name: string;
  grossPay: number;
  payFrequency: string;
  effectiveDate: string | null;
  isActive: boolean;
  deductions: IncomeDeduction[];
  deposits: IncomeDeposit[];
  takeHomePay: number;
  monthlyGross: number;
  monthlyNet: number;
}

interface IncomeData {
  sources: EnrichedIncomeSource[];
  totalMonthlyGross: number;
  totalMonthlyNet: number;
}

interface PlaidAccountItem {
  accountId: string;
  itemId: string;
  institutionName: string;
  accounts: Array<{
    accountId: string;
    name: string;
    type: string;
    mask: string | null;
    currentBalance: number | null;
  }>;
}

interface ManualAsset {
  id: number;
  name: string;
  category: string;
  currentValue: number;
}

interface DepositAccount {
  accountId: string;
  name: string;
  mask: string | null;
  source: "plaid" | "manual";
}

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Semi-Monthly",
  monthly: "Monthly",
  annually: "Annually",
};

const FREQUENCY_PER_YEAR: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annually: 1,
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatCurrencyPrecise(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function IncomeContent() {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("Primary Salary");
  const [newGross, setNewGross] = useState("");
  const [newFrequency, setNewFrequency] = useState("biweekly");
  const [newEffectiveDate, setNewEffectiveDate] = useState("");

  const [addDeductionSourceId, setAddDeductionSourceId] = useState<number | null>(null);
  const [newDeductionName, setNewDeductionName] = useState("");
  const [newDeductionAmount, setNewDeductionAmount] = useState("");
  const [newDeductionPreTax, setNewDeductionPreTax] = useState(true);

  const [addDepositSourceId, setAddDepositSourceId] = useState<number | null>(null);
  const [newDepositLabel, setNewDepositLabel] = useState("");
  const [newDepositAmount, setNewDepositAmount] = useState("");
  const [newDepositAccountId, setNewDepositAccountId] = useState("");

  const incomeQuery = useQuery<IncomeData>({ queryKey: ["/api/finance/income-sources"] });
  const accountsQuery = useQuery<PlaidAccountItem[]>({ queryKey: ["/api/plaid/accounts"] });
  const assetsQuery = useQuery<{ assets: ManualAsset[] }>({ queryKey: ["/api/finance/manual-assets"] });

  const sources = incomeQuery.data?.sources || [];
  const plaidItems = accountsQuery.data || [];
  const manualAssets = assetsQuery.data?.assets || [];

  const depositoryAccounts: DepositAccount[] = (() => {
    const result: DepositAccount[] = [];
    for (const item of plaidItems) {
      for (const acct of item.accounts) {
        if (acct.type === "depository") {
          result.push({
            accountId: acct.accountId,
            name: acct.name,
            mask: acct.mask,
            source: "plaid",
          });
        }
      }
    }
    for (const asset of manualAssets) {
      result.push({
        accountId: `manual-${asset.id}`,
        name: asset.name,
        mask: null,
        source: "manual",
      });
    }
    return result;
  })();

  const createSourceMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/finance/income-sources", {
      name: newName,
      grossPay: parseFloat(newGross) || 0,
      payFrequency: newFrequency,
      effectiveDate: newEffectiveDate || null,
      isActive: true,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] });
      setShowAddForm(false);
      setNewName("Primary Salary");
      setNewGross("");
      setNewFrequency("biweekly");
      setNewEffectiveDate("");
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/income-sources/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const toggleSourceMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiRequest("PUT", `/api/finance/income-sources/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const addDeductionMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/finance/income-deductions", {
      sourceId: addDeductionSourceId,
      name: newDeductionName,
      amount: parseFloat(newDeductionAmount) || 0,
      isPreTax: newDeductionPreTax,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] });
      setAddDeductionSourceId(null);
      setNewDeductionName("");
      setNewDeductionAmount("");
      setNewDeductionPreTax(true);
    },
  });

  const deleteDeductionMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/income-deductions/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const addDepositMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/finance/income-deposits", {
      sourceId: addDepositSourceId,
      accountId: newDepositAccountId || null,
      accountLabel: newDepositLabel || null,
      amount: parseFloat(newDepositAmount) || 0,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] });
      setAddDepositSourceId(null);
      setNewDepositLabel("");
      setNewDepositAmount("");
      setNewDepositAccountId("");
    },
  });

  const deleteDepositMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/income-deposits/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const updateDeductionMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; amount?: number; isPreTax?: boolean }) =>
      apiRequest("PUT", `/api/finance/income-deductions/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const updateDepositMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; amount?: number; accountLabel?: string }) =>
      apiRequest("PUT", `/api/finance/income-deposits/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const updateSourceMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; grossPay?: number; payFrequency?: string; effectiveDate?: string | null }) =>
      apiRequest("PUT", `/api/finance/income-sources/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finance/income-sources"] }),
  });

  const [editingDeduction, setEditingDeduction] = useState<{ id: number; amount: string } | null>(null);
  const [editingDeposit, setEditingDeposit] = useState<{ id: number; amount: string } | null>(null);
  const [editingSource, setEditingSource] = useState<{ id: number; grossPay: string } | null>(null);

  const isLoading = incomeQuery.isLoading;

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="income-loading">
        <div className="grid grid-cols-2 @sm:grid-cols-3 gap-3">
          <SummaryMetricCardSkeleton />
          <SummaryMetricCardSkeleton />
          <SummaryMetricCardSkeleton />
        </div>
        {[1, 2].map(i => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-3 animate-pulse space-y-2">
            <div className="h-4 w-40 bg-muted rounded" />
            <div className="h-3 w-56 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  const totalMonthlyGross = incomeQuery.data?.totalMonthlyGross || 0;
  const totalMonthlyNet = incomeQuery.data?.totalMonthlyNet || 0;
  const totalAnnualGross = totalMonthlyGross * 12;

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 @sm:grid-cols-3 gap-3" data-testid="income-summary">
        <SummaryMetricCard
          label="Monthly Gross"
          value={formatCurrency(totalMonthlyGross)}
          secondaryValue={`${formatCurrency(totalAnnualGross)}/yr`}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          testId="metric-monthly-gross"
        />
        <SummaryMetricCard
          label="Monthly Take-Home"
          value={formatCurrency(totalMonthlyNet)}
          secondaryValue={totalMonthlyGross > 0 ? `${((totalMonthlyNet / totalMonthlyGross) * 100).toFixed(1)}% of gross` : undefined}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          testId="metric-monthly-net"
        />
        <SummaryMetricCard
          label="Active Sources"
          value={`${sources.filter(s => s.isActive).length}`}
          secondaryValue={`${sources.length} total`}
          icon={<Briefcase className="h-3.5 w-3.5" />}
          testId="metric-active-sources"
        />
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Income Sources</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAddForm(!showAddForm)}
          data-testid="button-add-income-source"
        >
          <Plus className="h-3 w-3 mr-1" />
          Add Source
        </Button>
      </div>

      {showAddForm && (
        <div className="rounded-lg border border-border/50 bg-card p-4 space-y-3" data-testid="form-add-income-source">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase">Source Name</label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="h-8 text-xs mt-1"
                placeholder="Primary Salary"
                data-testid="input-source-name"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase">Gross Pay (per period)</label>
              <Input
                type="number"
                step="0.01"
                value={newGross}
                onChange={e => setNewGross(e.target.value)}
                className="h-8 text-xs mt-1"
                placeholder="3500.00"
                data-testid="input-gross-pay"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase">Pay Frequency</label>
              <Select value={newFrequency} onValueChange={setNewFrequency}>
                <SelectTrigger className="h-8 text-xs mt-1" data-testid="select-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(FREQUENCY_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase">Effective Date</label>
              <Input
                type="date"
                value={newEffectiveDate}
                onChange={e => setNewEffectiveDate(e.target.value)}
                className="h-8 text-xs mt-1"
                data-testid="input-effective-date"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)} data-testid="button-cancel-source">
              <X className="h-3 w-3 mr-1" />Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => createSourceMutation.mutate()}
              disabled={!newName || !newGross || createSourceMutation.isPending}
              data-testid="button-save-source"
            >
              <Check className="h-3 w-3 mr-1" />{createSourceMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {sources.length === 0 && !showAddForm && (
        <div className="rounded-lg border border-dashed border-border bg-card/50 p-6 text-center" data-testid="income-empty-state">
          <Briefcase className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
          <p className="text-sm text-muted-foreground">No income sources yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Add your salary, freelance income, or other sources to track paycheck breakdowns</p>
        </div>
      )}

      {sources.map(source => (
        <div key={source.id} className="rounded-lg border border-border/50 bg-card overflow-hidden" data-testid={`income-source-${source.id}`}>
          <div className="px-4 py-3 flex items-center justify-between border-b border-border/30">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={source.isActive}
                  onCheckedChange={(checked) => toggleSourceMutation.mutate({ id: source.id, isActive: checked })}
                  data-testid={`switch-active-${source.id}`}
                />
                <div>
                  <h4 className={`text-sm font-medium ${source.isActive ? "text-foreground" : "text-muted-foreground line-through"}`} data-testid={`text-source-name-${source.id}`}>
                    {source.name}
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {FREQUENCY_LABELS[source.payFrequency] || source.payFrequency}
                    {source.effectiveDate && ` · Since ${source.effectiveDate}`}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-sm font-medium tabular-nums" data-testid={`text-gross-${source.id}`}>
                  {editingSource?.id === source.id ? (
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="0.01"
                        value={editingSource.grossPay}
                        onChange={e => setEditingSource({ ...editingSource, grossPay: e.target.value })}
                        className="h-6 text-xs w-24 px-1"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            updateSourceMutation.mutate({ id: source.id, grossPay: parseFloat(editingSource.grossPay) || 0 });
                            setEditingSource(null);
                          }
                          if (e.key === "Escape") setEditingSource(null);
                        }}
                        data-testid={`input-edit-gross-${source.id}`}
                      />
                      <button onClick={() => { updateSourceMutation.mutate({ id: source.id, grossPay: parseFloat(editingSource.grossPay) || 0 }); setEditingSource(null); }} className="text-primary"><Check className="h-3 w-3" /></button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setEditingSource({ id: source.id, grossPay: source.grossPay.toString() })}
                      className="hover:text-primary transition-colors cursor-pointer"
                      data-testid={`button-edit-gross-${source.id}`}
                    >
                      {formatCurrencyPrecise(source.grossPay)}<span className="text-xs text-muted-foreground ml-1">gross</span>
                    </button>
                  )}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums" data-testid={`text-monthly-${source.id}`}>
                  {formatCurrency(source.monthlyGross)}/mo · {formatCurrency(source.monthlyNet)}/mo net
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => deleteSourceMutation.mutate(source.id)}
                disabled={deleteSourceMutation.isPending}
                data-testid={`button-delete-source-${source.id}`}
              >
                <Trash2 className="h-3 w-3 text-muted-foreground" />
              </Button>
            </div>
          </div>

          <div className="px-4 py-3 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <Receipt className="h-3 w-3" /> Deductions
                </h5>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setAddDeductionSourceId(addDeductionSourceId === source.id ? null : source.id)}
                  data-testid={`button-add-deduction-${source.id}`}
                >
                  <Plus className="h-3 w-3 mr-0.5" />Add
                </Button>
              </div>

              {source.deductions.length === 0 && addDeductionSourceId !== source.id && (
                <p className="text-xs text-muted-foreground/60 italic">No deductions added</p>
              )}

              {source.deductions.map(d => (
                <div key={d.id} className="flex items-center justify-between py-1 group" data-testid={`deduction-${d.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-foreground">{d.name}</span>
                    <span className={`text-xs px-1 py-0.5 rounded ${d.isPreTax ? "bg-info/10 text-info-foreground" : "bg-cat-event/15 text-cat-event-foreground"}`}>
                      {d.isPreTax ? "pre-tax" : "post-tax"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {editingDeduction?.id === d.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          step="0.01"
                          value={editingDeduction.amount}
                          onChange={e => setEditingDeduction({ ...editingDeduction, amount: e.target.value })}
                          className="h-5 text-xs w-20 px-1"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              updateDeductionMutation.mutate({ id: d.id, amount: parseFloat(editingDeduction.amount) || 0 });
                              setEditingDeduction(null);
                            }
                            if (e.key === "Escape") setEditingDeduction(null);
                          }}
                          data-testid={`input-edit-deduction-${d.id}`}
                        />
                        <button onClick={() => { updateDeductionMutation.mutate({ id: d.id, amount: parseFloat(editingDeduction.amount) || 0 }); setEditingDeduction(null); }} className="text-primary"><Check className="h-3 w-3" /></button>
                        <button onClick={() => setEditingDeduction(null)} className="text-muted-foreground"><X className="h-3 w-3" /></button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingDeduction({ id: d.id, amount: d.amount.toString() })}
                        className="text-xs tabular-nums text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        data-testid={`text-deduction-amount-${d.id}`}
                      >
                        -{formatCurrencyPrecise(d.monthlyAmount)}
                        <span className="text-xs text-muted-foreground ml-0.5">/mo</span>
                        {source.payFrequency !== "monthly" && (
                          <span className="text-xs text-muted-foreground/70 ml-1">({formatCurrencyPrecise(d.amount)}/{source.payFrequency === "annually" ? "yr" : "paycheck"})</span>
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => deleteDeductionMutation.mutate(d.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      data-testid={`button-delete-deduction-${d.id}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}

              {addDeductionSourceId === source.id && (
                <div className="flex items-center gap-2 mt-2 bg-muted/30 rounded-md p-2" data-testid={`form-add-deduction-${source.id}`}>
                  <Input
                    value={newDeductionName}
                    onChange={e => setNewDeductionName(e.target.value)}
                    className="h-6 text-xs flex-1"
                    placeholder="401k, Federal Tax..."
                    data-testid="input-deduction-name"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    value={newDeductionAmount}
                    onChange={e => setNewDeductionAmount(e.target.value)}
                    className="h-6 text-xs w-24"
                    placeholder="Amount"
                    data-testid="input-deduction-amount"
                  />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">Pre-tax</span>
                    <Switch
                      checked={newDeductionPreTax}
                      onCheckedChange={setNewDeductionPreTax}
                      data-testid="switch-deduction-pretax"
                    />
                  </div>
                  <button
                    onClick={() => addDeductionMutation.mutate()}
                    disabled={!newDeductionName || !newDeductionAmount || addDeductionMutation.isPending}
                    className="text-primary hover:text-primary/80 disabled:opacity-50"
                    data-testid="button-save-deduction"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button onClick={() => setAddDeductionSourceId(null)} className="text-muted-foreground" data-testid="button-cancel-deduction">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            <div className="border-t border-border/30 pt-3">
              <div className="flex items-center justify-between mb-2">
                <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <Landmark className="h-3 w-3" /> Deposit Allocations
                </h5>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setAddDepositSourceId(addDepositSourceId === source.id ? null : source.id)}
                  data-testid={`button-add-deposit-${source.id}`}
                >
                  <Plus className="h-3 w-3 mr-0.5" />Add
                </Button>
              </div>

              {source.deposits.length === 0 && addDepositSourceId !== source.id && (
                <p className="text-xs text-muted-foreground/60 italic">No deposit allocations set</p>
              )}

              {source.deposits.map(d => (
                <div key={d.id} className="flex items-center justify-between py-1 group" data-testid={`deposit-${d.id}`}>
                  <span className="text-xs text-foreground">{d.accountLabel || d.accountId || "Unknown Account"}</span>
                  <div className="flex items-center gap-2">
                    {editingDeposit?.id === d.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          step="0.01"
                          value={editingDeposit.amount}
                          onChange={e => setEditingDeposit({ ...editingDeposit, amount: e.target.value })}
                          className="h-5 text-xs w-20 px-1"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              updateDepositMutation.mutate({ id: d.id, amount: parseFloat(editingDeposit.amount) || 0 });
                              setEditingDeposit(null);
                            }
                            if (e.key === "Escape") setEditingDeposit(null);
                          }}
                          data-testid={`input-edit-deposit-${d.id}`}
                        />
                        <button onClick={() => { updateDepositMutation.mutate({ id: d.id, amount: parseFloat(editingDeposit.amount) || 0 }); setEditingDeposit(null); }} className="text-primary"><Check className="h-3 w-3" /></button>
                        <button onClick={() => setEditingDeposit(null)} className="text-muted-foreground"><X className="h-3 w-3" /></button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingDeposit({ id: d.id, amount: d.amount.toString() })}
                        className="text-xs tabular-nums text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        data-testid={`text-deposit-amount-${d.id}`}
                      >
                        {formatCurrencyPrecise(d.amount)}
                      </button>
                    )}
                    <button
                      onClick={() => deleteDepositMutation.mutate(d.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      data-testid={`button-delete-deposit-${d.id}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}

              {addDepositSourceId === source.id && (
                <div className="flex items-center gap-2 mt-2 bg-muted/30 rounded-md p-2" data-testid={`form-add-deposit-${source.id}`}>
                  <Select value={newDepositAccountId} onValueChange={(val) => {
                    setNewDepositAccountId(val);
                    const acct = depositoryAccounts.find(a => a.accountId === val);
                    if (acct) setNewDepositLabel(`${acct.name}${acct.mask ? ` ···${acct.mask}` : ""}`);
                  }}>
                    <SelectTrigger className="h-6 text-xs flex-1" data-testid="select-deposit-account">
                      <SelectValue placeholder="Select account..." />
                    </SelectTrigger>
                    <SelectContent>
                      {depositoryAccounts.map(a => (
                        <SelectItem key={a.accountId} value={a.accountId}>
                          {a.name}{a.mask ? ` ···${a.mask}` : ""}{a.source === "manual" ? " (manual)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    step="0.01"
                    value={newDepositAmount}
                    onChange={e => setNewDepositAmount(e.target.value)}
                    className="h-6 text-xs w-24"
                    placeholder="Amount"
                    data-testid="input-deposit-amount"
                  />
                  <button
                    onClick={() => addDepositMutation.mutate()}
                    disabled={!newDepositAmount || addDepositMutation.isPending}
                    className="text-primary hover:text-primary/80 disabled:opacity-50"
                    data-testid="button-save-deposit"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button onClick={() => setAddDepositSourceId(null)} className="text-muted-foreground" data-testid="button-cancel-deposit">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            <div className="border-t border-border/30 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">Take-Home Pay</span>
                <span className="text-sm font-semibold tabular-nums text-foreground" data-testid={`text-take-home-${source.id}`}>
                  {formatCurrencyPrecise(source.takeHomePay)}
                  <span className="text-xs text-muted-foreground ml-1">per {source.payFrequency === "annually" ? "year" : "paycheck"}</span>
                </span>
              </div>
              {source.deductions.length > 0 && (
                <div className="mt-1 flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-success"
                      style={{ width: `${source.grossPay > 0 ? (source.takeHomePay / source.grossPay) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {source.grossPay > 0 ? `${((source.takeHomePay / source.grossPay) * 100).toFixed(1)}%` : "0%"}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
