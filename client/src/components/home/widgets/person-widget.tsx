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

const OUTREACH_LABELS: Record<string, string> = {
  follow_up: "Follow-up with",
  check_in: "Check-in with",
  reconnect: "Reconnect with",
};

function PersonInline({ item }: { item: SimpleFeedItem }) {
  const reference = primaryReference(item);
  const outreachType = stringPayload(item, "outreachType");
  const outreachLabel = outreachType ? OUTREACH_LABELS[outreachType] : null;
  const badge = stringPayload(item, "contextBadge") || stringPayload(item, "suggestedAction");

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {outreachLabel ? <span className="shrink-0 text-xs text-muted-foreground">{outreachLabel}</span> : null}
      {reference ? (
        <ReferenceRenderer refValue={reference} surface="simple-row" />
      ) : (
        <span className="truncate text-sm font-medium">{item.title}</span>
      )}
      {!outreachLabel && badge ? <span className="shrink-0 text-xs text-muted-foreground">{badge}</span> : null}
    </div>
  );
}

export function PersonWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <PersonInline item={item} />;
  return <PersonInline item={item} />;
}
