import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { libraryPagePlacements } from "@shared/models/library2";
import { libraryPages } from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import { db } from "./db";
import { parseLibraryIndexEntries } from "./library-index-format";
import { placeLibraryPageSemantically } from "./library-placement";
import type { Principal } from "./principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";

const placementScopeColumns = {
  scope: libraryPagePlacements.scope,
  ownerUserId: libraryPagePlacements.ownerUserId,
  vaultId: libraryPagePlacements.vaultId,
};

const placementInsertScopeColumns = {
  scope: libraryPagePlacements.scope,
  ownerUserId: libraryPagePlacements.ownerUserId,
  accountId: libraryPagePlacements.accountId,
};

const pageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export type Library2ImportSource =
  | { type: "page" | "section"; pageId: string }
  | { type: "vault"; vaultId: string };

export interface CreateLibrary2PlacementsInput {
  source: Library2ImportSource;
  vaultId: string;
  sectionPageId: string;
  importKey: string;
}

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Library2 placements require a user principal"), { status: 403 });
  }
}

function visiblePages(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, pageScopeColumns, predicate);
}

function visiblePlacements(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, placementScopeColumns, predicate);
}

function writablePlacements(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, placementScopeColumns, predicate);
}

async function requireLiveVault(vaultId: string, principal: Principal & { accountId: string }) {
  const [vault] = await db
    .select()
    .from(vaults)
    .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId), eq(vaults.isArchived, false)))
    .limit(1);
  if (!vault) throw Object.assign(new Error("Library2 vault not found"), { status: 404 });
  return vault;
}

async function readCanonicalSections(vaultId: string, principal: Principal) {
  const [indexPage] = await db
    .select({ id: libraryPages.id, plainTextContent: libraryPages.plainTextContent })
    .from(libraryPages)
    .where(visiblePages(principal, and(
      eq(libraryPages.vaultId, vaultId),
      eq(libraryPages.structuralRole, "meta"),
      or(
        eq(libraryPages.title, "Index"),
        sql`'library-index' = ANY(${libraryPages.tags})`,
      ),
    )))
    .limit(1);
  if (!indexPage) return [];

  const entries = parseLibraryIndexEntries(indexPage.plainTextContent);
  if (entries.length === 0) {
    return [{ id: indexPage.id, title: "Index", slug: "index", emoji: null, sortOrder: 0, category: "Index" }];
  }
  const pages = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      emoji: libraryPages.emoji,
      sortOrder: libraryPages.sortOrder,
    })
    .from(libraryPages)
    .where(visiblePages(principal, and(
      inArray(libraryPages.id, entries.map((entry) => entry.id)),
      eq(libraryPages.vaultId, vaultId),
      eq(libraryPages.structuralRole, "wiki"),
    )))
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  return pages.map((page) => ({ ...page, category: entryById.get(page.id)?.category ?? "Concepts" }));
}

async function requireCanonicalSection(vaultId: string, sectionPageId: string, principal: Principal) {
  const sections = await readCanonicalSections(vaultId, principal);
  const section = sections.find((candidate) => candidate.id === sectionPageId);
  if (section) return section;

  const [fallback] = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      emoji: libraryPages.emoji,
      sortOrder: libraryPages.sortOrder,
    })
    .from(libraryPages)
    .where(visiblePages(principal, and(
      eq(libraryPages.id, sectionPageId),
      eq(libraryPages.vaultId, vaultId),
      eq(libraryPages.structuralRole, "meta"),
      or(eq(libraryPages.title, "Index"), sql`'library-index' = ANY(${libraryPages.tags})`),
    )))
    .limit(1);
  if (!fallback) {
    throw Object.assign(new Error("Library2 section must be the vault Index or a canonical Index entry"), { status: 400 });
  }
  return { ...fallback, category: "Index" };
}

