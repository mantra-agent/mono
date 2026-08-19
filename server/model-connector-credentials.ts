/**
 * Per-connector credential authority for model connectors.
 *
 * Subscription OAuth tokens and API/CLI secrets both live on the
 * provider_connections row via provider-credential-store. Global app_secrets
 * and hard-coded connected_accounts IDs remain compatibility fallbacks only.
 */
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { providerConnections } from "@shared/models/platforms";
import {
  deleteProviderCredential,
  getProviderCredential,
  storeProviderCredential,
} from "./provider-credential-store";
import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";
import { getAccount, getAccountTokens, deleteAccount } from "./connected-accounts";
import { createNamedSystemPrincipal } from "./principal";
import { runWithPrincipal } from "./principal-context";
import type { ModelConnectorProvider } from "@shared/model-connectors";

const log = createLogger("ModelConnectorCredentials");

export type SubscriptionProvider = "openai-subscription" | "grok-subscription";

export interface SubscriptionTokenBlob {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
  email?: string;
  label?: string;
}

const LEGACY_SUBSCRIPTION_ACCOUNT: Record<SubscriptionProvider, string> = {
  "openai-subscription": "openai-subscription-primary",
  "grok-subscription": "grok-subscription-primary",
};

const LEGACY_SECRET_NAME: Partial<Record<ModelConnectorProvider, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "claude-cli": "CLAUDE_CODE_OAUTH_TOKEN",
};

function isSubscriptionTokens(value: unknown): value is SubscriptionTokenBlob {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as SubscriptionTokenBlob).access_token === "string"
    && (value as SubscriptionTokenBlob).access_token.length > 0
  );
}

function parseSubscriptionTokens(raw: string | null): SubscriptionTokenBlob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSubscriptionTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function getConnectorRow(connectorId: number): Promise<typeof providerConnections.$inferSelect | null> {
  if (!Number.isFinite(connectorId) || connectorId <= 0) return null;
  const [row] = await db
    .select()
    .from(providerConnections)
    .where(and(
      eq(providerConnections.id, connectorId),
      eq(providerConnections.connectorKind, "model"),
    ))
    .limit(1);
  return row ?? null;
}

/** Store subscription OAuth tokens on the connector row. */
export async function storeConnectorSubscriptionTokens(
  connectorId: number,
  tokens: SubscriptionTokenBlob,
  updatedBy: string | null,
): Promise<void> {
  const row = await getConnectorRow(connectorId);
  if (!row) throw new Error("Model connector not found");
  if (row.provider !== "openai-subscription" && row.provider !== "grok-subscription") {
    throw new Error(`Connector ${connectorId} is not a subscription provider`);
  }
  await storeProviderCredential(connectorId, JSON.stringify(tokens), updatedBy);
  log.info("stored subscription tokens on connector", { connectorId, provider: row.provider, email: tokens.email ?? null });
}

/** Read subscription tokens from the connector; null when unset. */
export async function getConnectorSubscriptionTokens(
  connectorId: number,
): Promise<SubscriptionTokenBlob | null> {
  const raw = await getProviderCredential(connectorId);
  return parseSubscriptionTokens(raw);
}

export async function clearConnectorCredential(connectorId: number): Promise<void> {
  await deleteProviderCredential(connectorId);
}

/** Plain secret (API key / Claude OAuth token) on the connector. */
export async function storeConnectorSecret(
  connectorId: number,
  secret: string,
  updatedBy: string | null,
): Promise<void> {
  const row = await getConnectorRow(connectorId);
  if (!row) throw new Error("Model connector not found");
  if (row.provider === "openai-subscription" || row.provider === "grok-subscription") {
    throw new Error("Use subscription OAuth for subscription connectors");
  }
  await storeProviderCredential(connectorId, secret, updatedBy);
}

export async function getConnectorSecret(connectorId: number): Promise<string | null> {
  const raw = await getProviderCredential(connectorId);
  if (!raw) return null;
  // Subscription blobs are JSON; plain secrets are not.
  if (parseSubscriptionTokens(raw)) return null;
  return raw;
}

export interface ConnectorAuthStatus {
  connected: boolean;
  email?: string;
  label?: string;
  hasTokens?: boolean;
  hasCredential?: boolean;
  credentialLast4?: string;
  source: "connector" | "legacy" | "none";
}

/**
 * Named Router members are exclusive instances. Only the legacy NULL-router
 * chain may inherit global primary accounts / app_secrets during cutover.
 */
function allowsLegacyCredentialFallback(routerId: string | null | undefined): boolean {
  return routerId == null;
}

/**
 * Auth status for UI. Prefers connector-owned credential.
 * Legacy global fallback applies only to unmigrated NULL-router rows.
 */
