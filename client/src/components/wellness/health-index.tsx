import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronRight, Heart, Loader2, Moon, Zap } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface HealthMetric {
  id: number;
  metricType: string;
  value: number;
  unit: string;
  source: string;
  date: string;
  recordedAt: string;
}

type MetricSection = "Readiness" | "Sleep" | "Activity" | "Heart" | "Other";

const SECTIONS: MetricSection[] = ["Readiness", "Sleep", "Activity", "Heart", "Other"];

const KNOWN_LABELS: Record<string, string> = {
  readiness_score: "Readiness",
  body_temperature_deviation: "Temperature Deviation",
  body_temperature_trend_deviation: "Temperature Trend",
  readiness_hrv_balance: "HRV Balance",
  readiness_recovery_index: "Recovery Index",
  readiness_resting_heart_rate: "Resting Heart Rate Score",
  readiness_sleep_balance: "Sleep Balance",
  readiness_total_sleep: "Total Sleep Score",
  sleep_score: "Sleep Score",
  sleep_balance: "Sleep Balance",
  sleep_timing: "Sleep Timing",
  sleep_efficiency_score: "Sleep Efficiency Score",
  sleep_total: "Total Sleep",
  sleep_awake: "Awake",
  sleep_deep: "Deep Sleep",
  sleep_core: "Core Sleep",
  sleep_rem: "REM Sleep",
  sleep_efficiency: "Sleep Efficiency",
  sleep_in_bed: "In Bed",
  activity_score: "Activity Score",
  steps: "Steps",
  active_calories: "Active Calories",
  total_calories: "Total Calories",
  walking_distance: "Walking Distance",
  high_activity_minutes: "High Activity",
  medium_activity_minutes: "Medium Activity",
  low_activity_minutes: "Low Activity",
  sedentary_minutes: "Sedentary",
  activity_balance: "Activity Balance",
  stay_active: "Stay Active",
  workout_calories: "Workout Calories",
  workout_distance: "Workout Distance",
  workout_minutes: "Workout",
  session_minutes: "Session",
  session_heart_rate_avg: "Session Heart Rate Avg",
  session_heart_rate_max: "Session Heart Rate Max",
  session_heart_rate_min: "Session Heart Rate Min",
  heart_rate_avg: "Heart Rate Avg",
  heart_rate_min: "Heart Rate Min",
  heart_rate_max: "Heart Rate Max",
  HKQuantityTypeIdentifierStepCount: "Steps",
  HKQuantityTypeIdentifierHeartRate: "Heart Rate",
  HKQuantityTypeIdentifierActiveEnergyBurned: "Active Energy",
  HKQuantityTypeIdentifierBasalEnergyBurned: "Resting Energy",
  HKQuantityTypeIdentifierBodyMass: "Weight",
  HKQuantityTypeIdentifierOxygenSaturation: "Blood Oxygen",
  HKCategoryTypeIdentifierSleepAnalysis: "Sleep",
  HKQuantityTypeIdentifierRestingHeartRate: "Resting Heart Rate",
};

function sectionFor(type: string): MetricSection {
  if (
    type.startsWith("readiness_") ||
    type.startsWith("body_temperature_")
  ) {
    return "Readiness";
  }
  if (type.startsWith("sleep_") || type === "HKCategoryTypeIdentifierSleepAnalysis") {
    return "Sleep";
  }
  if (
    type.startsWith("heart_rate_") ||
    type.startsWith("session_heart_rate_") ||
    type === "HKQuantityTypeIdentifierHeartRate" ||
    type === "HKQuantityTypeIdentifierRestingHeartRate"
  ) {
    return "Heart";
  }
  if (
    type.startsWith("activity_") ||
    type.startsWith("workout_") ||
    type.startsWith("session_") ||
    type === "steps" ||
    type.endsWith("_calories") ||
    type.endsWith("_activity_minutes") ||
    type === "sedentary_minutes" ||
    type === "walking_distance" ||
    type === "stay_active" ||
    type === "HKQuantityTypeIdentifierStepCount" ||
    type === "HKQuantityTypeIdentifierActiveEnergyBurned" ||
    type === "HKQuantityTypeIdentifierBasalEnergyBurned"
  ) {
    return "Activity";
  }
  return "Other";
}

