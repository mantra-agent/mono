import { ModelConnectorSection } from "@/components/integrations/model-connector-section";
import {
  GrokSubscriptionSection,
  OpenAISubscriptionSection,
} from "@/components/integrations/subscription-section";
import { ConnectorSecretSection } from "@/components/integrations/connector-secret-section";
import type { ModelConnectorProvider } from "@shared/model-connectors";

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
 * Auth is always connector-scoped. Callers must pass the Router connector
 * instance; leftover Integrations singleton resolution is gone.
 */
export function ProviderConnectorPackage({
  provider,
  connector,
  invalidateQueryKeys,
  /** Routers: skip Subscription / Models section headers and nest fields under the connector. */
  flattenHeaders = false,
}: {
  provider: PackagedConnectorProvider;
  connector: ConnectorProp;
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
  flattenHeaders?: boolean;
}) {
  const connectorId = connector.id;

  const models = (
    <ModelConnectorSection
      provider={provider}
      connector={connector as any}
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
    return (
      <div className="min-w-0" data-testid="card-secret-openai">
        <ConnectorSecretSection
          connectorId={connectorId}
          label="API"
          placeholder="sk-…"
          flattenHeaders={flattenHeaders}
          invalidateQueryKeys={invalidateQueryKeys}
        >
          {models}
        </ConnectorSecretSection>
      </div>
    );
  }

  if (provider === "anthropic") {
    return (
      <div className="min-w-0" data-testid="card-secret-anthropic">
        <ConnectorSecretSection
          connectorId={connectorId}
          label="API"
          placeholder="sk-ant-…"
          flattenHeaders={flattenHeaders}
          invalidateQueryKeys={invalidateQueryKeys}
        >
          {models}
        </ConnectorSecretSection>
      </div>
    );
  }

  return (
    <div className="min-w-0" data-testid="card-secret-claude-cli">
      <ConnectorSecretSection
        connectorId={connectorId}
        label="Claude Code CLI"
        placeholder="Claude Code OAuth token"
        flattenHeaders={flattenHeaders}
        invalidateQueryKeys={invalidateQueryKeys}
      >
        {models}
      </ConnectorSecretSection>
    </div>
  );
}

