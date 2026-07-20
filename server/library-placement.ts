import { and, eq, inArray, type SQL } from "drizzle-orm";
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

export const LIBRARY_PLACEMENT_POLICY = {
  minimumMatchedTerms: 2,
  minimumScore: 12,
  minimumScoreMargin: 4,
  minimumScoreRatio: 1.35,
} as const;

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

const GENERIC_TERMS = new Set([
  "about", "agent", "architecture", "artifact", "based", "canonical", "content", "current", "data",
  "design", "document", "draft", "feature", "from", "into", "mantra", "model", "notes", "page", "plan", "process",
  "product", "project", "report", "review", "spec", "system", "that", "this", "through", "using", "with",
]);

function visible(principal: Principal, predicate: SQL) {
  return combineWithVisibleScope(principal, libraryScopeColumns, predicate);
}

function normalizeTerm(term: string): string {
  if (term.endsWith("ies") && term.length > 5) return `${term.slice(0, -3)}y`;
  if (term.endsWith("s") && !term.endsWith("ss") && term.length > 4) return term.slice(0, -1);
  return term;
}

function terms(text: string): Set<string> {
  return new Set(text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 2 && !/^\d+$/.test(term))
    .map(normalizeTerm)
    .filter(term => !GENERIC_TERMS.has(term)));
}

function addWeightedTerms(target: Map<string, number>, text: string | null | undefined, weight: number): void {
  for (const term of terms(text ?? "")) target.set(term, Math.max(target.get(term) ?? 0, weight));
}

function sourceTerms(input: LibrarySemanticPlacementInput): { weights: Map<string, number>; anchorTerms: Set<string> } {
  const weights = new Map<string, number>();
  const titleTerms = terms(input.title);
  const tagTerms = terms((input.tags ?? []).join(" "));
  addWeightedTerms(weights, input.title, 5);
  addWeightedTerms(weights, (input.tags ?? []).join(" "), 5);
  addWeightedTerms(weights, input.contentSummary, 2);
  addWeightedTerms(weights, input.purpose, 2);
  addWeightedTerms(weights, input.pageContext, 1);
  return { weights, anchorTerms: new Set([...titleTerms, ...tagTerms]) };
}

function destinationTerms(entry: LibraryIndexEntry, page: Pick<typeof libraryPages.$inferSelect, "title" | "slug" | "summary" | "oneLiner">) {
  return {
    title: terms(`${page.title} ${page.slug}`),
    description: terms(`${entry.description} ${entry.category} ${page.summary ?? ""} ${page.oneLiner ?? ""}`),
  };
}

function scoreEntry(source: ReturnType<typeof sourceTerms>, entry: LibraryIndexEntry, page: Pick<typeof libraryPages.$inferSelect, "title" | "slug" | "summary" | "oneLiner">) {
  const destination = destinationTerms(entry, page);
  const matchedTerms: string[] = [];
  let score = 0;
  let anchored = false;

  for (const [term, weight] of source.weights) {
    if (!destination.title.has(term) && !destination.description.has(term)) continue;
    matchedTerms.push(term);
    score += weight + (destination.title.has(term) ? 2 : 0);
    if (source.anchorTerms.has(term)) anchored = true;
  }

  return { score, matchedTerms, anchored };
}

async function readEligibleWikiPages(ids: string[], wikiPageId: string, principal: Principal) {
  if (ids.length === 0) return [];
  return db.select().from(libraryPages).where(visible(principal, and(
    inArray(libraryPages.id, ids),
    eq(libraryPages.parentId, wikiPageId),
    eq(libraryPages.structuralRole, "wiki"),
  )));
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
  const entries = parseLibraryIndexEntries(indexPage?.plainTextContent ?? "");

  if (entries.length === 0) {
    return reviewRequired(vault, structuralRole, input, 0,
      "The vault Index has no wiki entries, so semantic placement cannot infer a meaningful location.", "missing_index");
  }

  const pageRows = await readEligibleWikiPages(entries.map(entry => entry.id), vault.wikiPageId, principal);
  const pageById = new Map(pageRows.map(page => [page.id, page]));
  const source = sourceTerms(input);
  const ranked = entries
    .filter(entry => pageById.has(entry.id))
    .map(entry => {
      const page = pageById.get(entry.id)!;
      return { entry, page, ...scoreEntry(source, entry, page) };
    })
    .sort((a, b) => b.score - a.score || b.matchedTerms.length - a.matchedTerms.length);

  if (ranked.length === 0) {
    return reviewRequired(vault, structuralRole, input, 0,
      "The vault Index contains no eligible direct Wiki destinations.", "missing_index");
  }

  const best = ranked[0];
  const second = ranked[1];
  const margin = best.score - (second?.score ?? 0);
  const ratio = second?.score ? best.score / second.score : Number.POSITIVE_INFINITY;
  const matchedWeight = best.matchedTerms.reduce((total, term) => total + (source.weights.get(term) ?? 0), 0);
  const totalWeight = Array.from(source.weights.values()).reduce((total, weight) => total + weight, 0);
  const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  const separation = best.score > 0 ? Math.max(0, Math.min(1, margin / best.score)) : 0;
  const confidence = Number(Math.min(0.99, coverage * 0.65 + separation * 0.35).toFixed(3));
  const isConfident = best.anchored
    && best.matchedTerms.length >= LIBRARY_PLACEMENT_POLICY.minimumMatchedTerms
    && best.score >= LIBRARY_PLACEMENT_POLICY.minimumScore
    && margin >= LIBRARY_PLACEMENT_POLICY.minimumScoreMargin
    && ratio >= LIBRARY_PLACEMENT_POLICY.minimumScoreRatio;

  if (!isConfident) {
    const runnerUp = second ? `; runner-up @page:${second.page.id} scored ${second.score}` : "";
    return reviewRequired(
      vault,
      structuralRole,
      input,
      confidence,
      `No credible Index destination. Best @page:${best.page.id} scored ${best.score} on [${best.matchedTerms.join(", ") || "none"}]${runnerUp}; required anchored terms=${LIBRARY_PLACEMENT_POLICY.minimumMatchedTerms}, score=${LIBRARY_PLACEMENT_POLICY.minimumScore}, margin=${LIBRARY_PLACEMENT_POLICY.minimumScoreMargin}, ratio=${LIBRARY_PLACEMENT_POLICY.minimumScoreRatio}.`,
      "ambiguous_placement",
    );
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
    reason: `Matched vault Index entry @page:${best.page.id} on [${best.matchedTerms.join(", ")}], score ${best.score}, margin ${margin}: ${best.entry.description}`,
    lint: { requiresReview: false, code: "none", message: null },
    compatibility: { purpose: input.purpose ?? null },
  };
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

function reviewRequired(
  vault: Awaited<ReturnType<typeof ensureMantraLibraryVault>>,
  structuralRole: LibraryStructuralRole,
  input: LibrarySemanticPlacementInput,
  confidence: number,
  reason: string,
  code: "ambiguous_placement" | "missing_index",
): LibrarySemanticPlacementResult {
  return {
    outcome: "review_required",
    vaultId: vault.vaultId,
    rootPageId: vault.rootPageId,
    indexPageId: vault.indexPageId,
    parentId: vault.rootPageId,
    parentTitle: "Mantra",
    structuralRole,
    confidence,
    reason,
    lint: {
      requiresReview: true,
      code,
      message: "Saved at the vault root with review-required placement metadata; this is lint residue, not a final filing location.",
    },
    compatibility: { purpose: input.purpose ?? null },
  };
}
