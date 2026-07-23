import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import { syncContentFields } from "@shared/markdown-tiptap";
import { libraryPages } from "@shared/models/info";
import { users } from "@shared/schema";
import { vaults } from "@shared/models/vaults";

export const LIBRARY_STRUCTURAL_ROLES = ["source", "artifact", "wiki", "meta"] as const;
export type LibraryStructuralRole = (typeof LIBRARY_STRUCTURAL_ROLES)[number];

export const MANTRA_LIBRARY_VAULT_NAME = "Mantra";
export const CANONICAL_LIBRARY_INDEX_BOOTSTRAP_MARKDOWN =
  "# Library Index\n\nThis vault has no approved Index sections yet.";

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

function requireAccountPrincipal(
  principal: Principal,
): Principal & { userId: string; accountId: string } {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId
  ) {
    throw Object.assign(
      new Error("Library vault bootstrap requires a user principal"),
      { status: 403 },
    );
  }
  return principal as Principal & { userId: string; accountId: string };
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
  log.info("Ensured Mantra Library vault", {
    accountId: scopedPrincipal.accountId,
    vaultId: created.id,
  });
  return created.id;
}

async function ensureUserCanSeeVault(principal: Principal, vaultId: string): Promise<void> {
  if (principal.actorType !== "user" || !principal.userId) return;
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

export async function ensureVaultPage(input: {
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
      combineWithVisibleScope(
        input.principal,
        libraryScopeColumns,
        and(
          eq(libraryPages.vaultId, input.vaultId),
          input.parentId === null
            ? isNull(libraryPages.parentId)
            : eq(libraryPages.parentId, input.parentId),
          eq(libraryPages.slug, slug),
        ),
      ),
    )
    .limit(1);

  if (existing) {
    if (
      existing.scope !== "user" ||
      existing.ownerUserId !== input.principal.userId ||
      existing.accountId !== input.principal.accountId
    ) {
      throw Object.assign(
        new Error("Library page is visible but not writable"),
        { status: 403 },
      );
    }
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
      .where(
        combineWithWritableScope(
          input.principal,
          libraryScopeColumns,
          eq(libraryPages.id, existing.id),
        ),
      )
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

export type CanonicalLibraryMetadataKind = "index" | "wiki" | "log";

const canonicalMetadata = {
  index: {
    title: "Index",
    tag: "library-index",
    tags: ["library-index", "library-meta"],
    markdown: CANONICAL_LIBRARY_INDEX_BOOTSTRAP_MARKDOWN,
    sortOrder: 0,
  },
  wiki: {
    title: "Wiki",
    tag: "wiki",
    tags: ["wiki", "library-meta"],
    markdown: "# Wiki\n\nAgent-maintained compiled knowledge for this vault.",
    sortOrder: 1,
  },
  log: {
    title: "Log",
    tag: "library-log",
    tags: ["library-log", "library-meta"],
    markdown: "# Library Log\n\nAppend-only maintenance history for this vault.",
    sortOrder: 2,
  },
} as const;

/**
 * Canonical metadata identity is `(vault_id, structural_role=meta, kind tag)`.
 * Parentage is normalized only after that identity is resolved under a
 * transaction-scoped lock, so moving metadata to the vault root cannot fork it.
 */
export async function ensureCanonicalVaultMetadataPage(input: {
  principal: Principal;
  vaultId: string;
  kind: CanonicalLibraryMetadataKind;
}): Promise<typeof libraryPages.$inferSelect> {
  requireAccountPrincipal(input.principal);
  const definition = canonicalMetadata[input.kind];
  const synced = syncContentFields({ markdown: definition.markdown });
  const lockKey = `library-metadata:${input.vaultId}:${input.kind}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const candidates = await tx
      .select()
      .from(libraryPages)
      .where(
        combineWithVisibleScope(
          input.principal,
          libraryScopeColumns,
          and(
            eq(libraryPages.vaultId, input.vaultId),
            eq(libraryPages.structuralRole, "meta"),
            sql`${definition.tag} = ANY(${libraryPages.tags})`,
          ),
        ),
      )
      .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id));

    // Canonical metadata identity is (vault, structural_role=meta, kind tag)
    // and its home is always the vault root. A nested row matching that
    // identity is stale classification by definition, so demote it here at
    // the one boundary that owns the invariant instead of failing every
    // read, lint, and move that encounters the duplicate.
    const rootCandidates = candidates.filter((page) => page.parentId === null);
    if (rootCandidates.length > 1) {
      throw Object.assign(
        new Error(`Vault has multiple root canonical ${definition.title} pages; migration repair is required`),
        { status: 409 },
      );
    }
    const canonical = rootCandidates[0] ?? candidates[0];
    const staleNested = candidates.filter((page) => page.id !== canonical?.id);
    for (const stale of staleNested) {
      const demotedTags = (stale.tags ?? []).filter(
        (tag) => tag !== definition.tag && tag !== "library-meta",
      );
      const [demoted] = await tx
        .update(libraryPages)
        .set({
          structuralRole: "artifact",
          tags: demotedTags,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          updatedByUserId: input.principal.userId ?? undefined,
        })
        .where(
          combineWithWritableScope(
            input.principal,
            libraryScopeColumns,
            eq(libraryPages.id, stale.id),
          ),
        )
        .returning({ id: libraryPages.id });
      if (!demoted) {
        throw Object.assign(
          new Error(`Stale duplicate ${definition.title} page is not writable; migration repair is required`),
          { status: 409 },
        );
      }
      log.warn("Demoted stale canonical metadata duplicate", {
        vaultId: input.vaultId,
        kind: input.kind,
        pageId: stale.id,
        parentId: stale.parentId,
        canonicalPageId: canonical?.id ?? null,
      });
    }

    const existing = canonical;
    if (existing) {
      const desiredTags = Array.from(new Set([...(existing.tags ?? []), ...definition.tags]));
      const [updated] = await tx
        .update(libraryPages)
        .set({
          title: definition.title,
          slug: slugify(definition.title),
          parentId: null,
          structuralRole: "meta",
          tags: desiredTags,
          sortOrder: definition.sortOrder,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          updatedByUserId: input.principal.userId ?? undefined,
        })
        .where(
          combineWithWritableScope(
            input.principal,
            libraryScopeColumns,
            eq(libraryPages.id, existing.id),
          ),
        )
        .returning();
      if (!updated) {
        throw Object.assign(new Error("Canonical Library metadata page is not writable"), { status: 403 });
      }
      return updated;
    }

    const [created] = await tx
      .insert(libraryPages)
      .values({
        title: definition.title,
        slug: slugify(definition.title),
        content: synced.content,
        plainTextContent: synced.plainTextContent,
        parentId: null,
        tags: [...definition.tags],
        structuralRole: "meta",
        sortOrder: definition.sortOrder,
        ...ownedInsertValues(input.principal, libraryScopeColumns),
        vaultId: input.vaultId,
        createdByUserId: input.principal.userId ?? undefined,
        updatedByUserId: input.principal.userId ?? undefined,
      })
      .returning();
    return created;
  });
}

export interface MantraLibraryVaultBootstrapResult {
  vaultId: string;
  wikiPageId: string;
  indexPageId: string;
  logPageId: string;
}

export async function ensureMantraLibraryVault(
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<MantraLibraryVaultBootstrapResult> {
  const vaultId = await ensureMantraVault(principal);
  const index = await ensureCanonicalVaultMetadataPage({ principal, vaultId, kind: "index" });
  const wiki = await ensureCanonicalVaultMetadataPage({ principal, vaultId, kind: "wiki" });
  const logPage = await ensureCanonicalVaultMetadataPage({ principal, vaultId, kind: "log" });

  return {
    vaultId,
    wikiPageId: wiki.id,
    indexPageId: index.id,
    logPageId: logPage.id,
  };
}
