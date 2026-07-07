import { createHash } from "crypto";
import { db } from "./db";
import { appSecrets, connectedAccounts } from "@shared/schema";
import {
  decrypt,
  decryptJson,
  isEncryptedEnvelope,
  getEncryptionKey,
  getPreviousEncryptionKey,
} from "./encryption";

export interface EncryptionStoreCounts {
  total: number;
  current: number;
  previous: number;
  undecryptable: number;
}

export interface EncryptionStatus {
  currentKeyFingerprint: string;
  previousKeyFingerprint: string | null;
  previousKeySet: boolean;
  appSecrets: EncryptionStoreCounts & { undecryptableNames: string[] };
  connectedAccounts: EncryptionStoreCounts & { undecryptableAccountIds: string[] };
  /**
   * "healthy"  – every row decrypts with the current key
   * "warning"  – some rows only decrypt with the previous key (rotation in progress)
   * "error"    – at least one row cannot be decrypted with either key
   */
  health: "healthy" | "warning" | "error";
}

function fingerprint(key: string | null): string | null {
  if (!key) return null;
  return createHash("sha256").update(key).digest("hex").slice(0, 4);
}

async function tryDecryptString(envelope: unknown, key: string): Promise<boolean> {
  if (!isEncryptedEnvelope(envelope)) return false;
  try {
    await decrypt(envelope, key);
    return true;
  } catch {
    return false;
  }
}

async function tryDecryptJson(envelope: unknown, key: string): Promise<boolean> {
  if (!isEncryptedEnvelope(envelope)) return false;
  try {
    await decryptJson(envelope, key);
    return true;
  } catch {
    return false;
  }
}

// Postgres "undefined_table" — only safe failure mode to swallow during boot
// before schema bootstrap has run. Anything else is a real DB error and should
// propagate so callers (boot log, API) can surface it.
function isMissingTableError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "42P01";
}

export async function scanEncryptionStatus(): Promise<EncryptionStatus> {
  const currentKey = getEncryptionKey();
  const previousKey = getPreviousEncryptionKey();

  const secretsCounts = {
    total: 0, current: 0, previous: 0, undecryptable: 0,
    undecryptableNames: [] as string[],
  };
  const accountsCounts = {
    total: 0, current: 0, previous: 0, undecryptable: 0,
    undecryptableAccountIds: [] as string[],
  };

  try {
    const secretRows = await db.select().from(appSecrets);
    for (const row of secretRows) {
      secretsCounts.total++;
      if (!isEncryptedEnvelope(row.envelope)) {
        secretsCounts.undecryptable++;
        secretsCounts.undecryptableNames.push(row.name);
        continue;
      }
      if (await tryDecryptString(row.envelope, currentKey)) {
        secretsCounts.current++;
      } else if (previousKey && await tryDecryptString(row.envelope, previousKey)) {
        secretsCounts.previous++;
      } else {
        secretsCounts.undecryptable++;
        secretsCounts.undecryptableNames.push(row.name);
      }
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  try {
    const accountRows = await db.select().from(connectedAccounts);
    for (const row of accountRows) {
      if (!row.tokens) continue;
      accountsCounts.total++;
      if (!isEncryptedEnvelope(row.tokens)) {
        // Plaintext rows are re-encrypted on first read; treat as current.
        accountsCounts.current++;
        continue;
      }
      if (await tryDecryptJson(row.tokens, currentKey)) {
        accountsCounts.current++;
      } else if (previousKey && await tryDecryptJson(row.tokens, previousKey)) {
        accountsCounts.previous++;
      } else {
        accountsCounts.undecryptable++;
        accountsCounts.undecryptableAccountIds.push(row.accountId);
      }
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  const undecryptableTotal = secretsCounts.undecryptable + accountsCounts.undecryptable;
  const previousTotal = secretsCounts.previous + accountsCounts.previous;
  const health: EncryptionStatus["health"] =
    undecryptableTotal > 0 ? "error" : (previousTotal > 0 ? "warning" : "healthy");

  return {
    currentKeyFingerprint: fingerprint(currentKey) ?? "????",
    previousKeyFingerprint: fingerprint(previousKey),
    previousKeySet: !!previousKey,
    appSecrets: secretsCounts,
    connectedAccounts: accountsCounts,
    health,
  };
}

// Cached snapshot for hot paths (e.g. chat error notice) that want to ask
// "is there currently any encryption key issue?" without re-scanning every
// row on every request. The full scan is cheap but DB-bound, so a short TTL
// keeps it both fresh and effectively free.
let cachedStatus: { value: EncryptionStatus; expiresAt: number } | null = null;
const STATUS_CACHE_MS = 60_000;

export async function getCachedEncryptionStatus(): Promise<EncryptionStatus | null> {
  const now = Date.now();
  if (cachedStatus && cachedStatus.expiresAt > now) return cachedStatus.value;
  try {
    const value = await scanEncryptionStatus();
    cachedStatus = { value, expiresAt: now + STATUS_CACHE_MS };
    return value;
  } catch {
    return null;
  }
}

export function invalidateEncryptionStatusCache(): void {
  cachedStatus = null;
}

export function formatEncryptionStatusLog(status: EncryptionStatus): string {
  const a = status.appSecrets;
  const c = status.connectedAccounts;
  return (
    `encryption_status health=${status.health}` +
    ` app_secrets=${a.current}/${a.previous}/${a.undecryptable}` +
    ` (total=${a.total}) connected_accounts=${c.current}/${c.previous}/${c.undecryptable}` +
    ` (total=${c.total}) current_key_fp=${status.currentKeyFingerprint}` +
    ` previous_key_set=${status.previousKeySet}` +
    (status.previousKeyFingerprint ? ` previous_key_fp=${status.previousKeyFingerprint}` : "")
  );
}
