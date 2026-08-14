import { getSecret, getSecretSync } from "../../secrets-store";

/**
 * Canonical Sentry readiness for API + crash capture.
 *
 * One secrets fill arms every surface:
 * - SENTRY_DSN or EXPO_PUBLIC_SENTRY_DSN (client-safe, shared web/mobile/server)
 * - SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT (API + tooling)
 */
export interface SentryFullConfig {
  dsn: string | null;
  hasToken: boolean;
  org: string | null;
  project: string | null;
}

export function resolveSentryDsnSync(): string | null {
  const dsn =
    getSecretSync("SENTRY_DSN")?.trim() ||
    getSecretSync("EXPO_PUBLIC_SENTRY_DSN")?.trim() ||
    "";
  return dsn.length > 0 ? dsn : null;
}

export async function resolveSentryDsn(): Promise<string | null> {
  const primary = (await getSecret("SENTRY_DSN"))?.trim();
  if (primary) return primary;
  const legacy = (await getSecret("EXPO_PUBLIC_SENTRY_DSN"))?.trim();
  return legacy || null;
}

export async function getSentryFullConfig(): Promise<SentryFullConfig> {
  const [dsn, token, org, project] = await Promise.all([
    resolveSentryDsn(),
    getSecret("SENTRY_AUTH_TOKEN"),
    getSecret("SENTRY_ORG"),
    getSecret("SENTRY_PROJECT"),
  ]);
  return {
    dsn,
    hasToken: !!(token && token.length > 0),
    org: org || null,
    project: project || null,
  };
}

export function getSentryFullConfigSync(): SentryFullConfig {
  return {
    dsn: resolveSentryDsnSync(),
    hasToken: !!getSecretSync("SENTRY_AUTH_TOKEN")?.trim(),
    org: getSecretSync("SENTRY_ORG")?.trim() || null,
    project: getSecretSync("SENTRY_PROJECT")?.trim() || null,
  };
}

export function sentryMissingSecrets(cfg: SentryFullConfig): string[] {
  const missing: string[] = [];
  if (!cfg.dsn) missing.push("SENTRY_DSN");
  if (!cfg.hasToken) missing.push("SENTRY_AUTH_TOKEN");
  if (!cfg.org) missing.push("SENTRY_ORG");
  if (!cfg.project) missing.push("SENTRY_PROJECT");
  return missing;
}

export function isSentryFullyConfigured(
  cfg: SentryFullConfig,
): cfg is SentryFullConfig & {
  dsn: string;
  hasToken: true;
  org: string;
  project: string;
} {
  return !!cfg.dsn && cfg.hasToken && !!cfg.org && !!cfg.project;
}
