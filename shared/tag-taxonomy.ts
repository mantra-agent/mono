/**
 * Canonical tag taxonomy policy — the single semantic boundary that keeps the
 * shared Tag namespace (and the memory graph built on top of it) made of
 * cross-cutting *topics*, not structural *types*.
 *
 * Pure, dependency-free, and shared by client tag editors and every server
 * tag-generation site. The server gate (`server/tags/tag-proposal.ts`) composes
 * this policy with the canonical slug normalizer; nothing here touches the DB.
 *
 * The problem this resolves: tags and structural object types share one string
 * namespace with no boundary, so type words ("idea", "decision", "task",
 * "meeting") leak in as tags and — being the most frequent — dominate /tags
 * while being the least tag-like entries. The fix is defense in depth:
 *   1. Generation guidance tells the model NOT to mint type words (generative).
 *   2. TYPE_STOPLIST deterministically drops any that slip through (backstop).
 */

import { STRUCTURAL_LIBRARY_TAGS } from "./library-tags";

/**
 * Root structural object-types that must never become semantic tags. Stored as
 * canonical slugs (lowercase, hyphenated) so the check runs on normalized form.
 *
 * The altitude test decides membership: a word belongs here when it names *what
 * an object is* rather than *what it is about*. Compound semantic tags survive
 * the slug boundary automatically — "decision" is blocked, but "decision-making"
 * normalizes to a distinct slug and passes.
 */
export const TYPE_STOPLIST: ReadonlySet<string> = new Set<string>([
  // Reference-registry object types (singular + common plural).
  "idea", "ideas",
  "note", "notes",
  "task", "tasks",
  "goal", "goals",
  "project", "projects",
  "milestone", "milestones",
  "meeting", "meetings",
  "session", "sessions",
  "plan", "plans",
  "workflow", "workflows",
  "decision", "decisions",
  "priority", "priorities",
  "principle", "principles",
  "person", "people",
  "page", "pages",
  "file", "files",
  "thought", "thoughts",
  "memory", "memories",
  "intention", "intentions",
]);

/**
 * True when a tag — in raw or normalized form — is a structural type or a
 * structural Library marker, and therefore must not enter the semantic Tag
 * namespace. Callers should pass either the label or the slug; both are
 * normalized to slug form before the check.
 */
export function isTypeTag(tag: string): boolean {
  const slug = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return false;
  if (TYPE_STOPLIST.has(slug)) return true;
  // Structural Library markers ("folder", "wiki", "canonical-folder-*", …).
  if (STRUCTURAL_LIBRARY_TAGS.has(slug)) return true;
  if (slug.startsWith("canonical-folder-")) return true;
  return false;
}

/**
 * The canonical prompt fragment injected into every tag-generating LLM call.
 * Carries three things that previously lived in three divergent copies (or not
 * at all): the existing-tag reuse hint, the type-exclusion rule, and the
 * altitude test. Append to a site's existing system prompt — this never
 * replaces the call, only shapes the tags field it already produces.
 *
 * @param existingTagSlugs canonical slugs already in use, most-frequent first.
 */
export function buildTagGuidance(existingTagSlugs: readonly string[] = []): string {
  const reuse =
    existingTagSlugs.length > 0
      ? `\n\nExisting tags in the system (prefer reusing these when they fit): ${existingTagSlugs
          .slice(0, 50)
          .join(", ")}.`
      : "";
  return (
    reuse +
    `\n\nTag rules — tags are cross-cutting semantic TOPICS, never structural types:` +
    `\n- Never use an object type as a tag: not "idea", "decision", "task", "note", "meeting", "goal", "project", "plan", "workflow", "session", "principle".` +
    `\n- Altitude test: only propose a tag if two otherwise-unrelated items could genuinely share it. If it only describes what this one thing *is*, drop it.` +
    `\n- Prefer specific domains ("logistics", "immigration", "typography") over generic containers ("work", "stuff", "misc").`
  );
}
