import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BriefcaseBusiness,
  ClipboardList,
  FileCode2,
  Heart,
  User,
  type LucideIcon,
} from "lucide-react";
import { ActivityHeatmap, type ActivityHeatmapDay } from "@/components/activity-heatmap";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { usePageHeader } from "@/hooks/use-page-header";
import { useProductComposition } from "@/hooks/use-product-composition";

interface DashboardKpi {
  key: string;
  label: string;
  value: number;
}

interface DashboardSeries {
  key: string;
  label: string;
  days: ActivityHeatmapDay[];
}

interface DashboardActivity {
  date: string;
  kpis: DashboardKpi[];
  series: DashboardSeries[];
}

/** Host-owned marker criteria per known series key. Visibility/order come from composition. */
const SERIES_MARKERS: Record<
  string,
  {
    title: string;
    marker: {
      icon: LucideIcon;
      criterion: "above-80-percent-of-maximum" | "above-value";
      threshold?: number;
      filled: boolean;
    };
  }
> = {
  wellness_completions: {
    title: "WELLNESS",
    marker: { icon: Heart, criterion: "above-80-percent-of-maximum", filled: true },
  },
  opportunity_interactions: {
    title: "INTERACTIONS",
    marker: { icon: User, criterion: "above-value", threshold: 5, filled: true },
  },
  completed_tasks: {
    title: "TASKS",
    marker: {
      icon: BriefcaseBusiness,
      criterion: "above-value",
      threshold: 40,
      filled: true,
    },
  },
  shipped_prs: {
    title: "CODE",
    marker: { icon: FileCode2, criterion: "above-value", threshold: 50, filled: true },
  },
};

const FALLBACK_MARKER = {
  title: "ACTIVITY",
  marker: {
    icon: ClipboardList,
    criterion: "above-80-percent-of-maximum" as const,
    filled: true,
  },
};

function localDateToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export default function DashboardPage() {
  usePageHeader({ title: "Dashboard" });
  const date = localDateToday();
  const compositionQuery = useProductComposition();

  const heatmaps = useMemo(
    () =>
      [...(compositionQuery.data?.dashboardHeatmaps ?? [])].sort(
        (a, b) => a.order - b.order || a.seriesKey.localeCompare(b.seriesKey),
      ),
    [compositionQuery.data?.dashboardHeatmaps],
  );

  const seriesParam = useMemo(
    () => heatmaps.map((heatmap) => heatmap.seriesKey).join(","),
    [heatmaps],
  );

  const activityQuery = useQuery<DashboardActivity>({
    queryKey: [
      `/api/dashboard/activity?date=${encodeURIComponent(date)}&series=${encodeURIComponent(seriesParam)}`,
    ],
    enabled: seriesParam.length > 0 && !compositionQuery.isLoading,
  });

  const seriesByKey = useMemo(() => {
    const map = new Map<string, DashboardSeries>();
    for (const series of activityQuery.data?.series ?? []) {
      map.set(series.key, series);
    }
    return map;
  }, [activityQuery.data?.series]);

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background p-4 md:p-3">
      <div className="flex flex-col gap-6">
        {activityQuery.isError && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Some dashboard activity could not be loaded.
          </div>
        )}

        {!compositionQuery.isLoading && heatmaps.length === 0 && (
          <p className="px-2 text-sm text-muted-foreground">
            No activity heatmaps are available for your current product composition.
          </p>
        )}

        {heatmaps.length > 0 && (
          <div className="bg-background">
            {heatmaps.map((contribution, index) => {
              const series = seriesByKey.get(contribution.seriesKey);
              const presentation = SERIES_MARKERS[contribution.seriesKey] ?? FALLBACK_MARKER;
              const title = presentation.title;
              const days = series?.days ?? [];
              return (
                <div key={contribution.id} className={index === 0 ? "" : "pt-6"}>
                  <ProfileDetailSection
                    title={title}
                    defaultOpen
                    testId={`section-dashboard-${contribution.seriesKey}`}
                  >
                    <ActivityHeatmap
                      days={days}
                      marker={presentation.marker}
                      valueLabel={title.toLowerCase()}
                    />
                  </ProfileDetailSection>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
