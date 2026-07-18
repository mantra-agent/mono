// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQuery, useMutation } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { getInstanceName } from "@/lib/instance-config";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  FolderClosed,
  FileText,
  Loader2,
  CheckCircle2,
  Search,
  Trash2,
  ArrowUpRight,
  Plus,
  Database,
  Layers,
  Brain,
  Sparkles,
  X,
  RefreshCw,
  Clock,
  Tag,
  Info,
  User,
  Bot,
  Wrench,
  Hash,
  AlertCircle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Play,
  Pause as PauseIcon,
  Link2,
  MessageSquare,
  Pencil,
  Globe,
  Mic,
  Lightbulb,
  Activity,
  CircleDot,
  Settings,
  Zap,
  MoreHorizontal,
  SlidersHorizontal,
  Share2,
  GitBranch,
  Users,
  Target,
  FolderKanban,
  Unlink,
  ShieldCheck,
  AlertTriangle,
  Circle,
} from "lucide-react";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { createReferenceRef } from "@shared/references";
import { SimpleTextFrame } from "@/components/home/simple-text-frame";
import { MemoryGraph3D, type MemoryGraph3DHandle, type MemoryGraph3DLink, type MemoryGraph3DNode } from "@/components/memory/memory-graph-3d";
import { MemorySourceIcon } from "@/components/memory/memory-source-icon";

const SOURCE_REF_TYPE_MAP: Record<string, "session" | "page"> = {
  session: "session",
  library_page: "page",
  library: "page",
};

function SourceRefLabel({ sourceType, sourceId, className }: { sourceType: string; sourceId: string; className?: string }) {
  const refType = SOURCE_REF_TYPE_MAP[sourceType];
  if (refType) {
    return <ReferenceRenderer refValue={createReferenceRef({ type: refType, id: sourceId })} surface="simple-chip" className={className} />;
  }
  return <span className={className ?? "font-mono text-muted-foreground truncate"}>{sourceId}</span>;
}
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePageHeader } from "@/hooks/use-page-header";
import { useEventStream } from "@/hooks/use-event-stream";
import { useTimezone } from "@/hooks/use-timezone";
import { useMyelination } from "@/hooks/use-myelination";
import { cn } from "@/lib/utils";
import { fromCivilDate } from "@shared/civil-date";

const log = createLogger("MemoryPage");

const MEMORY_SHELL_CLASS = "h-full min-h-0 overflow-hidden bg-background text-foreground";
const MEMORY_PANEL_CLASS = "bg-card border-card-border shadow-sm";
const MEMORY_PANEL_HEADER_CLASS = "border-b border-card-border bg-muted/20 px-4 py-3";
const MEMORY_LIST_ROW_CLASS = "rounded-md border border-transparent transition-colors hover:border-card-border hover:bg-accent/50";
const MEMORY_SELECTED_ROW_CLASS = "border-card-border bg-accent text-accent-foreground";
const MEMORY_EMPTY_CLASS = "flex flex-col items-center justify-center py-12 text-center text-muted-foreground";

const WORKING_SECTION_TRIGGER_CLASS = "flex items-center justify-start gap-1.5 w-full px-2 py-1.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md";
const WORKING_TREE_ROW_CLASS = "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden";
const WORKING_TREE_SELECTED_CLASS = "bg-accent text-foreground";
const WORKING_TREE_IDLE_CLASS = "text-muted-foreground hover:bg-accent/70 hover:text-foreground";


interface WorkspaceItem {
  name: string;
  path: string;
  type: "file" | "directory";
  docType?: string;
  docId?: string;
  title?: string;
}

interface MemoryEntry {
  id: number;
  content: string;
  title?: string;
  summary?: string;
  contentHash?: string;
  layer: "short" | "mid" | "long";
  source: string;
  sourceId?: string;
  tags?: string[];
  graphed?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  processedAt?: string;
  integrationStage?: string | null;
  processingStatus?: "idle" | "processing" | "error" | string | null;
  processingRunId?: string | null;
  processingStartedAt?: string | null;
  processingError?: string | null;
  processingUpdatedAt?: string | null;
  oneLiner?: string | null;
  sourceCount?: number;
  sourceRefs?: MemorySourceRef[];
}

interface MemorySourceRef {
  id: number;
  memoryId: number;
  sourceType: string;
  sourceId: string;
  relationship: string;
  context?: string;
  quote?: string | null;
  strength: number;
  createdAt?: string;
}

interface MemoryLink {
  id: number;
  fromId: number;
  toId: number;
  relationship: string;
  strength: number;
}

