import { eq, inArray, type SQL } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { db } from "./db";
import { ensureMantraLibraryVault, normalizeLibraryStructuralRole, type LibraryStructuralRole } from "./library-domain";
import { parseLibraryIndexEntries, type LibraryIndexEntry } from "./library-index-format";
import type { Principal } from "./principal";
import { combineWithVisibleScope } from "./scoped-storage";

export type LibraryPlacementOutcome = "placed" | "explicit_parent" | "review_required";

export interface LibrarySemanticPlacementInput {
  title: string;
  purpose?: string | null;
  pageContext?: string | null;
  contentSummary?: string | null;
  tags?: string[] | null;
  structuralRole?: string | null;
  explicitParentId?: string | null;
}

export interface LibrarySemanticPlacementResult {
  outcome: LibraryPlacementOutcome;
  vaultId: string;
  rootPageId: string;
  indexPageId: string;
  parentId: string;
  parentTitle: string;
  structuralRole: LibraryStructuralRole;
  confidence: number;
  reason: string;
  lint: {
    requiresReview: boolean;
    code: "none" | "ambiguous_placement" | "missing_index" | "explicit_parent";
    message: string | null;
  };
  compatibility: {
    purpose: string | null;
  };
}

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

function visible(principal: Principal, predicate: SQL) {
  return combineWithVisibleScope(principal, libraryScopeColumns, predicate);
}

function terms(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 2)));
}

function inferRole(input: LibrarySemanticPlacementInput): LibraryStructuralRole {
  const explicit = normalizeLibraryStructuralRole(input.structuralRole, "artifact");
  if (input.structuralRole) return explicit;
  const purpose = (input.purpose ?? "").toLowerCase();
  const tags = (input.tags ?? []).map(tag => tag.toLowerCase());
  if (tags.includes("source") || purpose.includes("source") || purpose.includes("capture")) return "source";
  if (tags.includes("wiki")) return "wiki";
  if (tags.includes("meta") || purpose.includes("index") || purpose.includes("lint")) return "meta";
  return "artifact";
}

function scoreEntry(queryTerms: string[], entry: LibraryIndexEntry, page?: Pick<typeof libraryPages.$inferSelect, "title" | "slug" | "plainTextContent" | "summary" | "oneLiner">): number {
  const haystack = [entry.description, entry.category, page?.title, page?.slug, page?.summary, page?.oneLiner, page?.plainTextContent?.slice(0, 1000)].join(" ").toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function readPages(ids: string[], principal: Principal) {
  if (ids.length === 0) return [];
  return db.select().from(libraryPages).where(visible(principal, inArray(libraryPages.id, ids)));
}

export async function placeLibraryPageSemantically(input: LibrarySemanticPlacementInput, principal: Principal): Promise<LibrarySemanticPlacementResult> {
  const vault = await ensureMantraLibraryVault(principal);
  const structuralRole = inferRole(input);

  if (input.explicitParentId) {
    const [parent] = await db.select().from(libraryPages).where(visible(principal, eq(libraryPages.id, input.explicitParentId))).limit(1);
    if (!parent) throw new Error("Explicit Library parent is not visible");
    return {
      outcome: "explicit_parent",
      vaultId: parent.vaultId ?? vault.vaultId,
      rootPageId: vault.rootPageId,
      indexPageId: vault.indexPageId,
      parentId: parent.id,
      parentTitle: parent.title,
      structuralRole,
      confidence: 1,
      reason: "Caller supplied an explicit parent; semantic placement records the decision but does not override human-selected structure.",
      lint: { requiresReview: false, code: "explicit_parent", message: null },
      compatibility: { purpose: input.purpose ?? null },
    };
  }

  const [indexPage] = await db.select().from(libraryPages).where(visible(principal, eq(libraryPages.id, vault.indexPageId))).limit(1);
  const indexContent = indexPage?.plainTextContent ?? "";
  const entries = parseLibraryIndexEntries(indexContent);

  if (entries.length === 0) {
    return {
      outcome: "review_required",
      vaultId: vault.vaultId,
      rootPageId: vault.rootPageId,
      indexPageId: vault.indexPageId,
      parentId: vault.rootPageId,
      parentTitle: "Mantra",
      structuralRole,
      confidence: 0,
      reason: "The vault Index has no wiki entries, so semantic placement cannot infer a meaningful location.",
      lint: { requiresReview: true, code: "missing_index", message: "Library placement requires Index entries before automatic filing." },
      compatibility: { purpose: input.purpose ?? null },
    };
  }

  const pageRows = await readPages(entries.map(entry => entry.id), principal);
  const pageById = new Map(pageRows.map(page => [page.id, page]));
  const queryTerms = terms([input.title, input.contentSummary, input.pageContext, input.purpose, ...(input.tags ?? [])].filter(Boolean).join(" "));
  const ranked = entries
    .map(entry => ({ entry, page: pageById.get(entry.id), score: scoreEntry(queryTerms, entry, pageById.get(entry.id)) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  const confidence = queryTerms.length === 0 ? 0 : best.score / Math.max(queryTerms.length, 1);
  const isConfident = best?.page && best.score >= 2 && (!second || best.score > second.score);

  if (!isConfident) {
    return {
      outcome: "review_required",
      vaultId: vault.vaultId,
      rootPageId: vault.rootPageId,
      indexPageId: vault.indexPageId,
      parentId: vault.rootPageId,
      parentTitle: "Mantra",
      structuralRole,
      confidence,
      reason: second && best.score === second.score
        ? `Ambiguous placement between ${best.entry.id} and ${second.entry.id}.`
        : "No Index entry matched the document strongly enough for automatic placement.",
      lint: { requiresReview: true, code: "ambiguous_placement", message: "Saved at the vault root with review-required placement metadata; this is lint residue, not a final filing location." },
      compatibility: { purpose: input.purpose ?? null },
    };
  }

  return {
    outcome: "placed",
    vaultId: vault.vaultId,
    rootPageId: vault.rootPageId,
    indexPageId: vault.indexPageId,
    parentId: best.page.id,
    parentTitle: best.page.title,
    structuralRole,
    confidence,
    reason: `Matched vault Index entry @page:${best.page.id}: ${best.entry.description}`,
    lint: { requiresReview: false, code: "none", message: null },
    compatibility: { purpose: input.purpose ?? null },
  };
}
