import { db } from "./db";
import { appSecrets } from "@shared/schema";
import { eq, notInArray, sql } from "drizzle-orm";
import {
  encrypt,
  decrypt,
  isEncryptedEnvelope,
  getEncryptionKey,
  getPreviousEncryptionKey,
} from "./encryption";
import { createLogger } from "./log";
import {
  SECRET_CATALOG,
  SECRET_NAMES,
  isKnownSecretName,
  type SecretMetadata,
} from "@shared/secrets-catalog";

const log = createLogger("Secrets");

interface CacheEntry {
  value: string;
  last4: string;
  updatedAt: Date;
  updatedBy: string | null;
}

const cache = new Map<string, CacheEntry>();
const invalidNames = new Set<string>();
let loaded = false;

function computeLast4(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? value : value.slice(-4);
}

async function decryptEnvelope(envelope: unknown): Promise<string | null> {
  if (!isEncryptedEnvelope(envelope)) return null;
  try {
    return await decrypt(envelope, getEncryptionKey());
  } catch {
    const prev = getPreviousEncryptionKey();
    if (prev) {
      try { return await decrypt(envelope, prev); } catch {}
    }
    log.error("Failed to decrypt secret envelope");
    return null;
  }
}

async function ensureTable(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_secrets (
        name text PRIMARY KEY,
        envelope jsonb NOT NULL,
        last4 text NOT NULL DEFAULT '',
        updated_at timestamp NOT NULL DEFAULT now(),
        updated_by text
      )
    `);
  } catch (err: any) {
    log.error(`Failed to ensure app_secrets table: ${err?.message || err}`);
  }
}

// Delete any rows in app_secrets whose name is no longer in the catalog.
// Runs on every startup; cheap, idempotent, and self-cleaning when secrets
// are retired in shared/secrets-catalog.ts.
async function pruneOrphanedSecrets(): Promise<void> {
  try {
    if (SECRET_NAMES.length === 0) return;
    const result = await db
      .delete(appSecrets)
      .where(notInArray(appSecrets.name, SECRET_NAMES));
    const removed = result.rowCount ?? 0;
    if (removed > 0) {
      log.log(`Pruned ${removed} orphaned secret row(s) not present in the catalog`);
    }
  } catch (err: any) {
    log.warn(`Failed to prune orphaned secrets: ${err?.message || err}`);
  }
}

export async function loadAllSecrets(): Promise<void> {
  try {
    await ensureTable();
    await pruneOrphanedSecrets();
    const rows = await db.select().from(appSecrets);
    cache.clear();
    invalidNames.clear();
    for (const row of rows) {
      const value = await decryptEnvelope(row.envelope);
      if (value === null) {
        invalidNames.add(row.name);
        continue;
      }
      cache.set(row.name, {
        value,
        last4: row.last4 || computeLast4(value),
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      });
    }
    loaded = true;
    log.log(`Loaded ${cache.size} secrets from DB`);
  } catch (err: any) {
    log.error(`Failed to load secrets: ${err?.message || err}`);
  }
}

export function getSecretSync(name: string): string | undefined {
  const entry = cache.get(name);
  if (entry) return entry.value;
  const fromEnv = process.env[name];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export async function getSecret(name: string): Promise<string | undefined> {
  if (!loaded) await loadAllSecrets();
  return getSecretSync(name);
}

export function hasSecret(name: string): boolean {
  return getSecretSync(name) !== undefined;
}

export async function setSecret(name: string, value: string, updatedBy: string | null): Promise<void> {
  if (!isKnownSecretName(name)) throw new Error(`Unknown secret name: ${name}`);
  // Trim leading/trailing whitespace — pasted tokens often arrive with a stray
  // newline or space, and providers (e.g. Railway) reject them as "Not Authorized".
  value = typeof value === "string" ? value.trim() : value;
  if (!value || value.length === 0) throw new Error("Secret value cannot be empty");
  const envelope = await encrypt(value, getEncryptionKey());
  const last4 = computeLast4(value);
  const now = new Date();
  await db
    .insert(appSecrets)
    .values({ name, envelope, last4, updatedAt: now, updatedBy })
    .onConflictDoUpdate({
      target: appSecrets.name,
      set: { envelope, last4, updatedAt: now, updatedBy },
    });
  cache.set(name, { value, last4, updatedAt: now, updatedBy });
  log.log(`Secret '${name}' set by user=${updatedBy ?? "unknown"} last4=${last4}`);
  invalidateClients(name);
}

export async function clearSecret(name: string, actor: string | null): Promise<boolean> {
  if (!isKnownSecretName(name)) throw new Error(`Unknown secret name: ${name}`);
  const result = await db.delete(appSecrets).where(eq(appSecrets.name, name));
  cache.delete(name);
  log.log(`Secret '${name}' cleared by user=${actor ?? "unknown"}`);
  invalidateClients(name);
  return (result.rowCount ?? 0) > 0;
}

export async function listSecretsMetadata(): Promise<SecretMetadata[]> {
  if (!loaded) await loadAllSecrets();
  const out: SecretMetadata[] = [];
  for (const spec of SECRET_CATALOG) {
    const cached = cache.get(spec.name);
    if (cached) {
      out.push({
        name: spec.name,
        section: spec.section,
        label: spec.label,
        description: spec.description,
        isSet: true,
        status: "set",
        source: "db",
        last4: cached.last4,
        updatedAt: cached.updatedAt.toISOString(),
        updatedBy: cached.updatedBy,
      });
    } else if (invalidNames.has(spec.name)) {
      out.push({
        name: spec.name,
        section: spec.section,
        label: spec.label,
        description: spec.description,
        isSet: false,
        status: "invalid",
        source: "db",
        last4: null,
        updatedAt: null,
        updatedBy: null,
      });
    } else {
      const envVal = process.env[spec.name];
      const fromEnv = !!(envVal && envVal.length > 0);
      out.push({
        name: spec.name,
        section: spec.section,
        label: spec.label,
        description: spec.description,
        isSet: fromEnv,
        status: fromEnv ? "set" : "not_set",
        source: fromEnv ? "env" : "none",
        last4: fromEnv ? computeLast4(envVal!) : null,
        updatedAt: null,
        updatedBy: null,
      });
    }
  }
  return out;
}

const invalidationListeners: Array<(name: string) => void> = [];

export function onSecretChange(listener: (name: string) => void): () => void {
  invalidationListeners.push(listener);
  return () => {
    const i = invalidationListeners.indexOf(listener);
    if (i >= 0) invalidationListeners.splice(i, 1);
  };
}

function invalidateClients(name: string) {
  for (const l of invalidationListeners) {
    try { l(name); } catch (err) { log.warn(`secret listener failed: ${err}`); }
  }
}

export { SECRET_NAMES };
