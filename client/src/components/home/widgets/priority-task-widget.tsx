import { ListTodo } from "lucide-react";
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

/** Inline mode: renders just the content for use inside SimpleTreeRow */
function PriorityTaskInline({ item }: { item: SimpleFeedItem }) {
  const reference = primaryReference(item);
  const completed = item.status === "completed";

  return (
    <div className="flex items-center gap-1.5">
      <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {reference ? (
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
      )}
    </div>
  );
}

export function PriorityTaskWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <PriorityTaskInline item={item} />;

  return <SimpleCheckRow item={item} />;
}
