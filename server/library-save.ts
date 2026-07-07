import { sql } from "drizzle-orm";
import { acquireLibraryParentLocks, db } from "./db";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { resolveLibraryParentFromContext, type LibraryParentResolution } from "./library-index";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { ownedInsertValues } from "./scoped-storage";
import { libraryPages } from "@shared/models/info";
import { syncContentFields } from "@shared/markdown-tiptap";

export interface CreateFiledLibraryPageInput {
  title: string;
  markdown: string;
  purpose: string;
  pageContext?: string | null;
  contentSummary?: string | null;
  tags?: string[];
  status?: string | null;
  createdBySessionId?: string | null;
  slugSuffix?: string | null;
  surface?: boolean;
  surfaceDurationHours?: number;
  surfaceReason?: string | null;
  surfaceSection?: string | null;
}

export type CreatedFiledLibraryPage = typeof libraryPages.$inferSelect & {
  filingResolution: LibraryParentResolution;
};

const log = createLogger("LibrarySave");

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
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
  const filingResolution = await resolveLibraryParentFromContext({
    purpose: input.purpose,
    pageContext: input.pageContext ?? null,
    title: input.title,
    contentSummary: input.contentSummary ?? input.markdown.slice(0, 500),
    tags: input.tags ?? [],
  });
  const synced = syncContentFields({ markdown: input.markdown });
  const slugBase = slugifyLibraryTitle(input.title, filingResolution.filingKey || "page");
  const slug = input.slugSuffix ? `${slugBase}-${input.slugSuffix}` : slugBase;

  const page = await db.transaction(async (tx) => {
    await acquireLibraryParentLocks(tx, [filingResolution.parentId]);
    const [row] = await tx.insert(libraryPages).values({
      title: input.title,
      slug,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId: filingResolution.parentId,
      tags: input.tags ?? [],
      status: input.status ?? null,
      createdBySessionId: input.createdBySessionId ?? null,
      ...buildLibrarySurfaceSet(input),
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), libraryScopeColumns),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).returning();
    return row;
  });

  try {
    const { upsertLibraryPageMemory } = await import("./routes/library");
    await upsertLibraryPageMemory(page);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[ingest] error source=library sourceId=${page.id} reason=filed_create_sync_failed error=${message}`);
  }

  publishLibraryChanged(page.surface ? "surfaced" : "created", page);
  return { ...page, filingResolution };
}
