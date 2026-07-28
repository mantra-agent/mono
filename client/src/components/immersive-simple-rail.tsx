import { Loader2 } from "lucide-react";
import { useHomeFeed } from "@/hooks/use-home-feed";
import { SIMPLE_SECTION_LABELS, type SimpleFeedItem } from "@shared/models/simple";
import { cn } from "@/lib/utils";

/** Sections hidden from the entrance rail — keep it anchored on what matters now. */
const HIDDEN_SECTIONS = new Set(["done", "snoozed", "earlier"]);

/**
 * Read-only Simple projection for the immersive-orb entrance's left rail.
 *
 * The full interactive Simple feed (`SimpleFeedView`) depends on
 * `FocusSessionProvider`, which the lean immersive shell deliberately does not
 * mount. This rail reuses the same provider-free `useHomeFeed()` data source
 * but renders a compact, non-interactive recap / action-items / today view, so
 * the authenticated FTUE has real personal context beside the orb without
 * dragging the heavy session providers into the entrance shell.
 */
export function ImmersiveSimpleRail() {
  const { data, isLoading } = useHomeFeed({ refresh: false });

  const sections = (data?.sections ?? []).filter(
    (section) => !HIDDEN_SECTIONS.has(section.section) && section.items.length > 0,
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="px-4 pb-2 pt-4">
        <h1 className="text-xl font-semibold text-foreground">Simple</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-2 pb-6">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : sections.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Nothing yet</div>
        ) : (
          sections.map((section) => (
            <div key={section.section} className="mb-4">
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {SIMPLE_SECTION_LABELS[section.section]}
              </div>
              <div className="flex flex-col">
                {section.items.map((item) => (
                  <RailRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RailRow({ item }: { item: SimpleFeedItem }) {
  const done = item.status === "completed";
  return (
    <div className="flex items-baseline gap-2 rounded-md px-2 py-1.5">
      {item.time ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.time}</span>
      ) : null}
      <span
        className={cn(
          "min-w-0 truncate text-sm text-foreground",
          done && "text-muted-foreground line-through",
        )}
      >
        {item.title}
      </span>
    </div>
  );
}
