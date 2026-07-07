import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, AlertCircle, CheckCircle2, Landmark, AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { usePlaidLink } from "react-plaid-link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FreshnessBadge } from "./freshness-badge";
import { SummaryMetricCard, SummaryMetricCardSkeleton } from "./summary-metric-card";

interface PlaidAccountItem {
  accountId: string;
  itemId: string;
  institutionName: string;
  healthy: boolean;
  healthError: string | null;
  accounts: Array<{
    accountId: string;
    name: string;
    type: string;
    subtype: string | null;
    currentBalance: number | null;
    availableBalance: number | null;
    lastUpdated: string | null;
  }>;
}

interface SyncStatus {
  itemId: string;
  status: string;
  syncPhase: string | null;
  pagesCompleted: number;
  totalAdded: number;
  error: string | null;
  lastSynced: string | null;
  syncStartedAt: string | null;
  lastSyncAttempt: string | null;
  needsInvestigation: boolean;
  hasCursor: boolean;
  initialSyncComplete: boolean;
  oldestTransaction: string | null;
  newestTransaction: string | null;
}

interface ManualAsset {
  id: number;
  name: string;
  category: string;
  currentValue: number;
  notes: string | null;
  lastUpdated: string;
}

interface FinanceSummary {
  totalAssets: number;
  plaidAssetTotal: number;
  manualAssetTotal: number;
  accountCount: number;
  netWorth: number;
  totalLiabilities: number;
  savingsRate: number | null;
  spendingByCategory: Record<string, number>;
  investmentAllocation: Record<string, number>;
  recurringObligations: number;
  manualLiabilityTotal: number;
  plaidLiabilityTotal: number;
}

const assetFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().min(1, "Category is required"),
  currentValue: z.coerce.number().min(0, "Value must be positive"),
  notes: z.string().optional(),
});

type AssetFormValues = z.infer<typeof assetFormSchema>;

const ASSET_CATEGORIES = ["Cash", "Real Estate", "Vehicle", "Investment", "Retirement", "Personal Property", "Other"];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatAccountType(type: string, subtype: string | null): string {
  if (subtype) return subtype.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function getConnectionHealth(item: PlaidAccountItem): { label: string; color: string; icon: typeof CheckCircle2 } {
  if (!item.healthy) {
    return { label: "Broken", color: "text-error-foreground", icon: AlertCircle };
  }
  const newestUpdate = item.accounts.reduce<string | null>((newest, a) => {
    if (!a.lastUpdated) return newest;
    if (!newest) return a.lastUpdated;
    return a.lastUpdated > newest ? a.lastUpdated : newest;
  }, null);
  if (newestUpdate) {
    const hoursSince = (Date.now() - new Date(newestUpdate).getTime()) / 3600000;
    if (hoursSince > 48) {
      return { label: "Stale", color: "text-warning-foreground", icon: AlertTriangle };
    }
  }
  return { label: "Healthy", color: "text-success-foreground", icon: CheckCircle2 };
}

function PlaidConnectButton() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const fetchToken = useCallback(() => {
    setLinkError(null);
    apiRequest("POST", "/api/plaid/create-link-token")
      .then(res => res.json())
      .then(data => setLinkToken(data.linkToken || null))
      .catch((err: Error) => {
        let msg = err.message;
        try {
          const parsed = JSON.parse(msg.replace(/^\d+:\s*/, ""));
          if (parsed?.error) msg = parsed.error;
        } catch { /* keep original */ }
        setLinkError(msg);
      });
  }, []);

  useEffect(() => { fetchToken(); }, [fetchToken]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken) => {
      apiRequest("POST", "/api/plaid/exchange-token", { publicToken })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
          queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
        });
    },
  });

  if (linkError) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-destructive" data-testid="text-plaid-connect-error">{linkError}</span>
        <Button size="sm" variant="outline" onClick={fetchToken} data-testid="button-plaid-retry">Retry</Button>
      </div>
    );
  }

  return (
    <Button size="sm" variant="outline" onClick={() => open()} disabled={!ready || !linkToken} data-testid="button-connect-plaid">
      <Plus className="h-3 w-3 mr-1" /> Connect Institution
    </Button>
  );
}

