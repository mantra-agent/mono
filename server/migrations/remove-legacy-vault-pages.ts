import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { users } from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { syncContentFields } from "@shared/markdown-tiptap";
import { db, pool } from "../db";
import {
  CANONICAL_LIBRARY_INDEX_BOOTSTRAP_MARKDOWN,
  type CanonicalLibraryMetadataKind,
} from "../library-domain";
import { createLogger } from "../log";
import { moveLibraryPage } from "../library-move";
import { createUserSessionPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
} from "../scoped-storage";

const log = createLogger("RemoveLegacyVaultPages");
const MIGRATION_KEY = "remove-legacy-vault-pages-v1";
const RAY_OWNER_USER_ID = "f6de5710-5f8a-4e91-afa2-c673a997ce2d";
const RAY_ACCOUNT_ID = "1d52cbc6-d922-4afd-b5e8-0eeeb5babd47";
const MIGRATION_LOCK_KEY = `migration.${MIGRATION_KEY}.${RAY_ACCOUNT_ID}`;
const VAULT_NAMES = ["Personal", "Mantra", "Enklu", "Tive"] as const;
const MARKER_NAMES = ["Personal", "Enklu", "Tive"] as const;

const EXPLICIT_CONTENT_DESTINATIONS = [
  { id: "f1a8a83a-5d37-4fae-8de2-623b14d8a08f", vault: "Enklu", parent: "root" },
  { id: "9995754c-3d28-43c3-a3f4-329adbdf1a9c", vault: "Enklu", parent: "wiki" },
  { id: "00b2a44a-1dca-4090-bc14-d529db75300f", vault: "Enklu", parent: "wiki" },
  { id: "b045edfc-6c06-492b-9e04-864b5bd18af2", vault: "Tive", parent: "root" },
  { id: "8a48e12d-9262-436c-a4e2-b526290c7995", vault: "Tive", parent: "root" },
  { id: "4fbc8132-61ef-407a-8a83-87b6e84ce1b9", vault: "Tive", parent: "root" },
  { id: "b8cc1a12-e7bc-4ab4-ac9f-0b9385b5fc6b", vault: "Tive", parent: "wiki" },
] as const;

const pageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

const metadataDefinitions: Record<CanonicalLibraryMetadataKind, {
  title: string;
  tag: string;
  tags: string[];
  bootstrap: string[];
  sortOrder: number;
}> = {
  index: {
    title: "Index",
    tag: "library-index",
    tags: ["library-index", "library-meta"],
    bootstrap: [
      CANONICAL_LIBRARY_INDEX_BOOTSTRAP_MARKDOWN,
      "# Library Index\n\n## Entities\n\n## Concepts\n\n## Synthesis\n\nThis semantic catalog lists compiled Wiki pages only. It is intentionally empty until ingest creates or updates Wiki pages.",
    ],
    sortOrder: 0,
  },
  wiki: {
    title: "Wiki",
    tag: "wiki",
    tags: ["wiki", "library-meta"],
    bootstrap: [
      "# Wiki\n\nAgent-maintained compiled knowledge for this vault.",
      "# Wiki\n\nAgent-maintained compiled knowledge for the Personal vault.",
      "# Wiki\n\nAgent-maintained compiled knowledge for the Enklu vault.",
      "# Wiki\n\nAgent-maintained compiled knowledge for the Tive vault.",
      "# Wiki\n\nAgent-maintained compiled knowledge for the Mantra vault. Entity, Concept, and Synthesis pages live under this section.",
    ],
    sortOrder: 1,
  },
  log: {
    title: "Log",
    tag: "library-log",
    tags: ["library-log", "library-meta"],
    bootstrap: [],
    sortOrder: 2,
  },
};

type Page = typeof libraryPages.$inferSelect;
type VaultName = (typeof VAULT_NAMES)[number];

type ManifestEntry = Pick<Page,
  | "id"
  | "title"
  | "slug"
  | "content"
  | "plainTextContent"
  | "parentId"
  | "tags"
  | "status"
  | "surface"
  | "surfaceUntil"
  | "surfaceReason"
  | "surfaceSection"
  | "sortOrder"
  | "scope"
  | "ownerUserId"
  | "accountId"
  | "vaultId"
  | "structuralRole"
