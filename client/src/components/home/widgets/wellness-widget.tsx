import type { SimpleFeedItem } from "@shared/models/simple";
import { sourceRefToReferenceRef } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { SimpleCheckRow } from "../home-check-row";
import { cn } from "@/lib/utils";

function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" ? value : null;
}

function primaryReference(item: SimpleFeedItem) {
  return item.references?.[0] ?? (item.sourceRefs?.[0] ? sourceRefToReferenceRef(item.sourceRefs[0]) : null);
}

/** Inline mode: renders content for use inside SimpleTreeRow */
function WellnessInline({ item }: { item: SimpleFeedItem }) {
  const reference = primaryReference(item);
  const completed = item.status === "completed";

  return reference ? (
    <span className="min-w-0">
      <ReferenceRenderer refValue={reference} surface="simple-row" className={completed ? "text-neutral hover:text-neutral" : undefined} />
    </span>
  ) : (
    <span className={cn(
      "truncate text-sm font-medium",
      completed && "text-neutral line-through",
    )}>
      {item.title}
    </span>
  );
}

export function WellnessWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <WellnessInline item={item} />;
  return <SimpleCheckRow item={item} sublabel={stringPayload(item, "windowLabel")} />;
}
