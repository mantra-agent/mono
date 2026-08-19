import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gauge, Loader2, Plus, Target } from "lucide-react";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HierarchySectionHeader,
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ActivityHeatmap, heatmapFillColor } from "@/components/activity-heatmap";
import { ReferencePicker } from "@/components/references/reference-picker";
import { ReferenceText } from "@/components/references/reference-text";
import { serializeReference } from "@shared/references";
import {
  METRIC_CATALOG_FAMILIES,
  METRIC_CATALOG_FAMILY_LABEL,
  METRIC_DIRECTIONS,
  metricCatalogFamilyOf,
  type Kpi,
  type KpiScoreBand,
  type Metric,
  type MetricCatalogFamily,
  type MetricDirection,
  type MetricSample,
} from "@shared/models/metrics";
import {
  KPI_PERIOD_LABEL,
  KPI_PERIODS,
  KPI_SAMPLE_PRESETS,
  type KpiPeriod,
  type KpiStyle,
} from "@shared/kpi-sample";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface KpisResponse {
  kpis: Kpi[];
}
interface MetricsResponse {
  metrics: Metric[];
}

const BAND_LABEL: Record<KpiScoreBand, string> = {
  bull: "Over",
  on_track: "Perform",
  bear: "Under",
  critical: "Under",
  stale: "Stale",
  unavailable: "Unavailable",
  unmeasured: "Unmeasured",
};

const DIRECTION_LABEL: Record<MetricDirection, string> = {
  higher_is_better: "Higher is better",
  lower_is_better: "Lower is better",
  target_band: "Target band",
};