>;

function visible(principal: Principal, predicate = sql`TRUE`) {
  return combineWithVisibleScope(principal, pageScopeColumns, predicate);
}

function writable(principal: Principal, predicate = sql`TRUE`) {
  return combineWithWritableScope(principal, pageScopeColumns, predicate);
}

function normalizedContent(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function isBootstrapContent(page: Page, kind: CanonicalLibraryMetadataKind): boolean {
  const normalized = normalizedContent(page.plainTextContent);
  if (kind === "log") {
    return normalized.startsWith("# Library Log") && normalized.includes("## Bootstrap");
  }
  return metadataDefinitions[kind].bootstrap.some(
    (candidate) => normalizedContent(candidate) === normalized,
  );
}

function kindFor(page: Page): CanonicalLibraryMetadataKind | null {
  const tags = page.tags ?? [];
  if (tags.includes("library-index")) return "index";
  if (tags.includes("library-log")) return "log";
  if (tags.includes("wiki") && tags.includes("library-meta")) return "wiki";
  return null;
}

function requireExactOwnedPage(page: Page, label: string): void {
  if (
    page.scope !== "user" ||
    page.ownerUserId !== RAY_OWNER_USER_ID ||
    page.accountId !== RAY_ACCOUNT_ID
  ) {
    throw new Error(`${label} failed exact Ray ownership guard`);
  }
}

async function readRayPrincipal(): Promise<Principal> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, RAY_OWNER_USER_ID))
    .limit(1);
  if (!user) throw new Error("Ray user not found for Library vault repair");
  const principal = await createUserSessionPrincipal(user);
  if (principal.accountId !== RAY_ACCOUNT_ID) {
    throw new Error("Ray account identity changed; Library vault repair refused");
  }
  return principal;
}

async function readVaultMap(): Promise<Record<VaultName, string>> {
  const rows = await db
    .select({ id: vaults.id, name: vaults.name })
    .from(vaults)
    .where(
      and(
        eq(vaults.accountId, RAY_ACCOUNT_ID),
        eq(vaults.isArchived, false),
        inArray(vaults.name, [...VAULT_NAMES]),
      ),
    );
  const map = Object.fromEntries(rows.map((row) => [row.name, row.id])) as Partial<Record<VaultName, string>>;
  for (const name of VAULT_NAMES) {
    if (!map[name]) throw new Error(`Required ${name} Vault is missing or archived`);
  }
  if (rows.length !== VAULT_NAMES.length) {
    throw new Error("Library vault repair found duplicate required Vault names");
  }
  return map as Record<VaultName, string>;
}

async function readMigrationRecord(): Promise<{ status: string; manifest: ManifestEntry[] } | null> {
  const result = await pool.query(
    `SELECT status, manifest FROM library_vault_identity_migrations
     WHERE migration_key = $1 AND owner_user_id = $2 AND account_id = $3`,
    [MIGRATION_KEY, RAY_OWNER_USER_ID, RAY_ACCOUNT_ID],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    status: String(row.status),
    manifest: Array.isArray(row.manifest) ? row.manifest as ManifestEntry[] : [],
  };
}

async function readMigrationStatus(): Promise<string | null> {
  return (await readMigrationRecord())?.status ?? null;
}

