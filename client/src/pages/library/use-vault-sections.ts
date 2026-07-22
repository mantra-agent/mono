// Use createLogger for logging ONLY
import { useMemo } from "react";
import { useVaults, type Vault } from "@/hooks/use-vaults";
import type { LibraryPage, TreeNode } from "./types";

/**
 * Shared, reusable vault-awareness for the Library sidebars (Library1 + Library2).
 *
 * Two derived views over the already-owner-scoped Library payload:
 *  - `useVisibleVaults()` resolves the toggled-on, non-archived vault set and the
 *    page→vault resolution rule (null vault_id folds into the default vault so
 *    pre-backfill pages stay visible, matching the server move guard's
 *    "null vault_id rows stay unconstrained" semantics).
 *  - `useVaultSections()` groups pages/tree roots into one section per visible
 *    vault (INCLUDING empty vaults) and derives a RECENT list.
 *
 * These are pure derived views. They never mutate a page's stored `vaultId` or
 * location. Vault visibility comes from `useVaults()`, whose optimistic
 * `visibleVaultIds` update makes toggling a vault off remove its section,
 * subtree, RECENT entries, and (via `resolveVaultId`/`isVaultVisible`) its move
 * destinations reactively, with no reload — the server library payload is only
 * owner-scoped, not vault-toggle-scoped, so this filtering is the source of
 * visibility truth on the client.
 */

const DEFAULT_RECENT_LIMIT = 5;

export interface VisibleVaults {
  /** Toggled-on, non-archived vaults in stable (position, name, id) order. */
  visibleVaults: Vault[];
  /** The account's default vault id, used to resolve null-vault pages. */
  defaultVaultId: string | null;
  /** True while vault visibility is still loading. */
  isLoading: boolean;
  /** Resolve a page's effective vault id, folding null into the default vault. */
  resolveVaultId: (vaultId: string | null | undefined) => string | null;
  /** Whether a page's (resolved) vault is currently visible. */
  isVaultVisible: (vaultId: string | null | undefined) => boolean;
}

export interface VaultSection {
  vault: Vault;
  /** Root-level tree nodes belonging to this vault (empty when no treeData given). */
  rootNodes: TreeNode[];
  /** Flat visible pages belonging to this vault. */
  pages: LibraryPage[];
}

export interface VaultSectionsResult extends VisibleVaults {
  /** One section per visible vault, including vaults with zero pages. */
  sections: VaultSection[];
  /** Up to `recentLimit` most-recently-modified visible pages across all visible vaults. */
  recent: LibraryPage[];
}

export interface UseVaultSectionsArgs {
  pages: LibraryPage[];
  treeData?: TreeNode[];
  recentLimit?: number;
}

function sortVaults(a: Vault, b: Vault): number {
  if (a.position !== b.position) return a.position - b.position;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

/** Resolve the visible-vault set and the page→vault resolution rule. */
export function useVisibleVaults(): VisibleVaults {
  const { vaults, visibleVaultIds, isLoading } = useVaults();

  return useMemo(() => {
    const defaultVaultId = vaults.find((v) => v.isDefault)?.id ?? null;
    const visibleSet = new Set(visibleVaultIds);

    const visibleVaults = vaults
      .filter((v) => !v.isArchived && visibleSet.has(v.id))
      .sort(sortVaults);
    const visibleVaultIdSet = new Set(visibleVaults.map((v) => v.id));

    const resolveVaultId = (
      vaultId: string | null | undefined,
    ): string | null => vaultId ?? defaultVaultId;

    const isVaultVisible = (vaultId: string | null | undefined): boolean => {
      const resolved = resolveVaultId(vaultId);
      return resolved !== null && visibleVaultIdSet.has(resolved);
    };

    return {
      visibleVaults,
      defaultVaultId,
      isLoading,
      resolveVaultId,
      isVaultVisible,
    };
  }, [vaults, visibleVaultIds, isLoading]);
}

/**
 * Group Library pages and tree roots into one section per visible vault
 * (including empty vaults), plus a RECENT list of the most-recently-modified
 * visible pages. Pure derived view; never mutates stored location/vaultId.
 */
export function useVaultSections({
  pages,
  treeData,
  recentLimit = DEFAULT_RECENT_LIMIT,
}: UseVaultSectionsArgs): VaultSectionsResult {
  const visible = useVisibleVaults();

  return useMemo(() => {
    const { visibleVaults, resolveVaultId } = visible;
    const visibleVaultIdSet = new Set(visibleVaults.map((v) => v.id));

    // Group flat pages by resolved vault (visible vaults only).
    const pagesByVault = new Map<string, LibraryPage[]>();
    for (const v of visibleVaults) pagesByVault.set(v.id, []);
    for (const page of pages) {
      const vid = resolveVaultId(page.vaultId);
      if (vid && visibleVaultIdSet.has(vid)) pagesByVault.get(vid)!.push(page);
    }

    // Group root tree nodes by resolved vault (visible vaults only). Because a
    // page's vault is immutable and moves are same-vault only, an entire subtree
    // belongs to its root node's vault.
    const rootsByVault = new Map<string, TreeNode[]>();
    for (const v of visibleVaults) rootsByVault.set(v.id, []);
    for (const root of treeData ?? []) {
      const vid = resolveVaultId(root.vaultId);
      if (vid && visibleVaultIdSet.has(vid)) rootsByVault.get(vid)!.push(root);
    }

    const sections: VaultSection[] = visibleVaults.map((vault) => ({
      vault,
      rootNodes: rootsByVault.get(vault.id) ?? [],
      pages: pagesByVault.get(vault.id) ?? [],
    }));

    // RECENT: most-recently-modified visible pages. Self-contained ordering so
    // the view is correct regardless of input order. ISO timestamps sort
    // lexicographically in chronological order.
    const recent = pages
      .filter((page) => {
        const vid = resolveVaultId(page.vaultId);
        return vid !== null && visibleVaultIdSet.has(vid);
      })
      .slice()
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, recentLimit);

    return { ...visible, sections, recent };
  }, [visible, pages, treeData, recentLimit]);
}
