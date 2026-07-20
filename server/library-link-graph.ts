import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { parseReferenceText } from "@shared/reference-parser";
import { libraryPageLinks, libraryPages } from "@shared/models/info";
import { syncContentFields } from "@shared/markdown-tiptap";
import { db } from "./db";
import { ensureMantraLibraryVault } from "./library-domain";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
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

const LINT_PAGE_LIMIT = 2_000;
const LINT_DUPLICATE_GROUP_LIMIT = 50;
const LINT_ISSUE_SAMPLE_LIMIT = 80;

function visible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, pageScopeColumns, predicate);
}

function writable(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, pageScopeColumns, predicate);
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

export async function syncEmbeddedLibraryPageLinks(pageId: string, principal: Principal = getCurrentPrincipalOrSystem()): Promise<{ pageId: string; refsFound: number; linksInserted: number; linksRemoved: number; brokenRefs: string[] }> {
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

export async function getLibraryPageNeighbors(pageIds: string[], principal: Principal = getCurrentPrincipalOrSystem(), limit = 20): Promise<LibraryLinkNeighbor[]> {
  const ids = Array.from(new Set(pageIds.filter(Boolean))).slice(0, 50);
  if (!ids.length) return [];
  const outbound = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug, summary: libraryPages.summary, structuralRole: libraryPages.structuralRole })
    .from(libraryPageLinks)
    .innerJoin(libraryPages, eq(libraryPageLinks.targetPageId, libraryPages.id))
    .where(visibleLinks(principal, inArray(libraryPageLinks.sourcePageId, ids)))
    .limit(limit);
  const inbound = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug, summary: libraryPages.summary, structuralRole: libraryPages.structuralRole })
    .from(libraryPageLinks)
    .innerJoin(libraryPages, eq(libraryPageLinks.sourcePageId, libraryPages.id))
    .where(visibleLinks(principal, inArray(libraryPageLinks.targetPageId, ids)))
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

export interface LibraryLintIssue {
  code: string;
  severity: "failure" | "review" | "warning";
  pageId?: string;
  title?: string;
  detail: string;
}

export interface LibraryLintReport {
  generatedAt: string;
  vaultId: string;
  checkedPages: number;
  checkedLinks: number;
  counts: Record<string, number>;
  failures: number;
  reviewItems: number;
  warnings: number;
  repaired: { staleEdgesRemoved: number; missingEdgesInserted: number };
  issues: LibraryLintIssue[];
}

