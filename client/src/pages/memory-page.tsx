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
import { Checkbox } from "@/components/ui/checkbox";
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
  ListFilter,
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
import {
  getAvailableMemoryGraphNodeTypes,
  MemorySourceIcon,
} from "@/components/memory/memory-source-icon";

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
  recency?: number;
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
  activeTouchedAt?: string | null;
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

type LayersStorageMode = "vnext";

interface MemoryStats {
  short: number;
  mid: number;
  long: number;
  total: number;
}

type GraphStorageMode = "vnext";

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

type LogGranularity = "day" | "week" | "month" | "year";

interface DateRange {
  start: Date;
  end: Date;
  startIso: string;
  endIso: string;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getConfiguredTimezone(timezone: string | null | undefined) {
  return timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
}

function getZonedDateParts(value: string | Date, timezone: string): ZonedDateParts {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: getConfiguredTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const getPart = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const hour = getPart("hour");
  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: hour === 24 ? 0 : hour,
    minute: getPart("minute"),
    second: getPart("second"),
  };
}

function civilDayIndex(parts: Pick<ZonedDateParts, "year" | "month" | "day">) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function zonedMidnightToUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = { year, month, day, hour: 0, minute: 0, second: 0 };
  let timestamp = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedDateParts(new Date(timestamp), timezone);
    const dayDelta = civilDayIndex(target) - civilDayIndex(actual);
    const millisDelta =
      dayDelta * 86_400_000 +
      (target.hour - actual.hour) * 3_600_000 +
      (target.minute - actual.minute) * 60_000 +
      (target.second - actual.second) * 1_000;

    if (millisDelta === 0) return new Date(timestamp);
    timestamp += millisDelta;
  }

  return new Date(timestamp);
}

