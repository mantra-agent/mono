import { db } from "./db";
import { sql } from "drizzle-orm";
import { encrypt, decrypt, isEncryptedEnvelope, getEncryptionKey, getPreviousEncryptionKey } from "./encryption";
import { createLogger } from "./log";

const log = createLogger("GitHubCredentials");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubCredentialRow {
  id: number;
  label: string;
  githubLogin: string | null;
  envelope: unknown;
  last4: string;
  urlPatterns: string[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitHubCredentialPublic {
  id: number;
  label: string;
  githubLogin: string | null;
  last4: string;
  urlPatterns: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CachedCredential {
  id: number;
  label: string;
  githubLogin: string | null;
  token: string;
  last4: string;
  urlPatterns: string[];
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let credentialCache: CachedCredential[] | null = null;

function invalidateCache(): void {
  credentialCache = null;
}

async function decryptToken(envelope: unknown): Promise<string | null> {
  if (!isEncryptedEnvelope(envelope)) return null;
  try {
    return await decrypt(envelope, getEncryptionKey());
  } catch {
    const prev = getPreviousEncryptionKey();
    if (prev) {
      try {
        return await decrypt(envelope, prev);
      } catch {}
    }
    return null;
  }
}

async function loadCache(): Promise<CachedCredential[]> {
  if (credentialCache) return credentialCache;

  const rows = await db.execute(sql`
    SELECT id, label, github_login, envelope, last4, url_patterns, is_default, created_at, updated_at
    FROM github_credentials
    ORDER BY is_default DESC, created_at ASC
  `);

  const result: CachedCredential[] = [];
  for (const row of rows.rows) {
    const token = await decryptToken(row.envelope);
    if (!token) {
      log.warn(`Credential id=${row.id} has undecryptable token, skipping`);
      continue;
    }
    result.push({
      id: row.id as number,
      label: row.label as string,
      githubLogin: (row.github_login as string) || null,
      token,
      last4: row.last4 as string,
      urlPatterns: (row.url_patterns as string[]) || [],
      isDefault: row.is_default as boolean,
    });
  }

  credentialCache = result;
  return result;
}

// ---------------------------------------------------------------------------
// Table migration
// ---------------------------------------------------------------------------

export async function ensureGithubCredentialsTable(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS github_credentials (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        github_login TEXT,
        envelope JSONB NOT NULL,
        last4 TEXT NOT NULL DEFAULT '',
        url_patterns TEXT[] NOT NULL DEFAULT '{}',
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err: any) {
    log.error(`Failed to create github_credentials table: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// GitHub API validation
// ---------------------------------------------------------------------------

export async function validateGitHubPAT(token: string): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) {
      const user = (await res.json()) as { login?: string };
      return { ok: true, login: user?.login || "unknown" };
    }
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = `: ${body.message}`;
    } catch {}
    return { ok: false, error: `GitHub /user returned HTTP ${res.status}${detail}` };
  } catch (err: any) {
    return { ok: false, error: `Could not reach GitHub: ${err?.message || String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeLast4(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? value : value.slice(-4);
}

function toPgArrayLiteral(arr: string[]): string {
 return '{' + arr.map(s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listCredentials(): Promise<GitHubCredentialPublic[]> {
  const rows = await db.execute(sql`
    SELECT id, label, github_login, last4, url_patterns, is_default, created_at, updated_at
    FROM github_credentials
    ORDER BY is_default DESC, created_at ASC
  `);

  return rows.rows.map((r: any) => ({
    id: r.id,
    label: r.label,
    githubLogin: r.github_login || null,
    last4: r.last4,
    urlPatterns: r.url_patterns || [],
    isDefault: r.is_default,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));
}

export async function getCredential(id: number): Promise<GitHubCredentialPublic | null> {
  const rows = await db.execute(sql`
    SELECT id, label, github_login, last4, url_patterns, is_default, created_at, updated_at
    FROM github_credentials WHERE id = ${id}
  `);
  if (rows.rows.length === 0) return null;
  const r: any = rows.rows[0];
  return {
    id: r.id,
    label: r.label,
    githubLogin: r.github_login || null,
    last4: r.last4,
    urlPatterns: r.url_patterns || [],
    isDefault: r.is_default,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function addCredential(
  token: string,
  label: string,
  urlPatterns: string[],
  isDefault: boolean,
  githubLogin?: string | null,
): Promise<GitHubCredentialPublic> {
  const envelope = await encrypt(token, getEncryptionKey());
  const last4 = computeLast4(token);

  // If setting as default, unset others first
  if (isDefault) {
    await db.execute(sql`UPDATE github_credentials SET is_default = false WHERE is_default = true`);
  }

  const rows = await db.execute(sql`
    INSERT INTO github_credentials (label, github_login, envelope, last4, url_patterns, is_default)
    VALUES (${label}, ${githubLogin || null}, ${JSON.stringify(envelope)}::jsonb, ${last4}, ${toPgArrayLiteral(urlPatterns)}::text[], ${isDefault})
    RETURNING id, label, github_login, last4, url_patterns, is_default, created_at, updated_at
  `);

  invalidateCache();
  const r: any = rows.rows[0];
  log.log(`Added credential id=${r.id} label="${label}" login=${githubLogin || "?"} default=${isDefault}`);

  return {
    id: r.id,
    label: r.label,
    githubLogin: r.github_login || null,
    last4: r.last4,
    urlPatterns: r.url_patterns || [],
    isDefault: r.is_default,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function updateCredential(
  id: number,
  updates: { label?: string; urlPatterns?: string[]; isDefault?: boolean; token?: string },
): Promise<GitHubCredentialPublic | null> {
  // If setting as default, unset others first
  if (updates.isDefault) {
    await db.execute(sql`UPDATE github_credentials SET is_default = false WHERE is_default = true`);
  }

  // Handle token update separately (needs encryption)
  if (updates.token) {
    const envelope = await encrypt(updates.token, getEncryptionKey());
    const last4 = computeLast4(updates.token);
    await db.execute(sql`
      UPDATE github_credentials
      SET envelope = ${JSON.stringify(envelope)}::jsonb, last4 = ${last4}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `);
  }

  // Handle label update
  if (updates.label !== undefined) {
    await db.execute(sql`
      UPDATE github_credentials SET label = ${updates.label}, updated_at = CURRENT_TIMESTAMP WHERE id = ${id}
    `);
  }

  // Handle URL patterns update
  if (updates.urlPatterns !== undefined) {
    await db.execute(sql`
      UPDATE github_credentials SET url_patterns = ${toPgArrayLiteral(updates.urlPatterns)}::text[], updated_at = CURRENT_TIMESTAMP WHERE id = ${id}
    `);
  }

  // Handle isDefault update
  if (updates.isDefault !== undefined) {
    await db.execute(sql`
      UPDATE github_credentials SET is_default = ${updates.isDefault}, updated_at = CURRENT_TIMESTAMP WHERE id = ${id}
    `);
  }

  invalidateCache();
  log.log(`Updated credential id=${id} fields=[${Object.keys(updates).join(",")}]`);
  return getCredential(id);
}

export async function removeCredential(id: number): Promise<boolean> {
  // Check count first — prevent deleting the last credential
  const countResult = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM github_credentials`);
  const count = (countResult.rows[0] as any)?.cnt || 0;
  if (count <= 1) {
    throw new Error("Cannot delete the last remaining GitHub credential");
  }

  const result = await db.execute(sql`DELETE FROM github_credentials WHERE id = ${id}`);
  const deleted = (result.rowCount ?? 0) > 0;

  if (deleted) {
    // If we deleted the default, promote the oldest remaining
    const defaultCheck = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM github_credentials WHERE is_default = true`);
    if (((defaultCheck.rows[0] as any)?.cnt || 0) === 0) {
      await db.execute(sql`
        UPDATE github_credentials SET is_default = true
        WHERE id = (SELECT id FROM github_credentials ORDER BY created_at ASC LIMIT 1)
      `);
    }
    invalidateCache();
    log.log(`Removed credential id=${id}`);
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// URL-based credential resolution
// ---------------------------------------------------------------------------

function matchUrlPattern(repoUrl: string, pattern: string): boolean {
  // Pattern format: github.com/owner/* or github.com/owner/repo
  // Simple glob: convert * to regex .*
  try {
    const normalizedUrl = repoUrl.replace(/\.git$/, "").replace(/^https?:\/\//, "");
    const normalizedPattern = pattern.replace(/^https?:\/\//, "");
    const regexStr = "^" + normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
    return new RegExp(regexStr, "i").test(normalizedUrl);
  } catch {
    return false;
  }
}

export async function getTokenForUrl(repoUrl: string): Promise<string> {
  const creds = await loadCache();
  if (creds.length === 0) {
    throw new Error("No GitHub credentials configured — add one in Integrations → GitHub");
  }

  // Try URL pattern matching (most specific first = longest pattern)
  const matches = creds
    .filter((c) => c.urlPatterns.some((p) => matchUrlPattern(repoUrl, p)))
    .sort((a, b) => {
      const aMax = Math.max(...a.urlPatterns.map((p) => p.length));
      const bMax = Math.max(...b.urlPatterns.map((p) => p.length));
      return bMax - aMax; // longest pattern first
    });

  if (matches.length > 0) {
    return matches[0].token;
  }

  // Fallback to default
  const defaultCred = creds.find((c) => c.isDefault);
  if (defaultCred) return defaultCred.token;

  throw new Error("No matching GitHub credential for URL and no default credential set");
}

export async function getDefaultToken(): Promise<string> {
  const creds = await loadCache();
  const defaultCred = creds.find((c) => c.isDefault);
  if (defaultCred) return defaultCred.token;

  // Fallback: return any credential if only one exists
  if (creds.length === 1) return creds[0].token;
  if (creds.length === 0) {
    throw new Error("No GitHub credentials configured — add one in Integrations → GitHub");
  }

  throw new Error("Multiple GitHub credentials exist but none is marked as default");
}

export async function credentialCount(): Promise<number> {
  const result = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM github_credentials`);
  return (result.rows[0] as any)?.cnt || 0;
}