function labelFor(type: string): string {
  if (KNOWN_LABELS[type]) return KNOWN_LABELS[type];
  return type
    .replace(/HK(?:QuantityType|CategoryType)Identifier/, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatValue(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) >= 10 ? 1 : 2);
  if (unit === "score") return rounded;
  if (unit === "count") return Math.round(value).toLocaleString();
  if (unit === "percent") return `${rounded}%`;
  if (unit === "celsius") return `${rounded}°C`;
  if (unit === "kcal") return `${Math.round(value).toLocaleString()} kcal`;
  if (unit === "bpm") return `${Math.round(value)} bpm`;
  if (unit === "hr") return `${rounded} hr`;
  if (unit === "min") return `${rounded} min`;
  if (unit === "m") return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
  return unit ? `${rounded} ${unit}` : rounded;
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function sectionIcon(section: MetricSection) {
  const className = "h-3.5 w-3.5";
  if (section === "Sleep") return <Moon className={className} />;
  if (section === "Heart") return <Heart className={className} />;
  if (section === "Readiness") return <Zap className={className} />;
  return <Activity className={className} />;
}

interface MetricGroup {
  type: string;
  section: MetricSection;
  label: string;
  latest: HealthMetric;
  average: number;
  samples: HealthMetric[];
}

function groupMetrics(rows: HealthMetric[]): MetricGroup[] {
  const byType = new Map<string, HealthMetric[]>();
  for (const row of rows) {
    const bucket = byType.get(row.metricType) ?? [];
    bucket.push(row);
    byType.set(row.metricType, bucket);
  }

  return Array.from(byType.entries())
    .map(([type, samples]) => {
      const ordered = [...samples].sort((a, b) => {
        if (a.date === b.date) return b.id - a.id;
        return a.date < b.date ? 1 : -1;
      });
      const latest = ordered[0];
      const average = ordered.reduce((sum, sample) => sum + sample.value, 0) / ordered.length;
      return {
        type,
        section: sectionFor(type),
        label: labelFor(type),
        latest,
        average,
        samples: ordered,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function MetricRow({ group }: { group: MetricGroup }) {
  return (
    <ProfileTreeRow
      label={group.label}
      icon={sectionIcon(group.section)}
      hasValue
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      testId={`health-metric-${group.type}`}
      expandedContentClassName="px-2 pb-2 pl-2"
      expandedContent={(
        <div className="space-y-0.5">
          <ProfileTreeRow label="Latest" hasValue showEmpty mobileLayout="inline">
            {formatValue(group.latest.value, group.latest.unit)}
          </ProfileTreeRow>
          <ProfileTreeRow label="Average" hasValue showEmpty mobileLayout="inline">
            {formatValue(group.average, group.latest.unit)}
          </ProfileTreeRow>
          <ProfileTreeRow label="Date" hasValue showEmpty mobileLayout="inline">
            {formatDate(group.latest.date)}
          </ProfileTreeRow>
          <ProfileTreeRow label="Source" hasValue showEmpty mobileLayout="inline">
            {group.latest.source}
          </ProfileTreeRow>
          <ProfileTreeRow label="Samples" hasValue showEmpty mobileLayout="inline">
            {String(group.samples.length)}
          </ProfileTreeRow>
          {group.samples.map((sample, index) => (
            <HierarchyTreeRow
              key={sample.id}
              indent="icon"
              continues={index < group.samples.length - 1}
              connectorAnchor="first-row-center"
            >
              <ProfileTreeRow
                label={formatDate(sample.date)}
                hasValue
                showEmpty
                mobileLayout="inline"
                valueLayout="compact"
                testId={`health-sample-${sample.id}`}
              >
                {formatValue(sample.value, sample.unit)}
              </ProfileTreeRow>
            </HierarchyTreeRow>
          ))}
        </div>
      )}
    >
      {formatValue(group.latest.value, group.latest.unit)}
    </ProfileTreeRow>
  );
}

export function HealthIndex() {
  const [search, setSearch] = useState("");
  const metrics = useQuery<HealthMetric[]>({
    queryKey: ["/api/health/metrics", "index"],
    queryFn: async () => {
      const response = await fetch("/api/health/metrics?days=30", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load health metrics");
      return response.json();
    },
  });

  const groups = useMemo(() => groupMetrics(metrics.data ?? []), [metrics.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) =>
      `${group.label} ${group.type} ${group.latest.source}`.toLowerCase().includes(needle),
    );
  }, [groups, search]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="health-page">
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-health"
            clearTestId="button-clear-health-search"
            ariaLabel="Search health metrics"
          />
          {metrics.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading health metrics" />
            </div>
          ) : metrics.error ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Could not load health metrics</div>
          ) : groups.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No health metrics</div>
          ) : (
            SECTIONS.map((section) => {
              const rows = filtered.filter((group) => group.section === section);
              if (rows.length === 0) return null;
              return (
                <CollapsibleSection key={section} label={section} count={rows.length}>
                  {rows.map((group, index) => (
                    <HierarchyTreeRow
                      key={group.type}
                      continues={index < rows.length - 1}
                      connectorAnchor="first-row-center"
                    >
                      <MetricRow group={group} />
                    </HierarchyTreeRow>
                  ))}
                </CollapsibleSection>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function CollapsibleSection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label} · {count}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