function addCivilPeriod(parts: Pick<ZonedDateParts, "year" | "month" | "day">, granularity: LogGranularity, delta: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  switch (granularity) {
    case "day":
      date.setUTCDate(date.getUTCDate() + delta);
      break;
    case "week":
      date.setUTCDate(date.getUTCDate() + delta * 7);
      break;
    case "month":
      date.setUTCMonth(date.getUTCMonth() + delta);
      break;
    case "year":
      date.setUTCFullYear(date.getUTCFullYear() + delta);
      break;
  }
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function getWeekStart(parts: Pick<ZonedDateParts, "year" | "month" | "day">) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function getDateRange(date: Date, granularity: LogGranularity, timezone: string): DateRange {
  const tz = getConfiguredTimezone(timezone);
  const parts = getZonedDateParts(date, tz);
  let startParts: Pick<ZonedDateParts, "year" | "month" | "day">;
  let endParts: Pick<ZonedDateParts, "year" | "month" | "day">;

  switch (granularity) {
    case "day":
      startParts = { year: parts.year, month: parts.month, day: parts.day };
      endParts = addCivilPeriod(startParts, "day", 1);
      break;
    case "week":
      startParts = getWeekStart(parts);
      endParts = addCivilPeriod(startParts, "week", 1);
      break;
    case "month":
      startParts = { year: parts.year, month: parts.month, day: 1 };
      endParts = addCivilPeriod(startParts, "month", 1);
      break;
    case "year":
      startParts = { year: parts.year, month: 1, day: 1 };
      endParts = addCivilPeriod(startParts, "year", 1);
      break;
  }

  const start = zonedMidnightToUtc(startParts.year, startParts.month, startParts.day, tz);
  const end = zonedMidnightToUtc(endParts.year, endParts.month, endParts.day, tz);
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
}

function eventDateKeyInTz(value: string | Date, timezone: string) {
  const parts = getZonedDateParts(value, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function eventTimeInTz(value: string | Date, timezone: string) {
  return new Date(value).toLocaleTimeString("en-US", { timeZone: getConfiguredTimezone(timezone), hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDayHeader(dayKey: string, timezone: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return zonedMidnightToUtc(year, month, day, timezone).toLocaleDateString("en-US", {
    timeZone: getConfiguredTimezone(timezone),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function navigateDate(date: Date, granularity: LogGranularity, delta: number, timezone: string): Date {
  const tz = getConfiguredTimezone(timezone);
  const rangeStartParts = getZonedDateParts(getDateRange(date, granularity, tz).start, tz);
  const next = addCivilPeriod(
    { year: rangeStartParts.year, month: rangeStartParts.month, day: rangeStartParts.day },
    granularity,
    delta,
  );
  return zonedMidnightToUtc(next.year, next.month, next.day, tz);
}

function formatPeriodLabel(date: Date, granularity: LogGranularity, timezone: string) {
  const tz = getConfiguredTimezone(timezone);
  const range = getDateRange(date, granularity, tz);
  const compactDate = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" });
  const compactDateWithYear = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });

  switch (granularity) {
    case "day":
      return range.start.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
    case "week": {
      const endInclusive = new Date(range.end.getTime() - 1);
      const startYear = getZonedDateParts(range.start, tz).year;
      const endYear = getZonedDateParts(endInclusive, tz).year;
      const startLabel = startYear === endYear ? compactDate.format(range.start) : compactDateWithYear.format(range.start);
      return `${startLabel}–${compactDateWithYear.format(endInclusive)}`;
    }
    case "month":
      return range.start.toLocaleDateString("en-US", { timeZone: tz, month: "long", year: "numeric" });
    case "year":
      return String(getZonedDateParts(range.start, tz).year);
  }
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
          <VnextSourceRefsSection claimId={entry.id} />
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

  const { startIso, endIso } = useMemo(() => getDateRange(currentDate, granularity, timezone), [currentDate, granularity, timezone]);

  const { data: claims = [], isLoading } = useQuery<VnextClaim[]>({
    queryKey: ["/api/memory/vnext/claims", "journal", startIso, endIso],
    queryFn: async () => {
      const pageSize = 100;
      const collected: VnextClaim[] = [];
      let offset = 0;

      while (true) {
        const params = new URLSearchParams({
          createdAfter: startIso,
          createdBefore: endIso,
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
        className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background md:w-1/3 md:min-w-80 md:shrink-0 md:border-r md:border-border"
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
              onClick={() => setCurrentDate(navigateDate(currentDate, granularity, -1, timezone))}
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
              onClick={() => setCurrentDate(navigateDate(currentDate, granularity, 1, timezone))}
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
                              <div key={claim.id} className="min-w-0">
                                <div className="flex min-w-0 items-stretch">
                                  <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
                                    <div className={cn("absolute left-1/2 top-0 -translate-x-px border-l border-border", isLast && !isSelected ? "bottom-1/2" : "bottom-0")} />
                                    <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
                                  </div>
                                  <button
                                    type="button"
                                    className={cn(
                                      WORKING_TREE_ROW_CLASS,
                                      isSelected ? WORKING_TREE_SELECTED_CLASS : WORKING_TREE_IDLE_CLASS,
                                    )}
                                    onClick={() => setSelectedClaimId(isSelected ? null : claim.id)}
                                    aria-expanded={isSelected}
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
                                {isSelected && (
                                  <div className="ml-6 mr-2 border-l border-border/40 pl-2 py-2 space-y-3" data-testid={`log-claim-expanded-${claim.id}`}>
                                    {selectedClaim ? (
                                      <>
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
                                      </>
                                    ) : selectedClaimLoading ? (
                                      <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading memory…</div>
                                    ) : (
                                      <div className="px-2 py-1.5 text-sm text-muted-foreground">Memory not found.</div>
                                    )}
                                  </div>
                                )}
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
    </div>
  );
}


const entityTypeConfig: Record<string, { icon: typeof Users; label: string }> = {
  person: { icon: Users, label: "Person" },
  project: { icon: FolderKanban, label: "Project" },
  goal: { icon: Target, label: "Goal" },
  strategy: { icon: Target, label: "Strategy" },
};

function VnextEntityLinksSection({ claimId }: { claimId: number }) {
  const { data, isLoading } = useQuery<{ entityLinks: VnextEntityLink[]; total: number }>({
    queryKey: ["/api/memory/vnext/claims", claimId, "entity-links"],
    queryFn: async () => {
      const res = await fetch(`/api/memory/vnext/claims/${claimId}/entity-links`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch vNext entity links");
      return res.json();
    },
  });

  if (isLoading) return <Skeleton className="h-8 w-full" />;
  const links = data?.entityLinks ?? [];
  if (links.length === 0) return null;

  return (
    <div data-testid={`vnext-entity-links-section-${claimId}`}>
      <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
        <Link2 className="h-3 w-3" />
        Entity Links ({links.length})
      </p>
      <div className="space-y-1">
        {links.map((link) => {
          const config = entityTypeConfig[link.entityType] || { icon: Link2, label: link.entityType };
          const Icon = config.icon;
          return (
            <div key={link.id} className={cn("flex items-center gap-2 px-3 py-2", MEMORY_LIST_ROW_CLASS, "border-card-border bg-card")} data-testid={`vnext-entity-link-${link.id}`}>
              <Icon className="h-3 w-3 text-muted-foreground/70 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate text-foreground/80">{link.entityId}</p>
                <p className="text-xs text-muted-foreground">{config.label}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GraphTab({
  inFullscreenModal = false,
  onOpenFullscreen,
}: {
  inFullscreenModal?: boolean;
  onOpenFullscreen?: () => void;
} = {}) {
  const { timezone } = useTimezone();
  const isMobile = useIsMobile();
  const graphRef = useRef<MemoryGraph3DHandle>(null);
  const [selectedNode, setSelectedNode] = useState<MemoryEntry | null>(null);
  const [selectedLabelTypes, setSelectedLabelTypes] = useState<Set<string>>(() => new Set(["people"]));
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  useFocusContext(
    selectedNode
      ? { entity: { type: "memory", id: String(selectedNode.id), label: selectedNode.title || undefined } }
      : null,
  );

  const { data: graph, isLoading, isError } = useQuery<PalaceData>({
    queryKey: ["/api/memory/vnext/graph"],
    queryFn: async () => {
      const response = await fetch("/api/memory/vnext/graph", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load the vNext memory graph");
      return response.json();
    },
  });

  const entryMap = useMemo(
    () => new Map((graph?.entries ?? []).map((entry) => [entry.id, entry])),
    [graph?.entries],
  );

  const graphNodes = useMemo<MemoryGraph3DNode[]>(() => {
    const degree = new Map<number, number>();
    for (const link of graph?.links ?? []) {
      degree.set(link.fromId, (degree.get(link.fromId) ?? 0) + 1);
      degree.set(link.toId, (degree.get(link.toId) ?? 0) + 1);
    }
    return (graph?.entries ?? []).map((entry) => {
      const visual = getGraphNodeVisual(entry);
      return {
        id: entry.id,
        source: visual.source,
        label: entry.title?.trim() || entry.oneLiner?.trim() || firstLine(entry.content, 72) || visual.label,
        degree: degree.get(entry.id) ?? 0,
        recency: typeof entry.recency === "number" ? entry.recency : 0,
        pendingDeletion: false,
      };
    });
  }, [graph]);

  const graphLinks = useMemo<MemoryGraph3DLink[]>(
    () => (graph?.links ?? []).map((link) => ({ ...link })),
    [graph?.links],
  );

  const availableLabelTypes = useMemo(
    () => getAvailableMemoryGraphNodeTypes(graphNodes.map((node) => node.source)),
    [graphNodes],
  );

  const toggleLabelType = useCallback((typeId: string) => {
    setSelectedLabelTypes((current) => {
      const next = new Set(current);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  }, []);

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

  if (isLoading) {
    return <div className="p-4"><Skeleton className="h-[400px] w-full" /></div>;
  }

  if (isError) {
    return <div className="px-2 py-1.5 text-sm text-error" data-testid="memory-graph-error">The vNext memory graph could not be loaded.</div>;
  }

  if (!graph?.entries?.length) {
    return <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="memory-graph-empty">No linked vNext claims yet.</div>;
  }

  const selectedMetadata = (selectedNode?.metadata ?? {}) as Record<string, unknown>;
  const selectedIsClaim = selectedMetadata.nodeKind === "claim" || !selectedMetadata.nodeKind;

  return (
    <div className={cn("flex flex-col", MEMORY_SHELL_CLASS)} data-testid="memory-graph-tab">
      <div className="relative flex flex-1 overflow-hidden min-h-0">
        <div className="flex-1 relative overflow-hidden bg-background">
          <MemoryGraph3D
            ref={graphRef}
            nodes={graphNodes}
            links={graphLinks}
            selectedNodeId={selectedNode?.id ?? null}
            selectedLabelTypes={selectedLabelTypes}
            onNodeSelect={handleNodeSelect}
            onNodeHover={handleNodeHover}
          />

          {hoveredNodeId !== null && (() => {
            const entry = entryMap.get(hoveredNodeId);
            if (!entry) return null;
            const visual = getGraphNodeVisual(entry);
            const HoverIcon = visual.Icon;
            return (
              <div
                className="absolute z-50 max-w-xs rounded-md border border-card-border bg-popover p-3 shadow-md"
                style={{ left: tooltipPos.x, top: tooltipPos.y, transform: "translateY(-50%)" }}
                data-testid={`memory-graph-tooltip-${hoveredNodeId}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-popover-foreground leading-tight">
                  <HoverIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.title || firstLine(entry.content)}</span>
                </div>
                {entry.content && <p className="mt-2 text-xs text-popover-foreground/80 line-clamp-4">{entry.content}</p>}
              </div>
            );
          })()}

          <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1" data-testid="memory-graph-controls">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Choose persistent graph labels"
                  title="Choose labels"
                  data-testid="button-graph-label-filter"
                  className={selectedLabelTypes.size > 0 ? "border-foreground/30 bg-card/90" : "bg-card/80"}
                >
                  <ListFilter className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="end"
                sideOffset={8}
                className="w-48 border-card-border bg-popover p-1.5"
                data-testid="memory-graph-label-filter"
              >
                <div className="space-y-0.5" role="group" aria-label="Persistent graph labels">
                  {availableLabelTypes.map((type) => {
                    const selected = selectedLabelTypes.has(type.id);
                    return (
                      <label
                        key={type.id}
                        className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-popover-foreground transition-colors hover:bg-accent"
                        data-testid={`memory-graph-label-option-${type.id}`}
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleLabelType(type.id)}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Show ${type.label} labels`}
                        />
                        <MemorySourceIcon source={type.iconSource} className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1">{type.label}</span>
                      </label>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
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
          <div className={cn("absolute inset-x-2 bottom-2 z-20 max-h-[55%] overflow-y-auto scrollbar-thin border p-4 space-y-4 md:inset-y-2 md:left-auto md:right-2 md:w-80 md:max-h-none", MEMORY_PANEL_CLASS)} data-testid="memory-graph-detail">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <SourceIcon source={selectedNode.source} className="h-4 w-4 text-muted-foreground shrink-0" />
                <h3 className="text-base font-semibold text-foreground truncate">{getDisplayTitle(selectedNode, 80)}</h3>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedNode(null)} aria-label="Close graph detail" data-testid="button-close-graph-detail">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
              {selectedMetadata.lifecycleStage && <Badge variant="outline">{lifecycleLabel(String(selectedMetadata.lifecycleStage))}</Badge>}
              {selectedMetadata.claimType && <Badge variant="outline">{claimTypeLabel(String(selectedMetadata.claimType))}</Badge>}
              {selectedNode.createdAt && <span>{new Date(selectedNode.createdAt).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</span>}
              <span>~{formatTokens(estimateTokens(selectedNode.content))} tok</span>
            </div>

            <SimpleTextFrame content={selectedNode.content} />
            {selectedIsClaim && <VnextSourceRefsSection claimId={selectedNode.id} />}
            {selectedIsClaim && <VnextEntityLinksSection claimId={selectedNode.id} />}
          </div>
        )}
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

function LayersTab() {
  const { timezone } = useTimezone();
  const [openStages, setOpenStages] = useState<Set<string>>(() => new Set(MEMORY_VNEXT_PIPELINE_STAGES.map(stage => stage.value)));
  const [expandedClaimIds, setExpandedClaimIds] = useState<Set<number>>(new Set());
  const { status: graphMyelinationStatus } = useGraphMyelinationStatus();
  const [layersSearchQuery, setLayersSearchQuery] = useState("");

  const { events } = useEventStream();
  const lastSeenEventRef = useRef<string | null>(null);

  const { data: vnextCounts, isLoading: vnextCountsLoading } = useQuery<VnextClaimCounts>({ queryKey: ["/api/memory/vnext/claims/counts"] });
  const { data: vnextClaimsResponse, isLoading: vnextClaimsLoading } = useQuery<VnextClaimsResponse>({ queryKey: ["/api/memory/vnext/claims", "layers", 100], queryFn: async () => { const res = await fetch("/api/memory/vnext/claims?limit=100", { credentials: "include" }); if (!res.ok) throw new Error("Failed to load vNext claims"); return res.json(); } });
  const { data: vnextSourcesResponse, isLoading: vnextSourcesLoading } = useQuery<VnextSourcesResponse>({ queryKey: ["/api/memory/vnext/sources", "layers", 100], queryFn: async () => { const res = await fetch("/api/memory/vnext/sources?limit=100", { credentials: "include" }); if (!res.ok) throw new Error("Failed to load vNext sources"); return res.json(); } });

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    if (latest.id === lastSeenEventRef.current) return;
    if (latest.event === "entries_changed") {
      lastSeenEventRef.current = latest.id;
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/claims/counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/sources"] });
    }
  }, [events]);

  const vnextClaims = vnextClaimsResponse?.claims ?? [];
  const vnextSources = vnextSourcesResponse?.sources ?? [];
  const isLoading = vnextClaimsLoading || vnextSourcesLoading || vnextCountsLoading;

  const queryTokens = layersSearchQuery.toLowerCase().split(/\s+/).filter(Boolean);

  const filteredClaims = useMemo(() => {
    if (queryTokens.length === 0) return vnextClaims;
    return vnextClaims.filter(claim => {
      const searchable = [claim.title, claim.content, claim.claimType, claim.lifecycleStage, ...(claim.topics ?? [])].filter(Boolean).join(" ").toLowerCase();
      return queryTokens.every(token => searchable.includes(token));
    });
  }, [vnextClaims, queryTokens]);

  const filteredSources = useMemo(() => {
    if (queryTokens.length === 0) return vnextSources;
    return vnextSources.filter(src => {
      const searchable = [src.title, src.content, src.sourceType].filter(Boolean).join(" ").toLowerCase();
      return queryTokens.every(token => searchable.includes(token));
    });
  }, [vnextSources, queryTokens]);

  const toggleStage = (stage: string) => {
    setOpenStages(prev => { const next = new Set(prev); if (next.has(stage)) next.delete(stage); else next.add(stage); return next; });
  };

  return (
    <div className={cn("flex flex-col", MEMORY_SHELL_CLASS)} data-testid="layers-tab">
      <GraphMyelinationProgressBar status={graphMyelinationStatus} />

      <div className={cn("flex items-center gap-2", MEMORY_PANEL_HEADER_CLASS)}>
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={layersSearchQuery} onChange={(e) => setLayersSearchQuery(e.target.value)} placeholder="Filter memories..." className="pl-8" data-testid="input-layers-search" />
        </div>
        {vnextCounts && (
          <span className="text-xs text-muted-foreground shrink-0">
            {vnextCounts.total} claims
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1" data-testid="layers-pipeline">
        {isLoading && <div className="space-y-1 p-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}</div>}

        {!isLoading && MEMORY_VNEXT_PIPELINE_STAGES.map(stage => {
          const isSource = stage.value === "source_refs";
          const items = isSource ? filteredSources : filteredClaims.filter(c => c.lifecycleStage === stage.value);
          const count = isSource
            ? (vnextCounts as Record<string, unknown>)?.sourceCount ?? items.length
            : (vnextCounts?.stages as Record<string, number> | undefined)?.[stage.value] ?? items.length;
          const isOpen = openStages.has(stage.value);
          return (
            <Collapsible key={stage.value} open={isOpen} onOpenChange={() => toggleStage(stage.value)}>
              <CollapsibleTrigger className={WORKING_SECTION_TRIGGER_CLASS} data-testid={`stage-trigger-${stage.value}`}>
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>{stage.label}</span>
                <Badge variant="outline" className="ml-auto text-xs">{String(count)}</Badge>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-px pl-4">
                  {items.length === 0 && <p className="text-xs text-muted-foreground py-1">No items</p>}
                  {isSource
                    ? (items as typeof vnextSources).map(src => (
                        <div key={src.id} className={cn(WORKING_TREE_ROW_CLASS, WORKING_TREE_IDLE_CLASS)} data-testid={`source-row-${src.id}`}>
                          <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs">{src.title || src.content?.slice(0, 60) || `Source #${src.id}`}</span>
                          <span className="ml-auto text-xs text-muted-foreground/50 shrink-0">{src.createdAt ? relativeTime(src.createdAt) : ""}</span>
                        </div>
                      ))
                    : (items as typeof vnextClaims).map(claim => {
                        const expanded = expandedClaimIds.has(claim.id);
                        return (
                          <div key={claim.id}>
                            <VnextClaimRow
                              claim={claim}
                              expanded={expanded}
                              onToggle={() => setExpandedClaimIds(prev => { const next = new Set(prev); if (next.has(claim.id)) next.delete(claim.id); else next.add(claim.id); return next; })}
                              timezone={timezone}
                            />
                          </div>
                        );
                      })
                  }
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}


export default function MemoryPageFull() {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const rawInitialTab = urlParams.get("tab") || "memories";
  const initialTab = rawInitialTab === "query" ? "extraction" : rawInitialTab === "working" || rawInitialTab === "layers" ? "memories" : rawInitialTab === "log" || rawInitialTab === "tags" ? "maintenance" : rawInitialTab;
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
      {activeTab === "extraction" && <QueryTab />}
      {activeTab === "graph" && <GraphTab onOpenFullscreen={() => setGraphFullscreenOpen(true)} />}
      {activeTab === "maintenance" && <VnextJournalTab />}
    </div>
  );
}
