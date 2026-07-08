import { resolve as resolvePath } from "path";
import { writeFile } from "fs/promises";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { getProviderCredential } from "./provider-credential-store";
import { environmentSourceBindings, platformProductEnvironments, platformProducts, platforms, providerConnections } from "@shared/models/platforms";

const log = createLogger("GitSourceResolver");

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface ResolvedGitSource {
  environmentId: number;
  platformId: number;
  platformName: string;
  productId: number;
  productName: string;
  environmentName: string;
  sourceBindingId: number;
  provider: "github";
  connectionId: number;
  connectionLabel: string;
  owner: string;
  repo: string;
  branch: string;
  repoUrl: string;
  codeIndexingEnabled: boolean;
  token: string;
}

export function parseGitHubRepoUrl(repoUrl?: string): GitHubRepoRef | null {
  if (!repoUrl) return null;
  try {
    const parsed = new URL(repoUrl);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
    const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export async function createGitAskpassEnv(token: string): Promise<Record<string, string>> {
  const askpassId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const askpass = resolvePath(`/tmp/.git-askpass-${askpassId}.sh`);
  await writeFile(askpass, `#!/bin/sh\necho "${token.replace(/"/g, "\\\"")}"\n`, { mode: 0o700 });
  return { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
}

interface ResolveOptions {
  platformEnvironmentId?: number | null;
  connectionId?: number | null;
  repoUrl?: string | null;
  branch?: string | null;
  matchBranch?: boolean;
  requireIndexingEnabled?: boolean;
}

export async function resolveGitSource(options: ResolveOptions = {}): Promise<ResolvedGitSource | null> {
  const repoRef = parseGitHubRepoUrl(options.repoUrl || undefined);

  const baseQuery = db
    .select({
      environmentId: environmentSourceBindings.environmentId,
      platformId: platforms.id,
      platformName: platforms.name,
      productId: platformProducts.id,
      productName: platformProducts.name,
      environmentName: platformProductEnvironments.name,
      sourceBindingId: environmentSourceBindings.id,
      provider: environmentSourceBindings.provider,
      connectionId: environmentSourceBindings.connectionId,
      connectionLabel: providerConnections.label,
      connectionStatus: providerConnections.status,
      owner: environmentSourceBindings.owner,
      repo: environmentSourceBindings.repo,
      branch: environmentSourceBindings.branch,
      codeIndexingEnabled: environmentSourceBindings.codeIndexingEnabled,
    })
    .from(environmentSourceBindings)
    .innerJoin(platformProductEnvironments, eq(platformProductEnvironments.id, environmentSourceBindings.environmentId))
    .innerJoin(platformProducts, eq(platformProducts.id, platformProductEnvironments.productId))
    .innerJoin(platforms, eq(platforms.id, platformProducts.platformId))
    .leftJoin(providerConnections, eq(providerConnections.id, environmentSourceBindings.connectionId));

  const rows = options.platformEnvironmentId
    ? await baseQuery.where(eq(environmentSourceBindings.environmentId, options.platformEnvironmentId))
    : await baseQuery;

  const matches = rows.filter((row) => {
    if (row.provider !== "github") return false;
    if (!row.connectionId) return false;
    if (row.connectionStatus && row.connectionStatus !== "active") return false;
    if (options.connectionId && row.connectionId !== options.connectionId) return false;
    if (options.requireIndexingEnabled && !row.codeIndexingEnabled) return false;
    if (repoRef) {
      if (row.owner.toLowerCase() !== repoRef.owner.toLowerCase()) return false;
      if (row.repo.toLowerCase() !== repoRef.repo.toLowerCase()) return false;
    }
    if (options.matchBranch !== false && options.branch && row.branch && row.branch !== options.branch) return false;
    return Boolean(row.owner && row.repo);
  });

  if (matches.length === 0) return null;
  if (!options.platformEnvironmentId && !options.connectionId && !repoRef && matches.length > 1) {
    log.warn("ambiguous Git source resolution; pass platformEnvironmentId", {
      candidates: matches.map((row) => ({ environmentId: row.environmentId, owner: row.owner, repo: row.repo, branch: row.branch, codeIndexingEnabled: row.codeIndexingEnabled })),
    });
  }

  const selected = matches[0];
  if (!selected.connectionId) return null;
  const token = await getProviderCredential(selected.connectionId);
  if (!token) {
    log.warn("provider credential missing for Git source", { environmentId: selected.environmentId, connectionId: selected.connectionId });
    return null;
  }

  return {
    environmentId: selected.environmentId,
    platformId: selected.platformId,
    platformName: selected.platformName,
    productId: selected.productId,
    productName: selected.productName,
    environmentName: selected.environmentName,
    sourceBindingId: selected.sourceBindingId,
    provider: "github",
    connectionId: selected.connectionId,
    connectionLabel: selected.connectionLabel || `Connection ${selected.connectionId}`,
    owner: selected.owner,
    repo: selected.repo,
    branch: selected.branch || "main",
    repoUrl: `https://github.com/${selected.owner}/${selected.repo}.git`,
    codeIndexingEnabled: selected.codeIndexingEnabled,
    token,
  };
}

export async function resolveDefaultIndexedGitSource(): Promise<ResolvedGitSource | null> {
  const envValue = process.env.GITNEXUS_PLATFORM_ENVIRONMENT_ID;
  const explicitFromEnv = Number.isFinite(Number(envValue)) ? Number(envValue) : null;
  if (explicitFromEnv) {
    return resolveGitSource({ platformEnvironmentId: explicitFromEnv, requireIndexingEnabled: true });
  }

  try {
    const { getSetting } = await import("./system-settings");
    const settingValue = await getSetting<number | string | null>("system.gitnexus_platform_environment_id");
    const explicitFromSetting = Number.isFinite(Number(settingValue)) ? Number(settingValue) : null;
    if (explicitFromSetting) {
      return resolveGitSource({ platformEnvironmentId: explicitFromSetting, requireIndexingEnabled: true });
    }
  } catch (err) {
    log.debug("GitNexus default environment setting lookup failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return resolveGitSource({ requireIndexingEnabled: true });
}
