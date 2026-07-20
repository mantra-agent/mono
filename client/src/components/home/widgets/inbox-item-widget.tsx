import { Inbox } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { cn } from "@/lib/utils";

function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" ? value : null;
}

/** Inline mode: renders content for use inside SimpleTreeRow */
function InboxItemInline({ item }: { item: SimpleFeedItem }) {
  const kind = stringPayload(item, "kind");
  const href = item.actions?.find(a => a.type === "navigate")?.href;
  const completed = item.status === "completed";
  const showKind = kind && kind !== "email_review";

  const inner = completed ? (
    <div className="mx-1 flex min-w-0 items-center gap-1">
      <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate border-b border-current text-xs font-medium text-neutral transition-all duration-200">
        {item.title}
      </span>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm font-medium">{item.title}</span>
      {showKind && <span className="shrink-0 text-xs text-muted-foreground capitalize">{kind.replace(/_/g, " ")}</span>}
    </div>
  );

  if (href) return <a href={href} className="min-w-0 flex-1">{inner}</a>;
  return inner;
}

export function InboxItemWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <InboxItemInline item={item} />;

  const kind = stringPayload(item, "kind");
  const href = item.actions?.find(a => a.type === "navigate")?.href;

  const content = (
    <div className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50">
      <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{item.title}</span>
        {kind && <div className="mt-0.5 text-xs text-muted-foreground capitalize">{kind.replace(/_/g, " ")}</div>}
      </div>
    </div>
  );

  if (href) return <a href={href} className={cn("group")}>{content}</a>;
  return content;
}
