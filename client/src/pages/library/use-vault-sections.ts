// Use createLogger for logging ONLY
import { useMemo } from "react";
import { useVaults, type Vault } from "@/hooks/use-vaults";
import type { LibraryPage, TreeNode } from "./types";

/**
 * Shared, reusable vault-awareness for the standard Library sidebar.
 *
 * Two derived views over the grant-aware Library payload:
 *  - `useVisibleVaults()` resolves the toggled-on, non-archived vault set and the
 *    page→vault resolution rule (null vault_id folds into the default vault so
 *    pre-backfill pages stay visible, matching the server move guard's
 *    "null vault_id rows stay unconstrained" semantics).
 *  - `useVaultSections()` groups owned pages/tree roots into one section per
 *    visible vault (INCLUDING empty vaults), projects grant-only roots into
 *    Shared, and derives a RECENT list of owned visible pages.
 *
 * These are pure derived views. They never mutate a page's stored `vaultId` or
 * location. Vault visibility comes from `useVaults()`, whose optimistic
 * `visibleVaultIds` update makes toggling a vault off remove its section,
 * subtree, RECENT entries, and (via `resolveVaultId`/`isVaultVisible`) its move
 * destinations reactively, with no reload. Shared is a recipient projection of
 * grant-only roots; it is not a real Library folder.
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
  /** Whether a concrete Vault id is enabled in the top bar. */
  isVaultEnabled: (vaultId: string | null | undefined) => boolean;
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
  /** Grant-only roots whose parent is invisible. Projection, not a real folder. */
  sharedRoots: TreeNode[];
  /** Up to `recentLimit` most-recently-modified visible pages across all visible vaults. */
  recent: LibraryPage[];
}

export interface UseVaultSectionsArgs {
  pages: LibraryPage[];
  treeData?: TreeNode[];
  recentLimit?: number;
  currentUserId?: string | null;
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

    const isVaultEnabled = (vaultId: string | null | undefined): boolean =>
      typeof vaultId === "string" && visibleVaultIdSet.has(vaultId);

    const isVaultVisible = (vaultId: string | null | undefined): boolean => {
      const resolved = resolveVaultId(vaultId);
      return isVaultEnabled(resolved);
    };

    return {
      visibleVaults,
      defaultVaultId,
      isLoading,
      resolveVaultId,
      isVaultEnabled,
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
  currentUserId = null,
}: UseVaultSectionsArgs): VaultSectionsResult {
  const visible = useVisibleVaults();

  return useMemo(() => {
    const { visibleVaults, resolveVaultId } = visible;
    const visibleVaultIdSet = new Set(visibleVaults.map((v) => v.id));
    const isSharedRoot = (page: Pick<LibraryPage, "ownerUserId" | "vaultId">): boolean => {
      const vid = resolveVaultId(page.vaultId);
      const vaultVisible = Boolean(vid && visibleVaultIdSet.has(vid));
      if (vaultVisible) return false;
      return Boolean(currentUserId && page.ownerUserId && page.ownerUserId !== currentUserId);
    };

    // Group flat pages by resolved vault (visible vaults only).
    const pagesByVault = new Map<string, LibraryPage[]>();
    for (const v of visibleVaults) pagesByVault.set(v.id, []);
    for (const page of pages) {
      if (isSharedRoot(page)) continue;
      const vid = resolveVaultId(page.vaultId);
      if (vid && visibleVaultIdSet.has(vid)) pagesByVault.get(vid)!.push(page);
    }

    // Group root tree nodes by resolved vault (visible vaults only). The server
    // transfer boundary keeps every descendant in the root node's vault.
    // Grant-only roots whose parent is invisible land in Shared instead.
    const rootsByVault = new Map<string, TreeNode[]>();
    for (const v of visibleVaults) rootsByVault.set(v.id, []);
    const sharedRoots: TreeNode[] = [];
    for (const root of treeData ?? []) {
      if (isSharedRoot(root)) {
        sharedRoots.push(root);
        continue;
      }
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
        if (isSharedRoot(page)) return false;
        const vid = resolveVaultId(page.vaultId);
        return vid !== null && visibleVaultIdSet.has(vid);
      })
      .slice()
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, recentLimit);

    return { ...visible, sections, sharedRoots, recent };
  }, [visible, pages, treeData, recentLimit, currentUserId]);
}
