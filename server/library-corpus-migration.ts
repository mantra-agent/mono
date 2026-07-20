import { createHash } from "crypto";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { syncContentFields } from "@shared/markdown-tiptap";
import { libraryPages } from "@shared/models/info";
import { db, pool } from "./db";
import { ensureMantraLibraryVault, normalizeLibraryStructuralRole, type LibraryStructuralRole } from "./library-domain";
import { placeLibraryPageSemantically } from "./library-placement";
import { buildLibrarySurfaceSet, publishLibraryChanged, slugifyLibraryTitle } from "./library-save";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("LibraryCorpusMigration");

const INVENTORY_PAGE_LIMIT = 2_000;
const APPLY_ITEM_LIMIT = 50;

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export type LibraryCorpusMigrationOutcome = "placed" | "unchanged" | "ambiguous" | "invalid";
export type LibraryCorpusAmbiguityClass = "missing_index" | "ambiguous_index_match" | "invalid_role" | "invalid_title" | "invalid_parent" | "system_meta_page";

export interface LibraryCorpusMigrationItemProposal {
  pageId: string;
  pageTitle: string;
  contentHash: string;
  currentVaultId: string | null;
  currentParentId: string | null;
  currentStructuralRole: string | null;
  proposedVaultId: string | null;
  proposedParentId: string | null;
  proposedParentTitle: string | null;
  proposedStructuralRole: LibraryStructuralRole | null;
  outcome: LibraryCorpusMigrationOutcome;
  ambiguityClass: LibraryCorpusAmbiguityClass | null;
  reason: string;
  confidence: number;
}

export interface LibraryCorpusMigrationRunResult {
  runId: string;
  idempotencyKey: string;
  vaultId: string;
  reportPageId: string;
  status: "proposed" | "partially_applied" | "applied" | "failed";
  reviewGate: "human_review_required";
  counts: Record<LibraryCorpusMigrationOutcome, number> & { total: number };
  ambiguityClasses: Record<string, number>;
  reportRef: string;
}

function visible(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, libraryScopeColumns, predicate);
}

function writable(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, libraryScopeColumns, predicate);
}