async function captureManifest(principal: Principal): Promise<void> {
  const existing = await readMigrationRecord();
  if (existing && existing.manifest.length > 0) {
    if (existing.status === "failed") {
      await pool.query(
        `UPDATE library_vault_identity_migrations
         SET status = 'running', error = NULL, completed_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE migration_key = $1 AND owner_user_id = $2 AND account_id = $3`,
        [MIGRATION_KEY, RAY_OWNER_USER_ID, RAY_ACCOUNT_ID],
      );
    }
    return;
  }
  const pages = await db
    .select()
    .from(libraryPages)
    .where(
      visible(
        principal,
        and(
          eq(libraryPages.ownerUserId, RAY_OWNER_USER_ID),
          eq(libraryPages.accountId, RAY_ACCOUNT_ID),
          eq(libraryPages.scope, "user"),
        ),
      ),
    )
    .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id));
  const candidateIds = new Set(EXPLICIT_CONTENT_DESTINATIONS.map((item) => item.id));
  const taggedMarkers = pages.filter((page) => (page.tags ?? []).includes("library-vault"));
  const markerIds = new Set(taggedMarkers.map((page) => page.id));
  const touched = pages.filter((page) =>
    candidateIds.has(page.id) ||
    markerIds.has(page.id) ||
    (page.parentId && markerIds.has(page.parentId)) ||
    (page.structuralRole === "meta" && ["Index", "Wiki", "Log"].includes(page.title)),
  );
  const manifest: ManifestEntry[] = touched.map((page) => ({
    id: page.id,
    title: page.title,
    slug: page.slug,
    content: page.content,
    plainTextContent: page.plainTextContent,
    parentId: page.parentId,
    tags: page.tags,
    status: page.status,
    surface: page.surface,
    surfaceUntil: page.surfaceUntil,
    surfaceReason: page.surfaceReason,
    surfaceSection: page.surfaceSection,
    sortOrder: page.sortOrder,
    scope: page.scope,
    ownerUserId: page.ownerUserId,
    accountId: page.accountId,
    vaultId: page.vaultId,
    structuralRole: page.structuralRole,
  }));
  await pool.query(
    `INSERT INTO library_vault_identity_migrations
      (migration_key, scope, owner_user_id, account_id, status, manifest, started_at, updated_at)
     VALUES ($1, 'user', $2, $3, 'running', $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (migration_key, owner_user_id, account_id) DO UPDATE
     SET status = 'running', manifest = EXCLUDED.manifest, error = NULL,
         completed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE library_vault_identity_migrations.status = 'failed'
       AND library_vault_identity_migrations.manifest = '[]'::jsonb`,
    [MIGRATION_KEY, RAY_OWNER_USER_ID, RAY_ACCOUNT_ID, JSON.stringify(manifest)],
  );
}

async function readMarkers(principal: Principal, mantraVaultId: string): Promise<Record<VaultName, Page>> {
  const liveMarkers = await db
    .select()
    .from(libraryPages)
    .where(
      visible(
        principal,
        and(
          eq(libraryPages.ownerUserId, RAY_OWNER_USER_ID),
          eq(libraryPages.accountId, RAY_ACCOUNT_ID),
          eq(libraryPages.scope, "user"),
          eq(libraryPages.vaultId, mantraVaultId),
          sql`'library-vault' = ANY(${libraryPages.tags})`,
          inArray(libraryPages.title, [...VAULT_NAMES]),
        ),
      ),
    )
    .orderBy(asc(libraryPages.createdAt));
  if (liveMarkers.length > VAULT_NAMES.length) {
    throw new Error("Legacy Vault marker set is ambiguous; repair refused");
  }
  const manifest = (await readMigrationRecord())?.manifest ?? [];
  const markerSnapshots = manifest.filter((page) =>
    VAULT_NAMES.includes(page.title as VaultName) &&
    (page.tags ?? []).includes("library-vault") &&
    page.vaultId === mantraVaultId,
  );
  const byName = Object.fromEntries(
    [...markerSnapshots, ...liveMarkers].map((page) => [page.title, page]),
  ) as Partial<Record<VaultName, Page>>;
  for (const name of VAULT_NAMES) {
    if (!byName[name]) throw new Error(`Legacy ${name} marker identity is absent from live state and manifest`);
  }
  return byName as Record<VaultName, Page>;
}

