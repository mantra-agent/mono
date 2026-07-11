/**
 * Runtime Identity — single source of truth for "which deployment am I?"
 *
 * Resolved exactly once at boot from Railway-provided environment variables
 * plus PUBLIC_URL, then cached for the process lifetime. Every consumer that
 * needs the environment name, serving host, public base URL, git commit, or
 * DB host reads from here instead of scattering process.env lookups.
 *
 * Mismatch detection: PUBLIC_URL is a manually-set Railway variable and can
 * silently drift from the actual serving domain (RAILWAY_PUBLIC_DOMAIN),
 * which routes external callbacks (e.g. Recall.ai webhooks) to the wrong
 * deployment. When both are known and disagree, the identity flags the
 * mismatch, logs an error at boot, and getRuntimePublicBaseUrl() prefers the
 * verifiable serving domain over the configured PUBLIC_URL.
 */
import { createLogger } from "./log";

const log = createLogger("runtime-identity");

export interface RuntimeIdentity {
  /** Railway environment name, e.g. "production", "stage". "local" when not on Railway. */
  environmentName: string;
  /** Railway service name, e.g. "mono". */
  serviceName: string | null;
  /** Actual serving domain provided by Railway, e.g. "mono-prod-8d22.up.railway.app". */
  servingHost: string | null;
  /** Normalized PUBLIC_URL env var (no trailing slash), or null when unset. */
  publicUrl: string | null;
  /** True when PUBLIC_URL host and servingHost are both known and disagree. */
  publicUrlMismatch: boolean;
  /** Git commit SHA of the running build, when Railway provides it. */
  gitCommit: string | null;
  /** Hostname of the connected database (never credentials). */
  dbHost: string | null;
  /** ISO timestamp of when this identity was resolved. */
  resolvedAt: string;
}

let cached: RuntimeIdentity | null = null;

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

/**
 * Resolve the runtime identity from the environment. Called once at boot;
 * subsequent calls return the cached identity. Safe to call lazily from any
 * consumer — resolution is synchronous and idempotent.
 */
export function resolveRuntimeIdentity(): RuntimeIdentity {
  if (cached) return cached;

  const environmentName =
    process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    process.env.RAILWAY_ENVIRONMENT?.trim() ||
    "local";
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
  const publicUrlMismatch = Boolean(
    publicUrlHost && servingHost && publicUrlHost !== servingHost,
  );

  cached = {
    environmentName,
    serviceName,
    servingHost,
    publicUrl,
    publicUrlMismatch,
    gitCommit,
    dbHost,
    resolvedAt: new Date().toISOString(),
  };

  if (publicUrlMismatch) {
    log.error(
      `PUBLIC_URL mismatch: PUBLIC_URL=${publicUrl} but this deployment serves ${servingHost}. ` +
        `External callbacks derived from PUBLIC_URL would route to the wrong deployment. ` +
        `getRuntimePublicBaseUrl() will prefer https://${servingHost}. ` +
        `Fix the PUBLIC_URL Railway variable for environment "${environmentName}".`,
    );
  } else {
    log.info(describeRuntimeIdentity(cached));
  }

  return cached;
}

/** The cached runtime identity, resolving on first use. */
export function getRuntimeIdentity(): RuntimeIdentity {
  return cached ?? resolveRuntimeIdentity();
}

/**
 * The trustworthy public base URL for this deployment (no trailing slash).
 * Prefers the Railway-verified serving domain when PUBLIC_URL disagrees with
 * it, so externally-registered callbacks always point at THIS deployment.
 * Returns null when neither source is available (bare local dev).
 */
export function getRuntimePublicBaseUrl(): string | null {
  const id = getRuntimeIdentity();
  if (id.publicUrlMismatch && id.servingHost) {
    log.warn(
      `using serving host https://${id.servingHost} instead of mismatched PUBLIC_URL=${id.publicUrl}`,
    );
    return `https://${id.servingHost}`;
  }
  if (id.publicUrl) return id.publicUrl;
  if (id.servingHost) return `https://${id.servingHost}`;
  return null;
}

/** One-line human-readable identity summary for logs and agent context. */
export function describeRuntimeIdentity(id: RuntimeIdentity = getRuntimeIdentity()): string {
  const parts = [
    `env=${id.environmentName}`,
    id.serviceName ? `service=${id.serviceName}` : null,
    id.servingHost ? `host=${id.servingHost}` : null,
    id.gitCommit ? `commit=${id.gitCommit.slice(0, 8)}` : null,
    id.dbHost ? `db=${id.dbHost}` : null,
    id.publicUrlMismatch ? `⚠ PUBLIC_URL mismatch (${id.publicUrl})` : null,
  ].filter(Boolean);
  return `runtime identity: ${parts.join(" · ")}`;
}
