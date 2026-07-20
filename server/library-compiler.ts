import { createHash } from "crypto";
import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { syncContentFields } from "@shared/markdown-tiptap";
import { libraryPageLinks, libraryPages } from "@shared/models/info";
import { db } from "./db";
import { ACTIVITY_FRAMING } from "./job-profiles";
import {
  ensureMantraLibraryVault,
  normalizeLibraryStructuralRole,
  type LibraryStructuralRole,
} from "./library-domain";
import { createLogger } from "./log";
import { chatCompletion } from "./model-client";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import { markSourceChanged, registerSourceIfAbsent } from "./memory/vnext-source-queue";
import { getLibraryPageNeighbors, syncEmbeddedLibraryPageLinks } from "./library-link-graph";

const log = createLogger("LibraryCompiler");

const libraryScopeColumns = {
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

const COMPILE_LATENCY_BUDGET_MS = 45_000;
const COMPILE_INPUT_CHAR_BUDGET = 80_000;
const COMPILE_OUTPUT_TOKEN_BUDGET = 3_000;
const COMPILE_CONCURRENCY_BUDGET = 1;
const QUERY_WIKI_PAGE_LIMIT = 5;
const RELEVANT_WIKI_LIMIT = 6;

export interface LibraryCompileResult {
  sourcePageId: string;
  sourceTitle: string;
  sourceRole: LibraryStructuralRole;
  vaultId: string;
  indexPageId: string;
  logPageId: string;
  wikiPagesRead: Array<{ id: string; title: string }>;
  wikiPagesCreated: Array<{ id: string; title: string }>;
  wikiPagesUpdated: Array<{ id: string; title: string }>;
  wikiPagesUnchanged: Array<{ id: string; title: string }>;
  linksAdded: number;
  contradictions: string[];
  budgets: {
    latencyMs: number;
    latencyBudgetMs: number;
    inputCharBudget: number;
    outputTokenBudget: number;
    concurrencyBudget: number;
  };
}

export interface LibraryIndexQueryResult {
  query: string;
  vaultId: string;
  indexPageId: string;
  selectedEntries: LibraryIndexEntry[];
  wikiPages: Array<{ id: string; title: string; summary: string | null; contentPreview: string }>;
  evidencePageIds: string[];
  neighbors: Array<{ id: string; title: string; slug: string; summary: string | null; structuralRole: string; direction: "inbound" | "outbound" }>;
  fallbackUsed: boolean;
}

interface LibraryIndexEntry {
  id: string;
  title: string;
  category: "Entities" | "Concepts" | "Synthesis";
  description: string;
}

interface CompilerUpdate {
  category: "Entities" | "Concepts" | "Synthesis";
  title: string;
  summary: string;
  contentMarkdown: string;
  evidenceQuote?: string;
  relatedPageIds?: string[];
}

interface CompilerResponse {
  updates?: CompilerUpdate[];
  contradictions?: string[];
}

function visible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, libraryScopeColumns, predicate);
}

function writable(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, libraryScopeColumns, predicate);
}

function slugify(title: string, fallback = "wiki-page"): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function normalizeCategory(value: unknown): "Entities" | "Concepts" | "Synthesis" {
  const text = String(value ?? "").toLowerCase();
  if (text.startsWith("entit")) return "Entities";
  if (text.startsWith("synth")) return "Synthesis";
  return "Concepts";
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function compileMarker(sourceId: string, hash: string): string {
  return `<!-- library-compile-source:${sourceId}:${hash} -->`;
}

function parseJsonObject(text: string): CompilerResponse {
  try {
    return JSON.parse(text) as CompilerResponse;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]) as CompilerResponse;
    } catch {
      return {};
    }
  }
}

function truncate(input: string, maxChars: number): string {
  return input.length <= maxChars ? input : `${input.slice(0, maxChars)}\n\n[truncated ${input.length - maxChars} chars to stay inside Library compiler input budget]`;
}

