import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Clock, FileJson2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePageHeader } from "@/hooks/use-page-header";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HIERARCHY_SECTION_HEADER_CLASS, HIERARCHY_SESSION_ROW_CLASS } from "@/components/hierarchy-section-header";
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

interface CapturedSection {
  id: string;
  title: string;
  raw: string;
}

function parseCapturedSections(value: string): CapturedSection[] {
  const tokenPattern = /<section\s+id="([^"]+)"\s+title="([^"]*)"\s*>|<\/section>/g;
  const stack: Array<{ id: string; title: string; start: number; order: number }> = [];
  const completed: Array<CapturedSection & { order: number; depth: number }> = [];
  let token: RegExpExecArray | null;
  let order = 0;

  while ((token = tokenPattern.exec(value)) !== null) {
    if (!token[0].startsWith("</")) {
      stack.push({ id: token[1], title: token[2] || token[1], start: token.index, order });
      order += 1;
      continue;
    }
    const opened = stack.pop();
    if (!opened) continue;
    completed.push({
      id: opened.id,
      title: opened.title,
      raw: value.slice(opened.start, tokenPattern.lastIndex),
      order: opened.order,
      depth: stack.length,
    });
  }

  if (completed.length === 0) return [];
  const topDepth = Math.min(...completed.map((section) => section.depth));
  return completed
    .filter((section) => section.depth === topDepth)
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, depth: _depth, ...section }) => section);
}

interface PayloadNode {
  id: string;
  label: string;
  value: unknown;
  children: PayloadNode[];
  kind: "field" | "tool" | "message";
}

type PromptSectionKind = "markdown" | "html" | "json" | "messages" | "tools" | "text" | "overhead";

interface PromptSection {
  id: string;
  title: string;
  value: unknown;
  kind: PromptSectionKind;
  tokenCount: number;
}

