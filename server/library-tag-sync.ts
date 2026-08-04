import { tagService } from "./tag-service";
import { createLogger } from "./log";
import { semanticLibraryTags } from "@shared/library-tags";

const log = createLogger("LibraryTagSync");

// The semantic/structural boundary now lives in @shared/library-tags so the
// client tag editors share exactly one definition with this server module.
// Re-exported here for existing server importers of library-tag-sync.
export { semanticLibraryTags };

/**
 * Fire-and-forget canonical write-through for a Library page's tags. Mirrors the
 * page's semantic tags into the Postgres TagService under the `page` reference
 * type so they render as first-class @tag: chips, feed usage counts, and become
 * Tag graph nodes. Best-effort: a sync failure is logged and never blocks the
 * page write, matching the write-through pattern used by Company/Thesis storage.
 */
export function syncLibraryPageTags(
  pageId: string,
  pageTitle: string,
  tags: readonly string[] | null | undefined,
): void {
  tagService
    .replaceEntityTags("page", pageId, pageTitle, semanticLibraryTags(tags))
    .catch((err) =>
      log.warn("library tag sync failed", {
        pageId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}
