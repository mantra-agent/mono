import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActivityHeatmap, type ActivityHeatmapDay } from "@/components/activity-heatmap";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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

function localDateToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export default function DashboardPage() {
  usePageHeader({ title: "Dashboard" });
  const [date, setDate] = useState(localDateToday);
  const query = useQuery<DashboardActivity>({
    queryKey: [`/api/dashboard/activity?date=${encodeURIComponent(date)}`],
  });

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background p-4 md:p-6">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-end">
          <Input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="w-full sm:w-44"
            aria-label="Dashboard date"
            data-testid="input-dashboard-date"
          />
        </div>

        {query.isError ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            Dashboard activity could not be loaded.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {query.isLoading
              ? ["opportunity", "wellness", "tasks", "prs"].map((key) => (
                  <Card key={key} className="min-w-0 overflow-hidden bg-card">
                    <CardHeader><Skeleton className="h-4 w-40" /></CardHeader>
                    <CardContent><Skeleton className="h-8 w-16" /></CardContent>
                  </Card>
                ))
              : query.data?.kpis.map((kpi) => (
                  <Card key={kpi.key} className="min-w-0 overflow-hidden bg-card">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">{kpi.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold text-foreground">{kpi.value.toLocaleString()}</p>
                    </CardContent>
                  </Card>
                ))}
          </div>
        )}

        {!query.isLoading && !query.isError && query.data && (
          <div className="space-y-0 bg-background">
            {query.data.series.map((series) => (
              <ProfileDetailSection
                key={series.key}
                title={series.label}
                defaultOpen
                testId={`section-dashboard-${series.key}`}
              >
                <ActivityHeatmap
                  days={series.days}
                  onSelectDate={setDate}
                  valueLabel={series.label.toLowerCase()}
                />
              </ProfileDetailSection>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
