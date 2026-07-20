import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { ownedInsertValues } from "./scoped-storage";
import { syncContentFields } from "@shared/markdown-tiptap";
import { libraryPages } from "@shared/models/info";
import { users } from "@shared/schema";
import { vaults } from "@shared/models/vaults";

export const LIBRARY_STRUCTURAL_ROLES = ["source", "artifact", "wiki", "meta"] as const;
export type LibraryStructuralRole = (typeof LIBRARY_STRUCTURAL_ROLES)[number];

export const MANTRA_LIBRARY_VAULT_NAME = "Mantra";

const log = createLogger("LibraryDomain");

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export function normalizeLibraryStructuralRole(
  role: string | null | undefined,
  fallback: LibraryStructuralRole = "artifact",
): LibraryStructuralRole {
  return LIBRARY_STRUCTURAL_ROLES.includes(role as LibraryStructuralRole)
    ? (role as LibraryStructuralRole)
    : fallback;
}

function slugify(title: string, fallback = "page"): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function requireAccountPrincipal(principal: Principal): Principal & { accountId: string } {
  if (!principal.accountId) {
    throw new Error("Library vault bootstrap requires an account principal");
  }
  return principal as Principal & { accountId: string };
}

async function ensureMantraVault(principal: Principal): Promise<string> {
  const scopedPrincipal = requireAccountPrincipal(principal);
  const [existing] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      and(
        eq(vaults.accountId, scopedPrincipal.accountId),
        eq(vaults.name, MANTRA_LIBRARY_VAULT_NAME),
      ),
    )
    .limit(1);
  if (existing) {
    await ensureUserCanSeeVault(principal, existing.id);
    return existing.id;
  }

  const [positionRow] = await db
    .select({ maxPosition: sql<number>`COALESCE(MAX(${vaults.position}), -1)` })
    .from(vaults)
    .where(eq(vaults.accountId, scopedPrincipal.accountId));

  const [created] = await db
    .insert(vaults)
    .values({
      accountId: scopedPrincipal.accountId,
      name: MANTRA_LIBRARY_VAULT_NAME,
      icon: "M",
      color: "#63B3FF",
      purpose: "Mantra product, architecture, specs, meeting notes, and compiled product knowledge.",
      position: (positionRow?.maxPosition ?? -1) + 1,
      isDefault: false,
    })
    .onConflictDoUpdate({
      target: [vaults.accountId, vaults.name],
      set: {
        purpose: "Mantra product, architecture, specs, meeting notes, and compiled product knowledge.",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({ id: vaults.id });

  await ensureUserCanSeeVault(principal, created.id);
  log.log(`Ensured Mantra Library vault for account=${scopedPrincipal.accountId}`);
  return created.id;
}

async function ensureUserCanSeeVault(principal: Principal, vaultId: string): Promise<void> {
  if (!principal.userId) return;
  await db
    .update(users)
    .set({
      visibleVaultIds: sql`CASE
        WHEN ${users.visibleVaultIds} IS NULL THEN ARRAY[${vaultId}]::text[]
        WHEN ${vaultId} = ANY(${users.visibleVaultIds}) THEN ${users.visibleVaultIds}
        ELSE array_append(${users.visibleVaultIds}, ${vaultId})
      END`,
    })
    .where(eq(users.id, principal.userId));
}

async function ensureVaultPage(input: {
  principal: Principal;
  vaultId: string;
  title: string;
  parentId: string | null;
  structuralRole: LibraryStructuralRole;
  tags: string[];
  plainTextContent: string;
  sortOrder: number;
  slugFallback?: string;
}): Promise<typeof libraryPages.$inferSelect> {
  const synced = syncContentFields({ markdown: input.plainTextContent });
  const slug = slugify(input.title, input.slugFallback ?? "page");

  const [existing] = await db
    .select()
    .from(libraryPages)
    .where(
      and(
        eq(libraryPages.vaultId, input.vaultId),
        input.parentId === null
          ? isNull(libraryPages.parentId)
          : eq(libraryPages.parentId, input.parentId),
        eq(libraryPages.slug, slug),
      ),
    )
    .limit(1);

  if (existing) {
    const desiredRole = normalizeLibraryStructuralRole(existing.structuralRole, input.structuralRole);
    const desiredTags = Array.from(new Set([...(existing.tags ?? []), ...input.tags]));
    const [updated] = await db
      .update(libraryPages)
      .set({
        structuralRole: desiredRole,
        tags: desiredTags,
        vaultId: input.vaultId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
        updatedByUserId: input.principal.userId ?? undefined,
      })
      .where(eq(libraryPages.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(libraryPages)
    .values({
      title: input.title,
      slug,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId: input.parentId,
      tags: input.tags,
      structuralRole: input.structuralRole,
      sortOrder: input.sortOrder,
      ...ownedInsertValues(input.principal, libraryScopeColumns),
      vaultId: input.vaultId,
      createdByUserId: input.principal.userId ?? undefined,
      updatedByUserId: input.principal.userId ?? undefined,
    })
    .returning();
  return created;
}

export interface MantraLibraryVaultBootstrapResult {
  vaultId: string;
  rootPageId: string;
  wikiPageId: string;
  indexPageId: string;
  logPageId: string;
}

export async function ensureMantraLibraryVault(
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<MantraLibraryVaultBootstrapResult> {
  const vaultId = await ensureMantraVault(principal);

  const root = await ensureVaultPage({
    principal,
    vaultId,
    title: MANTRA_LIBRARY_VAULT_NAME,
    parentId: null,
    structuralRole: "meta",
    tags: ["vault", "mantra", "library-vault"],
    plainTextContent:
      "# Mantra\n\nTop-level Library vault for Mantra product knowledge. Wiki, Index, and Log are maintained under this vault.",
    sortOrder: 0,
    slugFallback: "mantra",
  });

  const wiki = await ensureVaultPage({
    principal,
    vaultId,
    title: "Wiki",
    parentId: root.id,
    structuralRole: "meta",
    tags: ["wiki", "library-meta", "mantra"],
    plainTextContent:
      "# Wiki\n\nAgent-maintained compiled knowledge for the Mantra vault. Entity, Concept, and Synthesis pages live under this section.",
    sortOrder: 0,
    slugFallback: "wiki",
  });

  const index = await ensureVaultPage({
    principal,
    vaultId,
    title: "Index",
    parentId: root.id,
    structuralRole: "meta",
    tags: ["library-index", "library-meta", "mantra"],
    plainTextContent:
      "# Library Index\n\n## Entities\n\n## Concepts\n\n## Synthesis\n\nThis semantic catalog lists compiled Wiki pages only. It is intentionally empty until ingest creates or updates Wiki pages.",
    sortOrder: 1,
    slugFallback: "index",
  });

  const logPage = await ensureVaultPage({
    principal,
    vaultId,
    title: "Log",
    parentId: root.id,
    structuralRole: "meta",
    tags: ["library-log", "library-meta", "mantra"],
    plainTextContent:
      "# Library Log\n\nAppend-only maintenance history for the Mantra vault.\n\n## Bootstrap\n\nMantra vault, Wiki, Index, and Log metadata pages were ensured replay-safely.",
    sortOrder: 2,
    slugFallback: "log",
  });

  return {
    vaultId,
    rootPageId: root.id,
    wikiPageId: wiki.id,
    indexPageId: index.id,
    logPageId: logPage.id,
  };
}
