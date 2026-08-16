// ─── Connector readiness (spec §3.2, §6.2 step 5) ──────────────────────────
// Resolves whether each registered connector capability is currently usable,
// WITHOUT exposing credentials and WITHOUT per-connector database fan-out.
//
// Readiness is derived from three cheap, already-bounded sources:
//   1. Global app secrets      → synchronous getSecretSync (in-memory/env, no DB)
//   2. OAuth connected accounts → ONE principal-scoped list the resolver fetched
//   3. Platform provider conns  → ONE principal-scoped list the resolver fetched
//
// This is a shadow-mode readiness signal: it is deliberately conservative and
// synchronous. It never performs live provider health probes (that path is the
// heavy /api/setup/secrets-status endpoint) and never reads token bytes.

import { getSecretSync } from "../../secrets-store";
import type { IntegrationContribution } from "@shared/models/mod-registry";
import { getModRegistry } from "../registry";
import { REGISTERED_CONNECTOR_KEYS } from "../registry/registered-keys";

export type ConnectorReadiness = "ready" | "setup-required";

/** Minimal provider-connection shape the readiness check needs. */
export interface ReadinessProviderConnection {
  provider: string;
  status: string;
}

/** Minimal connected-account shape the readiness check needs (no secrets). */
export interface ReadinessConnectedAccount {
  provider: string;
  healthy: boolean | null;
}

function allSecrets(...names: string[]): boolean {
  return names.every((name) => {
    const value = getSecretSync(name);
    return typeof value === "string" && value.length > 0;
  });
}

function anySecret(...names: string[]): boolean {
  return names.some((name) => {
    const value = getSecretSync(name);
    return typeof value === "string" && value.length > 0;
  });
}

let contributionIndex: Map<string, IntegrationContribution> | null = null;

function integrationContributionsByConnector(): Map<string, IntegrationContribution> {
  if (contributionIndex) return contributionIndex;
  const registry = getModRegistry();
  const byKey = new Map<string, IntegrationContribution>();
  const all = [
    ...(registry.core.contributions.integrations ?? []),
    ...registry.mods.flatMap((mod) => mod.contributions.integrations ?? []),
  ];
  for (const contribution of all) {
    if (!byKey.has(contribution.connectorKey)) byKey.set(contribution.connectorKey, contribution);
  }
  contributionIndex = byKey;
  return byKey;
}

function readinessFromContribution(
  contribution: IntegrationContribution | undefined,
): ConnectorReadiness | undefined {
  if (!contribution?.readinessKind) return undefined;
  if (contribution.readinessKind === "secret") {
    const required = contribution.requiredSecrets ?? [];
    const any = contribution.requiredAnySecrets ?? [];
    const requiredOk = required.length === 0 || allSecrets(...required);
    const anyOk = any.length === 0 || anySecret(...any);
    return requiredOk && anyOk ? "ready" : "setup-required";
  }
  return undefined;
}

/**
 * Secret-backed connectors: ready iff their required app secrets are present.
 *
 * Exported as the single source of truth for cheap, synchronous, global
 * (non-principal) connector readiness. Returns `undefined` for connectors with
 * no cheap synchronous secret signal (OAuth/provider-backed), so callers can
 * distinguish "definitively not configured" from "no cheap signal available".
 */
