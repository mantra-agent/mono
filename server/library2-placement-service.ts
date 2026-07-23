import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  LIBRARY_PLACEMENT_INDEX_SECTIONS,
  libraryPages,
  libraryPlacements,
  type LibraryPlacementIndexSection,
} from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import { db } from "./db";
import { ensureCanonicalVaultMetadataPage } from "./library-domain";
import {
  parseLibraryIndexStructure,
  type LibraryIndexEntry,
} from "./library-index-format";
import {
  createLibraryPlacements,
  deleteLibraryPlacement,
  getLibraryPlacement,
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
  destinationId: string;
  importKey: string;
}

interface Library2Destination {
  id: string;
  title: string;
  path: string;
  depth: number;
  sortOrder: number;
  category: LibraryPlacementIndexSection;
  pageId: string | null;
  pageTitle: string | null;
  pageSlug: string | null;
  pageEmoji: string | null;
  kind: "section" | "wiki";
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

function visibleVaultIds(principal: Principal): string[] | null {
  if (principal.actorType === "system") return null;
  return principal.visibleVaultIds.length > 0
    ? principal.visibleVaultIds
    : null;
}

function vaultIsVisible(vaultId: string, principal: Principal): boolean {
  const allowedVaultIds = visibleVaultIds(principal);
  return allowedVaultIds === null || allowedVaultIds.includes(vaultId);
}

async function requireLiveVault(
  vaultId: string,
  principal: Principal & { accountId: string },
) {
  const [vault] = vaultIsVisible(vaultId, principal)
    ? await db
        .select()
        .from(vaults)
        .where(
          and(
            eq(vaults.id, vaultId),
            eq(vaults.accountId, principal.accountId),
            eq(vaults.isArchived, false),
          ),
        )
        .limit(1)
    : [];
  if (!vault) {
    throw Object.assign(new Error("Library2 vault not found or archived"), {
      status: 404,
    });
  }
  return vault;
}

function wikiDestinationId(entry: LibraryIndexEntry): string {
  return `index-wiki:${entry.id}`;
}

async function readCanonicalDestinations(
  vaultId: string,
  principal: Principal,
): Promise<Library2Destination[]> {
  const canonicalIndexPage = await ensureCanonicalVaultMetadataPage({
    principal,
    vaultId,
    kind: "index",
  });

  const structure = parseLibraryIndexStructure(
    canonicalIndexPage.plainTextContent,
  );
  if (structure.sections.length === 0) return [];

  const pages = structure.entries.length
    ? await db
        .select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          emoji: libraryPages.emoji,
        })
        .from(libraryPages)
        .where(
          visiblePages(
            principal,
            and(
              inArray(
                libraryPages.id,
                structure.entries.map((entry) => entry.id),
              ),
              eq(libraryPages.vaultId, vaultId),
              eq(libraryPages.structuralRole, "wiki"),
            ),
          ),
        )
    : [];
  const pageById = new Map(pages.map((page) => [page.id, page]));

  const sections: Library2Destination[] = structure.sections.map((section) => ({
    id: section.id,
    title: section.title,
    path: section.path,
    depth: section.depth,
    sortOrder: section.sortOrder,
    category: section.category,
    pageId: null,
    pageTitle: null,
    pageSlug: null,
    pageEmoji: null,
    kind: "section",
  }));
  const sectionByPath = new Map(
    structure.sections.map((section) => [section.path, section]),
  );
  const wikiPages = structure.entries.flatMap((entry) => {
    const page = pageById.get(entry.id);
    if (!page) return [];
    const section = entry.sectionPath
      ? sectionByPath.get(entry.sectionPath)
      : undefined;
    return [{
      id: wikiDestinationId(entry),
      title: page.title,
      path: entry.sectionPath
        ? `${entry.sectionPath} / ${page.title}`
        : page.title,
      depth: (section?.depth ?? -1) + 1,
      sortOrder: entry.sortOrder,
      category: entry.category,
      pageId: page.id,
      pageTitle: page.title,
      pageSlug: page.slug,
      pageEmoji: page.emoji,
      kind: "wiki" as const,
    }];
  });
  return [...sections, ...wikiPages].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );
}

async function requireCanonicalDestination(
  vaultId: string,
  destinationId: string,
  principal: Principal,
): Promise<Library2Destination> {
  const destinations = await readCanonicalDestinations(vaultId, principal);
  const destination = destinations.find(
    (candidate) => candidate.id === destinationId,
  );
  if (!destination) {
    throw Object.assign(
      new Error("Library2 destination must exist in the canonical Index"),
      { status: 400 },
    );
  }
  return destination;
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
  destinationId: string,
): string {
  const sourceId = "pageId" in source ? source.pageId : source.vaultId;
  return `library2:${source.type}:${sourceId}:${vaultId}:${destinationId}`;
}

export async function listLibrary2Destinations(principal: Principal) {
  requireUserPrincipal(principal);
  const allowedVaultIds = visibleVaultIds(principal);
  if (allowedVaultIds?.length === 0) return [];
  const liveVaults = await db
    .select()
    .from(vaults)
    .where(
      and(
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
        allowedVaultIds ? inArray(vaults.id, allowedVaultIds) : undefined,
      ),
    )
    .orderBy(asc(vaults.position), asc(vaults.name));
  return Promise.all(
    liveVaults.map(async (vault) => ({
      vault,
      destinations: await readCanonicalDestinations(vault.id, principal),
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
  const vaultDestination = destinations.find(
    (candidate) => candidate.vault.id === suggestion.vaultId,
  );
  const wikiDestination = vaultDestination?.destinations.find(
    (candidate) => candidate.pageId === suggestion.parentId,
  );
  const fallbackDestination = vaultDestination?.destinations.find(
    (candidate) => candidate.kind === "section",
  );
  return {
    vaultId: suggestion.vaultId,
    destinationId: wikiDestination?.id ?? fallbackDestination?.id ?? null,
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
  const destination = await requireCanonicalDestination(
    input.vaultId,
    input.destinationId,
    principal,
  );
  if (
    input.importKey !==
    expectedImportKey(input.source, input.vaultId, input.destinationId)
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
    indexPath: string | null;
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
          indexPath: libraryPlacements.indexPath,
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
          row.indexSection === destination.category &&
          row.indexPath === destination.path &&
          row.parentPageId === destination.pageId,
      )
      .map((row) => row.pageId),
  );

  await createLibraryPlacements(
    pages.map((page) => ({
      pageId: page.id,
      vaultId: input.vaultId,
      indexSection: destination.category,
      indexPath: destination.path,
      parentPageId: destination.pageId,
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
  const allowedVaultIds = visibleVaultIds(principal);
  if (allowedVaultIds?.length === 0) return [];
  return db
    .select({
      placementId: libraryPlacements.id,
      vaultId: libraryPlacements.vaultId,
      destinationPageId: libraryPlacements.parentPageId,
      indexPath: libraryPlacements.indexPath,
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
    .where(
      and(
        visiblePlacements(principal),
        visiblePages(principal),
        allowedVaultIds
          ? inArray(libraryPlacements.vaultId, allowedVaultIds)
          : undefined,
      ),
    )
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));
}

export async function deleteLibrary2Placement(
  placementId: string,
  principal: Principal,
) {
  requireUserPrincipal(principal);
  const placement = await getLibraryPlacement(placementId, principal);
  if (!placement || !vaultIsVisible(placement.vaultId, principal)) {
    throw Object.assign(new Error("Library2 placement not found"), {
      status: 404,
    });
  }
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
