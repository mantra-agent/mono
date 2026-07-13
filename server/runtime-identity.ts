/**
 * Runtime Identity — single source of truth for "which deployment am I?"
 *
 * Railway injects the provider coordinates for the running deployment. The
 * Platforms registry owns their canonical Platform Environment meaning,
 * including the canonical public base URL from the environment's hosting
 * binding. Resolution is asynchronous so boot can enrich identity from
 * PostgreSQL, while local development still receives a useful
 * environment-only identity.
 *
 * Public base URL priority (canonical → fallback):
 *   1. Hosting binding publicUrl for the resolved Platform Environment
 *   2. Railway-injected serving host (RAILWAY_PUBLIC_DOMAIN)
 *   3. PUBLIC_URL env variable (local-dev / explicit override fallback only)
 */
import { createLogger } from "./log";

const log = createLogger("runtime-identity");

export interface RuntimeIdentity {
  environmentName: string;
  serviceName: string | null;
  servingHost: string | null;
  /** Canonical public base URL: binding publicUrl → serving host → PUBLIC_URL env fallback. */
  publicUrl: string | null;
  /** Where the canonical publicUrl came from. */
  publicUrlSource: "hosting_binding" | "serving_host" | "env" | null;
  /** Raw PUBLIC_URL env variable, kept only as a stale-configuration diagnostic. */
  envPublicUrl: string | null;
  /** True when the PUBLIC_URL env variable disagrees with the canonical public URL. */
  publicUrlMismatch: boolean;
  gitCommit: string | null;
  dbHost: string | null;
  platformEnvironmentId: number | null;
  platformEnvironmentName: string | null;
  resolvedAt: string;
}

let cached: RuntimeIdentity | null = null;
let inFlight: Promise<RuntimeIdentity> | null = null;

function normalizeUrl(value: string | null | undefined): string | null {
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
  const envPublicUrl = normalizeUrl(process.env.PUBLIC_URL);
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;

  let dbHost: string | null = null;
  try {
    dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null;
  } catch {
    dbHost = null;
  }

  // Pre-enrichment defaults: serving host, then env fallback. The Platform
  // Environment hosting binding overrides this during resolveRuntimeIdentity.
  let publicUrl: string | null = null;
  let publicUrlSource: RuntimeIdentity["publicUrlSource"] = null;
  if (servingHost) {
    publicUrl = `https://${servingHost}`;
    publicUrlSource = "serving_host";
  } else if (envPublicUrl) {
    publicUrl = envPublicUrl;
    publicUrlSource = "env";
  }

  return {
    environmentName,
    serviceName,
    servingHost,
    publicUrl,
    publicUrlSource,
    envPublicUrl,
    publicUrlMismatch: computeEnvMismatch(envPublicUrl, publicUrl),
    gitCommit,
    dbHost,
    platformEnvironmentId: null,
    platformEnvironmentName: null,
    resolvedAt: new Date().toISOString(),
  };
}

function computeEnvMismatch(envPublicUrl: string | null, canonicalUrl: string | null): boolean {
  const envHost = hostOf(envPublicUrl);
  const canonicalHost = hostOf(canonicalUrl);
  return Boolean(envHost && canonicalHost && envHost !== canonicalHost);
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
        const bindingPublicUrl = normalizeUrl(environment.providerConfiguration.publicUrl);
        if (bindingPublicUrl) {
          identity.publicUrl = bindingPublicUrl;
          identity.publicUrlSource = "hosting_binding";
        }
      } else if (process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_SERVICE_ID) {
        log.warn("Running Railway deployment has no matching Platform Environment hosting binding");
      }
    } catch (error) {
      log.warn(
        `Platform Environment identity resolution failed; continuing with provider identity: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    identity.publicUrlMismatch = computeEnvMismatch(identity.envPublicUrl, identity.publicUrl);
    cached = identity;
    if (identity.publicUrlMismatch) {
      log.warn(
        `Stale PUBLIC_URL env variable: PUBLIC_URL=${identity.envPublicUrl} but canonical public URL is ` +
          `${identity.publicUrl} (source: ${identity.publicUrlSource}). The env variable is ignored; ` +
          `remove or correct it on the Railway service for environment "${identity.environmentName}".`,
      );
    }
    log.info(describeRuntimeIdentity(identity));
    return identity;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export async function getRuntimeIdentity(): Promise<RuntimeIdentity> {
  return cached ?? resolveRuntimeIdentity();
}

/** Canonical public base URL for this deployment (no trailing slash). */
export async function getRuntimePublicBaseUrl(): Promise<string | null> {
  const id = await getRuntimeIdentity();
  return id.publicUrl;
}

/**
 * Synchronous accessor for callers that cannot await (e.g. legacy sync
 * utility chains). Returns the canonical public base URL once boot
 * resolution has completed, otherwise the pre-enrichment best guess.
 */
export function getRuntimePublicBaseUrlSync(): string | null {
  if (cached) return cached.publicUrl;
  return readBaseIdentity().publicUrl;
}

export function describeRuntimeIdentity(id: RuntimeIdentity): string {
  const parts = [
    `env=${id.environmentName}`,
    id.platformEnvironmentId ? `platformEnvironment=${id.platformEnvironmentName}#${id.platformEnvironmentId}` : null,
    id.serviceName ? `service=${id.serviceName}` : null,
    id.servingHost ? `host=${id.servingHost}` : null,
    id.publicUrl ? `publicUrl=${id.publicUrl} (${id.publicUrlSource})` : null,
    id.gitCommit ? `commit=${id.gitCommit.slice(0, 8)}` : null,
    id.dbHost ? `db=${id.dbHost}` : null,
    id.publicUrlMismatch ? `⚠ stale PUBLIC_URL env (${id.envPublicUrl})` : null,
  ].filter(Boolean);
  return `runtime identity: ${parts.join(" · ")}`;
}
