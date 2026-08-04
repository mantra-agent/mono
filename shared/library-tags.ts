/**
 * Single source of truth for the semantic/structural boundary on Library page
 * tags[]. Shared by the server (canonical Tag write-through) and the client
 * (tag editors) so the two never diverge.
 *
 * Structural / system Library tags are placement and lifecycle markers, not
 * semantic topics. They must never be mirrored into the canonical Tag registry
 * (doing so would pollute every user's Tag namespace and the memory graph with
 * non-semantic markers like "folder", "wiki", or "library-meta"), and tag
 * editors must never expose them as editable/deletable topics — removing one
 * would strand a page's type or placement.
 */
export const STRUCTURAL_LIBRARY_TAGS: ReadonlySet<string> = new Set([
  "folder",
  "system-folder",
  "wiki",
  "library-index",
  "library-log",
  "library-meta",
  "migrated-from-note",
  "library-placement-review",
]);

export function isStructuralLibraryTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  return (
    STRUCTURAL_LIBRARY_TAGS.has(normalized) ||
    // Canonical vault folder markers: canonical-folder-plans/-workflows/-specs/-skills
    normalized.startsWith("canonical-folder-")
  );
}

/**
 * The semantic subset of a Library page's tags[] eligible for canonical Tag
 * identity and safe to surface in tag editors. Filters out structural markers.
 */
export function semanticLibraryTags(
  tags: readonly string[] | null | undefined,
): string[] {
  return (tags ?? []).filter((tag) => tag && !isStructuralLibraryTag(tag));
}

/**
 * The structural/system markers within a Library page's tags[]. Editors must
 * preserve these on write since the tags[] column is a raw replace.
 */
export function structuralLibraryTags(
  tags: readonly string[] | null | undefined,
): string[] {
  return (tags ?? []).filter((tag) => tag && isStructuralLibraryTag(tag));
}
