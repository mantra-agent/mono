import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Circle, ClipboardList, Loader2, Plus, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";

interface MondayAccount {
  accountId: string;
  email: string | null;
  label: string;
  workspaceName?: string | null;
  vaultId: string | null;
  healthy: boolean | null;
  healthError?: string | null;
}

export function MondaySection({ vaultId }: { vaultId?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = useQuery<{ oauthConfigured: boolean }>({ queryKey: ["/api/monday/status"] });
  const accounts = useQuery<{ accounts: MondayAccount[] }>({
    queryKey: ["/api/connected-accounts", "monday"],
    queryFn: async () => (await apiRequest("GET", "/api/connected-accounts?provider=monday")).json(),
  });
  const connect = useMutation({
    mutationFn: async (popup: Window) => {
      if (!vaultId) throw new Error("Choose an active Vault before connecting Monday");
      const { url } = await (await apiRequest("POST", "/api/monday/oauth/start", { vaultId })).json();
      popup.location.replace(url);
    },
    onError: (error: Error, popup) => {
      popup.close();
      toast({
        title: "Monday connection failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  const disconnect = useMutation({
    mutationFn: async (account: MondayAccount) =>
      apiRequest("DELETE", `/api/monday/accounts/${encodeURIComponent(account.accountId)}`, {
        confirmation: account.email || account.label,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "monday"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "Monday disconnected" });
    },
    onError: (error: Error) =>
      toast({
        title: "Monday disconnect failed",
        description: error.message,
        variant: "destructive",
      }),
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; status?: string; message?: string } | null;
      if (!data || data.type !== "mantra:monday-oauth") return;
      queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "monday"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      if (data.status === "connected") {
        toast({ title: "Monday connected" });
      } else {
        toast({
          title: "Monday connection failed",
          description: data.message || "Please try connecting again.",
          variant: "destructive",
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient, toast]);

  const startMondayOAuth = () => {
    const popup = window.open("about:blank", "mantra-monday-oauth", "width=600,height=760,scrollbars=yes");
    if (!popup) {
      toast({ title: "Popup blocked", description: "Allow popups and try again.", variant: "destructive" });
      return;
    }
    connect.mutate(popup);
  };

  const list = accounts.data?.accounts || [];
  const hasAccount = list.length > 0;
  const primary = list[0];
  const unhealthy = primary && primary.healthy === false;

  return (
    <div className="space-y-0" data-testid="monday-section">
      {list.map((account, index, allAccounts) => {
        const icon =
          account.healthy === false ? (
            <AlertTriangle className="h-3.5 w-3.5 text-error" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          );
        const value =
          account.healthy === false
            ? account.healthError || "Connection unhealthy"
            : account.workspaceName || account.email || account.label;
        return (
          <HierarchyTreeRow
            key={account.accountId}
            continues
            connectorAnchor="first-row-center"
          >
            <ProfileTreeRow
              label={account.label}
              icon={icon}
              hasValue={Boolean(value)}
              showEmpty
              mobileLayout="inline"
              valueLayout="compact"
              actionContent={
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                  aria-label={`Disconnect ${account.label}`}
                  onClick={() => disconnect.mutate(account)}
                  disabled={disconnect.isPending}
                >
                  {disconnect.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              }
            >
              <span className={account.healthy === false ? "text-error" : undefined}>{value}</span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
        );
      })}
      <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
        <div className="flex min-h-10 items-center gap-2 px-2 py-1.5">
          {hasAccount ? (
            unhealthy ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-error" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            )
          ) : (
            <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {!status.data?.oauthConfigured
              ? "Monday connection unavailable"
              : hasAccount
                ? unhealthy
                  ? "Reconnect Monday"
                  : "Connected"
                : "Connect Monday"}
          </span>
          <button
            type="button"
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            onClick={startMondayOAuth}
            disabled={!status.data?.oauthConfigured || connect.isPending}
          >
            {connect.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            <span>{hasAccount ? "Reconnect" : "Connect"}</span>
          </button>
        </div>
      </HierarchyTreeRow>
      {!hasAccount && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <ClipboardList className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Read-only boards for assessment</span>
        </div>
      )}
    </div>
  );
}
