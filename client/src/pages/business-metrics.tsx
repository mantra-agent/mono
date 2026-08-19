import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Database, FunctionSquare, Loader2, Plus, PenLine, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  METRIC_CATALOG_FAMILIES,
  METRIC_CATALOG_FAMILY_LABEL,
  metricCatalogFamilyOf,
  type Metric,
  type MetricCatalogFamily,
  type MetricSeries,
} from "@shared/models/metrics";
import {
  METRIC_PRODUCER_FAMILY_LABEL,
  METRIC_PRODUCER_PICKER_ITEMS,
  type MetricProducerFamily,
} from "@shared/metric-producers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { serializeReference } from "@shared/references";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

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

const ADAPTER_ICON: Record<"manual" | "internal" | "expression", typeof Database> = {
  manual: PenLine,
  internal: Database,
  expression: FunctionSquare,
};

function equationOf(metric: Metric): string {
  const raw = metric.adapterConfig?.equation;
  return typeof raw === "string" ? raw : "";
}

function MetricEquationEditor({
  equation,
  onEquationChange,
  operands,
  onOperandsChange,
  excludeMetricId,
}: {
  equation: string;
  onEquationChange: (next: string) => void;
  operands: ReferencePickerValue[];
  onOperandsChange: (next: ReferencePickerValue[]) => void;
  excludeMetricId?: string;
}) {
  const producersByFamily = useMemo(() => {
    const map = new Map<MetricProducerFamily, typeof METRIC_PRODUCER_PICKER_ITEMS[number][]>();
    for (const item of METRIC_PRODUCER_PICKER_ITEMS) {
      const list = map.get(item.family) ?? [];
      list.push(item);
      map.set(item.family, list);
    }
    return map;
  }, []);

  return (
    <div className="space-y-2">
      <Input
        placeholder="Equation"
        value={equation}
        onChange={(e) => onEquationChange(e.target.value)}
        data-testid="metric-equation"
        className="font-mono text-sm"
      />
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">Producers</div>
        {([...producersByFamily.entries()] as Array<[MetricProducerFamily, typeof METRIC_PRODUCER_PICKER_ITEMS[number][]]>).map(
          ([family, items]) => (
            <div key={family} className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
                {METRIC_PRODUCER_FAMILY_LABEL[family]}
              </div>
              <div className="flex flex-wrap gap-1">
                {items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-accent"
                    data-testid={`metric-producer-${item.key}`}
                    onClick={() => {
                      onEquationChange(equation.trim() ? `${equation.trim()} ${item.key}` : item.key);
                    }}
                  >
                    {item.key}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Metrics</div>
        <ReferencePicker
          value={operands}
          onChange={(next) => {
            const added = next.find((item) => !operands.some((existing) => existing.id === item.id));
            onOperandsChange(next);
            if (!added) return;
            if (excludeMetricId && added.id === excludeMetricId) return;
            const token = serializeReference({ type: "metric", id: added.id });
            onEquationChange(equation.trim() ? `${equation.trim()} ${token}` : token);
          }}
          types={["metric"]}
          mode="multi"
          variant="inline"
          placeholder="Add metric"
          testId="metric-equation-operand"
        />
      </div>
    </div>
  );
}

const METRIC_SECTIONS_COLLAPSED_KEY = "metrics-catalog-sections-collapsed";

function loadCollapsedFamilies(): Set<MetricCatalogFamily> {
  try {
    const raw = localStorage.getItem(METRIC_SECTIONS_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is MetricCatalogFamily =>
        (METRIC_CATALOG_FAMILIES as readonly string[]).includes(value),
      ),
    );
  } catch {
    return new Set();
  }
}

function saveCollapsedFamilies(collapsed: Set<MetricCatalogFamily>) {
  try {
    localStorage.setItem(METRIC_SECTIONS_COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* ignore quota / private mode */
  }
}

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

  return (
    <div className="max-w-xl space-y-3 py-1">
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

function MetricDefinitionEditor({ metric }: { metric: Metric }) {
  const { toast } = useToast();
  const [description, setDescription] = useState(metric.description ?? "");
  const [equation, setEquation] = useState(equationOf(metric));
  const [operands, setOperands] = useState<ReferencePickerValue[]>([]);
  const isManual = metric.adapterKind === "manual" || equationOf(metric) === "manual";

  useEffect(() => {
    setDescription(metric.description ?? "");
    setEquation(equationOf(metric));
  }, [metric.id, metric.description, metric.adapterConfig]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/metrics/${metric.id}`, {
        description,
        adapterConfig: { equation: equation.trim() },
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/metrics") });
      toast({ title: "Metric saved", description: metric.name });
    },
    onError: (error: unknown) => {
      toast({
        title: "Failed to save metric",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const canSave = equation.trim().length > 0 && !mutation.isPending;

  return (
    <div className="max-w-xl space-y-3 py-1">
      <Textarea
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        data-testid={`metric-description-${metric.slug}`}
      />
      <MetricEquationEditor
        equation={equation}
        onEquationChange={setEquation}
        operands={operands}
        onOperandsChange={setOperands}
        excludeMetricId={metric.id}
      />
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={!canSave}
        data-testid={`metric-save-${metric.slug}`}
      >
        {mutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Save definition
      </Button>
      {isManual ? <RecordSampleForm metric={metric} /> : null}
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
  const coverage = series.coverage?.status;
  const unavailable = coverage === "unavailable" || coverage === "unbound";
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
      expandedContent={<MetricDefinitionEditor metric={metric} />}
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
          <span data-testid={`metric-menu-empty-${metric.slug}`} />
        )
      }
    >
      <span className={cn("whitespace-nowrap font-mono", (!sample || unavailable) && "text-muted-foreground")}>
        {unavailable ? (coverage === "unbound" ? "unbound" : "unavailable") : sample ? formatValue(sample.value, sample.unit) : "—"}
      </span>
    </ProfileTreeRow>
  );
}

function CreateMetricDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [equation, setEquation] = useState("");
  const [operands, setOperands] = useState<ReferencePickerValue[]>([]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/metrics", {
        name: name.trim(),
        description: description.trim(),
        status: "active",
        adapterConfig: { equation: equation.trim() },
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/metrics") });
      toast({ title: "Metric created", description: name });
      setOpen(false);
      setName("");
      setDescription("");
      setEquation("");
      setOperands([]);
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
          <DialogDescription>Name, description, and equation. The equation is the definition.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Metric name" value={name} onChange={(e) => setName(e.target.value)} data-testid="metric-name" />
          <Textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="metric-description"
          />
          <MetricEquationEditor
            equation={equation}
            onEquationChange={setEquation}
            operands={operands}
            onOperandsChange={setOperands}
          />
        </div>
        <DialogFooter>
          <Button
            onClick={() => mutation.mutate()}
            disabled={name.trim() === "" || equation.trim() === "" || mutation.isPending}
            data-testid="metric-submit"
          >
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
  usePageHeader({ title: "Metrics" });
  const [query, setQuery] = useState("");
  const [sampleSpan, setSampleSpan] = useState<SampleSpan>("today");
  const [deleteTarget, setDeleteTarget] = useState<Metric | null>(null);
  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<MetricCatalogFamily>>(loadCollapsedFamilies);

  useEffect(() => {
    saveCollapsedFamilies(collapsedFamilies);
  }, [collapsedFamilies]);

  function toggleFamily(family: MetricCatalogFamily) {
    setCollapsedFamilies((current) => {
      const next = new Set(current);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  const samplingRange = useMemo(() => {
    const end = new Date();
    return { start: rangeStart(sampleSpan, end), end };
  }, [sampleSpan]);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<MetricsResponse>({
    queryKey: ["/api/metrics", sampleSpan],
    queryFn: async () => {
      const url = `/api/metrics?start=${encodeURIComponent(samplingRange.start.toISOString())}&end=${encodeURIComponent(samplingRange.end.toISOString())}`;
      const response = await apiRequest("GET", url);
      return response.json();
    },
    refetchInterval: 60_000,
  });

  const listErrorMessage = useMemo(() => {
    if (!isError) return null;
    if (!(error instanceof Error) || !error.message.trim()) return "Request failed";
    const raw = error.message.replace(/^\d{3}:\s*/, "").trim();
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // not JSON — use stripped status body
    }
    return raw || "Request failed";
  }, [isError, error]);

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
    const list = (data?.metrics ?? []).map((metric) => ({
      metric,
      samples: metric.latestSample ? [metric.latestSample] : [],
      valueStatus: "actual" as const,
      coverage: metric.coverage ?? { status: "finalized" as const },
    }));
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(({ metric }) => metric.name.toLowerCase().includes(q) || metric.slug.toLowerCase().includes(q));
  }, [data, query]);

  const sections = useMemo(() => {
    const grouped = new Map<MetricCatalogFamily, typeof series>();
    for (const item of series) {
      const family = metricCatalogFamilyOf(item.metric);
      const bucket = grouped.get(family) ?? [];
      bucket.push(item);
      grouped.set(family, bucket);
    }
    return METRIC_CATALOG_FAMILIES
      .map((family) => ({ family, items: grouped.get(family) ?? [] }))
      .filter((section) => section.items.length > 0);
  }, [series]);

  return (
    <div className={HIERARCHY_TREE_STACK_CLASS}>
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
      <CreateMetricDialog />

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading metrics…
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground" data-testid="metrics-list-error">
          <span className="min-w-0 flex-1 truncate">
            Couldn’t load metrics{listErrorMessage ? `: ${listErrorMessage}` : "."}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-sm"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid="metrics-list-retry"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry"}
          </Button>
        </div>
      ) : series.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No metrics yet.
        </div>
      ) : (
        <>
          {sections.map((section) => {
            const isOpen = !collapsedFamilies.has(section.family);
            return (
              <Collapsible
                key={section.family}
                open={isOpen}
                onOpenChange={() => toggleFamily(section.family)}
              >
                <div className="space-y-0">
                  <CollapsibleTrigger
                    className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
                    data-testid={`metric-section-${section.family}`}
                  >
                    <ChevronRight
                      className={cn("h-3 w-3 shrink-0 transition-transform", isOpen && "rotate-90")}
                    />
                    {METRIC_CATALOG_FAMILY_LABEL[section.family]}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {section.items.map((item) => (
                      <MetricTreeRow
                        key={item.metric.id}
                        series={item}
                        onRequestDelete={setDeleteTarget}
                      />
                    ))}
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
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
