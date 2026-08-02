import type { Vault } from "@/hooks/use-vaults";
import { vaultTitleColor } from "@/lib/vault-title-color";
import type { LibraryPage } from "./types";

export type LibraryPageTitleColorResolver = (
  page: Pick<LibraryPage, "vaultId">,
  alpha: number,
) => string | null;

/**
 * Resolve a Library page's single owning Vault through the shared title-color
 * boundary. Legacy null-Vault pages inherit the account's default Vault.
 */
export function libraryPageTitleColor(
  page: Pick<LibraryPage, "vaultId">,
  defaultVaultId: string | null,
  vaultById: Map<string, Vault>,
  activeVaultId: string | null,
  alpha: number,
): string | null {
  const effectiveVaultId = page.vaultId ?? defaultVaultId;
  return vaultTitleColor(
    effectiveVaultId ? [effectiveVaultId] : undefined,
    vaultById,
    activeVaultId,
    alpha,
  );
}
