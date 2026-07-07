import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Heart,
  Footprints,
  Moon,
  Activity,
  Flame,
  Droplets,
  Scale,
  Zap,
  AlertCircle,
  Copy,
  CheckCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface MetricSummary {
  avg: number;
  latest: number;
  unit: string;
  count: number;
}

interface Summary {
  [metricType: string]: MetricSummary;
}

interface HealthMetric {
  id: number;
  metricType: string;
  value: number;
  unit: string;
  source: string;
  date: string;
  recordedAt: string;
}

const METRIC_META: Record<string, { label: string; icon: typeof Heart; color: string; format?: (v: number) => string }> = {
  "HKQuantityTypeIdentifierStepCount": {
    label: "Steps",
    icon: Footprints,
    color: "text-info",
    format: (v) => Math.round(v).toLocaleString(),
  },
  "HKQuantityTypeIdentifierHeartRate": {
    label: "Heart Rate",
    icon: Heart,
    color: "text-error",
    format: (v) => `${Math.round(v)} bpm`,
  },
  "HKQuantityTypeIdentifierActiveEnergyBurned": {
    label: "Active Energy",
    icon: Flame,
    color: "text-cat-event",
    format: (v) => `${Math.round(v)} kcal`,
  },
  "HKQuantityTypeIdentifierBasalEnergyBurned": {
    label: "Resting Energy",
    icon: Zap,
    color: "text-warning",
    format: (v) => `${Math.round(v)} kcal`,
  },
  "HKQuantityTypeIdentifierBodyMass": {
    label: "Weight",
    icon: Scale,
    color: "text-cat-ai",
    format: (v) => `${v.toFixed(1)} kg`,
  },
  "HKQuantityTypeIdentifierOxygenSaturation": {
    label: "Blood Oxygen",
    icon: Droplets,
    color: "text-active",
    format: (v) => `${(v * 100).toFixed(0)}%`,
  },
  "HKCategoryTypeIdentifierSleepAnalysis": {
    label: "Sleep",
    icon: Moon,
    color: "text-cat-system",
    format: (v) => `${(v / 3600).toFixed(1)} hr`,
  },
  "HKQuantityTypeIdentifierRestingHeartRate": {
    label: "Resting Heart Rate",
    icon: Activity,
    color: "text-cat-health",
    format: (v) => `${Math.round(v)} bpm`,
  },
};

function getMetricMeta(type: string) {
  return METRIC_META[type] ?? {
    label: type.replace(/HK(?:QuantityType|CategoryType)Identifier/, "").replace(/([A-Z])/g, " $1").trim(),
    icon: Activity,
    color: "text-muted-foreground",
    format: (v: number) => v.toFixed(1),
  };
}

function MetricCard({ metricType, data }: { metricType: string; data: MetricSummary }) {
  const meta = getMetricMeta(metricType);
  const Icon = meta.icon;
  const displayValue = meta.format ? meta.format(data.latest) : `${data.latest} ${data.unit}`;
  const avgDisplay = meta.format ? meta.format(data.avg) : `${data.avg} ${data.unit}`;

  return (
    <Card data-testid={`card-metric-${metricType}`}>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${meta.color}`} />
            <span className="text-sm font-medium text-muted-foreground">{meta.label}</span>
          </div>
          <Badge variant="secondary" className="text-xs font-mono px-1 py-0">{data.count} pts</Badge>
        </div>
        <div className="mt-3">
          <p data-testid={`text-metric-latest-${metricType}`} className="text-2xl font-bold">{displayValue}</p>
          <p className="text-xs text-muted-foreground mt-1">7-day avg: {avgDisplay}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function RecentRow({ metric }: { metric: HealthMetric }) {
  const meta = getMetricMeta(metric.metricType);
  const displayValue = meta.format ? meta.format(metric.value) : `${metric.value} ${metric.unit}`;
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{meta.label}</span>
        <Badge variant="outline" className="text-xs">{metric.source}</Badge>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold">{displayValue}</p>
        <p className="text-xs text-muted-foreground">{metric.date}</p>
      </div>
    </div>
  );
}

export function MetricsContent() {
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();

  const { data: summary, isLoading: summaryLoading } = useQuery<Summary>({
    queryKey: ["/api/health/summary"],
  });

  const { data: recent, isLoading: recentLoading } = useQuery<HealthMetric[]>({
    queryKey: ["/api/health/metrics"],
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/health/metrics");
      return res.json() as Promise<{ ok: boolean; deletedCount: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/health/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/health/metrics"] });
      setConfirmOpen(false);
      toast({
        title: "Health data cleared",
        description: `Deleted ${data.deletedCount.toLocaleString()} metric${data.deletedCount === 1 ? "" : "s"}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to clear health data",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const webhookUrl = `${window.location.origin}/api/health/webhook`;

  function copyWebhook() {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const hasData = summary && Object.keys(summary).length > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Wellness Metrics</h1>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button
              data-testid="button-clear-health-data"
              variant="destructive"
              size="sm"
              disabled={!hasData || clearMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear Data
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent data-testid="dialog-clear-health-data">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear all health metrics?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes every collected health metric synced from Health Auto Export
                (steps, heart rate, energy, weight, blood oxygen, sleep, and more). This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-clear-health-data" disabled={clearMutation.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="button-confirm-clear-health-data"
                onClick={(e) => {
                  e.preventDefault();
                  clearMutation.mutate();
                }}
                disabled={clearMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {clearMutation.isPending ? "Clearing…" : "Clear Data"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {!hasData && !summaryLoading && (
        <Card className="border-dashed">
          <CardContent className="pt-6 pb-6">
            <div className="flex flex-col items-center text-center gap-3">
              <AlertCircle className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">No health data yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Connect the <strong>Health Auto Export</strong> app on your iPhone to start syncing.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Webhook Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            In the <strong>Health Auto Export</strong> app, add a REST API export pointing to this URL:
          </p>
          <div className="flex items-center gap-2 bg-muted rounded-md px-3 py-2">
            <code data-testid="text-webhook-url" className="text-xs flex-1 break-all">{webhookUrl}</code>
            <Button
              data-testid="button-copy-webhook"
              variant="ghost"
              size="sm"
              onClick={copyWebhook}
              className="shrink-0"
            >
              {copied ? <CheckCheck className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Set the export format to <strong>JSON</strong> and enable auto-export on the schedule of your choice.
          </p>
        </CardContent>
      </Card>

      {summaryLoading ? (
        <div className="grid grid-cols-2 @md:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-3 w-20 mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : hasData ? (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Last 7 Days</h2>
          <div className="grid grid-cols-2 @md:grid-cols-3 gap-4">
            {Object.entries(summary!).map(([type, data]) => (
              <MetricCard key={type} metricType={type} data={data} />
            ))}
          </div>
        </div>
      ) : null}

      {hasData && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent Entries</CardTitle>
          </CardHeader>
          <CardContent>
            {recentLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : recent && recent.length > 0 ? (
              <div>
                {recent.slice(0, 20).map((m) => <RecentRow key={m.id} metric={m} />)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No recent entries.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
