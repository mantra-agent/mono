import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  Loader2,
  Plug,
  Shield,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

type SubscriptionKind = "openai" | "grok";

const SUBSCRIPTION_CONFIG = {
  openai: {
    statusKey: ["/api/openai-subscription/status"] as const,
    disconnectPath: "/api/openai-subscription/disconnect",
    exchangePath: "/api/openai-subscription/oauth/exchange",
    startPath: "/api/openai-subscription/oauth/start",
    popupName: "openai-subscription-oauth",
    testId: "card-openai-subscription",
    disconnectTestId: "button-disconnect-openai-subscription",
    connectTestId: "button-connect-openai-subscription",
    pasteTestId: "input-oauth-callback-url",
    submitTestId: "button-submit-oauth-url",
    connectedToast: "ChatGPT account connected",
    disconnectedToast: "ChatGPT account disconnected",
    pastePlaceholder: "Paste callback URL",
    usesRawCode: false,
  },
  grok: {
    statusKey: ["/api/grok-subscription/status"] as const,
    disconnectPath: "/api/grok-subscription/disconnect",
    exchangePath: "/api/grok-subscription/oauth/exchange",
    startPath: "/api/grok-subscription/oauth/start",
    popupName: "grok-subscription-oauth",
    testId: "card-grok-subscription",
    disconnectTestId: "button-disconnect-grok-subscription",
    connectTestId: "button-connect-grok-subscription",
    pasteTestId: "input-grok-oauth-callback-url",
    submitTestId: "button-submit-grok-oauth-url",
    authorizeTestId: "link-grok-oauth-authorize",
    connectedToast: "Grok account connected",
    disconnectedToast: "Grok account disconnected",
    pastePlaceholder: "Paste code",
    usesRawCode: true,
  },
} as const;

/**
 * Shared subscription account section for OpenAI / Grok. Owns connect,
 * disconnect, and status rows. Label is "Subscription" because the parent
 * Integrations/Routers row already names the provider.
 */
