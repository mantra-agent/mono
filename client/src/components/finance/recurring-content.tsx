import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useCallback } from "react";
import { Plus, Pencil, Trash2, RefreshCw, AlertTriangle } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";

interface RecurringExpense {
  id: number;
  name: string;
  amount: number;
  frequency: string;
  category: string;
  nextDueDate: string | null;
  lastReviewedAt: string | null;
  source: string;
  transactionPattern: string | null;
  notes: string | null;
  isActive: boolean;
}

const FREQUENCIES = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"] as const;
const CATEGORIES = ["Subscription", "Insurance", "Utilities", "Rent", "Loan Payment", "Membership", "Other"];

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  amount: z.coerce.number().min(0.01, "Amount must be positive"),
  frequency: z.string().min(1, "Frequency is required"),
  category: z.string().min(1, "Category is required"),
  nextDueDate: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().default(true),
});

type FormValues = z.infer<typeof formSchema>;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function annualize(amount: number, frequency: string): number {
  const multipliers: Record<string, number> = {
    weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, semiannual: 2, annual: 1,
  };
  return amount * (multipliers[frequency] || 12);
}

function needsReview(lastReviewed: string | null): boolean {
  if (!lastReviewed) return true;
  const d = new Date(lastReviewed);
  const daysSince = (Date.now() - d.getTime()) / 86400000;
  return daysSince > 90;
}

function humanFrequency(f: string): string {
  const labels: Record<string, string> = {
    weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly", quarterly: "Quarterly", semiannual: "Semiannual", annual: "Annual",
  };
  return labels[f] || f;
}