export function AccountsContent() {
  const { toast } = useToast();
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<ManualAsset | null>(null);

  const summaryQuery = useQuery<FinanceSummary>({ queryKey: ["/api/finance/summary"] });
  const accountsQuery = useQuery<PlaidAccountItem[]>({ queryKey: ["/api/plaid/accounts"] });
  const assetsQuery = useQuery<{ assets: ManualAsset[] }>({ queryKey: ["/api/finance/manual-assets"] });
  const syncStatusQuery = useQuery<{ statuses: SyncStatus[] }>({ queryKey: ["/api/plaid/sync-status"] });

  const summary = summaryQuery.data;
  const plaidItems = accountsQuery.data || [];
  const manualAssets = assetsQuery.data?.assets || [];
  const syncStatuses = syncStatusQuery.data?.statuses || [];
  const syncStatusByItem = useMemo(() => new Map(syncStatuses.map(s => [s.itemId, s])), [syncStatuses]);

  const totalAssets = summary?.totalAssets ?? 0;

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetFormSchema),
    defaultValues: { name: "", category: "", currentValue: 0, notes: "" },
  });

  const openNewAsset = () => {
    setEditingAsset(null);
    form.reset({ name: "", category: "", currentValue: 0, notes: "" });
    setAssetDialogOpen(true);
  };

  const openEditAsset = (asset: ManualAsset) => {
    setEditingAsset(asset);
    form.reset({ name: asset.name, category: asset.category, currentValue: asset.currentValue, notes: asset.notes || "" });
    setAssetDialogOpen(true);
  };

  const createMutation = useMutation({
    mutationFn: (data: AssetFormValues) => apiRequest("POST", "/api/finance/manual-assets", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      setAssetDialogOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: AssetFormValues & { id: number }) => apiRequest("PUT", `/api/finance/manual-assets/${data.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      setAssetDialogOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/finance/manual-assets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/manual-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
    },
  });

  const onSubmit = (values: AssetFormValues) => {
    if (editingAsset) {
      updateMutation.mutate({ ...values, id: editingAsset.id });
    } else {
      createMutation.mutate(values);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const isLoading = summaryQuery.isLoading || accountsQuery.isLoading || assetsQuery.isLoading;
  const hasError = summaryQuery.isError || accountsQuery.isError || assetsQuery.isError;

  const [confirmResync, setConfirmResync] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ status: string; syncPhase: string | null; pagesCompleted: number; totalAdded: number } | null>(null);

  const forceResyncMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiRequest("POST", "/api/plaid/force-resync", { itemId });
      return res.json() as Promise<{ accepted: boolean; syncedItemIds?: string[] }>;
    },
    onSuccess: (data) => {
      setConfirmResync(null);
      setSyncProgress({ status: "syncing", syncPhase: "accounts", pagesCompleted: 0, totalAdded: 0 });
      pollSyncStatus(data.syncedItemIds);
      toast({ title: "Re-sync started", description: "Clearing cursor and re-fetching all historical transactions..." });
    },
    onError: (err: Error) => {
      setConfirmResync(null);
      toast({ title: "Re-sync failed", description: err.message, variant: "destructive" });
    },
  });

  const pollSyncStatus = useCallback(async (scopedItemIds?: string[]) => {
    const maxPolls = 120;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch("/api/plaid/sync-status", { credentials: "include" });
        if (!res.ok) break;
        const data = await res.json();
        const allStatuses: Array<{ itemId: string; status: string; syncPhase: string | null; pagesCompleted: number; totalAdded: number; error?: string }> = data.statuses || [];
        const relevant = scopedItemIds
          ? allStatuses.filter(s => scopedItemIds.includes(s.itemId))
          : allStatuses;
        const syncing = relevant.find(s => s.status === "syncing");
        const errored = relevant.find(s => s.status === "error");
        if (syncing) {
          setSyncProgress({ status: "syncing", syncPhase: syncing.syncPhase, pagesCompleted: syncing.pagesCompleted, totalAdded: syncing.totalAdded });
        } else if (errored) {
          setSyncProgress({ status: "error", syncPhase: null, pagesCompleted: errored.pagesCompleted, totalAdded: errored.totalAdded });
          queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
          queryClient.invalidateQueries({ queryKey: ["/api/plaid/sync-status"] });
          return;
        } else {
          setSyncProgress(null);
          queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
          queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
          queryClient.invalidateQueries({ queryKey: ["/api/plaid/transactions"] });
          queryClient.invalidateQueries({ queryKey: ["/api/plaid/sync-status"] });
          return;
        }
      } catch { break; }
    }
    setSyncProgress(null);
    queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
  }, []);

  const syncMutation = useMutation({
    mutationFn: async (itemId: string | undefined) => {
      const res = await apiRequest("POST", "/api/plaid/sync", itemId ? { itemId } : undefined);
      const json = await res.json() as { mode?: string; accepted?: boolean; syncedItemIds?: string[]; [key: string]: unknown };
      return { ...json, requestedItemId: itemId };
    },
    onSuccess: (data: { mode?: string; accepted?: boolean; syncedItemIds?: string[]; requestedItemId?: string }) => {
      if (data?.mode === "background" || data?.accepted) {
        setSyncProgress({ status: "syncing", syncPhase: "accounts", pagesCompleted: 0, totalAdded: 0 });
        const scopeIds = data.syncedItemIds || (data.requestedItemId ? [data.requestedItemId] : undefined);
        pollSyncStatus(scopeIds);
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
        queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Sync failed",
        description: err.message || "Unable to refresh account data. Try re-linking the account.",
        variant: "destructive",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
    },
  });

  if (isLoading) {
    return (
      <div className="p-4 space-y-4" data-testid="accounts-loading">
        <SummaryMetricCardSkeleton />
        {[1, 2, 3].map(i => (
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
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="accounts-error">
        <AlertCircle className="h-6 w-6 text-destructive mb-2" />
        <p className="text-sm text-muted-foreground">Unable to load account data.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <SummaryMetricCard
        label="Total Assets"
        value={formatCurrency(totalAssets)}
        icon={<Landmark className="h-3.5 w-3.5" />}
        testId="metric-total-assets"
      />

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Connected Accounts</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => syncMutation.mutate(undefined)}
              disabled={syncMutation.isPending || (!!syncProgress && syncProgress.status !== "error")}
              className="text-xs text-primary hover:underline disabled:opacity-50"
              data-testid="button-sync-accounts"
            >
              {syncMutation.isPending || syncProgress ? "Syncing..." : "Refresh All"}
            </button>
            <PlaidConnectButton />
          </div>
        </div>

        {syncProgress && syncProgress.status === "syncing" && (
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 mb-3 flex items-center gap-2" data-testid="sync-progress-banner">
            <RefreshCw className="h-3 w-3 text-primary animate-spin" />
            <span className="text-xs text-primary">
              {syncProgress.syncPhase === "transactions"
                ? `Syncing transactions... ${syncProgress.pagesCompleted > 0 ? `${syncProgress.pagesCompleted} pages, ${syncProgress.totalAdded} transactions` : ""}`
                : syncProgress.syncPhase === "accounts"
                ? "Syncing accounts..."
                : syncProgress.syncPhase === "recurring"
                ? `Detecting recurring transactions... (${syncProgress.totalAdded} txns synced)`
                : syncProgress.syncPhase === "holdings"
                ? `Fetching holdings... (${syncProgress.totalAdded} txns synced)`
                : syncProgress.syncPhase === "liabilities"
                ? `Fetching liabilities... (${syncProgress.totalAdded} txns synced)`
                : `Syncing... ${syncProgress.pagesCompleted > 0 ? `${syncProgress.pagesCompleted} pages, ${syncProgress.totalAdded} transactions` : ""}`
              }
            </span>
          </div>
        )}
        {syncProgress && syncProgress.status === "error" && (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 mb-3 flex items-center gap-2" data-testid="sync-error-banner">
            <AlertTriangle className="h-3 w-3 text-destructive" />
            <span className="text-xs text-destructive">
              Sync encountered an error. {syncProgress.totalAdded > 0 && `${syncProgress.totalAdded} transactions were added before the error.`} Try syncing again.
            </span>
          </div>
        )}

        {plaidItems.length === 0 ? (
          <div className="rounded-lg border border-border/50 bg-card p-6 text-center" data-testid="accounts-no-plaid">
            <p className="text-xs text-muted-foreground mb-2">No bank accounts connected yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {plaidItems.map(item => {
              const health = getConnectionHealth(item);
              const HealthIcon = health.icon;
              const itemSync = syncStatusByItem.get(item.itemId);
              const showInvestigation = itemSync?.needsInvestigation && itemSync?.status !== "syncing";
              return (
                <div key={item.itemId} className="rounded-lg border border-border/50 bg-card" data-testid={`institution-${item.itemId}`}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">{item.institutionName}</span>
                      <HealthIcon className={`h-3 w-3 ${health.color}`} />
                      <Badge variant="outline" className={`text-xs px-1 py-0 h-4 ${health.color}`}>{health.label}</Badge>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => syncMutation.mutate(item.itemId)}
                        disabled={syncMutation.isPending || (!!syncProgress && syncProgress.status !== "error")}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary disabled:opacity-50 transition-colors"
                        title="Quick sync — fetch new transactions since last sync"
                        data-testid={`button-sync-${item.itemId}`}
                      >
                        <RefreshCw className={`h-3 w-3 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                      </button>
                      <button
                        onClick={() => setConfirmResync(item.itemId)}
                        disabled={forceResyncMutation.isPending || (!!syncProgress && syncProgress.status !== "error")}
                        className="inline-flex items-center gap-1 text-xs text-warning-foreground hover:text-warning-foreground dark:hover:text-warning disabled:opacity-50 transition-colors"
                        title="Force full re-sync — clears history and re-fetches everything from scratch"
                        data-testid={`button-force-resync-${item.itemId}`}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                      {!item.healthy && (
                        <PlaidConnectButton />
                      )}
                    </div>
                  </div>
                  {!item.healthy && (
                    <div className="px-3 py-2 bg-error/5 dark:bg-error/20 border-b border-border/30" data-testid={`institution-error-${item.itemId}`}>
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-3.5 w-3.5 text-error shrink-0 mt-0.5" />
                        <div className="flex flex-col gap-1">
                          <p className="text-xs text-error-foreground dark:text-error">
                            {item.healthError || "This connection is broken and needs to be re-linked."}
                          </p>
                          <p className="text-xs text-error-foreground/70">
                            Use the "Connect Institution" button above to re-link this account.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  {showInvestigation && (
                    <div className="px-3 py-2 bg-warning/5 border-b border-border/30" data-testid={`sync-warning-${item.itemId}`}>
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                        <div className="flex flex-col gap-1">
                          <p className="text-xs text-warning-foreground dark:text-warning">
                            {itemSync.error || "Initial sync may be incomplete — some accounts have missing data."}
                          </p>
                          <p className="text-xs text-warning-foreground/70">
                            Use the re-sync button (↺) to force a full re-fetch of all historical transactions.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  {itemSync && (
                    <div className="px-3 py-1.5 border-b border-border/30 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground" data-testid={`sync-info-${item.itemId}`}>
                      <span>{itemSync.totalAdded} txns synced</span>
                      <span>·</span>
                      <span>{itemSync.pagesCompleted} pages</span>
                      {itemSync.oldestTransaction && (
                        <>
                          <span>·</span>
                          <span>Data: {new Date(itemSync.oldestTransaction + "T00:00:00").toLocaleDateString()} — {itemSync.newestTransaction ? new Date(itemSync.newestTransaction + "T00:00:00").toLocaleDateString() : "now"}</span>
                        </>
                      )}
                      {itemSync.lastSynced && (
                        <>
                          <span>·</span>
                          <span>Last sync: {new Date(itemSync.lastSynced).toLocaleString()}</span>
                        </>
                      )}
                      {itemSync.status === "error" && itemSync.error && (
                        <>
                          <span>·</span>
                          <span className="text-destructive">{itemSync.error}</span>
                        </>
                      )}
                    </div>
                  )}
                  <div className="divide-y divide-border/30">
                    {item.accounts.map(acct => (
                      <div key={acct.accountId} className="flex items-center justify-between px-3 py-2 text-xs" data-testid={`account-row-${acct.accountId}`}>
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="font-medium text-foreground truncate">{acct.name}</span>
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <span>{formatAccountType(acct.type, acct.subtype)}</span>
                            <FreshnessBadge lastUpdated={acct.lastUpdated} />
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 shrink-0 ml-2">
                          <span className="font-medium tabular-nums text-foreground">
                            {acct.currentBalance !== null ? formatCurrency(acct.currentBalance) : "—"}
                          </span>
                          {acct.availableBalance !== null && acct.availableBalance !== acct.currentBalance && (
                            <span className="text-muted-foreground tabular-nums">
                              {formatCurrency(acct.availableBalance)} avail.
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Manual Assets</h3>
          <button onClick={openNewAsset} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="button-add-asset">
            <Plus className="h-3 w-3" /> Add Asset
          </button>
        </div>

        {manualAssets.length === 0 ? (
          <div className="rounded-lg border border-border/50 bg-card p-6 text-center" data-testid="assets-empty">
            <p className="text-xs text-muted-foreground">No manual assets added yet.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 bg-card divide-y divide-border/50">
            {manualAssets.map(asset => (
              <div key={asset.id} className="flex items-center justify-between px-3 py-2.5 text-xs" data-testid={`asset-row-${asset.id}`}>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-medium text-foreground truncate">{asset.name}</span>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span>{asset.category}</span>
                    <FreshnessBadge lastUpdated={asset.lastUpdated} />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="font-medium tabular-nums text-foreground">{formatCurrency(asset.currentValue)}</span>
                  <button onClick={() => openEditAsset(asset)} className="text-muted-foreground hover:text-foreground" data-testid={`button-edit-asset-${asset.id}`}>
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(asset.id)}
                    className="text-muted-foreground hover:text-destructive"
                    data-testid={`button-delete-asset-${asset.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={!!confirmResync} onOpenChange={() => setConfirmResync(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Force Full Re-sync</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              This will clear the sync cursor and re-fetch all historical transactions from Plaid. This is useful if the initial sync was incomplete or data is missing.
            </p>
            <p className="text-xs text-warning-foreground">
              Existing transactions will be updated or deduplicated — no data will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmResync(null)} data-testid="button-cancel-resync">Cancel</Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={forceResyncMutation.isPending}
                onClick={() => confirmResync && forceResyncMutation.mutate(confirmResync)}
                data-testid="button-confirm-resync"
              >
                {forceResyncMutation.isPending ? "Starting..." : "Force Re-sync"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={assetDialogOpen} onOpenChange={setAssetDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">{editingAsset ? "Edit Asset" : "Add Manual Asset"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Name</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-asset-name" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="category" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Category</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="h-8 text-xs" data-testid="select-asset-category"><SelectValue placeholder="Select category" /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ASSET_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="currentValue" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Value ($)</FormLabel>
                  <FormControl><Input type="number" step="0.01" {...field} className="h-8 text-xs" data-testid="input-asset-value" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Notes (optional)</FormLabel>
                  <FormControl><Input {...field} className="h-8 text-xs" data-testid="input-asset-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setAssetDialogOpen(false)} data-testid="button-cancel-asset">Cancel</Button>
                <Button type="submit" size="sm" disabled={isPending} data-testid="button-save-asset">
                  {isPending ? "Saving..." : editingAsset ? "Update" : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