async function normalizeMantraFolder(
  principal: Principal,
  page: Page,
  mantraVaultId: string,
): Promise<void> {
  const [livePage] = await db
    .select()
    .from(libraryPages)
    .where(visible(principal, eq(libraryPages.id, page.id)))
    .limit(1);
  if (!livePage) throw new Error("Mantra folder was deleted; repair refused");
  requireExactOwnedPage(livePage, "Mantra folder");
  if (livePage.title !== "Mantra" || livePage.vaultId !== mantraVaultId || livePage.parentId !== null) {
    throw new Error("Mantra folder identity drifted; repair refused");
  }
  if (!(livePage.tags ?? []).includes("library-vault")) {
    if (livePage.structuralRole === "artifact") return;
    throw new Error("Mantra folder partially normalized; repair refused");
  }
  const tags = (livePage.tags ?? []).filter((tag) => tag !== "vault" && tag !== "library-vault");
  const [updated] = await db
    .update(libraryPages)
    .set({
      tags,
      structuralRole: "artifact",
      updatedByUserId: RAY_OWNER_USER_ID,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      writable(
        principal,
        and(
          eq(libraryPages.id, livePage.id),
          eq(libraryPages.title, livePage.title),
          eq(libraryPages.parentId, livePage.parentId),
          eq(libraryPages.vaultId, livePage.vaultId),
          eq(libraryPages.plainTextContent, livePage.plainTextContent),
          eq(libraryPages.tags, livePage.tags),
        ),
      ),
    )
    .returning({ id: libraryPages.id });
  if (!updated) throw new Error("Mantra folder exact update guard failed");
}

async function readMetadataCandidates(
  principal: Principal,
  vaultId: string,
  markerId: string,
  kind: CanonicalLibraryMetadataKind,
): Promise<Page[]> {
  const definition = metadataDefinitions[kind];
  return db
    .select()
    .from(libraryPages)
    .where(
      visible(
        principal,
        and(
          eq(libraryPages.ownerUserId, RAY_OWNER_USER_ID),
          eq(libraryPages.accountId, RAY_ACCOUNT_ID),
          eq(libraryPages.scope, "user"),
          eq(libraryPages.structuralRole, "meta"),
          sql`${definition.tag} = ANY(${libraryPages.tags})`,
          sql`(${libraryPages.vaultId} = ${vaultId} OR ${libraryPages.parentId} = ${markerId})`,
        ),
      ),
    )
    .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id));
}

function chooseCanonicalMetadata(
  candidates: Page[],
  markerId: string,
  kind: CanonicalLibraryMetadataKind,
): Page {
  if (candidates.length === 0) throw new Error(`No ${kind} metadata candidate found`);
  const root = candidates.filter((page) => page.parentId === null);
  const rich = candidates.filter((page) => !isBootstrapContent(page, kind));
  if (kind === "index") {
    const distinctRich = new Set(rich.map((page) => normalizedContent(page.plainTextContent)));
    if (distinctRich.size > 1) throw new Error("Distinct non-template Indexes require manual reconciliation");
    return root.find((page) => !isBootstrapContent(page, kind)) ?? rich[0] ?? root[0] ?? candidates[0];
  }
  if (kind === "log") return root[0] ?? candidates[0];
  return root[0] ?? candidates.find((page) => page.parentId === markerId) ?? candidates[0];
}

async function moveChildrenToCanonical(
  principal: Principal,
  source: Page,
  canonical: Page,
  destinationVaultId: string,
): Promise<void> {
  const children = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(visible(principal, eq(libraryPages.parentId, source.id)))
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.id));
  for (const child of children) {
    if (child.id === canonical.id) continue;
    await moveLibraryPage(
      {
        pageId: child.id,
        destinationParentId: canonical.id,
        destinationVaultId,
      },
      principal,
    );
  }
}

