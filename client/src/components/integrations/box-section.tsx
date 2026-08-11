import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Loader2, Plus, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";

interface BoxAccount {
  accountId: string;
  email: string | null;
  label: string;
  vaultId: string | null;
  healthy: boolean | null;
}

export function BoxSection({ vaultId }: { vaultId?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = useQuery<{ oauthConfigured: boolean }>({ queryKey: ["/api/box/status"] });
  const accounts = useQuery<{ accounts: BoxAccount[] }>({
    queryKey: ["/api/connected-accounts", "box"],
    queryFn: async () => (await apiRequest("GET", "/api/connected-accounts?provider=box")).json(),
  });
  const connect = useMutation({
    mutationFn: async () => {
      if (!vaultId) throw new Error("Choose an active Vault before connecting Box");
      const { url } = await (await apiRequest("POST", "/api/box/oauth/start", { vaultId })).json();
      window.location.assign(url);
    },
    onError: (error: Error) => toast({
      title: "Box connection failed",
      description: error.message,
      variant: "destructive",
    }),
  });
  const disconnect = useMutation({
    mutationFn: async (account: BoxAccount) => apiRequest(
      "DELETE",
      `/api/box/accounts/${encodeURIComponent(account.accountId)}`,
      { confirmation: account.email || account.label },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "box"] });
      queryClient.invalidateQueries({ queryKey: ["/api/drive/resources"] });
      toast({ title: "Box disconnected" });
    },
    onError: (error: Error) => toast({
      title: "Box disconnect failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  return (
    <div className="space-y-0" data-testid="box-section">
      {(accounts.data?.accounts || []).map((account, index, allAccounts) => (
        <HierarchyTreeRow
          key={account.accountId}
          continues={index < allAccounts.length}
          connectorAnchor="first-row-center"
        >
          <ProfileTreeRow
            label={account.label}
            icon={<Box className="h-3.5 w-3.5" />}
            hasValue={Boolean(account.email)}
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
                {disconnect.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            }
          >
            {account.email}
          </ProfileTreeRow>
        </HierarchyTreeRow>
      ))}
      <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
        <div className="flex min-h-10 items-center gap-2 px-2 py-1.5">
          <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {status.data?.oauthConfigured ? "Connect Box" : "Box connection unavailable"}
          </span>
          <button
            type="button"
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            onClick={() => connect.mutate()}
            disabled={!status.data?.oauthConfigured || connect.isPending}
          >
            {connect.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Plus className="h-3.5 w-3.5" />}
            <span>Connect</span>
          </button>
        </div>
      </HierarchyTreeRow>
    </div>
  );
}
