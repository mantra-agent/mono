import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  Container,
  Database,
  LayoutGrid,
  ListChecks,
  Link2,
  Download,
  Eraser,
  PackageCheck,
  Palette,
  ExternalLink,
  FileText,
  Eye,
  FlaskConical,
  GitBranch,
  History,
  Loader2,
  MoreHorizontal,
  MoreVertical,
  MessageSquare,
  Pause,
  Pin,
  Play,
  Power,
  RefreshCw,
  Rocket,
  RotateCcw,
  Smartphone,
  Target,
  Square,
  Sparkles,
  Type,
  Upload,
  User,
  Wifi,
  XCircle,
  Activity,
  Bug,
  Calendar,
  Dumbbell,
  Ruler,
  ShieldCheck,
  OctagonAlert,
  MailOpen,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStatusClasses } from "@/components/nav-dot";
import { MantraLogo } from "@/components/mantra-logo";
import { InlineDatePicker } from "@/components/inline-date-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format-utils";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import { createLogger } from "@/lib/logger";
import { DatabaseDataBrowser } from "@/pages/dev/database-data-browser";
import InternalPromptsTab from "@/pages/internal-prompts";
import VersionTimeline from "./version-timeline";
import { IssuesTab } from "@/components/issues-tab";
import {
  BuildStatusPanel,
  type DevDeploymentSummary as SharedDevDeploymentSummary,
  type DevLogEntry as SharedDevLogEntry,
  type StatusFamily,
  type LogLevel,
  statusFamily,
  statusLabel,
  detailedStatusLabel,
  familyClasses,
  relativeTime,
  commitUrl,
  levelOf,
  levelClasses,
  MAX_LOG_LINES,
} from "@/components/build-status-panel";

export type DevDeploymentSummary = SharedDevDeploymentSummary;
export { BuildStatusPanel };
type DevLogEntry = SharedDevLogEntry;

const dbSyncLogger = createLogger("DbSyncUI");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DevStatusOk {
  configured: true;
  devUrl: string | null;
  projectId: string;
  environmentId: string;
  serviceId: string;
  deployment: DevDeploymentSummary | null;
  statusError: string | null;
  fetchedAt: string;
}

type DevStatus = DevStatusOk;

interface StageAutomationLoginUrl {
  url: string;
  expiresAt: string;
}

interface DevVariable {
  name: string;
  masked: boolean;
}

