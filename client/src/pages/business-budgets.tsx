import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, Folder, Loader2, Pencil, Plus, ReceiptText, Trash2 } from "lucide-react";
import type { BusinessBudget, BusinessBudgetMutation, BudgetCategory, BudgetDepartment, BudgetLineItem } from "@shared/models/business-budgets";
import { budgetMonthlyTotal, categoryMonthlyTotal, departmentMonthlyTotal } from "@shared/models/business-budgets";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function parseMoney(value: string): number | null {
  const amount = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

interface NameDialogState {
  title: string;
  initialValue: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
}

function NameDialog({ state, onClose }: { state: NameDialogState | null; onClose: () => void }) {
  const [value, setValue] = useState(state?.initialValue ?? "");
  if (!state) return null;
  const submit = () => {
    const name = value.trim();
    if (!name) return;
    state.onSubmit(name);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{state.title}</DialogTitle></DialogHeader>
        <Input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submit()} />
        <DialogFooter><Button onClick={submit} disabled={!value.trim()}>{state.submitLabel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MutationMenu({ rename, remove }: { rename: () => void; remove: () => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={rename}><Pencil className="mr-2 h-3.5 w-3.5" />Rename</DropdownMenuItem>
      <DropdownMenuItem onSelect={remove} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-3.5 w-3.5" />Delete</DropdownMenuItem>
    </>
  );
}

function BudgetTreeRow({ continues, children }: { continues: boolean; children: ReactNode }) {
  return (
    <HierarchyTreeRow continues={continues} connectorAnchor="first-row-center" indent="icon">
      {children}
    </HierarchyTreeRow>
  );
}

function MonthlyAmountInput({ item, onSet }: { item: BudgetLineItem; onSet: (amountCents: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((item.monthlyAmountCents / 100).toFixed(2));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft((item.monthlyAmountCents / 100).toFixed(2));
  }, [item.monthlyAmountCents]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const next = parseMoney(draft);
    if (next === null) {
      setDraft((item.monthlyAmountCents / 100).toFixed(2));
      setEditing(false);
      return;
    }
    if (next !== item.monthlyAmountCents) onSet(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        className="!mr-5 !h-5 !w-16 text-right tabular-nums"
        inputMode="decimal"
        aria-label={`${item.name} monthly budget`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft((item.monthlyAmountCents / 100).toFixed(2));
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="mr-5 tabular-nums text-muted-foreground"
      aria-label={`Edit ${item.name} monthly budget`}
      onClick={() => setEditing(true)}
    >
      {formatMoney(item.monthlyAmountCents)}
    </button>
  );
}

interface BudgetTreeProps {
  budget: BusinessBudget;
  query: string;
  mutate: (mutation: BusinessBudgetMutation) => void;
  openNameDialog: (state: NameDialogState) => void;
}

function LineItemRow({ department, category, item, continues, mutate, openNameDialog }: {
  department: BudgetDepartment;
  category: BudgetCategory;
  item: BudgetLineItem;
  continues: boolean;
  mutate: BudgetTreeProps["mutate"];
  openNameDialog: BudgetTreeProps["openNameDialog"];
}) {
  const identity = { departmentId: department.id, categoryId: category.id, lineItemId: item.id };
  return (
    <BudgetTreeRow continues={continues}>
      <ProfileTreeRow
        label={item.name}
        icon={<ReceiptText className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        valueLayout="compact"
        menuContent={<MutationMenu
          rename={() => openNameDialog({ title: "Rename Line Item", initialValue: item.name, submitLabel: "Save", onSubmit: (name) => mutate({ action: "rename_line_item", ...identity, name }) })}
          remove={() => mutate({ action: "delete_line_item", ...identity })}
        />}
        menuVisibility="hover"
      >
        <MonthlyAmountInput item={item} onSet={(amountCents) => mutate({ action: "set_monthly_amount", ...identity, amountCents })} />
      </ProfileTreeRow>
    </BudgetTreeRow>
  );
}

function CategoryRow({ department, category, continues, mutate, openNameDialog }: {
  department: BudgetDepartment;
  category: BudgetCategory;
  continues: boolean;
  mutate: BudgetTreeProps["mutate"];
  openNameDialog: BudgetTreeProps["openNameDialog"];
}) {
  return (
    <BudgetTreeRow continues={continues}>
      <ProfileTreeRow
        label={<span className="italic text-foreground">{category.name}</span>}
        icon={<Folder className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        valueLayout="compact"
        defaultOpen
        expandedContent={
          <div>
            {category.lineItems.map((item, index) => (
              <LineItemRow key={item.id} department={department} category={category} item={item} continues={index < category.lineItems.length - 1} mutate={mutate} openNameDialog={openNameDialog} />
            ))}
            <BudgetTreeRow continues={false}>
              <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => openNameDialog({
                title: "New Line Item", initialValue: "", submitLabel: "Add Line Item",
                onSubmit: (name) => mutate({ action: "add_line_item", departmentId: department.id, categoryId: category.id, name }),
              })}><Plus className="h-3.5 w-3.5" />New Line Item</button>
            </BudgetTreeRow>
          </div>
        }
        expandedContentClassName="px-0 pb-0 pl-0"
        menuContent={<MutationMenu
          rename={() => openNameDialog({ title: "Rename Category", initialValue: category.name, submitLabel: "Save", onSubmit: (name) => mutate({ action: "rename_category", departmentId: department.id, categoryId: category.id, name }) })}
          remove={() => mutate({ action: "delete_category", departmentId: department.id, categoryId: category.id })}
        />}
        menuVisibility="hover"
      >
        <span className="italic tabular-nums">{formatMoney(categoryMonthlyTotal(category))}</span>
      </ProfileTreeRow>
    </BudgetTreeRow>
  );
}

function DepartmentSection({ department, mutate, openNameDialog }: {
  department: BudgetDepartment;
  mutate: BudgetTreeProps["mutate"];
  openNameDialog: BudgetTreeProps["openNameDialog"];
}) {
  return (
    <div className={HIERARCHY_TREE_STACK_CLASS}>
      <ProfileTreeRow
        label={<span className="italic text-foreground">{department.name}</span>}
        icon={<Building2 className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        valueLayout="compact"
        defaultOpen
        expandedContent={
          <div>
            {department.categories.map((category, index) => (
              <CategoryRow key={category.id} department={department} category={category} continues={index < department.categories.length - 1} mutate={mutate} openNameDialog={openNameDialog} />
            ))}
            <BudgetTreeRow continues={false}>
              <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => openNameDialog({
                title: "New Budget Category", initialValue: "", submitLabel: "Add Category",
                onSubmit: (name) => mutate({ action: "add_category", departmentId: department.id, name }),
              })}><Plus className="h-3.5 w-3.5" />New Category</button>
            </BudgetTreeRow>
          </div>
        }
        expandedContentClassName="px-0 pb-0 pl-0"
        menuContent={<MutationMenu
          rename={() => openNameDialog({ title: "Rename Department", initialValue: department.name, submitLabel: "Save", onSubmit: (name) => mutate({ action: "rename_department", departmentId: department.id, name }) })}
          remove={() => mutate({ action: "delete_department", departmentId: department.id })}
        />}
        menuVisibility="hover"
      >
        <span className="italic tabular-nums">{formatMoney(departmentMonthlyTotal(department))}</span>
      </ProfileTreeRow>
    </div>
  );
}

export default function BusinessBudgetsPage() {
  const { businesses, selectedId, setSelectedId, selected, isLoading: businessesLoading } = useSelectedBusiness();
  const [query, setQuery] = useState("");
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const { toast } = useToast();
  const key = ["/api/business/budgets", selectedId] as const;
  const budgetQuery = useQuery<BusinessBudget>({
    queryKey: key,
    enabled: Boolean(selectedId),
    queryFn: async () => (await apiRequest("GET", `/api/business/budgets?businessId=${encodeURIComponent(selectedId ?? "")}`)).json(),
  });
  const mutation = useMutation({
    mutationFn: async (body: BusinessBudgetMutation) => (await apiRequest("PATCH", `/api/business/budgets?businessId=${encodeURIComponent(selectedId ?? "")}`, body)).json(),
    onSuccess: (budget: BusinessBudget) => queryClient.setQueryData(key, budget),
    onError: (error: unknown) => toast({ title: "Budget change failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" }),
  });
  const departments = useMemo(() => {
    const all = budgetQuery.data?.departments ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return all;
    return all.filter((department) => department.name.toLowerCase().includes(term)
      || department.categories.some((category) => category.name.toLowerCase().includes(term)
        || category.lineItems.some((item) => item.name.toLowerCase().includes(term))));
  }, [budgetQuery.data?.departments, query]);
  const monthlyTotal = budgetMonthlyTotal(budgetQuery.data?.departments ?? []);
  const loading = businessesLoading || budgetQuery.isLoading;

  return (
    <div className="p-4">
      <BusinessPageHeader page="Budgets" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="flex items-center gap-2 pb-2">
        <div className="min-w-0 flex-1"><HierarchySearchInput value={query} onChange={setQuery} placeholder="Search budgets" /></div>
        <span className="shrink-0 text-sm font-medium tabular-nums">{formatMoney(monthlyTotal)} / month</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading budget…</div>
      ) : selected && budgetQuery.data ? (
        <>
          <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setNameDialog({ title: "New Department", initialValue: "", submitLabel: "Add Department", onSubmit: (name) => mutation.mutate({ action: "add_department", name }) })}>
            <Plus className="h-3.5 w-3.5" />New Department
          </button>
          {departments.map((department) => <DepartmentSection key={department.id} department={department} mutate={(body) => mutation.mutate(body)} openNameDialog={setNameDialog} />)}
          {departments.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">{query ? "No matching budget items." : "No departments yet."}</div>}
        </>
      ) : (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No Business selected.</div>
      )}
      <NameDialog key={`${nameDialog?.title ?? "closed"}-${nameDialog?.initialValue ?? ""}`} state={nameDialog} onClose={() => setNameDialog(null)} />
    </div>
  );
}