export async function getConnectorAuthStatus(connectorId: number): Promise<ConnectorAuthStatus> {
  const row = await getConnectorRow(connectorId);
  if (!row) throw new Error("Model connector not found");
  const legacyOk = allowsLegacyCredentialFallback(row.routerId);

  if (row.provider === "openai-subscription" || row.provider === "grok-subscription") {
    const tokens = await getConnectorSubscriptionTokens(connectorId);
    if (tokens) {
      return {
        connected: true,
        email: tokens.email,
        label: tokens.label || tokens.email,
        hasTokens: true,
        source: "connector",
      };
    }
    if (!legacyOk) return { connected: false, source: "none" };
    // Legacy primary account fallback (NULL-router chain only).
    const legacyId = LEGACY_SUBSCRIPTION_ACCOUNT[row.provider];
    const legacy = await runWithPrincipal(createNamedSystemPrincipal("model-connector-auth"), async () => {
      const account = await getAccount(legacyId);
      if (!account) return null;
      const legacyTokens = await getAccountTokens(legacyId);
      return {
        connected: true as const,
        email: account.email ?? undefined,
        label: account.label ?? undefined,
        hasTokens: !!legacyTokens,
        source: "legacy" as const,
      };
    });
    if (legacy) return legacy;
    return { connected: false, source: "none" };
  }

  const secret = await getConnectorSecret(connectorId);
  if (secret) {
    return {
      connected: true,
      hasCredential: true,
      credentialLast4: row.credentialLast4 || undefined,
      source: "connector",
    };
  }
  if (!legacyOk) return { connected: false, hasCredential: false, source: "none" };
  const legacyName = LEGACY_SECRET_NAME[row.provider as ModelConnectorProvider];
  if (legacyName && getSecretSync(legacyName)) {
    return { connected: true, hasCredential: true, source: "legacy" };
  }
  return { connected: false, hasCredential: false, source: "none" };
}

/**
 * Resolve a usable secret/token string for routing.
 * Subscriptions return a sentinel when tokens exist (token materialization stays in model-client).
 * API/CLI return the secret string. Legacy globals apply only to NULL-router rows.
 */
export async function resolveConnectorCredentialMaterial(
  connectorId: number,
  provider: ModelConnectorProvider,
): Promise<string | null> {
  const row = await getConnectorRow(connectorId);
  const legacyOk = allowsLegacyCredentialFallback(row?.routerId);

  if (provider === "openai-subscription" || provider === "grok-subscription") {
    const tokens = await getConnectorSubscriptionTokens(connectorId);
    if (tokens?.access_token) return "connector-subscription";
    if (!legacyOk) return null;
    const legacyId = LEGACY_SUBSCRIPTION_ACCOUNT[provider];
    const legacy = await runWithPrincipal(createNamedSystemPrincipal("model-connector-auth"), () => getAccount(legacyId));
    return legacy ? "legacy-subscription" : null;
  }

  const secret = await getConnectorSecret(connectorId);
  if (secret) return secret;
  if (!legacyOk) return null;

  const legacyName = LEGACY_SECRET_NAME[provider];
  if (legacyName) return getSecretSync(legacyName) || null;
  return null;
}

/**
 * Load subscription tokens for a connector.
 * Named-router connectors never inherit the legacy primary account.
 * When connectorId is omitted, legacy primary only (image paths / unrouted calls).
 */
export async function loadSubscriptionTokens(
  provider: SubscriptionProvider,
  connectorId?: number | null,
): Promise<{ tokens: SubscriptionTokenBlob; connectorId: number | null; source: "connector" | "legacy" }> {
  if (connectorId && connectorId > 0) {
    const tokens = await getConnectorSubscriptionTokens(connectorId);
    if (tokens) return { tokens, connectorId, source: "connector" };
    const row = await getConnectorRow(connectorId);
    if (row && !allowsLegacyCredentialFallback(row.routerId)) {
      throw Object.assign(
        new Error(`${provider} not connected on this connector. Connect the account on this connector instance.`),
        { code: "CONNECTOR_NOT_CONFIGURED" },
      );
    }
  }
  const legacyId = LEGACY_SUBSCRIPTION_ACCOUNT[provider];
  const legacyTokens = await runWithPrincipal(createNamedSystemPrincipal("model-client"), async () => {
    const raw = await getAccountTokens(legacyId);
    if (!isSubscriptionTokens(raw)) return null;
    return raw as SubscriptionTokenBlob;
  });
  if (!legacyTokens) {
    throw Object.assign(new Error(`${provider} not connected. Connect the account on the connector.`), {
      code: "CONNECTOR_NOT_CONFIGURED",
    });
  }
  return { tokens: legacyTokens, connectorId: connectorId && connectorId > 0 ? connectorId : null, source: "legacy" };
}

export async function persistSubscriptionTokens(
  provider: SubscriptionProvider,
  tokens: SubscriptionTokenBlob,
  connectorId: number | null,
  updatedBy: string | null,
): Promise<void> {
  if (connectorId && connectorId > 0) {
    await storeConnectorSubscriptionTokens(connectorId, tokens, updatedBy);
    return;
  }
  // Legacy write path during dual-run.
  const { updateAccount } = await import("./connected-accounts");
  await runWithPrincipal(createNamedSystemPrincipal("model-client"), () =>
    updateAccount(LEGACY_SUBSCRIPTION_ACCOUNT[provider], { tokens }),
  );
}

export async function disconnectConnectorAuth(connectorId: number): Promise<void> {
  const row = await getConnectorRow(connectorId);
  if (!row) throw new Error("Model connector not found");
  await clearConnectorCredential(connectorId);
  // If this was the only consumer of a legacy primary and tokens were never migrated,
  // leave leftover global secrets alone — other leftover rows may still need them.
  log.info("cleared connector auth", { connectorId, provider: row.provider });
}

export function legacySubscriptionAccountId(provider: SubscriptionProvider): string {
  return LEGACY_SUBSCRIPTION_ACCOUNT[provider];
}

export async function deleteLegacySubscriptionAccount(provider: SubscriptionProvider): Promise<void> {
  await runWithPrincipal(createNamedSystemPrincipal("model-connector-auth"), () =>
    deleteAccount(LEGACY_SUBSCRIPTION_ACCOUNT[provider]),
  );
}
