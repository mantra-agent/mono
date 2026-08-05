/**
 * The single door for turning raw, model-proposed (or user-proposed) tags into
 * clean, canonical semantic tags. Every tag-generation site routes its output
 * through `gateProposedTags` before persisting or returning.
 *
 * Composition, not reinvention:
 *   - canonical slug normalization (`normalizeTagSlug`) — the storage source of truth
 *   - type-exclusion (`isTypeTag` / TYPE_STOPLIST) — keeps structural types out
 *   - company/role redundancy (`filterRedundantTags`) — specialized people logic
 *     whose multi-word tokenization ("Founder & CEO" → blocks "founder"/"ceo")
 *     is intentionally preserved rather than folded into slug form
 *
 * Returns both the surviving tags and what was dropped (with reasons), so
 * surfaces that report ignored tags to the user keep that affordance.
 */

import { normalizeTagSlug, normalizeTagLabel } from "./tag-service";
import { isTypeTag } from "@shared/tag-taxonomy";
import { filterRedundantTags } from "@shared/people-metadata";

export interface GatedTags {
  tags: string[];
  ignored: { tag: string; reason: string }[];
}

export interface GateOptions {
  /** When set, drop tags that merely duplicate the linked company. */
  companyName?: string;
  /** When set, drop tags that merely duplicate the person's role. */
  role?: string;
  /** Hard cap on returned tags (default 8). */
  limit?: number;
}

/**
 * Normalize, de-type, de-duplicate, and (optionally) de-redundify a set of
 * proposed tags. Order preserved; original label form retained for display,
 * de-duplication keyed on canonical slug.
 */
export function gateProposedTags(
  raw: readonly unknown[] | null | undefined,
  opts: GateOptions = {},
): GatedTags {
  const ignored: { tag: string; reason: string }[] = [];

  // Coerce to trimmed strings.
  let candidates = (raw ?? [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);

  // Specialized people redundancy pass (company/role), when applicable.
  if (opts.companyName || opts.role) {
    const filtered = filterRedundantTags({
      tags: candidates,
      companyName: opts.companyName,
      role: opts.role,
    });
    ignored.push(...filtered.ignoredTags);
    candidates = filtered.savedTags;
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  const limit = opts.limit ?? 8;

  for (const candidate of candidates) {
    const slug = normalizeTagSlug(candidate);
    if (!slug) continue;
    if (isTypeTag(slug)) {
      ignored.push({ tag: candidate, reason: "structural type" });
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    tags.push(normalizeTagLabel(candidate));
    if (tags.length >= limit) break;
  }

  return { tags, ignored };
}
