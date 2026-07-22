import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Clock, FileJson2, Layers, ShieldCheck } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { cn } from "@/lib/utils";
import type { SpineMetadata } from "@shared/context-spine";
import type {
  InferencePayloadCapture,
  InferencePayloadCaptureListResponse,
  InferencePayloadCaptureSummary,
} from "@shared/inference-payload";

function formatModelName(modelId: string): string {
  const name = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return name.replace(/-\d{8}$/, "");
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function SummaryBar({ metadata }: { metadata: SpineMetadata }) {
  const usagePct = metadata.contextWindow && metadata.contextWindow > 0
    ? Math.min((metadata.totalTokens / metadata.contextWindow) * 100, 100)
    : null;
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground" data-testid="context-summary-bar">
      <span className="flex items-center gap-1">
        <Layers className="h-3 w-3" />
        {metadata.activeSectionCount}/{metadata.sectionCount} sections
      </span>
      {metadata.contextWindow && metadata.modelId && usagePct !== null && (
        <>
          <span>{formatModelName(metadata.modelId)} / {metadata.modelTier} tier</span>
          <span className="tabular-nums">
            {formatTokens(metadata.totalTokens)} / {formatTokens(metadata.contextWindow)} ({usagePct.toFixed(1)}%)
          </span>
        </>
      )}
    </div>
  );
}

function RuntimeCard({ metadata }: { metadata: SpineMetadata }) {
  const coding = metadata.codingContext;
  return (
    <Card className="flex-1 min-h-0 min-w-0 overflow-auto">
      <div className="p-4 space-y-4">
        <h2 className="text-sm font-semibold">Runtime</h2>
        {coding ? (
          <div className="space-y-2">
            {coding.requiredReferences.map((reference) => (
              <div key={reference.id} className="flex items-start justify-between gap-4 border-b border-border/20 py-2 text-sm last:border-b-0">
                <div className="min-w-0">
                  <div>{reference.label}</div>
                  {reference.source && <div className="font-mono text-xs text-muted-foreground break-all">{reference.source}</div>}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{reference.loaded ? "loaded" : reference.required ? "tool boundary" : "on demand"}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No coding context metadata recorded.</div>
        )}
      </div>
    </Card>
  );
}

function InstructionsCard({ metadata }: { metadata: SpineMetadata }) {
  return (
    <Card className="flex-1 min-h-0 min-w-0 overflow-auto">
      <div className="p-4 space-y-3">
        <h2 className="text-sm font-semibold">Instructions</h2>
        {(metadata.instructionGroups || []).map((group) => (
          <div key={group.id} className="flex items-start justify-between gap-4 border-b border-border/20 py-2 text-sm last:border-b-0">
            <div className="min-w-0">
              <div>{group.title}</div>
              <div className="font-mono text-xs text-muted-foreground break-all">{group.id}</div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatTokens(group.tokenCount)} tokens</span>
          </div>
        ))}
        {(metadata.instructionGroups || []).length === 0 && (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No instruction groups recorded.</div>
        )}
      </div>
    </Card>
  );
}

interface PayloadNode {
  id: string;
  label: string;
  value: unknown;
  depth: number;
  children: PayloadNode[];
}

function buildPayloadNode(label: string, value: unknown, depth = 0, path = "request"): PayloadNode {
  const entries = Array.isArray(value)
    ? value.map((item, index) => [`[${index}]`, item] as const)
    : value !== null && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];
  return {
    id: path,
    label,
    value,
    depth,
    children: entries.map(([key, child]) => buildPayloadNode(key, child, depth + 1, `${path}.${key}`)),
  };
}

function rawValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

function nodeMeta(node: PayloadNode): string {
  if (Array.isArray(node.value)) return `${node.value.length} items`;
  if (node.value !== null && typeof node.value === "object") return `${node.children.length} fields`;
  if (typeof node.value === "string") return `${node.value.length.toLocaleString()} chars`;
  if (node.value === null) return "null";
  return typeof node.value;
}

interface PayloadIndexNodeProps {
  node: PayloadNode;
  expanded: Set<string>;
  activeId: string;
  onToggle: (id: string) => void;
  onNavigate: (id: string) => void;
  continues: boolean;
}

function PayloadIndexNode({ node, expanded, activeId, onToggle, onNavigate, continues }: PayloadIndexNodeProps) {
  const hasChildren = node.children.length > 0;
  const open = expanded.has(node.id);
  const row = (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-xs", activeId === node.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground")}>
      {hasChildren ? (
        <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded" onClick={() => onToggle(node.id)} aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}>
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        </button>
      ) : <span className="h-5 w-5 shrink-0" />}
      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onNavigate(node.id)}>{node.label}</button>
    </div>
  );
  return (
    <div>
      {node.depth > 0 ? <HierarchyTreeRow continues={continues}>{row}</HierarchyTreeRow> : row}
      {hasChildren && open && node.children.map((child, index) => (
        <PayloadIndexNode
          key={child.id}
          node={child}
          expanded={expanded}
          activeId={activeId}
          onToggle={onToggle}
          onNavigate={onNavigate}
          continues={index < node.children.length - 1}
        />
      ))}
    </div>
  );
}

