import { resolve as resolvePath, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "./log";

function getDir(): string {
  try {
    if (typeof import.meta?.url === "string") {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {}
  return resolvePath(process.cwd(), "server");
}
const __dirname = getDir();

const log = createLogger("GitHubAuth");

const TOKEN_NOT_SET_MESSAGE = "No GitHub credentials configured — add one in Integrations → GitHub";

// ---------------------------------------------------------------------------
// Migration: move legacy GITHUB_TOKEN from app_secrets → github_credentials
// Called once at server boot after both tables are initialized.
// ---------------------------------------------------------------------------

export async function migrateGitHubToken(): Promise<void> {
  try {
    const { ensureGithubCredentialsTable, credentialCount, addCredential, validateGitHubPAT } =
      await import("./github-credentials");

    await ensureGithubCredentialsTable();

    // If credentials already exist, migration is done
    const count = await credentialCount();
    if (count > 0) return;

    // Check for legacy token in app_secrets
    const { getSecretSync } = await import("./secrets-store");
    const legacyToken = getSecretSync("GITHUB_TOKEN");
    if (!legacyToken) {
      // Also check env var fallback
      const envToken = process.env.GITHUB_TOKEN;
      if (envToken && envToken.length > 0) {
        log.log("Migrating GITHUB_TOKEN from environment variable");
        let login: string | null = null;
        const validation = await validateGitHubPAT(envToken);
        if (validation.ok) login = validation.login;
        const urlPattern = login ? `github.com/${login}/*` : "github.com/*";
        await addCredential(envToken, login || "Default", [urlPattern], true, login);
        log.log(`Migration complete: created credential from env var (login=${login || "unknown"})`);
      }
      return;
    }

    // Validate and discover login
    let login: string | null = null;
    const validation = await validateGitHubPAT(legacyToken);
    if (validation.ok) {
      login = validation.login;
    } else {
      log.warn(`Legacy GITHUB_TOKEN validation failed during migration: ${validation.error}`);
    }

    // Create credential from legacy token
    const urlPattern = login ? `github.com/${login}/*` : "github.com/*";
    await addCredential(legacyToken, login || "Default", [urlPattern], true, login);

    // Clear legacy token from app_secrets
    try {
      const { clearSecret } = await import("./secrets-store");
      await clearSecret("GITHUB_TOKEN", "migration");
      log.log(`Migration complete: moved GITHUB_TOKEN to github_credentials (login=${login || "unknown"})`);
    } catch (err: any) {
      log.warn(`Migration: failed to clear legacy GITHUB_TOKEN from app_secrets: ${err?.message}`);
    }
  } catch (err: any) {
    log.error(`GitHub credential migration failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Public API (backward-compatible)
// ---------------------------------------------------------------------------

/**
 * Returns the default credential's token.
 * Falls back to GITHUB_TOKEN env var if DB lookup fails (resilience under pool pressure).
 */
export async function getGitHubAccessToken(): Promise<string> {
  try {
    const { getDefaultToken } = await import("./github-credentials");
    return await getDefaultToken();
  } catch (err: any) {
    const envToken = process.env.GITHUB_TOKEN;
    if (envToken && envToken.length > 0) {
      log.warn(`getDefaultToken failed (${err?.message}), falling back to GITHUB_TOKEN env var`);
      return envToken;
    }
    throw err;
  }
}

/**
 * Returns the correct token for a given repo URL using pattern matching.
 * Falls back to default if no pattern matches, then to env var if DB fails.
 */
export async function getGitHubTokenForUrl(url: string): Promise<string> {
  try {
    const { getTokenForUrl } = await import("./github-credentials");
    return await getTokenForUrl(url);
  } catch (err: any) {
    const envToken = process.env.GITHUB_TOKEN;
    if (envToken && envToken.length > 0) {
      log.warn(`getTokenForUrl failed (${err?.message}), falling back to GITHUB_TOKEN env var`);
      return envToken;
    }
    throw err;
  }
}

export async function getAuthenticatedGitUrl(httpsUrl: string): Promise<string> {
  const token = await getGitHubAccessToken();
  const parsed = new URL(httpsUrl.replace(/\.git$/, "") + ".git");
  return `https://x-access-token:${token}@${parsed.host}${parsed.pathname}`;
}

export function getGitCredentialEnv(token: string): Record<string, string> {
  return {
    GIT_ASKPASS: resolvePath(__dirname, "../scripts/git-askpass.sh"),
    GIT_USERNAME: "x-access-token",
    GIT_PASSWORD: token,
  };
}

export function isGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === "github.com" || parsed.host === "www.github.com";
  } catch {
    return url.includes("github.com");
  }
}
