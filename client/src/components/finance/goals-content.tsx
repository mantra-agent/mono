import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { Plus, Pencil, Trash2, Target, Sparkles } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fromCivilDate } from "@shared/civil-date";

interface FinancialGoal {
  id: number;
  name: string;
  targetAmount: number;
  currentAmount: number;
  category: string;
  linkedAccountIds: string[] | null;
  notes: string | null;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
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

const GOAL_CATEGORIES = ["Emergency Fund", "Financial Freedom", "Savings", "Debt Payoff", "Custom"];

const SUGGESTED_GOALS = [
  { name: "Emergency Fund", category: "Emergency Fund", targetAmount: 10000 },
  { name: "6 Months Expenses", category: "Emergency Fund", targetAmount: 25000 },
  { name: "Debt Free", category: "Debt Payoff", targetAmount: 0 },
  { name: "Retirement Savings", category: "Financial Freedom", targetAmount: 100000 },
];

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  targetAmount: z.coerce.number().min(0, "Target must be non-negative"),
  currentAmount: z.coerce.number().min(0, "Current amount must be non-negative"),
  category: z.string().min(1, "Category is required"),
  targetDate: z.string().optional(),
  notes: z.string().optional(),
  linkedAccountIds: z.array(z.string()).optional(),
});

type FormValues = z.infer<typeof formSchema>;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

