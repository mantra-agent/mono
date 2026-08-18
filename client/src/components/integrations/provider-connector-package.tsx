import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { ModelConnectorSection } from "@/components/integrations/model-connector-section";
import {
  GrokSubscriptionSection,
  OpenAISubscriptionSection,
} from "@/components/integrations/subscription-section";
import { ConnectorSecretSection } from "@/components/integrations/connector-secret-section";
import type { ModelConnectorProvider } from "@shared/model-connectors";
import { apiRequest } from "@/lib/queryClient";

export type PackagedConnectorProvider =
  | "openai-subscription"
  | "openai"
  | "grok-subscription"
  | "claude-cli"
  | "anthropic";

export const PACKAGED_CONNECTOR_PROVIDERS = new Set<string>([
  "openai-subscription",
  "openai",
  "grok-subscription",
  "claude-cli",
  "anthropic",
]);

type ConnectorProp = {
  id: number;
  provider: ModelConnectorProvider;
  label: string;
  status: string;
  sortOrder?: number;
  priorityPinned?: boolean;
  config: {
    kind?: "model" | "openai-models" | "claude-cli-models" | "grok-models";
    tierMappings: Record<"max" | "high" | "balanced" | "fast", string | { model: string }>;
  };
};

/**
 * Full packageable connector widget: account/credentials + Models tree.
 * Auth is always connector-scoped (provider_connections.id). When only a
 * provider is passed (Integrations page), resolve the legacy singleton row.
 */
export function ProviderConnectorPackage({
  provider,
  connector,
  invalidateQueryKeys,
  /** When true, omit the outer provider section chrome (Integrations page already owns it). */
  bare = false,
  /** Routers: skip Subscription / Models section headers and nest fields under the connector. */
  flattenHeaders = false,
}: {
  provider: PackagedConnectorProvider;
  connector?: ConnectorProp;
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
  bare?: boolean;
  flattenHeaders?: boolean;
}) {
  const legacyQuery = useQuery<{ id: number; provider: string }>({
    queryKey: ["/api/models/connectors/by-provider", provider],
    enabled: connector == null,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/models/connectors/by-provider/${provider}`);
      return res.json();
    },
    staleTime: 15_000,
  });

  const connectorId = connector?.id ?? legacyQuery.data?.id;

  if (connectorId == null) {
    if (legacyQuery.isLoading) {
      return (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading connector…
        </div>
      );
    }
    return (
      <div className="px-2 py-1.5 text-sm text-muted-foreground">
        No connector instance for {provider}.
      </div>
    );
  }

  const models = (
    <ModelConnectorSection
      provider={provider}
      connector={connector as any}
      connectorId={connector ? undefined : connectorId}
      title="Models"
      nested
      flattenHeaders={flattenHeaders}
      invalidateQueryKeys={invalidateQueryKeys}
    />
  );

  if (provider === "openai-subscription") {
    return (
      <OpenAISubscriptionSection connectorId={connectorId} flattenHeaders={flattenHeaders} invalidateQueryKeys={invalidateQueryKeys}>
        {models}
      </OpenAISubscriptionSection>
    );
  }

  if (provider === "grok-subscription") {
    return (
      <GrokSubscriptionSection connectorId={connectorId} flattenHeaders={flattenHeaders} invalidateQueryKeys={invalidateQueryKeys}>
        {models}
      </GrokSubscriptionSection>
    );
  }

  if (provider === "openai") {
    const body = (
      <ConnectorSecretSection
        connectorId={connectorId}
        label="API"
        placeholder="sk-…"
        flattenHeaders={flattenHeaders}
        invalidateQueryKeys={invalidateQueryKeys}
      >
        {models}
      </ConnectorSecretSection>
    );
    if (bare) return <div className="min-w-0" data-testid="card-secret-openai">{body}</div>;
    return <div className="min-w-0" data-testid="card-secret-openai">{body}</div>;
  }

  if (provider === "anthropic") {
    const body = (
      <ConnectorSecretSection
        connectorId={connectorId}
        label="API"
        placeholder="sk-ant-…"
        flattenHeaders={flattenHeaders}
        invalidateQueryKeys={invalidateQueryKeys}
      >
        {models}
      </ConnectorSecretSection>
    );
    if (bare) return <div className="min-w-0" data-testid="card-secret-anthropic">{body}</div>;
    return <div className="min-w-0" data-testid="card-secret-anthropic">{body}</div>;
  }

  // claude-cli
  const body = (
    <ConnectorSecretSection
      connectorId={connectorId}
      label="Claude Code CLI"
      placeholder="Claude Code OAuth token"
      flattenHeaders={flattenHeaders}
      invalidateQueryKeys={invalidateQueryKeys}
    >
      {models}
    </ConnectorSecretSection>
  );
  if (bare) return <div className="min-w-0" data-testid="card-secret-claude-cli">{body}</div>;
  return (
    <div className="min-w-0" data-testid="card-secret-claude-cli">
      {body}
    </div>
  );
}

