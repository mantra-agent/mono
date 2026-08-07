import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, FunctionSquare, Loader2, Plus, PenLine, Trash2 } from "lucide-react";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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

const ADAPTER_SECTION_LABEL: Record<MetricAdapterKind, string> = {
  manual: "Manual",
  internal: "Internal",
  expression: "Expression",
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
  metric,
  onRequestDelete,
}: {
  metric: Metric;
  onRequestDelete: (metric: Metric) => void;
}) {
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
      expandedContent={<RecordSampleForm metric={metric} />}
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
  const [query, setQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Metric | null>(null);

  const { data, isLoading } = useQuery<MetricsResponse>({
    queryKey: ["/api/business/metrics"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (metric: Metric) => {
      const res = await apiRequest("DELETE", `/api/business/metrics/${metric.id}`);
      return res.json();
    },
    onSuccess: (_result, metric) => {
      queryClient.invalidateQueries({ queryKey: ["/api/business/metrics"] });
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

  const metrics = useMemo(() => {
    const list = data?.metrics ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q));
  }, [data, query]);

  const sections = useMemo(
    () =>
      METRIC_ADAPTER_KINDS.map((kind) => ({
        kind,
        label: ADAPTER_SECTION_LABEL[kind] ?? kind,
        items: metrics.filter((m) => m.adapterKind === kind),
      })).filter((section) => section.items.length > 0),
    [metrics],
  );

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={query}
          onChange={setQuery}
          inputTestId="metrics-search"
          clearTestId="button-clear-metrics-search"
          ariaLabel="Search metrics"
        />
        <CreateMetricDialog />
      </div>

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
          {sections.map((section) => (
            <div key={section.kind} className={HIERARCHY_TREE_STACK_CLASS}>
              <HierarchySectionHeader data-testid={`metric-section-${section.kind}`}>
                {section.label}
              </HierarchySectionHeader>
              {section.items.map((metric) => (
                <MetricTreeRow
                  key={metric.id}
                  metric={metric}
                  onRequestDelete={setDeleteTarget}
                />
              ))}
            </div>
          ))}
        </div>
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
