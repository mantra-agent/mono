import { createHash } from "node:crypto";
import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";
import { getProviderCredential } from "./provider-credential-store";
import { getAccount } from "./connected-accounts";
import { createNamedSystemPrincipal } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { listModelConnectors, type ModelConnector } from "./model-connectors";
import { getConnectorTierModelConfig, type ConnectorTierModelConfig, semanticTierSchema, type SemanticTier } from "@shared/model-connectors";
import type { ActivityId } from "./job-profiles";

const log = createLogger("ModelRouting");

/** Tier used when no active persona (or an invalid persona tier) can supply routing intent. */
export const DEFAULT_SEMANTIC_TIER: SemanticTier = "fast";

export interface ConnectorAttempt {
  connectorId: number;
  connectorLabel: string;
  connectorOrder: number;
  provider: string;
  tier: SemanticTier;
  model: string;
  modelConfig?: ConnectorTierModelConfig;
  outcome: "selected" | "skipped" | "failed";
  reason?: string;
}

export interface ModelRoutingDecision {
  activity: ActivityId;
  tier: SemanticTier | "explicit-override";
  model: string;
  provider: string;
  modelString: string;
  modelConfig?: ConnectorTierModelConfig;
  configVersion: string;
  configHash: string;
  explicitOverride: boolean;
  overrideReason?: string;
  providerEnabled: boolean;
  source: "persona" | "explicit-override" | "semantic-tier-override" | "default-fallback";
  personaId?: number;
  connectorId?: number;
  connectorLabel?: string;
  connectorOrder?: number;
  attemptIndex: number;
  attempts: ConnectorAttempt[];
  credential?: string;
  fallbackCandidates?: ModelRoutingDecision[];
}

export class ModelRoutingError extends Error {
  code = "MODEL_ROUTING_ERROR";
  constructor(message: string, public routing?: Partial<ModelRoutingDecision>) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

function splitModel(modelString: string): { provider: string; model: string } {
  const slash = modelString.indexOf("/");
  return slash < 0
    ? { provider: "openai", model: modelString }
    : { provider: modelString.slice(0, slash), model: modelString.slice(slash + 1) };
}

function legacyCredential(provider: string): string | null {
  if (provider === "anthropic") return getSecretSync("ANTHROPIC_API_KEY") || null;
  if (provider === "openai") return getSecretSync("OPENAI_API_KEY") || null;
  if (provider === "claude-cli") return getSecretSync("CLAUDE_CODE_OAUTH_TOKEN") || null;
  return null;
}

async function connectorCredential(connector: ModelConnector): Promise<string | null> {
  if (connector.credentialRef) return getProviderCredential(connector.credentialRef);
  if (connector.provider === "openai-subscription") {
    return (await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), () => getAccount("openai-subscription-primary"))) ? "connected-account" : null;
  }
  return legacyCredential(connector.provider);
}

export async function resolveSemanticTier(sessionId?: string): Promise<{ tier: SemanticTier; source: "persona" | "default-fallback"; personaId?: number }> {
  const { resolveSessionPersona } = await import("./session-persona");
  const persona = await resolveSessionPersona(sessionId);
  if (!persona) {
    log.warn(`No active persona for model routing; falling back to default tier "${DEFAULT_SEMANTIC_TIER}"`);
    return { tier: DEFAULT_SEMANTIC_TIER, source: "default-fallback" };
  }
  const parsed = semanticTierSchema.safeParse(persona.semanticTier);
  if (!parsed.success) {
    log.warn(`Active persona ${persona.id} has invalid semantic tier "${String(persona.semanticTier)}"; falling back to default tier "${DEFAULT_SEMANTIC_TIER}"`);
    return { tier: DEFAULT_SEMANTIC_TIER, source: "default-fallback", personaId: persona.id };
  }
  return { tier: parsed.data, source: "persona", personaId: persona.id };
}

export async function resolveModelCandidates(
  activity: ActivityId,
  options: { model?: string; overrideReason?: string; semanticTierOverride?: SemanticTier; sessionId?: string } = {},
): Promise<ModelRoutingDecision[]> {
  if (options.model) {
    if (!options.overrideReason) throw new ModelRoutingError("Explicit model override requires overrideReason");
    const parsed = splitModel(options.model);
    return [{
      activity, tier: "explicit-override", model: parsed.model, provider: parsed.provider,
      modelString: options.model, configVersion: "explicit-override", configHash: "explicit-override",
      explicitOverride: true, overrideReason: options.overrideReason, providerEnabled: true,
      source: "explicit-override", attemptIndex: 0, attempts: [],
      credential: legacyCredential(parsed.provider) || undefined,
    }];
  }

  const intent = options.semanticTierOverride
    ? { tier: options.semanticTierOverride, source: "semantic-tier-override" as const, personaId: undefined }
    : await resolveSemanticTier(options.sessionId);
  if (options.semanticTierOverride && !options.overrideReason) throw new ModelRoutingError("Semantic tier override requires overrideReason");
  const connectors = (await listModelConnectors()).filter((connector) => connector.status === "active");
  const configHash = createHash("sha256").update(JSON.stringify(connectors.map((connector) => ({
    id: connector.id, order: connector.sortOrder, provider: connector.provider,
    mappings: connector.config.tierMappings,
  })))).digest("hex").slice(0, 12);
  const attempts: ConnectorAttempt[] = [];
  const decisions: ModelRoutingDecision[] = [];

  for (const connector of connectors) {
    const tierConfig = getConnectorTierModelConfig(connector.config, intent.tier);
    const modelString = tierConfig.model.includes("/") ? tierConfig.model : `${connector.provider}/${tierConfig.model}`;
    const parsed = splitModel(modelString);
    const credential = await connectorCredential(connector);
    if (!credential) {
      attempts.push({ connectorId: connector.id, connectorLabel: connector.label, connectorOrder: connector.sortOrder,
        provider: connector.provider, tier: intent.tier, model: parsed.model, modelConfig: tierConfig, outcome: "skipped", reason: "credential-unavailable" });
      continue;
    }
    const attemptIndex = attempts.length;
    attempts.push({ connectorId: connector.id, connectorLabel: connector.label, connectorOrder: connector.sortOrder,
      provider: connector.provider, tier: intent.tier, model: parsed.model, modelConfig: tierConfig, outcome: "selected" });
    decisions.push({
      activity, tier: intent.tier, model: parsed.model, provider: connector.provider, modelString, modelConfig: tierConfig,
      configVersion: configHash, configHash, explicitOverride: false, providerEnabled: true,
      source: intent.source, personaId: intent.personaId, connectorId: connector.id,
      connectorLabel: connector.label, connectorOrder: connector.sortOrder, attemptIndex,
      attempts: attempts.map((entry) => ({ ...entry })), credential,
    });
  }
  if (decisions.length > 1) decisions[0].fallbackCandidates = decisions.slice(1);
  if (!decisions.length) throw new ModelRoutingError(`No enabled model connector can serve tier ${intent.tier}`, {
    activity, tier: intent.tier, source: intent.source, personaId: intent.personaId, configHash, attempts,
  });
  return decisions;
}

export function appendFailedAttempt(
  routing: ModelRoutingDecision,
  error: unknown,
): ConnectorAttempt[] {
  const reason = error instanceof Error ? error.message : String(error);
  return routing.attempts.map((attempt, index) => index === routing.attemptIndex
    ? { ...attempt, outcome: "failed" as const, reason }
    : attempt);
}