function extractPageRefs(content: string): string[] {
  return Array.from(new Set(Array.from(content.matchAll(/@page:([A-Za-z0-9_-]+)/g)).map(m => m[1]).filter(Boolean)));
}

function parseIndexEntries(indexContent: string): LibraryIndexEntry[] {
  const entries: LibraryIndexEntry[] = [];
  let category: LibraryIndexEntry["category"] = "Concepts";
  for (const line of indexContent.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(Entities|Concepts|Synthesis)\s*$/i);
    if (heading) {
      category = normalizeCategory(heading[1]);
      continue;
    }
    const match = line.match(/^-\s+@page:([A-Za-z0-9_-]+)\s*(?:—|-|:)\s*(.+)$/);
    if (!match) continue;
    entries.push({ id: match[1], title: match[1], category, description: match[2].trim() });
  }
  return entries;
}

function scoreText(query: string, ...texts: Array<string | null | undefined>): number {
  const haystack = texts.join(" ").toLowerCase();
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 2);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function resolvePage(idOrSlug: string, principal: Principal) {
  const byId = await db.select().from(libraryPages).where(visible(principal, eq(libraryPages.id, idOrSlug))).limit(1);
  return byId[0] || (await db.select().from(libraryPages).where(visible(principal, eq(libraryPages.slug, idOrSlug))).limit(1))[0] || null;
}

async function childrenOf(parentId: string, principal: Principal) {
  return db.select().from(libraryPages).where(visible(principal, eq(libraryPages.parentId, parentId))).orderBy(asc(libraryPages.title));
}

