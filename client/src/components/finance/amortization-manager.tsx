import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, Trash2, Power, PowerOff, Pencil } from "lucide-react";

interface AmortizationRow {
  id: number;
  transactionId: string;
  originalAmount: number;
  spreadMonths: number;
  startMonth: string;
  category: string;
  isActive: boolean;
  notes: string | null;
  txnMonth: string | null;
  txnName: string | null;
  orphaned: boolean;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

export function AmortizationManager() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSpread, setEditSpread] = useState<string>("");
  const [editStart, setEditStart] = useState<string>("");

  const { data, isLoading } = useQuery<{ amortizations: AmortizationRow[] }>({
    queryKey: ["/api/finance/amortizations"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      return apiRequest("PATCH", `/api/finance/amortizations/${id}`, patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/amortizations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-comparison"] });
      setEditingId(null);
      toast({ title: "Amortization updated" });
    },
    onError: (e: any) => toast({ title: "Update failed", description: e?.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/finance/amortizations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/amortizations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/forecast"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/budget-comparison"] });
      toast({ title: "Amortization removed" });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: e?.message, variant: "destructive" }),
  });

  const rows = data?.amortizations || [];

  if (isLoading) {
    return <div className="text-xs text-muted-foreground p-3">Loading amortizations…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border/50 bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-1">Transaction Amortizations</h3>
        <p className="text-xs text-muted-foreground">
          No amortizations yet. When you have a large one-time expense (medical bill, annual premium), amortize it from the Transactions tab so it doesn&apos;t skew your monthly comparisons.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card" data-testid="amortization-manager">
      <div className="px-4 py-3 border-b border-border/50">
        <h3 className="text-sm font-semibold text-foreground">Transaction Amortizations</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Spread one-time costs across months so budget vs. actual comparisons stay clean.
        </p>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map(r => {
          const monthly = r.originalAmount / r.spreadMonths;
          const isEditing = editingId === r.id;
          return (
            <div key={r.id} className="px-4 py-3 flex flex-col gap-2" data-testid={`amortization-row-${r.id}`}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate" data-testid={`text-amortization-name-${r.id}`}>
                      {r.txnName || `Transaction #${r.transactionId}`}
                    </span>
                    {r.orphaned && (
                      <span className="inline-flex items-center gap-1 text-xs text-warning" title="Source transaction no longer exists">
                        <AlertCircle className="h-3 w-3" /> Orphaned
                      </span>
                    )}
                    {!r.isActive && <span className="text-xs text-muted-foreground uppercase">Inactive</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {formatCurrency(r.originalAmount)} → {formatCurrency(monthly)}/mo × {r.spreadMonths}mo from {r.startMonth} · {r.category}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingId(isEditing ? null : r.id);
                      setEditSpread(String(r.spreadMonths));
                      setEditStart(r.startMonth);
                    }}
                    data-testid={`button-edit-amortization-${r.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateMutation.mutate({ id: r.id, patch: { isActive: !r.isActive } })}
                    disabled={updateMutation.isPending}
                    data-testid={`button-toggle-amortization-${r.id}`}
                    title={r.isActive ? "Deactivate" : "Activate"}
                  >
                    {r.isActive ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (confirm("Remove this amortization? Original transaction is unaffected.")) {
                        deleteMutation.mutate(r.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid={`button-delete-amortization-${r.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {isEditing && (
                <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-border/30">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs" htmlFor={`spread-${r.id}`}>Spread (months)</Label>
                    <Input
                      id={`spread-${r.id}`}
                      type="number"
                      min={1}
                      max={120}
                      value={editSpread}
                      onChange={e => setEditSpread(e.target.value)}
                      className="h-7 w-24 text-xs"
                      data-testid={`input-edit-spread-${r.id}`}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs" htmlFor={`start-${r.id}`}>Start (YYYY-MM)</Label>
                    <Input
                      id={`start-${r.id}`}
                      value={editStart}
                      onChange={e => setEditStart(e.target.value)}
                      className="h-7 w-28 text-xs"
                      data-testid={`input-edit-start-${r.id}`}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const sm = parseInt(editSpread);
                      if (isNaN(sm) || sm < 1 || sm > 120) {
                        toast({ title: "Spread must be 1-120 months", variant: "destructive" });
                        return;
                      }
                      if (!/^\d{4}-\d{2}$/.test(editStart)) {
                        toast({ title: "Start month must be YYYY-MM", variant: "destructive" });
                        return;
                      }
                      updateMutation.mutate({ id: r.id, patch: { spreadMonths: sm, startMonth: editStart } });
                    }}
                    disabled={updateMutation.isPending}
                    data-testid={`button-save-amortization-${r.id}`}
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
