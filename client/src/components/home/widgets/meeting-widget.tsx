import { Calendar, MapPin, Users } from "lucide-react";
import type { SimpleFeedItem } from "@shared/models/simple";
import { sourceRefToReferenceRef } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { cn } from "@/lib/utils";

function stringPayload(item: SimpleFeedItem, key: string): string | null {
  const value = item.payload?.[key];
  return typeof value === "string" ? value : null;
}

function arrayPayload(item: SimpleFeedItem, key: string): string[] {
  const value = item.payload?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numberPayload(item: SimpleFeedItem, key: string): number | null {
  const value = item.payload?.[key];
  return typeof value === "number" ? value : null;
}

function primaryReference(item: SimpleFeedItem) {
  return item.references?.[0] ?? (item.sourceRefs?.[0] ? sourceRefToReferenceRef(item.sourceRefs[0]) : null);
}

/** Inline mode: renders as a reference link (like other widgets) */
function MeetingInline({ item }: { item: SimpleFeedItem }) {
  const reference = primaryReference(item);

  return reference ? (
    <ReferenceRenderer refValue={reference} surface="simple-row" className={item.status === "completed" ? "text-neutral hover:text-neutral" : undefined} />
  ) : (
    <span className={cn("truncate text-sm font-medium", item.status === "completed" && "text-neutral line-through")}>{item.title}</span>
  );
}

export function MeetingWidget({ item, inline }: { item: SimpleFeedItem; inline?: boolean }) {
  if (inline) return <MeetingInline item={item} />;

  const time = stringPayload(item, "time");
  const location = stringPayload(item, "location");
  const attendees = arrayPayload(item, "attendees");
  const attendeeCount = numberPayload(item, "attendeeCount") ?? attendees.length;
  const href = item.actions?.find(a => a.type === "navigate")?.href ?? "/schedule";

  return (
    <a
      href={href}
      className={cn(
        "group flex min-h-10 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50",
      )}
    >
      <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("truncate text-sm font-medium", item.status === "completed" && "text-neutral line-through")}>{item.title}</span>
          {time && <span className="shrink-0 text-xs text-muted-foreground">{time}</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
          {location && (
            <span className="flex items-center gap-1 truncate">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{location}</span>
            </span>
          )}
          {attendeeCount > 0 && (
            <span className="flex items-center gap-1 shrink-0">
              <Users className="h-3 w-3" />
              {attendees.length > 0 ? attendees.join(", ") : `${attendeeCount}`}
            </span>
          )}
        </div>
      </div>
    </a>
  );
}
