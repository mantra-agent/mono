import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Plus, Pencil, Trash2, Car, Home, Wrench, Package, DollarSign, TrendingDown, PiggyBank } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";

interface FinancedAsset {
  id: number;
  name: string;
  category: string;
  purchasePrice: number;
  purchaseDate: string | null;
  currentValue: number;
  depreciationMethod: string | null;
  usefulLifeMonths: number | null;
  salvageValue: number | null;
  loanOriginalAmount: number | null;
  loanBalance: number | null;
  loanApr: number | null;
  monthlyPayment: number | null;
  totalPayments: number | null;
  paymentsMade: number | null;
  loanStartDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
};

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  vehicle: <Car className="h-4 w-4" />,
  real_estate: <Home className="h-4 w-4" />,
  equipment: <Wrench className="h-4 w-4" />,
  other: <Package className="h-4 w-4" />,
};

const CATEGORY_LABELS: Record<string, string> = {
  vehicle: "Vehicle",
  real_estate: "Real Estate",
  equipment: "Equipment",
  other: "Other",
};

const DEPRECIATION_LABELS: Record<string, string> = {
  none: "None",
  straight_line: "Straight Line",
  declining_balance: "Declining Balance",
};

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().min(1, "Category is required"),
  purchasePrice: z.coerce.number().min(0, "Must be positive"),
  purchaseDate: z.string().optional().default(""),
  currentValue: z.coerce.number().min(0, "Must be positive"),
  depreciationMethod: z.string().default("none"),
  usefulLifeMonths: z.coerce.number().optional().nullable(),
  salvageValue: z.coerce.number().optional().nullable(),
  loanOriginalAmount: z.coerce.number().optional().nullable(),
  loanBalance: z.coerce.number().optional().nullable(),
  loanApr: z.coerce.number().optional().nullable(),
  monthlyPayment: z.coerce.number().optional().nullable(),
  totalPayments: z.coerce.number().int().optional().nullable(),
  paymentsMade: z.coerce.number().int().optional().nullable(),
  loanStartDate: z.string().optional().default(""),
  notes: z.string().optional().default(""),
});

type FormValues = z.infer<typeof formSchema>;