async function deleteExactScaffold(
  principal: Principal,
  page: Page,
  allowedAfterMerge: boolean,
): Promise<void> {
  const [child] = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(visible(principal, eq(libraryPages.parentId, page.id)))
    .limit(1);
  if (child) throw new Error(`Scaffold ${page.id} still has children`);
  const kind = kindFor(page);
  if (kind && !allowedAfterMerge && !isBootstrapContent(page, kind)) {
    throw new Error(`Non-template metadata ${page.id} was not merged; deletion refused`);
  }
  const deleted = await db
    .delete(libraryPages)
    .where(
      writable(
        principal,
        and(
          eq(libraryPages.id, page.id),
          eq(libraryPages.title, page.title),
          page.parentId === null
            ? isNull(libraryPages.parentId)
            : eq(libraryPages.parentId, page.parentId),
          page.vaultId === null
            ? isNull(libraryPages.vaultId)
            : eq(libraryPages.vaultId, page.vaultId),
          eq(libraryPages.plainTextContent, page.plainTextContent),
          eq(libraryPages.tags, page.tags),
          sql`NOT EXISTS (SELECT 1 FROM library_pages child WHERE child.parent_id = ${page.id})`,
        ),
      ),
    )
    .returning({ id: libraryPages.id });
  if (deleted.length !== 1) throw new Error(`Scaffold ${page.id} exact delete guard failed`);
}

