import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gauge, Loader2, Plus, Target } from "lucide-react";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HierarchySectionHeader,
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
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
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";

interface KpisResponse {
  kpis: Kpi[];
}
interface MetricsResponse {
  metrics: Metric[];
}

const BAND_LABEL: Record<KpiScoreBand, string> = {
  bull: "Bull",
  on_track: "On track",
  bear: "Bear",
  critical: "Critical",
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
      const res = await apiRequest("POST", "/api/kpis", {
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
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/kpis") });
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
  usePageHeader({ title: "KPIs" });
  const [query, setQuery] = useState("");
  const kpisUrl = selectedId ? `/api/kpis?businessId=${encodeURIComponent(selectedId)}` : "/api/kpis";
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
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={query}
          onChange={setQuery}
          inputTestId="kpis-search"
          clearTestId="button-clear-kpis-search"
          ariaLabel="Search KPIs"
        />
        <CreateKpiDialog metrics={metricsData?.metrics ?? []} />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading KPIs…
        </div>
      ) : kpis.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No KPIs yet.
        </div>
      ) : (
        <div className="py-4">
          <HierarchySectionHeader data-testid="kpi-section-current">Current</HierarchySectionHeader>
          {kpis.map((kpi) => {
            const band = kpi.score?.band ?? "unmeasured";
            const details = [kpi.metric?.name, kpi.targetLabel, kpi.cadence, kpi.ownerLabel].filter(Boolean) as string[];
            const thresholds = [
              kpi.bullThreshold != null ? `Bull ≥ ${kpi.bullThreshold}` : null,
              kpi.onTrackThreshold != null ? `On track ≥ ${kpi.onTrackThreshold}` : null,
              kpi.bearThreshold != null ? `Bear ≥ ${kpi.bearThreshold}` : null,
            ].filter(Boolean) as string[];
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
                expandedContent={
                  details.length > 0 || thresholds.length > 0 ? (
                    <div className="space-y-1 text-muted-foreground">
                      {details.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {kpi.targetLabel ? <Target className="h-3.5 w-3.5" /> : null}
                          {details.map((detail) => <span key={detail}>{detail}</span>)}
                        </div>
                      ) : null}
                      {thresholds.length > 0 ? <div>{thresholds.join(" · ")}</div> : null}
                    </div>
                  ) : undefined
                }
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
      )}
    </div>
  );
}