function issue(list: LibraryLintIssue[], item: LibraryLintIssue) {
  if (list.length < LINT_ISSUE_SAMPLE_LIMIT) list.push(item);
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function pathFor(pageId: string | null, byId: Map<string, { id: string; title: string; parentId: string | null }>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = pageId;
  while (current && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    const page = byId.get(current)!;
    path.unshift(page.title);
    current = page.parentId;
  }
  return path;
}

export async function runLibraryLint(input: { repair?: boolean; surfaceReport?: boolean } = {}, principal: Principal = getCurrentPrincipalOrSystem()): Promise<LibraryLintReport & { reportPageId?: string }> {
  const vault = await ensureMantraLibraryVault(principal);
  const pages = await db.select({
    id: libraryPages.id,
    title: libraryPages.title,
    slug: libraryPages.slug,
    parentId: libraryPages.parentId,
    plainTextContent: libraryPages.plainTextContent,
    structuralRole: libraryPages.structuralRole,
    vaultId: libraryPages.vaultId,
    summary: libraryPages.summary,
    oneLiner: libraryPages.oneLiner,
    tags: libraryPages.tags,
    status: libraryPages.status,
    surface: libraryPages.surface,
  }).from(libraryPages).where(visible(principal, eq(libraryPages.vaultId, vault.vaultId))).orderBy(asc(libraryPages.title)).limit(LINT_PAGE_LIMIT);
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const pagePathById = new Map(pages.map((page) => [page.id, { id: page.id, title: page.title, parentId: page.parentId }]));
  const links = await db.select().from(libraryPageLinks).where(visibleLinks(principal)).orderBy(desc(libraryPageLinks.createdAt)).limit(5_000);
  const issues: LibraryLintIssue[] = [];
  const counts: Record<string, number> = {};
  const add = (code: string, severity: LibraryLintIssue["severity"], detail: string, page?: typeof pages[number]) => {
    counts[code] = (counts[code] ?? 0) + 1;
    issue(issues, { code, severity, detail, pageId: page?.id, title: page?.title });
  };

  let missingEdgesInserted = 0;
  let staleEdgesRemoved = 0;
  const linkKey = (source: string, target: string) => `${source}->${target}`;
  const existingKeys = new Set(links.map((link) => linkKey(link.sourcePageId, link.targetPageId)));
  const desiredKeys = new Set<string>();
  const ownership = ownedInsertValues(principal, linkScopeColumns);

  for (const page of pages) {
    if (!page.title.trim()) add("empty_title", "failure", "Page has no title.", page);
    if (!(page.plainTextContent || "").trim() && ![vault.wikiPageId, vault.indexPageId, vault.logPageId].includes(page.id)) add("empty_page", "warning", "Page has no plaintext content.", page);
    if (!page.vaultId) add("missing_vault", "failure", "Page has no vault membership.", page);
    if (!page.structuralRole) add("missing_role", "failure", "Page has no structural role.", page);
    if (page.surface || (page.tags ?? []).includes("library-placement-review") || page.status === "needs_review") add("inbox_residue", "failure", "Page remains surfaced or marked for Library placement review.", page);

    const path = pathFor(page.parentId, pagePathById).join(" / ").toLowerCase();
    if (page.structuralRole === "wiki" && !path.includes("wiki") && page.id !== vault.wikiPageId) add("role_location_mismatch", "review", "Wiki page is not under the vault Wiki subtree.", page);
    if (page.structuralRole === "meta" && ![vault.indexPageId, vault.logPageId, vault.vaultId, vault.wikiPageId].includes(page.id)) add("role_location_mismatch", "review", "Meta page is not one of the vault metadata pages.", page);

    const refs = extractEmbeddedPageReferenceIds(page.plainTextContent).filter((targetId) => targetId !== page.id);
    for (const target of refs) {
      const targetPage = pageById.get(target) || pages.find((candidate) => candidate.slug === target);
      if (!targetPage) {
        add("broken_link", "failure", `Embedded reference @page:${target} does not resolve inside this vault.`, page);
        continue;
      }
      desiredKeys.add(linkKey(page.id, targetPage.id));
      if (!existingKeys.has(linkKey(page.id, targetPage.id))) {
        add("missing_edge", "warning", `Embedded reference @page:${target} is missing its projected edge.`, page);
        if (input.repair) {
          const inserted = await db.insert(libraryPageLinks).values({ sourcePageId: page.id, targetPageId: targetPage.id, ...ownership, createdByUserId: principal.userId ?? undefined, updatedByUserId: principal.userId ?? undefined }).onConflictDoNothing().returning({ id: libraryPageLinks.id });
          missingEdgesInserted += inserted.length;
        }
      }
    }
  }

  for (const link of links) {
    if (!pageById.has(link.sourcePageId) || !pageById.has(link.targetPageId)) add("broken_projected_edge", "failure", `Projected edge ${link.sourcePageId} -> ${link.targetPageId} points to an absent page.`);
    if (pageById.has(link.sourcePageId) && pageById.has(link.targetPageId) && !desiredKeys.has(linkKey(link.sourcePageId, link.targetPageId))) {
      add("stale_edge", "warning", `Projected edge ${link.sourcePageId} -> ${link.targetPageId} is no longer embedded in source content.`);
      if (input.repair) {
        const removed = await db.delete(libraryPageLinks).where(writableLinks(principal, and(eq(libraryPageLinks.sourcePageId, link.sourcePageId), eq(libraryPageLinks.targetPageId, link.targetPageId)))).returning({ id: libraryPageLinks.id });
        staleEdgesRemoved += removed.length;
      }
    }
  }

  const indexPage = pageById.get(vault.indexPageId);
  const indexRefs = new Set(extractEmbeddedPageReferenceIds(indexPage?.plainTextContent || ""));
  for (const page of pages.filter((p) => p.structuralRole === "wiki" && p.id !== vault.wikiPageId)) {
    if (!indexRefs.has(page.id) && !indexRefs.has(page.slug)) add("missing_index_entry", "failure", "Wiki page is missing from the vault Index.", page);
    const inbound = links.some((link) => link.targetPageId === page.id);
    if (!inbound && page.id !== vault.indexPageId) add("orphaned_wiki", "review", "Wiki page has no inbound Library links.", page);
    const description = page.oneLiner || page.summary || "";
    if (indexPage?.plainTextContent?.includes(`@page:${page.id}`) && description && !indexPage.plainTextContent.includes(description.slice(0, 40))) add("stale_index_entry", "review", "Index entry may be stale against the Wiki summary.", page);
  }

  const byTitle = new Map<string, Array<typeof pages[number]>>();
  for (const page of pages) {
    const key = normalizeTitle(page.title);
    if (!key) continue;
    const group = byTitle.get(key) ?? [];
    group.push(page);
    byTitle.set(key, group);
  }
  for (const group of Array.from(byTitle.values()).filter((items) => items.length > 1).slice(0, LINT_DUPLICATE_GROUP_LIMIT)) {
    add("duplicate_title", "review", `Likely duplicate title across ${group.length} pages: ${group.map((p) => `@page:${p.id}`).join(", ")}`, group[0]);
  }

  const failures = issues.filter((i) => i.severity === "failure").length + Math.max(0, (counts.failure ?? 0) - issues.filter((i) => i.severity === "failure").length);
  const reviewItems = Object.entries(counts).filter(([code]) => issues.find((i) => i.code === code)?.severity === "review").reduce((sum, [, count]) => sum + count, 0);
  const warnings = Object.entries(counts).filter(([code]) => issues.find((i) => i.code === code)?.severity === "warning").reduce((sum, [, count]) => sum + count, 0);
  const report: LibraryLintReport = {
    generatedAt: new Date().toISOString(),
    vaultId: vault.vaultId,
    checkedPages: pages.length,
    checkedLinks: links.length,
    counts,
    failures,
    reviewItems,
    warnings,
    repaired: { staleEdgesRemoved, missingEdgesInserted },
    issues,
  };

  if (!input.surfaceReport) return report;
  const markdown = renderLibraryLintReport(report);
  const synced = syncContentFields({ markdown });
  const [created] = await db.insert(libraryPages).values({
    title: `Library Lint Report — ${new Date().toISOString().slice(0, 10)}`,
    slug: `library-lint-report-${Date.now()}`,
    parentId: vault.logPageId,
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    tags: ["library-lint", "second-brain", failures > 0 ? "failure" : "report"],
    status: failures > 0 ? "needs_review" : "complete",
    structuralRole: "meta",
    surface: true,
    surfaceUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    surfaceReason: "Review final Library Second Brain lint results and residual gaps.",
    surfaceSection: "inbox",
    ...ownedInsertValues(principal, pageScopeColumns),
    vaultId: vault.vaultId,
    createdByUserId: principal.userId ?? undefined,
    updatedByUserId: principal.userId ?? undefined,
  }).returning({ id: libraryPages.id });
  return { ...report, reportPageId: created.id };
}

export function renderLibraryLintReport(report: LibraryLintReport): string {
  const issueLines = report.issues.length
    ? report.issues.map((i) => `- **${i.severity} / ${i.code}**${i.pageId ? ` @page:${i.pageId}` : ""}: ${i.detail}`).join("\n")
    : "- No sampled issues.";
  const countLines = Object.entries(report.counts).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `- ${code}: ${count}`).join("\n") || "- none";
  return `# Library Lint Report\n\nGenerated: ${report.generatedAt}\nVault: @page:${report.vaultId}\n\n## Verdict\n\n${report.failures > 0 ? "Failure: residual Library issues remain and require review." : "Pass: no failure-class issues found in the bounded lint run."}\n\n## Counts\n\n- Pages checked: ${report.checkedPages}\n- Projected links checked: ${report.checkedLinks}\n- Failures: ${report.failures}\n- Review items: ${report.reviewItems}\n- Warnings: ${report.warnings}\n- Mechanical repairs: inserted ${report.repaired.missingEdgesInserted}, removed ${report.repaired.staleEdgesRemoved}\n\n## Issue classes\n\n${countLines}\n\n## Sampled issues\n\n${issueLines}\n\n## Scope\n\nBounded lint checked at most ${LINT_PAGE_LIMIT} pages and ${LINT_ISSUE_SAMPLE_LIMIT} sampled issues. Automatic repair is limited to deterministic projected-edge insertion/removal derived from embedded canonical @page references. Moves, merges, deletions, and substantive rewrites remain human review work.\n`;
}
