import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, Database, FunctionSquare, Loader2, Plus, PenLine } from "lucide-react";
import {
  METRIC_ADAPTER_KINDS,
  METRIC_DIRECTIONS,
  METRIC_SAMPLE_PERIODS,
  type Metric,
  type MetricAdapterKind,
  type MetricDirection,
} from "@shared/models/metrics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface MetricsResponse {
  metrics: Metric[];
}

const DIRECTION_LABEL: Record<MetricDirection, string> = {
  higher_is_better: "Higher is better",
  lower_is_better: "Lower is better",
  target_band: "Target band",
};

const ADAPTER_ICON: Record<MetricAdapterKind, typeof Database> = {
  manual: PenLine,
  internal: Database,
  expression: FunctionSquare,
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const diff = Date.now() - then;
  const hours = diff / (1000 * 60 * 60);
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatValue(value: number, unit: string): string {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function RecordSampleDialog({ metric }: { metric: Metric }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [evidence, setEvidence] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/business/metrics/${metric.id}/samples`, {
        value: Number(value),
        unit: metric.unit,
        evidence: evidence.trim() || undefined,
        sourceRef: "manual",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/business/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/business/kpis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/business/kpis/standing-scores"] });
      toast({ title: "Sample recorded", description: `${metric.name} updated.` });
      setOpen(false);
      setValue("");
      setEvidence("");
    },
    onError: (error: unknown) => {
      toast({ title: "Failed to record sample", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const valid = value.trim() !== "" && Number.isFinite(Number(value));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`record-sample-${metric.slug}`}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Sample
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record sample — {metric.name}</DialogTitle>
          <DialogDescription>Log an observed value. This updates any KPI bound to this metric.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              placeholder="Value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              data-testid="sample-value"
            />
            <span className="text-sm text-muted-foreground">{metric.unit || "units"}</span>
          </div>
          <Textarea
            placeholder="Evidence / source note (optional)"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            data-testid="sample-evidence"
          />
        </div>
        <DialogFooter>
          <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending} data-testid="sample-submit">
            {mutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateMetricDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [direction, setDirection] = useState<MetricDirection>("higher_is_better");
  const [adapterKind, setAdapterKind] = useState<MetricAdapterKind>("manual");
  const [samplePeriod, setSamplePeriod] = useState<string>("point");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/business/metrics", {
        name: name.trim(),
        unit: unit.trim(),
        direction,
        adapterKind,
        samplePeriod,
        status: "active",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/business/metrics"] });
      toast({ title: "Metric created", description: name });
      setOpen(false);
      setName("");
      setUnit("");
    },
    onError: (error: unknown) => {
      toast({ title: "Failed to create metric", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="create-metric">
          <Plus className="mr-1 h-4 w-4" /> New metric
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New metric</DialogTitle>
          <DialogDescription>Define a measurement. Adapters decide where its data comes from.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Metric name" value={name} onChange={(e) => setName(e.target.value)} data-testid="metric-name" />
          <Input placeholder="Unit (e.g. %, count, USD)" value={unit} onChange={(e) => setUnit(e.target.value)} data-testid="metric-unit" />
          <div className="grid grid-cols-2 gap-2">
            <Select value={direction} onValueChange={(v) => setDirection(v as MetricDirection)}>
              <SelectTrigger data-testid="metric-direction"><SelectValue /></SelectTrigger>
              <SelectContent>
                {METRIC_DIRECTIONS.map((d) => (
                  <SelectItem key={d} value={d}>{DIRECTION_LABEL[d]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={adapterKind} onValueChange={(v) => setAdapterKind(v as MetricAdapterKind)}>
              <SelectTrigger data-testid="metric-adapter"><SelectValue /></SelectTrigger>
              <SelectContent>
                {METRIC_ADAPTER_KINDS.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Select value={samplePeriod} onValueChange={setSamplePeriod}>
            <SelectTrigger data-testid="metric-period"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METRIC_SAMPLE_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={() => mutation.mutate()} disabled={name.trim() === "" || mutation.isPending} data-testid="metric-submit">
            {mutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BusinessMetricsPage() {
  usePageHeader({ title: "Metrics" });
  const [query, setQuery] = useState("");

  const { data, isLoading } = useQuery<MetricsResponse>({
    queryKey: ["/api/business/metrics"],
  });

  const metrics = useMemo(() => {
    const list = data?.metrics ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Activity className="h-5 w-5 text-muted-foreground" /> Metrics
          </h1>
          <p className="text-sm text-muted-foreground">Measurements collected through adapters. KPIs read from these.</p>
        </div>
        <CreateMetricDialog />
      </div>

      <Input
        placeholder="Search metrics…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-4"
        data-testid="metrics-search"
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading metrics…
        </div>
      ) : metrics.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          No metrics yet. Create one to start collecting.
        </div>
      ) : (
        <div className="space-y-2">
          {metrics.map((metric) => {
            const AdapterIcon = ADAPTER_ICON[metric.adapterKind] ?? Database;
            const sample = metric.latestSample;
            return (
              <div
                key={metric.id}
                className="flex items-center justify-between gap-4 rounded-lg border bg-card p-3"
                data-testid={`metric-row-${metric.slug}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{metric.name}</span>
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      <AdapterIcon className="h-3 w-3" /> {metric.adapterKind}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {DIRECTION_LABEL[metric.direction]} · {metric.samplePeriod}
                    {metric.unit ? ` · ${metric.unit}` : ""}
                  </div>
                </div>
                <div className="text-right">
                  <div className={cn("font-mono text-sm", !sample && "text-muted-foreground")}>
                    {sample ? formatValue(sample.value, sample.unit) : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">{relativeTime(sample?.observedAt)}</div>
                </div>
                <RecordSampleDialog metric={metric} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
