import { Briefcase } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { sourceRefToReferenceRef } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { cn } from "@/lib/utils";

function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" ? value : null;
}

function numberPayload(item: SimpleFeedItem, key: string): number | null {
  const value = item.payload?.[key];
  return typeof value === "number" ? value : null;
}

function primaryReference(item: SimpleFeedItem) {
  return item.references?.[0] ?? (item.sourceRefs?.[0] ? sourceRefToReferenceRef(item.sourceRefs[0]) : null);
}

/** Inline mode: renders as a reference link (matches wellness/meeting pattern) */
function ProjectInline({ item }: { item: SimpleFeedItem }) {
  const reference = primaryReference(item);

  return reference ? (
    <ReferenceRenderer refValue={reference} surface="simple-row" />
  ) : (
    <span className="truncate text-sm font-medium">{item.title}</span>
  );
}

export function ProjectWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <ProjectInline item={item} />;

  const status = stringPayload(item, "status");
  const dueDate = stringPayload(item, "dueDate");
  const activeMilestones = numberPayload(item, "activeMilestones");
  const href = item.actions?.find(a => a.type === "navigate")?.href ?? `/work`;

  return (
    <a
      href={href}
      className={cn(
        "group flex min-h-10 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50",
      )}
    >
      <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.title}</span>
          {status && <span className="shrink-0 text-xs text-muted-foreground capitalize">{status}</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
          {dueDate && <span>Due {dueDate}</span>}
          {activeMilestones != null && activeMilestones > 0 && (
            <span>{activeMilestones} active milestone{activeMilestones !== 1 ? "s" : ""}</span>
          )}
        </div>
      </div>
    </a>
  );
}
