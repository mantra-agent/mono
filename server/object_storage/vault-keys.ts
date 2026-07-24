/**
 * Vault-prefixed object key utilities.
 *
 * New writes use `vaults/{vaultId}/{category}/{filename}`.
 * Reads try vault-prefixed key first, falling back to legacy `private/...` key.
 * This enables migrate-don't-mutate: old objects remain readable while new objects
 * land in vault-partitioned paths.
 */
import type { Principal } from "../principal";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { storageBackend, PRIVATE_PREFIX, type ObjectMetadata } from "./s3-backend";
import { createLogger } from "../log";

const log = createLogger("VaultKeys");

const VAULT_PREFIX = "vaults/";

/**
 * Build a vault-scoped object storage key.
 *
 * @param vaultId - The vault to write into
 * @param category - Object category (e.g. "uploads", "generated", "media", "inference", "renders")
 * @param filename - The file name including extension (e.g. "abc-123.png")
 * @returns Full key like "vaults/{vaultId}/uploads/abc-123.png"
 */
export function vaultObjectKey(vaultId: string, category: string, filename: string): string {
  return `${VAULT_PREFIX}${vaultId}/${category}/${filename}`;
}

/**
 * Build a vault-scoped key using the current principal's activeVaultId.
 * Falls back to legacy `private/{category}/{filename}` if no vault is active
 * (system principals, pre-vault code paths).
 */
export function vaultObjectKeyFromPrincipal(
  principal: Principal | null | undefined,
  category: string,
  filename: string,
): string {
  const vaultId = principal?.activeVaultId;
  if (vaultId) {
    return vaultObjectKey(vaultId, category, filename);
  }
  // Fallback for system principals or pre-vault contexts
  return `${PRIVATE_PREFIX}${category}/${filename}`;
}

/**
 * Auto-resolve the vault-scoped key from the current async principal context.
 * Convenience wrapper for code paths that don't have the principal in scope.
 */
export function vaultObjectKeyAuto(category: string, filename: string): string {
  const principal = getCurrentPrincipalOrSystem();
  return vaultObjectKeyFromPrincipal(principal, category, filename);
}

/**
 * Check if a key is vault-prefixed.
 */
export function isVaultKey(key: string): boolean {
  return key.startsWith(VAULT_PREFIX);
}

/**
 * Check if a key is legacy (private/ prefix).
 */
export function isLegacyKey(key: string): boolean {
  return key.startsWith(PRIVATE_PREFIX);
}

/**
 * Convert a legacy key to its vault-prefixed equivalent.
 * `private/uploads/abc.png` → `vaults/{vaultId}/uploads/abc.png`
 */
export function legacyKeyToVaultKey(legacyKey: string, vaultId: string): string {
  if (!legacyKey.startsWith(PRIVATE_PREFIX)) {
    throw new Error(`Not a legacy key: ${legacyKey}`);
  }
  const rest = legacyKey.slice(PRIVATE_PREFIX.length);
  return `${VAULT_PREFIX}${vaultId}/${rest}`;
}

/**
 * Convert a vault key back to the legacy equivalent (for fallback resolution).
 * `vaults/{vaultId}/uploads/abc.png` → `private/uploads/abc.png`
 */
export function vaultKeyToLegacyKey(vaultKey: string): string | null {
  if (!vaultKey.startsWith(VAULT_PREFIX)) return null;
  const afterVault = vaultKey.slice(VAULT_PREFIX.length);
  // Skip the vaultId segment
  const slashIdx = afterVault.indexOf("/");
  if (slashIdx === -1) return null;
  const rest = afterVault.slice(slashIdx + 1);
  return `${PRIVATE_PREFIX}${rest}`;
}

/**
 * Extract the entity path (without any prefix) from a key.
 * Works for both vault and legacy keys.
 *
 * `private/uploads/abc.png` → `uploads/abc.png`
 * `vaults/{id}/uploads/abc.png` → `uploads/abc.png`
 */
export function extractEntityPath(key: string): string | null {
  if (key.startsWith(PRIVATE_PREFIX)) {
    return key.slice(PRIVATE_PREFIX.length);
  }
  if (key.startsWith(VAULT_PREFIX)) {
    const afterVault = key.slice(VAULT_PREFIX.length);
    const slashIdx = afterVault.indexOf("/");
    if (slashIdx === -1) return null;
    return afterVault.slice(slashIdx + 1);
  }
  return null;
}

/**
 * Resolve an object key with vault-first, legacy-fallback semantics.
 *
 * For reads: tries the vault-prefixed path first, then falls back to legacy.
 * This enables dual-read during the migration period.
 *
 * @param entityPath - The entity portion (e.g. "uploads/abc.png")
 * @param vaultId - The vault to check first (null = skip vault check)
 * @returns The key that exists, or null if neither path has the object
 */
export async function resolveObjectKeyWithFallback(
  entityPath: string,
  vaultId: string | null,
): Promise<{ key: string; source: "vault" | "legacy" } | null> {
  // Try vault path first
  if (vaultId) {
    const vaultKey = `${VAULT_PREFIX}${vaultId}/${entityPath}`;
    const vaultMeta = await storageBackend.headObject(vaultKey);
    if (vaultMeta) {
      return { key: vaultKey, source: "vault" };
    }
  }

  // Fall back to legacy path
  const legacyKey = `${PRIVATE_PREFIX}${entityPath}`;
  const legacyMeta = await storageBackend.headObject(legacyKey);
  if (legacyMeta) {
    return { key: legacyKey, source: "legacy" };
  }

  return null;
}

/**
 * Resolve an object key across an ordered list of candidate vaults, then legacy.
 *
 * An object's bytes live in whichever vault was active when it was written, which
 * is not necessarily the reader's currently-active vault. Trying only the active
 * vault (plus legacy) strands objects whose home vault differs from the active one
 * — the "image stopped rendering after switching vaults" failure. This resolver
 * walks the ordered candidate vaults (pass the active vault first, then every vault
 * the reader can see) and returns the first hit, so reads succeed for any object
 * the reader is entitled to see without widening visibility beyond the reader's own
 * vault set. Bounded by the small number of visible vaults; the active vault is
 * tried first for the fast path.
 *
 * @param entityPath - The entity portion (e.g. "uploads/abc.png")
 * @param vaultIds - Ordered candidate vault ids; nullish and duplicate ids are skipped
 * @returns The resolved key, its source, and head metadata, or null if nothing matched
 */
export async function resolveObjectKeyAcrossVaults(
  entityPath: string,
  vaultIds: Array<string | null | undefined>,
): Promise<{ key: string; source: "vault" | "legacy"; meta: ObjectMetadata } | null> {
  const seen = new Set<string>();
  for (const vaultId of vaultIds) {
    if (!vaultId || seen.has(vaultId)) continue;
    seen.add(vaultId);
    const vaultKey = `${VAULT_PREFIX}${vaultId}/${entityPath}`;
    const meta = await storageBackend.headObject(vaultKey);
    if (meta) return { key: vaultKey, source: "vault", meta };
  }

  const legacyKey = `${PRIVATE_PREFIX}${entityPath}`;
  const legacyMeta = await storageBackend.headObject(legacyKey);
  if (legacyMeta) return { key: legacyKey, source: "legacy", meta: legacyMeta };

  return null;
}

export { VAULT_PREFIX };