export function GoalsContent() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FinancialGoal | null>(null);

  const goalsQuery = useQuery<{ goals: FinancialGoal[] }>({ queryKey: ["/api/finance/goals"] });
  const accountsQuery = useQuery<PlaidAccountItem[]>({ queryKey: ["/api/plaid/accounts"] });
  const accountsLoaded = !accountsQuery.isLoading && !!accountsQuery.data;

  const goals = goalsQuery.data?.goals || [];
  const allAccounts = useMemo(() => {
    if (!accountsQuery.data) return [];
    const items = Array.isArray(accountsQuery.data) ? accountsQuery.data : [];
    return items.flatMap(item =>
      (item.accounts || []).map(a => ({ ...a, institutionName: item.institutionName }))
    );
  }, [accountsQuery.data]);

  const goalsWithComputed = useMemo(() => {
    return goals.map(g => {
      if (g.linkedAccountIds && g.linkedAccountIds.length > 0 && accountsLoaded) {
        const matchedAccounts = allAccounts.filter(a => g.linkedAccountIds!.includes(a.accountId));
        if (matchedAccounts.length > 0) {
          const linkedTotal = matchedAccounts.reduce((s, a) => s + (a.currentBalance ?? 0), 0);
          return { ...g, computedAmount: linkedTotal > 0 ? linkedTotal : g.currentAmount };
        }
        return { ...g, computedAmount: g.currentAmount };
      }
      if (g.linkedAccountIds && g.linkedAccountIds.length > 0 && !accountsLoaded) {
        return { ...g, computedAmount: -1 };
      }
      return { ...g, computedAmount: g.currentAmount };
    });
  }, [goals, allAccounts, accountsLoaded]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", targetAmount: 0, currentAmount: 0, category: "", targetDate: "", notes: "", linkedAccountIds: [] },
  });

  const [selectedLinkedAccounts, setSelectedLinkedAccounts] = useState<Set<string>>(new Set());

  const depositoryAccountIds = useMemo(() => {
    return allAccounts.filter(a => a.type === "depository").map(a => a.accountId);
  }, [allAccounts]);

  const openNew = (suggested?: { name: string; category: string; targetAmount: number }) => {
    setEditing(null);
    const cat = suggested?.category || "";
    const shouldAutoLink = (cat === "Emergency Fund" || cat === "Savings") && depositoryAccountIds.length > 0;
    const autoLinked = shouldAutoLink ? depositoryAccountIds : [];
    setSelectedLinkedAccounts(new Set(autoLinked));
    form.reset({
      name: suggested?.name || "",
      targetAmount: suggested?.targetAmount || 0,
      currentAmount: 0,
      category: cat,
      targetDate: "",
      notes: "",
      linkedAccountIds: autoLinked,
    });
    setDialogOpen(true);
  };

  const openEdit = (goal: FinancialGoal) => {
    setEditing(goal);
    setSelectedLinkedAccounts(new Set(goal.linkedAccountIds || []));
    form.reset({
      name: goal.name,
      targetAmount: goal.targetAmount,
      currentAmount: goal.currentAmount,
      category: goal.category,
      targetDate: goal.targetDate || "",
      notes: goal.notes || "",
      linkedAccountIds: goal.linkedAccountIds || [],
    });
    setDialogOpen(true);
  };

  const toggleLinkedAccount = (id: string) => {
    setSelectedLinkedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const arr = Array.from(next);
      form.setValue("linkedAccountIds", arr);
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiRequest("POST", "/api/finance/goals", data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/finance/goals"] }); setDialogOpen(false); },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown> & { id: number }) => apiRequest("PUT", `/api/finance/goals/${data.id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/finance/goals"] }); setDialogOpen(false); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/goals/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/finance/goals"] }); },
  });

  const onSubmit = (values: FormValues) => {
    const payload: Record<string, unknown> = {
      name: values.name,
      targetAmount: values.targetAmount,
      currentAmount: values.currentAmount,
      category: values.category,
      targetDate: values.targetDate || null,
      notes: values.notes || null,
      linkedAccountIds: Array.from(selectedLinkedAccounts),
    };
    if (editing) {
      updateMutation.mutate({ ...payload, id: editing.id });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (goalsQuery.isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="goals-loading">
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-4 animate-pulse space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-2 w-full bg-muted rounded" />
            <div className="h-3 w-20 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (goalsQuery.isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="goals-error">
        <p className="text-sm text-muted-foreground">Unable to load goals.</p>
      </div>
    );
  }

  if (goals.length === 0) {
    return (
      <div className="p-4">
        <div className="flex flex-col items-center justify-center py-16 text-center" data-testid="goals-empty">
          <div className="rounded-full bg-primary/10 p-4 mb-4">
            <Target className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-sm font-medium text-foreground mb-1">Set Your Financial Goals</h3>
          <p className="text-xs text-muted-foreground mb-6 max-w-sm">
            Track progress toward milestones that matter. Link accounts to auto-compute progress.
          </p>
          <div className="grid grid-cols-2 gap-2 mb-4 w-full max-w-sm">
            {SUGGESTED_GOALS.map(sg => (
              <button
                key={sg.name}
                onClick={() => openNew(sg)}
                className="rounded-lg border border-border/50 bg-card p-3 text-left hover:bg-muted/50 transition-colors"
                data-testid={`button-suggest-${sg.name.replace(/\s+/g, "-").toLowerCase()}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <Sparkles className="h-3 w-3 text-primary" />
                  <span className="text-xs font-medium text-foreground">{sg.name}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatCurrency(sg.targetAmount)} target</span>
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => openNew()} data-testid="button-add-custom-goal">
            <Plus className="h-3 w-3 mr-1" /> Custom Goal
          </Button>
        </div>

        <GoalDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          form={form}
          onSubmit={onSubmit}
          editing={editing}
          isPending={isPending}
          allAccounts={allAccounts}
          selectedLinkedAccounts={selectedLinkedAccounts}
          toggleLinkedAccount={toggleLinkedAccount}
          depositoryAccountIds={depositoryAccountIds}
          setSelectedLinkedAccounts={setSelectedLinkedAccounts}
        />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Your Goals</h3>
        <button onClick={() => openNew()} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="button-add-goal">
          <Plus className="h-3 w-3" /> Add Goal
        </button>
      </div>

      <div className="space-y-3">
        {goalsWithComputed.map(goal => {
          const isLoading = goal.computedAmount === -1;
          const displayAmount = isLoading ? 0 : goal.computedAmount;
          const progress = goal.targetAmount > 0 ? Math.min((displayAmount / goal.targetAmount) * 100, 100) : 0;
          const linkedNames = goal.linkedAccountIds?.map(id => allAccounts.find(a => a.accountId === id)?.name).filter(Boolean) || [];

          return (
            <div key={goal.id} className="rounded-lg border border-border/50 bg-card p-4" data-testid={`goal-card-${goal.id}`}>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <Target className="h-3.5 w-3.5 text-primary" />
                    <span className="text-sm font-medium text-foreground">{goal.name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{goal.category}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => openEdit(goal)} className="text-muted-foreground hover:text-foreground" data-testid={`button-edit-goal-${goal.id}`}>
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button onClick={() => deleteMutation.mutate(goal.id)} className="text-muted-foreground hover:text-destructive" data-testid={`button-delete-goal-${goal.id}`}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>

              <div className="mb-1.5">
                {isLoading ? (
                  <div className="h-2 w-full bg-muted rounded animate-pulse" />
                ) : (
                  <Progress value={progress} className="h-2" data-testid={`progress-goal-${goal.id}`} />
                )}
              </div>

              <div className="flex items-center justify-between text-xs">
                {isLoading ? (
                  <span className="text-muted-foreground italic" data-testid={`text-goal-loading-${goal.id}`}>Loading account balances...</span>
                ) : (
                  <span className="text-foreground font-medium tabular-nums" data-testid={`text-goal-amount-${goal.id}`}>{formatCurrency(displayAmount)}</span>
                )}
                <span className="text-muted-foreground tabular-nums">of {formatCurrency(goal.targetAmount)}</span>
              </div>

              {!isLoading && progress === 0 && (!goal.linkedAccountIds || goal.linkedAccountIds.length === 0) && depositoryAccountIds.length > 0 && (
                <button
                  onClick={() => openEdit(goal)}
                  className="mt-2 w-full rounded border border-dashed border-primary/30 bg-primary/5 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 transition-colors text-left"
                  data-testid={`button-link-accounts-${goal.id}`}
                >
                  Link your bank accounts to auto-track progress
                </button>
              )}

              <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground flex-wrap">
                <span>{isLoading ? "..." : `${progress.toFixed(0)}%`} complete</span>
                {goal.targetDate && (
                  <><span className="text-border">·</span><span>Target: {fromCivilDate(goal.targetDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</span></>
                )}
                {linkedNames.length > 0 && (
                  <><span className="text-border">·</span><span>Linked: {linkedNames.join(", ")}</span></>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <GoalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        form={form}
        onSubmit={onSubmit}
        editing={editing}
        isPending={isPending}
        allAccounts={allAccounts}
        selectedLinkedAccounts={selectedLinkedAccounts}
        toggleLinkedAccount={toggleLinkedAccount}
        depositoryAccountIds={depositoryAccountIds}
        setSelectedLinkedAccounts={setSelectedLinkedAccounts}
      />
    </div>
  );
}

function GoalDialog({
  open, onOpenChange, form, onSubmit, editing, isPending, allAccounts, selectedLinkedAccounts, toggleLinkedAccount, depositoryAccountIds, setSelectedLinkedAccounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ReturnType<typeof useForm<FormValues>>;
  onSubmit: (values: FormValues) => void;
  editing: FinancialGoal | null;
  isPending: boolean;
  allAccounts: Array<{ accountId: string; name: string; institutionName: string }>;
  selectedLinkedAccounts: Set<string>;
  toggleLinkedAccount: (id: string) => void;
  depositoryAccountIds: string[];
  setSelectedLinkedAccounts: (s: Set<string>) => void;
}) {
  const watchedCategory = form.watch("category");
  const prevCategoryRef = useRef(watchedCategory);

  useEffect(() => {
    if (editing) return;
    if (watchedCategory === prevCategoryRef.current) return;
    prevCategoryRef.current = watchedCategory;
    if ((watchedCategory === "Emergency Fund" || watchedCategory === "Savings") && depositoryAccountIds.length > 0) {
      setSelectedLinkedAccounts(new Set(depositoryAccountIds));
      form.setValue("linkedAccountIds", depositoryAccountIds);
    }
  }, [watchedCategory, editing, depositoryAccountIds, setSelectedLinkedAccounts, form]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{editing ? "Edit Goal" : "Add Financial Goal"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Goal Name</FormLabel>
                <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-goal-name" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="category" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Category</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger className="h-8 text-xs" data-testid="select-goal-category"><SelectValue placeholder="Select category" /></SelectTrigger></FormControl>
                  <SelectContent>{GOAL_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="targetAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Target ($)</FormLabel>
                  <FormControl><Input type="number" step="0.01" {...field} className="h-8 text-xs" data-testid="input-goal-target" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="currentAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Current ($)</FormLabel>
                  <FormControl><Input type="number" step="0.01" {...field} className="h-8 text-xs" data-testid="input-goal-current" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="targetDate" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Target Date (optional)</FormLabel>
                <FormControl><Input type="date" {...field} className="h-8 text-xs" data-testid="input-goal-date" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {allAccounts.length > 0 && (
              <div>
                <span className="text-xs font-medium">Link Accounts (auto-compute progress)</span>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {allAccounts.map(a => (
                    <button
                      key={a.accountId}
                      type="button"
                      onClick={() => toggleLinkedAccount(a.accountId)}
                      className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                        selectedLinkedAccounts.has(a.accountId) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50"
                      }`}
                      data-testid={`button-link-account-${a.accountId}`}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Notes (optional)</FormLabel>
                <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-goal-notes" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} data-testid="button-cancel-goal">Cancel</Button>
              <Button type="submit" size="sm" disabled={isPending} data-testid="button-save-goal">
                {isPending ? "Saving..." : editing ? "Update" : "Add"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
