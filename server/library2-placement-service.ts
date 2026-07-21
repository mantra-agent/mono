import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  LIBRARY_PLACEMENT_INDEX_SECTIONS,
  libraryPages,
  libraryPlacements,
  type LibraryPlacementIndexSection,
} from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import { db } from "./db";
import { parseLibraryIndexEntries } from "./library-index-format";
import {
  createLibraryPlacements,
  deleteLibraryPlacement,
} from "./library-placement-store";
import { placeLibraryPageSemantically } from "./library-placement";
import type { Principal } from "./principal";
import { combineWithVisibleScope } from "./scoped-storage";

const pageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

const placementScopeColumns = {
  scope: libraryPlacements.scope,
  ownerUserId: libraryPlacements.ownerUserId,
  accountId: libraryPlacements.accountId,
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

interface Library2Section {
  id: string;
  title: string;
  slug: string;
  emoji: string | null;
  sortOrder: number;
  category: LibraryPlacementIndexSection;
}

const LIBRARY2_IMPORT_PAGE_LIMIT = 5_000;
const LIBRARY2_TRAVERSAL_BATCH_SIZE = 200;

function requireUserPrincipal(
  principal: Principal,
): asserts principal is Principal & { userId: string; accountId: string } {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId
  ) {
    throw Object.assign(
      new Error("Library2 placements require a user principal"),
      { status: 403 },
    );
  }
}

function visiblePages(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, pageScopeColumns, predicate);
}

function visiblePlacements(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, placementScopeColumns, predicate);
}

async function requireLiveVault(
  vaultId: string,
  principal: Principal & { accountId: string },
) {
  const [vault] = await db
    .select()
    .from(vaults)
    .where(
      and(
        eq(vaults.id, vaultId),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ),
    )
    .limit(1);
  if (!vault) {
    throw Object.assign(new Error("Library2 vault not found or archived"), {
      status: 404,
    });
  }
  return vault;
}

async function readCanonicalSections(
  vaultId: string,
  principal: Principal,
): Promise<Library2Section[]> {
  const [indexPage] = await db
    .select({ id: libraryPages.id, plainTextContent: libraryPages.plainTextContent })
    .from(libraryPages)
    .where(
      visiblePages(
        principal,
        and(
          eq(libraryPages.vaultId, vaultId),
          eq(libraryPages.structuralRole, "meta"),
          or(
            eq(libraryPages.title, "Index"),
            sql`'library-index' = ANY(${libraryPages.tags})`,
          ),
        ),
      ),
    )
    .limit(1);
  if (!indexPage) return [];

  const entries = parseLibraryIndexEntries(indexPage.plainTextContent);
  if (entries.length === 0) return [];

  const pages = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      emoji: libraryPages.emoji,
      sortOrder: libraryPages.sortOrder,
    })
    .from(libraryPages)
    .where(
      visiblePages(
        principal,
        and(
          inArray(
            libraryPages.id,
            entries.map((entry) => entry.id),
          ),
          eq(libraryPages.vaultId, vaultId),
          eq(libraryPages.structuralRole, "wiki"),
        ),
      ),
    )
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  return pages.map((page) => ({
    ...page,
    category: entryById.get(page.id)?.category ?? "Concepts",
  }));
}

async function requireCanonicalSection(
  vaultId: string,
  sectionPageId: string,
  principal: Principal,
): Promise<Library2Section> {
  const sections = await readCanonicalSections(vaultId, principal);
  const section = sections.find((candidate) => candidate.id === sectionPageId);
  if (!section) {
    throw Object.assign(
      new Error("Library2 section must be a canonical Index entry"),
      { status: 400 },
    );
  }
  return section;
}

async function readVisiblePage(pageId: string, principal: Principal) {
  const [page] = await db
    .select()
    .from(libraryPages)
    .where(visiblePages(principal, eq(libraryPages.id, pageId)))
    .limit(1);
  return page;
}

