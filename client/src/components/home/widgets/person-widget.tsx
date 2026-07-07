import type { SimpleFeedItem } from "@shared/models/simple";
import { sourceRefToReferenceRef } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";

function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function primaryReference(item: SimpleFeedItem) {
  return item.references?.[0] ?? (item.sourceRefs?.[0] ? sourceRefToReferenceRef(item.sourceRefs[0]) : null);
}

/** Derive a short reason label for Tier 1 items */
function tierLabel(item: SimpleFeedItem): string | null {
  const tier = item.payload?.surfaceTier;
  if (tier !== 1) return null;
  if (item.payload?.responseOwedDetails) return "Response owed";
  if (item.payload?.commitmentDetails) return "Open commitment";
  return null;
}

function PersonInline({ item }: { item: SimpleFeedItem }) {
  const reference = primaryReference(item);
  const badge = stringPayload(item, "contextBadge");
  const label = tierLabel(item);
  // Prefer tier label over generic badge, fall back to suggestedAction
  const subtitle = label || badge || stringPayload(item, "suggestedAction");

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {reference ? (
        <ReferenceRenderer refValue={reference} surface="simple-row" />
      ) : (
        <span className="truncate text-sm font-medium">{item.title}</span>
      )}
      {subtitle ? (
        <span className={`shrink-0 text-xs ${label ? "text-warning-foreground" : "text-muted-foreground"}`}>
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

export function PersonWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <PersonInline item={item} />;
  return <PersonInline item={item} />;
}
