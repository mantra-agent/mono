import type { SimpleFeedItem, SimpleSourceType, SimpleWidgetType } from "@shared/models/simple";
import { sourceRefsToReferenceRefs } from "@shared/simple-references";

/** Work/planning Simple sources that must seat Producer, not router classification. */
const PRODUCER_SOURCE_TYPES = new Set<SimpleSourceType>(["task", "project", "milestone"]);
const PRODUCER_WIDGET_TYPES = new Set<SimpleWidgetType>(["priority_task", "project"]);

/** Title for a new session opened from a Simple Discuss action. */
export function simpleDiscussTitle(item: SimpleFeedItem): string {
  return item.title.trim().slice(0, 80) || "Simple Item";
}

/**
 * Explicit session seat for Simple Discuss.
 * Tasks, projects, and milestones are planning work — pin Producer at create
 * so orientation bootstrap cannot reseat them. Other Simple types leave persona
 * unset and let bootstrap classify (email/person use their own launchers).
 */
export function simpleDiscussPersonaName(item: SimpleFeedItem): "Producer" | undefined {
  if (PRODUCER_WIDGET_TYPES.has(item.widgetType)) return "Producer";
  if ((item.sourceRefs ?? []).some((ref) => PRODUCER_SOURCE_TYPES.has(ref.type))) {
    return "Producer";
  }
  return undefined;
}

/**
 * Opening message for Simple Discuss.
 * Includes payload description so orientation bootstrap can route persona from
 * real task/goal body rather than title + widget type alone.
 */
export function buildSimpleDiscussMessage(item: SimpleFeedItem): string {
  const refs = item.references?.length
    ? item.references
    : sourceRefsToReferenceRefs(item.sourceRefs ?? []);
  const canonicalRefs = refs.map((ref) => ref.canonical);
  const description = typeof item.payload?.description === "string"
    ? item.payload.description.trim()
    : "";

  const parts = [
    `Let's discuss this Simple item: **${item.title}**`,
    `Type: ${item.widgetType}`,
    `Section: ${item.section}`,
  ];
  if (item.time) parts.push(`Display time: ${item.time}`);
  if (canonicalRefs.length) {
    parts.push(`Reference${canonicalRefs.length === 1 ? "" : "s"}: ${canonicalRefs.join(" ")}`);
  }
  if (description) {
    parts.push("", "Description:", description);
  }
  return parts.join("\n");
}
