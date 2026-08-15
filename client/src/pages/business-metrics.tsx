import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, FunctionSquare, Loader2, Plus, PenLine, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  METRIC_ADAPTER_KINDS,
  METRIC_DIRECTIONS,
  METRIC_SAMPLE_PERIODS,
  type Metric,
  type MetricAdapterKind,
  type MetricCollection,
  type MetricDirection,
  type MetricSeries,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HierarchySectionHeader,
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { useSelectedBusiness } from "@/hooks/use-selected-business";

interface MetricsResponse {
  metrics: Metric[];
}

const SAMPLE_SPANS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
] as const;

type SampleSpan = (typeof SAMPLE_SPANS)[number]["key"];

function rangeStart(span: SampleSpan, end: Date): Date {
  if (span === "today") {
    return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  }
  const days = SAMPLE_SPANS.find((option) => option.key === span)?.days ?? 7;
  return new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
}

function SamplingMenu({ value, onChange }: { value: SampleSpan; onChange: (value: SampleSpan) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Metric sampling"
          data-testid="metrics-sampling-menu"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Sampling span
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as SampleSpan)}>
              {SAMPLE_SPANS.map((option) => (
                <DropdownMenuRadioItem key={option.key} value={option.key}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

function formatValue(value: number, unit: string): string {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

/**
 * Inline record-sample form. Recording an observation is the frequent,
 * lightweight action, so it lives inside the row's expanded detail rather than
 * behind a modal — the canonical inline-edit pattern shared with the account
 * profile rows.
 */
function RecordSampleForm({ metric }: { metric: Metric }) {
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [evidence, setEvidence] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/metrics/${metric.id}/samples`, {
        value: Number(value),
        unit: metric.unit,
        evidence: evidence.trim() || undefined,
        sourceRef: "manual",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/metrics") });
      queryClient.invalidateQueries({ queryKey: ["/api/business/kpis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/business/kpis/standing-scores"] });
      toast({ title: "Sample recorded", description: `${metric.name} updated.` });
      setValue("");
      setEvidence("");
    },
    onError: (error: unknown) => {
      toast({ title: "Failed to record sample", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const valid = value.trim() !== "" && Number.isFinite(Number(value));
  const AdapterIcon = ADAPTER_ICON[metric.adapterKind] ?? Database;

  return (
    <div className="max-w-xl space-y-3 py-1">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <AdapterIcon className="h-3 w-3" />
          <span className="capitalize text-foreground">{metric.adapterKind}</span>
        </div>
        <div>{DIRECTION_LABEL[metric.direction]}</div>
        <div>Period · <span className="text-foreground">{metric.samplePeriod}</span></div>
        <div>Unit · <span className="text-foreground">{metric.unit || "—"}</span></div>
      </dl>

      {metric.latestSample?.evidence ? (
        <p className="rounded-md bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
          {metric.latestSample.evidence}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Input
          type="number"
          placeholder="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid={`sample-value-${metric.slug}`}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{metric.unit || "units"}</span>
      </div>
      <Textarea
        placeholder="Evidence / source note (optional)"
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        data-testid={`sample-evidence-${metric.slug}`}
      />
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={!valid || mutation.isPending}
        data-testid={`sample-submit-${metric.slug}`}
      >
        {mutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
        Record sample
      </Button>
    </div>
  );
}

function MetricTreeRow({
  series,
  onRequestDelete,
}: {
  series: MetricSeries;
  onRequestDelete: (metric: Metric) => void;
}) {
  const metric = series.metric;
  const AdapterIcon = ADAPTER_ICON[metric.adapterKind] ?? Database;
  const sample = metric.latestSample;
  const isManual = metric.adapterKind === "manual";

  return (
    <ProfileTreeRow
      label={metric.name}
      icon={<AdapterIcon className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      menuVisibility="hover"
      testId={`metric-row-${metric.slug}`}
      expandedContent={isManual ? <RecordSampleForm metric={metric} /> : (
        <div className="space-y-1 py-1 text-xs text-muted-foreground">
          <div>{sample?.sourceRef ?? "Source unavailable"}</div>
          {sample?.evidence ? <div>{sample.evidence}</div> : null}
        </div>
      )}
      menuContent={
        isManual ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              onRequestDelete(metric);
            }}
            data-testid={`metric-menu-delete-${metric.slug}`}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        ) : (
          // Internal/expression rows keep the SessionMenu ellipsis with a blank
          // submenu until actions are defined.
          <span data-testid={`metric-menu-empty-${metric.slug}`} />
        )
      }
    >
      <span className={cn("whitespace-nowrap font-mono", !sample && "text-muted-foreground")}>
        {sample ? formatValue(sample.value, sample.unit) : "—"}
      </span>
    </ProfileTreeRow>
  );
}

function CreateMetricDialog({ businessId }: { businessId: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [direction, setDirection] = useState<MetricDirection>("higher_is_better");
  const [adapterKind, setAdapterKind] = useState<MetricAdapterKind>("manual");
  const [samplePeriod, setSamplePeriod] = useState<string>("point");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/metrics", {
        businessId,
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
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/metrics") });
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
        <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="create-metric">
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Metric</span>
        </button>
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
  const { toast } = useToast();
  const { businesses, selectedId, setSelectedId } = useSelectedBusiness();
  const [query, setQuery] = useState("");
  const [sampleSpan, setSampleSpan] = useState<SampleSpan>("today");
  const [deleteTarget, setDeleteTarget] = useState<Metric | null>(null);

  const samplingRange = useMemo(() => {
    const end = new Date();
    return { start: rangeStart(sampleSpan, end), end };
  }, [sampleSpan]);
  const { data, isLoading } = useQuery<MetricCollection>({
    queryKey: ["/api/metrics/collection", selectedId, sampleSpan],
    queryFn: async () => {
      const url = `/api/metrics/collection?businessId=${encodeURIComponent(selectedId ?? "")}&start=${encodeURIComponent(samplingRange.start.toISOString())}&end=${encodeURIComponent(samplingRange.end.toISOString())}`;
      const response = await apiRequest("GET", url);
      return response.json();
    },
    enabled: Boolean(selectedId),
    refetchInterval: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (metric: Metric) => {
      const res = await apiRequest("DELETE", `/api/metrics/${metric.id}`);
      return res.json();
    },
    onSuccess: (_result, metric) => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/metrics") });
      queryClient.invalidateQueries({ queryKey: ["/api/business/kpis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/business/kpis/standing-scores"] });
      toast({ title: "Metric deleted", description: metric.name });
      setDeleteTarget(null);
    },
    onError: (error: unknown) => {
      toast({
        title: "Failed to delete metric",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const series = useMemo(() => {
    const list = data?.series ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(({ metric }) => metric.name.toLowerCase().includes(q) || metric.slug.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <div className={HIERARCHY_TREE_STACK_CLASS}>
      <BusinessPageHeader
        page="Metrics"
        businesses={businesses}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <HierarchySearchInput
            value={query}
            onChange={setQuery}
            inputTestId="metrics-search"
            clearTestId="button-clear-metrics-search"
            ariaLabel="Search metrics"
          />
        </div>
        <SamplingMenu value={sampleSpan} onChange={setSampleSpan} />
      </div>
      {selectedId ? <CreateMetricDialog businessId={selectedId} /> : null}

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading metrics…
        </div>
      ) : series.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No metrics yet.
        </div>
      ) : (
        <>
          <HierarchySectionHeader data-testid="metric-section-metrics">
            Metrics · {SAMPLE_SPANS.find((option) => option.key === sampleSpan)?.label}
          </HierarchySectionHeader>
          {series.map((item) => (
            <MetricTreeRow
              key={item.metric.id}
              series={item}
              onRequestDelete={setDeleteTarget}
            />
          ))}
        </>
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete metric</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `Delete “${deleteTarget.name}” and its samples? This cannot be undone.`
                : "Delete this metric and its samples? This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-metric-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!deleteTarget || deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget);
              }}
              data-testid="button-metric-delete-confirm"
            >
              {deleteMutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
