import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gauge, Loader2, Plus, Target } from "lucide-react";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import {
  METRIC_DIRECTIONS,
  type Kpi,
  type KpiScoreBand,
  type Metric,
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface KpisResponse {
  kpis: Kpi[];
}
interface MetricsResponse {
  metrics: Metric[];
}

const BAND_STYLE: Record<KpiScoreBand, { label: string; className: string }> = {
  bull: { label: "Bull", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  on_track: { label: "On track", className: "bg-teal-500/15 text-teal-300 border-teal-500/30" },
  bear: { label: "Bear", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  critical: { label: "Critical", className: "bg-red-500/15 text-red-300 border-red-500/30" },
  stale: { label: "Stale", className: "bg-slate-500/15 text-slate-300 border-slate-500/30" },
  unavailable: { label: "Unavailable", className: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
  unmeasured: { label: "Unmeasured", className: "bg-muted text-muted-foreground border-border" },
};

const DIRECTION_LABEL: Record<MetricDirection, string> = {
  higher_is_better: "Higher is better",
  lower_is_better: "Lower is better",
  target_band: "Target band",
};

function BandPill({ band }: { band: KpiScoreBand }) {
  const style = BAND_STYLE[band] ?? BAND_STYLE.unmeasured;
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", style.className)}>
      {style.label}
    </span>
  );
}

function formatValue(value: number | null, unit: string): string {
  if (value == null) return "—";
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function CreateKpiDialog({ metrics }: { metrics: Metric[] }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [metricId, setMetricId] = useState("");
  const [name, setName] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [cadence, setCadence] = useState("Weekly");
  const [ownerLabel, setOwnerLabel] = useState("");
  const [direction, setDirection] = useState<MetricDirection>("higher_is_better");
  const [bull, setBull] = useState("");
  const [onTrack, setOnTrack] = useState("");
  const [bear, setBear] = useState("");

  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/business/kpis", {
        metricId,
        name: name.trim(),
        targetLabel: targetLabel.trim() || undefined,
        cadence: cadence.trim() || undefined,
        ownerLabel: ownerLabel.trim() || undefined,
        direction,
        bullThreshold: num(bull),
        onTrackThreshold: num(onTrack),
        bearThreshold: num(bear),
        status: "active",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/business/kpis") });
      toast({ title: "KPI created", description: name });
      setOpen(false);
      setName("");
      setTargetLabel("");
      setBull("");
      setOnTrack("");
      setBear("");
    },
    onError: (error: unknown) => {
      toast({ title: "Failed to create KPI", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const valid = metricId !== "" && name.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={metrics.length === 0} data-testid="create-kpi">
          <Plus className="mr-1 h-4 w-4" /> New KPI
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New KPI</DialogTitle>
          <DialogDescription>Bind a target and band thresholds to a metric to track where you stand.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={metricId} onValueChange={setMetricId}>
            <SelectTrigger data-testid="kpi-metric"><SelectValue placeholder="Source metric" /></SelectTrigger>
            <SelectContent>
              {metrics.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input placeholder="KPI name" value={name} onChange={(e) => setName(e.target.value)} data-testid="kpi-name" />
          <Input placeholder="Target (e.g. ≥ 99.9% uptime)" value={targetLabel} onChange={(e) => setTargetLabel(e.target.value)} data-testid="kpi-target" />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Cadence" value={cadence} onChange={(e) => setCadence(e.target.value)} data-testid="kpi-cadence" />
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
          <div className="grid grid-cols-3 gap-2">
            <Input type="number" placeholder="Bull ≥" value={bull} onChange={(e) => setBull(e.target.value)} data-testid="kpi-bull" />
            <Input type="number" placeholder="On track ≥" value={onTrack} onChange={(e) => setOnTrack(e.target.value)} data-testid="kpi-ontrack" />
            <Input type="number" placeholder="Bear ≥" value={bear} onChange={(e) => setBear(e.target.value)} data-testid="kpi-bear" />
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

export default function BusinessKpisPage() {
  const { businesses, selectedId, setSelectedId } = useSelectedBusiness();
  const [query, setQuery] = useState("");
  const kpisUrl = selectedId ? `/api/business/kpis?businessId=${encodeURIComponent(selectedId)}` : "/api/business/kpis";
  const metricsUrl = selectedId ? `/api/business/metrics?businessId=${encodeURIComponent(selectedId)}` : "/api/business/metrics";

  const { data, isLoading } = useQuery<KpisResponse>({ queryKey: [kpisUrl], enabled: Boolean(selectedId) });
  const { data: metricsData } = useQuery<MetricsResponse>({ queryKey: [metricsUrl], enabled: Boolean(selectedId) });

  const kpis = useMemo(() => {
    const list = data?.kpis ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((k) => k.name.toLowerCase().includes(q) || k.slug.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <div className="p-4">
      <BusinessPageHeader page="KPIs" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Gauge className="h-5 w-5 text-muted-foreground" /> KPIs
          </h1>
          <p className="text-sm text-muted-foreground">Targets and band thresholds over your metrics. Bands show where you stand.</p>
        </div>
        <CreateKpiDialog metrics={metricsData?.metrics ?? []} />
      </div>

      <Input
        placeholder="Search KPIs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-4"
        data-testid="kpis-search"
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading KPIs…
        </div>
      ) : kpis.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          No KPIs yet. Create a metric first, then bind a KPI to it.
        </div>
      ) : (
        <div className="space-y-2">
          {kpis.map((kpi) => {
            const band = kpi.score?.band ?? "unmeasured";
            return (
              <div
                key={kpi.id}
                className="rounded-lg border bg-card p-3"
                data-testid={`kpi-row-${kpi.slug}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{kpi.name}</span>
                      <BandPill band={band} />
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {kpi.targetLabel ? <span className="inline-flex items-center gap-1"><Target className="h-3 w-3" />{kpi.targetLabel}</span> : null}
                      {kpi.cadence ? <span>· {kpi.cadence}</span> : null}
                      {kpi.ownerLabel ? <span>· {kpi.ownerLabel}</span> : null}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm">{formatValue(kpi.score?.value ?? null, kpi.score?.unit ?? "")}</div>
                    {kpi.metric ? <div className="text-xs text-muted-foreground">{kpi.metric.name}</div> : null}
                  </div>
                </div>
                {(kpi.bullThreshold != null || kpi.onTrackThreshold != null || kpi.bearThreshold != null) && (
                  <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
                    {kpi.bullThreshold != null && <span>Bull ≥ {kpi.bullThreshold}</span>}
                    {kpi.onTrackThreshold != null && <span>On track ≥ {kpi.onTrackThreshold}</span>}
                    {kpi.bearThreshold != null && <span>Bear ≥ {kpi.bearThreshold}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
