import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SimpleFeedItem } from "@shared/models/simple";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchySectionHeader } from "@/components/hierarchy-section-header";
import { SimpleWidgetRenderer } from "@/components/home/home-widget-renderer";
import { usePageHeader } from "@/hooks/use-page-header";

interface MeetingCounts {
  completedMeetingCount: number;
  completedMeetingsWithNotesCount: number;
  transcriptFragmentCount: number;
  recapReadyCount: number;
}

interface MeetingsResponse {
  items: SimpleFeedItem[];
  total: number;
  counts: MeetingCounts;
}

type MeetingGroup = "This Week" | "This Month" | "Earlier";

function groupFor(item: SimpleFeedItem): MeetingGroup {
  const value = item.anchorTime ?? item.actionTime;
  if (!value) return "Earlier";
  const date = new Date(value);
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  if (date >= weekAgo) return "This Week";
  if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) return "This Month";
  return "Earlier";
}

export default function MeetingsPage() {
  const [search, setSearch] = useState("");
  usePageHeader({ title: "Meetings" });
  const query = search.trim();
  const endpoint = `/api/meetings/records?limit=100${query ? `&query=${encodeURIComponent(query)}` : ""}`;
  const { data, isLoading, error } = useQuery<MeetingsResponse>({ queryKey: [endpoint] });
  const groups = useMemo(() => {
    const result: Record<MeetingGroup, SimpleFeedItem[]> = {
      "This Week": [],
      "This Month": [],
      Earlier: [],
    };
    for (const item of data?.items ?? []) result[groupFor(item)].push(item);
    return result;
  }, [data?.items]);

  return (
    <div className="flex h-full w-full bg-background" data-testid="meetings-page">
      <div className="flex w-full min-w-0 flex-col @md:w-1/3">
        <div className="shrink-0 p-2">
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-meetings"
            clearTestId="button-clear-meeting-search"
            ariaLabel="Search completed meetings"
          />
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {data
              ? `${data.counts.completedMeetingsWithNotesCount} with notes · ${data.counts.completedMeetingCount} completed`
              : "Completed meetings"}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Unable to load meetings.</div>
          ) : isLoading ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading meetings…</div>
          ) : (data?.items.length ?? 0) === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No completed meetings.</div>
          ) : (
            <div className="space-y-2">
              {(Object.entries(groups) as Array<[MeetingGroup, SimpleFeedItem[]]>).map(([label, items]) => items.length > 0 && (
                <section key={label}>
                  <HierarchySectionHeader>{label}</HierarchySectionHeader>
                  <div className="min-w-0">
                    {items.map(item => <SimpleWidgetRenderer key={item.id} item={item} />)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 @md:block" />
    </div>
  );
}