export function SubscriptionSection({
  kind,
  children,
}: {
  kind: SubscriptionKind;
  children?: React.ReactNode;
}) {
  const cfg = SUBSCRIPTION_CONFIG[kind];
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canManageSystemIntegrations = hasPermission("system:write");

  const { data: statusData, isLoading, refetch } = useQuery<{
    connected: boolean;
    email?: string;
    label?: string;
    hasTokens?: boolean;
  }>({
    queryKey: [...cfg.statusKey],
    refetchInterval: 30000,
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", cfg.disconnectPath);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...cfg.statusKey] });
      queryClient.invalidateQueries({ queryKey: ["/api/models/available"] });
      toast({ title: cfg.disconnectedToast });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to disconnect", description: err.message, variant: "destructive" });
    },
  });

  const [showUrlPaste, setShowUrlPaste] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [exchangeState, setExchangeState] = useState("");
  const [isExchanging, setIsExchanging] = useState(false);

  const exchangeCode = async (code: string, state: string) => {
    setIsExchanging(true);
    try {
      const res = await fetch(cfg.exchangePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code, state }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Exchange failed");
      toast({ title: cfg.connectedToast, description: data.email || "Success" });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/models/available"] });
      setShowUrlPaste(false);
      setPasteUrl("");
    } catch (err: any) {
      toast({ title: "Failed to connect", description: err.message, variant: "destructive" });
    } finally {
      setIsExchanging(false);
    }
  };

  const handleConnect = async () => {
    try {
      if (!canManageSystemIntegrations) {
        toast({
          title: "Admin only",
          description: "Only admins can change system model integrations.",
          variant: "destructive",
        });
        return;
      }
      const res = await fetch(cfg.startPath, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start OAuth");
      }
      const { url, state } = await res.json();
      setExchangeState(state);
      setAuthUrl(url || "");

      if (kind === "grok") {
        // xAI shows the authorization code on-page; always reveal paste + manual link.
        setShowUrlPaste(true);
        const popup = window.open(url, cfg.popupName, "width=600,height=700,scrollbars=yes");
        if (!popup) {
          toast({
            title: "Popup blocked",
            description: "Use the Authorize link below, approve access, then paste the code.",
          });
        }
        return;
      }

      const popup = window.open(url, cfg.popupName, "width=600,height=700,scrollbars=yes");
      if (!popup) {
        toast({ title: "Popup blocked", description: "Please allow popups and try again.", variant: "destructive" });
        return;
      }
      let handled = false;
      const pasteTimer = setTimeout(() => {
        if (!handled) setShowUrlPaste(true);
      }, 4000);
      const check = setInterval(() => {
        if (handled) return;
        try {
          const popupUrl = popup.location.href;
          if (popupUrl && popupUrl.includes("/auth/callback")) {
            const params = new URL(popupUrl).searchParams;
            const code = params.get("code");
            const urlState = params.get("state");
            if (code && urlState) {
              handled = true;
              clearInterval(check);
              clearTimeout(pasteTimer);
              popup.close();
              exchangeCode(code, urlState);
              return;
            }
          }
        } catch {
          /* cross-origin, expected */
        }
        if (popup.closed && !handled) {
          clearInterval(check);
          clearTimeout(pasteTimer);
          setShowUrlPaste(true);
        }
      }, 300);
    } catch (err: any) {
      toast({ title: "Failed to start OAuth", description: err.message, variant: "destructive" });
    }
  };

  const handlePasteSubmit = () => {
    const raw = pasteUrl.trim();
    if (!raw) return;
    try {
      const url = new URL(raw);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || exchangeState;
      if (!code) {
        toast({ title: "Invalid URL", description: "No authorization code found in URL", variant: "destructive" });
        return;
      }
      exchangeCode(code, state);
    } catch {
      if (cfg.usesRawCode) {
        exchangeCode(raw, exchangeState);
        return;
      }
      toast({ title: "Invalid URL", description: "Please paste the full URL from the browser address bar", variant: "destructive" });
    }
  };

  const connected = statusData?.connected ?? false;

  return (
    <div className="min-w-0" data-testid={cfg.testId}>
      <IntegrationTreeSection label="Subscription" initialOpen={!connected} icon={<Bot className="h-3.5 w-3.5" />}>
        <ProfileTreeRow label="Account" icon={<Bot className="h-3.5 w-3.5" />} hasValue showEmpty>
          <span className="text-muted-foreground">{statusData?.email || statusData?.label || "Not connected"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Status"
          icon={connected ? <CheckCircle2 className="h-3.5 w-3.5 text-active" /> : <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
          hasValue
          showEmpty
        >
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className={connected ? "text-active" : "text-muted-foreground"}>
              {isLoading ? "Loading" : connected ? "Connected" : "Not connected"}
            </span>
            {isLoading ? (
              <Skeleton className="h-5 w-16" />
            ) : connected ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending || !canManageSystemIntegrations}
                title={canManageSystemIntegrations ? undefined : "Admin only"}
                data-testid={cfg.disconnectTestId}
              >
                {disconnectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                Disconnect
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnect}
                disabled={isExchanging || !canManageSystemIntegrations}
                title={canManageSystemIntegrations ? undefined : "Admin only"}
                data-testid={cfg.connectTestId}
              >
                {isExchanging ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
                {isExchanging ? "Connecting..." : "Connect"}
              </Button>
            )}
            {!connected && showUrlPaste && (
              <>
                <Input
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  placeholder={cfg.pastePlaceholder}
                  className="min-w-[10rem] flex-1 text-xs"
                  data-testid={cfg.pasteTestId}
                />
                <Button
                  size="sm"
                  onClick={handlePasteSubmit}
                  disabled={!pasteUrl.trim() || isExchanging}
                  data-testid={cfg.submitTestId}
                >
                  {isExchanging ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit"}
                </Button>
                {kind === "grok" && authUrl ? (
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-cta underline hover:text-active"
                    data-testid={SUBSCRIPTION_CONFIG.grok.authorizeTestId}
                  >
                    Authorize
                  </a>
                ) : null}
              </>
            )}
          </div>
        </ProfileTreeRow>
        {!canManageSystemIntegrations && (
          <ProfileTreeRow label="Access" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground">Admin only</span>
          </ProfileTreeRow>
        )}
        {children}
      </IntegrationTreeSection>
    </div>
  );
}

export function OpenAISubscriptionSection({ children }: { children?: React.ReactNode }) {
  return <SubscriptionSection kind="openai">{children}</SubscriptionSection>;
}

export function GrokSubscriptionSection({ children }: { children?: React.ReactNode }) {
  return <SubscriptionSection kind="grok">{children}</SubscriptionSection>;
}
