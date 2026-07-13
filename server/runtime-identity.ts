/**
 * Runtime Identity — single source of truth for "which deployment am I?"
 *
 * Railway injects the provider coordinates for the running deployment. The
 * Platforms registry owns their canonical Platform Environment meaning.
 * Resolution is asynchronous so boot can enrich identity from PostgreSQL,
 * while local development still receives a useful environment-only identity.
 */
import { createLogger } from "./log";

const log = createLogger("runtime-identity");

export interface RuntimeIdentity {
  environmentName: string;
  serviceName: string | null;
  servingHost: string | null;
  publicUrl: string | null;
  publicUrlMismatch: boolean;
  gitCommit: string | null;
  dbHost: string | null;
  platformEnvironmentId: number | null;
  platformEnvironmentName: string | null;
  resolvedAt: string;
}

let cached: RuntimeIdentity | null = null;
let inFlight: Promise<RuntimeIdentity> | null = null;

function normalizeUrl(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function readBaseIdentity(): RuntimeIdentity {
  const environmentName = process.env.RAILWAY_ENVIRONMENT_NAME?.trim() || "local";
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || null;
  const servingHost = process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || null;
  const publicUrl = normalizeUrl(process.env.PUBLIC_URL);
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;

  let dbHost: string | null = null;
  try {
    dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null;
  } catch {
    dbHost = null;
  }

  const publicUrlHost = hostOf(publicUrl);
  return {
    environmentName,
    serviceName,
    servingHost,
    publicUrl,
    publicUrlMismatch: Boolean(publicUrlHost && servingHost && publicUrlHost !== servingHost),
    gitCommit,
    dbHost,
    platformEnvironmentId: null,
    platformEnvironmentName: null,
    resolvedAt: new Date().toISOString(),
  };
}

export async function resolveRuntimeIdentity(): Promise<RuntimeIdentity> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const identity = readBaseIdentity();
    try {
      const { resolveRunningPlatformEnvironment } = await import("./platform-environment-resolver");
      const environment = await resolveRunningPlatformEnvironment();
      if (environment) {
        identity.platformEnvironmentId = environment.platformEnvironmentId;
        identity.platformEnvironmentName = environment.platformEnvironmentName;
      } else if (process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_SERVICE_ID) {
        log.warn("Running Railway deployment has no matching Platform Environment hosting binding");
      }
    } catch (error) {
      log.warn(
        `Platform Environment identity resolution failed; continuing with provider identity: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    cached = identity;
    if (identity.publicUrlMismatch) {
      log.error(
        `PUBLIC_URL mismatch: PUBLIC_URL=${identity.publicUrl} but this deployment serves ${identity.servingHost}. ` +
          `External callbacks derived from PUBLIC_URL would route to the wrong deployment. ` +
          `getRuntimePublicBaseUrl() will prefer https://${identity.servingHost}. ` +
          `Fix the PUBLIC_URL Railway variable for environment "${identity.environmentName}".`,
      );
    } else {
      log.info(describeRuntimeIdentity(identity));
    }
    return identity;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export async function getRuntimeIdentity(): Promise<RuntimeIdentity> {
  return cached ?? resolveRuntimeIdentity();
}

export async function getRuntimePublicBaseUrl(): Promise<string | null> {
  const id = await getRuntimeIdentity();
  if (id.publicUrlMismatch && id.servingHost) {
    log.warn(`using serving host https://${id.servingHost} instead of mismatched PUBLIC_URL=${id.publicUrl}`);
    return `https://${id.servingHost}`;
  }
  if (id.publicUrl) return id.publicUrl;
  if (id.servingHost) return `https://${id.servingHost}`;
  return null;
}

export function describeRuntimeIdentity(id: RuntimeIdentity): string {
  const parts = [
    `env=${id.environmentName}`,
    id.platformEnvironmentId ? `platformEnvironment=${id.platformEnvironmentName}#${id.platformEnvironmentId}` : null,
    id.serviceName ? `service=${id.serviceName}` : null,
    id.servingHost ? `host=${id.servingHost}` : null,
    id.gitCommit ? `commit=${id.gitCommit.slice(0, 8)}` : null,
    id.dbHost ? `db=${id.dbHost}` : null,
    id.publicUrlMismatch ? `⚠ PUBLIC_URL mismatch (${id.publicUrl})` : null,
  ].filter(Boolean);
  return `runtime identity: ${parts.join(" · ")}`;
}
