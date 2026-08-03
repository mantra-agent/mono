import { tagService } from "./tag-service";
import { createLogger } from "./log";

const log = createLogger("LibraryTagSync");

/**
 * Structural / system Library tags are placement and lifecycle markers, not
 * semantic topics. They must never be mirrored into the canonical Tag registry:
 * doing so would pollute every user's Tag namespace and the memory graph with
 * non-semantic markers like "folder", "wiki", or "library-meta". Only semantic,
 * user/agent-authored topic tags are promoted to canonical Tag identity.
 *
 * This exclusion set is the single source of truth for the semantic/structural
 * boundary on Library page tags[].
 */
const STRUCTURAL_LIBRARY_TAGS: ReadonlySet<string> = new Set([
  "folder",
  "system-folder",
  "wiki",
  "library-index",
  "library-log",
  "library-meta",
  "migrated-from-note",
  "library-placement-review",
]);

function isStructuralLibraryTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  return (
    STRUCTURAL_LIBRARY_TAGS.has(normalized) ||
    // Canonical vault folder markers: canonical-folder-plans/-workflows/-specs/-skills
    normalized.startsWith("canonical-folder-")
  );
}

/**
 * The semantic subset of a Library page's tags[] eligible for canonical Tag
 * identity. Filters out structural/system markers.
 */
export function semanticLibraryTags(
  tags: readonly string[] | null | undefined,
): string[] {
  return (tags ?? []).filter((tag) => tag && !isStructuralLibraryTag(tag));
}

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
