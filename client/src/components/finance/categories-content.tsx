import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Pencil, Trash2, ArrowRight, Tag } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ExpenseCategory } from "./category-labels";

interface MerchantOverride {
  id: number;
  merchantName: string;
  categoryId: number;
}

export function CategoriesContent() {
  const { toast } = useToast();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");

  const [newMerchant, setNewMerchant] = useState("");
  const [newMerchantCategoryId, setNewMerchantCategoryId] = useState<number | "">("");

  const categoriesQuery = useQuery<{ categories: ExpenseCategory[] }>({ queryKey: ["/api/finance/categories"] });
  const overridesQuery = useQuery<{ overrides: MerchantOverride[] }>({ queryKey: ["/api/finance/merchant-overrides"] });

  const categories = categoriesQuery.data?.categories || [];
  const overrides = overridesQuery.data?.overrides || [];

  const createCategoryMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/finance/categories", { name: newName, color: newColor }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/categories"] });
      setNewName("");
      setNewColor("#6366f1");
      toast({ title: "Category created" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateCategoryMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PUT", `/api/finance/categories/${id}`, { name: editName, color: editColor }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/categories"] });
      setEditingId(null);
      toast({ title: "Category updated" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/merchant-overrides"] });
      toast({ title: "Category deleted" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const upsertOverrideMutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/finance/merchant-overrides", { merchantName: newMerchant, categoryId: newMerchantCategoryId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/merchant-overrides"] });
      setNewMerchant("");
      setNewMerchantCategoryId("");
      toast({ title: "Merchant mapping saved" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteOverrideMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/merchant-overrides/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/merchant-overrides"] });
      toast({ title: "Mapping removed" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const categoryMap = new Map(categories.map(c => [c.id, c]));

  const isLoading = categoriesQuery.isLoading || overridesQuery.isLoading;

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="categories-loading">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="rounded-lg border border-border/50 bg-card p-3 animate-pulse space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-3 w-48 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6">
      <div data-testid="categories-list-section">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Expense Categories</h4>
        <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
          {categories.map(cat => (
            <div key={cat.id} className="flex items-center justify-between px-3 py-2.5 border-b border-border/30 last:border-b-0" data-testid={`category-row-${cat.id}`}>
              {editingId === cat.id ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    type="color"
                    value={editColor}
                    onChange={e => setEditColor(e.target.value)}
                    className="h-6 w-6 rounded cursor-pointer border-0 p-0"
                    data-testid={`input-edit-color-${cat.id}`}
                  />
                  <Input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="h-7 text-xs flex-1 max-w-[200px]"
                    data-testid={`input-edit-name-${cat.id}`}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2"
                    onClick={() => updateCategoryMutation.mutate(cat.id)}
                    disabled={updateCategoryMutation.isPending || !editName.trim()}
                    data-testid={`button-save-edit-${cat.id}`}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2"
                    onClick={() => setEditingId(null)}
                    data-testid={`button-cancel-edit-${cat.id}`}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color || "#a1a1aa" }}
                    />
                    <span className="text-xs text-foreground font-medium">{cat.name}</span>
                    {cat.isDefault && (
                      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Default</span>
                    )}
                    {cat.plaidCategory && (
                      <span className="text-xs text-muted-foreground">{cat.plaidCategory}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => {
                        setEditingId(cat.id);
                        setEditName(cat.name);
                        setEditColor(cat.color || "#a1a1aa");
                      }}
                      data-testid={`button-edit-category-${cat.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    {!cat.isDefault && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                        onClick={() => deleteCategoryMutation.mutate(cat.id)}
                        disabled={deleteCategoryMutation.isPending}
                        data-testid={`button-delete-category-${cat.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2" data-testid="add-category-form">
          <input
            type="color"
            value={newColor}
            onChange={e => setNewColor(e.target.value)}
            className="h-7 w-7 rounded cursor-pointer border-0 p-0"
            data-testid="input-new-category-color"
          />
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New category name"
            className="h-7 text-xs max-w-[200px]"
            data-testid="input-new-category-name"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => createCategoryMutation.mutate()}
            disabled={createCategoryMutation.isPending || !newName.trim()}
            data-testid="button-add-category"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        </div>
      </div>

      <div data-testid="merchant-overrides-section">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Merchant Mappings</h4>
        <p className="text-xs text-muted-foreground mb-3">
          Override the default category for a specific merchant. Applies to all transactions from that merchant.
        </p>
        <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
          {overrides.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <Tag className="h-5 w-5 mx-auto mb-2 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">No merchant mappings yet</p>
            </div>
          ) : (
            overrides.map(ov => {
              const cat = categoryMap.get(ov.categoryId);
              return (
                <div key={ov.id} className="flex items-center justify-between px-3 py-2 border-b border-border/30 last:border-b-0" data-testid={`override-row-${ov.id}`}>
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    <span className="text-foreground font-medium truncate">{ov.merchantName}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <div className="flex items-center gap-1 shrink-0">
                      {cat && <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: cat.color || "#a1a1aa" }} />}
                      <span className="text-muted-foreground">{cat?.name || "Unknown"}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-destructive hover:text-destructive shrink-0"
                    onClick={() => deleteOverrideMutation.mutate(ov.id)}
                    disabled={deleteOverrideMutation.isPending}
                    data-testid={`button-delete-override-${ov.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })
          )}
        </div>

        <div className="mt-3 flex items-center gap-2 flex-wrap" data-testid="add-override-form">
          <Input
            value={newMerchant}
            onChange={e => setNewMerchant(e.target.value)}
            placeholder="Merchant name"
            className="h-7 text-xs max-w-[180px]"
            data-testid="input-new-merchant-name"
          />
          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
          <select
            value={newMerchantCategoryId}
            onChange={e => setNewMerchantCategoryId(e.target.value ? parseInt(e.target.value) : "")}
            className="h-7 text-xs rounded-md border border-input bg-background px-2 max-w-[180px]"
            data-testid="select-merchant-category"
          >
            <option value="">Select category</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => upsertOverrideMutation.mutate()}
            disabled={upsertOverrideMutation.isPending || !newMerchant.trim() || newMerchantCategoryId === ""}
            data-testid="button-add-override"
          >
            <Plus className="h-3 w-3 mr-1" />
            Map
          </Button>
        </div>
      </div>
    </div>
  );
}