function AssetCard({ asset, onEdit, onDelete }: { asset: FinancedAsset; onEdit: () => void; onDelete: () => void }) {
  const equity = (asset.currentValue || 0) - (asset.loanBalance || 0);
  const hasLoan = asset.loanBalance !== null && asset.loanBalance > 0;
  const remainingPayments = asset.totalPayments && asset.paymentsMade !== null ? asset.totalPayments - (asset.paymentsMade || 0) : null;
  const depreciation = (asset.purchasePrice || 0) - (asset.currentValue || 0);
  const depPct = asset.purchasePrice > 0 ? (depreciation / asset.purchasePrice) * 100 : 0;

  return (
    <div className="rounded-lg border border-border/50 bg-card p-4" data-testid={`asset-card-${asset.id}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-2 rounded-md bg-muted shrink-0">
            {CATEGORY_ICONS[asset.category] || CATEGORY_ICONS.other}
          </div>
          <div className="min-w-0">
            <div className="font-medium text-foreground truncate">{asset.name}</div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="text-xs font-normal" data-testid={`category-badge-${asset.id}`}>
                {CATEGORY_LABELS[asset.category] || asset.category}
              </Badge>
              {asset.depreciationMethod && asset.depreciationMethod !== "none" && (
                <span>{DEPRECIATION_LABELS[asset.depreciationMethod]}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} data-testid={`edit-asset-${asset.id}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-error hover:text-error-foreground" onClick={onDelete} data-testid={`delete-asset-${asset.id}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 @sm:grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Current Value</div>
          <div className="font-semibold text-foreground" data-testid={`value-${asset.id}`}>{fmt(asset.currentValue)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Purchase Price</div>
          <div className="text-foreground">{fmt(asset.purchasePrice)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Depreciation</div>
          <div className="text-error-foreground">{fmt(depreciation)} ({depPct.toFixed(1)}%)</div>
        </div>
        {hasLoan && (
          <>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">Loan Balance</div>
              <div className="text-foreground" data-testid={`loan-balance-${asset.id}`}>{fmt(asset.loanBalance)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">Monthly Payment</div>
              <div className="text-foreground">{asset.monthlyPayment ? fmt(asset.monthlyPayment) : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">APR</div>
              <div className="text-foreground">{asset.loanApr !== null ? `${asset.loanApr}%` : "—"}</div>
            </div>
            {remainingPayments !== null && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Remaining Payments</div>
                <div className="text-foreground">{remainingPayments}</div>
              </div>
            )}
          </>
        )}
        <div className={hasLoan ? "col-span-2 @sm:col-span-1" : ""}>
          <div className="text-xs text-muted-foreground mb-0.5">Equity</div>
          <div className={`font-semibold ${equity >= 0 ? "text-success-foreground" : "text-error-foreground"}`} data-testid={`equity-${asset.id}`}>
            {fmt(equity)}
          </div>
        </div>
      </div>

      {asset.notes && (
        <div className="mt-2 text-xs text-muted-foreground border-t border-border/30 pt-2">{asset.notes}</div>
      )}
    </div>
  );
}

export function AssetsContent() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<FinancedAsset | null>(null);
  const { toast } = useToast();

  const { data: assets, isLoading } = useQuery<FinancedAsset[]>({
    queryKey: ["/api/finance/financed-assets"],
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "", category: "vehicle", purchasePrice: 0, purchaseDate: "",
      currentValue: 0, depreciationMethod: "none", usefulLifeMonths: null,
      salvageValue: null, loanOriginalAmount: null, loanBalance: null,
      loanApr: null, monthlyPayment: null, totalPayments: null,
      paymentsMade: null, loanStartDate: "", notes: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: FormValues) => apiRequest("POST", "/api/finance/financed-assets", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/financed-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Asset added" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: FormValues & { id: number }) => apiRequest("PUT", `/api/finance/financed-assets/${data.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/financed-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      setDialogOpen(false);
      setEditingAsset(null);
      form.reset();
      toast({ title: "Asset updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/financed-assets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/financed-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      toast({ title: "Asset deleted" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const openCreate = () => {
    setEditingAsset(null);
    form.reset({
      name: "", category: "vehicle", purchasePrice: 0, purchaseDate: "",
      currentValue: 0, depreciationMethod: "none", usefulLifeMonths: null,
      salvageValue: null, loanOriginalAmount: null, loanBalance: null,
      loanApr: null, monthlyPayment: null, totalPayments: null,
      paymentsMade: null, loanStartDate: "", notes: "",
    });
    setDialogOpen(true);
  };

  const openEdit = (asset: FinancedAsset) => {
    setEditingAsset(asset);
    form.reset({
      name: asset.name,
      category: asset.category,
      purchasePrice: asset.purchasePrice,
      purchaseDate: asset.purchaseDate || "",
      currentValue: asset.currentValue,
      depreciationMethod: asset.depreciationMethod || "none",
      usefulLifeMonths: asset.usefulLifeMonths,
      salvageValue: asset.salvageValue,
      loanOriginalAmount: asset.loanOriginalAmount,
      loanBalance: asset.loanBalance,
      loanApr: asset.loanApr,
      monthlyPayment: asset.monthlyPayment,
      totalPayments: asset.totalPayments,
      paymentsMade: asset.paymentsMade,
      loanStartDate: asset.loanStartDate || "",
      notes: asset.notes || "",
    });
    setDialogOpen(true);
  };

  const onSubmit = (values: FormValues) => {
    const toNull = (v: string | number | null | undefined): string | number | null => {
      if (v === undefined || v === null) return null;
      if (typeof v === "string" && v === "") return null;
      return v;
    };

    const loanOrig = typeof values.loanOriginalAmount === "number" ? values.loanOriginalAmount : null;
    const paymentsMade = typeof values.paymentsMade === "number" ? values.paymentsMade : 0;
    const monthlyPmt = typeof values.monthlyPayment === "number" ? values.monthlyPayment : null;

    let computedBalance = typeof values.loanBalance === "number" ? values.loanBalance : null;
    if (computedBalance === null && loanOrig !== null && loanOrig > 0 && monthlyPmt !== null && monthlyPmt > 0) {
      computedBalance = Math.max(0, loanOrig - (paymentsMade * monthlyPmt));
    }

    const clean = {
      ...values,
      purchaseDate: toNull(values.purchaseDate) as string | null,
      loanStartDate: toNull(values.loanStartDate) as string | null,
      notes: toNull(values.notes) as string | null,
      usefulLifeMonths: values.usefulLifeMonths ?? null,
      salvageValue: values.salvageValue ?? null,
      loanOriginalAmount: loanOrig,
      loanBalance: computedBalance,
      loanApr: values.loanApr ?? null,
      monthlyPayment: monthlyPmt,
      totalPayments: values.totalPayments ?? null,
      paymentsMade: values.paymentsMade ?? null,
    };
    if (editingAsset) {
      updateMutation.mutate({ ...clean, id: editingAsset.id } as any);
    } else {
      createMutation.mutate(clean as any);
    }
  };

  const totals = useMemo(() => {
    if (!assets) return { totalValue: 0, totalLoans: 0, totalEquity: 0 };
    const totalValue = assets.reduce((s, a) => s + (a.currentValue || 0), 0);
    const totalLoans = assets.reduce((s, a) => s + (a.loanBalance || 0), 0);
    return { totalValue, totalLoans, totalEquity: totalValue - totalLoans };
  }, [assets]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="assets-loading">
        <div className="grid grid-cols-1 @sm:grid-cols-3 gap-3">
          {[...Array(3)].map((_, i) => <SummaryMetricCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4" data-testid="assets-content">
      <div className="grid grid-cols-1 @sm:grid-cols-3 gap-3">
        <SummaryMetricCard label="Total Asset Value" value={fmt(totals.totalValue)} icon={<DollarSign className="h-3.5 w-3.5" />} testId="metric-asset-value" />
        <SummaryMetricCard label="Total Loan Balance" value={fmt(totals.totalLoans)} icon={<TrendingDown className="h-3.5 w-3.5" />} testId="metric-loan-balance" />
        <SummaryMetricCard
          label="Total Equity"
          value={fmt(totals.totalEquity)}
          icon={<PiggyBank className="h-3.5 w-3.5" />}
          delta={totals.totalValue > 0 ? (totals.totalEquity / totals.totalValue) * 100 : 0}
          deltaLabel="of value"
          testId="metric-total-equity"
        />
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">
          {assets && assets.length > 0 ? `${assets.length} Financed Asset${assets.length !== 1 ? "s" : ""}` : "No financed assets yet"}
        </h3>
        <Button size="sm" onClick={openCreate} data-testid="button-add-asset">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Asset
        </Button>
      </div>

      {assets && assets.length === 0 && (
        <div className="flex flex-col items-center justify-center h-40 gap-2" data-testid="assets-empty">
          <Package className="h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">Track vehicles, real estate, and equipment with their loan details.</p>
        </div>
      )}

      <div className="grid grid-cols-1 @lg:grid-cols-2 gap-3">
        {assets?.map(asset => (
          <AssetCard
            key={asset.id}
            asset={asset}
            onEdit={() => openEdit(asset)}
            onDelete={() => {
              if (confirm(`Delete "${asset.name}"?`)) deleteMutation.mutate(asset.id);
            }}
          />
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingAsset(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingAsset ? "Edit Asset" : "Add Financed Asset"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Name</FormLabel>
                    <FormControl><Input placeholder="e.g. 2023 Tesla Model 3" {...field} data-testid="input-asset-name" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="category" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-category"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="vehicle">Vehicle</SelectItem>
                        <SelectItem value="real_estate">Real Estate</SelectItem>
                        <SelectItem value="equipment">Equipment</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purchase Date</FormLabel>
                    <FormControl><Input type="date" {...field} data-testid="input-purchase-date" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="purchasePrice" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purchase Price</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} data-testid="input-purchase-price" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="currentValue" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Value</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} data-testid="input-current-value" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="border-t border-border/50 pt-3">
                <h4 className="text-sm font-medium mb-2">Depreciation</h4>
                <div className="grid grid-cols-3 gap-3">
                  <FormField control={form.control} name="depreciationMethod" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Method</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger data-testid="select-depreciation"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="straight_line">Straight Line</SelectItem>
                          <SelectItem value="declining_balance">Declining Balance</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="usefulLifeMonths" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Life (months)</FormLabel>
                      <FormControl><Input type="number" placeholder="60" {...field} value={field.value ?? ""} data-testid="input-useful-life" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="salvageValue" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Salvage Value</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="0" {...field} value={field.value ?? ""} data-testid="input-salvage-value" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              <div className="border-t border-border/50 pt-3">
                <h4 className="text-sm font-medium mb-2">Loan Details</h4>
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={form.control} name="loanOriginalAmount" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Original Amount</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="0" {...field} value={field.value ?? ""} data-testid="input-loan-original" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="loanBalance" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Current Balance</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="0" {...field} value={field.value ?? ""} data-testid="input-loan-balance" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="loanApr" render={({ field }) => (
                    <FormItem>
                      <FormLabel>APR (%)</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="0" {...field} value={field.value ?? ""} data-testid="input-loan-apr" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="monthlyPayment" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Monthly Payment</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="0" {...field} value={field.value ?? ""} data-testid="input-monthly-payment" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="totalPayments" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Payments</FormLabel>
                      <FormControl><Input type="number" placeholder="60" {...field} value={field.value ?? ""} data-testid="input-total-payments" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="paymentsMade" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payments Made</FormLabel>
                      <FormControl><Input type="number" placeholder="0" {...field} value={field.value ?? ""} data-testid="input-payments-made" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="loanStartDate" render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel>Loan Start Date</FormLabel>
                      <FormControl><Input type="date" {...field} data-testid="input-loan-start-date" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea rows={2} placeholder="Optional notes..." {...field} data-testid="input-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <Button
                type="submit"
                className="w-full"
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-submit-asset"
              >
                {(createMutation.isPending || updateMutation.isPending) ? "Saving..." : editingAsset ? "Update Asset" : "Add Asset"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