interface VnextClaim {
  id: number;
  storage: "memory_vnext_claims";
  title?: string | null;
  content: string;
  claimType: "state" | "cause" | "action" | string;
  confidence: number;
  topics?: string[];
  entityMentions?: unknown[];
  sourceClaimIndex?: number | null;
  sourceMemoryId?: number | null;
  source?: string;
  sourceId?: string | null;
  lifecycleStage: string;
  lifecycleStageUpdatedAt?: string | null;
  metadata?: Record<string, unknown>;
  recallCount?: number;
  lastRecalledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface VnextSourceRef {
  id: number;
  claimId: number;
  sourceType: string;
  sourceId: string;
  relationship: string;
  context?: string;
  quote?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  strength: number;
  createdAt?: string | null;
}

interface VnextClaimsResponse {
  storage: "memory_vnext_claims";
  total: number;
  claims: VnextClaim[];
}

interface VnextSourceQueueRow {
  id: number;
  sourceType: string;
  sourceId: string;
  status: "pending" | "processing" | "completed" | string;
  lastModifiedAt?: string | null;
  lastExtractedAt?: string | null;
  contentHash?: string | null;
  createdAt?: string | null;
}

interface VnextSourcesResponse {
  storage: "memory_vnext_source_queue";
  total: number;
  byStatus: { pending: number; processing: number; completed: number; total: number };
  sources: VnextSourceQueueRow[];
}

interface VnextClaimCounts {
  storage: "memory_vnext_claims";
  total: number;
  byLifecycleStage: Record<string, number>;
  byClaimType: Record<string, number>;
  sourceRefs: number;
  entityLinks: number;
  claimLinks: number;
}

interface VnextLifecycleRunResponse {
  triggered: boolean;
  storage: "memory_vnext_claims";
  runId: string;
  scanned: number;
  sourced: number;
  linked: number;
  canonicalized: number;
  retired: number;
  skipped: number;
  errors: number;
}

type LayersStorageMode = "legacy" | "vnext";

interface MemoryStats {
  short: number;
  mid: number;
  long: number;
  total: number;
}

type GraphStorageMode = "legacy" | "vnext";

interface PalaceData {
  storage?: "memory_legacy" | "memory_vnext";
  entries: MemoryEntry[];
  links: MemoryLink[];
  linkSource?: "links" | "sources" | "claim_links";
  semantics?: string;
}

interface VnextSearchResult extends VnextClaim {
  score: number;
  embeddingSimilarity: number;
  lexicalSimilarity: number;
  textMatch: boolean;
  linkCount: number;
  retrievalPath: string[];
}

interface VnextSearchResponse {
  storage: "memory_vnext_claims";
  total: number;
  results: VnextSearchResult[];
}


function MyelinationProgressBar() {
  const m = useMyelination();
  if (!m.isMyelinating && !m.isPaused && m.phase !== "complete") return null;

  const percentage = m.total > 0 ? Math.round((m.current / m.total) * 100) : 0;
  const phaseLabel = m.phase === "summarize" ? "Summarizing" : m.phase === "embed" ? "Embedding" : m.phase === "link" ? "Linking" : m.phase === "complete" ? "Complete" : m.phase === "starting" ? "Starting" : m.phase;

  return (
    <div className="w-full space-y-1.5" data-testid="myelination-progress">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{phaseLabel}</span>
        {m.total > 0 && <span className="text-muted-foreground tabular-nums">{m.current}/{m.total} ({percentage}%)</span>}
      </div>
      <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${m.phase === "complete" ? "bg-success" : "bg-primary"}`}
          style={{ width: `${m.phase === "complete" ? 100 : Math.max(2, percentage)}%` }}
          data-testid="myelination-progress-bar"
        />
      </div>
      <p className="text-xs text-muted-foreground/70 truncate">{m.detail}</p>
    </div>
  );
}

interface ConsolidationStatus {
  running: boolean;
  layer: string;
  current: number;
  total: number;
  detail: string;
  startedAt: number | null;
  tokenEstimate: number | null;
  startingTokens: number | null;
  currentTokens: number | null;
  thresholds: { triggerCapacity: number; targetCapacity: number };
}

function useConsolidationStatus() {
  const { data, isLoading } = useQuery<ConsolidationStatus>({
    queryKey: ["/api/memory/consolidation/status"],
    refetchInterval: (query) => {
      const d = query.state.data as ConsolidationStatus | undefined;
      return d?.running ? 1000 : 10000;
    },
  });
  return { status: data, isLoading };
}

interface IntegrationStatus {
  running: boolean;
  layer: string;
  current: number;
  total: number;
  detail: string;
  startedAt: number | null;
  tokenEstimate: number | null;
  startingTokens: number | null;
  currentTokens: number | null;
  thresholds: { triggerCapacity: number; targetCapacity: number };
}

function useIntegrationStatus() {
  const { data, isLoading } = useQuery<IntegrationStatus>({
    queryKey: ["/api/memory/integration/status"],
    refetchInterval: (query) => {
      const d = query.state.data as IntegrationStatus | undefined;
      return d?.running ? 1000 : 10000;
    },
  });
  return { status: data, isLoading };
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function ConsolidationProgressBar({ status }: { status: ConsolidationStatus | undefined }) {
  if (!status?.running) return null;

  const starting = status.startingTokens ?? 0;
  const current = status.currentTokens ?? starting;
  const rinse = status.thresholds.targetCapacity;
  const flush = status.thresholds.triggerCapacity;

  const scaleMax = Math.max(starting, current, flush) * 1.1 || 1;
  const fillPct = Math.min((current / scaleMax) * 100, 100);
  const rinsePct = Math.min((rinse / scaleMax) * 100, 100);
  const flushPct = Math.min((flush / scaleMax) * 100, 100);

  return (
    <div className="w-full space-y-1.5 px-3 py-2 bg-info/5 border-b border-info/10" data-testid="consolidation-progress">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-info" />
          Consolidating short-term memory
        </span>
        <span className="text-muted-foreground tabular-nums">
          ~{formatTokenCount(current)} → {formatTokenCount(rinse)} tok
        </span>
      </div>
      <div className="relative h-2 w-full bg-muted rounded-full" data-testid="consolidation-progress-track">
        <div
          className="h-full rounded-full transition-all duration-700 bg-info"
          style={{ width: `${Math.max(0.5, fillPct)}%` }}
          data-testid="consolidation-progress-bar"
        />
        <div
          className="absolute -top-px -bottom-px w-[2px] bg-info rounded-full"
          style={{ left: `${rinsePct}%` }}
          title={`Rinse: ${formatTokenCount(rinse)}`}
        />
        <div
          className="absolute -top-px -bottom-px w-[2px] bg-warning rounded-full"
          style={{ left: `${flushPct}%` }}
          title={`Flush: ${formatTokenCount(flush)}`}
        />
      </div>
      <div className="relative text-xs h-3">
        <span className="absolute left-0 text-muted-foreground/60">0</span>
        <span className="absolute text-info -translate-x-1/2" style={{ left: `${rinsePct}%` }}>{formatTokenCount(rinse)}</span>
        <span className="absolute text-warning -translate-x-1/2" style={{ left: `${flushPct}%` }}>{formatTokenCount(flush)}</span>
      </div>
      {status.detail && (
        <p className="text-xs text-muted-foreground/70 truncate">{status.detail}</p>
      )}
    </div>
  );
}

function IntegrationProgressBar({ status }: { status: IntegrationStatus | undefined }) {
  if (!status?.running) return null;

  const starting = status.startingTokens ?? 0;
  const current = status.currentTokens ?? starting;
  const rinse = status.thresholds.targetCapacity;
  const flush = status.thresholds.triggerCapacity;

  const scaleMax = Math.max(starting, current, flush) * 1.1 || 1;
  const fillPct = Math.min((current / scaleMax) * 100, 100);
  const rinsePct = Math.min((rinse / scaleMax) * 100, 100);
  const flushPct = Math.min((flush / scaleMax) * 100, 100);

  return (
    <div className="w-full space-y-1.5 px-3 py-2 bg-active/5 border-b border-active/10" data-testid="integration-progress">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground flex items-center gap-1.5">
          <Layers className="h-3 w-3 text-active" />
          Integrating mid-term → long-term
        </span>
        <span className="text-muted-foreground tabular-nums">
          ~{formatTokenCount(current)} → {formatTokenCount(rinse)} tok
        </span>
      </div>
      <div className="relative h-2 w-full bg-muted rounded-full" data-testid="integration-progress-track">
        <div
          className="h-full rounded-full transition-all duration-700 bg-active"
          style={{ width: `${Math.max(0.5, fillPct)}%` }}
          data-testid="integration-progress-bar"
        />
        <div
          className="absolute -top-px -bottom-px w-[2px] bg-active rounded-full"
          style={{ left: `${rinsePct}%` }}
          title={`Rinse: ${formatTokenCount(rinse)}`}
        />
        <div
          className="absolute -top-px -bottom-px w-[2px] bg-warning rounded-full"
          style={{ left: `${flushPct}%` }}
          title={`Flush: ${formatTokenCount(flush)}`}
        />
      </div>
      <div className="relative text-xs h-3">
        <span className="absolute left-0 text-muted-foreground/60">0</span>
        <span className="absolute text-active -translate-x-1/2" style={{ left: `${rinsePct}%` }}>{formatTokenCount(rinse)}</span>
        <span className="absolute text-warning -translate-x-1/2" style={{ left: `${flushPct}%` }}>{formatTokenCount(flush)}</span>
      </div>
      {status.detail && (
        <p className="text-xs text-muted-foreground/70 truncate">{status.detail}</p>
      )}
    </div>
  );
}

interface GraphMyelinationStatus {
  running: boolean;
  total: number;
  remaining: number;
  current: number;
  detail: string;
  startedAt: number | null;
  ungraphedCount: number;
}

function useGraphMyelinationStatus() {
  const { data, isLoading } = useQuery<GraphMyelinationStatus>({
    queryKey: ["/api/memory/graph-myelination/status"],
    refetchInterval: (query) => {
      const d = query.state.data as GraphMyelinationStatus | undefined;
      return d?.running ? 1000 : 10000;
    },
  });
  return { status: data, isLoading };
}

function GraphMyelinationProgressBar({ status }: { status: GraphMyelinationStatus | undefined }) {
  if (!status?.running || status.total === 0) return null;

  const processed = status.current;
  const total = status.total;
  const pct = Math.min((processed / total) * 100, 100);

  return (
    <div className="w-full space-y-1.5 px-3 py-2 bg-success/5 border-b border-success/10" data-testid="graph-myelination-progress">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground flex items-center gap-1.5">
          <GitBranch className="h-3 w-3 text-success" />
          Myelinating long → graph
        </span>
        <span className="text-muted-foreground tabular-nums">
          {status.remaining} remaining
        </span>
      </div>
      <div className="relative h-2 w-full bg-muted rounded-full" data-testid="graph-myelination-progress-track">
        <div
          className="h-full rounded-full transition-all duration-700 bg-success"
          style={{ width: `${Math.max(0.5, pct)}%` }}
          data-testid="graph-myelination-progress-bar"
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground/60">
        <span>{processed}/{total} processed</span>
        <span>{status.remaining} → 0</span>
      </div>
      {status.detail && (
        <p className="text-xs text-muted-foreground/70 truncate">{status.detail}</p>
      )}
    </div>
  );
}

interface ExchangeBlock {
  role: "user" | "assistant" | "xyz" | "thinking" | "tools";
  label: string;
  content: string;
}

const KNOWN_ROLES = new Set(["XYZ", "THINKING", "TOOLS"]);

function parseTurnTags(content: string): ExchangeBlock[] | null {
  const hasTurnTags = /<turn\s+role="/.test(content);
  if (!hasTurnTags) return null;

  const blocks: ExchangeBlock[] = [];
  const turnRegex = /<turn\s+role="([^"]+)"(?:\s+name="([^"]*)")?>([\s\S]*?)<\/turn>/g;
  let match;

  while ((match = turnRegex.exec(content)) !== null) {
    const role = match[1];
    const name = match[2] || null;
    const blockContent = match[3].trim();
    if (!blockContent) continue;

    if (role === "user") {
      const label = name ? name.charAt(0) + name.slice(1).toLowerCase() : "User";
      blocks.push({ role: "user", label, content: blockContent });
    } else if (role === "assistant") {
      blocks.push({ role: "assistant", label: getInstanceName(), content: blockContent });
    } else if (role === "thinking") {
      blocks.push({ role: "thinking", label: "Thinking", content: blockContent });
    } else if (role === "tools") {
      blocks.push({ role: "tools", label: "Tools", content: blockContent });
    }
  }

  return blocks.length > 0 ? blocks : null;
}

function parseLegacyDelimiters(content: string): ExchangeBlock[] | null {
  const hasDelimiters = /<<<[A-Z]+>>>/.test(content);
  if (!hasDelimiters) return null;

  const blocks: ExchangeBlock[] = [];
  const regex = /<<<([A-Z]+)>>>/g;
  let lastIndex = 0;
  let lastBlock: { role: ExchangeBlock["role"]; label: string } | null = null;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (lastBlock !== null && match.index > lastIndex) {
      const blockContent = content.slice(lastIndex, match.index).trim();
      if (blockContent) blocks.push({ ...lastBlock, content: blockContent });
    }
    const tag = match[1];
    if (KNOWN_ROLES.has(tag)) {
      lastBlock = { role: tag.toLowerCase() as ExchangeBlock["role"], label: tag.charAt(0) + tag.slice(1).toLowerCase() };
    } else {
      const name = tag.charAt(0) + tag.slice(1).toLowerCase();
      lastBlock = { role: "user", label: name };
    }
    lastIndex = regex.lastIndex;
  }

  if (lastBlock !== null && lastIndex < content.length) {
    const blockContent = content.slice(lastIndex).trim();
    if (blockContent) blocks.push({ ...lastBlock, content: blockContent });
  }

  return blocks.length > 0 ? blocks : null;
}

function parseExchangeContent(content: string): ExchangeBlock[] | null {
  return parseTurnTags(content) || parseLegacyDelimiters(content);
}

const roleStyleConfig: Record<ExchangeBlock["role"], { icon: typeof User; bgClass: string; textClass: string }> = {
  user: { icon: User, bgClass: "bg-info/10 dark:bg-info/10", textClass: "text-info-foreground" },
  assistant: { icon: Bot, bgClass: "bg-success/10 dark:bg-success/10", textClass: "text-success-foreground" },
  xyz: { icon: Bot, bgClass: "bg-success/10 dark:bg-success/10", textClass: "text-success-foreground" },
  thinking: { icon: Brain, bgClass: "bg-warning/10 dark:bg-warning/10", textClass: "text-warning-foreground dark:text-warning" },
  tools: { icon: Wrench, bgClass: "bg-active/10", textClass: "text-active-foreground" },
};

function preserveNewlines(text: string): string {
  return text.replace(/\n/g, "  \n");
}

function ExchangeContentRenderer({ content }: { content: string }) {
  const blocks = parseExchangeContent(content);
  if (!blocks) {
    return (
      <div className="text-sm text-foreground/90 leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-hr:my-2 prose-blockquote:my-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{preserveNewlines(content)}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="exchange-blocks">
      {blocks.map((block, i) => {
        const style = roleStyleConfig[block.role];
        const Icon = style.icon;
        return (
          <div key={i} className={`rounded-md p-3 ${style.bgClass}`} data-testid={`exchange-block-${block.role}-${i}`}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Icon className={`h-3 w-3 ${style.textClass}`} />
              <span className={`text-xs font-medium uppercase tracking-wide ${style.textClass}`}>{block.label}</span>
            </div>
            <div className="text-sm text-foreground/90 leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-hr:my-2 prose-blockquote:my-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{preserveNewlines(block.content)}</ReactMarkdown>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isDeletionScheduled(entry: MemoryEntry): boolean {
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  return !!meta.deletionScheduled;
}

function getDeletionInfo(entry: MemoryEntry): { scheduled: string; reason?: string } | null {
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  if (!meta.deletionScheduled) return null;
  return {
    scheduled: String(meta.deletionScheduled),
    reason: meta.deletionReason ? String(meta.deletionReason) : undefined,
  };
}

const layerColorMap: Record<string, { badge: string; dot: string }> = {
  short: { badge: "bg-active/15 text-active-foreground border-active/30", dot: "bg-active" },
  mid: { badge: "bg-warning/15 text-warning-foreground dark:text-warning border-warning/30", dot: "bg-warning" },
  long: { badge: "bg-cat-ai/15 text-cat-ai-foreground border-cat-ai/30", dot: "bg-cat-ai" },
};

function LayerBadge({ layer }: { layer: string }) {
  const colors = layerColorMap[layer] || layerColorMap.short;
  const label = layer === "short" ? "Short" : layer === "mid" ? "Mid" : "Long";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium border ${colors.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
      {label}
    </span>
  );
}

function SourceIcon({ source, className = "h-2.5 w-2.5" }: { source: string; className?: string }) {
  return <MemorySourceIcon source={source} className={className} />;
}

function getGraphNodeVisual(entry: MemoryEntry): { icon: string; source: string; label: string; Icon: typeof FileText } {
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  const nodeKind = String(meta.nodeKind || "");
  const nodeType = String(meta.nodeType || meta.entityType || nodeKind || entry.source || "manual");
  const claimType = String(meta.claimType || entry.source || "").toLowerCase();
  if (nodeKind === "claim") {
    if (claimType === "cause") return { icon: "↯", source: "cause", label: "Cause", Icon: Zap };
    if (claimType === "action") return { icon: "→", source: "action", label: "Action", Icon: Activity };
    return { icon: "•", source: "state", label: "State", Icon: CircleDot };
  }
  if (nodeType === "person") return { icon: "👤", source: "person", label: "Person", Icon: User };
  if (nodeType === "page") return { icon: "📄", source: "page", label: "Page", Icon: FileText };
  if (nodeType === "session") return { icon: "💬", source: "session", label: "Session", Icon: MessageSquare };
  return { icon: "◦", source: nodeType, label: nodeType, Icon: FileText };
}

function relativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function firstLine(text: string, maxLen = 60): string {
  const lines = text.split("\n");
  let line = lines[0]?.replace(/<<<\w+>>>/g, "").trim() || text.trim();

  const toolMatch = line.match(/^\[Tool:\s*(\w+)\]\s*\((?:ok|ERROR)\)\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s*(.*)/);
  if (toolMatch) {
    const toolName = toolMatch[1];
    let rest = toolMatch[2]?.trim() || "";
    if (!rest && lines.length > 1) {
      rest = lines[1].trim();
    }
    const paramSnippet = rest.length > 30 ? rest.slice(0, 30) + "..." : rest;
    line = paramSnippet ? `${toolName}("${paramSnippet}")` : toolName;
    return line.length > maxLen ? line.slice(0, maxLen) + "..." : line;
  }

  const exchangeMatch = line.match(/^\[Exchange\]\s*"?(.+?)"?\s*\|.*$/);
  if (exchangeMatch) {
    line = exchangeMatch[1].trim();
    return line.length > maxLen ? line.slice(0, maxLen) + "..." : line;
  }
  line = line.replace(/^\[Exchange\]\s*/, "").trim();
  line = line.replace(/^"(.*)"$/, "$1");

  return line.length > maxLen ? line.slice(0, maxLen) + "..." : line;
}

function getDisplayTitle(entry: { title?: string | null; oneLiner?: string | null; source: string; summary?: string | null; content: string }, maxLen = 60): string {
  const isBareToolName = entry.source === "tool" && entry.title && /^\w+$/.test(entry.title);
  if (entry.title && !isBareToolName) return entry.title;
  if (entry.oneLiner) return firstLine(entry.oneLiner, maxLen);
  if (entry.summary) return firstLine(entry.summary, maxLen);
  return firstLine(entry.content, maxLen);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const HIDDEN_TAGS = new Set(["exchange"]);
function displayTags(tags: string[] | null | undefined): string[] {
  if (!tags) return [];
  return tags.filter(t => !HIDDEN_TAGS.has(t));
}

const memoryTabs = [
  { value: "memories", label: "Memories", icon: <Database className="h-3.5 w-3.5" />, testId: "tab-memory-memories" },
  { value: "sources", label: "Sources", icon: <FileText className="h-3.5 w-3.5" />, testId: "tab-memory-sources" },
  { value: "extraction", label: "Extraction", icon: <Search className="h-3.5 w-3.5" />, testId: "tab-memory-extraction" },
  { value: "graph", label: "Graph", icon: <Share2 className="h-3.5 w-3.5" />, testId: "tab-memory-graph" },
  { value: "maintenance", label: "Maintenance", icon: <Settings className="h-3.5 w-3.5" />, testId: "tab-memory-maintenance" },
];



function getMemoryConfidence(entry: MemoryEntry): number | null {
  const meta = entry.metadata as Record<string, unknown> | undefined;
  const raw = meta?.confidence ?? meta?.score ?? null;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function stageLabel(stage?: string | null): string {
  if (!stage) return "stage ?";
  return stage.replace("stage_", "S");
}

function MemorySignals({ entry, timezone, prefix }: { entry: MemoryEntry; timezone: string; prefix: string }) {
  const confidence = getMemoryConfidence(entry);
  const processed = entry.processedAt || entry.updatedAt;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap" data-testid={`${prefix}-signals`}>
      <LayerBadge layer={entry.layer} />
      <Badge variant="outline" className="text-xs px-1.5 py-0" data-testid={`${prefix}-stage`}>{stageLabel(entry.integrationStage)}</Badge>
      {confidence !== null && <span className="font-mono" data-testid={`${prefix}-confidence`}>{Math.round(confidence * 100)}% conf</span>}
      <span className="flex items-center gap-1" data-testid={`${prefix}-source-count`}><FileText className="h-2.5 w-2.5" />{entry.sourceCount ?? entry.sourceRefs?.length ?? 0} sources</span>
      {processed && <span data-testid={`${prefix}-processed`}>processed {new Date(processed).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</span>}
    </div>
  );
}


type MemoryPipelineStatusTone = "neutral" | "processing" | "amber" | "error";

function getPipelineStatusTone(entry: MemoryEntry): MemoryPipelineStatusTone {
  if (entry.processingStatus === "error") return "error";
  if (entry.processingStatus === "processing") return "processing";
  if ((entry.integrationStage || "stage_0") === "stage_1") return "amber";
  return "neutral";
}

function pipelineRowToneClass(tone: MemoryPipelineStatusTone) {
  switch (tone) {
    case "processing":
      return "text-foreground bg-info/10 hover:bg-info/15 border border-info/20";
    case "amber":
      return "text-foreground bg-warning/5 hover:bg-warning/10 border border-warning/15";
    case "error":
      return "text-foreground bg-error/10 hover:bg-error/15 border border-error/25";
    default:
      return WORKING_TREE_IDLE_CLASS;
  }
}

function pipelineSignalIcon(tone: MemoryPipelineStatusTone, testId: string) {
  if (tone === "processing") return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-info" data-testid={testId} />;
  if (tone === "amber") return <Clock className="h-3 w-3 shrink-0 text-warning" data-testid={testId} />;
  if (tone === "error") return <AlertCircle className="h-3 w-3 shrink-0 text-error" data-testid={testId} />;
  return null;
}

function getStageStatusTone(entries: MemoryEntry[]): MemoryPipelineStatusTone {
  if (entries.some(entry => entry.processingStatus === "error")) return "error";
  if (entries.some(entry => entry.processingStatus === "processing")) return "processing";
  if (entries.some(entry => getPipelineStatusTone(entry) === "amber")) return "amber";
  return "neutral";
}

function stageHeaderToneClass(tone: MemoryPipelineStatusTone) {
  switch (tone) {
    case "processing":
      return "text-info bg-info/5 hover:bg-info/10";
    case "amber":
      return "text-warning bg-warning/5 hover:bg-warning/10";
    case "error":
      return "text-error bg-error/5 hover:bg-error/10";
    default:
      return "";
  }
}

function formatPipelineTime(value: string | null | undefined, timezone: string) {
  if (!value) return null;
  return new Date(value).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}


const MEMORY_PIPELINE_STAGES = [
  { value: "stage_0", label: "Stage 0", description: "Captured" },
  { value: "stage_1", label: "Stage 1", description: "Titled" },
  { value: "stage_2", label: "Stage 2", description: "Linked" },
  { value: "stage_3", label: "Stage 3", description: "Integrated" },
  { value: "stage_4", label: "Stage 4", description: "Maintained" },
];

const MEMORY_VNEXT_SOURCE_STAGE = { value: "stage_0", label: "Sources" };

const MEMORY_VNEXT_CLAIM_STAGES = [
  { value: "extracted", label: "Claims" },
  { value: "sourced", label: "Refs" },
  { value: "linked", label: "Linked" },
  { value: "canonical", label: "Promoted" },
  { value: "retired", label: "Retired" },
];

const MEMORY_VNEXT_PIPELINE_STAGES = [MEMORY_VNEXT_SOURCE_STAGE, ...MEMORY_VNEXT_CLAIM_STAGES];

function lifecycleLabel(stage?: string | null): string {
  if (!stage) return "unknown";
  return stage.charAt(0).toUpperCase() + stage.slice(1).replace(/_/g, " ");
}

function claimTypeLabel(type?: string | null): string {
  if (!type) return "claim";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function MemoryPipelineRow({ entry, expanded, onToggle, timezone }: { entry: MemoryEntry; expanded: boolean; onToggle: () => void; timezone: string }) {
  const title = getDisplayTitle(entry, 90);
  const topics = displayTags(entry.tags);
  const confidence = getMemoryConfidence(entry);
  const sourceCount = entry.sourceCount ?? entry.sourceRefs?.length ?? 0;
  const processed = entry.processedAt || entry.updatedAt || entry.createdAt;
  const detailTitle = entry.title || entry.oneLiner || null;
  const tone = getPipelineStatusTone(entry);
  const processingTime = formatPipelineTime(entry.processingStartedAt || entry.processingUpdatedAt, timezone);
  const updatedTime = formatPipelineTime(entry.processingUpdatedAt, timezone);

  return (
    <div data-testid={`memory-pipeline-row-${entry.id}`}>
      <button type="button" className={cn(WORKING_TREE_ROW_CLASS, pipelineRowToneClass(tone))} onClick={onToggle} aria-expanded={expanded} data-testid={`memory-pipeline-toggle-${entry.id}`}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform text-muted-foreground/70", expanded && "rotate-90")} />
        {pipelineSignalIcon(tone, `memory-pipeline-status-icon-${entry.id}`)}
        <SourceIcon source={entry.source} className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
        <span className="min-w-0 flex-1 truncate text-left" data-testid={`memory-pipeline-title-${entry.id}`}>{title}</span>
        {entry.processingStatus === "error" && <span className="shrink-0 text-xs text-error">error</span>}
        {entry.processingStatus === "processing" && <span className="shrink-0 text-xs text-info">processing</span>}
        {sourceCount > 0 && <span className="shrink-0 text-xs text-muted-foreground/60">{sourceCount} src</span>}
        <span className="shrink-0 text-xs text-muted-foreground/60" data-testid={`memory-pipeline-time-${entry.id}`}>{relativeTime(processed)}</span>
      </button>
      {expanded && (
        <div className="ml-6 border-l border-card-border pl-3 pr-2 py-2 space-y-3" data-testid={`memory-pipeline-details-${entry.id}`}>
          {detailTitle && <div><p className="text-xs font-medium text-muted-foreground mb-1">Title</p><p className="text-sm text-foreground/85 whitespace-pre-wrap">{detailTitle}</p></div>}
          {entry.summary && entry.summary !== entry.content && <div><p className="text-xs font-medium text-muted-foreground mb-1">Summary</p><p className="text-sm text-foreground/80 whitespace-pre-wrap">{entry.summary}</p></div>}
          {topics.length > 0 && <div><p className="text-xs font-medium text-muted-foreground mb-1">Topics</p><div className="flex flex-wrap gap-1.5">{topics.map(topic => <Badge key={topic} variant="outline" className="px-1.5 py-0 text-xs">{topic}</Badge>)}</div></div>}
          {(entry.processingStatus && entry.processingStatus !== "idle") && (
            <div className="rounded-md border border-card-border bg-muted/15 p-2" data-testid={`memory-pipeline-processing-${entry.id}`}>
              <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                {pipelineSignalIcon(tone, `memory-pipeline-detail-status-icon-${entry.id}`)}
                Processing
              </p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex gap-2"><span className="w-16 shrink-0">Status</span><span className="text-foreground/80">{entry.processingStatus}</span></div>
                {processingTime && <div className="flex gap-2"><span className="w-16 shrink-0">Started</span><span className="text-foreground/80">{processingTime}</span></div>}
                {updatedTime && <div className="flex gap-2"><span className="w-16 shrink-0">Updated</span><span className="text-foreground/80">{updatedTime}</span></div>}
                {entry.processingError && <div className="flex gap-2"><span className="w-16 shrink-0">Error</span><span className="text-error">{entry.processingError}</span></div>}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid={`memory-pipeline-meta-${entry.id}`}>
            <span>ID {entry.id}</span><span>{entry.source}</span><span>{stageLabel(entry.integrationStage)}</span><span>legacy {entry.layer}</span>
            {confidence !== null && <span>{Math.round(confidence * 100)}% confidence</span>}
            {processed && <span>{new Date(processed).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</span>}
          </div>
          <div><p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1"><FileText className="h-3 w-3" />Content</p><ExchangeContentRenderer content={entry.content} /></div>
          <SourceRefsSection entryId={entry.id} />
        </div>
      )}
    </div>
  );
}


function VnextClaimTypeIcon({ claimType }: { claimType: string }) {
  if (claimType === "cause") return <Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Cause" />;
  if (claimType === "action") return <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Action" />;
  return <CircleDot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="State" />;
}

function VnextClaimRow({ claim, expanded, onToggle, timezone }: { claim: VnextClaim; expanded: boolean; onToggle: () => void; timezone: string }) {
  const updated = claim.lifecycleStageUpdatedAt || claim.updatedAt || claim.createdAt;
  const topics = claim.topics ?? [];
  const metadataEntries = claim.metadata ? Object.entries(claim.metadata).filter(([, value]) => value !== null && value !== undefined) : [];
  const timestamp = formatPipelineTime(updated, timezone);

  return (
    <div data-testid={`memory-vnext-claim-row-${claim.id}`}>
      <button type="button" className={cn(WORKING_TREE_ROW_CLASS, WORKING_TREE_IDLE_CLASS)} onClick={onToggle} aria-expanded={expanded} data-testid={`memory-vnext-claim-toggle-${claim.id}`}>
        <VnextClaimTypeIcon claimType={claim.claimType} />
        <span className="min-w-0 flex-1 truncate text-left text-foreground" data-testid={`memory-vnext-claim-title-${claim.id}`}>{claim.title || "Untitled claim"}</span>
        {timestamp && <span className="shrink-0 text-xs text-muted-foreground/60" data-testid={`memory-vnext-claim-time-${claim.id}`}>{timestamp}</span>}
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        </span>
      </button>
      {expanded && (
        <div className="space-y-3 pb-3 pl-8 pr-2 pt-1" data-testid={`memory-vnext-claim-details-${claim.id}`}>
          <SimpleTextFrame content={claim.content} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid={`memory-vnext-claim-meta-${claim.id}`}>
            <span>{lifecycleLabel(claim.lifecycleStage)}</span>
            <span>{claimTypeLabel(claim.claimType)}</span>
            <span>{Math.round(Number(claim.confidence ?? 0) * 100)}% confidence</span>
          </div>
          {topics.length > 0 && <div className="flex flex-wrap gap-1.5">{topics.map(topic => <Badge key={topic} variant="outline" className="px-1.5 py-0 text-xs">{topic}</Badge>)}</div>}
          <VnextSourceRefsSection claimId={claim.id} />
          {metadataEntries.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Budget metadata</p>
              <pre className="rounded-md border border-card-border bg-muted/10 p-2 text-xs font-mono text-foreground/70 whitespace-pre-wrap">{JSON.stringify(claim.metadata, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VnextSourceRefsSection({ claimId }: { claimId: number }) {
  const { data, isLoading } = useQuery<{ sources: VnextSourceRef[]; total: number }>({
    queryKey: ["/api/memory/vnext/claims", claimId, "sources"],
    queryFn: async () => {
      const res = await fetch(`/api/memory/vnext/claims/${claimId}/sources`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load vNext claim sources");
      return res.json();
    },
    enabled: !!claimId,
  });
  if (isLoading) return <Skeleton className="h-16 w-full rounded-md" />;
  const refs = data?.sources ?? [];
  if (refs.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1"><FileText className="h-3 w-3" />Source refs ({refs.length})</p>
      <div className="space-y-1">
        {refs.map((ref) => (
          <div key={ref.id} className="rounded-md border border-card-border bg-muted/10 p-2" data-testid={`memory-vnext-source-ref-${ref.id}`}>
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="px-1.5 py-0">{ref.sourceType}</Badge>
              <SourceRefLabel sourceType={ref.sourceType} sourceId={ref.sourceId} className="truncate" />
              <span className="ml-auto text-muted-foreground">{ref.relationship} · {Math.round(Number(ref.strength ?? 0) * 100)}%</span>
            </div>
            {ref.context && <p className="mt-1 text-xs text-foreground/75 whitespace-pre-wrap">{ref.context}</p>}
            {ref.quote && <p className="mt-1 border-l border-primary/40 pl-2 text-xs italic text-muted-foreground">{ref.quote}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceRefsSection({ entryId }: { entryId: number }) {
  const { data: refs, isLoading } = useQuery<MemorySourceRef[]>({
    queryKey: ["/api/memory/entries", entryId, "sources"],
    queryFn: async () => {
      const res = await fetch(`/api/memory/entries/${entryId}/sources`);
      if (!res.ok) throw new Error("Failed to load memory sources");
      return res.json();
    },
    enabled: !!entryId,
  });
  if (isLoading) return <Skeleton className="h-16 w-full rounded-md" />;
  if (!refs || refs.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1"><FileText className="h-3 w-3" />Sources ({refs.length})</p>
      <div className="space-y-1">
        {refs.map((ref) => (
          <div key={ref.id} className="rounded-md border border-card-border bg-muted/10 p-2" data-testid={`memory-source-ref-${ref.id}`}>
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="px-1.5 py-0">{ref.sourceType}</Badge>
              <SourceRefLabel sourceType={ref.sourceType} sourceId={ref.sourceId} className="truncate" />
              <span className="ml-auto text-muted-foreground">{ref.relationship} · {Math.round(Number(ref.strength ?? 0) * 100)}%</span>
            </div>
            {ref.context && <p className="mt-1 text-xs text-foreground/75 whitespace-pre-wrap">{ref.context}</p>}
            {ref.quote && <p className="mt-1 border-l border-primary/40 pl-2 text-xs italic text-muted-foreground">{ref.quote}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

interface RetentionPurgeDryRunResponse {
  queryHash: string;
  candidates: number;
  skipped: number;
  byLayer: Record<string, number>;
  bySource: Record<string, number>;
  affectedLinks: number;
  affectedEntityLinks: number;
  survivingPeersToRecompute: number;
  estimatedBatches: number;
  confirmationPhrase: string;
  warnings: string[];
  skippedReasons: Array<{ reason: string; count: number }>;
}

interface RetentionPurgeArchiveResponse {
  archiveHash: string;
  archiveObjectPath: string;
  candidateCount: number;
  confirmationPhrase: string;
}

interface RetentionPurgeExecuteResponse {
  deletedCount: number;
  requestedCount: number;
  batches: number;
  linksRemoved: number;
  peerCleanupScheduled: number;
  archiveHash: string;
  archiveObjectPath: string;
  cleanupErrors?: string[];
}

function RetentionPurgeDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [layers, setLayers] = useState<string[]>([]);
  const [protectionMode, setProtectionMode] = useState<"standard" | "aggressive" | "exact">("standard");
  const [dryRun, setDryRun] = useState<RetentionPurgeDryRunResponse | null>(null);
  const [archive, setArchive] = useState<RetentionPurgeArchiveResponse | null>(null);
  const [result, setResult] = useState<RetentionPurgeExecuteResponse | null>(null);
  const [confirmation, setConfirmation] = useState("");

  const payload = useMemo(() => ({
    startDate: startDate ? fromCivilDate(startDate).toISOString() : undefined,
    endDate: endDate ? fromCivilDate(endDate).toISOString() : undefined,
    layers: layers.length ? layers : undefined,
    protectionMode,
  }), [startDate, endDate, layers, protectionMode]);

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      if (!payload.endDate) throw new Error("End date is required");
      const res = await apiRequest("POST", "/api/memory/retention-purge/dry-run", payload);
      return await res.json() as RetentionPurgeDryRunResponse;
    },
    onSuccess: (data) => {
      setDryRun(data);
      setArchive(null);
      setResult(null);
      setConfirmation("");
    },
    onError: (error: Error) => toast({ title: "Dry run failed", description: error.message, variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/memory/retention-purge/archive", payload);
      return await res.json() as RetentionPurgeArchiveResponse;
    },
    onSuccess: (data) => {
      setArchive(data);
      setConfirmation("");
      toast({ title: "Archive created", description: data.archiveObjectPath });
    },
    onError: (error: Error) => toast({ title: "Archive failed", description: error.message, variant: "destructive" }),
  });

  const executeMutation = useMutation({
    mutationFn: async () => {
      if (!archive) throw new Error("Archive is required");
      const res = await apiRequest("POST", "/api/memory/retention-purge/execute", { ...payload, archiveHash: archive.archiveHash, confirmationPhrase: confirmation });
      return await res.json() as RetentionPurgeExecuteResponse;
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/memory/stats"] });
      toast({ title: "Retention purge complete", description: `${data.deletedCount} memories deleted` });
    },
    onError: (error: Error) => toast({ title: "Execute failed", description: error.message, variant: "destructive" }),
  });

  const toggleLayer = (layer: string) => {
    setLayers((current) => current.includes(layer) ? current.filter((item) => item !== layer) : [...current, layer]);
  };
  const busy = dryRunMutation.isPending || archiveMutation.isPending || executeMutation.isPending;
  const expectedPhrase = archive?.confirmationPhrase || dryRun?.confirmationPhrase || "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="button-retention-purge">
        <Trash2 className="h-4 w-4 mr-2" />
        Retention Purge
      </Button>
      <DialogContent className="max-w-3xl" data-testid="retention-purge-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            Retention Purge
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Protection</Label>
              <Select value={protectionMode} onValueChange={(value) => setProtectionMode(value as typeof protectionMode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="aggressive">Aggressive</SelectItem>
                  <SelectItem value="exact">Exact</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Layers</Label>
            <div className="flex flex-wrap gap-2">
              {["short", "mid", "long", "workspace"].map((layer) => (
                <Button key={layer} type="button" size="sm" variant={layers.includes(layer) ? "default" : "outline"} onClick={() => toggleLayer(layer)}>
                  {layer}
                </Button>
              ))}
            </div>
          </div>

          {dryRun && (
            <div className="rounded-lg border border-card-border bg-muted/20 p-4 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div><p className="text-muted-foreground">Candidates</p><p className="text-lg font-semibold">{dryRun.candidates}</p></div>
                <div><p className="text-muted-foreground">Skipped</p><p className="text-lg font-semibold">{dryRun.skipped}</p></div>
                <div><p className="text-muted-foreground">Links</p><p className="text-lg font-semibold">{dryRun.affectedLinks}</p></div>
                <div><p className="text-muted-foreground">Peer recompute</p><p className="text-lg font-semibold">{dryRun.survivingPeersToRecompute}</p></div>
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>By layer: {Object.entries(dryRun.byLayer).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}</p>
                <p>Entity links affected: {dryRun.affectedEntityLinks}</p>
                <p>Batches: {dryRun.estimatedBatches}</p>
              </div>
            </div>
          )}

          {archive && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm space-y-2">
              <p className="font-medium">Archive created before deletion.</p>
              <p className="font-mono text-xs break-all text-muted-foreground">{archive.archiveObjectPath}</p>
              <p>Type <span className="font-mono font-semibold">{archive.confirmationPhrase}</span> to execute.</p>
              <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder={archive.confirmationPhrase} />
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-success/30 bg-success/10 p-4 text-sm">
              Deleted {result.deletedCount} of {result.requestedCount} requested memories. Removed {result.linksRemoved} links and recomputed {result.peerCleanupScheduled} graph neighborhoods.
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => dryRunMutation.mutate()} disabled={busy || !endDate}>
            {dryRunMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Preview purge
          </Button>
          <Button variant="outline" onClick={() => archiveMutation.mutate()} disabled={busy || !dryRun || dryRun.candidates === 0}>
            {archiveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create archive
          </Button>
          <Button variant="destructive" onClick={() => executeMutation.mutate()} disabled={busy || !archive || confirmation !== expectedPhrase}>
            {executeMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Execute purge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


type LogGranularity = "day" | "week" | "month" | "year";

interface LogEvent {
  id: number;
  entryId: number;
  eventType: string;
  details: Record<string, unknown>;
  occurredAt: string;
  entryTitle: string | null;
  entrySummary: string | null;
  entrySource: string | null;
  entryLayer: string | null;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  created: "bg-info/15 text-info-foreground dark:text-info",
  promoted: "bg-active/15 text-active-foreground",
  graphed: "bg-success/15 text-success-foreground",
  recalled: "bg-warning/15 text-warning-foreground",
  merged: "bg-cat-event/15 text-cat-event-foreground",
  updated: "bg-neutral/15 text-neutral-foreground",
  deleted: "bg-error/15 text-error-foreground",
  belief_created: "bg-cat-system/15 text-cat-system-foreground",
  summary_updated: "bg-active/15 text-active-foreground",
};

function getDateRange(date: Date, granularity: LogGranularity): { start: Date; end: Date } {
  const start = new Date(date);
  const end = new Date(date);

  switch (granularity) {
    case "day":
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "week": {
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek);
      start.setHours(0, 0, 0, 0);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case "month":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "year":
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(11, 31);
      end.setHours(23, 59, 59, 999);
      break;
  }
  return { start, end };
}

function navigateDate(date: Date, granularity: LogGranularity, direction: -1 | 1): Date {
  const next = new Date(date);
  switch (granularity) {
    case "day":
      next.setDate(next.getDate() + direction);
      break;
    case "week":
      next.setDate(next.getDate() + direction * 7);
      break;
    case "month":
      next.setMonth(next.getMonth() + direction);
      break;
    case "year":
      next.setFullYear(next.getFullYear() + direction);
      break;
  }
  return next;
}

function formatPeriodLabel(date: Date, granularity: LogGranularity, timezone: string): string {
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString("en-US", { timeZone: timezone, ...opts });
  switch (granularity) {
    case "day":
      return fmt(date, { month: "short", day: "numeric", year: "numeric" });
    case "week": {
      const weekStart = new Date(date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      return `${fmt(weekStart, { month: "short", day: "numeric" })} – ${fmt(weekEnd, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    case "month":
      return fmt(date, { month: "long", year: "numeric" });
    case "year":
      return fmt(date, { year: "numeric" });
  }
}

function formatDayHeader(dateStr: string, timezone: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function eventTimeInTz(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function eventDateKeyInTz(iso: string, timezone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function EventHistorySection({ entryId, timezone }: { entryId: number; timezone: string }) {
  const { data: entryEvents } = useQuery<Array<{ id: number; eventType: string; details: unknown; occurredAt: string }>>({
    queryKey: [`/api/memory/entries/${entryId}/events`],
    enabled: !!entryId,
  });

  if (!entryEvents || entryEvents.length === 0) return null;

  return (
    <div data-testid={`event-history-${entryId}`}>
      <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
        <Clock className="h-3 w-3" />
        Event History ({entryEvents.length})
      </p>
      <div className="space-y-1">
        {entryEvents.map((ev) => {
          const time = new Date(ev.occurredAt).toLocaleString("en-US", {
            timeZone: timezone,
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          const colorClass = EVENT_TYPE_COLORS[ev.eventType] || "bg-neutral/15 text-neutral-foreground";
          return (
            <div key={ev.id} className="flex items-center gap-2 text-xs" data-testid={`entry-event-${ev.id}`}>
              <span className="text-xs text-muted-foreground shrink-0">{time}</span>
              <Badge variant="secondary" className={`text-xs px-1.5 py-0 ${colorClass}`}>
                {ev.eventType.replace("_", " ")}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LogTab({ initialEntryId }: { initialEntryId?: number | null }) {
  const { timezone } = useTimezone();
  const [granularity, setGranularity] = useState<LogGranularity>("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(initialEntryId ?? null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  // Publish the selected memory entry so the focus widget's pageContext carries it.
  useFocusContext(
    selectedEntryId !== null
      ? { entity: { type: "memory", id: String(selectedEntryId) } }
      : null
  );

  const { start, end } = useMemo(() => getDateRange(currentDate, granularity), [currentDate, granularity]);

  const startISO = start.toISOString();
  const endISO = end.toISOString();

  const { data: events, isLoading } = useQuery<LogEvent[]>({
    queryKey: [`/api/memory/log?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`],
  });

  const { data: summary } = useQuery<Record<string, number>>({
    queryKey: [`/api/memory/log/summary?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`],
  });

  const { data: selectedEntryData } = useQuery<MemoryEntry>({
    queryKey: [`/api/memory/entries/${selectedEntryId}`],
    enabled: !!selectedEntryId,
  });

  const eventsByDay = useMemo(() => {
    if (!events) return new Map<string, LogEvent[]>();
    const grouped = new Map<string, LogEvent[]>();
    for (const event of events) {
      const day = eventDateKeyInTz(event.occurredAt, timezone);
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day)!.push(event);
    }
    return grouped;
  }, [events, timezone]);

  useEffect(() => {
    if (eventsByDay.size > 0 && expandedDays.size === 0) {
      const days = Array.from(eventsByDay.keys()).sort().reverse();
      setExpandedDays(new Set(days.slice(0, 3)));
    }
  }, [eventsByDay]);

  const toggleDay = (day: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const totalEvents = summary ? Object.values(summary).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className={cn("flex flex-1", MEMORY_SHELL_CLASS)} data-testid="log-tab">
      <div className={cn("w-80 shrink-0 border-r flex flex-col overflow-hidden", MEMORY_PANEL_CLASS)}>
        <div className={cn("flex items-center justify-between", MEMORY_PANEL_HEADER_CLASS)}>
          <div className="flex items-center gap-2" data-testid="log-granularity-controls">
            {(["day", "week", "month", "year"] as LogGranularity[]).map(g => (
              <Button
                key={g}
                variant={granularity === g ? "default" : "ghost"}
                size="sm"
                className="text-xs capitalize"
                onClick={() => setGranularity(g)}
                data-testid={`log-granularity-${g}`}
              >
                {g}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1" data-testid="log-nav-controls">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCurrentDate(navigateDate(currentDate, granularity, -1))}
              data-testid="log-nav-prev"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[160px] text-center" data-testid="log-period-label">
              {formatPeriodLabel(currentDate, granularity, timezone)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCurrentDate(navigateDate(currentDate, granularity, 1))}
              data-testid="log-nav-next"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs ml-2"
              onClick={() => setCurrentDate(new Date())}
              data-testid="log-nav-today"
            >
              Today
            </Button>
          </div>
        </div>

        {summary && totalEvents > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 border-b border-card-border bg-muted/10 text-xs text-muted-foreground" data-testid="log-summary-bar">
            <span className="font-medium" data-testid="log-total-events">{totalEvents} events</span>
            {Object.entries(summary).map(([type, count]) => (
              <span key={type} className="flex items-center gap-1" data-testid={`log-summary-type-${type}`}>
                <Badge variant="secondary" className={`text-xs px-1.5 py-0 ${EVENT_TYPE_COLORS[type] || ""}`}>
                  {type.replace("_", " ")}
                </Badge>
                {count}
              </span>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : eventsByDay.size === 0 ? (
            <div className={MEMORY_EMPTY_CLASS} data-testid="log-empty-state">
              <Clock className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm font-medium">No memory events in this period</p>
              <p className="text-xs mt-1">Navigate to a different time range to explore memory history</p>
            </div>
          ) : (
            <div className="px-4 py-2">
              {Array.from(eventsByDay.entries())
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([day, dayEvents]) => {
                  const isExpanded = expandedDays.has(day);
                  return (
                    <div key={day} className="mb-2" data-testid={`log-day-${day}`}>
                      <button
                        className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-accent/50 transition-colors"
                        onClick={() => toggleDay(day)}
                        data-testid={`log-day-toggle-${day}`}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        )}
                        <span className="text-sm font-medium">{formatDayHeader(day, timezone)}</span>
                        <Badge variant="secondary" className="text-xs font-mono px-1 py-0 ml-auto">
                          {dayEvents.length}
                        </Badge>
                      </button>
                      {isExpanded && (
                        <div className="ml-6 border-l border-card-border pl-3 mt-1 space-y-1">
                          {dayEvents.map(event => {
                            const time = eventTimeInTz(event.occurredAt, timezone);
                            const colorClass = EVENT_TYPE_COLORS[event.eventType] || "bg-neutral/15 text-neutral-foreground";
                            return (
                              <button
                                key={event.id}
                                className={cn("flex items-start gap-2 w-full text-left py-1.5 px-2", MEMORY_LIST_ROW_CLASS, selectedEntryId === event.entryId && MEMORY_SELECTED_ROW_CLASS)}
                                onClick={() => setSelectedEntryId(event.entryId)}
                                data-testid={`log-event-${event.id}`}
                              >
                                <span className="text-xs text-muted-foreground mt-0.5 shrink-0 w-12">{time}</span>
                                <Badge variant="secondary" className={`text-xs px-1.5 py-0 shrink-0 ${colorClass}`}>
                                  {event.eventType.replace("_", " ")}
                                </Badge>
                                <p className="text-xs font-medium truncate min-w-0 flex-1" data-testid={`log-event-title-${event.id}`}>
                                  {event.entryTitle || `Entry #${event.entryId}`}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {selectedEntryId && (
        <div className={cn("flex-1 flex flex-col overflow-hidden min-w-0", MEMORY_PANEL_CLASS)} data-testid="log-detail-panel">
          {selectedEntryData ? (
            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <SourceIcon source={selectedEntryData.source} className="h-4 w-4 text-muted-foreground shrink-0" />
                  <h3 className="text-base font-semibold text-foreground truncate" data-testid="log-detail-title">
                    {getDisplayTitle(selectedEntryData, 80)}
                  </h3>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedEntryId(null)} data-testid="log-detail-close">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1" data-testid="log-detail-time">
                  <Clock className="h-2.5 w-2.5" />
                  {selectedEntryData.createdAt
                    ? new Date(selectedEntryData.createdAt).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
                    : "Unknown"}
                </span>
                <span className="flex items-center gap-1" data-testid="log-detail-id">
                  <Hash className="h-2.5 w-2.5" />{selectedEntryData.id}
                </span>
                <LayerBadge layer={selectedEntryData.layer} />
              </div>

              {selectedEntryData.summary && selectedEntryData.summary !== selectedEntryData.content && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Summary</p>
                  <p className="text-sm text-foreground/80 whitespace-pre-wrap" data-testid="log-detail-summary">
                    {selectedEntryData.summary}
                  </p>
                </div>
              )}

              {displayTags(selectedEntryData.tags).length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {displayTags(selectedEntryData.tags).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs" data-testid={`log-detail-tag-${tag}`}>{tag}</Badge>
                  ))}
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  Content
                </p>
                <div data-testid="log-detail-content">
                  <ExchangeContentRenderer content={selectedEntryData.content} />
                </div>
              </div>

              {selectedEntryData.metadata && Object.keys(selectedEntryData.metadata).length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Metadata</p>
                  <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/70 bg-muted/20 border border-card-border rounded-md p-3" data-testid="log-detail-metadata">
                    {JSON.stringify(selectedEntryData.metadata, null, 2)}
                  </pre>
                </div>
              )}

              <EntityLinksSection entryId={selectedEntryData.id} />

              <EventHistorySection entryId={selectedEntryData.id} timezone={timezone} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function VnextJournalTab() {
  const { timezone } = useTimezone();
  const [granularity, setGranularity] = useState<LogGranularity>("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedClaimId, setSelectedClaimId] = useState<number | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  useFocusContext(
    selectedClaimId !== null
      ? { entity: { type: "memory", id: String(selectedClaimId) } }
      : null
  );

  const { start, end } = useMemo(() => getDateRange(currentDate, granularity), [currentDate, granularity]);
  const startISO = start.toISOString();
  const endISO = end.toISOString();

  const { data: claims = [], isLoading } = useQuery<VnextClaim[]>({
    queryKey: ["/api/memory/vnext/claims", "journal", startISO, endISO],
    queryFn: async () => {
      const pageSize = 100;
      const collected: VnextClaim[] = [];
      let offset = 0;

      while (true) {
        const params = new URLSearchParams({
          createdAfter: startISO,
          createdBefore: endISO,
          limit: String(pageSize),
          offset: String(offset),
        });
        const res = await fetch(`/api/memory/vnext/claims?${params.toString()}`, { credentials: "include" });
        if (!res.ok) throw new Error("Failed to load vNext memory journal");
        const page = await res.json() as VnextClaimsResponse;
        collected.push(...page.claims);
        if (page.claims.length < pageSize) break;
        offset += pageSize;
      }

      return collected;
    },
  });

  const { data: selectedClaimResponse, isLoading: selectedClaimLoading } = useQuery<{ claim: VnextClaim }>({
    queryKey: ["/api/memory/vnext/claims", selectedClaimId],
    queryFn: async () => {
      const res = await fetch(`/api/memory/vnext/claims/${selectedClaimId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load vNext claim");
      return res.json();
    },
    enabled: selectedClaimId !== null,
  });

  const filteredClaims = useMemo(() => {
    if (!searchQuery.trim()) return claims;
    const tokens = searchQuery.toLowerCase().trim().split(/\s+/);
    return claims.filter(claim => {
      const haystack = [
        claim.title,
        claim.content,
        claim.claimType,
        claim.lifecycleStage,
        ...(claim.topics ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
      return tokens.every(t => haystack.includes(t));
    });
  }, [claims, searchQuery]);

  const claimsByDay = useMemo(() => {
    const grouped = new Map<string, VnextClaim[]>();
    for (const claim of filteredClaims) {
      if (!claim.createdAt) continue;
      const day = eventDateKeyInTz(claim.createdAt, timezone);
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day)!.push(claim);
    }
    return grouped;
  }, [filteredClaims, timezone]);

  useEffect(() => {
    const days = Array.from(claimsByDay.keys()).sort().reverse();
    setExpandedDays(new Set(days.slice(0, 3)));
  }, [claimsByDay]);

  const toggleDay = (day: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const selectedClaim = selectedClaimResponse?.claim;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden bg-background text-foreground" data-testid="log-tab">
      <div
        className={cn(
          "flex min-w-0 flex-col overflow-hidden bg-background",
          selectedClaimId !== null ? "w-80 shrink-0 border-r border-border" : "flex-1",
        )}
        data-testid="journal-tree-panel"
      >
        <div className="border-b border-border p-2">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <HierarchySearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                inputTestId="input-search-journal"
                clearTestId="button-clear-journal-search"
                ariaLabel="Search journal"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0" title="Journal range" data-testid="button-journal-range">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-28">
                {(["day", "week", "month", "year"] as LogGranularity[]).map(g => (
                  <DropdownMenuItem
                    key={g}
                    onClick={() => setGranularity(g)}
                    className={cn("text-xs", granularity === g && "font-semibold text-foreground")}
                    data-testid={`menu-journal-${g}`}
                  >
                    {g.toUpperCase()}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="mt-1 flex items-center gap-1" data-testid="log-nav-controls">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentDate(navigateDate(currentDate, granularity, -1))}
              data-testid="log-nav-prev"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="flex-1 text-center text-xs font-medium text-muted-foreground" data-testid="log-period-label">
              {formatPeriodLabel(currentDate, granularity, timezone)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentDate(navigateDate(currentDate, granularity, 1))}
              data-testid="log-nav-next"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setCurrentDate(new Date())}
              data-testid="log-nav-today"
            >
              Today
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-background scrollbar-thin">
          <div className="space-y-1 p-2">
            {isLoading ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading memories…</div>
            ) : claimsByDay.size === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="log-empty-state">
                {searchQuery.trim() ? "No matching memories." : "No memories in this period."}
              </div>
            ) : (
              Array.from(claimsByDay.entries())
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([day, dayClaims]) => {
                  const isSearching = searchQuery.trim().length > 0;
                  const isOpen = isSearching || expandedDays.has(day);
                  return (
                    <Collapsible
                      key={day}
                      open={isOpen}
                      onOpenChange={() => {
                        if (!isSearching) toggleDay(day);
                      }}
                      data-testid={`log-day-${day}`}
                    >
                      <CollapsibleTrigger
                        className={WORKING_SECTION_TRIGGER_CLASS}
                        data-testid={`log-day-toggle-${day}`}
                      >
                        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", isOpen && "rotate-90")} />
                        <span className="min-w-0 flex-1 truncate">{formatDayHeader(day, timezone)}</span>
                        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground/70">{dayClaims.length}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="ml-[11px] mt-0.5">
                          {dayClaims.map((claim, index) => {
                            const isLast = index === dayClaims.length - 1;
                            const isSelected = selectedClaimId === claim.id;
                            return (
                              <div key={claim.id} className="flex min-w-0 items-stretch">
                                <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
                                  <div className={cn("absolute left-1/2 top-0 -translate-x-px border-l border-border", isLast ? "bottom-1/2" : "bottom-0")} />
                                  <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
                                </div>
                                <button
                                  type="button"
                                  className={cn(
                                    WORKING_TREE_ROW_CLASS,
                                    isSelected ? WORKING_TREE_SELECTED_CLASS : WORKING_TREE_IDLE_CLASS,
                                  )}
                                  onClick={() => setSelectedClaimId(claim.id)}
                                  data-testid={`log-claim-${claim.id}`}
                                >
                                  <VnextClaimTypeIcon claimType={claim.claimType} />
                                  <span className={cn("min-w-0 flex-1 truncate text-left", isSelected && "font-medium")}>
                                    {claim.title || firstLine(claim.content, 70)}
                                  </span>
                                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
                                    {claim.createdAt ? eventTimeInTz(claim.createdAt, timezone) : ""}
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })
            )}
          </div>
        </div>
      </div>

      {selectedClaimId !== null && (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background" data-testid="log-detail-panel">
          {selectedClaim ? (
            <div className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <VnextClaimTypeIcon claimType={selectedClaim.claimType} />
                  <h3 className="truncate text-base font-semibold text-foreground" data-testid="log-detail-title">
                    {selectedClaim.title || firstLine(selectedClaim.content, 80)}
                  </h3>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedClaimId(null)} data-testid="log-detail-close">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1" data-testid="log-detail-time">
                  <Clock className="h-2.5 w-2.5" />
                  {selectedClaim.createdAt
                    ? new Date(selectedClaim.createdAt).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
                    : "Unknown"}
                </span>
                <span className="flex items-center gap-1" data-testid="log-detail-id">
                  <Hash className="h-2.5 w-2.5" />{selectedClaim.id}
                </span>
                <Badge variant="outline">{claimTypeLabel(selectedClaim.claimType)}</Badge>
                <Badge variant="outline">{lifecycleLabel(selectedClaim.lifecycleStage)}</Badge>
                <span>{Math.round(Number(selectedClaim.confidence ?? 0) * 100)}% confidence</span>
              </div>

              {(selectedClaim.topics ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {(selectedClaim.topics ?? []).map(topic => (
                    <Badge key={topic} variant="outline" className="text-xs" data-testid={`log-detail-topic-${topic}`}>{topic}</Badge>
                  ))}
                </div>
              )}

              <div>
                <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  Memory
                </p>
                <SimpleTextFrame content={selectedClaim.content} />
              </div>

              <VnextSourceRefsSection claimId={selectedClaim.id} />

              {selectedClaim.metadata && Object.keys(selectedClaim.metadata).length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Metadata</p>
                  <pre className="whitespace-pre-wrap rounded-md border border-card-border bg-muted/20 p-3 font-mono text-xs text-foreground/70" data-testid="log-detail-metadata">
                    {JSON.stringify(selectedClaim.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : selectedClaimLoading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">Loading memory…</div>
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">Memory not found.</div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceTab() {
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<WorkspaceItem | null>(null);

  const { data: items, isLoading } = useQuery<WorkspaceItem[]>({
    queryKey: [`/api/memory/workspace?path=${encodeURIComponent(currentPath)}`],
  });

  const { data: docContent, isLoading: docLoading } = useQuery<Record<string, unknown>>({
    queryKey: ["/api/memory/document", selectedFile?.docType ?? "", selectedFile?.docId ?? ""],
    enabled: !!selectedFile?.docType && !!selectedFile?.docId,
  });

  const breadcrumbParts = currentPath ? currentPath.split("/").filter(Boolean) : [];

  const navigateToDir = useCallback((path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
  }, []);

  const handleItemClick = useCallback((item: WorkspaceItem) => {
    if (item.type === "directory") {
      navigateToDir(item.path);
    } else {
      setSelectedFile(item);
    }
  }, [navigateToDir]);

  return (
    <div className={cn("flex flex-col", MEMORY_SHELL_CLASS)} data-testid="workspace-tab">
      <div className={MEMORY_PANEL_HEADER_CLASS}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink
                className="cursor-pointer text-xs"
                onClick={() => navigateToDir("")}
                data-testid="breadcrumb-root"
              >
                root
              </BreadcrumbLink>
            </BreadcrumbItem>
            {breadcrumbParts.map((part, i) => {
              const partPath = breadcrumbParts.slice(0, i + 1).join("/");
              return (
                <span key={partPath} className="contents">
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                    className="cursor-pointer text-xs"
                    onClick={() => navigateToDir(partPath)}
                    data-testid={`breadcrumb-${part}`}
                  >
                    {part}
                  </BreadcrumbLink>
                  </BreadcrumbItem>
                </span>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className={cn("w-64 shrink-0 border-r overflow-y-auto p-2", MEMORY_PANEL_CLASS)} data-testid="workspace-tree">
          {isLoading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : items && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="workspace-empty">
              <FolderOpen className="h-8 w-8 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No files or folders here</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Documents indexed by the memory system will appear in this workspace</p>
            </div>
          ) : (
            items?.map((item) => {
              const isSelected = selectedFile?.path === item.path;
              const Icon = item.type === "directory" ? FolderClosed : FileText;
              return (
                <div
                  key={item.docId ? `${item.path}:${item.docId}` : item.path}
                  className={`group flex items-center gap-2 py-1.5 px-2 rounded-md cursor-pointer hover-elevate ${isSelected ? "bg-accent" : ""}`}
                  onClick={() => handleItemClick(item)}
                  data-testid={`workspace-item-${item.name}`}
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 text-sm font-mono truncate">{item.name}</span>
                  {item.type === "directory" && (
                    <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                  )}
                  {item.docType && (
                    <span className="inline-flex items-center bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5 shrink-0">{item.docType}</span>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className={cn("flex-1 flex flex-col overflow-hidden min-w-0", MEMORY_PANEL_CLASS)} data-testid="workspace-content">
          {selectedFile ? (
            <>
              <div className={cn("flex items-center gap-2", MEMORY_PANEL_HEADER_CLASS)}>
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-mono text-sm truncate" data-testid="workspace-file-name">{selectedFile.name}</span>
                {selectedFile.docType && (
                  <span className="inline-flex items-center bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="workspace-file-doctype">{selectedFile.docType}</span>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {docLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-5/6" />
                  </div>
                ) : docContent ? (
                  <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 bg-muted/20 border border-card-border rounded-md p-4" data-testid="workspace-file-content">
                    {typeof docContent === "string" ? docContent : JSON.stringify(docContent, null, 2)}
                  </pre>
                ) : (
                  <p className="text-sm text-muted-foreground">Unable to load document content</p>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6" data-testid="workspace-no-selection">
              <FileText className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">Select a file to view its contents</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Click on any file in the tree to preview it here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ContentBlock {
  id: number;
  entryId: number;
  content: string;
  role: string;
  ordinal: number;
  createdAt: string;
}

const blockRoleColors: Record<string, string> = {
  original: "bg-info/15 text-info-foreground border-info/30",
  merged: "bg-warning/15 text-warning-foreground dark:text-warning border-warning/30",
  enriched: "bg-success/15 text-success-foreground border-success/30",
  promoted: "bg-cat-ai/15 text-cat-ai-foreground border-cat-ai/30",
};

function ContentBlocksSection({ entryId }: { entryId: number }) {
  const { data: blocks, isLoading } = useQuery<ContentBlock[]>({
    queryKey: ["/api/memory/entries", entryId, "blocks"],
    queryFn: async () => {
      const res = await fetch(`/api/memory/entries/${entryId}/blocks`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  if (isLoading) return <Skeleton className="h-8 w-full" />;
  if (!blocks || blocks.length === 0) return null;

  return (
    <div data-testid="content-blocks-section">
      <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
        <Layers className="h-3 w-3" />
        Content Blocks ({blocks.length})
      </p>
      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover-elevate rounded-md px-2 py-1" data-testid="toggle-content-blocks">
          <ChevronRight className="h-3 w-3" />
          <span>Show {blocks.length} block{blocks.length !== 1 ? "s" : ""}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 mt-2">
            {blocks.map((block) => {
              const roleClass = blockRoleColors[block.role] || "bg-muted/50 text-muted-foreground border-border";
              return (
                <div key={block.id} className="rounded-md border p-3 space-y-1.5" data-testid={`content-block-${block.id}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={`text-xs border ${roleClass}`} data-testid={`block-role-${block.id}`}>
                      {block.role}
                    </Badge>
                    <span className="text-xs text-muted-foreground">#{block.ordinal}</span>
                  </div>
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed" data-testid={`block-content-${block.id}`}>
                    {block.content}
                  </p>
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function MemoryEntryDetailDialog({ entry, open, onOpenChange }: {
  entry: MemoryEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!entry) return null;

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return null;
    return new Date(dateStr).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const layerLabel = entry.layer === "short" ? "Short-term" : entry.layer === "mid" ? "Mid-term" : "Long-term";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid={`dialog-entry-detail-${entry.id}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            <span>Memory Entry #{entry.id}</span>
            <Badge variant="outline" className="text-xs ml-1" data-testid="detail-layer">{layerLabel}</Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
              <FileText className="h-3 w-3" />
              Content
            </p>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed" data-testid="detail-full-content">
              {entry.content}
            </p>
          </div>

          {entry.summary && entry.summary !== entry.content && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Summary</p>
              <p className="text-sm text-foreground/80 whitespace-pre-wrap" data-testid="detail-summary">
                {entry.summary}
              </p>
            </div>
          )}

          <ContentBlocksSection entryId={entry.id} />

          {entry.sourceId && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Source</p>
              {SOURCE_REF_TYPE_MAP[entry.source] ? (
                <span data-testid="detail-source-id"><SourceRefLabel sourceType={entry.source} sourceId={entry.sourceId} /></span>
              ) : (
                <span className="text-xs font-mono text-foreground/70" data-testid="detail-source-id">{entry.sourceId}</span>
              )}
            </div>
          )}

          {displayTags(entry.tags).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <Tag className="h-3 w-3" />
                Tags
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {displayTags(entry.tags).map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs" data-testid={`detail-tag-${tag}`}>{tag}</Badge>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Timestamps
            </p>
            <div className="space-y-1">
              {entry.createdAt && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-20 shrink-0">Created</span>
                  <span className="text-xs text-foreground/80" data-testid="detail-created-at">{formatDate(entry.createdAt)}</span>
                </div>
              )}
              {entry.updatedAt && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-20 shrink-0">Processed</span>
                  <span className="text-xs text-foreground/80" data-testid="detail-processed-at">{formatDate(entry.updatedAt)}</span>
                </div>
              )}
            </div>
          </div>

          {(() => {
            const delInfo = getDeletionInfo(entry);
            if (!delInfo) return null;
            return (
              <div className="rounded-md border border-error/30 bg-error/5 p-3" data-testid="detail-deletion-info">
                <p className="text-xs font-medium text-error mb-1.5 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Pending Deletion
                </p>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-20 shrink-0">Scheduled</span>
                    <span className="text-xs text-foreground/80" data-testid="detail-deletion-scheduled">{delInfo.scheduled}</span>
                  </div>
                  {delInfo.reason && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Reason</span>
                      <span className="text-xs text-foreground/80" data-testid="detail-deletion-reason">{delInfo.reason}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {entry.metadata && Object.keys(entry.metadata).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Metadata</p>
              <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/70 bg-muted/20 border border-card-border rounded-md p-3" data-testid="detail-metadata">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


function LayersTab() {
  const { toast } = useToast();
  const { timezone } = useTimezone();
  const [storageMode, setStorageMode] = useState<LayersStorageMode>("vnext");
  const [openStages, setOpenStages] = useState<Set<string>>(() => new Set(MEMORY_PIPELINE_STAGES.map(stage => stage.value)));
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<number>>(new Set());
  const [expandedClaimIds, setExpandedClaimIds] = useState<Set<number>>(new Set());
  const { status: consolidationStatus } = useConsolidationStatus();
  const { status: integrationStatus } = useIntegrationStatus();
  const { status: graphMyelinationStatus } = useGraphMyelinationStatus();
  const [clearLayer, setClearLayer] = useState<string | null>(null);
  const [showPendingDeletions, setShowPendingDeletions] = useState(false);
  const [layersSearchQuery, setLayersSearchQuery] = useState("");

  useEffect(() => {
    setOpenStages(new Set((storageMode === "legacy" ? MEMORY_PIPELINE_STAGES : MEMORY_VNEXT_PIPELINE_STAGES).map(stage => stage.value)));
  }, [storageMode]);

  const { events } = useEventStream();
  const lastSeenEventRef = useRef<string | null>(null);

  const { data: stats, isLoading: statsLoading } = useQuery<MemoryStats>({ queryKey: ["/api/memory/stats"], enabled: storageMode === "legacy" });
  const { data: allEntries, isLoading: entriesLoading } = useQuery<MemoryEntry[]>({ queryKey: ["/api/memory/entries"], enabled: storageMode === "legacy" });
  const { data: vnextCounts, isLoading: vnextCountsLoading } = useQuery<VnextClaimCounts>({ queryKey: ["/api/memory/vnext/claims/counts"], enabled: storageMode === "vnext" });
  const { data: vnextClaimsResponse, isLoading: vnextClaimsLoading } = useQuery<VnextClaimsResponse>({ queryKey: ["/api/memory/vnext/claims", "layers", 100], queryFn: async () => { const res = await fetch("/api/memory/vnext/claims?limit=100", { credentials: "include" }); if (!res.ok) throw new Error("Failed to load vNext claims"); return res.json(); }, enabled: storageMode === "vnext" });
  const { data: vnextSourcesResponse, isLoading: vnextSourcesLoading } = useQuery<VnextSourcesResponse>({ queryKey: ["/api/memory/vnext/sources", "layers", 100], queryFn: async () => { const res = await fetch("/api/memory/vnext/sources?limit=100", { credentials: "include" }); if (!res.ok) throw new Error("Failed to load vNext sources"); return res.json(); }, enabled: storageMode === "vnext" });

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    if (latest.id === lastSeenEventRef.current) return;
    if (latest.event === "entries_changed") {
      lastSeenEventRef.current = latest.id;
      queryClient.invalidateQueries({ queryKey: ["/api/memory/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/consolidation/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/integration/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims/counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/sources"] });
    }
  }, [events]);

  const pipelineEntries = useMemo(() => {
    const entries = allEntries ?? [];
    const deletionFiltered = showPendingDeletions ? entries.filter(isDeletionScheduled) : entries;
    const queryTokens = layersSearchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = queryTokens.length === 0 ? deletionFiltered : deletionFiltered.filter(entry => {
      const searchable = [entry.title, entry.summary, entry.content, ...(entry.tags ?? []), ...(entry.topics ?? [])].filter(Boolean).join(" ").toLowerCase();
      return queryTokens.every(token => searchable.includes(token));
    });
    return [...filtered].sort((a, b) => {
      const stageCompare = (a.integrationStage || "stage_0").localeCompare(b.integrationStage || "stage_0");
      if (stageCompare !== 0) return stageCompare;
      return new Date(b.processedAt || b.updatedAt || b.createdAt || 0).getTime() - new Date(a.processedAt || a.updatedAt || a.createdAt || 0).getTime();
    });
  }, [allEntries, showPendingDeletions, layersSearchQuery]);

  const entriesByStage = useMemo(() => {
    const groups = new Map<string, MemoryEntry[]>();
    for (const stage of MEMORY_PIPELINE_STAGES) groups.set(stage.value, []);
    for (const entry of pipelineEntries) {
      const stage = entry.integrationStage || "stage_0";
      if (!groups.has(stage)) groups.set(stage, []);
      groups.get(stage)!.push(entry);
    }
    return groups;
  }, [pipelineEntries]);

  const vnextSources = useMemo(() => {
    const queryTokens = layersSearchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const sources = (vnextSourcesResponse?.sources ?? []).filter(source => {
      if (source.status === "completed") return false;
      if (queryTokens.length === 0) return true;
      const searchable = `${source.sourceType} ${source.sourceId}`.toLowerCase();
      return queryTokens.every(token => searchable.includes(token));
    });
    return [...sources].sort((a, b) => new Date(b.lastModifiedAt || b.createdAt || 0).getTime() - new Date(a.lastModifiedAt || a.createdAt || 0).getTime());
  }, [vnextSourcesResponse, layersSearchQuery]);

  const vnextClaims = useMemo(() => {
    const queryTokens = layersSearchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const claims = vnextClaimsResponse?.claims ?? [];
    const filtered = queryTokens.length === 0 ? claims : claims.filter(claim => {
      const searchable = [claim.title, claim.content, claim.claimType, ...(claim.topics ?? [])].filter(Boolean).join(" ").toLowerCase();
      return queryTokens.every(token => searchable.includes(token));
    });
    return [...filtered].sort((a, b) => {
      const stageCompare = (a.lifecycleStage || "extracted").localeCompare(b.lifecycleStage || "extracted");
      if (stageCompare !== 0) return stageCompare;
      return new Date(b.lifecycleStageUpdatedAt || b.updatedAt || b.createdAt || 0).getTime() - new Date(a.lifecycleStageUpdatedAt || a.updatedAt || a.createdAt || 0).getTime();
    });
  }, [vnextClaimsResponse, layersSearchQuery]);

  const vnextClaimsByStage = useMemo(() => {
    const groups = new Map<string, VnextClaim[]>();
    for (const stage of MEMORY_VNEXT_CLAIM_STAGES) groups.set(stage.value, []);
    for (const claim of vnextClaims) {
      const stage = claim.lifecycleStage || "extracted";
      if (!groups.has(stage)) groups.set(stage, []);
      groups.get(stage)!.push(claim);
    }
    return groups;
  }, [vnextClaims]);

  const flushMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/memory/flush/short"),
    onSuccess: () => { toast({ title: "Short-term memory cleared" }); queryClient.invalidateQueries({ queryKey: ["/api/memory/entries"] }); queryClient.invalidateQueries({ queryKey: ["/api/memory/stats"] }); },
  });
  const flushMidMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/memory/flush/mid"),
    onSuccess: () => { toast({ title: "Mid-term memory cleared" }); queryClient.invalidateQueries({ queryKey: ["/api/memory/entries"] }); queryClient.invalidateQueries({ queryKey: ["/api/memory/stats"] }); },
  });
  const flushLongMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/memory/flush/long"),
    onSuccess: () => { toast({ title: "Long-term memory cleared" }); queryClient.invalidateQueries({ queryKey: ["/api/memory/entries"] }); queryClient.invalidateQueries({ queryKey: ["/api/memory/stats"] }); },
  });
  const consolidateMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/memory/consolidation/trigger"),
    onSuccess: () => { toast({ title: "Consolidation started" }); queryClient.invalidateQueries({ queryKey: ["/api/memory/consolidation/status"] }); },
  });
  const integrateMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/memory/integration/trigger"),
    onSuccess: () => { toast({ title: "Integration started" }); queryClient.invalidateQueries({ queryKey: ["/api/memory/integration/status"] }); },
  });
  const graphMyelinationMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/memory/myelination/run", { batchSize: 25 }),
    onSuccess: () => { toast({ title: "Graph myelination started" }); queryClient.invalidateQueries({ queryKey: ["/api/memory/myelination/status"] }); },
  });
  const vnextLifecycleMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/memory/vnext/lifecycle/run", { limit: 100 })).json() as Promise<VnextLifecycleRunResponse>,
    onSuccess: (result) => {
      toast({ title: "vNext lifecycle complete", description: `${result.scanned} scanned · ${result.sourced + result.linked + result.canonicalized + result.retired} advanced · ${result.skipped} skipped` });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims/counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims"] });
    },
  });

  const [nukeDialogOpen, setNukeDialogOpen] = useState(false);
  const [nukeConfirmText, setNukeConfirmText] = useState("");
  const vnextNukeMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/memory/vnext/claims/nuke", { confirm: "NUKE" })).json() as Promise<{ nuked: boolean; deleted: number }>,
    onSuccess: (result) => {
      toast({ title: "vNext memories nuked", description: `${result.deleted} claims permanently deleted.` });
      setNukeDialogOpen(false);
      setNukeConfirmText("");
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims/counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims"] });
    },
    onError: (error: Error) => toast({ title: "Nuke failed", description: error.message, variant: "destructive" }),
  });

  const pendingDeletionCount = useMemo(() => allEntries?.filter(isDeletionScheduled).length ?? 0, [allEntries]);
  const isLoading = storageMode === "legacy" ? statsLoading || entriesLoading : vnextCountsLoading || vnextClaimsLoading || vnextSourcesLoading;

  if (isLoading) {
    return <div className={cn("p-3 space-y-2", MEMORY_SHELL_CLASS)}><Skeleton className="h-8 w-full rounded-md" /><Skeleton className="h-28 w-full rounded-md" /><Skeleton className="h-28 w-full rounded-md" /></div>;
  }

  const toggleStage = (stage: string) => {
    setOpenStages(prev => { const next = new Set(prev); next.has(stage) ? next.delete(stage) : next.add(stage); return next; });
  };
  const toggleEntry = (entryId: number) => {
    setExpandedEntryIds(prev => { const next = new Set(prev); next.has(entryId) ? next.delete(entryId) : next.add(entryId); return next; });
  };
  const toggleClaim = (claimId: number) => {
    setExpandedClaimIds(prev => { const next = new Set(prev); next.has(claimId) ? next.delete(claimId) : next.add(claimId); return next; });
  };

  const renderVnextSourceRow = (source: VnextSourceQueueRow) => {
    const modified = formatPipelineTime(source.lastModifiedAt || source.createdAt, timezone);
    const refType = SOURCE_REF_TYPE_MAP[source.sourceType] ?? null;
    return (
      <div key={source.id} className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/30" data-testid={`memory-vnext-source-row-${source.id}`}>
        <div className="min-w-0 flex-1">
          {refType ? (
            <ReferenceRenderer refValue={createReferenceRef({ type: refType, id: source.sourceId })} surface="simple-chip" />
          ) : (
            <span className="truncate font-medium">{source.sourceType}:{source.sourceId}</span>
          )}
        </div>
        {modified && <span className="shrink-0 text-[11px] text-muted-foreground/60">{modified}</span>}
      </div>
    );
  };

  const renderVnextStageSection = (stage: { value: string; label: string }) => {
    const isSourceStage = stage.value === MEMORY_VNEXT_SOURCE_STAGE.value;
    const claims = isSourceStage ? [] : (vnextClaimsByStage.get(stage.value) ?? []);
    const count = isSourceStage ? vnextSources.length : claims.length;
    const open = openStages.has(stage.value);
    return (
      <Collapsible key={stage.value} open={open} onOpenChange={() => toggleStage(stage.value)} data-testid={`memory-vnext-stage-${stage.value}`}>
        <CollapsibleTrigger className={WORKING_SECTION_TRIGGER_CLASS} data-testid={`memory-vnext-stage-trigger-${stage.value}`}>
          <span className="min-w-0 flex-1 truncate">{stage.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground/70" data-testid={`memory-vnext-stage-count-${stage.value}`}>{count}</span>
          <span className="ml-1 flex w-5 shrink-0 items-center justify-center"><ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} /></span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-0.5 pb-2" data-testid={`memory-vnext-stage-claims-${stage.value}`}>
            {isSourceStage ? (
              vnextSources.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground/60" data-testid="memory-vnext-stage-empty-stage_0">No queued vNext sources.</div> : vnextSources.map(renderVnextSourceRow)
            ) : (
              claims.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground/60" data-testid={`memory-vnext-stage-empty-${stage.value}`}>No vNext claims in this stage.</div> : claims.map(claim => <VnextClaimRow key={claim.id} claim={claim} expanded={expandedClaimIds.has(claim.id)} onToggle={() => toggleClaim(claim.id)} timezone={timezone} />)
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const renderStageSection = (stage: { value: string; label: string; description: string }) => {
    const entries = entriesByStage.get(stage.value) ?? [];
    const open = openStages.has(stage.value);
    const tone = getStageStatusTone(entries);
    const processingCount = entries.filter(entry => entry.processingStatus === "processing").length;
    const activeIndex = entries.findIndex(entry => entry.processingStatus === "processing");
    const progressPercent = processingCount > 0 && entries.length > 0 ? Math.max(8, ((activeIndex >= 0 ? activeIndex + 1 : 1) / entries.length) * 100) : 0;
    return (
      <Collapsible key={stage.value} open={open} onOpenChange={() => toggleStage(stage.value)} data-testid={`memory-pipeline-stage-${stage.value}`}>
        <CollapsibleTrigger className={cn(WORKING_SECTION_TRIGGER_CLASS, stageHeaderToneClass(tone))} data-testid={`memory-pipeline-stage-trigger-${stage.value}`}>
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          {pipelineSignalIcon(tone, `memory-pipeline-stage-status-${stage.value}`)}
          <span className="min-w-0 truncate">{stage.label}</span>
          <span className="hidden sm:inline text-[11px] normal-case font-normal tracking-normal text-muted-foreground/60">{stage.description}</span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/70" data-testid={`memory-pipeline-stage-count-${stage.value}`}>{entries.length}</span>
        </CollapsibleTrigger>
        {processingCount > 0 && <div className="mx-2 h-px bg-info/20" data-testid={`memory-pipeline-stage-progress-${stage.value}`}><div className="h-px bg-info transition-all" style={{ width: `${progressPercent}%` }} /></div>}
        <CollapsibleContent>
          <div className="space-y-0.5 pb-2" data-testid={`memory-pipeline-stage-entries-${stage.value}`}>
            {entries.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground/60" data-testid={`memory-pipeline-stage-empty-${stage.value}`}>No memories in this stage.</div> : entries.map(entry => <MemoryPipelineRow key={entry.id} entry={entry} expanded={expandedEntryIds.has(entry.id)} onToggle={() => toggleEntry(entry.id)} timezone={timezone} />)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <div className={cn("flex flex-col", MEMORY_SHELL_CLASS)} data-testid="layers-tab">
      <div className="flex items-center gap-1 border-b border-card-border bg-background p-2" data-testid="layers-controls-bar">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={layersSearchQuery}
            onChange={(event) => setLayersSearchQuery(event.target.value)}
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="input-search-layers"
          />
          {layersSearchQuery && (
            <button
              type="button"
              onClick={() => setLayersSearchQuery("")}
              className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
              data-testid="button-clear-layers-search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" data-testid="button-layers-menu">
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={storageMode} onValueChange={(value) => setStorageMode(value as LayersStorageMode)}>
              <DropdownMenuRadioItem value="vnext" data-testid="menu-layers-mode-vnext">vNext</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="legacy" data-testid="menu-layers-mode-legacy">Legacy</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {storageMode === "vnext" ? (
              <>
                <DropdownMenuItem onClick={() => vnextLifecycleMutation.mutate()} disabled={vnextLifecycleMutation.isPending} data-testid="menu-run-vnext-lifecycle">
                  {vnextLifecycleMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <GitBranch className="mr-2 h-3.5 w-3.5" />}
                  Run lifecycle
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onSelect={() => setTimeout(() => { setNukeConfirmText(""); setNukeDialogOpen(true); }, 0)} disabled={vnextNukeMutation.isPending} data-testid="menu-nuke-vnext">
                  <Trash2 className="mr-2 h-3.5 w-3.5" />Nuke...
                </DropdownMenuItem>
              </>
            ) : (
              <>
                {pendingDeletionCount > 0 && <DropdownMenuItem onSelect={() => setShowPendingDeletions(!showPendingDeletions)} data-testid="menu-filter-pending-deletions"><AlertTriangle className="mr-2 h-3.5 w-3.5 text-error" />{showPendingDeletions ? "Show all" : `${pendingDeletionCount} pending`}</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => consolidateMutation.mutate()} disabled={consolidateMutation.isPending || consolidationStatus?.running} data-testid="menu-consolidate">Consolidate</DropdownMenuItem>
                <DropdownMenuItem onClick={() => integrateMutation.mutate()} disabled={integrateMutation.isPending || integrationStatus?.running} data-testid="menu-integrate-mid">Integrate</DropdownMenuItem>
                <DropdownMenuItem onClick={() => graphMyelinationMutation.mutate()} disabled={graphMyelinationMutation.isPending || graphMyelinationStatus?.running} data-testid="menu-myelinate-graph">Myelinate to Graph</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => setTimeout(() => setClearLayer("short"), 0)} data-testid="menu-clear-short">Clear Short-term Memory...</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onSelect={() => setTimeout(() => setClearLayer("mid"), 0)} data-testid="menu-clear-mid">Clear Mid-term Memory...</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onSelect={() => setTimeout(() => setClearLayer("long"), 0)} data-testid="menu-clear-long">Clear Long-term Memory...</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {storageMode === "legacy" ? (
        <>
          <ConsolidationProgressBar status={consolidationStatus} />
          <IntegrationProgressBar status={integrationStatus} />
          <GraphMyelinationProgressBar status={graphMyelinationStatus} />
        </>
      ) : null}

      <AlertDialog open={nukeDialogOpen} onOpenChange={(open) => { setNukeDialogOpen(open); if (!open) setNukeConfirmText(""); }}>
        <AlertDialogContent data-testid="dialog-nuke-vnext">
          <AlertDialogHeader>
            <AlertDialogTitle>Nuke all vNext memories?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all {vnextCounts?.total ?? 0} vNext claims plus their source refs, entity links, and claim links. Legacy memory is untouched. This cannot be undone. Type NUKE to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={nukeConfirmText} onChange={(event) => setNukeConfirmText(event.target.value)} placeholder="Type NUKE to confirm" data-testid="input-nuke-confirm" />
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-nuke-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={nukeConfirmText !== "NUKE" || vnextNukeMutation.isPending} onClick={(event) => { event.preventDefault(); vnextNukeMutation.mutate(); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-nuke-confirm">
              {vnextNukeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Nuke everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-2" data-testid={storageMode === "legacy" ? "memory-pipeline-tree" : "memory-vnext-claim-tree"}>
        {storageMode === "legacy" ? (
          pipelineEntries.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="memory-pipeline-empty">No legacy memories yet.</div> : <div className="space-y-0.5">{MEMORY_PIPELINE_STAGES.map(renderStageSection)}</div>
        ) : (
          (vnextClaims.length === 0 && vnextSources.length === 0) ? <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="memory-vnext-empty">No vNext memories yet.</div> : <div className="space-y-0.5">{MEMORY_VNEXT_PIPELINE_STAGES.map(renderVnextStageSection)}</div>
        )}
      </div>

      <AlertDialog open={clearLayer !== null} onOpenChange={(open) => { if (!open) setClearLayer(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Clear {clearLayer}-term memory?</AlertDialogTitle><AlertDialogDescription>This will permanently delete all {clearLayer === "short" ? (stats?.short ?? 0) : clearLayer === "mid" ? (stats?.mid ?? 0) : (stats?.long ?? 0)} {clearLayer}-term memory entries. This action cannot be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel data-testid="button-clear-cancel">Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (clearLayer === "short") flushMutation.mutate(); else if (clearLayer === "mid") flushMidMutation.mutate(); else if (clearLayer === "long") flushLongMutation.mutate(); setClearLayer(null); }} data-testid="button-clear-confirm">Clear</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GraphTab({ inFullscreenModal = false, onOpenFullscreen }: { inFullscreenModal?: boolean; onOpenFullscreen?: () => void } = {}) {
  const { toast } = useToast();
  const { timezone } = useTimezone();
  const isMobile = useIsMobile();
  const graphRef = useRef<MemoryGraph3DHandle>(null);
  const [selectedNode, setSelectedNode] = useState<MemoryEntry | null>(null);
  const [graphStorageMode, setGraphStorageMode] = useState<GraphStorageMode>("vnext");
  const [graphLinkSource, setGraphLinkSource] = useState<"links" | "sources">("links");
  const [removeFromGraphConfirmOpen, setRemoveFromGraphConfirmOpen] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const isVnextGraph = graphStorageMode === "vnext";
  const myelination = useMyelination();

  useFocusContext(
    selectedNode
      ? { entity: { type: "memory", id: String(selectedNode.id), label: selectedNode.title || undefined } }
      : null,
  );

  const { data: palace, isLoading } = useQuery<PalaceData>({
    queryKey: ["/api/memory/graph", graphStorageMode, graphLinkSource],
    queryFn: async () => {
      const endpoint = isVnextGraph
        ? "/api/memory/vnext/graph"
        : `/api/memory/palace?linkSource=${graphLinkSource}`;
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Failed to fetch ${graphStorageMode} graph`);
      return response.json();
    },
  });

  const entryMap = useMemo(
    () => new Map((palace?.entries || []).map((entry) => [entry.id, entry])),
    [palace?.entries],
  );

  const graphNodes = useMemo<MemoryGraph3DNode[]>(() => {
    const degree = new Map<number, number>();
    for (const link of palace?.links || []) {
      degree.set(link.fromId, (degree.get(link.fromId) || 0) + 1);
      degree.set(link.toId, (degree.get(link.toId) || 0) + 1);
    }
    return (palace?.entries || []).map((entry) => {
      const metadata = (entry.metadata || {}) as Record<string, unknown>;
      const visual = getGraphNodeVisual(entry);
      const label = entry.title?.trim() || entry.oneLiner?.trim() || entry.content.trim().slice(0, 72) || visual.label;
      return {
        id: entry.id,
        source: visual.source,
        label,
        degree: degree.get(entry.id) || 0,
        decayScore: metadata.decay_score == null ? 1 : Number(metadata.decay_score),
        pendingDeletion: Boolean(metadata.deletionScheduled),
      };
    });
  }, [palace]);

  const graphLinks = useMemo<MemoryGraph3DLink[]>(
    () => (palace?.links || []).map((link) => ({ ...link })),
    [palace?.links],
  );

  const handleNodeSelect = useCallback((nodeId: number) => {
    const entry = entryMap.get(nodeId);
    if (entry) setSelectedNode(entry);
  }, [entryMap]);

  const handleNodeHover = useCallback((nodeId: number | null, position?: { x: number; y: number }) => {
    setHoveredNodeId(nodeId);
    if (position) setTooltipPos(position);
  }, []);

  useEffect(() => {
    if (selectedNode && !entryMap.has(selectedNode.id)) setSelectedNode(null);
  }, [entryMap, selectedNode]);

  const removeFromGraphMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("PATCH", `/api/memory/entries/${id}/graph`, { graphed: false });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Removed from graph" });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/graph"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/palace"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/entries"] });
      setSelectedNode(null);
    },
    onError: (error: Error) => {
      toast({ title: "Remove failed", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return <div className="p-4"><Skeleton className="h-[400px] w-full" /></div>;
  }

  if (!palace?.entries?.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-12 px-6 text-center" data-testid="palace-empty">
        <Share2 className="h-6 w-6 text-muted-foreground/30 mb-4" />
        <h3 className="text-sm font-medium text-foreground mb-1">No memories in graph yet</h3>
        <p className="text-sm text-muted-foreground/70 max-w-sm">
          {isVnextGraph
            ? "vNext claims appear here after extraction creates claim links or entity links."
            : "Promote long-term memories to the graph from the Working tab."}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", MEMORY_SHELL_CLASS)} data-testid="palace-tab">


      {(myelination.isMyelinating || myelination.isPaused) && (
        <div className={MEMORY_PANEL_HEADER_CLASS}>
          <MyelinationProgressBar />
        </div>
      )}

      <div className="relative flex flex-1 overflow-hidden min-h-0">
        <div className="flex-1 relative overflow-hidden bg-background">
          <MemoryGraph3D
            ref={graphRef}
            nodes={graphNodes}
            links={graphLinks}
            selectedNodeId={selectedNode?.id ?? null}
            onNodeSelect={handleNodeSelect}
            onNodeHover={handleNodeHover}
          />

          <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-card-border bg-card/80 px-3 py-2 text-xs text-muted-foreground backdrop-blur-sm">
            Drag to orbit · Scroll to zoom · Select a node to inspect
          </div>

          {hoveredNodeId !== null && (() => {
            const hovEntry = entryMap.get(hoveredNodeId);
            if (!hovEntry) return null;
            const displayTitle = hovEntry.title || hovEntry.summary?.split('\n')[0]?.slice(0, 60) || `Entry #${hovEntry.id}`;
            const visual = getGraphNodeVisual(hovEntry);
            const nodeType = visual.source;
            const referenceType = nodeType === "person" ? "person" : nodeType === "page" ? "page" : nodeType === "session" ? "session" : null;
            const summaryText = hovEntry.content || hovEntry.summary;
            const dateText = hovEntry.updatedAt || hovEntry.createdAt;
            const HoverIcon = visual.Icon;
            return (
              <div
                className="absolute z-50 max-w-xs rounded-md border border-card-border bg-popover p-3 shadow-md"
                style={{ left: tooltipPos.x, top: tooltipPos.y, transform: 'translateY(-50%)' }}
                data-testid={`palace-node-tooltip-${hoveredNodeId}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-popover-foreground leading-tight mb-2" data-testid="tooltip-title">
                  <HoverIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{displayTitle}</span>
                </div>
                {referenceType && hovEntry.sourceId && (
                  <div className="mb-2" data-testid="tooltip-reference">
                    <ReferenceRenderer refValue={createReferenceRef({ type: referenceType, id: hovEntry.sourceId })} surface="simple-chip" />
                  </div>
                )}
                {summaryText && <p className="text-xs text-popover-foreground/80 leading-relaxed line-clamp-4" data-testid="tooltip-summary">{summaryText}</p>}
                {dateText && <p className="mt-2 text-xs text-muted-foreground" data-testid="tooltip-date">{new Date(dateText).toLocaleDateString()}</p>}
              </div>
            );
          })()}

          <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1" data-testid="palace-zoom-controls">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" data-testid="button-graph-menu">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={graphStorageMode} onValueChange={(value) => { setGraphStorageMode(value as GraphStorageMode); setSelectedNode(null); }}>
                  <DropdownMenuRadioItem value="vnext" data-testid="menu-graph-mode-vnext">vNext</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="legacy" data-testid="menu-graph-mode-legacy">Legacy</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                {!isVnextGraph && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setGraphLinkSource(graphLinkSource === "links" ? "sources" : "links")} data-testid="menu-graph-link-source">
                      {graphLinkSource === "links" ? "Use source refs" : "Use legacy links"}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="icon" onClick={() => graphRef.current?.zoomIn()} aria-label="Zoom in" title="Zoom in" data-testid="button-zoom-in">
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="icon" onClick={() => graphRef.current?.zoomOut()} aria-label="Zoom out" title="Zoom out" data-testid="button-zoom-out">
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="icon" onClick={() => graphRef.current?.fitToView()} aria-label="Fit graph to view" title="Fit graph to view" data-testid="button-graph-fit">
              <CircleDot className="h-3.5 w-3.5" />
            </Button>
            {!isMobile && !inFullscreenModal && onOpenFullscreen && (
              <Button variant="outline" size="icon" onClick={onOpenFullscreen} aria-label="Open graph fullscreen" title="Open graph fullscreen" data-testid="button-graph-fullscreen">
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {selectedNode && (
          <div className={cn("absolute inset-x-2 bottom-2 z-20 max-h-[55%] overflow-y-auto scrollbar-thin border p-4 space-y-4 md:inset-y-2 md:left-auto md:right-2 md:w-80 md:max-h-none", MEMORY_PANEL_CLASS)} data-testid="palace-detail-panel">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <SourceIcon source={selectedNode.source} className="h-4 w-4 text-muted-foreground shrink-0" />
                <h3 className="text-base font-semibold text-foreground truncate" data-testid="graph-detail-title">
                  {getDisplayTitle(selectedNode, 80)}
                </h3>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isVnextGraph && (
                <AlertDialog open={removeFromGraphConfirmOpen} onOpenChange={setRemoveFromGraphConfirmOpen}>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={removeFromGraphMutation.isPending}
                      title="Remove from graph"
                      data-testid={`button-remove-from-graph-${selectedNode.id}`}
                    >
                      <Share2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove from graph?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove this memory from the graph and delete its links. The memory itself is preserved in long-term memory.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          removeFromGraphMutation.mutate(selectedNode.id);
                          setRemoveFromGraphConfirmOpen(false);
                        }}
                        disabled={removeFromGraphMutation.isPending}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        data-testid="button-remove-from-graph-confirm"
                      >
                        {removeFromGraphMutation.isPending ? "Removing..." : "Remove"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                )}
                <Button variant="ghost" size="icon" onClick={() => setSelectedNode(null)} data-testid="button-close-detail">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1" data-testid="graph-detail-time">
                <Clock className="h-2.5 w-2.5" />
                {selectedNode.createdAt
                  ? new Date(selectedNode.createdAt).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
                  : "Unknown"}
              </span>
              <span className="flex items-center gap-1" data-testid="graph-detail-id">
                <Hash className="h-2.5 w-2.5" />{selectedNode.id}
              </span>
              <span className="text-muted-foreground/50" data-testid="graph-detail-tokens">
                ~{formatTokens(estimateTokens(selectedNode.content))} tok
              </span>
            </div>

            {selectedNode.summary && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  Summary
                </p>
                <p className="text-sm text-foreground/80 leading-relaxed" data-testid="graph-detail-summary">{selectedNode.summary}</p>
              </div>
            )}

            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline" className="text-xs">{selectedNode.source}</Badge>
              <Badge variant="outline" className="text-xs">{isVnextGraph ? (((selectedNode.metadata || {}) as Record<string, unknown>).nodeKind as string || "claim") : selectedNode.layer}</Badge>
              {isVnextGraph && ((selectedNode.metadata || {}) as Record<string, unknown>).lifecycleStage && (
                <Badge variant="outline" className="text-xs" data-testid="graph-detail-lifecycle-stage">
                  {lifecycleLabel(String(((selectedNode.metadata || {}) as Record<string, unknown>).lifecycleStage))}
                </Badge>
              )}
              {isDeletionScheduled(selectedNode) && (
                <Badge variant="outline" className="text-xs border-error/50 text-error bg-error/10" data-testid={`badge-pending-deletion-graph-${selectedNode.id}`}>
                  <AlertTriangle className="h-2 w-2 mr-0.5" />
                  Pending deletion
                </Badge>
              )}
              {selectedNode.tags?.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
              ))}
            </div>

            {(() => {
              const nodeLinks = (palace?.links || [])
                .filter(l => l.fromId === selectedNode.id || l.toId === selectedNode.id)
                .map(l => {
                  const otherId = l.fromId === selectedNode.id ? l.toId : l.fromId;
                  const otherEntry = entryMap.get(otherId);
                  return otherEntry ? { link: l, entry: otherEntry } : null;
                })
                .filter(Boolean) as { link: MemoryLink; entry: MemoryEntry }[];
              if (nodeLinks.length === 0) return null;
              return (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Link2 className="h-3 w-3" />
                    Links ({nodeLinks.length})
                  </p>
                  <div className="space-y-1">
                    {nodeLinks.map(({ link, entry: linkedEntry }) => (
                      <div
                        key={link.id}
                        className={cn("flex items-center gap-2 px-3 py-2 cursor-pointer", MEMORY_LIST_ROW_CLASS)}
                        onClick={() => setSelectedNode(linkedEntry)}
                        data-testid={`graph-detail-link-${link.id}`}
                      >
                        <SourceIcon source={linkedEntry.source} className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate text-foreground/80">{linkedEntry.title || firstLine(linkedEntry.content)}</p>
                          <p className="text-xs text-muted-foreground truncate">{link.relationship}</p>
                        </div>
                        <span className="text-xs text-muted-foreground/50 shrink-0">
                          {(link.strength * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <FileText className="h-3 w-3" />
                Content
              </p>
              <div data-testid="graph-detail-content">
                <ExchangeContentRenderer content={selectedNode.content} />
              </div>
            </div>

            {(() => {
              const delInfo = getDeletionInfo(selectedNode);
              if (!delInfo) return null;
              return (
                <div className="rounded-md border border-error/30 bg-error/5 p-3" data-testid="graph-detail-deletion-info">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs font-medium text-error flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Pending Deletion
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs gap-1 text-success hover:text-success-foreground"
                      onClick={() => {
                        const currentMeta = (selectedNode.metadata || {}) as Record<string, unknown>;
                        const { deletionScheduled: _, deletionReason: __, ...cleanMeta } = currentMeta;
                        apiRequest("PATCH", `/api/memory/entries/${selectedNode.id}`, { metadata: cleanMeta }).then(() => {
                          queryClient.invalidateQueries({ queryKey: ["/api/memory/palace"] });
                          queryClient.invalidateQueries({ queryKey: ["/api/memory/entries"] });
                          toast({ title: "Entry rescued", description: "Deletion scheduling cleared" });
                        }).catch((err: Error) => {
                          toast({ title: "Rescue failed", description: err.message || "Could not clear deletion scheduling", variant: "destructive" });
                        });
                      }}
                      data-testid={`button-rescue-graph-${selectedNode.id}`}
                    >
                      <ShieldCheck className="h-3 w-3" />
                      Rescue
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Scheduled</span>
                      <span className="text-xs text-foreground/80">{delInfo.scheduled}</span>
                    </div>
                    {delInfo.reason && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-20 shrink-0">Reason</span>
                        <span className="text-xs text-foreground/80">{delInfo.reason}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {selectedNode.metadata && Object.keys(selectedNode.metadata).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Metadata</p>
                <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/70 bg-muted/20 border border-card-border rounded-md p-3" data-testid="graph-detail-metadata">
                  {JSON.stringify(selectedNode.metadata, null, 2)}
                </pre>
              </div>
            )}

            <EntityLinksSection entryId={selectedNode.id} />

            <EventHistorySection entryId={selectedNode.id} timezone={timezone} />
          </div>
        )}
      </div>

    </div>
  );
}

interface MemoryEntityLink {
  id: number;
  memoryId: number;
  entityType: string;
  entityId: string;
  createdAt: string;
}

const entityTypeConfig: Record<string, { icon: typeof Users; label: string }> = {
  person: { icon: Users, label: "Person" },
  project: { icon: FolderKanban, label: "Project" },
  strategy: { icon: Target, label: "Strategy" },
};

function EntityLinksSection({ entryId }: { entryId: number }) {
  const { toast } = useToast();
  const { data: links, isLoading } = useQuery<MemoryEntityLink[]>({
    queryKey: ["/api/memory/entries", entryId, "entity-links"],
    queryFn: async () => {
      const res = await fetch(`/api/memory/entries/${entryId}/entity-links`);
      if (!res.ok) throw new Error("Failed to fetch entity links");
      return res.json();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (link: MemoryEntityLink) => {
      await apiRequest("DELETE", `/api/memory/entity-links/${link.memoryId}/${link.entityType}/${link.entityId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memory/entries", entryId, "entity-links"] });
      toast({ title: "Link removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to unlink", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) return <Skeleton className="h-8 w-full" />;
  if (!links || links.length === 0) return null;

  return (
    <div data-testid={`entity-links-section-${entryId}`}>
      <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
        <Link2 className="h-3 w-3" />
        Entity Links ({links.length})
      </p>
      <div className="space-y-1">
        {links.map((link) => {
          const config = entityTypeConfig[link.entityType] || { icon: Link2, label: link.entityType };
          const Icon = config.icon;
          return (
            <div
              key={link.id}
              className={cn("flex items-center gap-2 px-3 py-2", MEMORY_LIST_ROW_CLASS, "border-card-border bg-card")}
              data-testid={`entity-link-${link.id}`}
            >
              <Icon className="h-3 w-3 text-muted-foreground/70 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate text-foreground/80">{link.entityId}</p>
                <p className="text-xs text-muted-foreground">{config.label}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => unlinkMutation.mutate(link)}
                disabled={unlinkMutation.isPending}
                data-testid={`button-unlink-${link.id}`}
              >
                <Unlink className="h-3 w-3 text-muted-foreground" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QueryTab() {
  const { toast } = useToast();
  const { timezone } = useTimezone();
  const [searchQuery, setSearchQuery] = useState("");
  const [claimTypeFilter, setClaimTypeFilter] = useState<string>("all");
  const [selectedResult, setSelectedResult] = useState<VnextSearchResult | null>(null);

  const searchMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { query: searchQuery, limit: 20 };
      if (claimTypeFilter !== "all") body.claimType = claimTypeFilter;
      const res = await apiRequest("POST", "/api/memory/search", body);
      return await res.json() as VnextSearchResponse;
    },
    onError: (err: Error) => {
      log.error("vNext search failed:", err);
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim()) return;
    setSelectedResult(null);
    searchMutation.mutate();
  }, [searchQuery, searchMutation]);
  const results = searchMutation.data?.results;

  return (
    <div className={cn("flex flex-col", MEMORY_SHELL_CLASS)} data-testid="query-tab">
      <div className={cn("space-y-3", MEMORY_PANEL_HEADER_CLASS)}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") handleSearch(); }} placeholder="Search vNext memories..." className="pl-8" data-testid="input-search-query" />
          </div>
          <Button onClick={handleSearch} disabled={searchMutation.isPending || !searchQuery.trim()} data-testid="button-search">
            {searchMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1.5" />}
            Search
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Claim type</Label>
          <Select value={claimTypeFilter} onValueChange={setClaimTypeFilter}>
            <SelectTrigger className="w-28" data-testid="select-claim-type-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="state">State</SelectItem>
              <SelectItem value="cause">Cause</SelectItem>
              <SelectItem value="action">Action</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className={cn(selectedResult ? "hidden @md:flex" : "flex", "@md:w-80 w-full shrink-0 border-r overflow-y-auto scrollbar-thin flex-col", MEMORY_PANEL_CLASS)} data-testid="query-list-panel">
          {!results && !searchMutation.isPending && <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="query-empty">Search active vNext claims by meaning, title, content, or topic.</div>}
          {searchMutation.isPending && <div className="space-y-1 p-2">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-12 w-full rounded-md" />)}</div>}
          {results && results.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="query-no-results">No matching vNext claims.</div>}
          {results && results.length > 0 && (
            <div className="space-y-px p-1" data-testid="query-results">
              {results.map((result) => {
                const isSelected = selectedResult?.id === result.id;
                return (
                  <button type="button" key={result.id} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left", MEMORY_LIST_ROW_CLASS, isSelected && MEMORY_SELECTED_ROW_CLASS)} onClick={() => setSelectedResult(isSelected ? null : result)} data-testid={`result-row-${result.id}`}>
                    <VnextClaimTypeIcon claimType={result.claimType} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm truncate text-foreground/90 flex-1 min-w-0" data-testid={`result-title-${result.id}`}>{result.title || firstLine(result.content)}</p>
                        <span className="text-xs text-muted-foreground/60 shrink-0 ml-auto" data-testid={`result-time-${result.id}`}>{result.createdAt ? relativeTime(result.createdAt) : ""}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 overflow-hidden">
                        <span className="text-xs text-muted-foreground/70 font-mono shrink-0" data-testid={`result-score-${result.id}`}>{(result.score * 100).toFixed(0)}%</span>
                        <Badge variant="outline" className="text-xs px-1 py-0 shrink-0">{lifecycleLabel(result.lifecycleStage)}</Badge>
                        {(result.topics ?? []).slice(0, 2).map((topic) => <Badge key={topic} variant="outline" className="text-xs px-1 py-0 shrink-0">{topic}</Badge>)}
                      </div>
                    </div>
                    <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className={cn(selectedResult ? "flex" : "hidden @md:flex", "flex-1 flex-col overflow-hidden min-w-0", MEMORY_PANEL_CLASS)} data-testid="query-detail-panel">
          {selectedResult ? (
            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
              <div className="flex items-center gap-2 min-w-0">
                <Button variant="ghost" size="icon" className="@md:hidden shrink-0 -ml-1" onClick={() => setSelectedResult(null)} data-testid="button-back-query-detail"><ChevronLeft className="h-4 w-4" /></Button>
                <VnextClaimTypeIcon claimType={selectedResult.claimType} />
                <h3 className="text-base font-semibold text-foreground truncate" data-testid="query-detail-title">{selectedResult.title || firstLine(selectedResult.content)}</h3>
                <Button variant="ghost" size="icon" onClick={() => setSelectedResult(null)} className="hidden @md:inline-flex ml-auto" data-testid="button-close-query-detail"><X className="h-3.5 w-3.5" /></Button>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                <Badge variant="outline">{lifecycleLabel(selectedResult.lifecycleStage)}</Badge>
                <Badge variant="outline">{claimTypeLabel(selectedResult.claimType)}</Badge>
                <span>{Math.round(selectedResult.confidence * 100)}% confidence</span>
                <span className="flex items-center gap-1"><Clock className="h-2.5 w-2.5" />{selectedResult.createdAt ? new Date(selectedResult.createdAt).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "Unknown"}</span>
                <span className="flex items-center gap-1"><Hash className="h-2.5 w-2.5" />{selectedResult.id}</span>
                <span className="font-mono">score {(selectedResult.score * 100).toFixed(1)}%</span>
                <span>{selectedResult.linkCount} links</span>
                <span>{selectedResult.recallCount ?? 0} recalls</span>
              </div>
              {(selectedResult.topics ?? []).length > 0 && <div className="flex items-center gap-1.5 flex-wrap">{selectedResult.topics!.map((topic) => <Badge key={topic} variant="outline" className="text-xs">{topic}</Badge>)}</div>}
              <div><p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1"><FileText className="h-3 w-3" />Claim</p><SimpleTextFrame content={selectedResult.content} /></div>
              <VnextSourceRefsSection claimId={selectedResult.id} />
              {selectedResult.metadata && Object.keys(selectedResult.metadata).length > 0 && <div><p className="text-xs font-medium text-muted-foreground mb-1.5">Metadata</p><pre className="text-xs font-mono whitespace-pre-wrap text-foreground/70 bg-muted/20 border border-card-border rounded-md p-3" data-testid="query-detail-metadata">{JSON.stringify(selectedResult.metadata, null, 2)}</pre></div>}
            </div>
          ) : <div className="flex-1 px-2 py-1.5 text-sm text-muted-foreground" data-testid="query-no-selection">Select a vNext claim to view details.</div>}
        </div>
      </div>
    </div>
  );
}

export default function MemoryPageFull() {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const rawInitialTab = urlParams.get("tab") || "memories";
  const initialTab = rawInitialTab === "query" ? "extraction" : rawInitialTab === "working" || rawInitialTab === "layers" ? "memories" : rawInitialTab === "log" || rawInitialTab === "tags" ? "maintenance" : rawInitialTab;
  const initialEntryId = urlParams.get("entryId") ? parseInt(urlParams.get("entryId")!, 10) : null;
  const [activeTab, setActiveTab] = useState(initialTab);
  const [graphFullscreenOpen, setGraphFullscreenOpen] = useState(false);

  usePageHeader({
    title: activeTab === "memories" ? "Layers" : activeTab === "graph" ? "Memory Graph" : activeTab === "maintenance" ? "Journal" : "Memory",
    tabs: memoryTabs,
    activeTab,
    onTabChange: setActiveTab,
  });

  return (
    <div className={cn("flex flex-col min-w-0", MEMORY_SHELL_CLASS)} data-testid="memory-page-full">


      <Dialog open={graphFullscreenOpen} onOpenChange={setGraphFullscreenOpen}>
        <DialogContent className="h-screen max-h-screen w-screen max-w-none gap-0 overflow-hidden border-0 p-0 sm:rounded-none">
          <DialogHeader className="sr-only">
            <DialogTitle>Memory Graph full screen</DialogTitle>
          </DialogHeader>
          <GraphTab inFullscreenModal />
        </DialogContent>
      </Dialog>

      {activeTab === "memories" && <LayersTab />}
      {activeTab === "sources" && <LogTab initialEntryId={initialEntryId} />}
      {activeTab === "extraction" && <QueryTab />}
      {activeTab === "graph" && <GraphTab onOpenFullscreen={() => setGraphFullscreenOpen(true)} />}
      {activeTab === "maintenance" && <VnextJournalTab />}
    </div>
  );
}