function formatValue(value: number | null, unit: string): string {
  if (value == null) return "—";
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function sampleLabel(sample: MetricSample): string {
  const stamp = sample.periodStart ?? sample.observedAt;
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return stamp;
  return date.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" });
}

function KpiSeriesChart({ kpi }: { kpi: Kpi }) {
  const series = kpi.series ?? [];
  if (series.length === 0) {
    return <div className="text-sm text-muted-foreground">No samples in this range.</div>;
  }

  if (kpi.style === "heat" && kpi.period === "daily") {
    return (
      <ActivityHeatmap
        days={series.map((sample) => ({
          date: (sample.periodStart ?? sample.observedAt).slice(0, 10),
          value: sample.value,
        }))}
        valueLabel={kpi.metric?.unit || "value"}
        marker={
          kpi.bullThreshold != null
            ? { icon: Target, criterion: "above-value", threshold: kpi.bullThreshold }
            : undefined
        }
      />
    );
  }

  if (kpi.style === "heat") {
    const under = kpi.bearThreshold;
    const over = kpi.bullThreshold;
    const values = series.map((sample) => sample.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return (
      <div className="flex flex-wrap gap-1" data-testid={`kpi-heat-${kpi.slug}`}>
        {series.map((sample) => {
          const value = sample.value;
          let fill = heatmapFillColor(((value - min) / span) * 100);
          if (under != null && value < under) fill = "hsl(var(--error) / 0.55)";
          if (over != null && value >= over) fill = "hsl(var(--success) / 0.85)";
          return (
            <Tooltip key={sample.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${sampleLabel(sample)} ${formatValue(value, sample.unit)}`}
                  className="h-6 w-6 rounded-sm"
                  style={{ backgroundColor: fill }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {sampleLabel(sample)} · {formatValue(value, sample.unit)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  const data = series.map((sample) => ({
    label: sampleLabel(sample),
    value: sample.value,
  }));
  return (
    <div className="h-36 w-full" data-testid={`kpi-line-${kpi.slug}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
          <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={36} />
          {kpi.bearThreshold != null ? (
            <ReferenceLine y={kpi.bearThreshold} stroke="hsl(var(--error))" strokeDasharray="3 3" />
          ) : null}
          {kpi.bullThreshold != null ? (
            <ReferenceLine y={kpi.bullThreshold} stroke="hsl(var(--success))" strokeDasharray="3 3" />
          ) : null}
          <Line type="monotone" dataKey="value" stroke="hsl(var(--foreground))" dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CreateKpiDialog({ metrics }: { metrics: Metric[] }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [metricId, setMetricId] = useState("");
  const [name, setName] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [period, setPeriod] = useState<KpiPeriod>("weekly");
  const [samples, setSamples] = useState("1");
  const [style, setStyle] = useState<KpiStyle>("line");
  const [ownerLabel, setOwnerLabel] = useState("");
  const [direction, setDirection] = useState<MetricDirection>("higher_is_better");
  const [over, setOver] = useState("");
  const [under, setUnder] = useState("");

  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const applyPreset = (presetId: string) => {
    const preset = KPI_SAMPLE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setPeriod(preset.period);
    setSamples(String(preset.samples));
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/kpis", {
        metricId,
        name: name.trim(),
        targetLabel: targetLabel.trim() || undefined,
        period,
        samples: period === "live" ? 1 : Number(samples) || 1,
        style,
        ownerLabel: ownerLabel.trim() || undefined,
        direction,
        bullThreshold: num(over),
        bearThreshold: num(under),
        status: "active",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/kpis") });
      toast({ title: "KPI created", description: name });
      setOpen(false);
      setName("");
      setTargetLabel("");
      setOver("");
      setUnder("");
    },
    onError: (error: unknown) => {
      toast({ title: "Failed to create KPI", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const valid = metricId !== "" && name.trim() !== "";
  const selectedMetric = metrics.find((metric) => metric.id === metricId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          disabled={metrics.length === 0}
          data-testid="create-kpi"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New KPI</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New KPI</DialogTitle>
          <DialogDescription>Ask a completed calendar sample of a Metric and judge it against Under and Over.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <ReferencePicker
            types={["metric"]}
            mode="single"
            testId="kpi-metric"
            placeholder="Source metric"
            value={selectedMetric ? [{ type: "metric", id: selectedMetric.id, label: selectedMetric.name }] : []}
            onChange={(next) => setMetricId(next[0]?.id ?? "")}
          />
          <Input placeholder="KPI name" value={name} onChange={(e) => setName(e.target.value)} data-testid="kpi-name" />
          <Input placeholder="Target (e.g. ≥ 99.9% uptime)" value={targetLabel} onChange={(e) => setTargetLabel(e.target.value)} data-testid="kpi-target" />
          <Select onValueChange={applyPreset}>
            <SelectTrigger data-testid="kpi-preset"><SelectValue placeholder="Preset" /></SelectTrigger>
            <SelectContent>
              {KPI_SAMPLE_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Select value={period} onValueChange={(value) => setPeriod(value as KpiPeriod)}>
              <SelectTrigger data-testid="kpi-period"><SelectValue /></SelectTrigger>
              <SelectContent>
                {KPI_PERIODS.map((item) => (
                  <SelectItem key={item} value={item}>{KPI_PERIOD_LABEL[item]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={1}
              max={366}
              disabled={period === "live"}
              placeholder="Samples"
              value={period === "live" ? "1" : samples}
              onChange={(e) => setSamples(e.target.value)}
              data-testid="kpi-samples"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select value={style} onValueChange={(value) => setStyle(value as KpiStyle)}>
              <SelectTrigger data-testid="kpi-style"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="line">Line</SelectItem>
                <SelectItem value="heat">Heat</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="Owner" value={ownerLabel} onChange={(e) => setOwnerLabel(e.target.value)} data-testid="kpi-owner" />
          </div>
          <Select value={direction} onValueChange={(v) => setDirection(v as MetricDirection)}>
            <SelectTrigger data-testid="kpi-direction"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METRIC_DIRECTIONS.map((d) => (
                <SelectItem key={d} value={d}>{DIRECTION_LABEL[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Input type="number" placeholder="Under" value={under} onChange={(e) => setUnder(e.target.value)} data-testid="kpi-under" />
            <Input type="number" placeholder="Over" value={over} onChange={(e) => setOver(e.target.value)} data-testid="kpi-over" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending} data-testid="kpi-submit">
            {mutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KpiExpand({ kpi }: { kpi: Kpi }) {
  const { toast } = useToast();
  const [period, setPeriod] = useState<KpiPeriod>(kpi.period);
  const [samples, setSamples] = useState(String(kpi.samples));
  const [style, setStyle] = useState<KpiStyle>(kpi.style);
  const [under, setUnder] = useState(kpi.bearThreshold != null ? String(kpi.bearThreshold) : "");
  const [over, setOver] = useState(kpi.bullThreshold != null ? String(kpi.bullThreshold) : "");

  const mutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/kpis/${kpi.id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/kpis") });
    },
    onError: (error: unknown) => {
      toast({ title: "Failed to update KPI", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const saveQuestion = (nextPeriod = period, nextSamples = samples, nextStyle = style) => {
    mutation.mutate({
      period: nextPeriod,
      samples: nextPeriod === "live" ? 1 : Number(nextSamples) || 1,
      style: nextStyle,
    });
  };

  return (
    <div className="space-y-3">
      <ReferenceText content={serializeReference({ type: "metric", id: kpi.metricId })} />
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={period}
          onValueChange={(value) => {
            const next = value as KpiPeriod;
            setPeriod(next);
            saveQuestion(next, samples, style);
          }}
        >
          <SelectTrigger data-testid={`kpi-period-${kpi.slug}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {KPI_PERIODS.map((item) => (
              <SelectItem key={item} value={item}>{KPI_PERIOD_LABEL[item]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          min={1}
          max={366}
          disabled={period === "live"}
          value={period === "live" ? "1" : samples}
          onChange={(e) => setSamples(e.target.value)}
          onBlur={() => saveQuestion(period, samples, style)}
          data-testid={`kpi-samples-${kpi.slug}`}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="number"
          placeholder="Under"
          value={under}
          onChange={(e) => setUnder(e.target.value)}
          onBlur={() => mutation.mutate({ bearThreshold: under.trim() === "" ? null : Number(under) })}
          data-testid={`kpi-under-${kpi.slug}`}
        />
        <Input
          type="number"
          placeholder="Over"
          value={over}
          onChange={(e) => setOver(e.target.value)}
          onBlur={() => mutation.mutate({ bullThreshold: over.trim() === "" ? null : Number(over) })}
          data-testid={`kpi-over-${kpi.slug}`}
        />
      </div>
      <Select
        value={style}
        onValueChange={(value) => {
          const next = value as KpiStyle;
          setStyle(next);
          saveQuestion(period, samples, next);
        }}
      >
        <SelectTrigger data-testid={`kpi-style-${kpi.slug}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="line">Line</SelectItem>
          <SelectItem value="heat">Heat</SelectItem>
        </SelectContent>
      </Select>
      <KpiSeriesChart kpi={{ ...kpi, style }} />
      {kpi.coverage && kpi.coverage.status !== "finalized" ? (
        <div className="text-sm text-muted-foreground">
          {kpi.coverage.status}
          {"reason" in kpi.coverage && kpi.coverage.reason ? ` · ${kpi.coverage.reason}` : ""}
        </div>
      ) : null}
      {kpi.targetLabel ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Target className="h-3.5 w-3.5" />
          {kpi.targetLabel}
        </div>
      ) : null}
    </div>
  );
}

export default function BusinessKpisPage() {
  usePageHeader({ title: "KPIs" });
  const [query, setQuery] = useState("");

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<KpisResponse>({
    queryKey: ["/api/kpis"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/kpis");
      return response.json();
    },
  });
  const { data: metricsData } = useQuery<MetricsResponse>({
    queryKey: ["/api/metrics"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/metrics");
      return response.json();
    },
  });

  const kpis = useMemo(() => {
    const list = data?.kpis ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((k) => k.name.toLowerCase().includes(q) || k.slug.toLowerCase().includes(q));
  }, [data, query]);

  const sections = useMemo(() => {
    const grouped = new Map<MetricCatalogFamily, Kpi[]>();
    for (const kpi of kpis) {
      const family = kpi.metric ? metricCatalogFamilyOf(kpi.metric) : "manual";
      const bucket = grouped.get(family) ?? [];
      bucket.push(kpi);
      grouped.set(family, bucket);
    }
    return METRIC_CATALOG_FAMILIES
      .map((family) => ({ family, items: grouped.get(family) ?? [] }))
      .filter((section) => section.items.length > 0);
  }, [kpis]);

  const listErrorMessage = useMemo(() => {
    if (!isError) return null;
    if (!(error instanceof Error) || !error.message.trim()) return "Request failed";
    const raw = error.message.replace(/^\d{3}:\s*/, "").trim();
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // not JSON
    }
    return raw || "Request failed";
  }, [isError, error]);

  return (
    <div className={HIERARCHY_TREE_STACK_CLASS}>
      <HierarchySearchInput
        value={query}
        onChange={setQuery}
        inputTestId="kpis-search"
        clearTestId="button-clear-kpis-search"
        ariaLabel="Search KPIs"
      />
      <CreateKpiDialog metrics={metricsData?.metrics ?? []} />

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading KPIs…
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground" data-testid="kpis-list-error">
          <span className="min-w-0 flex-1 truncate">
            Couldn’t load KPIs{listErrorMessage ? `: ${listErrorMessage}` : "."}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-sm"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid="kpis-list-retry"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry"}
          </Button>
        </div>
      ) : kpis.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No KPIs yet.
        </div>
      ) : (
        sections.map((section) => (
          <div key={section.family} className="space-y-0">
            <HierarchySectionHeader data-testid={`kpi-section-${section.family}`}>
              {METRIC_CATALOG_FAMILY_LABEL[section.family]}
            </HierarchySectionHeader>
            {section.items.map((kpi) => {
              const band = kpi.score?.band ?? "unmeasured";
              return (
                <ProfileTreeRow
                  key={kpi.id}
                  label={kpi.name}
                  icon={<Gauge className="h-3.5 w-3.5" />}
                  hasValue
                  showEmpty
                  mobileLayout="inline"
                  valueLayout="compact"
                  testId={`kpi-row-${kpi.slug}`}
                  expandedContent={<KpiExpand kpi={kpi} />}
                >
                  <span className="whitespace-nowrap font-mono">
                    {formatValue(kpi.score?.value ?? null, kpi.score?.unit ?? "")}
                    {band !== "unmeasured" ? (
                      <span className="ml-2 font-sans text-muted-foreground">{BAND_LABEL[band]}</span>
                    ) : null}
                  </span>
                </ProfileTreeRow>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