async function consolidateMetadataKind(
  principal: Principal,
  vaultId: string,
  markerId: string,
  kind: CanonicalLibraryMetadataKind,
): Promise<Page> {
  const definition = metadataDefinitions[kind];
  const candidates = await readMetadataCandidates(principal, vaultId, markerId, kind);
  if (candidates.length === 0) {
    const { ensureCanonicalVaultMetadataPage } = await import("../library-domain");
    return ensureCanonicalVaultMetadataPage({ principal, vaultId, kind });
  }
  let canonical = chooseCanonicalMetadata(candidates, markerId, kind);
  requireExactOwnedPage(canonical, `${kind} canonical metadata`);

  if (kind === "log") {
    const segments = candidates
      .map((page) => normalizedContent(page.plainTextContent))
      .filter(Boolean);
    const mergedSegments: string[] = [];
    for (const segment of segments) {
      if (!mergedSegments.some((existing) => existing.includes(segment))) mergedSegments.push(segment);
    }
    const migrationEntry = `## Legacy vault-page migration\n\nMigration: ${MIGRATION_KEY}\nManifest: library_vault_identity_migrations\nVault: ${vaultId}`;
    if (!mergedSegments.some((segment) => segment.includes(`Migration: ${MIGRATION_KEY}`))) {
      mergedSegments.push(migrationEntry);
    }
    const markdown = mergedSegments.join("\n\n");
    const synced = syncContentFields({ markdown });
    const [updated] = await db
      .update(libraryPages)
      .set({
        content: synced.content,
        plainTextContent: synced.plainTextContent,
        updatedByUserId: RAY_OWNER_USER_ID,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(writable(principal, eq(libraryPages.id, canonical.id)))
      .returning();
    canonical = updated;
  } else {
    const richSource = candidates.find((page) => !isBootstrapContent(page, kind));
    if (richSource && isBootstrapContent(canonical, kind)) {
      const synced = syncContentFields({ markdown: richSource.plainTextContent });
      const [updated] = await db
        .update(libraryPages)
        .set({
          content: synced.content,
          plainTextContent: synced.plainTextContent,
          updatedByUserId: RAY_OWNER_USER_ID,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          writable(
            principal,
            and(
              eq(libraryPages.id, canonical.id),
              eq(libraryPages.plainTextContent, canonical.plainTextContent),
            ),
          ),
        )
        .returning();
      if (!updated) throw new Error(`${kind} content adoption guard failed`);
      canonical = updated;
    }
  }

  for (const source of candidates) {
    if (source.id !== canonical.id) {
      await moveChildrenToCanonical(principal, source, canonical, vaultId);
    }
  }

  const tags = Array.from(new Set([...(canonical.tags ?? []), ...definition.tags]))
    .filter((tag) => tag !== "library-placement-review" && tag !== "library-vault" && tag !== "vault");
  const [normalized] = await db
    .update(libraryPages)
    .set({
      title: definition.title,
      slug: definition.title.toLowerCase(),
      parentId: null,
      vaultId,
      structuralRole: "meta",
      tags,
      status: canonical.status === "needs_review" ? null : canonical.status,
      surface: false,
      surfaceUntil: null,
      surfaceReason: null,
      surfaceSection: null,
      sortOrder: definition.sortOrder,
      updatedByUserId: RAY_OWNER_USER_ID,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(writable(principal, eq(libraryPages.id, canonical.id)))
    .returning();
  if (!normalized) throw new Error(`${kind} canonical metadata normalization failed`);
  canonical = normalized;

  for (const loser of candidates) {
    if (loser.id === canonical.id) continue;
    await deleteExactScaffold(principal, loser, kind === "log" || normalizedContent(loser.plainTextContent) === normalizedContent(canonical.plainTextContent));
  }

  return canonical;
}

async function moveExplicitContent(
  principal: Principal,
  vaultMap: Record<VaultName, string>,
  wikiByVault: Partial<Record<VaultName, Page>>,
): Promise<void> {
  for (const item of EXPLICIT_CONTENT_DESTINATIONS) {
    const [page] = await db
      .select()
      .from(libraryPages)
      .where(visible(principal, eq(libraryPages.id, item.id)))
      .limit(1);
    if (!page) continue;
    requireExactOwnedPage(page, `content ${item.id}`);
    const destinationVaultId = vaultMap[item.vault];
    const destinationParentId = item.parent === "wiki"
      ? wikiByVault[item.vault]?.id ?? null
      : null;
    if (item.parent === "wiki" && !destinationParentId) {
      throw new Error(`${item.vault} canonical Wiki is unavailable`);
    }
    if (page.vaultId === destinationVaultId && page.parentId === destinationParentId) continue;
    await moveLibraryPage(
      {
        pageId: page.id,
        destinationParentId,
        destinationVaultId,
      },
      principal,
    );
  }
}

async function moveMarkerContent(
  principal: Principal,
  marker: Page,
  destinationVaultId: string,
): Promise<void> {
  const children = await db
    .select()
    .from(libraryPages)
    .where(visible(principal, eq(libraryPages.parentId, marker.id)))
    .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.id));
  for (const child of children) {
    if (kindFor(child)) continue;
    requireExactOwnedPage(child, `marker child ${child.id}`);
    await moveLibraryPage(
      {
        pageId: child.id,
        destinationParentId: null,
        destinationVaultId,
      },
      principal,
    );
  }
}

async function deleteMarker(principal: Principal, marker: Page): Promise<void> {
  const [liveMarker] = await db
    .select()
    .from(libraryPages)
    .where(visible(principal, eq(libraryPages.id, marker.id)))
    .limit(1);
  if (!liveMarker) return;
  requireExactOwnedPage(liveMarker, `${liveMarker.title} marker`);
  if (!(liveMarker.tags ?? []).includes("library-vault")) {
    throw new Error(`${liveMarker.title} marker lost legacy classification before deletion`);
  }
  await deleteExactScaffold(principal, liveMarker, true);
}

async function assertCanonicalMetadata(
  principal: Principal,
  vaultMap: Record<VaultName, string>,
): Promise<void> {
  for (const vaultId of Object.values(vaultMap)) {
    for (const kind of Object.keys(metadataDefinitions) as CanonicalLibraryMetadataKind[]) {
      const definition = metadataDefinitions[kind];
      const rows = await db
        .select({ id: libraryPages.id, parentId: libraryPages.parentId })
        .from(libraryPages)
        .where(
          visible(
            principal,
            and(
              eq(libraryPages.vaultId, vaultId),
              eq(libraryPages.structuralRole, "meta"),
              sql`${definition.tag} = ANY(${libraryPages.tags})`,
            ),
          ),
        );
      if (rows.length !== 1 || rows[0].parentId !== null) {
        throw new Error(`Vault ${vaultId} does not have exactly one root ${kind}`);
      }
    }
  }
  const legacyRows = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(
      visible(
        principal,
        and(
          eq(libraryPages.ownerUserId, RAY_OWNER_USER_ID),
          eq(libraryPages.accountId, RAY_ACCOUNT_ID),
          sql`'library-vault' = ANY(${libraryPages.tags})`,
        ),
      ),
    );
  if (legacyRows.length > 0) throw new Error("Legacy library-vault tags remain after migration");
}

async function markComplete(): Promise<void> {
  await pool.query(
    `UPDATE library_vault_identity_migrations
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP, error = NULL
     WHERE migration_key = $1 AND owner_user_id = $2 AND account_id = $3`,
    [MIGRATION_KEY, RAY_OWNER_USER_ID, RAY_ACCOUNT_ID],
  );
}

async function markFailed(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
  await pool.query(
    `INSERT INTO library_vault_identity_migrations
      (migration_key, scope, owner_user_id, account_id, status, manifest, error, started_at, updated_at)
     VALUES ($1, 'user', $2, $3, 'failed', '[]'::jsonb, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (migration_key, owner_user_id, account_id) DO UPDATE
     SET status = 'failed', updated_at = CURRENT_TIMESTAMP, error = EXCLUDED.error`,
    [MIGRATION_KEY, RAY_OWNER_USER_ID, RAY_ACCOUNT_ID, message],
  );
}

/**
 * Bounded repair of Ray's July 21 shadow-adoption residue.
 *
 * Replay model: one account-scoped session lock serializes replicas; the
 * before-state manifest is captured once and preserved across retries; every
 * move is idempotent through the canonical move boundary; metadata selection
 * is deterministic; delete guards include the exact row snapshot and no-child
 * predicate; and terminal assertions precede the durable completed marker.
 * This repair runs post-ready because one account's prerequisite drift must
 * never become a universal service-availability dependency.
 */
export async function removeLegacyVaultPages(): Promise<void> {
  if (await readMigrationStatus() === "completed") return;
  const lockClient = await pool.connect();
  let lockHeld = false;

  try {
    const lock = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [MIGRATION_LOCK_KEY],
    );
    lockHeld = lock.rows[0]?.acquired === true;
    if (!lockHeld) {
      log.info("Legacy Library Vault repair already owned by another replica", {
        migrationKey: MIGRATION_KEY,
        accountId: RAY_ACCOUNT_ID,
      });
      return;
    }
    if (await readMigrationStatus() === "completed") return;

    const principal = await readRayPrincipal();
    const vaultMap = await readVaultMap();
    principal.visibleVaultIds = Object.values(vaultMap);
    principal.activeVaultId = vaultMap.Mantra;

    await runWithPrincipal(principal, async () => {
      await captureManifest(principal);
      const markers = await readMarkers(principal, vaultMap.Mantra);
      await normalizeMantraFolder(principal, markers.Mantra, vaultMap.Mantra);

      const wikiByVault: Partial<Record<VaultName, Page>> = {};
      for (const name of MARKER_NAMES) {
        const marker = markers[name];
        const [liveMarker] = await db
          .select()
          .from(libraryPages)
          .where(visible(principal, eq(libraryPages.id, marker.id)))
          .limit(1);
        if (liveMarker) await moveMarkerContent(principal, liveMarker, vaultMap[name]);
        await consolidateMetadataKind(principal, vaultMap[name], marker.id, "index");
        wikiByVault[name] = await consolidateMetadataKind(principal, vaultMap[name], marker.id, "wiki");
        await consolidateMetadataKind(principal, vaultMap[name], marker.id, "log");
      }

      await moveExplicitContent(principal, vaultMap, wikiByVault);
      for (const name of MARKER_NAMES) await deleteMarker(principal, markers[name]);

      // Mantra metadata was stranded under the ordinary Mantra folder. The
      // canonical bootstrap now finds it by kind tag and normalizes it to root.
      const { ensureMantraLibraryVault } = await import("../library-domain");
      await ensureMantraLibraryVault(principal);
      await assertCanonicalMetadata(principal, vaultMap);
      await markComplete();
    });
    log.info("Legacy Library Vault pages removed", {
      migrationKey: MIGRATION_KEY,
      accountId: RAY_ACCOUNT_ID,
    });
  } catch (error) {
    await markFailed(error).catch(() => undefined);
    throw error;
  } finally {
    if (lockHeld) {
      await lockClient.query(
        `SELECT pg_advisory_unlock(hashtext($1))`,
        [MIGRATION_LOCK_KEY],
      ).catch(() => undefined);
    }
    lockClient.release();
  }
}
