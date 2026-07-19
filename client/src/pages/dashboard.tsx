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
    marker: { icon: User, criterion: "above-value", threshold: 5, filled: true },
  },
  completed_tasks: {
    title: "TASKS",
    order: 2,
    marker: { icon: BriefcaseBusiness, criterion: "above-value", threshold: 40, filled: true },
  },
  shipped_prs: {
    title: "CODE",
    order: 3,
    marker: { icon: FileCode2, criterion: "above-value", threshold: 50, filled: true },
  },
} as const;

function localDateToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function renderSeries(series: DashboardSeries[], startingIndex = 0) {
  return [...series]
    .sort((left, right) => SECTION_PRESENTATION[left.key].order - SECTION_PRESENTATION[right.key].order)
    .map((item, index) => (
      <div key={item.key} className={startingIndex + index === 0 ? "" : "pt-6"}>
        <ProfileDetailSection
          title={SECTION_PRESENTATION[item.key].title}
          defaultOpen
          testId={`section-dashboard-${item.key}`}
        >
          <ActivityHeatmap
            days={item.days}
            marker={SECTION_PRESENTATION[item.key].marker}
            valueLabel={SECTION_PRESENTATION[item.key].title.toLowerCase()}
          />
        </ProfileDetailSection>
      </div>
    ));
}

export default function DashboardPage() {
  usePageHeader({ title: "Dashboard" });
  const date = localDateToday();
  const coreQuery = useQuery<DashboardActivity>({
    queryKey: [`/api/dashboard/activity?date=${encodeURIComponent(date)}&source=core`],
  });
  const codeQuery = useQuery<DashboardActivity>({
    queryKey: [`/api/dashboard/activity?date=${encodeURIComponent(date)}&source=code`],
  });
  const hasError = coreQuery.isError || codeQuery.isError;
  const hasData = Boolean(coreQuery.data || codeQuery.data);

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background p-4 md:p-3">
      <div className="flex flex-col gap-6">
        {hasError && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Some dashboard activity could not be loaded.
          </div>
        )}

        {hasData && (
          <div className="bg-background">
            {renderSeries(coreQuery.data?.series ?? [])}
            {renderSeries(codeQuery.data?.series ?? [], coreQuery.data?.series.length ?? 0)}
          </div>
        )}
      </div>
    </div>
  );
}