interface PromptAccounting {
  sections: PromptSection[];
  totalTokens: number;
  source: "provider" | "estimated";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function nestedNumber(record: Record<string, unknown>, paths: string[][]): number | null {
  for (const path of paths) {
    let current: unknown = record;
    for (const segment of path) {
      current = isRecord(current) ? current[segment] : undefined;
    }
    const result = positiveInteger(current);
    if (result !== null) return result;
  }
  return null;
}

function providerInputTokens(capture: InferencePayloadCapture): number | null {
  return nestedNumber(capture.metadata, [
    ["inputTokens"],
    ["promptTokens"],
    ["requestTokens"],
    ["usage", "inputTokens"],
    ["usage", "input_tokens"],
    ["usage", "promptTokens"],
    ["usage", "prompt_tokens"],
    ["tokenUsage", "inputTokens"],
    ["tokenUsage", "promptTokens"],
  ]);
}

function labelFromKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

function classifySection(key: string, value: unknown): PromptSectionKind {
  const normalized = key.toLowerCase();
  if (normalized === "tools" || normalized === "applicationtooldefinitions") return "tools";
  if (normalized === "messages" || normalized === "history") return "messages";
  if (normalized === "input" && Array.isArray(value)) return "messages";
  if (typeof value !== "string") return "json";

  const trimmed = value.trim();
  if (/^<!doctype html/i.test(trimmed) || /^<html(?:\s|>)/i.test(trimmed)) return "html";
  if (parseCapturedSections(value).length > 0 || /(^|\n)#{1,6}\s+/.test(value) || /(^|\n)[*-]\s+/.test(value)) return "markdown";
  return "text";
}

function requestSections(request: unknown): Array<Omit<PromptSection, "tokenCount">> {
  if (typeof request === "string") {
    const sections = parseCapturedSections(request);
    if (sections.length > 0) {
      return sections.map((section, index) => ({
        id: section.id || `section-${index}`,
        title: section.title,
        value: section.raw,
        kind: classifySection(section.title, section.raw),
      }));
    }
    return [{ id: "prompt", title: "Prompt", value: request, kind: classifySection("prompt", request) }];
  }

  if (isRecord(request)) {
    const entries = Object.entries(request);
    if (entries.length > 0) {
      return entries.map(([key, value]) => ({
        id: key,
        title: labelFromKey(key),
        value,
        kind: classifySection(key, value),
      }));
    }
  }

  return [{ id: "request", title: "Request", value: request, kind: "json" }];
}

function allocateTokens(values: unknown[], totalTokens: number): number[] {
  if (values.length === 0) return [];
  if (totalTokens <= 0) return values.map(() => 0);

  const weights = values.map((value) => Math.max(1, exactValue(value).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map((weight) => (weight / totalWeight) * totalTokens);
  const allocations = shares.map(Math.floor);
  let remaining = totalTokens - allocations.reduce((sum, allocation) => sum + allocation, 0);
  const byRemainder = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder);

  for (let cursor = 0; remaining > 0; cursor += 1) {
    allocations[byRemainder[cursor % byRemainder.length].index] += 1;
    remaining -= 1;
  }
  return allocations;
}

function buildPromptAccounting(capture: InferencePayloadCapture): PromptAccounting {
  const baseSections = requestSections(capture.request);
  const estimatedRequestTokens = Math.max(1, Math.round(capture.requestChars / 4));
  const reportedInputTokens = providerInputTokens(capture);
  const payloadTokens = reportedInputTokens === null
    ? estimatedRequestTokens
    : Math.min(reportedInputTokens, estimatedRequestTokens);
  const allocations = allocateTokens(baseSections.map((section) => section.value), payloadTokens);
  const sections: PromptSection[] = baseSections.map((section, index) => ({
    ...section,
    tokenCount: allocations[index] ?? 0,
  }));

  if (reportedInputTokens !== null && reportedInputTokens > estimatedRequestTokens) {
    sections.push({
      id: "provider-overhead",
      title: "Provider / SDK Overhead",
      value: null,
      kind: "overhead",
      tokenCount: reportedInputTokens - estimatedRequestTokens,
    });
  }

  return {
    sections,
    totalTokens: sections.reduce((sum, section) => sum + section.tokenCount, 0),
    source: reportedInputTokens === null ? "estimated" : "provider",
  };
}

function toolLabel(value: unknown, index: number): string | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.function) ? value.function : null;
  const name = typeof value.name === "string" ? value.name : typeof nested?.name === "string" ? nested.name : null;
  return name ? name : `Tool ${index + 1}`;
}

function messageLabel(value: unknown, index: number): string | null {
  if (!isRecord(value)) return null;
  const role = typeof value.role === "string" ? value.role : typeof value.type === "string" ? value.type : null;
  const name = typeof value.name === "string" ? ` · ${value.name}` : "";
  return role ? `${role}${name}` : `Message ${index + 1}`;
}

function isToolCollection(path: string[]): boolean {
  return path[path.length - 1] === "tools" || path[path.length - 1] === "applicationToolDefinitions";
}

function isMessageCollection(path: string[]): boolean {
  const key = path[path.length - 1];
  return key === "messages" || key === "input" || key === "history";
}

function buildPayloadNode(label: string, value: unknown, path: string[] = ["request"], id = "request"): PayloadNode {
  const entries: Array<[string, unknown, PayloadNode["kind"]]> = Array.isArray(value)
    ? value.map((item, index) => {
        if (isToolCollection(path)) return [toolLabel(item, index) ?? `Tool ${index + 1}`, item, "tool"];
        if (isMessageCollection(path)) return [messageLabel(item, index) ?? `Message ${index + 1}`, item, "message"];
        return [`[${index}]`, item, "field"];
      })
    : isRecord(value)
      ? Object.entries(value).map(([key, item]) => [key, item, "field"])
      : [];

  return {
    id,
    label,
    value,
    kind: "field",
    children: entries.map(([key, child, kind], index) => ({
      ...buildPayloadNode(key, child, [...path, Array.isArray(value) ? String(index) : key], `${id}.${index}`),
      kind,
    })),
  };
}

function nodeMeta(node: PayloadNode): string {
  if (node.kind === "tool") return "tool schema";
  if (node.kind === "message") return "message";
  if (Array.isArray(node.value)) return `${node.value.length} items`;
  if (isRecord(node.value)) return `${node.children.length} fields`;
  if (typeof node.value === "string") return `${node.value.length.toLocaleString()} chars`;
  if (node.value === null) return "null";
  return typeof node.value;
}

function ExactContent({ value, testId }: { value: unknown; testId: string }) {
  return (
    <pre
      className="min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground"
      data-testid={testId}
    >
      {exactValue(value)}
    </pre>
  );
}

function PayloadTreeNode({ node, defaultOpen = false }: { node: PayloadNode; defaultOpen?: boolean }) {
  const expandedContent = node.children.length > 0 ? (
    <div className="min-w-0 max-w-full">
      {node.children.map((child, index) => (
        <HierarchyTreeRow key={child.id} continues={index < node.children.length - 1}>
          <PayloadTreeNode node={child} />
        </HierarchyTreeRow>
      ))}
    </div>
  ) : (
    <ExactContent value={node.value} testId={`payload-exact-${node.id}`} />
  );

  return (
    <ProfileTreeRow
      label={<span className="font-mono text-foreground">{node.label}</span>}
      hasValue={true}
      showEmpty={true}
      defaultOpen={defaultOpen}
      mobileLayout="inline"
      testId={`payload-node-${node.id}`}
      expandedContentClassName="min-w-0 max-w-full overflow-hidden pl-8"
      expandedContent={expandedContent}
    >
      <span className="truncate text-muted-foreground">{nodeMeta(node)}</span>
    </ProfileTreeRow>
  );
}

function sectionMarkupToMarkdown(value: string): string {
  return value
    .replace(/<section\s+[^>]*title="([^"]*)"[^>]*>/g, (_match, title: string) => `\n\n## ${title}\n\n`)
    .replace(/<section\s+[^>]*>/g, "\n\n")
    .replace(/<\/section>/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function MarkdownContent({ value }: { value: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-muted/50 prose-pre:text-xs prose-code:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml={true}>{sectionMarkupToMarkdown(value)}</ReactMarkdown>
    </div>
  );
}

function htmlToReadableText(value: string): string {
  if (typeof DOMParser === "undefined") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const document = new DOMParser().parseFromString(value, "text/html");
  document.querySelectorAll("script, style, template, noscript").forEach((node) => node.remove());
  return document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function HtmlContent({ value }: { value: string }) {
  return <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{htmlToReadableText(value)}</div>;
}

/**
 * A row styled exactly like a Session-menu session title. Non-expandable rows
 * render as a plain row with an optional right-aligned value; expandable rows
 * add the same chevron disclosure the session menu uses.
 */
function SessionMenuRow({
  label,
  meta,
  expandedContent,
  defaultOpen = false,
  testId,
}: {
  label: ReactNode;
  meta?: ReactNode;
  expandedContent?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const labelNode = <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>;
  const metaNode = meta != null ? (
    <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">{meta}</span>
  ) : null;

  if (!expandedContent) {
    return (
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "text-muted-foreground")} data-testid={testId}>
        {labelNode}
        {metaNode}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <CollapsibleTrigger className={cn(HIERARCHY_SESSION_ROW_CLASS, "text-muted-foreground hover:bg-accent/70")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {labelNode}
        {metaNode}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-3 pl-7 text-xs leading-relaxed text-foreground">{expandedContent}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageSection({ value }: { value: unknown }) {
  const messages = Array.isArray(value) ? value : [value];
  return (
    <div className="space-y-0.5">
      {messages.map((message, index) => {
        const label = messageLabel(message, index) ?? `Message ${index + 1}`;
        const record = isRecord(message) ? message : { content: message };
        const content = record.content ?? record.text ?? record.message ?? message;
        return (
          <SessionMenuRow
            key={`${label}-${index}`}
            label={label}
            testId={`message-row-${index}`}
            expandedContent={typeof content === "string"
              ? <MarkdownContent value={content} />
              : <PayloadTreeNode node={buildPayloadNode("content", content, ["content"], `message-${index}`)} defaultOpen={true} />}
          />
        );
      })}
    </div>
  );
}

function scalarPreview(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return String(value);
}

function JsonSection({ value, sectionId }: { value: unknown; sectionId: string }) {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      return (
        <div className="space-y-0.5">
          {entries.map(([key, fieldValue]) => {
            const isScalar = fieldValue === null || ["string", "number", "boolean"].includes(typeof fieldValue);
            return (
              <SessionMenuRow
                key={key}
                label={labelFromKey(key)}
                meta={isScalar ? scalarPreview(fieldValue) : undefined}
                testId={`option-row-${key}`}
                expandedContent={isScalar
                  ? undefined
                  : <PayloadTreeNode node={buildPayloadNode(key, fieldValue, [sectionId, key], `${sectionId}-${key}`)} defaultOpen={true} />}
              />
            );
          })}
        </div>
      );
    }
  }
  return <ExactContent value={value} testId={`section-content-${sectionId}`} />;
}

interface ToolParamDoc {
  name: string;
  typeLabel: string;
  required: boolean;
  description: string | null;
}

interface ToolDoc {
  name: string;
  description: string | null;
  params: ToolParamDoc[];
}

function schemaTypeLabel(schema: unknown): string {
  if (!isRecord(schema)) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((option) => JSON.stringify(option)).join(" | ");
  const type = schema.type;
  if (typeof type === "string") {
    if (type === "array" && isRecord(schema.items)) return `${schemaTypeLabel(schema.items)}[]`;
    return type;
  }
  if (Array.isArray(type)) return type.filter((entry) => typeof entry === "string").join(" | ") || "any";
  return "any";
}

function describeTool(tool: unknown): ToolDoc | null {
  if (!isRecord(tool)) return null;
  const fn = isRecord(tool.function) ? tool.function : null;
  const name = typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : null;
  if (!name) return null;

  const description = typeof tool.description === "string"
    ? tool.description
    : typeof fn?.description === "string" ? fn.description : null;

  const schema = isRecord(tool.input_schema)
    ? tool.input_schema
    : isRecord(tool.inputSchema)
      ? tool.inputSchema
      : isRecord(fn?.parameters)
        ? (fn.parameters as Record<string, unknown>)
        : null;

  const properties = schema && isRecord(schema.properties) ? schema.properties : {};
  const required = schema && Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];

  const params: ToolParamDoc[] = Object.entries(properties).map(([paramName, paramSchema]) => ({
    name: paramName,
    typeLabel: schemaTypeLabel(paramSchema),
    required: required.includes(paramName),
    description: isRecord(paramSchema) && typeof paramSchema.description === "string" ? paramSchema.description : null,
  }));

  return { name, description, params };
}

function ToolDocumentation({ doc }: { doc: ToolDoc }) {
  return (
    <div className="space-y-3">
      {doc.description && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{doc.description}</p>
      )}
      {doc.params.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters</div>
          {doc.params.map((param) => (
            <div key={param.name} className="border-l-2 border-border/40 pl-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-sm text-foreground">{param.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{param.typeLabel}</span>
                <span className={cn("text-xs", param.required ? "text-warning" : "text-muted-foreground")}>
                  {param.required ? "required" : "optional"}
                </span>
              </div>
              {param.description && (
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{param.description}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No input parameters.</div>
      )}
    </div>
  );
}

function ToolSection({ value }: { value: unknown }) {
  const tools = Array.isArray(value) ? value : [value];
  return (
    <div className="space-y-0.5">
      {tools.map((tool, index) => {
        const doc = describeTool(tool);
        const label = doc?.name ?? toolLabel(tool, index) ?? `Tool ${index + 1}`;
        return (
          <SessionMenuRow
            key={`${label}-${index}`}
            label={<span className="font-mono text-foreground">{label}</span>}
            meta={doc ? `${doc.params.length} param${doc.params.length === 1 ? "" : "s"}` : undefined}
            testId={`tool-row-${index}`}
            expandedContent={doc
              ? <ToolDocumentation doc={doc} />
              : <ExactContent value={tool} testId={`tool-raw-${index}`} />}
          />
        );
      })}
    </div>
  );
}

function SectionBody({ section }: { section: PromptSection }) {
  if (section.kind === "overhead") {
    return <div className="rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">Provider-reported input tokens outside the captured request object.</div>;
  }
  if (section.kind === "markdown" && typeof section.value === "string") return <MarkdownContent value={section.value} />;
  if (section.kind === "html" && typeof section.value === "string") return <HtmlContent value={section.value} />;
  if (section.kind === "messages") return <MessageSection value={section.value} />;
  if (section.kind === "tools") return <ToolSection value={section.value} />;
  if (section.kind === "json") return <JsonSection value={section.value} sectionId={section.id} />;
  return <ExactContent value={section.value} testId={`section-content-${section.id}`} />;
}

function PromptSectionBlock({ section, defaultOpen = false }: { section: PromptSection; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`prompt-section-${section.id}`}>
      <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span>{section.title}</span>
        <span className="ml-auto shrink-0 font-normal normal-case tracking-normal tabular-nums text-muted-foreground">
          {formatTokens(section.tokenCount)} tokens
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-1 pb-2 pt-1">
          <SectionBody section={section} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PromptCaptureSections({ capture }: { capture: InferencePayloadCapture }) {
  const accounting = useMemo(() => buildPromptAccounting(capture), [capture]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{capture.provider} / {capture.model}</span>
        <span className="tabular-nums">{formatTokens(accounting.totalTokens)} input tokens</span>
      </div>
      {capture.completeness === "legacy_incomplete" && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 px-3 py-2 text-xs text-warning" data-testid="legacy-capture-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Incomplete legacy capture. New calls include the complete immutable dispatch snapshot.
        </div>
      )}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto rounded-lg border border-border/30 p-2 scrollbar-thin" data-testid="prompt-capture-sections">
        {accounting.sections.map((section, index) => (
          <PromptSectionBlock key={section.id} section={section} defaultOpen={index === 0} />
        ))}
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
  return `${timestamp} · ${formatModelName(capture.model)}${legacy}`;
}

export default function ContextPage({ embedded }: { embedded?: boolean } = {}) {
  usePageHeader({ title: "Context", skip: !!embedded });
  const [selectedCaptureId, setSelectedCaptureId] = useState("");

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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
          {captureQuery.data && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />{new Date(captureQuery.data.capturedAt).toLocaleString()}
            </span>
          )}
        </div>

        {capturesQuery.isLoading || captureQuery.isLoading ? (
          <Skeleton className="h-full w-full" />
        ) : capturesQuery.isError || captureQuery.isError ? (
          <div className="px-2 py-1.5 text-sm text-destructive">Failed to load captured inference payload.</div>
        ) : captureQuery.data ? (
          <PromptCaptureSections capture={captureQuery.data} />
        ) : (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <FileJson2 className="h-4 w-4" />No captured inference calls yet.
          </div>
        )}
      </div>
    </div>
  );
}
