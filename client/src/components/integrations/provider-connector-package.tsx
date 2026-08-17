import { Bot, Shield } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { ModelConnectorSection } from "@/components/integrations/model-connector-section";
import {
  GrokSubscriptionSection,
  OpenAISubscriptionSection,
} from "@/components/integrations/subscription-section";
import { SecretsForSection } from "@/components/SecretControl";
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
 * Used by Integrations detail and Routers connector expand so both surfaces
 * show the same configuration, including subscription account state.
 */
export function ProviderConnectorPackage({
  provider,
  connector,
  invalidateQueryKeys,
  /** When true, omit the outer provider section chrome (Integrations page already owns it). */
  bare = false,
}: {
  provider: PackagedConnectorProvider;
  connector?: ConnectorProp;
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
  bare?: boolean;
}) {
  const models = (
    <ModelConnectorSection
      provider={provider}
      connector={connector as any}
      title="Models"
      nested
      invalidateQueryKeys={invalidateQueryKeys}
    />
  );

  if (provider === "openai-subscription") {
    return <OpenAISubscriptionSection>{models}</OpenAISubscriptionSection>;
  }

  if (provider === "grok-subscription") {
    return <GrokSubscriptionSection>{models}</GrokSubscriptionSection>;
  }

  if (provider === "openai") {
    const body = (
      <>
        <ProfileTreeRow label="Credentials" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
          <div className="min-w-0 w-full"><SecretsForSection section="openai" /></div>
        </ProfileTreeRow>
        {models}
      </>
    );
    if (bare) return <div className="min-w-0" data-testid="card-secret-openai">{body}</div>;
    return (
      <div className="min-w-0" data-testid="card-secret-openai">
        <IntegrationTreeSection label="API" initialOpen icon={<Bot className="h-3.5 w-3.5" />}>
          {body}
        </IntegrationTreeSection>
      </div>
    );
  }

  if (provider === "anthropic") {
    const body = (
      <>
        <ProfileTreeRow label="Credentials" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
          <div className="min-w-0 w-full"><SecretsForSection section="anthropic" /></div>
        </ProfileTreeRow>
        {models}
      </>
    );
    if (bare) return <div className="min-w-0" data-testid="card-secret-anthropic">{body}</div>;
    return (
      <div className="min-w-0" data-testid="card-secret-anthropic">
        <IntegrationTreeSection label="API" initialOpen icon={<Bot className="h-3.5 w-3.5" />}>
          {body}
        </IntegrationTreeSection>
      </div>
    );
  }

  // claude-cli
  const body = (
    <>
      <ProfileTreeRow label="Credentials" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
        <div className="min-w-0 w-full"><SecretsForSection section="claude-cli" /></div>
      </ProfileTreeRow>
      {models}
    </>
  );
  if (bare) return <div className="min-w-0" data-testid="card-secret-claude-cli">{body}</div>;
  return (
    <div className="min-w-0" data-testid="card-secret-claude-cli">
      <IntegrationTreeSection label="Claude Code CLI" initialOpen icon={<Bot className="h-3.5 w-3.5" />}>
        {body}
      </IntegrationTreeSection>
    </div>
  );
}
