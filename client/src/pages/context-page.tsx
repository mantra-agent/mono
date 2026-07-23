import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, FileJson2, Layers } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
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

interface CapturedSection {
  id: string;
  title: string;
  raw: string;
}

function parseCapturedSections(value: string): CapturedSection[] {
  const tokenPattern = /<section\s+id="([^"]+)"\s+title="([^"]*)"\s*>|<\/section>/g;
  const stack: Array<{ id: string; title: string; start: number; order: number }> = [];
  const completed: Array<CapturedSection & { order: number }> = [];
  let token: RegExpExecArray | null;
  let order = 0;

  while ((token = tokenPattern.exec(value)) !== null) {
    if (!token[0].startsWith("</")) {
      stack.push({ id: token[1], title: token[2] || token[1], start: token.index, order });
      order += 1;
      continue;
    }
    const opened = stack.pop();
    if (opened) {
      completed.push({
        id: opened.id,
        title: opened.title,
        raw: value.slice(opened.start, tokenPattern.lastIndex),
        order: opened.order,
      });
    }
  }

  return completed.sort((left, right) => left.order - right.order).map(({ order: _order, ...section }) => section);
}

interface PayloadNode {
  id: string;
  label: string;
  value: unknown;
  children: PayloadNode[];
  exactText?: string;
  kind: "field" | "section" | "tool" | "message";
}

function toolLabel(value: unknown, index: number): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.function && typeof record.function === "object"
    ? record.function as Record<string, unknown>
    : null;
  const name = typeof record.name === "string" ? record.name : typeof nested?.name === "string" ? nested.name : null;
  return name ? `[${index}] ${name}` : null;
}

function messageLabel(value: unknown, index: number): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : typeof record.type === "string" ? record.type : null;
  const name = typeof record.name === "string" ? ` · ${record.name}` : "";
  return role ? `[${index}] ${role}${name}` : null;
}

function isToolCollection(path: string[]): boolean {
  return path[path.length - 1] === "tools" || path[path.length - 1] === "applicationToolDefinitions";
}

function isMessageCollection(path: string[]): boolean {
  const key = path[path.length - 1];
  return key === "messages" || key === "input" || key === "history";
}

function normalizeChildKind(parentPath: string[], currentPath: string[], kind: PayloadNode["kind"]): PayloadNode["kind"] {
  if (kind !== "field") return kind;
  if (parentPath[parentPath.length - 1] === "tools" && currentPath[currentPath.length - 1] === "function") return "tool";
  return kind;
}

function buildPayloadNode(label: string, value: unknown, path: string[] = ["request"], id = "request"): PayloadNode {
  if (typeof value === "string") {
    const sections = parseCapturedSections(value);
    return {
      id,
      label,
      value,
      kind: "field",
      exactText: value,
      children: sections.map((section, index) => ({
        id: `${id}.section.${index}`,
        label: section.title,
        value: section.raw,
        children: [],
        exactText: section.raw,
        kind: "section",
      })),
    };
  }

  const entries: Array<[string, unknown, "field" | "tool" | "message"]> = Array.isArray(value)
    ? value.map((item, index) => {
        const semanticLabel = isToolCollection(path)
          ? toolLabel(item, index)
          : isMessageCollection(path)
            ? messageLabel(item, index)
            : null;
        return [semanticLabel ?? `[${index}]`, item, isToolCollection(path) ? "tool" : isMessageCollection(path) ? "message" : "field"];
      })
    : value !== null && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, item, "field"])
      : [];

  return {
    id,
    label,
    value,
    kind: "field",
    children: entries.map(([key, child, kind], index) => {
      const childPath = [...path, Array.isArray(value) ? String(index) : key];
      return {
        ...buildPayloadNode(key, child, childPath, `${id}.${index}`),
        kind: normalizeChildKind(path, childPath, kind),
      };
    }),
  };
}

function exactValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

function nodeMeta(node: PayloadNode): string {
  if (node.kind === "section") return `${node.exactText?.length.toLocaleString() ?? 0} chars`;
  if (node.kind === "tool") return "tool schema";
  if (node.kind === "message") return "message";
  if (Array.isArray(node.value)) return `${node.value.length} items`;
  if (node.value !== null && typeof node.value === "object") return `${node.children.length} fields`;
  if (typeof node.value === "string") return `${node.value.length.toLocaleString()} chars`;
  if (node.value === null) return "null";
  return typeof node.value;
}

function ExactContent({ value, testId }: { value: unknown; testId: string }) {
  return (
    <pre
      className="min-w-0 max-w-full overflow-x-auto whitespace-pre rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground"
      data-testid={testId}
    >
      {exactValue(value)}
    </pre>
  );
}

function PayloadTreeNode({ node, defaultOpen = false }: { node: PayloadNode; defaultOpen?: boolean }) {
  const childRows = node.children.length > 0 ? (
    <div className="mt-2 min-w-0">
      {node.children.map((child, index) => (
        <HierarchyTreeRow key={child.id} continues={index < node.children.length - 1}>
          <PayloadTreeNode node={child} />
        </HierarchyTreeRow>
      ))}
    </div>
  ) : null;
  const ownContent = node.exactText !== undefined || node.children.length === 0
    ? <ExactContent value={node.exactText ?? node.value} testId={`payload-exact-${node.id}`} />
    : null;

  return (
    <ProfileTreeRow
      label={<span className="font-mono text-foreground">{node.label}</span>}
      hasValue={true}
      showEmpty={true}
      defaultOpen={defaultOpen}
      mobileLayout="inline"
      testId={`payload-node-${node.id}`}
      expandedContentClassName="min-w-0 max-w-full overflow-hidden pl-8"
      expandedContent={(
        <div className="min-w-0 max-w-full">
          {ownContent}
          {childRows}
        </div>
      )}
    >
      <span className="truncate text-muted-foreground">{nodeMeta(node)}</span>
    </ProfileTreeRow>
  );
}

function PromptCaptureTree({ capture }: { capture: InferencePayloadCapture }) {
  const root = useMemo(
    () => buildPayloadNode(`inference call ${capture.id}`, capture.request),
    [capture.id, capture.request],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{capture.provider} / {capture.model}</span>
        <span>{capture.boundary}</span>
        <span>{capture.requestChars.toLocaleString()} chars</span>
        <span>attempt {capture.attempt}</span>
      </div>
      {capture.completeness === "legacy_incomplete" && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 px-3 py-2 text-xs text-warning" data-testid="legacy-capture-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Incomplete legacy capture. New calls include the complete immutable dispatch snapshot.
        </div>
      )}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto rounded-lg border border-border/30 p-2 scrollbar-thin" data-testid="prompt-capture-tree">
        <PayloadTreeNode key={capture.id} node={root} defaultOpen={true} />
      </div>
      {capture.evidence.residualLimitation && (
        <div className="px-2 text-xs leading-relaxed text-muted-foreground" data-testid="capture-residual-limitation">
          {capture.evidence.residualLimitation}
        </div>
      )}
    </div>
  );
}

function captureLabel(capture: InferencePayloadCaptureSummary): string {
  const timestamp = new Date(capture.capturedAt).toLocaleString();
  const legacy = capture.completeness === "legacy_incomplete" ? " · legacy" : "";
  return `${timestamp} · ${formatModelName(capture.model)} · ${capture.boundary}${legacy}`;
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
