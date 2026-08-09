import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { parseReferenceText } from "@shared/reference-parser";
import { libraryPageLinks, libraryPages } from "@shared/models/info";
import { db } from "./db";
import { libraryPageIsLive } from "./library-trash";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("LibraryLinkGraph");

const pageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};
const linkScopeColumns = {
  scope: libraryPageLinks.scope,
  ownerUserId: libraryPageLinks.ownerUserId,
  accountId: libraryPageLinks.accountId,
};

function visible(principal: Principal, predicate?: SQL): SQL {
  const notTrashed = libraryPageIsLive();
  return combineWithVisibleScope(principal, pageScopeColumns, predicate ? and(predicate, notTrashed) : notTrashed);
}

function visibleLinks(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, linkScopeColumns, predicate);
}

function writableLinks(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, linkScopeColumns, predicate);
}

export function extractEmbeddedPageReferenceIds(content: string | null | undefined): string[] {
  const refs = parseReferenceText(content || "")
    .filter((part): part is { kind: "reference"; ref: { type: string; id: string } } => part.kind === "reference" && part.ref.type === "page")
    .map((part) => part.ref.id)
    .filter(Boolean);
  return Array.from(new Set(refs));
}

async function resolveVisiblePageIds(idsOrSlugs: string[], principal: Principal): Promise<Set<string>> {
  const wanted = Array.from(new Set(idsOrSlugs.filter(Boolean)));
  if (!wanted.length) return new Set();
  const rows = await db.select({ id: libraryPages.id, slug: libraryPages.slug })
    .from(libraryPages)
    .where(visible(principal, or(inArray(libraryPages.id, wanted), inArray(libraryPages.slug, wanted))));
  const resolved = new Set<string>();
  for (const row of rows) {
    resolved.add(row.id);
    if (wanted.includes(row.slug)) resolved.add(row.id);
  }
  return resolved;
}

export async function syncEmbeddedLibraryPageLinks(pageId: string, principal: Principal = requireCurrentUserPrincipal()): Promise<{ pageId: string; refsFound: number; linksInserted: number; linksRemoved: number; brokenRefs: string[] }> {
  const [page] = await db.select({ id: libraryPages.id, plainTextContent: libraryPages.plainTextContent })
    .from(libraryPages)
    .where(visible(principal, eq(libraryPages.id, pageId)))
    .limit(1);
  if (!page) throw new Error(`Library page not found: ${pageId}`);

  const rawRefs = extractEmbeddedPageReferenceIds(page.plainTextContent).filter((id) => id !== page.id);
  const validTargetIds = await resolveVisiblePageIds(rawRefs, principal);
  const validRefs = Array.from(validTargetIds).filter((id) => id !== page.id);
  const brokenRefs = rawRefs.filter((id) => !validTargetIds.has(id));
  const existing = await db.select({ targetPageId: libraryPageLinks.targetPageId })
    .from(libraryPageLinks)
    .where(visibleLinks(principal, eq(libraryPageLinks.sourcePageId, page.id)));
  const existingTargets = new Set(existing.map((link) => link.targetPageId));
  const desiredTargets = new Set(validRefs);

  const ownership = ownedInsertValues(principal, linkScopeColumns);
  let linksInserted = 0;
  for (const targetPageId of desiredTargets) {
    if (existingTargets.has(targetPageId)) continue;
    const inserted = await db.insert(libraryPageLinks).values({
      sourcePageId: page.id,
      targetPageId,
      ...ownership,
      createdByUserId: principal.userId ?? undefined,
      updatedByUserId: principal.userId ?? undefined,
    }).onConflictDoNothing().returning({ id: libraryPageLinks.id });
    linksInserted += inserted.length;
  }

  const staleTargets = Array.from(existingTargets).filter((targetId) => !desiredTargets.has(targetId));
  let linksRemoved = 0;
  if (staleTargets.length) {
    const removed = await db.delete(libraryPageLinks)
      .where(writableLinks(principal, and(eq(libraryPageLinks.sourcePageId, page.id), inArray(libraryPageLinks.targetPageId, staleTargets))))
      .returning({ id: libraryPageLinks.id });
    linksRemoved = removed.length;
  }

  if (linksInserted || linksRemoved || brokenRefs.length) {
    log.info(`synced page=${page.id} refs=${rawRefs.length} inserted=${linksInserted} removed=${linksRemoved} broken=${brokenRefs.length}`);
  }
  return { pageId: page.id, refsFound: rawRefs.length, linksInserted, linksRemoved, brokenRefs };
}

export interface LibraryLinkNeighbor {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  structuralRole: string;
  direction: "inbound" | "outbound";
}

export async function getLibraryPageNeighbors(pageIds: string[], principal: Principal = requireCurrentUserPrincipal(), limit = 20): Promise<LibraryLinkNeighbor[]> {
  const ids = Array.from(new Set(pageIds.filter(Boolean))).slice(0, 50);
  if (!ids.length) return [];
  const outbound = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug, summary: libraryPages.summary, structuralRole: libraryPages.structuralRole })
    .from(libraryPageLinks)
    .innerJoin(libraryPages, eq(libraryPageLinks.targetPageId, libraryPages.id))
    .where(visibleLinks(principal, and(inArray(libraryPageLinks.sourcePageId, ids), libraryPageIsLive())))
    .limit(limit);
  const inbound = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug, summary: libraryPages.summary, structuralRole: libraryPages.structuralRole })
    .from(libraryPageLinks)
    .innerJoin(libraryPages, eq(libraryPageLinks.sourcePageId, libraryPages.id))
    .where(visibleLinks(principal, and(inArray(libraryPageLinks.targetPageId, ids), libraryPageIsLive())))
    .limit(limit);
  const seen = new Set<string>();
  const rows: LibraryLinkNeighbor[] = [];
  for (const row of outbound) {
    const key = `outbound:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, direction: "outbound" });
  }
  for (const row of inbound) {
    const key = `inbound:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, direction: "inbound" });
  }
  return rows.slice(0, limit);
}