export function secretConnectorReadiness(connectorKey: string): ConnectorReadiness | undefined {
  const fromContribution = readinessFromContribution(
    integrationContributionsByConnector().get(connectorKey),
  );
  if (fromContribution !== undefined) return fromContribution;
  switch (connectorKey) {
    case "anthropic":
      return allSecrets("ANTHROPIC_API_KEY") ? "ready" : "setup-required";
    case "openai":
      return allSecrets("OPENAI_API_KEY") ? "ready" : "setup-required";
    case "elevenlabs":
      return allSecrets("ELEVENLABS_API_KEY") ? "ready" : "setup-required";
    case "cartesia":
      return allSecrets("CARTESIA_API_KEY", "CARTESIA_VOICE_ID") ? "ready" : "setup-required";
    case "twilio":
      return allSecrets("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER")
        ? "ready"
        : "setup-required";
    case "deepgram":
      return allSecrets("DEEPGRAM_API_KEY") ? "ready" : "setup-required";
    case "claude-cli":
      return allSecrets("CLAUDE_CODE_OAUTH_TOKEN") ? "ready" : "setup-required";
    case "brave":
      return anySecret("BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY") ? "ready" : "setup-required";
    case "plaid":
      return allSecrets("PLAID_CLIENT_ID") ? "ready" : "setup-required";
    case "sendgrid":
      return allSecrets("SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL") ? "ready" : "setup-required";
    case "sentry":
      // One DSN (SENTRY_DSN or mobile build alias) + API credentials arms every surface.
      return (anySecret("SENTRY_DSN", "EXPO_PUBLIC_SENTRY_DSN") &&
        allSecrets("SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"))
        ? "ready"
        : "setup-required";
    case "expo":
      return allSecrets("EXPO_ACCESS_TOKEN") ? "ready" : "setup-required";
    case "recall":
      return allSecrets("RECALL_API_KEY", "RECALL_REGION") ? "ready" : "setup-required";
    default:
      return undefined;
  }
}

/** OAuth-account connectors: ready iff a healthy visible account of that provider exists. */
const OAUTH_ACCOUNT_PROVIDERS: Record<string, string> = {
  google: "google",
  quickbooks: "quickbooks",
};

/** Platform provider-connection connectors: ready iff an active visible connection exists. */
const PROVIDER_CONNECTION_PROVIDERS: Record<string, string> = {
  github: "github",
  railway: "railway",
  cloudflare: "cloudflare",
};

/**
 * Resolve readiness for every registered connector key. Pure given the two
 * pre-fetched principal-scoped lists plus synchronous secret presence.
 */
export function resolveConnectorReadiness(
  connectedAccounts: ReadinessConnectedAccount[],
  providerConnections: ReadinessProviderConnection[],
): Map<string, ConnectorReadiness> {
  const readiness = new Map<string, ConnectorReadiness>();

  const healthyProviders = new Set<string>();
  for (const account of connectedAccounts) {
    if (account.healthy !== false) healthyProviders.add(account.provider);
  }
  const activeConnectionProviders = new Set<string>();
  for (const conn of providerConnections) {
    if (conn.status === "active") activeConnectionProviders.add(conn.provider);
  }

  const contributions = integrationContributionsByConnector();
  for (const connectorKey of REGISTERED_CONNECTOR_KEYS) {
    const contribution = contributions.get(connectorKey);
    if (contribution?.readinessKind === "oauth-account" && contribution.oauthProvider) {
      readiness.set(
        connectorKey,
        healthyProviders.has(contribution.oauthProvider) ? "ready" : "setup-required",
      );
      continue;
    }
    if (contribution?.readinessKind === "provider-connection" && contribution.connectionProvider) {
      readiness.set(
        connectorKey,
        activeConnectionProviders.has(contribution.connectionProvider) ? "ready" : "setup-required",
      );
      continue;
    }
    const oauthProvider = OAUTH_ACCOUNT_PROVIDERS[connectorKey];
    if (oauthProvider) {
      readiness.set(connectorKey, healthyProviders.has(oauthProvider) ? "ready" : "setup-required");
      continue;
    }
    const connectionProvider = PROVIDER_CONNECTION_PROVIDERS[connectorKey];
    if (connectionProvider) {
      readiness.set(
        connectorKey,
        activeConnectionProviders.has(connectionProvider) ? "ready" : "setup-required",
      );
      continue;
    }
    const fromSecret = secretConnectorReadiness(connectorKey);
    // Connectors with no cheap synchronous signal (e.g. twitter OAuth1,
    // meta wearables, oura, automation-auth) are conservatively setup-required
    // in shadow mode rather than performing a live provider probe.
    readiness.set(connectorKey, fromSecret ?? "setup-required");
  }

  return readiness;
}
