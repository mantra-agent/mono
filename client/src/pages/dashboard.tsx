import { useQuery } from "@tanstack/react-query";
import { AlertCircle, BriefcaseBusiness, FileCode2, Heart, User } from "lucide-react";
import { ActivityHeatmap, type ActivityHeatmapDay } from "@/components/activity-heatmap";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { usePageHeader } from "@/hooks/use-page-header";

interface DashboardKpi {
  key: "opportunity_interactions" | "wellness_completions" | "completed_tasks" | "shipped_prs";
  label: string;
  value: number;
}

interface DashboardSeries {
  key: DashboardKpi["key"];
  label: string;
  days: ActivityHeatmapDay[];
}

interface DashboardActivity {
  date: string;
  kpis: DashboardKpi[];
  series: DashboardSeries[];
}

const SECTION_PRESENTATION = {
  wellness_completions: {
    title: "WELLNESS",
    order: 0,
    marker: { icon: Heart, criterion: "above-80-percent-of-maximum", filled: true },
  },
  opportunity_interactions: {
    title: "INTERACTIONS",
    order: 1,
    marker: { icon: User, criterion: "top-decile", filled: true },
  },
  completed_tasks: {
    title: "TASKS",
    order: 2,
    marker: { icon: BriefcaseBusiness, criterion: "top-decile", filled: true },
  },
  shipped_prs: {
    title: "CODE",
    order: 3,
    marker: { icon: FileCode2, criterion: "top-decile", filled: true },
  },
} as const;

function localDateToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export default function DashboardPage() {
  usePageHeader({ title: "Dashboard" });
  const date = localDateToday();
  const query = useQuery<DashboardActivity>({
    queryKey: [`/api/dashboard/activity?date=${encodeURIComponent(date)}`],
  });

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background p-4 md:p-3">
      <div className="flex flex-col gap-6">
        {query.isError && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Dashboard activity could not be loaded.
          </div>
        )}

        {!query.isLoading && !query.isError && query.data && (
          <div className="bg-background">
            {[...query.data.series]
              .sort((left, right) => SECTION_PRESENTATION[left.key].order - SECTION_PRESENTATION[right.key].order)
              .map((series, index) => (
                <div key={series.key} className={index === 0 ? "" : "pt-6"}>
                  <ProfileDetailSection
                    title={SECTION_PRESENTATION[series.key].title}
                    defaultOpen
                    testId={`section-dashboard-${series.key}`}
                  >
                    <ActivityHeatmap
                      days={series.days}
                      marker={SECTION_PRESENTATION[series.key].marker}
                      valueLabel={SECTION_PRESENTATION[series.key].title.toLowerCase()}
                    />
                  </ProfileDetailSection>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