async function selectRelevantWikiPages(input: {
  source: typeof libraryPages.$inferSelect;
  indexPage: typeof libraryPages.$inferSelect;
  wikiPageId: string;
  principal: Principal;
}) {
  const indexEntries = parseIndexEntries(input.indexPage.plainTextContent || "");
  const scored = indexEntries
    .map(entry => ({ entry, score: scoreText(`${input.source.title}\n${input.source.plainTextContent}`, entry.description, entry.id) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, RELEVANT_WIKI_LIMIT);

  const wantedIds = scored.map(item => item.entry.id);
  const directRefs = extractPageRefs(input.source.plainTextContent || "").slice(0, RELEVANT_WIKI_LIMIT);
  for (const ref of directRefs) if (!wantedIds.includes(ref)) wantedIds.push(ref);

  const pages: Array<typeof libraryPages.$inferSelect> = [];
  for (const id of wantedIds.slice(0, RELEVANT_WIKI_LIMIT)) {
    const page = await resolvePage(id, input.principal);
    if (page && page.structuralRole === "wiki") pages.push(page);
  }

  if (pages.length > 0) return pages;

  const words = input.source.title.split(/\s+/).filter(word => word.length > 3).slice(0, 4);
  const baseFilter = and(eq(libraryPages.parentId, input.wikiPageId), eq(libraryPages.structuralRole, "wiki"));
  const wordFilter = words.length
    ? and(baseFilter, or(...words.map(word => ilike(libraryPages.title, `%${word}%`))))
    : baseFilter;
  return db.select().from(libraryPages).where(visible(input.principal, wordFilter)).limit(RELEVANT_WIKI_LIMIT);
}

function buildCompilerPrompt(input: {
  source: typeof libraryPages.$inferSelect;
  sourceRef: string;
  indexContent: string;
  relevantWiki: Array<typeof libraryPages.$inferSelect>;
  sourceHash: string;
}): string {
  const wikiContext = input.relevantWiki.length
    ? input.relevantWiki.map(page => `## Existing Wiki: ${page.title}\nRef: @page:${page.id}\nSummary: ${page.summary || page.oneLiner || ""}\n\n${truncate(page.plainTextContent || "", 10_000)}`).join("\n\n")
    : "No relevant Wiki pages found. Create only stable subjects that deserve ongoing maintenance.";

  return `Compile exactly one Library Source or Artifact into the Mantra Wiki.\n\nHard rules:\n- Update existing Wiki subjects before proposing a new Wiki page.\n- Wiki pages are durable synthesized knowledge, not source summaries.\n- Source/artifact evidence remains intact. Include canonical ${input.sourceRef} in every updated page.\n- Keep Library documents separate from vNext lossy claims. Do not request a memory mirror.\n- Use only canonical @page references for evidence and related pages.\n- Return JSON only.\n\nBudgets:\n- latency budget: ${COMPILE_LATENCY_BUDGET_MS}ms\n- input budget: ${COMPILE_INPUT_CHAR_BUDGET} chars\n- output budget: ${COMPILE_OUTPUT_TOKEN_BUDGET} tokens\n- concurrency budget: ${COMPILE_CONCURRENCY_BUDGET}\n\nJSON schema:\n{\n  "updates": [\n    {\n      "category": "Entities" | "Concepts" | "Synthesis",\n      "title": "stable Wiki subject title",\n      "summary": "one concise Index line description",\n      "contentMarkdown": "complete markdown for the Wiki page, including the marker ${compileMarker(input.source.id, input.sourceHash)} and evidence reference ${input.sourceRef}",\n      "evidenceQuote": "optional short quote",\n      "relatedPageIds": ["optional-page-id"]\n    }\n  ],\n  "contradictions": ["specific contradiction or tension, empty if none"]\n}\n\nCurrent Index:\n${truncate(input.indexContent || "", 12_000)}\n\nSmallest relevant Wiki set:\n${wikiContext}\n\nSource document:\n# ${input.source.title}\nRef: ${input.sourceRef}\nRole: ${normalizeLibraryStructuralRole(input.source.structuralRole)}\nHash: ${input.sourceHash}\n\n${truncate(input.source.plainTextContent || "", 45_000)}`;
}

async function upsertWikiPage(input: {
  update: CompilerUpdate;
  principal: Principal;
  vaultId: string;
  wikiRootId: string;
  sourceId: string;
  sourceHash: string;
}): Promise<{ page: typeof libraryPages.$inferSelect; created: boolean; changed: boolean }> {
  const title = input.update.title.trim() || "Untitled Wiki Page";
  const slug = slugify(title);
  const existing = (await db.select().from(libraryPages).where(writable(input.principal, and(eq(libraryPages.parentId, input.wikiRootId), eq(libraryPages.slug, slug)))).limit(1))[0]
    || (await db.select().from(libraryPages).where(writable(input.principal, and(eq(libraryPages.parentId, input.wikiRootId), eq(libraryPages.title, title)))).limit(1))[0];
  const marker = compileMarker(input.sourceId, input.sourceHash);
  const markdown = input.update.contentMarkdown.includes(marker)
    ? input.update.contentMarkdown
    : `${input.update.contentMarkdown.trim()}\n\n${marker}`;
  const synced = syncContentFields({ markdown });
  const tags = Array.from(new Set(["wiki", "mantra", normalizeCategory(input.update.category).toLowerCase()]));

  if (existing) {
    const alreadyCompiled = (existing.plainTextContent || "").includes(marker);
    if (alreadyCompiled) {
      const [row] = await db.update(libraryPages).set({
        oneLiner: input.update.summary,
        summary: input.update.summary,
        structuralRole: "wiki",
        vaultId: input.vaultId,
        tags: Array.from(new Set([...(existing.tags ?? []), ...tags])),
        updatedAt: new Date(),
        updatedByUserId: input.principal.userId ?? undefined,
      }).where(eq(libraryPages.id, existing.id)).returning();
      return { page: row, created: false, changed: false };
    }
    const [row] = await db.update(libraryPages).set({
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      oneLiner: input.update.summary,
      summary: input.update.summary,
      structuralRole: "wiki",
      vaultId: input.vaultId,
      tags: Array.from(new Set([...(existing.tags ?? []), ...tags])),
      updatedAt: new Date(),
      updatedByUserId: input.principal.userId ?? undefined,
    }).where(eq(libraryPages.id, existing.id)).returning();
    return { page: row, created: false, changed: true };
  }

  const [maxSort] = await db.select({ maxSort: sql<number>`COALESCE(MAX(${libraryPages.sortOrder}), -1)` }).from(libraryPages).where(eq(libraryPages.parentId, input.wikiRootId));
  const [row] = await db.insert(libraryPages).values({
    title,
    slug,
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    parentId: input.wikiRootId,
    oneLiner: input.update.summary,
    summary: input.update.summary,
    tags,
    status: "compiled",
    structuralRole: "wiki",
    sortOrder: (maxSort?.maxSort ?? -1) + 1,
    ...ownedInsertValues(input.principal, libraryScopeColumns),
    vaultId: input.vaultId,
    createdByUserId: input.principal.userId ?? undefined,
    updatedByUserId: input.principal.userId ?? undefined,
  }).returning();
  return { page: row, created: true, changed: true };
}

async function refreshIndex(vault: Awaited<ReturnType<typeof ensureMantraLibraryVault>>, principal: Principal): Promise<void> {
  const wikiPages = await childrenOf(vault.wikiPageId, principal);
  const rows: Record<LibraryIndexEntry["category"], string[]> = { Entities: [], Concepts: [], Synthesis: [] };
  for (const page of wikiPages.filter(page => page.structuralRole === "wiki")) {
    const tagText = (page.tags ?? []).join(" ").toLowerCase();
    const category = tagText.includes("entities") || tagText.includes("entity")
      ? "Entities"
      : tagText.includes("synthesis")
        ? "Synthesis"
        : "Concepts";
    const description = (page.oneLiner || page.summary || "Compiled Mantra Wiki page.").replace(/\s+/g, " ").trim();
    rows[category].push(`- @page:${page.id} — ${description}`);
  }
  const markdown = `# Library Index\n\n## Entities\n${rows.Entities.sort().join("\n")}\n\n## Concepts\n${rows.Concepts.sort().join("\n")}\n\n## Synthesis\n${rows.Synthesis.sort().join("\n")}\n`;
  const synced = syncContentFields({ markdown });
  await db.update(libraryPages).set({
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    updatedAt: new Date(),
    updatedByUserId: principal.userId ?? undefined,
  }).where(writable(principal, eq(libraryPages.id, vault.indexPageId)));
}

async function appendLog(vault: Awaited<ReturnType<typeof ensureMantraLibraryVault>>, principal: Principal, entry: string, operationMarker: string): Promise<void> {
  const [logPage] = await db.select().from(libraryPages).where(writable(principal, eq(libraryPages.id, vault.logPageId))).limit(1);
  if (!logPage) throw new Error("Mantra Library Log page not found");
  if ((logPage.plainTextContent || "").includes(operationMarker)) return;
  const markdown = `${logPage.plainTextContent || "# Library Log"}\n\n${entry}\n${operationMarker}\n`;
  const synced = syncContentFields({ markdown });
  await db.update(libraryPages).set({
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    updatedAt: new Date(),
    updatedByUserId: principal.userId ?? undefined,
  }).where(eq(libraryPages.id, vault.logPageId));
}

async function linkPages(sourcePageId: string, targetPageId: string, principal: Principal): Promise<boolean> {
  const ownership = ownedInsertValues(principal, linkScopeColumns);
  const inserted = await db.insert(libraryPageLinks).values({
    sourcePageId,
    targetPageId,
    ownerUserId: ownership.ownerUserId,
    accountId: ownership.accountId,
    scope: ownership.scope,
    createdByUserId: principal.userId ?? undefined,
    updatedByUserId: principal.userId ?? undefined,
  }).onConflictDoNothing().returning({ id: libraryPageLinks.id });
  return inserted.length > 0;
}

export async function compileLibraryPageToMantraWiki(
  pageIdOrSlug: string,
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<LibraryCompileResult> {
  const started = Date.now();
  const vault = await ensureMantraLibraryVault(principal);
  const source = await resolvePage(pageIdOrSlug, principal);
  if (!source) throw new Error(`Library page not found: ${pageIdOrSlug}`);
  const role = normalizeLibraryStructuralRole(source.structuralRole);
  if (role !== "source" && role !== "artifact") {
    throw new Error(`Library compiler reads one Source or Artifact. Page ${source.id} has role ${role}.`);
  }
  if (!(source.plainTextContent || "").trim()) throw new Error(`Library page ${source.id} has no text to compile.`);

  await registerSourceIfAbsent("library_page", source.id, principal);

  const [indexPage] = await db.select().from(libraryPages).where(visible(principal, eq(libraryPages.id, vault.indexPageId))).limit(1);
  if (!indexPage) throw new Error("Mantra Library Index page not found");
  const relevantWiki = await selectRelevantWikiPages({ source, indexPage, wikiPageId: vault.wikiPageId, principal });
  const sourceHash = contentHash(`${source.title}\n${source.plainTextContent}`);
  const sourceRef = `@page:${source.id}`;
  const operationMarker = `<!-- library-compile-operation:${source.id}:${sourceHash} -->`;

  const result = await chatCompletion({
    activity: ACTIVITY_FRAMING,
    semanticTierOverride: "balanced",
    overrideReason: "Library compiler is a bounded JSON summarization workload and must not inherit session max/Codex routing",
    metadata: {
      source: "library-compiler",
      activity: ACTIVITY_FRAMING,
      sessionKey: `library-compiler:${source.id}`,
      budgets: {
        latencyMs: COMPILE_LATENCY_BUDGET_MS,
        inputChars: COMPILE_INPUT_CHAR_BUDGET,
        outputTokens: COMPILE_OUTPUT_TOKEN_BUDGET,
        concurrency: COMPILE_CONCURRENCY_BUDGET,
      },
    },
    maxTokens: COMPILE_OUTPUT_TOKEN_BUDGET,
    temperature: 0.2,
    jsonMode: true,
    messages: [
      { role: "system", content: "You are Mantra's Library Wiki compiler. Return strict JSON and preserve canonical @page references." },
      { role: "user", content: buildCompilerPrompt({ source, sourceRef, indexContent: indexPage.plainTextContent || "", relevantWiki, sourceHash }) },
    ],
  });

  const parsed = parseJsonObject(result.content);
  const updates = (parsed.updates ?? [])
    .filter(update => typeof update?.title === "string" && typeof update?.contentMarkdown === "string")
    .slice(0, 8)
    .map(update => ({ ...update, category: normalizeCategory(update.category), summary: String(update.summary || update.title).slice(0, 240) }));

  if (updates.length === 0) throw new Error("Library compiler produced no Wiki updates");

  const created: Array<{ id: string; title: string }> = [];
  const updated: Array<{ id: string; title: string }> = [];
  const unchanged: Array<{ id: string; title: string }> = [];
  let linksAdded = 0;

  for (const update of updates) {
    const upserted = await upsertWikiPage({ update, principal, vaultId: vault.vaultId, wikiRootId: vault.wikiPageId, sourceId: source.id, sourceHash });
    if (upserted.created) created.push({ id: upserted.page.id, title: upserted.page.title });
    else if (upserted.changed) updated.push({ id: upserted.page.id, title: upserted.page.title });
    else unchanged.push({ id: upserted.page.id, title: upserted.page.title });

    if (await linkPages(upserted.page.id, source.id, principal)) linksAdded++;
    await syncEmbeddedLibraryPageLinks(upserted.page.id, principal);
    for (const targetId of update.relatedPageIds ?? []) {
      if (targetId && targetId !== upserted.page.id && await linkPages(upserted.page.id, targetId, principal)) linksAdded++;
    }
    await markSourceChanged("library_page", upserted.page.id, principal);
  }

  await refreshIndex(vault, principal);
  const contradictions = (parsed.contradictions ?? []).map(String).filter(Boolean).slice(0, 10);
  const logEntry = `## [${new Date().toISOString()}] ingest | ${source.title}\n\nSource: ${sourceRef}\nCreated: ${created.map(p => `@page:${p.id}`).join(", ") || "none"}\nUpdated: ${updated.map(p => `@page:${p.id}`).join(", ") || "none"}\nUnchanged: ${unchanged.map(p => `@page:${p.id}`).join(", ") || "none"}\nContradictions: ${contradictions.length ? contradictions.join("; ") : "none"}`;
  await appendLog(vault, principal, logEntry, operationMarker);

  log.info(`compiled source=${source.id} created=${created.length} updated=${updated.length} unchanged=${unchanged.length} links=${linksAdded}`);
  return {
    sourcePageId: source.id,
    sourceTitle: source.title,
    sourceRole: role,
    vaultId: vault.vaultId,
    indexPageId: vault.indexPageId,
    logPageId: vault.logPageId,
    wikiPagesRead: relevantWiki.map(page => ({ id: page.id, title: page.title })),
    wikiPagesCreated: created,
    wikiPagesUpdated: updated,
    wikiPagesUnchanged: unchanged,
    linksAdded,
    contradictions,
    budgets: {
      latencyMs: Date.now() - started,
      latencyBudgetMs: COMPILE_LATENCY_BUDGET_MS,
      inputCharBudget: COMPILE_INPUT_CHAR_BUDGET,
      outputTokenBudget: COMPILE_OUTPUT_TOKEN_BUDGET,
      concurrencyBudget: COMPILE_CONCURRENCY_BUDGET,
    },
  };
}

export async function queryMantraLibraryIndex(
  query: string,
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<LibraryIndexQueryResult> {
  const vault = await ensureMantraLibraryVault(principal);
  const [indexPage] = await db.select().from(libraryPages).where(visible(principal, eq(libraryPages.id, vault.indexPageId))).limit(1);
  if (!indexPage) throw new Error("Mantra Library Index page not found");

  const entries = parseIndexEntries(indexPage.plainTextContent || "");
  let selected = entries
    .map(entry => ({ entry, score: scoreText(query, entry.description, entry.title, entry.id) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, QUERY_WIKI_PAGE_LIMIT)
    .map(item => item.entry);
  let fallbackUsed = false;

  if (selected.length === 0) {
    fallbackUsed = true;
    selected = (await db.select({
      id: libraryPages.id,
      title: libraryPages.title,
      summary: libraryPages.summary,
      oneLiner: libraryPages.oneLiner,
      tags: libraryPages.tags,
    }).from(libraryPages).where(visible(principal, and(eq(libraryPages.parentId, vault.wikiPageId), eq(libraryPages.structuralRole, "wiki"), or(ilike(libraryPages.title, `%${query}%`), ilike(libraryPages.summary, `%${query}%`), ilike(libraryPages.oneLiner, `%${query}%`))))).limit(QUERY_WIKI_PAGE_LIMIT))
      .map(page => ({ id: page.id, title: page.title, category: "Concepts" as const, description: page.oneLiner || page.summary || "Compiled Mantra Wiki page." }));
  }

  const wikiPages: LibraryIndexQueryResult["wikiPages"] = [];
  const evidencePageIds = new Set<string>();
  for (const entry of selected) {
    const page = await resolvePage(entry.id, principal);
    if (!page) continue;
    const content = page.plainTextContent || "";
    for (const ref of extractPageRefs(content)) {
      if (ref !== page.id) evidencePageIds.add(ref);
    }
    wikiPages.push({
      id: page.id,
      title: page.title,
      summary: page.summary || page.oneLiner || entry.description,
      contentPreview: truncate(content, 2_500),
    });
  }

  const neighbors = await getLibraryPageNeighbors(wikiPages.map((page) => page.id), principal, 20);
  for (const neighbor of neighbors) evidencePageIds.add(neighbor.id);

  return {
    query,
    vaultId: vault.vaultId,
    indexPageId: vault.indexPageId,
    selectedEntries: selected,
    wikiPages,
    evidencePageIds: Array.from(evidencePageIds).slice(0, 20),
    neighbors,
    fallbackUsed,
  };
}