function contentHash(page: Pick<typeof libraryPages.$inferSelect, "title" | "plainTextContent" | "updatedAt">): string {
  return createHash("sha256")
    .update(`${page.title}\n${page.updatedAt?.toISOString?.() ?? ""}\n${page.plainTextContent ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function isSamePlacement(page: typeof libraryPages.$inferSelect, proposal: LibraryCorpusMigrationItemProposal): boolean {
  return page.vaultId === proposal.proposedVaultId
    && page.parentId === proposal.proposedParentId
    && normalizeLibraryStructuralRole(page.structuralRole) === proposal.proposedStructuralRole;
}

function classifyInvalid(page: typeof libraryPages.$inferSelect): LibraryCorpusMigrationItemProposal | null {
  if (!page.title.trim()) {
    return {
      pageId: page.id,
      pageTitle: page.title || "Untitled",
      contentHash: contentHash(page),
      currentVaultId: page.vaultId,
      currentParentId: page.parentId,
      currentStructuralRole: page.structuralRole,
      proposedVaultId: null,
      proposedParentId: null,
      proposedParentTitle: null,
      proposedStructuralRole: null,
      outcome: "invalid",
      ambiguityClass: "invalid_title",
      reason: "Page has an empty title and cannot be semantically placed without human review.",
      confidence: 0,
    };
  }
  if (page.parentId === page.id) {
    return {
      pageId: page.id,
      pageTitle: page.title,
      contentHash: contentHash(page),
      currentVaultId: page.vaultId,
      currentParentId: page.parentId,
      currentStructuralRole: page.structuralRole,
      proposedVaultId: null,
      proposedParentId: null,
      proposedParentTitle: null,
      proposedStructuralRole: null,
      outcome: "invalid",
      ambiguityClass: "invalid_parent",
      reason: "Page is its own parent. Migration will not repair this autonomously.",
      confidence: 0,
    };
  }
  return null;
}

async function proposePage(page: typeof libraryPages.$inferSelect, principal: Principal): Promise<LibraryCorpusMigrationItemProposal> {
  const invalid = classifyInvalid(page);
  if (invalid) return invalid;

  const role = normalizeLibraryStructuralRole(page.structuralRole, "artifact");
  if (["Mantra", "Wiki", "Index", "Log"].includes(page.title) && role === "meta") {
    return {
      pageId: page.id,
      pageTitle: page.title,
      contentHash: contentHash(page),
      currentVaultId: page.vaultId,
      currentParentId: page.parentId,
      currentStructuralRole: page.structuralRole,
      proposedVaultId: page.vaultId,
      proposedParentId: page.parentId,
      proposedParentTitle: null,
      proposedStructuralRole: role,
      outcome: "unchanged",
      ambiguityClass: null,
      reason: "Canonical Mantra vault metadata page is already managed by the vault bootstrap.",
      confidence: 1,
    };
  }

  const placement = await placeLibraryPageSemantically({
    title: page.title,
    contentSummary: page.summary || page.oneLiner || (page.plainTextContent || "").slice(0, 500),
    pageContext: page.slug,
    tags: page.tags ?? [],
    structuralRole: role,
  }, principal);

  const proposal: LibraryCorpusMigrationItemProposal = {
    pageId: page.id,
    pageTitle: page.title,
    contentHash: contentHash(page),
    currentVaultId: page.vaultId,
    currentParentId: page.parentId,
    currentStructuralRole: page.structuralRole,
    proposedVaultId: placement.vaultId,
    proposedParentId: placement.parentId,
    proposedParentTitle: placement.parentTitle,
    proposedStructuralRole: placement.structuralRole,
    outcome: "placed",
    ambiguityClass: null,
    reason: placement.reason,
    confidence: placement.confidence,
  };

  if (placement.lint.requiresReview) {
    return {
      ...proposal,
      outcome: "ambiguous",
      ambiguityClass: placement.lint.code === "missing_index" ? "missing_index" : "ambiguous_index_match",
      reason: placement.reason,
    };
  }

  return isSamePlacement(page, proposal) ? { ...proposal, outcome: "unchanged" } : proposal;
}

function countOutcomes(items: LibraryCorpusMigrationItemProposal[]) {
  return {
    total: items.length,
    placed: items.filter(item => item.outcome === "placed").length,
    unchanged: items.filter(item => item.outcome === "unchanged").length,
    ambiguous: items.filter(item => item.outcome === "ambiguous").length,
    invalid: items.filter(item => item.outcome === "invalid").length,
  };
}

function countAmbiguityClasses(items: LibraryCorpusMigrationItemProposal[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!item.ambiguityClass) continue;
    counts[item.ambiguityClass] = (counts[item.ambiguityClass] ?? 0) + 1;
  }
  return counts;
}

function formatSection(title: string, items: LibraryCorpusMigrationItemProposal[], limit = 40): string {
  if (items.length === 0) return `## ${title}\n\nNone.\n`;
  const lines = items.slice(0, limit).map(item => {
    const proposed = item.proposedParentId ? ` → @page:${item.proposedParentId}` : "";
    const klass = item.ambiguityClass ? ` [${item.ambiguityClass}]` : "";
    return `- @page:${item.pageId} **${item.pageTitle}**${proposed}${klass} — ${item.reason}`;
  });
  const more = items.length > limit ? `\n- … ${items.length - limit} more omitted from report preview. Full proposals are in \`library_corpus_migration_items\` for this run.` : "";
  return `## ${title}\n\n${lines.join("\n")}${more}\n`;
}

async function ensureMigrationTables(): Promise<void> {
  await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS vault_id TEXT`);
  await pool.query(`ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS structural_role TEXT NOT NULL DEFAULT 'artifact'`);
  await pool.query(`ALTER TABLE library_pages DROP CONSTRAINT IF EXISTS chk_library_pages_structural_role`);
  await pool.query(`ALTER TABLE library_pages ADD CONSTRAINT chk_library_pages_structural_role CHECK (structural_role IN ('source', 'artifact', 'wiki', 'meta'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_pages_vault ON library_pages(vault_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_pages_structural_role ON library_pages(structural_role)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_corpus_migration_runs (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key TEXT NOT NULL,
      account_id TEXT,
      owner_user_id TEXT,
      vault_id TEXT,
      report_page_id TEXT REFERENCES library_pages(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      mode TEXT NOT NULL DEFAULT 'proposal',
      total_pages INTEGER NOT NULL DEFAULT 0,
      placed_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      ambiguous_count INTEGER NOT NULL DEFAULT 0,
      invalid_count INTEGER NOT NULL DEFAULT 0,
      review_gate TEXT NOT NULL DEFAULT 'human_review_required',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_library_corpus_migration_runs_status CHECK (status IN ('proposed', 'partially_applied', 'applied', 'failed')),
      CONSTRAINT chk_library_corpus_migration_runs_mode CHECK (mode IN ('proposal', 'reviewed_apply'))
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uk_library_corpus_migration_runs_owner_key
      ON library_corpus_migration_runs(account_id, owner_user_id, idempotency_key)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_corpus_migration_items (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id TEXT NOT NULL REFERENCES library_corpus_migration_runs(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
      page_title TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      current_vault_id TEXT,
      current_parent_id TEXT,
      current_structural_role TEXT,
      proposed_vault_id TEXT,
      proposed_parent_id TEXT,
      proposed_parent_title TEXT,
      proposed_structural_role TEXT,
      outcome TEXT NOT NULL,
      ambiguity_class TEXT,
      reason TEXT NOT NULL DEFAULT '',
      confidence NUMERIC NOT NULL DEFAULT 0,
      applied_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_library_corpus_migration_items_outcome CHECK (outcome IN ('placed', 'unchanged', 'ambiguous', 'invalid'))
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uk_library_corpus_migration_items_run_page
      ON library_corpus_migration_items(run_id, page_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_library_corpus_migration_items_outcome
      ON library_corpus_migration_items(run_id, outcome)
  `);
}

function buildReport(input: {
  runId: string;
  idempotencyKey: string;
  vaultId: string;
  indexPageId: string;
  items: LibraryCorpusMigrationItemProposal[];
}): string {
  const counts = countOutcomes(input.items);
  const ambiguityClasses = countAmbiguityClasses(input.items);
  return `# Library Corpus Migration Report\n\n` +
    `**Run:** ${input.runId}\n` +
    `**Idempotency key:** \`${input.idempotencyKey}\`\n` +
    `**Vault:** ${input.vaultId}\n` +
    `**Index used:** @page:${input.indexPageId}\n` +
    `**Mode:** proposal only. No destructive moves, deletions, merges, or ambiguous changes were applied.\n` +
    `**Human-review gate:** required before any application. Apply supports only explicitly reviewed placed items, bounded to ${APPLY_ITEM_LIMIT} per call.\n\n` +
    `## Counts\n\n` +
    `- Total inventoried exactly once: ${counts.total}\n` +
    `- Placed proposals: ${counts.placed}\n` +
    `- Unchanged: ${counts.unchanged}\n` +
    `- Ambiguous: ${counts.ambiguous}\n` +
    `- Invalid: ${counts.invalid}\n\n` +
    `## Named ambiguity classes\n\n` +
    (Object.keys(ambiguityClasses).length
      ? Object.entries(ambiguityClasses).map(([key, value]) => `- ${key}: ${value}`).join("\n")
      : "None.") +
    `\n\n` +
    formatSection("Placed proposals requiring review before application", input.items.filter(item => item.outcome === "placed")) + "\n" +
    formatSection("Ambiguous, not applied", input.items.filter(item => item.outcome === "ambiguous")) + "\n" +
    formatSection("Invalid, not applied", input.items.filter(item => item.outcome === "invalid")) + "\n" +
    formatSection("Unchanged sample", input.items.filter(item => item.outcome === "unchanged"), 25) + "\n" +
    `## Review gate\n\nRay must review this report and choose specific placed items for application. Ambiguous and invalid items require human classification first. Bulk deletion and silent merging are unsupported by this workflow.\n`;
}

async function findExistingRun(idempotencyKey: string, principal: Principal): Promise<LibraryCorpusMigrationRunResult | null> {
  await ensureMigrationTables();
  const { rows } = await pool.query(
    `SELECT * FROM library_corpus_migration_runs WHERE account_id IS NOT DISTINCT FROM $1 AND owner_user_id IS NOT DISTINCT FROM $2 AND idempotency_key = $3 LIMIT 1`,
    [principal.accountId ?? null, principal.userId ?? null, idempotencyKey],
  );
  const row = rows[0];
  if (!row?.report_page_id) return null;
  const ambiguity = await pool.query(
    `SELECT ambiguity_class, COUNT(*)::int AS count FROM library_corpus_migration_items WHERE run_id = $1 AND ambiguity_class IS NOT NULL GROUP BY ambiguity_class`,
    [row.id],
  );
  return {
    runId: row.id,
    idempotencyKey: row.idempotency_key,
    vaultId: row.vault_id,
    reportPageId: row.report_page_id,
    status: row.status,
    reviewGate: row.review_gate,
    counts: {
      total: row.total_pages,
      placed: row.placed_count,
      unchanged: row.unchanged_count,
      ambiguous: row.ambiguous_count,
      invalid: row.invalid_count,
    },
    ambiguityClasses: Object.fromEntries(ambiguity.rows.map((item: any) => [item.ambiguity_class, item.count])),
    reportRef: `@page:${row.report_page_id}`,
  };
}

export async function proposeLibraryCorpusMigration(input: { idempotencyKey?: string | null } = {}, principal: Principal): Promise<LibraryCorpusMigrationRunResult> {
  const idempotencyKey = input.idempotencyKey?.trim() || `library-corpus-migration:${new Date().toISOString().slice(0, 10)}`;
  const existing = await findExistingRun(idempotencyKey, principal);
  if (existing) return existing;

  await ensureMigrationTables();
  const vault = await ensureMantraLibraryVault(principal);
  const pages = await db.select().from(libraryPages).where(visible(principal)).orderBy(asc(libraryPages.pageId)).limit(INVENTORY_PAGE_LIMIT + 1);
  if (pages.length > INVENTORY_PAGE_LIMIT) {
    throw new Error(`Library corpus migration is bounded to ${INVENTORY_PAGE_LIMIT} pages per run; refusing unbounded inventory.`);
  }

  const proposals: LibraryCorpusMigrationItemProposal[] = [];
  for (const page of pages) {
    proposals.push(await proposePage(page, principal));
  }
  const counts = countOutcomes(proposals);
  const ambiguityClasses = countAmbiguityClasses(proposals);

  const { rows: runRows } = await pool.query(
    `INSERT INTO library_corpus_migration_runs (idempotency_key, account_id, owner_user_id, vault_id, status, mode, total_pages, placed_count, unchanged_count, ambiguous_count, invalid_count, review_gate)
     VALUES ($1,$2,$3,$4,'proposed','proposal',$5,$6,$7,$8,$9,'human_review_required')
     ON CONFLICT (account_id, owner_user_id, idempotency_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [idempotencyKey, principal.accountId ?? null, principal.userId ?? null, vault.vaultId, counts.total, counts.placed, counts.unchanged, counts.ambiguous, counts.invalid],
  );
  const runId = runRows[0].id as string;

  for (const item of proposals) {
    await pool.query(
      `INSERT INTO library_corpus_migration_items (run_id, page_id, page_title, content_hash, current_vault_id, current_parent_id, current_structural_role, proposed_vault_id, proposed_parent_id, proposed_parent_title, proposed_structural_role, outcome, ambiguity_class, reason, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (run_id, page_id) DO NOTHING`,
      [runId, item.pageId, item.pageTitle, item.contentHash, item.currentVaultId, item.currentParentId, item.currentStructuralRole, item.proposedVaultId, item.proposedParentId, item.proposedParentTitle, item.proposedStructuralRole, item.outcome, item.ambiguityClass, item.reason, item.confidence],
    );
  }

  const markdown = buildReport({ runId, idempotencyKey, vaultId: vault.vaultId, indexPageId: vault.indexPageId, items: proposals });
  const synced = syncContentFields({ markdown });
  const reportTitle = `Library Corpus Migration Report — ${new Date().toISOString().slice(0, 10)}`;
  const [report] = await db.insert(libraryPages).values({
    title: reportTitle,
    slug: `${slugifyLibraryTitle(reportTitle)}-${runId.slice(0, 8)}`,
    content: synced.content,
    plainTextContent: synced.plainTextContent,
    parentId: vault.logPageId,
    tags: ["library-migration", "second-brain", "review-required"],
    status: "needs_review",
    structuralRole: "meta",
    ...buildLibrarySurfaceSet({
      surface: true,
      surfaceDurationHours: 168,
      surfaceReason: "Review proposed Library corpus migration before any application.",
      surfaceSection: "inbox",
    }),
    ...ownedInsertValues(principal, libraryScopeColumns),
    vaultId: vault.vaultId,
    createdByUserId: principal.userId ?? undefined,
    updatedByUserId: principal.userId ?? undefined,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).returning();

  await pool.query(`UPDATE library_corpus_migration_runs SET report_page_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [report.id, runId]);
  publishLibraryChanged("surfaced", report);
  log.log(`[proposal] run=${runId} total=${counts.total} placed=${counts.placed} unchanged=${counts.unchanged} ambiguous=${counts.ambiguous} invalid=${counts.invalid}`);

  return {
    runId,
    idempotencyKey,
    vaultId: vault.vaultId,
    reportPageId: report.id,
    status: "proposed",
    reviewGate: "human_review_required",
    counts,
    ambiguityClasses,
    reportRef: `@page:${report.id}`,
  };
}

export async function applyReviewedLibraryCorpusMigration(input: { runId: string; itemIds: string[] }, principal: Principal): Promise<{ runId: string; applied: number; skipped: number; remainingPlaced: number }> {
  await ensureMigrationTables();
  if (!input.runId) throw new Error("runId is required");
  const itemIds = Array.from(new Set(input.itemIds.filter(Boolean))).slice(0, APPLY_ITEM_LIMIT);
  if (itemIds.length === 0) throw new Error("At least one reviewed migration item id is required");

  const { rows } = await pool.query(
    `SELECT * FROM library_corpus_migration_items WHERE run_id = $1 AND id = ANY($2::text[]) AND outcome = 'placed' AND applied_at IS NULL`,
    [input.runId, itemIds],
  );

  let applied = 0;
  let skipped = itemIds.length - rows.length;
  for (const item of rows) {
    if (!item.proposed_parent_id || !item.proposed_vault_id || !item.proposed_structural_role) {
      skipped++;
      continue;
    }
    const [page] = await db.select().from(libraryPages).where(writable(principal, eq(libraryPages.id, item.page_id))).limit(1);
    if (!page || contentHash(page) !== item.content_hash) {
      skipped++;
      continue;
    }
    await db.update(libraryPages).set({
      parentId: item.proposed_parent_id,
      vaultId: item.proposed_vault_id,
      structuralRole: normalizeLibraryStructuralRole(item.proposed_structural_role),
      updatedAt: sql`CURRENT_TIMESTAMP`,
      updatedByUserId: principal.userId ?? undefined,
    }).where(writable(principal, eq(libraryPages.id, item.page_id)));
    await pool.query(`UPDATE library_corpus_migration_items SET applied_at = CURRENT_TIMESTAMP WHERE id = $1`, [item.id]);
    applied++;
  }

  const remaining = await pool.query(`SELECT COUNT(*)::int AS count FROM library_corpus_migration_items WHERE run_id = $1 AND outcome = 'placed' AND applied_at IS NULL`, [input.runId]);
  await pool.query(
    `UPDATE library_corpus_migration_runs SET status = CASE WHEN $2::int = 0 THEN 'applied' ELSE 'partially_applied' END, mode = 'reviewed_apply', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [input.runId, remaining.rows[0]?.count ?? 0],
  );
  return { runId: input.runId, applied, skipped, remainingPlaced: remaining.rows[0]?.count ?? 0 };
}
