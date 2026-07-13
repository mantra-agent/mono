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
 * Public base URL priority:
 *   1. Hosting binding publicUrl for the resolved Platform Environment
 *   2. Railway-injected serving host (RAILWAY_PUBLIC_DOMAIN)
 */
import { createLogger } from "./log";

const log = createLogger("runtime-identity");

export interface RuntimeIdentity {
  environmentName: string;
  serviceName: string | null;
  servingHost: string | null;
  /** Canonical public base URL: hosting binding publicUrl → Railway serving host. */
  publicUrl: string | null;
  /** Where the canonical publicUrl came from. */
  publicUrlSource: "hosting_binding" | "serving_host" | null;
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

function readBaseIdentity(): RuntimeIdentity {
  const environmentName = process.env.RAILWAY_ENVIRONMENT_NAME?.trim() || "local";
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || null;
  const servingHost = process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || null;
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;

  let dbHost: string | null = null;
  try {
    dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null;
  } catch {
    dbHost = null;
  }

  // The Platform Environment hosting binding overrides the Railway serving
  // host during resolveRuntimeIdentity.
  let publicUrl: string | null = null;
  let publicUrlSource: RuntimeIdentity["publicUrlSource"] = null;
  if (servingHost) {
    publicUrl = `https://${servingHost}`;
    publicUrlSource = "serving_host";
  }

  return {
    environmentName,
    serviceName,
    servingHost,
    publicUrl,
    publicUrlSource,
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

    cached = identity;
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
  ].filter(Boolean);
  return `runtime identity: ${parts.join(" · ")}`;
}