async function resolveSectionPages(
  sectionPageId: string,
  principal: Principal,
  limit: number,
) {
  const root = await readVisiblePage(sectionPageId, principal);
  if (!root) {
    throw Object.assign(new Error("Library section not found"), { status: 404 });
  }

  const pages = [root];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0 && pages.length <= limit) {
    const nextFrontier: string[] = [];
    for (
      let offset = 0;
      offset < frontier.length;
      offset += LIBRARY2_TRAVERSAL_BATCH_SIZE
    ) {
      const parentIds = frontier.slice(
        offset,
        offset + LIBRARY2_TRAVERSAL_BATCH_SIZE,
      );
      const remaining = limit + 1 - pages.length;
      if (remaining <= 0) break;
      const children = await db
        .select()
        .from(libraryPages)
        .where(visiblePages(principal, inArray(libraryPages.parentId, parentIds)))
        .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title))
        .limit(remaining);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        pages.push(child);
        nextFrontier.push(child.id);
      }
      if (pages.length > limit) break;
    }
    frontier = nextFrontier;
  }
  return pages;
}

async function resolveSourcePages(
  source: Library2ImportSource,
  principal: Principal,
  limit = LIBRARY2_IMPORT_PAGE_LIMIT,
): Promise<Array<typeof libraryPages.$inferSelect>> {
  if (source.type === "page") {
    const page = await readVisiblePage(source.pageId, principal);
    if (!page) {
      throw Object.assign(new Error("Library page not found"), { status: 404 });
    }
    return [page];
  }

  if (source.type === "vault") {
    await requireLiveVault(source.vaultId, principal as Principal & { accountId: string });
    const pages = await db
      .select()
      .from(libraryPages)
      .where(visiblePages(principal, eq(libraryPages.vaultId, source.vaultId)))
      .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title))
      .limit(limit + 1);
    if (pages.length === 0) {
      throw Object.assign(
        new Error("Source vault has no visible Library pages"),
        { status: 404 },
      );
    }
    return pages;
  }

  return resolveSectionPages(source.pageId, principal, limit);
}

function expectedImportKey(
  source: Library2ImportSource,
  vaultId: string,
  sectionPageId: string,
): string {
  const sourceId = "pageId" in source ? source.pageId : source.vaultId;
  return `library2:${source.type}:${sourceId}:${vaultId}:${sectionPageId}`;
}

export async function listLibrary2Destinations(principal: Principal) {
  requireUserPrincipal(principal);
  const liveVaults = await db
    .select()
    .from(vaults)
    .where(
      and(
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ),
    )
    .orderBy(asc(vaults.position), asc(vaults.name));
  return Promise.all(
    liveVaults.map(async (vault) => ({
      vault,
      sections: await readCanonicalSections(vault.id, principal),
    })),
  );
}

export async function suggestLibrary2Destination(
  source: Library2ImportSource,
  principal: Principal,
) {
  requireUserPrincipal(principal);
  const pages = await resolveSourcePages(source, principal, 12);
  const representative = pages[0];
  const suggestion = await placeLibraryPageSemantically(
    {
      title:
        pages.length === 1
          ? representative.title
          : pages
              .slice(0, 12)
              .map((page) => page.title)
              .join(", "),
      contentSummary: pages
        .slice(0, 12)
        .map(
          (page) =>
            page.summary ||
            page.oneLiner ||
            page.plainTextContent.slice(0, 300),
        )
        .join("\n"),
      tags: Array.from(new Set(pages.flatMap((page) => page.tags))).slice(0, 20),
    },
    principal,
  );

  const destinations = await listLibrary2Destinations(principal);
  const destination = destinations.find(
    (candidate) => candidate.vault.id === suggestion.vaultId,
  );
  const section = destination?.sections.find(
    (candidate) => candidate.id === suggestion.parentId,
  );
  return {
    vaultId: suggestion.vaultId,
    sectionPageId: section?.id ?? null,
    confidence: suggestion.confidence,
    reason: suggestion.reason,
    sourceCount: pages.length,
  };
}

