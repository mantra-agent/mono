import { sql } from "drizzle-orm";
import { acquireLibraryParentLocks, db } from "./db";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { placeLibraryPageSemantically, type LibrarySemanticPlacementResult } from "./library-placement";
import { markSourceChanged } from "./memory/vnext-source-queue";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { ownedInsertValues } from "./scoped-storage";
import { libraryPages } from "@shared/models/info";
import { syncEmbeddedLibraryPageLinks } from "./library-link-graph";
import { syncContentFields } from "@shared/markdown-tiptap";
import type { LibraryStructuralRole } from "./library-domain";

export interface CreateFiledLibraryPageInput {
  title: string;
  markdown: string;
  purpose?: string | null;
  explicitParentId?: string | null;
  pageContext?: string | null;
  contentSummary?: string | null;
  tags?: string[];
  status?: string | null;
  structuralRole?: LibraryStructuralRole | null;
  createdBySessionId?: string | null;
  id?: string;
  slugSuffix?: string | null;
  surface?: boolean;
  surfaceDurationHours?: number;
  surfaceReason?: string | null;
  surfaceSection?: string | null;
}

export type CreatedFiledLibraryPage = typeof libraryPages.$inferSelect & {
  filingResolution: LibrarySemanticPlacementResult;
};

const log = createLogger("LibrarySave");

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export function slugifyLibraryTitle(title: string, fallback = "page"): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

export function buildLibrarySurfaceSet(input: {
  surface?: boolean;
  surfaceDurationHours?: number;
  surfaceReason?: string | null;
  surfaceSection?: string | null;
}): Partial<typeof libraryPages.$inferInsert> {
  if (input.surface === false) {
    return { surface: false, surfaceUntil: null, surfaceReason: null, surfaceSection: null };
  }
  if (input.surface === true && typeof input.surfaceDurationHours === "number" && input.surfaceDurationHours > 0) {
    return {
      surface: true,
      surfaceUntil: new Date(Date.now() + input.surfaceDurationHours * 60 * 60 * 1000),
      surfaceReason: input.surfaceReason ?? null,
      surfaceSection: input.surfaceSection ?? "inbox",
    };
  }
  return {};
}

export function publishLibraryChanged(action: string, page?: { id?: string | null; title?: string | null; surface?: boolean | null; surfaceUntil?: Date | string | null }) {
  eventBus.publish({
    category: "system",
    event: "data:library_changed",
    payload: {
      source: "library_service",
      action,
      pageId: page?.id ?? null,
      title: page?.title ?? null,
      surface: page?.surface ?? null,
      surfaceUntil: page?.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : (page?.surfaceUntil ?? null),
    },
  });
}

export async function createFiledLibraryPage(input: CreateFiledLibraryPageInput): Promise<CreatedFiledLibraryPage> {
  const principal = getCurrentPrincipalOrSystem();
  const filingResolution = await placeLibraryPageSemantically({
    purpose: input.purpose ?? null,
    pageContext: input.pageContext ?? null,
    title: input.title,
    contentSummary: input.contentSummary ?? input.markdown.slice(0, 500),
    tags: input.tags ?? [],
    structuralRole: input.structuralRole ?? null,
    explicitParentId: input.explicitParentId ?? null,
  }, principal);
  const synced = syncContentFields({ markdown: input.markdown });
  const slugBase = slugifyLibraryTitle(input.title, "page");
  const slug = input.slugSuffix ? `${slugBase}-${input.slugSuffix}` : slugBase;

  const page = await db.transaction(async (tx) => {
    await acquireLibraryParentLocks(tx, [filingResolution.parentId]);
    const [row] = await tx.insert(libraryPages).values({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      slug,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId: filingResolution.parentId,
      tags: Array.from(new Set([...(input.tags ?? []), ...(filingResolution.lint.requiresReview ? ["library-placement-review"] : [])])),
      status: filingResolution.lint.requiresReview ? (input.status ?? "needs_review") : (input.status ?? null),
      structuralRole: filingResolution.structuralRole,
      createdBySessionId: input.createdBySessionId ?? null,
      ...buildLibrarySurfaceSet(input),
      ...ownedInsertValues(principal, libraryScopeColumns),
      vaultId: filingResolution.vaultId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).returning();
    return row;
  });

  try {
    await syncEmbeddedLibraryPageLinks(page.id, principal);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[links] error source=library sourceId=${page.id} reason=embedded_link_sync_failed error=${message}`);
  }

  try {
    await markSourceChanged("library_page", page.id, principal);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[ingest] error source=library sourceId=${page.id} reason=filed_create_sync_failed error=${message}`);
  }

  publishLibraryChanged(page.surface ? "surfaced" : "created", page);
  return { ...page, filingResolution };
}