export function RecurringContent() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringExpense | null>(null);
  const [groupByCategory, setGroupByCategory] = useState(false);

  const query = useQuery<{ expenses: RecurringExpense[] }>({ queryKey: ["/api/finance/recurring"] });
  const expenses = query.data?.expenses || [];

  const sorted = useMemo(() =>
    [...expenses].sort((a, b) => annualize(b.amount, b.frequency) - annualize(a.amount, a.frequency)),
    [expenses]
  );

  const activeExpenses = useMemo(() => sorted.filter(e => e.isActive), [sorted]);

  const totalAnnual = useMemo(() =>
    activeExpenses.reduce((s, e) => s + annualize(e.amount, e.frequency), 0),
    [activeExpenses]
  );

  const reviewNeededCount = useMemo(() =>
    activeExpenses.filter(e => needsReview(e.lastReviewedAt)).length,
    [activeExpenses]
  );

  const detectRecurringMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/plaid/detect-recurring"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/recurring"] });
    },
  });

  const grouped = useMemo(() => {
    if (!groupByCategory) return null;
    const map: Record<string, RecurringExpense[]> = {};
    for (const e of sorted) {
      (map[e.category] ??= []).push(e);
    }
    return Object.entries(map).sort(([, a], [, b]) => {
      const sumA = a.filter(x => x.isActive).reduce((s, e) => s + annualize(e.amount, e.frequency), 0);
      const sumB = b.filter(x => x.isActive).reduce((s, e) => s + annualize(e.amount, e.frequency), 0);
      return sumB - sumA;
    });
  }, [sorted, groupByCategory]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", amount: 0, frequency: "monthly", category: "", nextDueDate: "", notes: "", isActive: true },
  });

  const openNew = () => {
    setEditing(null);
    form.reset({ name: "", amount: 0, frequency: "monthly", category: "", nextDueDate: "", notes: "", isActive: true });
    setDialogOpen(true);
  };

  const openEdit = (item: RecurringExpense) => {
    setEditing(item);
    form.reset({
      name: item.name,
      amount: item.amount,
      frequency: item.frequency,
      category: item.category,
      nextDueDate: item.nextDueDate || "",
      notes: item.notes || "",
      isActive: item.isActive,
    });
    setDialogOpen(true);
  };

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiRequest("POST", "/api/finance/recurring", data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/finance/recurring"] }); setDialogOpen(false); },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown> & { id: number }) => apiRequest("PUT", `/api/finance/recurring/${data.id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/finance/recurring"] }); setDialogOpen(false); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/recurring/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/finance/recurring"] }); },
  });

  const markReviewed = useCallback((item: RecurringExpense) => {
    updateMutation.mutate({ id: item.id, lastReviewedAt: new Date().toISOString() });
  }, [updateMutation]);

  const onSubmit = (values: FormValues) => {
    const payload: Record<string, unknown> = {
      name: values.name,
      amount: values.amount,
      frequency: values.frequency,
      category: values.category,
      nextDueDate: values.nextDueDate || null,
      notes: values.notes || null,
      isActive: values.isActive,
      source: "manual",
    };
    if (editing) {
      updateMutation.mutate({ ...payload, id: editing.id });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (query.isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="recurring-loading">
        <div className="grid grid-cols-2 gap-3"><SummaryMetricCardSkeleton /><SummaryMetricCardSkeleton /></div>
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-3 animate-pulse space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-3 w-48 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="recurring-error">
        <p className="text-sm text-muted-foreground">Unable to load recurring expenses.</p>
      </div>
    );
  }

  const renderExpenseRow = (e: RecurringExpense) => {
    const annual = annualize(e.amount, e.frequency);
    const review = e.isActive && needsReview(e.lastReviewedAt);
    return (
      <div key={e.id} className={`flex items-center justify-between px-3 py-2.5 text-xs ${!e.isActive ? "opacity-50" : ""}`} data-testid={`recurring-row-${e.id}`}>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground truncate">{e.name}</span>
            {!e.isActive && (
              <Badge variant="outline" className="text-xs px-1 py-0 h-4 text-muted-foreground">Inactive</Badge>
            )}
            {review && (
              <Badge variant="outline" className="text-xs px-1 py-0 h-4 text-warning-foreground border-warning/30">
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />Review
              </Badge>
            )}
            {e.source !== "manual" && (
              <Badge variant="secondary" className="text-xs px-1 py-0 h-4">Auto</Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground flex-wrap">
            <span>{e.category}</span>
            <span className="text-border">·</span>
            <span>{humanFrequency(e.frequency)}</span>
            {e.nextDueDate && (
              <><span className="text-border">·</span><span>Due {e.nextDueDate}</span></>
            )}
            <span className="text-border">·</span>
            <span>
              {e.lastReviewedAt
                ? `Reviewed ${new Date(e.lastReviewedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                : "Never reviewed"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="flex flex-col items-end gap-0.5">
            <span className="font-medium tabular-nums text-foreground">{formatCurrency(e.amount)}</span>
            <span className="text-muted-foreground tabular-nums">{formatCurrency(annual)}/yr</span>
          </div>
          {review && (
            <button
              onClick={() => markReviewed(e)}
              className="text-muted-foreground hover:text-foreground"
              title="Mark as reviewed"
              data-testid={`button-mark-reviewed-${e.id}`}
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
          <button onClick={() => openEdit(e)} className="text-muted-foreground hover:text-foreground" data-testid={`button-edit-recurring-${e.id}`}>
            <Pencil className="h-3 w-3" />
          </button>
          <button onClick={() => deleteMutation.mutate(e.id)} className="text-muted-foreground hover:text-destructive" data-testid={`button-delete-recurring-${e.id}`}>
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
        <SummaryMetricCard
          label="Annual Recurring Cost"
          value={formatCurrency(totalAnnual)}
          secondaryValue={`${formatCurrency(totalAnnual / 12)}/mo`}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          testId="metric-annual-recurring"
        />
        <SummaryMetricCard
          label="Review Needed"
          value={reviewNeededCount.toString()}
          secondaryValue={reviewNeededCount > 0 ? "Items not reviewed in 90+ days" : "All up to date"}
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          testId="metric-review-needed"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupByCategory(false)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${!groupByCategory ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
            data-testid="button-view-list"
          >
            List
          </button>
          <button
            onClick={() => setGroupByCategory(true)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${groupByCategory ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
            data-testid="button-view-grouped"
          >
            By Category
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => detectRecurringMutation.mutate()}
            disabled={detectRecurringMutation.isPending}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            data-testid="button-detect-recurring"
          >
            <RefreshCw className={`h-3 w-3 ${detectRecurringMutation.isPending ? "animate-spin" : ""}`} />
            {detectRecurringMutation.isPending ? "Detecting..." : "Detect"}
          </button>
          <button onClick={openNew} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="button-add-recurring">
            <Plus className="h-3 w-3" /> Add Expense
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-border/50 bg-card p-6 text-center" data-testid="recurring-empty">
          <p className="text-xs text-muted-foreground mb-2">No recurring expenses tracked yet.</p>
          <Button size="sm" variant="outline" onClick={openNew} data-testid="button-add-first-recurring">
            <Plus className="h-3 w-3 mr-1" /> Add Your First Expense
          </Button>
        </div>
      ) : groupByCategory && grouped ? (
        <div className="space-y-3">
          {grouped.map(([category, items]) => {
            const catTotal = items.filter(x => x.isActive).reduce((s, e) => s + annualize(e.amount, e.frequency), 0);
            return (
              <div key={category}>
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-xs font-medium text-muted-foreground">{category}</h4>
                  <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(catTotal)}/yr</span>
                </div>
                <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
                  {items.map(renderExpenseRow)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
          {sorted.map(renderExpenseRow)}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">{editing ? "Edit Recurring Expense" : "Add Recurring Expense"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Name</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-recurring-name" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Amount ($)</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} className="h-8 text-xs" data-testid="input-recurring-amount" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="frequency" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Frequency</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger className="h-8 text-xs" data-testid="select-recurring-frequency"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>{FREQUENCIES.map(f => <SelectItem key={f} value={f}>{humanFrequency(f)}</SelectItem>)}</SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Category</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger className="h-8 text-xs" data-testid="select-recurring-category"><SelectValue placeholder="Select category" /></SelectTrigger></FormControl>
                    <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="nextDueDate" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Next Due Date</FormLabel>
                  <FormControl><Input type="date" {...field} className="h-8 text-xs" data-testid="input-recurring-due-date" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Notes (optional)</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-recurring-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(false)} data-testid="button-cancel-recurring">Cancel</Button>
                <Button type="submit" size="sm" disabled={isPending} data-testid="button-save-recurring">
                  {isPending ? "Saving..." : editing ? "Update" : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