interface PayloadContentNodeProps {
  node: PayloadNode;
  openIds: Set<string>;
  onOpenChange: (id: string, open: boolean) => void;
  refs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  continues: boolean;
}

function PayloadContentNode({ node, openIds, onOpenChange, refs, continues }: PayloadContentNodeProps) {
  const open = openIds.has(node.id);
  const setRef = useCallback((element: HTMLDivElement | null) => {
    if (element) refs.current.set(node.id, element);
    else refs.current.delete(node.id);
  }, [node.id, refs]);
  const content = (
    <Collapsible open={open} onOpenChange={(next) => onOpenChange(node.id, next)}>
      <div ref={setRef} id={`payload-${node.id}`} className="min-w-0 rounded-md hover:bg-accent/40">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex min-h-11 w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-sm sm:min-h-8">
            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
            <span className="min-w-0 flex-1 truncate font-mono">{node.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{nodeMeta(node)}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-2 pb-2 pl-8">
            <pre className="max-h-none min-w-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground" data-testid={`payload-raw-${node.id}`}>
              {rawValue(node.value)}
            </pre>
            {node.children.length > 0 && (
              <div className="mt-2">
                {node.children.map((child, index) => (
                  <PayloadContentNode
                    key={child.id}
                    node={child}
                    openIds={openIds}
                    onOpenChange={onOpenChange}
                    refs={refs}
                    continues={index < node.children.length - 1}
                  />
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
  return node.depth > 0 ? <HierarchyTreeRow continues={continues}>{content}</HierarchyTreeRow> : content;
}

function PromptCaptureTree({ capture }: { capture: InferencePayloadCapture }) {
  const root = useMemo(() => buildPayloadNode(`inference call ${capture.id}`, capture.request), [capture.id, capture.request]);
  const [indexExpanded, setIndexExpanded] = useState<Set<string>>(() => new Set([root.id]));
  const [contentOpen, setContentOpen] = useState<Set<string>>(() => new Set([root.id]));
  const [activeId, setActiveId] = useState(root.id);
  const contentRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    setIndexExpanded(new Set([root.id]));
    setContentOpen(new Set([root.id]));
    setActiveId(root.id);
  }, [capture.id, root.id]);

  const toggleSet = useCallback((setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, forced?: boolean) => {
    setter((current) => {
      const next = new Set(current);
      const shouldOpen = forced ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const navigate = useCallback((id: string) => {
    setActiveId(id);
    toggleSet(setContentOpen, id, true);
    requestAnimationFrame(() => contentRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [toggleSet]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{capture.provider} / {capture.model}</span>
        <span>{capture.boundary}</span>
        <span>{capture.requestChars.toLocaleString()} chars</span>
        <span>attempt {capture.attempt}</span>
      </div>
      <div className="rounded-md border border-border/30 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 text-foreground"><ShieldCheck className="h-3.5 w-3.5" />{capture.evidence.observableBoundary}</div>
        {capture.evidence.residualLimitation && <div className="mt-1 leading-relaxed">{capture.evidence.residualLimitation}</div>}
        {capture.evidence.excludedSensitiveFields.length > 0 && <div className="mt-1">Excluded: {capture.evidence.excludedSensitiveFields.join(", ")}</div>}
      </div>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/30 md:flex-row">
        <aside className="max-h-64 w-full shrink-0 overflow-y-auto border-b border-border/20 bg-card/40 p-2 md:max-h-none md:w-[280px] md:border-b-0 md:border-r" aria-label="Payload index">
          <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Index</div>
          <PayloadIndexNode
            node={root}
            expanded={indexExpanded}
            activeId={activeId}
            onToggle={(id) => toggleSet(setIndexExpanded, id)}
            onNavigate={navigate}
            continues={false}
          />
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto p-2 md:p-4">
          <PayloadContentNode
            node={root}
            openIds={contentOpen}
            onOpenChange={(id, open) => toggleSet(setContentOpen, id, open)}
            refs={contentRefs}
            continues={false}
          />
        </div>
      </div>
    </div>
  );
}

function captureLabel(capture: InferencePayloadCaptureSummary): string {
  const timestamp = new Date(capture.capturedAt).toLocaleString();
  return `${timestamp} · ${formatModelName(capture.model)} · ${capture.boundary}`;
}

export default function ContextPage({ embedded }: { embedded?: boolean } = {}) {
  usePageHeader({ title: "Context", skip: !!embedded });
  const [viewTab, setViewTab] = useState("prompt");
  const [selectedCaptureId, setSelectedCaptureId] = useState("");

  const previewQuery = useQuery<{ metadata: SpineMetadata }>({
    queryKey: ["/api/context/preview/rendered", "full", "text"],
    queryFn: async () => {
      const response = await fetch("/api/context/preview/rendered?callType=full&llmMode=text");
      if (!response.ok) throw new Error("Failed to load context metadata");
      return response.json();
    },
  });

  const capturesQuery = useQuery<InferencePayloadCaptureListResponse>({
    queryKey: ["/api/context/inference-calls"],
    queryFn: async () => {
      const response = await fetch("/api/context/inference-calls");
      if (!response.ok) throw new Error("Failed to load inference calls");
      return response.json();
    },
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const captures = capturesQuery.data?.captures ?? [];
    if (captures.length > 0 && !captures.some((capture) => capture.id === selectedCaptureId)) {
      setSelectedCaptureId(captures[0].id);
    }
  }, [capturesQuery.data?.captures, selectedCaptureId]);

  const captureQuery = useQuery<InferencePayloadCapture>({
    queryKey: ["/api/context/inference-calls", selectedCaptureId],
    enabled: Boolean(selectedCaptureId),
    queryFn: async () => {
      const response = await fetch(`/api/context/inference-calls/${encodeURIComponent(selectedCaptureId)}`);
      if (!response.ok) throw new Error("Failed to load inference payload");
      return response.json();
    },
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="context-page">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
        <Tabs value={viewTab} onValueChange={setViewTab} className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {viewTab === "prompt" && (
              <Select value={selectedCaptureId} onValueChange={setSelectedCaptureId}>
                <SelectTrigger className="min-w-0 sm:w-[520px]" data-testid="select-inference-call">
                  <SelectValue placeholder="Select a recent inference call" />
                </SelectTrigger>
                <SelectContent>
                  {(capturesQuery.data?.captures ?? []).map((capture) => (
                    <SelectItem key={capture.id} value={capture.id}>{captureLabel(capture)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {captureQuery.data && viewTab === "prompt" && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />{new Date(captureQuery.data.capturedAt).toLocaleString()}
              </span>
            )}
            <TabsList className="sm:ml-auto">
              <TabsTrigger value="prompt" data-testid="tab-prompt-view">Prompt</TabsTrigger>
              <TabsTrigger value="runtime">Runtime</TabsTrigger>
              <TabsTrigger value="instructions">Instructions</TabsTrigger>
            </TabsList>
          </div>

          {previewQuery.data?.metadata && <SummaryBar metadata={previewQuery.data.metadata} />}

          <TabsContent value="prompt" className="mt-0 flex min-h-0 flex-1 flex-col">
            {capturesQuery.isLoading || captureQuery.isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : capturesQuery.isError || captureQuery.isError ? (
              <div className="px-2 py-1.5 text-sm text-destructive">Failed to load captured inference payload.</div>
            ) : captureQuery.data ? (
              <PromptCaptureTree capture={captureQuery.data} />
            ) : (
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                <FileJson2 className="h-4 w-4" />No captured inference calls yet.
              </div>
            )}
          </TabsContent>

          <TabsContent value="runtime" className="mt-0 flex min-h-0 flex-1 flex-col">
            {previewQuery.isLoading ? <Skeleton className="h-full w-full" /> : previewQuery.data?.metadata ? <RuntimeCard metadata={previewQuery.data.metadata} /> : null}
          </TabsContent>

          <TabsContent value="instructions" className="mt-0 flex min-h-0 flex-1 flex-col">
            {previewQuery.isLoading ? <Skeleton className="h-full w-full" /> : previewQuery.data?.metadata ? <InstructionsCard metadata={previewQuery.data.metadata} /> : null}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