function StatusBadge({ status }: { status: string | undefined | null }) {
  const family = statusFamily(status);
  const classes = familyClasses[family];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 text-xs font-medium", classes.badge)}
      data-testid="badge-dev-status"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", classes.dot)} />
      {statusLabel(status)}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status hook (polls /api/railway/runtime/status every 15s)
// ─────────────────────────────────────────────────────────────────────────────

function useDevStatus() {
  return useQuery<DevStatus>({
    queryKey: ["/api/railway/runtime/status"],
    queryFn: async () => {
      const res = await fetch("/api/railway/runtime/status", {
        credentials: "include",
      });
      if (res.status === 503) {
        return (await res.json()) as DevStatus;
      }
      if (!res.ok) {
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      }
      return (await res.json()) as DevStatus;
    },
    // Tighten the cadence while a build is in flight so the Preview tab
    // flips back to the iframe within a few seconds of SUCCESS, while
    // staying conservative when the dev instance is steady-state.
    refetchInterval: (query) => {
      const data = query.state.data as DevStatus | undefined;
      if (data && "configured" in data && data.configured) {
        const family = statusFamily(data.deployment?.status);
        if (family === "deploying") return 5_000;
      }
      return 15_000;
    },
    refetchOnWindowFocus: true,
    staleTime: 2_000,
    retry: false,
    // Keep last successful response visible while refetches fail. Critical
    // for the "Railway API unavailable" graceful-degradation path: the
    // iframe and prior status data remain on screen.
    placeholderData: (prev) => prev,
  });
}

/** @deprecated Automation login URL endpoint was deprecated — headless auth now uses DB session injection. */
function useStageAutomationLoginUrl(_path = "/") {
  return { data: undefined as StageAutomationLoginUrl | undefined, isLoading: false, error: null };
}

function refreshDevStatus() {
  queryClient.invalidateQueries({ queryKey: ["/api/railway/runtime/status"] });
  queryClient.invalidateQueries({ queryKey: ["/api/railway/runtime/deployments"] });
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Sync — types, hooks, controls, and progress bar
// ─────────────────────────────────────────────────────────────────────────────

type DbSyncStatus =
  | "idle"
  | "exporting"
  | "uploading"
  | "restarting"
  | "complete"
  | "failed"
  | "cancelled";

type DbSyncMode = "schema" | "data" | "data_plus";

interface DbSyncState {
  status: DbSyncStatus;
  mode: DbSyncMode | null;
  destination: string | null;
  syncId: string | null;
  startedAt: string | null;
  currentTable: string | null;
  currentTableIndex: number;
  totalTables: number;
  tablesCompleted: number;
  rowsExported: number;
  // Sum of count(*) across all exportable tables, captured by the export
  // pre-flight step. 0 when unknown (schema mode, or before pre-flight has
  // landed) — the bar falls back to tablesCompleted/totalTables in that case.
  totalRowsExpected: number;
  elapsedMs: number;
  error: string | null;
  completedAt: string | null;
}

const DB_SYNC_MODE_LABELS: Record<DbSyncMode, string> = {
  schema: "Schema",
  data: "Data",
  data_plus: "Data+",
};

const DB_SYNC_MODE_TOOLTIPS: Record<DbSyncMode, string> = {
  schema: "Structure only, zero rows",
  data: "All data, ~50–100MB (no embeddings)",
  data_plus: "Complete clone, ~850MB+",
};

const DB_SYNC_MODE_DIALOG_BLURBS: Record<DbSyncMode, string> = {
  schema:
    "Structure only — every table is wiped and recreated empty. Boot migrations restore the schema on the dev side.",
  data: "All tables and rows, excluding embedding vectors and the code_embeddings table (~50–100MB).",
  data_plus:
    "Complete clone — every table, every column, every row including embedding vectors (~850MB+).",
};

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function isDbSyncActive(state: DbSyncState | undefined): boolean {
  return (
    state?.status === "exporting" ||
    state?.status === "uploading" ||
    state?.status === "restarting"
  );
}

function isDbSyncTerminal(state: DbSyncState | undefined): boolean {
  return (
    state?.status === "complete" ||
    state?.status === "failed" ||
    state?.status === "cancelled"
  );
}

function useDbSyncStatus() {
  return useQuery<DbSyncState>({
    queryKey: ["/api/db-sync/status"],
    queryFn: async () => {
      const res = await fetch("/api/db-sync/status", {
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      return (await res.json()) as DbSyncState;
    },
    // Poll every 1s during active sync, every 10s otherwise.
    refetchInterval: (query) =>
      isDbSyncActive(query.state.data) ? 1_000 : 10_000,
    refetchOnWindowFocus: true,
    staleTime: 500,
    retry: false,
  });
}

function refreshDbSync() {
  queryClient.invalidateQueries({ queryKey: ["/api/db-sync/status"] });
}

interface DbSyncProgressBarProps {
  state: DbSyncState;
}

function DbSyncProgressBar({ state }: DbSyncProgressBarProps) {
  const { toast } = useToast();
  const destLabel = fallbackDestinationLabel(state.destination);
  const ctx = {
    direction: state.destination
      ? `local-to-${state.destination}`
      : "local-to-unknown",
    mode: state.mode,
    syncId: state.syncId,
  };
  const dismiss = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/db-sync/dismiss", {});
      return res.json();
    },
    onSuccess: () => {
      dbSyncLogger.log("publish dismiss success", ctx);
      refreshDbSync();
    },
    onError: (err: Error) => {
      dbSyncLogger.error("publish dismiss failed", err.message, ctx);
      toast({
        title: "Dismiss failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/db-sync/cancel", {});
      return res.json();
    },
    onSuccess: () => {
      dbSyncLogger.log("publish cancel requested", ctx);
      toast({ title: "Cancellation requested" });
      refreshDbSync();
    },
    onError: (err: Error) => {
      dbSyncLogger.error("publish cancel failed", err.message, ctx);
      toast({
        title: "Cancel failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Prefer row-based progress when the export pre-flight has landed —
  // gives a smooth bar that ticks up every ~1s during long tables instead
  // of jumping in chunks at table boundaries. Falls back to table-based
  // progress when totalRowsExpected is 0 (schema mode, or before the
  // pre-flight count has reported in).
  const total = state.totalTables || 1;
  const completed = state.tablesCompleted;
  const pct =
    state.totalRowsExpected > 0
      ? Math.min(
          100,
          Math.round((state.rowsExported / state.totalRowsExpected) * 100),
        )
      : Math.min(100, Math.round((completed / total) * 100));

  // Phase-tinted styling: amber for active, emerald for complete, red for
  // failed, muted for cancelled. Keeps the bar honest about what happened.
  let toneCls = "border-warning/30 bg-warning/5 text-warning";
  let icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (state.status === "complete") {
    toneCls = "border-success/30 bg-success/5 text-success-foreground";
    icon = <CheckCircle2 className="h-3.5 w-3.5" />;
  } else if (state.status === "failed") {
    toneCls = "border-error/30 bg-error/5 text-error-foreground";
    icon = <AlertTriangle className="h-3.5 w-3.5" />;
  } else if (state.status === "cancelled") {
    toneCls = "border-muted bg-muted/40 text-muted-foreground";
    icon = <AlertTriangle className="h-3.5 w-3.5" />;
  }

  let primaryLine: React.ReactNode = null;
  if (state.status === "exporting") {
    // When pre-flight has landed, prefer "X of Y rows" — much more
    // legible during the long tables (memory_entries, workspace_documents)
    // where the row counter ticks every ~1s but tablesCompleted holds
    // steady. Falls back to "X of Y tables" otherwise.
    const subline =
      state.totalRowsExpected > 0 ? (
        <>
          {state.rowsExported.toLocaleString()} of{" "}
          {state.totalRowsExpected.toLocaleString()} rows · table{" "}
          {Math.min(completed + 1, total)} of {total}
        </>
      ) : (
        <>
          [{completed} of {total} tables]
        </>
      );
    primaryLine = (
      <>
        Exporting local → {destLabel} · table:{" "}
        <span className="font-mono">{state.currentTable ?? "…"}</span>
        {" — "}
        {pct}%
        <span className="ml-2 text-xs opacity-75 tabular-nums">{subline}</span>
      </>
    );
  } else if (state.status === "uploading") {
    primaryLine = (
      <>
        Uploading archive → {destLabel}…
        <span className="ml-2 text-xs opacity-75">
          {state.rowsExported.toLocaleString()} rows in {state.totalTables}{" "}
          tables
        </span>
      </>
    );
  } else if (state.status === "restarting") {
    primaryLine = (
      <>
        Import done — restarting {destLabel} to clear caches…
        <span className="ml-2 text-xs opacity-75">
          {state.rowsExported.toLocaleString()} rows imported
        </span>
      </>
    );
  } else if (state.status === "complete") {
    primaryLine = (
      <>
        Publish to {destLabel} complete — {state.totalTables} tables,{" "}
        {state.rowsExported.toLocaleString()} rows in{" "}
        {formatElapsed(state.elapsedMs)}
        {state.error ? (
          <span className="ml-2 text-xs text-warning dark:text-warning">
            ({state.error})
          </span>
        ) : null}
      </>
    );
  } else if (state.status === "failed") {
    primaryLine = (
      <>
        Sync failed
        {state.currentTable ? (
          <>
            {" "}
            at table: <span className="font-mono">{state.currentTable}</span>
          </>
        ) : null}
        {" — "}
        <span className="text-xs">{state.error ?? "Unknown error"}</span>
      </>
    );
  } else if (state.status === "cancelled") {
    primaryLine = (
      <>
        Sync cancelled — {state.tablesCompleted} of {state.totalTables} tables
        completed
      </>
    );
  }

  const showProgressBar =
    state.status === "exporting" ||
    state.status === "uploading" ||
    state.status === "restarting";
  const dismissable = isDbSyncTerminal(state);

  return (
    <div
      className={cn("border-b px-4 py-2 flex flex-col gap-1.5", toneCls)}
      data-testid="db-sync-progress"
    >
      <div className="flex items-start gap-2 text-sm flex-wrap">
        {icon}
        <span className="flex-1 break-words overflow-hidden min-w-0">
          {primaryLine}
        </span>
        {isDbSyncActive(state) && (
          <span
            className="text-xs opacity-75 tabular-nums"
            data-testid="text-db-sync-elapsed"
          >
            {formatElapsed(state.elapsedMs)} elapsed
          </span>
        )}
        {isDbSyncActive(state) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs text-error-foreground hover:text-error-foreground"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            data-testid="button-db-sync-cancel"
          >
            Cancel
          </Button>
        )}
        {dismissable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending}
            data-testid="button-db-sync-dismiss"
          >
            Dismiss
          </Button>
        )}
      </div>
      {showProgressBar && (
        <Progress
          value={state.status === "uploading" ? 100 : pct}
          className="h-1.5"
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Database tab — unified publish flow.
//
// Phase 1 mental model: source is ALWAYS this instance's local DB. Destination
// is a Platform/Product/Environment-backed Railway hosting binding, with
// legacy dev/prod support kept in the server API for compatibility.
// ─────────────────────────────────────────────────────────────────────────────

type DbSyncDestination = string;

const PROD_CONFIRMATION_PHRASE = "PUBLISH TO PRODUCTION";

interface PlatformEnvironmentOption {
  id: number;
  name: string;
  productName: string;
  platformName: string;
  label: string;
  kind: "development" | "staging" | "production" | "custom";
}

interface PlatformEnvironment {
  id: number;
  name: string;
  productId: number;
}

interface PlatformProductSummary {
  id: number;
  name: string;
  platformId: number;
  environments: PlatformEnvironment[];
}

interface PlatformSummary {
  id: number;
  name: string;
  products: PlatformProductSummary[];
}

function environmentKindFromName(name: string): PlatformEnvironmentOption["kind"] {
  const lower = name.trim().toLowerCase();
  if (["prod", "production", "live"].includes(lower)) return "production";
  if (["dev", "development"].includes(lower)) return "development";
  if (["stage", "staging", "preview"].includes(lower)) return "staging";
  return "custom";
}

function destinationKeyForEnvironment(environmentId: number): DbSyncDestination {
  return `env:${environmentId}`;
}

function destinationEnvironmentId(destination: DbSyncDestination): number | null {
  if (!destination.startsWith("env:")) return null;
  const id = Number.parseInt(destination.slice(4), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function fallbackDestinationLabel(destination: DbSyncDestination | null): string {
  if (!destination) return "destination";
  if (destination === "dev") return "Railway development";
  if (destination === "prod") return "Railway production";
  if (destination.startsWith("env:")) return `Environment ${destination.slice(4)}`;
  return destination;
}

function usePlatformEnvironmentOptions() {
  return useQuery<PlatformEnvironmentOption[]>({
    queryKey: ["/api/platforms", "migration-destinations"],
    queryFn: async () => {
      const res = await fetch("/api/platforms", { credentials: "include" });
      if (!res.ok)
        throw new Error(
          (await res.text()) || `${res.status} ${res.statusText}`,
        );
      const platforms = (await res.json()) as PlatformSummary[];
      return platforms.flatMap((platform) =>
        (platform.products ?? []).flatMap((product) =>
          (product.environments ?? []).map((environment) => ({
            id: environment.id,
            name: environment.name,
            productName: product.name,
            platformName: platform.name,
            label: `${platform.name} / ${product.name} / ${environment.name}`,
            kind: environmentKindFromName(environment.name),
          })),
        ),
      );
    },
    retry: false,
    staleTime: 30_000,
  });
}

interface DbSizeData {
  totalBytes: number;
  tables: Array<{
    name: string;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    rowCount: number;
  }>;
}

// Approximate "what will actually copy" for the mode chosen. Excludes
// embeddings in `data` mode (code_embeddings table entirely + ~6KB per row
// for memory_entries.embedding and workspace_documents.embedding).
function estimateCopyBytes(
  mode: DbSyncMode,
  size: DbSizeData | undefined,
): number {
  if (!size) return 0;
  if (mode === "schema") return 0;
  if (mode === "data_plus") return size.totalBytes;
  let total = size.totalBytes;
  for (const t of size.tables) {
    if (t.name === "code_embeddings") {
      total -= t.totalBytes;
    } else if (
      t.name === "memory_entries" ||
      t.name === "workspace_documents"
    ) {
      total -= 6144 * t.rowCount;
    }
  }
  return Math.max(0, total);
}

// Source size = local DB always. /api/info/db/size already serves the local
// pool's per-table sizes, no destination-aware switching needed.
function useLocalDbSize() {
  return useQuery<DbSizeData>({
    queryKey: ["/api/info/db/size"],
    queryFn: async () => {
      const res = await fetch("/api/info/db/size", { credentials: "include" });
      if (!res.ok)
        throw new Error(
          (await res.text()) || `${res.status} ${res.statusText}`,
        );
      return (await res.json()) as DbSizeData;
    },
    retry: false,
    staleTime: 30_000,
  });
}

type LocalDbKind = "railway-dev" | "railway-prod" | "unknown";

interface LocalDbIdentity {
  kind: LocalDbKind;
  host: string;
  port: string;
  database: string;
  user: string;
  redactedUrl: string;
}

function useLocalDbIdentity() {
  return useQuery<LocalDbIdentity>({
    queryKey: ["/api/db-sync/local-identity"],
    queryFn: async () => {
      const res = await fetch("/api/db-sync/local-identity", {
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          (await res.text()) || `${res.status} ${res.statusText}`,
        );
      return (await res.json()) as LocalDbIdentity;
    },
    retry: false,
    staleTime: 60_000,
  });
}

interface DestinationVerifyResult {
  ok: boolean;
  destination: DbSyncDestination;
  destinationEnvironmentId: number | null;
  destinationLabel: string;
  destinationUrl: string | null;
  environmentKind: "development" | "staging" | "production" | "custom";
  blockers: string[];
  localIdentity: LocalDbIdentity | null;
  destinationIdentity: {
    redactedUrl: string;
    host: string;
    port: string;
    database: string;
  } | null;
  sameDb: boolean;
  confirmationPhrase: string | null;
}

function useDestinationVerify(destination: DbSyncDestination | null) {
  return useQuery<DestinationVerifyResult>({
    queryKey: ["/api/db-sync/verify", destination],
    queryFn: async () => {
      if (!destination) throw new Error("Choose a destination environment");
      const envId = destinationEnvironmentId(destination);
      const params = new URLSearchParams();
      if (envId) params.set("destinationEnvironmentId", String(envId));
      else params.set("destination", destination);
      const res = await fetch(`/api/db-sync/verify?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          (await res.text()) || `${res.status} ${res.statusText}`,
        );
      return (await res.json()) as DestinationVerifyResult;
    },
    enabled: !!destination,
    retry: false,
    refetchOnWindowFocus: true,
    // 30s matches the server-side Railway resolution cache; polling more
    // often would hit the cache anyway. Window-focus refetch covers the
    // "user just toggled a secret" case.
    staleTime: 30_000,
  });
}

function describeLocalKind(kind: LocalDbKind): { label: string; tone: string } {
  switch (kind) {
    case "railway-prod":
      return {
        label: "This DB is wired to: Railway production DB",
        tone: "border-error/30 bg-error/5 dark:border-error/50 dark:bg-error/40 text-error-foreground",
      };
    case "railway-dev":
      return {
        label: "This DB is wired to: Railway development DB",
        tone: "border-warning/30 bg-warning/5 dark:border-warning/50 dark:bg-warning/10 text-warning",
      };
    default:
      return {
        label: "This DB is wired to: Unrecognized DB",
        tone: "border-border bg-muted/30 text-muted-foreground",
      };
  }
}

interface DatabasePanelProps {
  syncState: DbSyncState | undefined;
  isDevRunning: boolean;
  embedded?: boolean;
}

function DatabasePanel({ syncState, isDevRunning, embedded = false }: DatabasePanelProps) {
  const { toast } = useToast();
  const environmentOptionsQuery = usePlatformEnvironmentOptions();
  const environmentOptions = environmentOptionsQuery.data ?? [];
  const defaultEnvironment = useMemo(
    () =>
      environmentOptions.find(
        (option) =>
          option.platformName.toLowerCase() === "mantra" &&
          option.productName.toLowerCase() === "web" &&
          option.kind === "staging",
      ) ?? environmentOptions[0],
    [environmentOptions],
  );
  const [destination, setDestination] = useState<DbSyncDestination | null>(null);
  const [mode, setMode] = useState<DbSyncMode>("data");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const sizeQuery = useLocalDbSize();
  const identityQuery = useLocalDbIdentity();

  useEffect(() => {
    if (!destination && defaultEnvironment) {
      setDestination(destinationKeyForEnvironment(defaultEnvironment.id));
    }
  }, [defaultEnvironment, destination]);

  const selectedEnvironmentId = destination ? destinationEnvironmentId(destination) : null;
  const selectedEnvironment = selectedEnvironmentId
    ? environmentOptions.find((option) => option.id === selectedEnvironmentId) ?? null
    : null;
  const selectedDestinationLabel =
    selectedEnvironment?.label ?? fallbackDestinationLabel(destination);
  const verifyQuery = useDestinationVerify(destination);
  const sourceSize = sizeQuery.data;
  const copyBytes = sourceSize ? estimateCopyBytes(mode, sourceSize) : null;

  const active = isDbSyncActive(syncState);
  const nonIdle = !!syncState && syncState.status !== "idle";
  const lastDestination = syncState?.destination ?? null;
  const verify = verifyQuery.data;
  const blockers = verify?.blockers ?? [];
  const verifyLoading = verifyQuery.isLoading || environmentOptionsQuery.isLoading;
  const hasBlockers = !!verify && blockers.length > 0;
  const destinationReady = !!destination;

  const start = useMutation({
    mutationFn: async () => {
      if (!destination) throw new Error("Choose a destination environment");
      const envId = destinationEnvironmentId(destination);
      const body: {
        mode: DbSyncMode;
        destination?: DbSyncDestination;
        destinationEnvironmentId?: number;
        confirmation?: string;
      } = { mode };
      if (envId) body.destinationEnvironmentId = envId;
      else body.destination = destination;
      if (phraseRequired) {
        // Forward the user-typed phrase rather than a client constant so
        // the server is the source of truth on what's accepted.
        body.confirmation = phrase.trim();
      }
      const res = await apiRequest("POST", "/api/db-sync/start", body);
      return res.json();
    },
    onSuccess: (data) => {
      dbSyncLogger.log("publish start success", {
        destination,
        destinationLabel: data?.destinationLabel ?? selectedDestinationLabel,
        mode,
        syncId: data?.syncId ?? null,
      });
      refreshDbSync();
      setConfirmOpen(false);
      setPhrase("");
      setStartError(null);
    },
    onError: (err: Error) => {
      dbSyncLogger.error("publish start failed", err.message, {
        destination,
        destinationLabel: selectedDestinationLabel,
        mode,
      });
      setStartError(err.message);
    },
  });

  const submitting = start.isPending;
  const phraseRequired = verify?.confirmationPhrase !== null && !!verify?.confirmationPhrase;
  // Use the phrase the server reports for this destination (falls back to
  // the client-side constant) so client/server stay in lockstep if the
  // phrase is ever changed centrally.
  const expectedPhrase = verify?.confirmationPhrase ?? PROD_CONFIRMATION_PHRASE;
  const phraseMatches = !phraseRequired || phrase.trim() === expectedPhrase;
  const destructiveButton = verify?.environmentKind === "production" || destination === "prod";

  const submit = () => {
    if (!phraseMatches || submitting) return;
    setStartError(null);
    start.mutate();
  };

  const initiate = () => {
    if (nonIdle || !destination) return;
    if (destination === "dev" && !isDevRunning) {
      toast({
        title: "Dev instance is not running",
        description: "Start the dev instance before publishing.",
        variant: "destructive",
      });
      return;
    }
    dbSyncLogger.log("publish initiate", {
      destination,
      destinationLabel: selectedDestinationLabel,
      mode,
      sourceTotalBytes: sourceSize?.totalBytes ?? null,
      estimatedCopyBytes: copyBytes,
    });
    setPhrase("");
    setStartError(null);
    setConfirmOpen(true);
  };

  // Identity badge: kind → human label + tone.
  const identity = identityQuery.data;
  const { label: identityLabel, tone: identityTone } = identity
    ? describeLocalKind(identity.kind)
    : {
        label: "Unknown",
        tone: "border-border bg-muted/30 text-muted-foreground",
      };

  return (
    <Card className={cn(embedded && "border-border/30 bg-card/60")} data-testid="card-database-panel">
      <CardHeader className={cn("pb-3", embedded && "px-3 pt-3")}>
        <CardTitle className="text-sm flex items-center gap-2">
          <Database className="h-4 w-4" />
          Publish database
        </CardTitle>
      </CardHeader>
      <CardContent className={cn("space-y-4", embedded && "px-3 pb-3")}>
        {/* Identity badge — what's the local DB actually connected to? */}
        <div
          className={cn(
            "rounded border px-3 py-2 text-xs space-y-0.5",
            identityTone,
          )}
          data-testid="panel-local-identity"
        >
          <div className="font-medium" data-testid="text-local-identity-label">
            {identityQuery.isLoading ? "Detecting local DB…" : identityLabel}
          </div>
          {identity && (
            <div
              className="font-mono opacity-80"
              data-testid="text-local-identity-url"
            >
              {identity.host}:{identity.port}/{identity.database}
            </div>
          )}
          {identityQuery.error && (
            <div
              className="text-error-foreground"
              data-testid="text-local-identity-error"
            >
              {(identityQuery.error as Error).message}
            </div>
          )}
        </div>

        <div className="grid gap-4 @md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Source</Label>
            <div
              className="rounded border border-border bg-muted/30 px-3 py-2 text-sm"
              data-testid="text-publish-source"
            >
              Local database
            </div>
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="db-publish-destination"
              className="text-xs text-muted-foreground"
            >
              Destination
            </Label>
            <Select
              value={destination ?? undefined}
              onValueChange={(v) => setDestination(v)}
              disabled={nonIdle || environmentOptionsQuery.isLoading}
            >
              <SelectTrigger
                id="db-publish-destination"
                data-testid="select-publish-destination"
              >
                <SelectValue placeholder="Choose environment" />
              </SelectTrigger>
              <SelectContent>
                {environmentOptions.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={destinationKeyForEnvironment(option.id)}
                    data-testid={`option-destination-env-${option.id}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {environmentOptionsQuery.error && (
              <p className="text-xs text-error-foreground">
                {(environmentOptionsQuery.error as Error).message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="db-publish-mode"
              className="text-xs text-muted-foreground"
            >
              Mode
            </Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as DbSyncMode)}
              disabled={nonIdle}
            >
              <SelectTrigger
                id="db-publish-mode"
                data-testid="select-publish-mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="schema" data-testid="option-mode-schema">
                  Schema — {DB_SYNC_MODE_TOOLTIPS.schema}
                </SelectItem>
                <SelectItem value="data" data-testid="option-mode-data">
                  Data — {DB_SYNC_MODE_TOOLTIPS.data}
                </SelectItem>
                <SelectItem
                  value="data_plus"
                  data-testid="option-mode-data-plus"
                >
                  Data+ — {DB_SYNC_MODE_TOOLTIPS.data_plus}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div
          className="rounded border border-border bg-muted/30 p-3 text-xs space-y-1"
          data-testid="panel-source-size"
        >
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              Source (local) database size
            </span>
            {sizeQuery.isLoading ? (
              <Skeleton className="h-4 w-20" />
            ) : sizeQuery.error ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-error-foreground"
                onClick={() => sizeQuery.refetch()}
                data-testid="button-retry-source-size"
              >
                Retry
              </Button>
            ) : sourceSize ? (
              <span className="font-mono" data-testid="text-source-size">
                {formatBytes(sourceSize.totalBytes)} ·{" "}
                {sourceSize.tables.length} tables
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Estimated copy</span>
            {sizeQuery.isLoading ? (
              <Skeleton
                className="h-4 w-20"
                data-testid="skeleton-estimated-copy"
              />
            ) : sizeQuery.error ? (
              <span
                className="text-error-foreground text-xs"
                data-testid="text-estimated-copy-error"
              >
                unavailable
              </span>
            ) : (
              <span className="font-mono" data-testid="text-estimated-copy">
                {formatBytes(copyBytes ?? 0)}
              </span>
            )}
          </div>
          {sizeQuery.error && (
            <p
              className="text-error-foreground"
              data-testid="text-source-size-error"
            >
              {(sizeQuery.error as Error).message}
            </p>
          )}
        </div>

        {/* Destination preflight blockers — surfaced inline so the user
            sees missing bindings / unreachable target / same-DB refusal
            BEFORE attempting to publish. */}
        {!nonIdle && hasBlockers && (
          <div
            className="rounded border border-error/30 bg-error/5 dark:border-error/50 dark:bg-error/40 px-3 py-2 text-xs space-y-1 text-error-foreground"
            data-testid="panel-publish-blockers"
          >
            <div className="font-medium">
              Cannot publish to {selectedDestinationLabel}:
            </div>
            <ul className="list-disc pl-5 space-y-0.5">
              {blockers.map((b, i) => (
                <li key={i} data-testid={`text-publish-blocker-${i}`}>
                  {b}
                </li>
              ))}
            </ul>
            <div className="pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => verifyQuery.refetch()}
                data-testid="button-verify-retry"
              >
                Re-check
              </Button>
            </div>
          </div>
        )}
        {!nonIdle && verify?.destinationIdentity && !hasBlockers && (
          <div
            className="rounded border border-border bg-muted/30 px-3 py-2 text-xs space-y-0.5"
            data-testid="panel-destination-identity"
          >
            <div className="text-muted-foreground">Destination DB</div>
            <div
              className="font-mono"
              data-testid="text-destination-identity-url"
            >
              {verify.destinationIdentity.host}:
              {verify.destinationIdentity.port}/
              {verify.destinationIdentity.database}
            </div>
          </div>
        )}

        {active ? (
          <div
            className="flex items-center gap-2 rounded border border-warning/30 bg-warning/5 dark:border-warning/50 dark:bg-warning/10 px-3 py-2 text-xs"
            data-testid="text-sync-in-progress"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
            <span>
              Publish in progress
              {lastDestination ? (
                <>
                  {" "}
                  → <strong>{fallbackDestinationLabel(lastDestination)}</strong>
                </>
              ) : null}
              . Disabled until it finishes.
            </span>
          </div>
        ) : nonIdle ? (
          <div
            className="flex items-center gap-2 rounded border border-border bg-muted/30 px-3 py-2 text-xs"
            data-testid="text-sync-non-idle"
          >
            <span>
              Last publish
              {lastDestination ? (
                <>
                  {" "}
                  → <strong>{fallbackDestinationLabel(lastDestination)}</strong>
                </>
              ) : null}{" "}
              needs to be dismissed from the progress bar below before
              publishing again.
            </span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant={destructiveButton ? "destructive" : "default"}
            onClick={initiate}
            disabled={
              nonIdle ||
              submitting ||
              hasBlockers ||
              verifyLoading ||
              !destinationReady ||
              !!environmentOptionsQuery.error
            }
            data-testid="button-publish-database"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : null}
            Publish to {selectedDestinationLabel}
          </Button>
        </div>

        {syncState && syncState.status !== "idle" && (
          <DbSyncProgressBar state={syncState} />
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Publish local database to {selectedDestinationLabel}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {/* Identity reminder at top of confirm dialog so the user
                    sees what local DB is being copied FROM and which DB it
                    will land IN before they type the phrase. */}
                <div
                  className={cn(
                    "rounded border px-2 py-1.5 text-xs space-y-0.5",
                    identityTone,
                  )}
                  data-testid="dialog-local-identity"
                >
                  <div className="font-medium">Source: {identityLabel}</div>
                  {identity && (
                    <div className="font-mono opacity-80">
                      {identity.redactedUrl}
                    </div>
                  )}
                </div>
                {verify?.destinationIdentity && (
                  <div
                    className="rounded border border-border bg-muted/30 px-2 py-1.5 text-xs space-y-0.5"
                    data-testid="dialog-destination-identity"
                  >
                    <div className="font-medium">
                      Destination: {selectedDestinationLabel}
                    </div>
                    <div className="font-mono opacity-80">
                      {verify.destinationIdentity.redactedUrl}
                    </div>
                  </div>
                )}
                <p>
                  This will <strong>wipe {selectedDestinationLabel}</strong> and
                  copy <strong>{DB_SYNC_MODE_LABELS[mode]}</strong> from the
                  local database. {DB_SYNC_MODE_DIALOG_BLURBS[mode]}
                </p>
                {phraseRequired && (
                  <p className="text-error-foreground">
                    This is destructive. Destination data will be{" "}
                    <strong>permanently overwritten</strong> with what's in the
                    local DB right now. There is no automatic rollback.
                  </p>
                )}
                <p>
                  Estimated copy:{" "}
                  {sizeQuery.isLoading ? (
                    <em>computing…</em>
                  ) : sizeQuery.error ? (
                    <em className="text-error-foreground">unavailable</em>
                  ) : (
                    <strong>{formatBytes(copyBytes ?? 0)}</strong>
                  )}
                  .
                </p>
                {startError && (
                  <p
                    className="text-xs text-error-foreground"
                    data-testid="text-publish-start-error"
                  >
                    {startError}
                  </p>
                )}
                {phraseRequired && (
                  <p className="text-xs text-muted-foreground">
                    Type{" "}
                    <span className="font-mono font-bold">
                      {expectedPhrase}
                    </span>{" "}
                    to confirm.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {phraseRequired && (
            <Input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={expectedPhrase}
              autoFocus
              autoComplete="off"
              disabled={submitting}
              data-testid="input-confirm-phrase"
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                dbSyncLogger.log("publish cancel from dialog", { destination });
                setPhrase("");
                setStartError(null);
              }}
              disabled={submitting}
              data-testid="button-publish-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                submit();
              }}
              disabled={!phraseMatches || submitting}
              className={cn(
                destructiveButton &&
                  "bg-error text-error-foreground hover:bg-error/90",
              )}
              data-testid="button-publish-confirm"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Publishing…
                </>
              ) : (
                <>Publish to {selectedDestinationLabel}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

interface StatusBarProps {
  status: DevStatusOk;
  isFetching: boolean;
  isStale: boolean;
  onRetry: () => void;
  showOpenInTab?: boolean;
}

function DevStatusBar({
  status,
  isFetching,
  isStale,
  onRetry,
  showOpenInTab,
}: StatusBarProps) {
  const { toast } = useToast();
  const { data: automationLogin } = useStageAutomationLoginUrl();
  const dep = status.deployment;
  const family = statusFamily(dep?.status);
  const isRunning = family === "running";
  const isStopped = family === "stopped" || !dep;
  const [stopOpen, setStopOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const action = useMutation({
    mutationFn: async (which: "redeploy" | "restart" | "stop") => {
      setPendingAction(which);
      throw new Error("Open the canonical Platform Environment page to manage this deployment.");
    },
    onSuccess: (_data, which) => {
      toast({ title: `Triggered ${which}` });
      refreshDevStatus();
    },
    onError: (err: Error, which) => {
      toast({
        title: `${which} failed`,
        description: err.message,
        variant: "destructive",
      });
    },
    onSettled: () => setPendingAction(null),
  });

  const hasStatusError = !!status.statusError;
  const showBanner = hasStatusError || isStale;
  const bannerMessage = hasStatusError
    ? "Railway API unavailable — preview still works directly. Showing last known status."
    : "Status data is stale — last update failed.";

  return (
    <div className="border-b bg-background/50">
      {showBanner && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 bg-warning/10 text-warning dark:text-warning text-xs border-b border-warning/20"
          data-testid="banner-status-error"
        >
          <span className="flex-1 truncate">{bannerMessage}</span>
          {status.fetchedAt && (
            <span
              className="text-xs opacity-80"
              data-testid="text-status-stale-since"
            >
              last updated {relativeTime(status.fetchedAt)}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs hover:bg-warning/20"
            onClick={onRetry}
            disabled={isFetching}
            data-testid="button-retry-status"
          >
            {isFetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Retry"
            )}
          </Button>
        </div>
      )}
      <div
        className="flex items-center gap-3 px-4 py-2 min-h-12"
        data-testid="dev-status-bar"
      >
        {isFetching && (
          <Loader2
            className="h-3 w-3 animate-spin text-muted-foreground"
            data-testid="icon-status-fetching"
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          {showOpenInTab && status.devUrl && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              data-testid="link-open-in-tab"
            >
              <a
                href={automationLogin?.url ?? status.devUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Open in new tab
              </a>
            </Button>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => action.mutate("redeploy")}
                disabled={pendingAction !== null}
                data-testid="button-redeploy"
              >
                {pendingAction === "redeploy" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redeploy</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => action.mutate("restart")}
                disabled={pendingAction !== null || isStopped}
                data-testid="button-restart"
              >
                {pendingAction === "restart" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Restart</TooltipContent>
          </Tooltip>

          {isRunning ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-error-foreground hover:text-error-foreground"
                  onClick={() => setStopOpen(true)}
                  disabled={pendingAction !== null}
                  data-testid="button-stop"
                >
                  {pendingAction === "stop" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-success-foreground hover:text-success-foreground"
                  onClick={() => action.mutate("redeploy")}
                  disabled={pendingAction !== null}
                  data-testid="button-start"
                >
                  {pendingAction === "redeploy" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Power className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Start</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <AlertDialog open={stopOpen} onOpenChange={setStopOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop development instance?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the running deployment for the dev environment. The
              instance will become unreachable until you redeploy or start it
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-stop">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setStopOpen(false);
                action.mutate("stop");
              }}
              data-testid="button-confirm-stop"
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview tab
// ─────────────────────────────────────────────────────────────────────────────

function DevPreviewIframe({ status }: { status: DevStatusOk }) {
  const { toast } = useToast();
  const {
    data: automationLogin,
    isLoading: authUrlLoading,
    error: authUrlError,
  } = useStageAutomationLoginUrl();
  const dep = status.deployment;
  // When the Railway API is unreachable we have no deployment data, but the
  // dev URL is independent of the API. Optimistically attempt the iframe.
  const apiUnavailable = !!status.statusError && !dep;
  const family = statusFamily(dep?.status);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const rawUrl = status.devUrl;
  const url = automationLogin?.url ?? rawUrl;

  const startMutation = useMutation({
    mutationFn: async () => {
      throw new Error("Open the canonical Platform Environment page to redeploy this environment.");
    },
    onSuccess: () => {
      toast({ title: "Starting development instance…" });
      refreshDevStatus();
    },
    onError: (err: Error) => {
      toast({
        title: "Start failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Reset iframe state when status transitions to running
  useEffect(() => {
    if (family === "running") {
      setIframeError(false);
      setIframeLoaded(false);
    }
  }, [family]);

  if (!rawUrl) {
    return (
      <OfflinePanel
        title="Environment URL unavailable"
        body="Add the public URL to this environment’s canonical hosting binding in Platforms."
      />
    );
  }

  if (authUrlLoading && !automationLogin) {
    return (
      <OfflinePanel title="Preparing authenticated Stage preview…" spinner />
    );
  }

  // While Railway is mid-build, swap in the dedicated build-status view.
  // Unmounting the iframe here is intentional: holding it during a deploy
  // keeps an open connection to the dying instance and forces a stale page
  // that never refreshes. Re-mounting on success guarantees a clean reload.
  if (family === "deploying" && dep) {
    return (
      <BuildStatusPanel deployment={dep} />
    );
  }

  // Failed deployments: keep the build/deploy log panel visible (with the
  // final lines) so the user can debug, instead of the old "deployment
  // failed" empty card.
  if (family === "failed" && dep) {
    return (
      <BuildStatusPanel deployment={dep} />
    );
  }

  // Only treat the instance as offline if Railway told us so. If the Railway
  // API is unavailable (apiUnavailable), still try to render the iframe — the
  // dev instance itself may be perfectly reachable.
  if (!apiUnavailable && (family === "stopped" || !dep)) {
    return (
      <OfflinePanel
        title="Development instance is offline."
        action={
          <Button
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
            data-testid="button-start-instance"
          >
            {startMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Power className="h-4 w-4 mr-2" />
            )}
            Start
          </Button>
        }
      />
    );
  }

  if (iframeError) {
    return (
      <OfflinePanel
        title="Preview unavailable"
        body="The iframe could not load — likely a CSP or X-Frame-Options block on the dev instance. Open it in a new tab instead."
        action={
          <Button asChild>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              data-testid="link-open-fallback"
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in new tab
            </a>
          </Button>
        }
      />
    );
  }

  // Force a clean re-mount of the iframe on the deploying → running flip by
  // keying it to the current deployment id. This guarantees the dev URL is
  // re-fetched (rather than reusing the in-memory document from before the
  // restart) the moment the new build comes up.
  return (
    <div className="relative flex-1 min-h-0">
      {authUrlError && (
        <div className="absolute top-0 inset-x-0 z-20 px-4 py-2 bg-warning/10 text-warning dark:text-warning text-xs border-b border-warning/20">
          Automation Auth is not available for Stage. Falling back to the raw
          Dev URL.
        </div>
      )}
      {!iframeLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      <iframe
        key={`${dep?.id ?? "no-deployment"}:${url}`}
        src={url}
        title="Dev Mantra Preview"
        className="w-full h-full border-0 bg-background"
        onLoad={() => setIframeLoaded(true)}
        onError={() => setIframeError(true)}
        data-testid="iframe-dev-preview"
      />
    </div>
  );
}

// Build status panel and its log streamer were extracted to
// `@/components/build-status-panel` so they can be reused by the Production
// tab without creating a circular dependency between dev.tsx and
// dev-publish-tab.tsx.

function OfflinePanel({
  title,
  body,
  action,
  spinner,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  spinner?: boolean;
}) {
  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center p-6"
      data-testid="panel-offline"
    >
      <div className="text-center max-w-md space-y-4">
        {spinner && (
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        )}
        <h3 className="text-base font-medium">{title}</h3>
        {body && <p className="text-sm text-muted-foreground">{body}</p>}
        {action}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployments tab
// ─────────────────────────────────────────────────────────────────────────────

function DeploymentsTable({ status }: { status: DevStatusOk }) {
  const { toast } = useToast();
  const [rollbackTarget, setRollbackTarget] =
    useState<DevDeploymentSummary | null>(null);

  const { data, isLoading, error, refetch } = useQuery<{
    deployments: DevDeploymentSummary[];
  }>({
    queryKey: ["/api/railway/runtime/deployments"],
    queryFn: async () => {
      const res = await fetch("/api/railway/runtime/deployments?limit=20", {
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      return res.json();
    },
  });

  const redeploy = useMutation({
    mutationFn: async (deploymentId: string) => {
      throw new Error("Open the canonical Platform Environment page to redeploy this deployment.");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Redeploy triggered" });
      refetch();
      refreshDevStatus();
    },
    onError: (err: Error) => {
      toast({
        title: "Redeploy failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const rollback = useMutation({
    mutationFn: async (deploymentId: string) => {
      throw new Error("Open Railway directly for a human-approved rollback.");
    },
    onSuccess: () => {
      toast({ title: "Rollback triggered" });
      refetch();
      refreshDevStatus();
    },
    onError: (err: Error) => {
      toast({
        title: "Rollback failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const railwayDashboardUrl = `https://railway.com/project/${status.projectId}/service/${status.serviceId}?environmentId=${status.environmentId}`;

  if (isLoading) {
    return (
      <div className="space-y-2 p-4" data-testid="loading-deployments">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center" data-testid="error-deployments">
        <p className="text-sm text-error-foreground">
          {(error as Error).message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          className="mt-3"
        >
          Retry
        </Button>
      </div>
    );
  }

  const deployments = data?.deployments ?? [];

  if (deployments.length === 0) {
    return (
      <div
        className="p-6 text-center text-sm text-muted-foreground"
        data-testid="empty-deployments"
      >
        No deployments yet.
      </div>
    );
  }

  // The most recent SUCCESS or DEPLOYING is the "current"
  const currentId =
    deployments.find((d) => statusFamily(d.status) === "running")?.id ??
    deployments[0]?.id;

  return (
    <div className="space-y-2 p-4" data-testid="table-deployments">
      <div className="flex items-center justify-end gap-2 mb-2">
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
          <a
            href={railwayDashboardUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="link-railway-dashboard"
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Open in Railway
          </a>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => refetch()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {deployments.map((d) => {
        const isCurrent = d.id === currentId;
        const family = statusFamily(d.status);
        const cUrl = commitUrl(d.repo, d.commitHash);
        const dur =
          d.createdAt && d.updatedAt
            ? formatDuration(
                new Date(d.updatedAt).getTime() -
                  new Date(d.createdAt).getTime(),
              )
            : null;

        return (
          <Card
            key={d.id}
            className={cn(
              "border-l-4",
              isCurrent ? familyClasses[family].border : "border-l-transparent",
            )}
            data-testid={`row-deployment-${d.id}`}
          >
            <CardContent className="p-3 flex items-center gap-3">
              <StatusBadge status={d.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  {d.commitHash &&
                    (cUrl ? (
                      <a
                        href={cUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-muted-foreground hover:underline shrink-0"
                      >
                        {d.commitHash.slice(0, 7)}
                      </a>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground shrink-0">
                        {d.commitHash.slice(0, 7)}
                      </span>
                    ))}
                  <span className="truncate">
                    {d.commitMessage || "(no message)"}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {d.branch && (
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-2.5 w-2.5" /> {d.branch}
                    </span>
                  )}
                  <span>{relativeTime(d.createdAt)}</span>
                  {dur && <span>{dur}</span>}
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    data-testid={`button-deployment-menu-${d.id}`}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => redeploy.mutate(d.id)}
                    disabled={redeploy.isPending}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-2" />
                    Redeploy
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setRollbackTarget(d)}
                    disabled={rollback.isPending || isCurrent}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-2" />
                    Roll back to this
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a
                      href={`https://railway.com/project/${status.projectId}/service/${status.serviceId}?environmentId=${status.environmentId}&deployment=${d.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-2" />
                      View on Railway
                    </a>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        );
      })}

      <AlertDialog
        open={!!rollbackTarget}
        onOpenChange={(o) => !o && setRollbackTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back dev instance?</AlertDialogTitle>
            <AlertDialogDescription>
              This rolls the dev environment back to deployment{" "}
              <span className="font-mono">
                {rollbackTarget?.commitHash?.slice(0, 7) ||
                  rollbackTarget?.id.slice(0, 8)}
              </span>
              . The current deployment will be replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rollbackTarget) rollback.mutate(rollbackTarget.id);
                setRollbackTarget(null);
              }}
              data-testid="button-confirm-rollback"
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs tab
// ─────────────────────────────────────────────────────────────────────────────

const LOG_LEVELS = ["all", "debug", "info", "warn", "error"] as const;

type LogEnv = "dev" | "prod";

function DevLogViewer() {
  const [env, setEnv] = useState<LogEnv>("dev");
  const [level, setLevel] = useState<LogLevel>("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState<DevLogEntry[]>([]);
  const [hasNew, setHasNew] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset buffer + transient flags when switching environments so the two
  // streams never interleave.
  useEffect(() => {
    setLogs([]);
    setHasNew(false);
    setNotConfigured(false);
  }, [env]);

  const logsUrl = "/api/railway/runtime/logs";

  const { data, error, isLoading, refetch, isFetching } = useQuery<{
    logs: DevLogEntry[];
  }>({
    queryKey: [logsUrl],
    queryFn: async () => {
      const res = await fetch(`${logsUrl}?limit=200`, {
        credentials: "include",
      });
      if (res.status === 503) {
        setNotConfigured(true);
        return { logs: [] };
      }
      setNotConfigured(false);
      if (!res.ok)
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      return res.json();
    },
    refetchInterval: paused ? false : 5_000,
    refetchOnWindowFocus: false,
  });

  // Merge new logs into ring buffer (dedupe by timestamp+message)
  useEffect(() => {
    if (!data?.logs) return;
    setLogs((prev) => {
      const seen = new Set(prev.map((l) => `${l.timestamp}|${l.message}`));
      const additions = data.logs.filter(
        (l) => !seen.has(`${l.timestamp}|${l.message}`),
      );
      if (additions.length === 0) return prev;
      const merged = [...prev, ...additions];
      const trimmed =
        merged.length > MAX_LOG_LINES ? merged.slice(-MAX_LOG_LINES) : merged;
      if (paused) setHasNew(true);
      return trimmed;
    });
  }, [data, paused]);

  // Auto-scroll
  useEffect(() => {
    if (paused) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, paused]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (level !== "all" && levelOf(l.severity) !== level) return false;
      if (q && !l.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, level, search]);

  const jumpToBottom = useCallback(() => {
    setPaused(false);
    setHasNew(false);
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="log-viewer">
      <div className="flex items-center gap-2 p-2 border-b bg-background">
        <Select value={env} onValueChange={(v) => setEnv(v as LogEnv)}>
          <SelectTrigger
            className="h-7 w-32 text-xs"
            data-testid="select-log-env"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dev">Development</SelectItem>
            <SelectItem value="prod">Production</SelectItem>
          </SelectContent>
        </Select>
        <Select value={level} onValueChange={(v) => setLevel(v as LogLevel)}>
          <SelectTrigger
            className="h-7 w-28 text-xs"
            data-testid="select-log-level"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOG_LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l.charAt(0).toUpperCase() + l.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Search logs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs flex-1"
          data-testid="input-log-search"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => setPaused((p) => !p)}
          data-testid="button-toggle-pause"
        >
          {paused ? (
            <Play className="h-3.5 w-3.5" />
          ) : (
            <Pause className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-logs"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
          />
        </Button>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-auto bg-background font-mono text-xs p-3"
          data-testid="log-output"
        >
          {notConfigured ? (
            <div
              className="text-muted-foreground"
              data-testid="text-logs-not-configured"
            >
              {env === "prod"
                ? "Production environment not configured."
                : "Development environment not configured."}
            </div>
          ) : isLoading && logs.length === 0 ? (
            <div className="text-muted-foreground">Loading logs…</div>
          ) : error ? (
            <div className="text-error">
              Failed to load logs: {(error as Error).message}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-muted-foreground">
              {logs.length === 0
                ? "No logs yet."
                : "No logs match the current filter."}
            </div>
          ) : (
            filtered.map((l, i) => {
              const lvl = levelOf(l.severity);
              return (
                <div
                  key={`${l.timestamp}-${i}`}
                  className="flex gap-3 leading-tight py-0.5"
                >
                  <span
                    title={l.timestamp}
                    className="text-muted-foreground shrink-0 tabular-nums"
                  >
                    {relativeTime(l.timestamp)}
                  </span>
                  <span
                    className={cn(
                      "whitespace-pre-wrap break-words",
                      levelClasses(lvl),
                    )}
                  >
                    {l.message}
                  </span>
                </div>
              );
            })
          )}
        </div>
        {paused && hasNew && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 right-3 rounded-full bg-success text-white text-xs px-3 py-1.5 shadow hover:bg-success/80"
            data-testid="button-new-logs"
          >
            New logs ↓
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Config tab
// ─────────────────────────────────────────────────────────────────────────────

function categorizeVar(name: string): string {
  if (/^DATABASE_|^PG/.test(name)) return "Database";
  if (/^GOOGLE_|^ENCRYPTION_|^SESSION_|^AUTH_|^OAUTH_/.test(name))
    return "Auth";
  if (
    /^ELEVENLABS_|^ANTHROPIC_|^OPENAI_|^CLAUDE_|^BRAVE_|^NOTION_|^TWITTER_|^PLAID_/.test(
      name,
    )
  )
    return "Services";
  if (/^RAILWAY_|^CSP_/.test(name)) return "Railway";
  return "Other";
}

const CATEGORY_ORDER = ["Database", "Auth", "Services", "Railway", "Other"];

function DevConfigView({ status }: { status: DevStatusOk }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<{ variables: DevVariable[] }>({
    queryKey: ["/api/railway/runtime/variables"],
    queryFn: async () => {
      const res = await fetch("/api/railway/runtime/variables", {
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      return res.json();
    },
  });


  const grouped = useMemo(() => {
    const map = new Map<string, DevVariable[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const v of data?.variables ?? []) {
      const cat = categorizeVar(v.name);
      map.get(cat)!.push(v);
    }
    return Array.from(map.entries()).filter(([, v]) => v.length > 0);
  }, [data]);

  const railwayVarsUrl = `https://railway.com/project/${status.projectId}/service/${status.serviceId}/variables?environmentId=${status.environmentId}`;

  if (isLoading) {
    return (
      <section className="space-y-2" data-testid="loading-variables">
        <h2 className="text-base font-semibold">Environment Variables</h2>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-2 text-center" data-testid="error-variables">
        <h2 className="text-base font-semibold text-left">
          Environment Variables
        </h2>
        <p className="text-sm text-error-foreground">
          {(error as Error).message}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="config-view">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2
            className="text-base font-semibold"
            data-testid="heading-env-variables"
          >
            Environment Variables
          </h2>
          <p className="text-xs text-muted-foreground">
            Variables are read-only here. Edit them in Railway to trigger a
            redeploy.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="h-7 text-xs">
          <a
            href={railwayVarsUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="link-railway-vars"
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Open in Railway
          </a>
        </Button>
      </div>

      {grouped.map(([category, vars]) => (
        <Card key={category} data-testid={`category-${category.toLowerCase()}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {category}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-1">
            {vars.map((v) => (
              <div
                key={v.name}
                className="flex items-center gap-2 border-b py-1.5 last:border-b-0"
                data-testid={`row-var-${v.name}`}
              >
                <span className="flex-1 truncate font-mono text-xs">{v.name}</span>
                <span className="text-xs text-muted-foreground">Value hidden</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      {grouped.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-6">
          No variables found.
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanse Modal — search & replace across all DB text data
// ─────────────────────────────────────────────────────────────────────────────

interface CleanseDetail {
  table: string;
  column: string;
  type: string;
  rowsAffected: number;
}

interface CleanseResult {
  totalTablesScanned: number;
  totalColumnsScanned: number;
  totalRowsAffected: number;
  details: CleanseDetail[];
  backupId?: string;
  dryRun: boolean;
}

function CleanseModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [phase, setPhase] = useState<"input" | "preview" | "running" | "done">(
    "input",
  );
  const [previewResult, setPreviewResult] = useState<CleanseResult | null>(
    null,
  );
  const [executeResult, setExecuteResult] = useState<CleanseResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    table: string;
    column: string;
  } | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);

  const reset = () => {
    setFindText("");
    setReplaceText("");
    setConfirmText("");
    setPhase("input");
    setPreviewResult(null);
    setExecuteResult(null);
    setError(null);
    setCaseInsensitive(false);
    setProgress(null);
    setBackupStatus(null);
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  /** Read an NDJSON stream, dispatch events to state, and return the final CleanseResult. */
  const consumeStream = async (response: Response): Promise<CleanseResult> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: CleanseResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete tail
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "progress") {
          setProgress({
            current: event.current,
            total: event.total,
            table: event.table,
            column: event.column,
          });
        } else if (event.type === "backup") {
          setBackupStatus(event.status);
        } else if (event.type === "complete") {
          finalResult = event as CleanseResult;
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }
    }
    if (!finalResult) throw new Error("Stream ended without completion event");
    return finalResult;
  };

  const runPreview = async () => {
    if (!findText.trim()) return;
    setError(null);
    setProgress(null);
    setBackupStatus(null);
    setPhase("running");
    try {
      const res = await apiRequest("POST", "/api/admin/cleanse", {
        find: findText,
        replace: replaceText,
        dryRun: true,
        caseInsensitive,
        stream: true,
      });
      const data = await consumeStream(res);
      setPreviewResult(data);
      setPhase("preview");
    } catch (err: any) {
      setError(err.message || "Preview failed");
      setPhase("input");
    }
  };

  const runExecute = async () => {
    if (confirmText !== findText) return;
    setError(null);
    setProgress(null);
    setBackupStatus(null);
    setPhase("running");
    try {
      const res = await apiRequest("POST", "/api/admin/cleanse", {
        find: findText,
        replace: replaceText,
        dryRun: false,
        caseInsensitive,
        stream: true,
      });
      const data = await consumeStream(res);
      setExecuteResult(data);
      setPhase("done");
      toast({
        title: "Cleanse complete",
        description: `${data.totalRowsAffected} rows updated across ${data.totalTablesScanned} tables`,
      });
    } catch (err: any) {
      setError(err.message || "Cleanse failed");
      setPhase("preview");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Database Cleanse</DialogTitle>
          <DialogDescription>
            Search and replace text across all database tables and columns.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-error/10 border border-error/30 p-3 text-sm text-error">
            {error}
          </div>
        )}

        {phase === "input" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cleanse-find">Find</Label>
              <Input
                id="cleanse-find"
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                placeholder="Text to find..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cleanse-replace">Replace with</Label>
              <Input
                id="cleanse-replace"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="Replacement text..."
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={caseInsensitive}
                onChange={(e) => setCaseInsensitive(e.target.checked)}
                className="rounded border-border"
              />
              Case-insensitive (matches agent, Agent, AGENT, etc.)
            </label>
          </div>
        )}

        {phase === "running" && (
          <div className="flex flex-col gap-3 py-4">
            {backupStatus && backupStatus !== "complete" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {backupStatus === "creating"
                    ? "Creating backup..."
                    : backupStatus === "waiting"
                      ? "Waiting for backup..."
                      : `Backup ${backupStatus}`}
                </span>
              </div>
            )}
            {progress ? (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Scanning columns...
                  </span>
                  <span className="tabular-nums font-medium">
                    {Math.round((progress.current / progress.total) * 100)}%
                  </span>
                </div>
                <Progress value={(progress.current / progress.total) * 100} />
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {progress.table}.{progress.column}
                  <span className="ml-2 text-muted-foreground/60">
                    ({progress.current}/{progress.total})
                  </span>
                </p>
              </>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Initializing...</span>
              </div>
            )}
          </div>
        )}

        {phase === "preview" && previewResult && (
          <div className="space-y-4">
            <div className="text-sm">
              <p className="font-medium">
                {previewResult.totalRowsAffected === 0
                  ? "No matches found."
                  : `${previewResult.totalRowsAffected.toLocaleString()} matches across ${previewResult.totalTablesScanned} tables`}
              </p>
            </div>
            {previewResult.details.length > 0 && (
              <div className="max-h-[240px] overflow-auto border rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left p-2 font-medium">Table</th>
                      <th className="text-left p-2 font-medium">Column</th>
                      <th className="text-right p-2 font-medium">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewResult.details.map((d, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="p-2 font-mono">{d.table}</td>
                        <td className="p-2 font-mono">{d.column}</td>
                        <td className="p-2 text-right tabular-nums">
                          {d.rowsAffected}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {previewResult.totalRowsAffected > 0 && (
              <div className="space-y-2">
                <Label
                  htmlFor="cleanse-confirm"
                  className="text-sm text-muted-foreground"
                >
                  Type{" "}
                  <span className="font-mono font-medium text-foreground">
                    {findText}
                  </span>{" "}
                  to confirm
                </Label>
                <Input
                  id="cleanse-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="Type the find text to confirm..."
                />
                <p className="text-xs text-muted-foreground">
                  A backup will be created automatically before executing.
                </p>
              </div>
            )}
          </div>
        )}

        {phase === "done" && executeResult && (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="font-medium">
                {executeResult.totalRowsAffected.toLocaleString()} rows updated
                across {executeResult.totalTablesScanned} tables
              </span>
            </div>
            {executeResult.backupId && (
              <p className="text-xs text-muted-foreground">
                Pre-cleanse backup: {executeResult.backupId}
              </p>
            )}
            {executeResult.details.length > 0 && (
              <div className="max-h-[200px] overflow-auto border rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left p-2 font-medium">Table</th>
                      <th className="text-left p-2 font-medium">Column</th>
                      <th className="text-right p-2 font-medium">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executeResult.details.map((d, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="p-2 font-mono">{d.table}</td>
                        <td className="p-2 font-mono">{d.column}</td>
                        <td className="p-2 text-right tabular-nums">
                          {d.rowsAffected}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === "input" && (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={runPreview} disabled={!findText.trim()}>
                <Eye className="h-4 w-4 mr-1.5" />
                Preview
              </Button>
            </>
          )}
          {phase === "preview" && previewResult && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setPhase("input");
                  setPreviewResult(null);
                  setConfirmText("");
                }}
              >
                Back
              </Button>
              {previewResult.totalRowsAffected > 0 && (
                <Button
                  variant="destructive"
                  onClick={runExecute}
                  disabled={confirmText !== findText}
                >
                  <Eraser className="h-4 w-4 mr-1.5" />
                  Execute ({previewResult.totalRowsAffected.toLocaleString()}{" "}
                  rows)
                </Button>
              )}
            </>
          )}
          {phase === "done" && (
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup Panel
// ─────────────────────────────────────────────────────────────────────────────

interface BackupJob {
  id: string;
  status: "in_progress" | "complete" | "failed" | "cancelled";
  trigger_type: "manual" | "scheduled" | "upload";
  s3_key: string | null;
  compressed_size: number | null;
  table_count: number | null;
  total_rows: number | null;
  duration_ms: number | null;
  table_manifest: Record<string, { rows: number; bytes?: number }> | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

const BACKUP_PRIVILEGED_HEADERS = {
  "x-privileged-scope": "backup",
  "x-privileged-reason": "Manage database backups from Dev Database page",
} as const;


function useNarrowContainer<T extends HTMLElement>(threshold = 720): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [isNarrow, setIsNarrow] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => setIsNarrow(el.getBoundingClientRect().width < threshold);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, isNarrow];
}

async function throwBackupResponseError(res: Response, fallback: string): Promise<never> {
  const payload = await res.json().catch(() => null);
  const message = payload?.error || res.statusText || fallback;
  throw new Error(`${res.status}: ${message}`);
}

async function fetchBackupJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-privileged-scope", BACKUP_PRIVILEGED_HEADERS["x-privileged-scope"]);
  headers.set("x-privileged-reason", BACKUP_PRIVILEGED_HEADERS["x-privileged-reason"]);

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!res.ok) await throwBackupResponseError(res, "Backup request failed");
  return (await res.json()) as T;
}

type UploadProgressSnapshot = { loaded: number; total: number | null };

function uploadWithProgress(
  url: string,
  body: Blob | File,
  options: {
    method?: string;
    contentType?: string;
    headers?: Record<string, string>;
    withCredentials?: boolean;
    onProgress: (snapshot: UploadProgressSnapshot) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "PUT", url);
    xhr.withCredentials = options.withCredentials ?? false;

    if (options.contentType) {
      xhr.setRequestHeader("Content-Type", options.contentType);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (event) => {
      options.onProgress({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress({ loaded: body.size, total: body.size });
        resolve();
        return;
      }

      let message = xhr.statusText || "Upload failed";
      try {
        const payload = JSON.parse(xhr.responseText);
        if (payload?.error) message = payload.error;
      } catch {
        if (xhr.responseText) message = xhr.responseText.slice(0, 300);
      }
      reject(new Error(`${xhr.status}: ${message}`));
    };
    xhr.onerror = () => reject(new Error("Failed to fetch"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(body);
  });
}

function BackupPanel() {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [backupsOpen, setBackupsOpen] = useState(true);
  const [restoreTarget, setRestoreTarget] = useState<BackupJob | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadPhase, setUploadPhase] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedBytes: number;
    totalBytes: number;
    currentChunk: number | null;
    totalChunks: number | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backupCardRef, isBackupNarrow] = useNarrowContainer<HTMLDivElement>(760);

  const {
    data: backups = [],
    isLoading,
    refetch,
  } = useQuery<BackupJob[]>({
    queryKey: ["/api/backups"],
    queryFn: () => fetchBackupJson<BackupJob[]>("/api/backups"),
    refetchInterval: (query) => {
      const data = query.state.data as BackupJob[] | undefined;
      if (data?.some((b) => b.status === "in_progress")) return 3000;
      return false;
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      fetchBackupJson<{ id: string; status: BackupJob["status"] }>("/api/backups", {
        method: "POST",
      }),
    onSuccess: () => {
      refetch();
      toast({
        title: "Backup started",
        description: "Creating a full database snapshot...",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Backup failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchBackupJson<{ ok?: boolean }>(`/api/backups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refetch();
      toast({ title: "Backup deleted" });
    },
    onError: (err: Error) => {
      toast({
        title: "Delete failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      fetchBackupJson<BackupJob>(`/api/backups/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "Cancelled manually from Dev Database page",
        }),
      }),
    onSuccess: () => {
      refetch();
      toast({ title: "Backup cancelled" });
    },
    onError: (err: Error) => {
      toast({
        title: "Cancel failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const hasInProgress = backups.some((b) => b.status === "in_progress");

  async function handleRestore(backup: BackupJob) {
    setIsRestoring(true);
    setRestoreResult(null);
    try {
      const data = await fetchBackupJson<{ totalRows?: number; tables?: number }>(
        `/api/backups/${backup.id}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false }),
        },
      );
      setRestoreResult(
        `Restore complete. ${data.totalRows?.toLocaleString() ?? "?"} rows across ${data.tables ?? "?"} tables restored.`,
      );
      toast({ title: "Restore complete" });
    } catch (err: any) {
      setRestoreResult(`Restore failed: ${err.message}`);
      toast({
        title: "Restore failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsRestoring(false);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".tar.gz") && !file.name.endsWith(".tgz")) {
      toast({
        title: "Invalid file",
        description: "Please select a .tar.gz backup file",
        variant: "destructive",
      });
      return;
    }
    // Reset input so the same file can be re-selected
    e.target.value = "";
    handleUpload(file);
  }

  /**
   * Upload a file in chunks to bypass Railway's 300s proxy timeout.
   * Each chunk is a separate HTTP request, well within the timeout.
   * Returns the backup job ID (not a restore job).
   */
  async function uploadChunked(file: File): Promise<string> {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB per chunk
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Phase 1: Init session
    setUploadPhase("Initializing chunked upload...");
    const { sessionId } = await fetchBackupJson<{ sessionId: string }>(
      "/api/backups/chunked/init",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalSize: file.size, totalChunks }),
      },
    );

    // Phase 2: Upload chunks sequentially
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      setUploadPhase(`Uploading chunk ${i + 1}/${totalChunks}...`);
      setUploadProgress({
        uploadedBytes: start,
        totalBytes: file.size,
        currentChunk: i + 1,
        totalChunks,
      });
      await uploadWithProgress(`/api/backups/chunked/${sessionId}/${i}`, chunk, {
        contentType: "application/octet-stream",
        headers: BACKUP_PRIVILEGED_HEADERS,
        withCredentials: true,
        onProgress: ({ loaded }) => {
          setUploadProgress({
            uploadedBytes: Math.min(start + loaded, file.size),
            totalBytes: file.size,
            currentChunk: i + 1,
            totalChunks,
          });
        },
      });
    }

    // Phase 3: Finalize — reassemble and create backup entry
    setUploadPhase("Finalizing upload...");
    const { id } = await fetchBackupJson<{ id?: string }>(
      `/api/backups/chunked/${sessionId}/finalize`,
      { method: "POST" },
    );
    if (!id) throw new Error("Server did not return a backup ID");
    return id;
  }

  async function handleUpload(file: File) {
    setIsUploading(true);
    setUploadResult(null);
    setUploadPhase("Requesting upload URL...");
    setUploadProgress(null);

    try {
      // Strategy 1: Try presigned R2 upload (fastest, bypasses Railway entirely)
      try {
        const { uploadUrl, objectKey } = await fetchBackupJson<{
          uploadUrl?: string;
          objectKey?: string;
        }>("/api/backups/upload-url", { method: "POST" });
        if (!uploadUrl || !objectKey) throw new Error("presigned unavailable");

        setUploadPhase("Uploading to storage...");
        setUploadProgress({
          uploadedBytes: 0,
          totalBytes: file.size,
          currentChunk: null,
          totalChunks: null,
        });
        await uploadWithProgress(uploadUrl, file, {
          contentType: "application/gzip",
          onProgress: ({ loaded }) => {
            setUploadProgress({
              uploadedBytes: Math.min(loaded, file.size),
              totalBytes: file.size,
              currentChunk: null,
              totalChunks: null,
            });
          },
        });

        setUploadPhase("Processing backup...");
        await fetchBackupJson<{ id: string }>("/api/backups/upload-from-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objectKey }),
        });
      } catch {
        // Strategy 2: Fall back to chunked upload (no S3 required)
        await uploadChunked(file);
      }

      setUploadResult("Upload complete. Backup added to the list.");
      toast({ title: "Upload complete" });
      refetch();
    } catch (err: any) {
      setUploadResult(`Upload failed: ${err.message}`);
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  }

  return (
    <>
      <section ref={backupCardRef} className="space-y-2">
        <div className={cn("flex gap-3 px-1", isBackupNarrow ? "flex-col" : "items-center justify-between")}>
          <button
              type="button"
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
              onClick={() => setBackupsOpen(v => !v)}
            >
              <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", backupsOpen && "rotate-90")} />
              <span>Backups</span>
            </button>
          {backupsOpen && <div className={cn("grid gap-1", isBackupNarrow ? "w-full grid-cols-1" : "w-auto shrink-0 grid-cols-2")}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tar.gz,.tgz"
              className="hidden"
              onChange={handleFileSelect}
            />
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              <Upload className="h-3.5 w-3.5 shrink-0" />
              <span>Upload Backup</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || hasInProgress}
            >
              {(createMutation.isPending || hasInProgress) ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>Create Backup</span>
            </button>
          </div>}
        </div>
        {backupsOpen && <div className="space-y-2 pl-5">
          {/* Upload progress banner */}
          {(isUploading || uploadResult) && (
            <div
              className={`rounded-md border p-3 ${uploadResult?.includes("failed") ? "border-error/50 bg-error/5" : uploadResult ? "border-success/50 bg-success/5 dark:bg-success/20" : "border-info/50 bg-info/5 dark:bg-info/5"}`}
            >
              {uploadResult ? (
                <div className={cn("flex gap-2", isBackupNarrow ? "flex-col" : "items-center justify-between")}>
                  <p
                    className={`min-w-0 text-sm leading-relaxed ${uploadResult.includes("failed") ? "text-error" : "text-success-foreground"}`}
                  >
                    {uploadResult}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn("h-7 px-2 text-xs", isBackupNarrow ? "w-full" : "w-auto shrink-0")}
                    onClick={() => {
                      setUploadResult(null);
                      setUploadPhase("");
                      setUploadProgress(null);
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info-foreground" />
                    <span className="min-w-0 text-sm font-medium">
                      {uploadPhase || "Processing..."}
                    </span>
                  </div>
                  {uploadProgress && (
                    <div className="space-y-1.5">
                      <Progress
                        value={Math.round((uploadProgress.uploadedBytes / Math.max(uploadProgress.totalBytes, 1)) * 100)}
                        className="h-1.5"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {Math.round((uploadProgress.uploadedBytes / Math.max(uploadProgress.totalBytes, 1)) * 100)}% · {formatBytes(uploadProgress.uploadedBytes)} of {formatBytes(uploadProgress.totalBytes)}
                        </span>
                        {uploadProgress.currentChunk && uploadProgress.totalChunks && (
                          <span>Chunk {uploadProgress.currentChunk} of {uploadProgress.totalChunks}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : backups.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No backups yet.</div>
          ) : (
            <div className="space-y-1">
              {backups.map((b) => {
                    const isExpanded = expandedId === b.id;
                    const isComplete = b.status === "complete";
                    const createdAt = new Date(b.created_at);
                    const tableEntries = b.table_manifest && typeof b.table_manifest === "object"
                      ? Object.entries(b.table_manifest)
                        .filter(([k]) => k !== "_total")
                        .sort(([, a], [, b]) => ((b as any).rows ?? 0) - ((a as any).rows ?? 0))
                      : [];

                    return (
                      <div key={b.id} className="group">
                        <button
                          type="button"
                          className={cn(
                            "group relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-left text-sm transition-colors",
                            isExpanded ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                          )}
                          onClick={() => setExpandedId(isExpanded ? null : b.id)}
                          aria-expanded={isExpanded}
                        >
                          {b.status === "in_progress" ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-active" />
                          ) : (
                            <Database className={cn("h-3.5 w-3.5 shrink-0", b.status === "complete" ? "text-success" : b.status === "failed" ? "text-error" : "text-muted-foreground")} />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {formatDistanceToNow(createdAt, { addSuffix: true })}
                          </span>
                          <span className="hidden min-w-0 max-w-[6rem] shrink truncate text-xs text-muted-foreground min-[390px]:block">
                            {b.compressed_size != null ? formatBytes(b.compressed_size) : "No size"}
                          </span>
                          <ChevronRight className={cn("absolute right-8 top-1/2 h-3.5 w-3.5 -translate-y-1/2 shrink-0 transition-transform", isExpanded && "rotate-90")} />
                        </button>

                        {isExpanded && (
                          <div className="flex min-w-0 items-stretch pl-4">
                            <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
                              <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border" />
                              <div className="absolute left-1/2 right-0 top-5 border-t border-border" />
                            </div>
                            <div className="min-w-0 flex-1 space-y-3 rounded-md bg-muted/20 p-3">
                              <div className={cn("grid gap-3 text-xs", isBackupNarrow ? "grid-cols-2" : "grid-cols-4 xl:grid-cols-6")}>
                                <div className="min-w-0">
                                  <div className="text-muted-foreground">Created</div>
                                  <div className="truncate text-foreground">{createdAt.toLocaleString()}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Trigger</div>
                                  <Badge variant={b.trigger_type === "scheduled" ? "outline" : "secondary"} className="mt-1 text-xs">
                                    {b.trigger_type}
                                  </Badge>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Size</div>
                                  <div className="text-foreground">{b.compressed_size != null ? formatBytes(b.compressed_size) : "—"}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Tables</div>
                                  <div className="text-foreground">{b.table_count ?? "—"}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Rows</div>
                                  <div className="text-foreground">{b.total_rows?.toLocaleString() ?? "—"}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Duration</div>
                                  <div className="text-foreground">{b.duration_ms != null ? `${(b.duration_ms / 1000).toFixed(1)}s` : "—"}</div>
                                </div>
                              </div>

                              <p className="break-all text-xs text-muted-foreground">ID: {b.id}</p>

                              {formatDiagnosticValue(b.error) && (
                                <p className="break-words text-xs text-error">
                                  Error: {formatDiagnosticValue(b.error)}
                                </p>
                              )}

                              <div className={cn("flex flex-wrap gap-2", isBackupNarrow && "grid grid-cols-2")}>
                                {b.status === "in_progress" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 text-xs text-warning border-warning/30 hover:bg-warning/10"
                                    disabled={cancelMutation.isPending}
                                    onClick={() => {
                                      if (confirm("Cancel this in-progress backup?")) {
                                        cancelMutation.mutate(b.id);
                                      }
                                    }}
                                  >
                                    <Square className="mr-1 h-3 w-3" />
                                    Cancel
                                  </Button>
                                )}
                                {isComplete && (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 text-xs"
                                      onClick={() => {
                                        fetchBackupJson<{ url: string }>(
                                          `/api/backups/${b.id}/download`,
                                          { headers: { Accept: "application/json" } },
                                        )
                                          .then(({ url }) => window.open(url, "_blank"))
                                          .catch((err) =>
                                            toast({
                                              title: "Download failed",
                                              description: err.message,
                                              variant: "destructive",
                                            }),
                                          );
                                      }}
                                    >
                                      <Download className="mr-1 h-3 w-3" />
                                      Download
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 text-xs text-warning border-warning/30 hover:bg-warning/10"
                                      onClick={() => {
                                        setRestoreTarget(b);
                                        setConfirmText("");
                                        setRestoreResult(null);
                                      }}
                                    >
                                      Restore
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 text-xs text-error hover:bg-error/10"
                                      onClick={() => {
                                        if (confirm("Delete this backup?")) {
                                          deleteMutation.mutate(b.id);
                                        }
                                      }}
                                    >
                                      Delete
                                    </Button>
                                  </>
                                )}
                              </div>

                              {tableEntries.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium text-muted-foreground">Table breakdown</p>
                                  <div className={cn("grid grid-cols-1 gap-x-4 gap-y-1 text-xs", !isBackupNarrow && "grid-cols-3 xl:grid-cols-4")}>
                                    {tableEntries.map(([table, info]) => (
                                      <div key={table} className="flex min-w-0 justify-between gap-2">
                                        <span className="truncate text-muted-foreground">{table}</span>
                                        <span className="shrink-0">{((info as any).rows ?? 0).toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
            </div>
          )}
        </div>}
      </section>

      {/* Restore Confirmation Dialog */}
      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open && !isRestoring) {
            setRestoreTarget(null);
            setConfirmText("");
            setRestoreResult(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore Database</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {restoreResult ? (
                  <p
                    className={
                      restoreResult.includes("failed")
                        ? "text-error"
                        : "text-success-foreground font-medium"
                    }
                  >
                    {restoreResult}
                  </p>
                ) : isRestoring ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>
                      Restoring database... This may take a few minutes.
                    </span>
                  </div>
                ) : (
                  <>
                    <p>
                      This backup contains{" "}
                      <strong>
                        {restoreTarget?.table_count ?? "?"} tables
                      </strong>{" "}
                      and{" "}
                      <strong>
                        {restoreTarget?.total_rows?.toLocaleString() ?? "?"}{" "}
                        rows
                      </strong>{" "}
                      from{" "}
                      {restoreTarget
                        ? new Date(restoreTarget.created_at).toLocaleString()
                        : "unknown"}
                      .
                    </p>
                    <p className="text-error font-medium">
                      Restoring will replace ALL current data.
                    </p>
                    <div>
                      <Label className="text-xs">
                        Type <strong>RESTORE</strong> to confirm:
                      </Label>
                      <Input
                        className="mt-1"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder="RESTORE"
                      />
                    </div>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestoring}>
              {restoreResult ? "Close" : "Cancel"}
            </AlertDialogCancel>
            {!restoreResult && !isRestoring && (
              <AlertDialogAction
                disabled={confirmText !== "RESTORE"}
                className="bg-warning hover:bg-warning/80 text-white"
                onClick={(e) => {
                  e.preventDefault();
                  if (restoreTarget) handleRestore(restoreTarget);
                }}
              >
                Restore Database
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Design tab
// ─────────────────────────────────────────────────────────────────────────────

type TokenItem = {
  name: string;
  value: string;
  className: string;
  usage: string;
};

const foundationTokens: TokenItem[] = [
  {
    name: "background",
    value: "222 20% 8%",
    className: "bg-background",
    usage: "Page canvas (pure black in dark mode). The default surface. Content-consumption UIs sit directly on this.",
  },
  {
    name: "card",
    value: "222 20% 11%",
    className: "bg-card",
    usage: "Content groups on structured data pages. Always pair with overflow-hidden min-w-0. Never black.",
  },
  {
    name: "muted",
    value: "222 16% 14%",
    className: "bg-muted",
    usage: "Quiet wells, disabled zones, secondary panes.",
  },
  {
    name: "foreground",
    value: "220 10% 92%",
    className: "bg-foreground",
    usage: "Full emphasis text and needs-attention state.",
  },
  {
    name: "primary",
    value: "var(--foreground)",
    className: "bg-foreground",
    usage:
      "Alias of foreground. Full primary text and calm structural emphasis. Not CTA.",
  },
  {
    name: "muted-foreground",
    value: "220 10% 55%",
    className: "bg-muted-foreground",
    usage: "Normal, resolved, labels, metadata, low-emphasis state.",
  },
  {
    name: "border",
    value: "222 16% 16%",
    className: "bg-border",
    usage: "Thin structure. Prefer borders over shadows.",
  },
];

const actionStatusTokens: TokenItem[] = [
  {
    name: "cta",
    value: "200 80% 50%",
    className: "bg-cta",
    usage:
      "Protected action and interactive color. Filled primary CTA; outline/text for secondary CTA, links, references.",
  },
  {
    name: "success",
    value: "174 70% 50%",
    className: "bg-success",
    usage: "Confirmed completion/health. Aqua, calm, never action.",
  },
  {
    name: "warning",
    value: "34 82% 58%",
    className: "bg-warning",
    usage: "Actual caution/probable risk. Warmer, quieter, rare.",
  },
  {
    name: "active",
    value: "200 80% 75%",
    className: "bg-active",
    usage:
      "CTA mixed halfway toward white for live/running spinner icons and active status icons.",
  },
  {
    name: "error",
    value: "356 64% 60%",
    className: "bg-error",
    usage: "Failure, broken invariant, destructive risk.",
  },
];

const typeScale = [
  {
    name: "Page title",
    className: "text-xl font-semibold @md:text-2xl",
    value: "text-2xl / semibold, text-xl constrained",
    sample: "Build Design",
  },
  {
    name: "Section head",
    className: "text-lg font-semibold",
    value: "text-lg / semibold",
    sample: "Color system",
  },
  {
    name: "Emphasis",
    className: "text-base font-medium",
    value: "text-base / medium",
    sample: "One primary action per decision surface.",
  },
  {
    name: "Body",
    className: "text-sm",
    value: "text-sm / regular",
    sample: "Dense, calm, legible interface copy.",
  },
  {
    name: "Caption",
    className: "text-xs text-muted-foreground",
    value: "text-xs / muted",
    sample: "Token metadata, timestamps, labels.",
  },
  {
    name: "Code",
    className: "font-mono text-xs",
    value: "JetBrains Mono",
    sample: "bg-card text-card-foreground",
  },
];

const spacingRules = [
  { name: "Tight", value: "gap-2", pixels: "8px", width: "w-8" },
  { name: "Default", value: "gap-4", pixels: "16px", width: "w-16" },
  { name: "Section", value: "gap-6", pixels: "24px", width: "w-24" },
  { name: "Major", value: "gap-8", pixels: "32px", width: "w-32" },
];

const auditRules = [
  "Hierarchy is obvious in three seconds.",
  "One primary action per screen or viewport; subregions use secondary hierarchy unless isolated.",
  "Use functional tokens, never decorative one-offs.",
  "Prefer borders and spacing over heavy shadows.",
  "Every dense panel still has breathing rhythm.",
  "Badges describe state, not decoration.",
  "Empty states explain what belongs here next.",
  "No persistent subtitles under page, card, dialog, tab, or panel titles.",
  "Mobile may collapse density and ornament; hierarchy, actions, and legibility stay intact.",
];

const activeStatusClasses = getStatusClasses("active");

const statusExamples = [
  {
    level: "error",
    token: "text-error",
    icon: AlertTriangle,
    label: "Failed deployment",
    detail: "Something broke. Highest priority.",
  },
  {
    level: "active",
    token: "text-active",
    icon: Loader2,
    label: "Running plan",
    detail: "Live work in motion. Flashing white, no hue.",
  },
  {
    level: "pinned",
    token: "text-foreground",
    icon: Pin,
    label: "Pinned",
    detail: "Pin stays white; text still follows read/unread.",
  },
  {
    level: "unread",
    token: "text-foreground",
    icon: CircleDot,
    label: "Unread update",
    detail: "New since last visit or needs attention. White text, no topaz.",
  },
  {
    level: "read",
    token: "text-muted-foreground",
    icon: Circle,
    label: "Read update",
    detail: "Already looked at. Muted text.",
  },
];

const referenceExamples = [
  {
    type: "page",
    label: "Design System",
    canonical: "@page:design-system",
    legacy: "[page:design-system]",
    icon: FileText,
  },
  {
    type: "person",
    label: "Ray",
    canonical: "@person:ray",
    legacy: "[person:ray]",
    icon: User,
  },
  {
    type: "goal",
    label: "Build the Economic Engine",
    canonical: "@goal:74f670b0",
    legacy: "[goal:74f670b0]",
    icon: Target,
  },
  {
    type: "intention",
    label: "Prepare Automate",
    canonical: "@intention:mqjzl8i5",
    legacy: "Intention ID: mqjzl8i5",
    icon: Sparkles,
  },
  {
    type: "wellness_activity",
    label: "Gratitude",
    canonical: "@wellness_activity:gratitude",
    legacy: "@health_activity:gratitude",
    icon: Activity,
  },
  {
    type: "priority",
    label: "Meta Display Connected",
    canonical: "@priority:daily:2026-06-19:Meta%20Display%20Connected",
    legacy: "none",
    icon: Pin,
  },
];

function DesignSection({
  number,
  title,
  eyebrow,
  children,
}: {
  number: string;
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border-b border-border/15 pb-8">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-xs text-muted-foreground/50">{number}</span>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/50">
            {eyebrow}
          </div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        </div>
      </div>
      <div className="min-w-0 overflow-hidden">{children}</div>
    </section>
  );
}

function TokenSwatch({ token }: { token: TokenItem }) {
  return (
    <div className="overflow-hidden rounded-md">
      <div className={cn("h-10 rounded-t-md", token.className)} />
      <div className="space-y-1 pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs">--{token.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {token.value}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {token.usage}
        </p>
      </div>
    </div>
  );
}

function DoDontCard({
  kind,
  title,
  children,
}: {
  kind: "do" | "dont";
  title: string;
  children: React.ReactNode;
}) {
  const isDo = kind === "do";
  return (
    <div
      className={cn(
        "rounded-md border p-4",
        isDo ? "border-border bg-muted/30" : "border-error/30 bg-error/5",
      )}
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        {isDo ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <XCircle className="h-4 w-4 text-error" />
        )}
        {title}
      </div>
      {children}
    </div>
  );
}

export function DesignTab() {
  const [hierarchySectionOpen, setHierarchySectionOpen] = useState(true);
  const [hierarchyParentOpen, setHierarchyParentOpen] = useState(true);
  const [hierarchyMeetingOpen, setHierarchyMeetingOpen] = useState(false);
  const [hierarchySelected, setHierarchySelected] = useState("parent");
  const [hierarchySearch, setHierarchySearch] = useState("");
  const [hierarchyTitle, setHierarchyTitle] = useState("Launch Mantra");
  const [hierarchyDate, setHierarchyDate] = useState("2026-07-15");
  const [hierarchyReferenceOpen, setHierarchyReferenceOpen] = useState(true);
  const [hierarchyChecked, setHierarchyChecked] = useState({
    priority: true,
    mobility: false,
  });

  return (
    <div className="min-h-full min-w-0 overflow-hidden bg-background px-4 py-6">
      <div className="grid min-w-0 gap-8 overflow-hidden">
        <header className="border-b border-border/15 pb-8">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="w-fit gap-1.5 text-muted-foreground"
            >
              <Sparkles className="h-3.5 w-3.5 text-foreground" />
              Visual constitution
            </Badge>
            <Badge
              variant="secondary"
              className="w-fit font-mono text-[10px] uppercase tracking-[0.14em]"
            >
              2026.06.23
            </Badge>
          </div>
          <h1 className="mt-3 text-lg font-semibold tracking-tight">
            Mantra Design System
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Dark-first, frameless, mobile-first. Content sits directly on the
            canvas. Cards are rare, borders are structural, and every color
            earns its place. DESIGN.md is canonical.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span><span className="text-foreground">CTA</span> — filled primary, outline secondary</span>
            <span><span className="text-foreground">Primary</span> — foreground alias</span>
            <span><span className="text-cta">Link</span> — CTA text, active hover</span>
          </div>
        </header>

        <DesignSection number="01" eyebrow="Brand" title="Mantra mark">
          <div className="grid gap-6 @lg:grid-cols-[240px_1fr]">
            <div className="flex aspect-square items-center justify-center rounded-lg border border-border/30 bg-background p-10">
              <MantraLogo className="h-28 w-28" />
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Website logo</div>
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Mantra uses the approved bold Mantra PNG mark as the website, sign-in,
                and upper-left web button logo. The mark pairs the white monogram
                with Mantra blue spatial axis/orbit on the black canvas. Do not substitute the
                generic Agent icon on brand surfaces.
              </p>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="font-mono">white M</Badge>
                <Badge variant="outline" className="font-mono text-cta">Mantra blue orbit</Badge>
                <Badge variant="outline" className="font-mono">black canvas</Badge>
              </div>
            </div>
          </div>
        </DesignSection>

        <DesignSection number="02" eyebrow="Color" title="Functional palette">
          <div className="mb-4">
            <div className="text-sm font-medium">
              Color encodes function, not decoration.
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Surface, action, link, and status colors are separate roles. CTA
              is the protected action color, link is the object/navigation
              color, and tinted backgrounds are reserved for surfaces that
              literally communicate state.
            </p>
          </div>
          <div className="grid gap-4 @sm:grid-cols-2 @lg:grid-cols-4">
            {foundationTokens.map((token) => (
              <TokenSwatch key={token.name} token={token} />
            ))}
          </div>
          <div className="mt-6 grid gap-4 @sm:grid-cols-2 @lg:grid-cols-5">
            {actionStatusTokens.map((token) => (
              <TokenSwatch key={token.name} token={token} />
            ))}
          </div>
        </DesignSection>

        <DesignSection
          number="03"
          eyebrow="Attention"
          title="CTA and status discipline"
        >
          <div className="grid min-w-0 gap-6 overflow-hidden @lg:grid-cols-3">
            <div className="space-y-3">
              <div className="text-sm font-medium">CTA is sacred</div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                One persistent blue action per screen. Never use CTA blue for
                panels, examples, icons, links, or status.
              </p>
              <Button className="w-full">Generate plan</Button>
              <Button className="w-full" variant="outline">
                Preview inputs
              </Button>
              <Button className="w-full" variant="ghost">
                Save draft
              </Button>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Needs attention</div>
              <div className="rounded-md border border-border/30 p-3">
                <div className="text-sm font-medium text-foreground">
                  Review enrollment path
                </div>
                <div className="text-xs text-muted-foreground">
                  Due today. Uses foreground emphasis, not amber.
                </div>
              </div>
              <div className="rounded-md border border-border/30 p-3">
                <div className="text-sm font-medium text-muted-foreground">
                  No response needed
                </div>
                <div className="text-xs text-muted-foreground">
                  Resolved items stay visually quiet.
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Alert/error merged</div>
              <div className="rounded-md border border-error/30 bg-error/10 p-3 text-error">
                <div className="text-sm font-medium">Build failed</div>
                <div className="text-xs opacity-80">
                  Failures, destructive risk, and broken invariants share one
                  hue.
                </div>
              </div>
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-warning">
                <div className="text-sm font-medium">Warning reserved</div>
                <div className="text-xs opacity-80">
                  Use only for actual caution or probable risk.
                </div>
              </div>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="04"
          eyebrow="Backgrounds"
          title="Surface and tint rules"
        >
          <div className="grid gap-6 @lg:grid-cols-3">
            <div className="space-y-3">
              <div className="text-sm font-medium">Nested menu</div>
              <div className="space-y-1 rounded-md p-1">
                <div className="rounded bg-accent px-2 py-1.5 text-sm">
                  Selected row uses accent
                </div>
                <div className="rounded px-2 py-1.5 text-sm text-muted-foreground">
                  Quiet row stays transparent
                </div>
                <div className="rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
                  metadata well uses muted
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Chat surfaces</div>
              <div className="rounded-lg border border-border/30 p-3 text-sm">
                Assistant/system bubble uses background/card structure.
              </div>
              <div className="ml-8 rounded-lg bg-muted p-3 text-sm">
                Secondary user/context bubble uses muted, not semantic tint.
              </div>
              <a
                className="text-sm text-cta transition-colors hover:text-active underline-offset-4 hover:underline"
                href="#"
              >
                Links use CTA and lighten on hover
              </a>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">State callouts</div>
              <div className="rounded-md border border-success/30 bg-success/10 p-2 text-sm text-success">
                Success confirmation
              </div>
              <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-sm text-warning">
                Actual warning/risk
              </div>
              <div className="rounded-md border border-error/30 bg-error/10 p-2 text-sm text-error">
                Failure or destructive risk
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            CTA blue has no tint role. Active has no tint role. Use structure
            first; semantic tints only when the surface literally communicates
            state.
          </p>
          <div className="mt-4 rounded-md border border-border/30 bg-card p-3">
            <div className="text-sm font-medium mb-2">Card philosophy</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Frameless is the starting point, not the whole story.
              Content-consumption UIs (chat, reading) sit directly on the dark
              canvas. Structured data pages (Brain, Settings, Config) use
              bg-card Cards to group related content. Cards must always contain
              their content (overflow-hidden, min-w-0). A Card should never be
              black — that&apos;s the canvas. Overflow escaping a Card is always
              a bug.
            </p>
          </div>
        </DesignSection>

        <DesignSection
          number="05"
          eyebrow="Typography"
          title="Type scale and voice"
        >
          <div className="grid gap-3">
            {typeScale.map((item) => (
              <div
                key={item.name}
                className="flex flex-col gap-1 rounded-md border border-border/20 p-3 @md:flex-row @md:items-center @md:gap-4"
              >
                <div className="shrink-0 @md:w-[140px]">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.value}
                  </div>
                </div>
                <div className={cn("min-w-0 truncate", item.className)}>{item.sample}</div>
                <code className="shrink-0 truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {item.className}
                </code>
              </div>
            ))}
            <div className="rounded-md border border-error/30 bg-error/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-error">
                <XCircle className="h-4 w-4" />
                No subtitles
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Do not place persistent explanatory copy under page, card,
                dialog, tab, or panel titles. If the title needs a subtitle,
                redesign the surface.
              </p>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="06"
          eyebrow="Hierarchy Tree"
          title="Primary UI surfacing modality"
        >
          <div className="grid gap-6 @lg:grid-cols-[1fr_0.9fr]">
            <div className="space-y-3">
              <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md bg-background p-2">
                <div className="relative mb-1 min-w-0">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={hierarchySearch}
                    onChange={(event) => setHierarchySearch(event.target.value)}
                    placeholder="Search items"
                    className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Search hierarchy items"
                  />
                  {hierarchySearch ? (
                    <button
                      type="button"
                      onClick={() => setHierarchySearch("")}
                      className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      aria-label="Clear hierarchy search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setHierarchySelected("new-item")}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80",
                    hierarchySelected === "new-item" && "bg-accent",
                  )}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">New Item</span>
                </button>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                  onClick={() => setHierarchySectionOpen((open) => !open)}
                  aria-expanded={hierarchySectionOpen}
                >
                  <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", hierarchySectionOpen && "rotate-90")} />
                  <span className="truncate">Today</span>
                </button>
                {hierarchySectionOpen ? (
                  <>
                    <div className="flex min-w-0 items-stretch">
                      <div className="relative min-w-0 flex-1 overflow-hidden">
                        <div
                          role="button"
                          tabIndex={0}
                          className={cn(
                            "group relative flex w-full cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 pr-16 text-left text-sm transition-colors",
                            hierarchySelected === "parent" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                          )}
                          onClick={() => setHierarchySelected("parent")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setHierarchySelected("parent");
                            }
                          }}
                        >
                          <Bot className="h-3.5 w-3.5 shrink-0" />
                          <input
                            value={hierarchyTitle}
                            onChange={(event) => setHierarchyTitle(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            className="h-5 min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-sm text-foreground outline-none focus:ring-0"
                            aria-label="Editable hierarchy title"
                          />
                          <button
                            type="button"
                            className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                            aria-label={hierarchyParentOpen ? "Collapse Parent" : "Expand Parent"}
                            onClick={(event) => {
                              event.stopPropagation();
                              setHierarchyParentOpen((open) => !open);
                            }}
                          >
                            <ChevronRight className={cn("h-3 w-3 transition-transform", hierarchyParentOpen && "rotate-90")} />
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className={cn(
                                  "absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                                  hierarchySelected === "parent" ? "bg-accent" : "bg-background hover:bg-accent",
                                )}
                                aria-label="Parent actions"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setHierarchySelected("parent")}>Select parent</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setHierarchyParentOpen((open) => !open)}>
                                {hierarchyParentOpen ? "Collapse" : "Expand"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                    {hierarchyParentOpen ? ([
                      { id: "meeting", depth: 1, kind: "icon", expandable: true, open: hierarchyMeetingOpen, icon: Calendar, label: "Meeting", meta: "Tue 1:30" },
                      { id: "priority", depth: 1, kind: "check", checked: hierarchyChecked.priority, icon: Check, label: "Priority", meta: hierarchyChecked.priority ? "Done" : "Today" },
                      ...(hierarchyMeetingOpen ? [
                        { id: "mobility", depth: 2, kind: "check", checked: hierarchyChecked.mobility, icon: Dumbbell, label: "Mobility", meta: "6–10 PM" },
                        { id: "notes", depth: 2, kind: "icon", expandable: false, open: false, icon: FileText, label: "Notes", meta: "2 min" },
                      ] : []),
                    ].map((item) => {
                      const Icon = item.icon;
                      const selected = hierarchySelected === item.id;
                      const checked = item.kind === "check" && !!item.checked;
                      return (
                        <div key={item.id} className="flex min-w-0 max-w-full items-stretch" style={{ paddingLeft: item.depth * 16 }}>
                          <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
                            <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border" />
                            <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
                          </div>
                          <div className="relative min-w-0 flex-1 overflow-hidden">
                            <div
                              role="button"
                              tabIndex={0}
                              className={cn(
                                "group relative flex w-full cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 pr-16 text-left text-sm transition-colors",
                                selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                              )}
                              onClick={() => setHierarchySelected(item.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setHierarchySelected(item.id);
                                }
                              }}
                            >
                              {item.kind === "icon" ? (
                                <Icon className="h-3.5 w-3.5 shrink-0" />
                              ) : (
                                <button
                                  type="button"
                                  className={cn(
                                    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-transparent transition-colors",
                                    checked ? "border-success text-success" : "border-input text-muted-foreground group-hover:border-success group-hover:bg-success/10",
                                  )}
                                  aria-label={`${checked ? "Mark incomplete" : "Mark complete"} ${item.label}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setHierarchyChecked((current) => ({
                                      ...current,
                                      [item.id]: !current[item.id as keyof typeof current],
                                    }));
                                    setHierarchySelected(item.id);
                                  }}
                                >
                                  {checked ? <Check className="h-3 w-3" /> : null}
                                </button>
                              )}
                              <span className={cn("min-w-0 flex-1 truncate", checked && "text-neutral line-through decoration-neutral/60")}>{item.label}</span>
                              {item.id === "meeting" ? (
                                <InlineDatePicker value={hierarchyDate} onCommit={(value) => setHierarchyDate(value || "")}>
                                  <span className="hidden min-w-0 max-w-[5.5rem] shrink truncate text-xs tabular-nums text-muted-foreground min-[390px]:block">
                                    {hierarchyDate || "Set date"}
                                  </span>
                                </InlineDatePicker>
                              ) : (
                                <span className="hidden min-w-0 max-w-[4.5rem] shrink truncate text-xs text-muted-foreground min-[390px]:block">{item.meta}</span>
                              )}
                              {item.expandable ? (
                                <button
                                  type="button"
                                  className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                                  aria-label={`${item.open ? "Collapse" : "Expand"} ${item.label}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setHierarchyMeetingOpen((open) => !open);
                                  }}
                                >
                                  <ChevronRight className={cn("h-3 w-3 transition-transform", item.open && "rotate-90")} />
                                </button>
                              ) : null}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    className={cn(
                                      "absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                                      selected ? "bg-accent" : "bg-background",
                                    )}
                                    aria-label={`${item.label} actions`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => setHierarchySelected(item.id)}>Select row</DropdownMenuItem>
                                  {item.kind === "check" ? (
                                    <DropdownMenuItem
                                      onClick={() => setHierarchyChecked((current) => ({
                                        ...current,
                                        [item.id]: !current[item.id as keyof typeof current],
                                      }))}
                                    >
                                      {checked ? "Mark incomplete" : "Mark complete"}
                                    </DropdownMenuItem>
                                  ) : null}
                                  {item.expandable ? (
                                    <DropdownMenuItem onClick={() => setHierarchyMeetingOpen((open) => !open)}>
                                      {item.open ? "Collapse" : "Expand"}
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        </div>
                      );
                    })) : null}
                    <div className="flex min-w-0 max-w-full items-stretch pl-4">
                      <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
                        <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border" />
                        <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/70">
                          <ReferenceRenderer
                            refValue={{ type: "page", id: "design-system", canonical: "@page:design-system" }}
                            surface="simple-row"
                            className="mx-0"
                          />
                          <button
                            type="button"
                            className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                            onClick={() => setHierarchyReferenceOpen((open) => !open)}
                            aria-label={hierarchyReferenceOpen ? "Collapse reference context" : "Expand reference context"}
                          >
                            <ChevronRight className={cn("h-3 w-3 transition-transform", hierarchyReferenceOpen && "rotate-90")} />
                          </button>
                        </div>
                        {hierarchyReferenceOpen ? (
                          <div className="mb-1 ml-2 border-l border-border py-1 pl-3 text-xs leading-relaxed text-muted-foreground">
                            References retain their inline link while revealing useful Simple-view context directly in the tree.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
              <p className="max-w-full break-words text-xs leading-relaxed text-muted-foreground">
                Hierarchy Tree is the primary modality for surfacing UI objects: search first, then the + New Item
                action, then collapsible sections. Edit the parent title and meeting date in place, expand the reference for useful context, and use the quiet zero state below as the canonical empty form. Click rows to select, twisties to expand/collapse, check circles to toggle completion, and hover a row to reveal its horizontal … menu.
              </p>
            </div>

            <div className="rounded-md border border-border/20 p-3">
              <div className="text-sm font-medium">Surface rule</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                When a screen needs to surface many objects, prefer the Hierarchy
                Tree before cards, tables, loose lists, or bespoke layouts. The
                tree gives users scan, selection, nesting, completion, expansion,
                and row actions through one compact interaction model.
              </p>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="07"
          eyebrow="Zero State"
          title="Keep the surface, quiet the absence"
        >
          <div className="grid gap-6 @lg:grid-cols-[1fr_0.9fr]">
            <div className="w-full min-w-0 overflow-hidden rounded-md bg-background p-2">
              <div className="relative mb-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input readOnly placeholder="Search things" className="h-7 w-full rounded-md border border-input bg-background pl-7 text-xs placeholder:text-muted-foreground" />
              </div>
              <button type="button" className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta hover:bg-accent/70">
                <Plus className="h-3.5 w-3.5" />
                <span>New Thing</span>
              </button>
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No things yet.</div>
            </div>
            <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>Zero states are the ordinary empty form of a surface. Search, the blue + New Thing action, and useful section structure remain visible.</p>
              <p>No hero icon, centered marketing copy, decorative card, or second CTA. Chat remains the explicit exception.</p>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="08"
          eyebrow="Spacing"
          title="Rhythm"
        >
          <div className="grid gap-6 @lg:grid-cols-[1fr_0.9fr]">
            <div className="space-y-2">
              {spacingRules.map((rule) => (
                <div
                  key={rule.value}
                  className="flex flex-col gap-1 rounded-md border border-border/20 p-2.5 @sm:flex-row @sm:items-center @sm:gap-3"
                >
                  <div className="flex items-center gap-2 @sm:w-[80px] @sm:shrink-0">
                    <div className="text-sm font-medium">{rule.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {rule.value}
                    </div>
                  </div>
                  <div className="hidden h-3 flex-1 rounded bg-muted @sm:block">
                    <div
                      className={cn("h-3 rounded bg-foreground/70", rule.width)}
                    />
                  </div>
                  <div className="hidden font-mono text-xs text-muted-foreground @sm:block">
                    {rule.pixels}
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-md border border-border/20 p-3">
              <div className="text-sm font-medium">Spacing doctrine</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Use the 8px rhythm. Tight controls use gap-2, ordinary groups use
                gap-4, and major sections use gap-6. Full-width containers remain
                the default; spacing should clarify hierarchy without inventing
                decorative wrappers.
              </p>
            </div>
          </div>
        </DesignSection>

        <DesignSection number="09" eyebrow="Motion" title="Animation with purpose">
          <div className="grid gap-4 @lg:grid-cols-3">
            {[
              {
                icon: ChevronRight,
                title: "Continuity",
                body: "Animate disclosure, expansion, and panel entrance when it preserves where the user is in the object graph.",
              },
              {
                icon: Activity,
                title: "State",
                body: "Use shimmer, pulse, rotation, or progress only to explain pending work, live activity, or state transition.",
              },
              {
                icon: Sparkles,
                title: "Restraint",
                body: "Motion is not ornament. Keep it fast, tokenized, and quiet enough that the next action still feels immediate.",
              },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="rounded-md border border-border/20 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <Icon className="h-3.5 w-3.5 text-foreground" />
                    {item.title}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {item.body}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-md border border-border/20 p-3">
            <div className="text-sm font-medium">Motion standard</div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Default motion should be 150–200ms, ease-out, and tied to a real
              change: hover color, chevron rotation, loading feedback, or
              spatial continuity. No decorative bounce. No delayed content. No
              motion that hides latency.
            </p>
          </div>
        </DesignSection>

        <DesignSection
          number="10"
          eyebrow="Components"
          title="Component exemplars"
        >
          <div className="grid gap-6 @lg:grid-cols-3">
            <div className="space-y-3">
              <div className="text-sm font-medium">Buttons</div>
              <Button className="w-full bg-cta text-cta-foreground hover:bg-cta/85 hover:shadow-md">
                Primary CTA
              </Button>
              <Button
                className="w-full border border-cta bg-transparent text-cta hover:border-active hover:text-active"
                variant="outline"
              >
                Secondary CTA
              </Button>
              <Button
                className="w-full border border-border bg-secondary hover:bg-accent hover:text-accent-foreground"
                variant="secondary"
              >
                Neutral secondary
              </Button>
              <Button className="w-full" variant="ghost">
                Quiet action
              </Button>
              <p className="text-xs text-muted-foreground">
                Use shared component primitives. Do not create local visual variants by taste.
              </p>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Inputs</div>
              <Label htmlFor="design-example-input">Label</Label>
              <Input
                id="design-example-input"
                value="Implementation-ready copy"
                readOnly
              />
              <div className="text-xs text-muted-foreground">
                Inputs are quiet until focused. Labels stay explicit.
              </div>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Checkboxes</div>
                {[
                  { label: "Pending step", state: "pending" },
                  { label: "Completed step", state: "complete" },
                  { label: "Running step", state: "running" },
                  { label: "Blocked step", state: "blocked" },
                  { label: "Needs review", state: "review" },
                ].map((item) => (
                  <div
                    key={item.state}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        item.state === "pending" &&
                          "border-transparent bg-transparent text-muted-foreground",
                        item.state === "complete" &&
                          "border-transparent bg-transparent text-success",
                        item.state === "running" &&
                          "border-transparent bg-transparent text-active",
                        item.state === "blocked" &&
                          "border-error bg-error/10 text-error",
                        item.state === "review" &&
                          "border-foreground/70 bg-foreground/10 text-foreground shadow-[0_0_0_1px_hsl(var(--foreground)/0.12)]",
                      )}
                    >
                      {item.state === "pending" && (
                        <Circle className="h-4 w-4" />
                      )}
                      {item.state === "complete" && (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      {item.state === "running" && (
                        <span className="inline-flex shrink-0 animate-pulse text-active">
                          <Loader2 className="h-4 w-4 animate-spin" />
                        </span>
                      )}
                      {item.state === "blocked" && (
                        <OctagonAlert className="h-3 w-3" />
                      )}
                      {item.state === "review" && (
                        <MailOpen className="h-3 w-3" />
                      )}
                    </span>
                    <span
                      className={cn(
                        item.state === "review" &&
                          "font-medium text-foreground",
                        item.state === "blocked" && "text-error",
                      )}
                    >
                      {item.label}
                    </span>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Pending outlines use foreground opacity, not border-border.
                  Needs Review follows unread emphasis.
                </p>
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium">Badges</div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">Object type</Badge>
                <Badge variant="secondary">Category</Badge>
                <Badge
                  variant="outline"
                  className="border-success/30 bg-success/10 text-success"
                >
                  Lifecycle: complete
                </Badge>
                <Badge variant="destructive">Lifecycle: failed</Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Badges describe durable object attributes, not read-only metadata.
                Plain text for config values, scores, and parameters.
              </p>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="11"
          eyebrow="Status"
          title="Icon-as-status language"
        >
          <div className="grid gap-6 @lg:grid-cols-[1fr_0.85fr]">
            <div className="grid gap-2">
              {statusExamples.map((item) => {
                const Icon = item.icon;
                const isActive = item.level === "active";
                return (
                  <div
                    key={item.level}
                    className="flex flex-col gap-1.5 rounded-md border border-border/20 p-3 @sm:flex-row @sm:items-center @sm:gap-4"
                  >
                    <div className="font-mono text-xs text-muted-foreground @sm:w-[80px] @sm:shrink-0">
                      {item.level}
                    </div>
                    <div
                      className={cn(
                        "flex items-center gap-3",
                        item.token,
                        isActive && "animate-pulse",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          isActive && "animate-spin",
                        )}
                      />
                      <div>
                        <div className="text-sm font-medium">{item.label}</div>
                        <div
                          className={cn(
                            "text-xs",
                            isActive
                              ? "text-active/80"
                              : "text-muted-foreground",
                          )}
                        >
                          {item.detail}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div>
              <div className="text-sm font-medium">Cascade rule</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Status is carried by the existing icon and label. No extra dots,
                circles, decorative badges, or competing color markers. Show
                exactly one: error → active → pinned → unread.
              </p>
              <div className="mt-4 flex items-start gap-2 rounded-md border border-border/20 p-3 text-error">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Selected but still failed
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Selected rows preserve status color.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </DesignSection>

        <DesignSection number="12" eyebrow="Icons" title="Iconography rules">
          <div className="grid gap-4 grid-cols-2 @md:grid-cols-4">
            {[
              {
                icon: Palette,
                label: "Semantic",
                rule: "One Lucide icon anchors one concept. Not decoration.",
              },
              {
                icon: Type,
                label: "Labeled",
                rule: "Nav and ambiguous actions pair icons with text.",
              },
              {
                icon: Ruler,
                label: "Sized",
                rule: "h-4 controls, h-5 panels, h-6 empty states.",
              },
              {
                icon: LayoutGrid,
                label: "Consistent",
                rule: "No mixed icon families. No filled/outline drift.",
              },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.label}
                  className="space-y-2"
                >
                  <Icon className="h-5 w-5 text-foreground" />
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    {item.rule}
                  </div>
                </div>
              );
            })}
          </div>
        </DesignSection>

        <DesignSection
          number="13"
          eyebrow="References"
          title="Typed reference links"
        >
          <div className="grid gap-6 @lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-3">
              {referenceExamples.map((item) => {
                return (
                  <div
                    key={item.canonical}
                    className="flex flex-col gap-2 overflow-hidden rounded-md border border-border/20 p-3 @md:flex-row @md:items-center @md:gap-4"
                  >
                    <ReferenceRenderer
                      refValue={{ type: item.type, id: item.canonical.slice(item.canonical.indexOf(":") + 1), canonical: item.canonical }}
                      surface="inline"
                      className="mx-0"
                    />
                    <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-muted px-2 py-1 font-mono text-[11px]">
                      {item.canonical}
                    </code>
                  </div>
                );
              })}
              <div className="flex items-center gap-3 p-3">
                <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="border-b border-current leading-tight">
                    Missing reference
                  </span>
                </span>
                <p className="text-xs text-muted-foreground">
                  Degraded references stay legible and neutral.
                </p>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium">Reference doctrine</div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
                <li>
                  <span className="text-foreground">Canonical:</span> emit{" "}
                  <code className="rounded bg-muted px-1 font-mono">
                    @type:id
                  </code>{" "}
                  when the ID is known.
                </li>
                <li>
                  <span className="text-foreground">Rendering:</span> use the shared parser and ReferenceRenderer so every registered type gets the current inline treatment.
                </li>
                <li>
                  <span className="text-foreground">Resolved:</span> references are compact inline links with their type icon and current object label.
                </li>
                <li>
                  <span className="text-foreground">Actionable:</span>{" "}
                  intentions may render richer controls instead of a generic
                  chip.
                </li>
                <li>
                  <span className="text-foreground">Wellness:</span> use{" "}
                  <code className="rounded bg-muted px-1 font-mono">
                    @wellness_activity:id
                  </code>
                  ;{" "}
                  <code className="rounded bg-muted px-1 font-mono">
                    @health_activity:id
                  </code>{" "}
                  aliases during migration.
                </li>
                <li>
                  <span className="text-foreground">Priorities:</span> use{" "}
                  <code className="rounded bg-muted px-1 font-mono">
                    @priority:period:date:id
                  </code>{" "}
                  for daily, next_day, weekly, next_week, monthly, and
                  next_month items.
                </li>
                <li>
                  <span className="text-foreground">Not decoration:</span>{" "}
                  reference links are object links and provenance, not visual
                  confetti.
                </li>
              </ul>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="15"
          eyebrow="Scrollbars"
          title="Invisible until scrolling"
        >
          <div className="grid gap-6 @lg:grid-cols-[1fr_0.9fr]">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">
                    Canonical scroll region
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Scroll the region to reveal the 3px thumb.
                  </div>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">
                  scrollbar-thin
                </Badge>
              </div>
              <div className="max-h-44 overflow-y-auto scrollbar-thin rounded-md border border-border/30 p-3 pr-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={index}
                    className="mb-1.5 rounded border border-border/20 px-2 py-1.5 last:mb-0"
                  >
                    <div className="text-sm">
                      Scrollable item {index + 1}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium">Scrollbar doctrine</div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
                <li>
                  <span className="text-foreground">Width:</span> 3px vertical
                  and horizontal everywhere.
                </li>
                <li>
                  <span className="text-foreground">Rest:</span> thumb and track
                  are transparent.
                </li>
                <li>
                  <span className="text-foreground">Reveal:</span> active
                  scrolling shows the thumb.
                </li>
                <li>
                  <span className="text-foreground">Hide:</span> the thumb
                  auto-hides shortly after scrolling stops.
                </li>
                <li>
                  <span className="text-foreground">No one-offs:</span>{" "}
                  component files must not define custom scrollbar CSS.
                </li>
                <li>
                  <span className="text-foreground">Alias:</span> scrollbar-hide
                  now shares the same active-scrolling behavior for legacy tab strips.
                </li>
              </ul>
            </div>
          </div>
        </DesignSection>

        <DesignSection number="16" eyebrow="Guardrails" title="Do and don't">
          <div className="grid gap-4 @lg:grid-cols-2">
            <DoDontCard kind="do" title="Do use the system">
              <div className="space-y-3">
                <div className="rounded-md border border-border/30 bg-card p-3">
                  <div className="text-sm font-medium">Clear hierarchy</div>
                  <div className="text-xs text-muted-foreground">
                    One title, one action, quiet metadata.
                  </div>
                </div>
              </div>
            </DoDontCard>
            <DoDontCard kind="dont" title="Don't improvise decoration">
              <div className="space-y-3 opacity-80">
                <div className="rounded-2xl border-2 border-dashed border-error/50 bg-gradient-to-r from-link/20 to-warning/20 p-3 shadow-xl">
                  <div className="text-sm font-bold uppercase tracking-widest">
                    Too many signals
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Arbitrary color, radius, shadow, and emphasis compete.
                  </div>
                </div>
                <div className="rounded-md border border-error/30 bg-error/5 p-3">
                  <div className="text-sm font-medium text-error">
                    Persistent subtitle
                  </div>
                  <div className="text-xs text-muted-foreground">
                    If the UI needs this explanation under its title, redesign
                    the surface or use a tooltip at the point of need.
                  </div>
                </div>
              </div>
            </DoDontCard>
          </div>
        </DesignSection>

        <DesignSection
          number="17"
          eyebrow="Access"
          title="Accessibility exemplars"
        >
          <div className="grid gap-6 grid-cols-2 @lg:grid-cols-4">
            <div className="space-y-3">
              <Button
                variant="outline"
                className="w-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Visible focus
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Keyboard focus is visible and tokenized.
              </p>
            </div>
            <div className="space-y-3">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh design examples"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Icon-only controls require aria labels.
              </p>
            </div>
            <div className="space-y-3">
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-warning">
                Contrast-safe warning
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Semantic tints use readable foreground tokens.
              </p>
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled>
                  Disabled
                </Button>
                <Button size="sm" variant="outline">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Loading
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Disabled is dormant. Loading is active and explained.
              </p>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="18"
          eyebrow="Doctrine"
          title="Design roles and scopes"
        >
          <div className="grid gap-6 @lg:grid-cols-2">
            <div>
              <div className="text-sm font-medium">
                Action and attention roles
              </div>
              <div className="mt-3 grid gap-1.5 text-xs leading-relaxed text-muted-foreground">
                {[
                  ["CTA", "Do this now", "Blue"],
                  ["Link/reference", "Go to object", "CTA outline/text"],
                  ["Active", "Running now", "Lighter CTA blue"],
                  ["Needs attention", "Human should notice", "Foreground"],
                  ["Error", "Failed or destructive", "Red"],
                ].map(([role, means, color]) => (
                  <div
                    key={role}
                    className="flex flex-col gap-0.5 rounded border border-border/20 px-2 py-1.5 @sm:flex-row @sm:items-center @sm:gap-3"
                  >
                    <span className="font-medium text-foreground @sm:w-[100px] @sm:shrink-0">{role}</span>
                    <span className="text-xs @sm:flex-1 @sm:text-inherit">{means}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em]">
                      {color}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm font-medium">Scope language</div>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
                <li>
                  <span className="text-foreground">Screen:</span> full
                  route/page or modal-level workflow.
                </li>
                <li>
                  <span className="text-foreground">Viewport:</span> currently
                  visible part of the screen; never show two primary CTAs here.
                </li>
                <li>
                  <span className="text-foreground">Region:</span> contained
                  card/panel/module; normally secondary hierarchy only.
                </li>
                <li>
                  <span className="text-foreground">Decision surface:</span>{" "}
                  isolated moment where the user chooses the next meaningful
                  action.
                </li>
              </ul>
            </div>
          </div>
        </DesignSection>

        <DesignSection
          number="19"
          eyebrow="Audit"
          title="Application suite rubric"
        >
          <div className="grid gap-2 @sm:grid-cols-2 @lg:grid-cols-4">
            {auditRules.map((rule) => (
              <div
                key={rule}
                className="flex gap-2 rounded-md border border-border/20 p-2.5"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
                <span className="text-xs leading-relaxed">{rule}</span>
              </div>
            ))}
          </div>
        </DesignSection>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TABS = [
  "history",
  "issues",
  "prompts",
] as const;
type DevTab = (typeof VALID_TABS)[number];

function normalizeTab(raw: string | null | undefined): DevTab {
  if (!raw) return "history";
  // Legacy tab redirects
  if (raw === "deployments" || raw === "logs" || raw === "version") return "history";
  if ((VALID_TABS as readonly string[]).includes(raw)) return raw as DevTab;
  return "history";
}

function parseInitialTab(): DevTab {
  if (typeof window === "undefined") return "history";
  const t = new URLSearchParams(window.location.search).get("tab");
  return normalizeTab(t);
}


export function DatabasePage() {
  const [cleanseOpen, setCleanseOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [browseDataOpen, setBrowseDataOpen] = useState(true);
  const [migrationOpen, setMigrationOpen] = useState(true);
  const { toast } = useToast();
  const [databasePageRef, isDatabaseNarrow] = useNarrowContainer<HTMLDivElement>(760);
  const { data: status } = useDevStatus();
  const { data: dbSyncState } = useDbSyncStatus();

  const isConfigured =
    !!status && "configured" in status && status.configured === true;
  const dep = isConfigured ? (status as DevStatusOk).deployment : undefined;
  const isDevRunning = statusFamily(dep?.status) === "running";

  usePageHeader({ title: "Database" });

  const handlePurgeEvents = async () => {
    setPurging(true);
    try {
      const res = await apiRequest("POST", "/api/admin/purge-events", {});
      const data = await res.json();
      toast({
        title: "Purge complete",
        description: `Deleted ${(data.deleted ?? 0).toLocaleString()} events older than 7 days.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/info/db/size"] });
    } catch (err: any) {
      toast({
        title: "Purge failed",
        description: err.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="database-page">
      <div
        ref={databasePageRef}
        className={cn("flex-1 min-h-0 overflow-auto", isDatabaseNarrow ? "p-3" : "p-4")}
        data-testid="database-page-content"
      >
        <div className="space-y-4">
          <BackupPanel />
          <section className="space-y-2">
            <div className={cn("flex gap-3 px-1", isDatabaseNarrow ? "flex-col" : "items-center justify-between")}>
              <button
                type="button"
                className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
                onClick={() => setBrowseDataOpen(v => !v)}
                aria-expanded={browseDataOpen}
              >
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", browseDataOpen && "rotate-90")} />
                <span>DATA</span>
              </button>
              {browseDataOpen && <div className={cn("grid gap-1", isDatabaseNarrow ? "w-full grid-cols-1" : "w-auto shrink-0 grid-cols-2")}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handlePurgeEvents}
                  disabled={purging}
                >
                  {purging ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Eraser className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>Purge Events</span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80"
                  onClick={() => setCleanseOpen(true)}
                >
                  <Eraser className="h-3.5 w-3.5 shrink-0" />
                  <span>Cleanse</span>
                </button>
              </div>}
            </div>
            {browseDataOpen && <div className="pl-5">
              <DatabaseDataBrowser />
            </div>}
          </section>
          <section className="space-y-2">
            <div className="flex gap-3 px-1">
              <button
                type="button"
                className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
                onClick={() => setMigrationOpen(v => !v)}
                aria-expanded={migrationOpen}
              >
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", migrationOpen && "rotate-90")} />
                <span>MIGRATION</span>
              </button>
            </div>
            {migrationOpen && <div className="pl-5">
              <DatabasePanel
                syncState={dbSyncState}
                isDevRunning={isDevRunning}
                embedded
              />
            </div>}
          </section>
        </div>
        <CleanseModal open={cleanseOpen} onOpenChange={setCleanseOpen} />
      </div>
    </div>
  );
}

export default function DevPage() {
  const initial = useMemo(parseInitialTab, []);
  const [activeTab, setActiveTab] = useState<DevTab>(initial);

  // Canonicalize legacy URLs (?tab=config, ?tab=home, unknown values) on
  // first paint so the address bar matches the rendered tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URLSearchParams(window.location.search).get("tab");
    if (raw !== initial) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", initial);
      window.history.replaceState({}, "", url.toString());
    }
    // Run once on mount; `initial` is stable from useMemo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    data: status,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useDevStatus();
  // Top-level tabs. Environment deployment controls live on canonical Platform Environment pages; database tooling lives at /database.
  const tabs = useMemo(
    () => [
      {
        value: "prompts",
        label: "Prompts",
        icon: <FileText className="h-4 w-4" />,
        testId: "tab-prompts",
      },
      {
        value: "history",
        label: "History",
        icon: <History className="h-4 w-4" />,
        testId: "tab-history",
      },
      {
        value: "issues",
        label: "Issues",
        icon: <CircleDot className="h-4 w-4" />,
        testId: "tab-issues",
      },
    ],
    [],
  );

  // Update URL ?tab= so deep links + back button work.
  const writeUrlTab = useCallback((value: string) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const handleTabChange = useCallback(
    (tab: string) => {
      const next = normalizeTab(tab);
      setActiveTab(next);
      writeUrlTab(next);
    },
    [writeUrlTab],
  );

  usePageHeader({
    title: "Build",
    tabs,
    activeTab,
    onTabChange: handleTabChange,
  });

  // First-load skeleton (no data yet, still fetching).
  if (isLoading && !status) {
    return (
      <div className="flex flex-col h-full" data-testid="dev-loading">
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Runtime identity and hosting credentials resolve through the canonical Platform Environment binding.
  if (!status) {
    return (
      <div className="flex h-full flex-col" data-testid="dev-error">
        <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-sm text-warning">
          <span className="flex-1">
            Couldn't resolve this runtime's Platform Environment: {" "}
            {(error as Error)?.message ?? "unknown error"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-retry-page"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry"}
          </Button>
        </div>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Configure or repair the environment's hosting binding in Platforms.
        </p>
      </div>
    );
  }

  const okStatus = status;
  return (
    <div className="flex flex-col h-full min-h-0" data-testid="dev-page">
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === "prompts" && (
          <div
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
            data-testid="tab-content-prompts"
          >
            <InternalPromptsTab />
          </div>
        )}
        {activeTab === "history" && (
          <div
            className="flex-1 min-h-0 flex flex-col gap-6 p-4 overflow-auto"
            data-testid="tab-content-history"
          >
            <VersionTimeline />
            <div>
              <h2 className="text-base font-semibold mb-3">Deployments</h2>
              <DeploymentsTable status={okStatus} />
            </div>
          </div>
        )}
        {activeTab === "issues" && (
          <div
            className="flex-1 min-h-0 flex flex-col p-4 overflow-auto"
            data-testid="tab-content-issues"
          >
            <IssuesTab />
          </div>
        )}
      </div>
    </div>
  );
}
