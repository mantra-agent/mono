import type { Vault } from "@/hooks/use-vaults";

// ── Vault-colored list titles ────────────────────────────────────────────
// Shared resolver for tinting an object's list title with its driving vault's
// color: full color for an emphasized row, a muted (reduced-alpha) variant for
// a de-emphasized row (read person, completed work item). Used by People and
// Projects/Milestones/Tasks so the tinting rule lives in exactly one place.

/** Alpha applied to a de-emphasized (read / completed) vault-colored title. */
export const MUTED_TITLE_ALPHA = 0.5;

/** Convert a #rrggbb (or #rgb) hex string to an rgba() string, or null if invalid. */
export function hexToRgba(hex: string, alpha: number): string | null {
  const cleaned = hex.trim().replace(/^#/, "");
  const full = cleaned.length === 3 ? cleaned.split("").map(ch => ch + ch).join("") : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const int = parseInt(full, 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

/**
 * Resolve the single vault whose color drives an object's list title. The active
 * vault wins when the object belongs to it; otherwise the lowest-position member
 * vault with a color. Returns null when no colored membership applies.
 */
export function resolveDrivingVault(
  vaultIds: string[] | undefined,
  vaultById: Map<string, Vault>,
  activeVaultId: string | null,
): Vault | null {
  if (!vaultIds || vaultIds.length === 0) return null;
  if (activeVaultId && vaultIds.includes(activeVaultId)) {
    const active = vaultById.get(activeVaultId);
    if (active?.color) return active;
  }
  let best: Vault | null = null;
  for (const id of vaultIds) {
    const vault = vaultById.get(id);
    if (!vault?.color) continue;
    if (!best || vault.position < best.position) best = vault;
  }
  return best;
}

/**
 * Title color for an object row at the given alpha, or null to fall back to the
 * default text classes. `alpha` is 1 for an emphasized row and MUTED_TITLE_ALPHA
 * for a de-emphasized one.
 */
/** Full vault color for reference chips, with white reserved for CTA-blue fallback. */
export function vaultReferenceColor(
  vaultIds: string[] | undefined,
  vaultById: Map<string, Vault>,
  activeVaultId: string | null,
): string | null {
  const color = resolveDrivingVault(vaultIds, vaultById, activeVaultId)?.color;
  if (!color) return null;
  const opaque = hexToRgba(color, 1);
  if (!opaque || opaque === "rgba(255, 255, 255, 1)") return null;
  return color;
}

export function vaultTitleColor(
  vaultIds: string[] | undefined,
  vaultById: Map<string, Vault>,
  activeVaultId: string | null,
  alpha: number,
): string | null {
  const vault = resolveDrivingVault(vaultIds, vaultById, activeVaultId);
  if (!vault?.color) return null;
  return hexToRgba(vault.color, alpha);
}