async function resolveSourcePages(source: Library2ImportSource, principal: Principal): Promise<Array<typeof libraryPages.$inferSelect>> {
  const pages = await db.select().from(libraryPages).where(visiblePages(principal));
  if (source.type === "page") {
    const page = pages.find((candidate) => candidate.id === source.pageId);
    if (!page) throw Object.assign(new Error("Library page not found"), { status: 404 });
    return [page];
  }
  if (source.type === "vault") {
    const selected = pages.filter((page) => page.vaultId === source.vaultId);
    if (selected.length === 0) throw Object.assign(new Error("Source vault has no visible Library pages"), { status: 404 });
    return selected;
  }

  const root = pages.find((candidate) => candidate.id === source.pageId);
  if (!root) throw Object.assign(new Error("Library section not found"), { status: 404 });
  const selectedIds = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of pages) {
      if (page.parentId && selectedIds.has(page.parentId) && !selectedIds.has(page.id)) {
        selectedIds.add(page.id);
        changed = true;
      }
    }
  }
  return pages.filter((page) => selectedIds.has(page.id));
}

export async function listLibrary2Destinations(principal: Principal) {
  requireUserPrincipal(principal);
  const liveVaults = await db
    .select()
    .from(vaults)
    .where(and(eq(vaults.accountId, principal.accountId), eq(vaults.isArchived, false)))
    .orderBy(asc(vaults.position), asc(vaults.name));
  return Promise.all(liveVaults.map(async (vault) => ({
    vault,
    sections: await readCanonicalSections(vault.id, principal),
  })));
}

export async function suggestLibrary2Destination(source: Library2ImportSource, principal: Principal) {
  requireUserPrincipal(principal);
  const pages = await resolveSourcePages(source, principal);
  const representative = pages[0];
  const suggestion = await placeLibraryPageSemantically({
    title: pages.length === 1 ? representative.title : pages.slice(0, 12).map((page) => page.title).join(", "),
    contentSummary: pages.slice(0, 12).map((page) => page.summary || page.oneLiner || page.plainTextContent.slice(0, 300)).join("\n"),
    tags: Array.from(new Set(pages.flatMap((page) => page.tags))).slice(0, 20),
  }, principal);
  return {
    vaultId: suggestion.vaultId,
    sectionPageId: suggestion.outcome === "review_required" ? suggestion.indexPageId : suggestion.parentId,
    confidence: suggestion.confidence,
    reason: suggestion.reason,
    sourceCount: pages.length,
  };
}

export async function createLibrary2Placements(input: CreateLibrary2PlacementsInput, principal: Principal) {
  requireUserPrincipal(principal);
  await requireLiveVault(input.vaultId, principal);
  await requireCanonicalSection(input.vaultId, input.sectionPageId, principal);
  const pages = await resolveSourcePages(input.source, principal);
  if (pages.length > 5_000) throw Object.assign(new Error("Library2 import is limited to 5,000 pages"), { status: 400 });

  const owner = ownedInsertValues(principal, placementInsertScopeColumns);
  if (owner.ownerUserId !== principal.userId || owner.accountId !== principal.accountId) {
    throw new Error("Library2 placement ownership could not be established");
  }
  const inserted = await db
    .insert(libraryPagePlacements)
    .values(pages.map((page) => ({
      pageId: page.id,
      vaultId: input.vaultId,
      sectionPageId: input.sectionPageId,
      importKey: input.importKey,
      ...owner,
      scope: "user",
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      createdByUserId: principal.userId,
    })))
    .onConflictDoNothing()
    .returning({ id: libraryPagePlacements.id });

  return { sourceCount: pages.length, createdCount: inserted.length, replayedCount: pages.length - inserted.length };
}

export async function listLibrary2Placements(principal: Principal) {
  requireUserPrincipal(principal);
  const rows = await db
    .select({
      placementId: libraryPagePlacements.id,
      vaultId: libraryPagePlacements.vaultId,
      sectionPageId: libraryPagePlacements.sectionPageId,
      importKey: libraryPagePlacements.importKey,
      createdAt: libraryPagePlacements.createdAt,
      page: libraryPages,
    })
    .from(libraryPagePlacements)
    .innerJoin(libraryPages, eq(libraryPagePlacements.pageId, libraryPages.id))
    .where(and(visiblePlacements(principal), visiblePages(principal)))
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));
  return rows;
}

export async function deleteLibrary2Placement(placementId: string, principal: Principal) {
  requireUserPrincipal(principal);
  const [deleted] = await db
    .delete(libraryPagePlacements)
    .where(writablePlacements(principal, eq(libraryPagePlacements.id, placementId)))
    .returning({ id: libraryPagePlacements.id });
  if (!deleted) throw Object.assign(new Error("Library2 placement not found"), { status: 404 });
  return deleted;
}
