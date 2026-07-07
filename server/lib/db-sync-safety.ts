// Typed-phrase confirmation required when the destination of a publish is
// the production Railway environment. The dev destination needs no typed
// phrase — dev is the disposable side.
export const PROD_DESTINATION_CONFIRMATION = "PUBLISH TO PRODUCTION";

const DB_URL_KEYS = ["DATABASE_URL", "POSTGRES_URL", "DATABASE_PRIVATE_URL", "POSTGRES_PRIVATE_URL"] as const;

export interface DbFingerprint {
  host: string;
  port: string;
  database: string;
  user: string;
}

export function redactDbUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "***";
    if (url.username) url.username = url.username ? "***" : "";
    return url.toString();
  } catch {
    return "<invalid database url>";
  }
}

export function fingerprintDbUrl(raw: string): DbFingerprint {
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "") || "postgres";
  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
    user: decodeURIComponent(url.username || ""),
  };
}

export function sameDbFingerprint(a: DbFingerprint, b: DbFingerprint): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database && a.user === b.user;
}

export function resolveDbUrl(vars: Record<string, string>): { key: string; url: string } | null {
  for (const key of DB_URL_KEYS) {
    const value = vars[key];
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") return { key, url: value };
    } catch {
      // Try the next candidate. Invalid values are blockers only if all candidates fail.
    }
  }
  return null;
}