export async function createLibrary2Placements(
  input: CreateLibrary2PlacementsInput,
  principal: Principal,
) {
  requireUserPrincipal(principal);
  await requireLiveVault(input.vaultId, principal);
  const section = await requireCanonicalSection(
    input.vaultId,
    input.sectionPageId,
    principal,
  );
  if (
    input.importKey !==
    expectedImportKey(input.source, input.vaultId, input.sectionPageId)
  ) {
    throw Object.assign(new Error("Library2 import key does not match the request"), {
      status: 400,
    });
  }

  const pages = await resolveSourcePages(input.source, principal);
  if (pages.length > LIBRARY2_IMPORT_PAGE_LIMIT) {
    throw Object.assign(
      new Error(
        `Library2 import is limited to ${LIBRARY2_IMPORT_PAGE_LIMIT.toLocaleString()} pages`,
      ),
      { status: 400 },
    );
  }

  const existing: Array<{
    pageId: string;
    indexSection: string;
    parentPageId: string | null;
  }> = [];
  for (
    let offset = 0;
    offset < pages.length;
    offset += LIBRARY2_TRAVERSAL_BATCH_SIZE
  ) {
    const pageIds = pages
      .slice(offset, offset + LIBRARY2_TRAVERSAL_BATCH_SIZE)
      .map((page) => page.id);
    existing.push(
      ...(await db
        .select({
          pageId: libraryPlacements.pageId,
          indexSection: libraryPlacements.indexSection,
          parentPageId: libraryPlacements.parentPageId,
        })
        .from(libraryPlacements)
        .where(
          visiblePlacements(
            principal,
            and(
              eq(libraryPlacements.vaultId, input.vaultId),
              inArray(libraryPlacements.pageId, pageIds),
            ),
          ),
        )),
    );
  }
  const alreadyPlacedPageIds = new Set(
    existing
      .filter(
        (row) =>
          row.indexSection === section.category &&
          row.parentPageId === section.id,
      )
      .map((row) => row.pageId),
  );

  await createLibraryPlacements(
    pages.map((page) => ({
      pageId: page.id,
      vaultId: input.vaultId,
      indexSection: section.category,
      parentPageId: section.id,
      placedBy: "import",
      confidence: 1,
    })),
    principal,
  );

  const replayedCount = pages.filter((page) =>
    alreadyPlacedPageIds.has(page.id),
  ).length;
  return {
    importKey: input.importKey,
    sourceCount: pages.length,
    createdCount: pages.length - replayedCount,
    replayedCount,
  };
}

export async function listLibrary2Placements(principal: Principal) {
  requireUserPrincipal(principal);
  return db
    .select({
      placementId: libraryPlacements.id,
      vaultId: libraryPlacements.vaultId,
      sectionPageId: libraryPlacements.parentPageId,
      indexSection: libraryPlacements.indexSection,
      createdAt: libraryPlacements.createdAt,
      page: libraryPages,
    })
    .from(libraryPlacements)
    .innerJoin(libraryPages, eq(libraryPlacements.pageId, libraryPages.id))
    .innerJoin(
      vaults,
      and(
        eq(libraryPlacements.vaultId, vaults.id),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ),
    )
    .where(and(visiblePlacements(principal), visiblePages(principal)))
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));
}

export async function deleteLibrary2Placement(
  placementId: string,
  principal: Principal,
) {
  requireUserPrincipal(principal);
  const deleted = await deleteLibraryPlacement(placementId, principal);
  if (!deleted) {
    throw Object.assign(new Error("Library2 placement not found"), {
      status: 404,
    });
  }
  return { id: placementId };
}

export function isLibrary2IndexSection(
  value: string,
): value is LibraryPlacementIndexSection {
  return LIBRARY_PLACEMENT_INDEX_SECTIONS.includes(
    value as LibraryPlacementIndexSection,
  );
}
