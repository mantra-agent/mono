import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2, Plug, Shield, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

interface ConnectorAuthStatus {
  connected: boolean;
  hasCredential?: boolean;
  credentialLast4?: string;
  source: "connector" | "legacy" | "none";
}

/**
 * Plain-secret auth block for openai / anthropic / claude-cli connectors.
 * Binds to a specific provider_connections row — not the global app_secrets section.
 */
export function ConnectorSecretSection({
  connectorId,
  label = "Credentials",
  placeholder = "Paste secret",
  invalidateQueryKeys,
  children,
}: {
  connectorId: number;
  label?: string;
  placeholder?: string;
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
  children?: React.ReactNode;
}) {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("system:write");
  const [draft, setDraft] = useState("");
  const statusKey = [`/api/models/connectors/${connectorId}/auth-status`] as const;

  const { data, isLoading } = useQuery<ConnectorAuthStatus>({
    queryKey: [...statusKey],
    enabled: Number.isFinite(connectorId) && connectorId > 0,
  });

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: [...statusKey] });
    if (invalidateQueryKeys) {
      await Promise.all(invalidateQueryKeys.map((key) => queryClient.invalidateQueries({ queryKey: [...key] })));
    }
    await queryClient.invalidateQueries({ queryKey: ["/api/models/available"] });
  }

  const saveMutation = useMutation({
    mutationFn: async (secret: string) => {
      const res = await apiRequest("POST", `/api/models/connectors/${connectorId}/secret`, { secret });
      return res.json();
    },
    onSuccess: async () => {
      setDraft("");
      await invalidate();
      toast({ title: "Credential saved on connector" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/models/connectors/${connectorId}/disconnect`);
      return res.json();
    },
    onSuccess: async () => {
      await invalidate();
      toast({ title: "Connector credential cleared" });
    },
    onError: (err: Error) => toast({ title: "Disconnect failed", description: err.message, variant: "destructive" }),
  });

  const connected = data?.connected ?? false;
  const last4 = data?.credentialLast4;
  const sourceNote = data?.source === "legacy" ? " (legacy global)" : "";

  return (
    <div className="min-w-0" data-testid={`connector-secret-${connectorId}`}>
      <IntegrationTreeSection label={label} initialOpen={!connected} icon={<Shield className="h-3.5 w-3.5" />}>
        <ProfileTreeRow
          label="Status"
          icon={connected ? <CheckCircle2 className="h-3.5 w-3.5 text-active" /> : <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
          hasValue
          showEmpty
        >
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className={connected ? "text-active" : "text-muted-foreground"}>
              {isLoading ? "Loading" : connected ? `Connected${last4 ? ` ···${last4}` : ""}${sourceNote}` : "Not connected"}
            </span>
            {connected ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={!canWrite || disconnectMutation.isPending}
                onClick={() => disconnectMutation.mutate()}
              >
                {disconnectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                Clear
              </Button>
            ) : null}
          </div>
        </ProfileTreeRow>
        <ProfileTreeRow label="Secret" icon={<KeyRound className="h-3.5 w-3.5" />} hasValue showEmpty>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              className="min-w-[10rem] flex-1 text-xs"
              disabled={!canWrite || saveMutation.isPending}
            />
            <Button
              size="sm"
              disabled={!canWrite || !draft.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate(draft.trim())}
            >
              {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
              Save
            </Button>
          </div>
        </ProfileTreeRow>
        {!canWrite ? (
          <ProfileTreeRow label="Access" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground">Admin only</span>
          </ProfileTreeRow>
        ) : null}
        {children}
      </IntegrationTreeSection>
    </div>
  );
}
