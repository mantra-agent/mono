// Use createLogger for logging ONLY
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2,
  FileText,
  Folder,
  ChevronRight,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { hexToRgba } from "@/lib/vault-title-color";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { createLogger } from "@/lib/logger";

/**
 * Connector tree primitive for vault-bound provider resources.
 *
 * Data plane: browse bound roots, drill folders, open provider links.
 * Semantic index policy: row toggles + durable run progress live here.
 * Connector management (connect / bind / unbind / share) stays on Integrations.
 */

const log = createLogger("client:FilesIndex");

export interface DriveResource {
  id: string;
  provider: "google" | "box" | "mantra";
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
}

export interface FilesChild {
  provider: "google" | "box" | "mantra";
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
  driveResourceId: string | null;
  viaFolderBind: boolean;
}

export type FileIndexUiStatus =
  | "off"
  | "self"
  | "recursive"
  | "inherited"
  | "indexing"
  | "stale"
  | "unsupported"
  | "error"
  | "retired";

export type FileIndexRunPhase =
  | "queued"
  | "discovering"
  | "indexing"
  | "complete"
  | "partial"
  | "failed"
  | "canceled";

export interface FileIndexRun {
  id: string;
  policyId: string;
  rootDriveResourceId: string;
  vaultId: string;
  phase: FileIndexRunPhase;
  foldersVisited: number;
  filesDiscovered: number;
  filesEligible: number;
  filesCompleted: number;
  filesUnchanged: number;
  filesUnsupported: number;
  filesFailed: number;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface FileIndexStatus {
  driveResourceId: string;
  resourceType: "file" | "folder";
  vaultId: string;
  mode: "off" | "self" | "recursive";
  policyId: string | null;
  indexedSource: {
    id: string;
    discoveryState: string;
    rootDriveResourceId: string | null;
    name: string;
    oneLiner?: string | null;
    summary?: string | null;
  } | null;
  reconciliationRun: FileIndexRun | null;
  status: FileIndexUiStatus;
}

const ACTIVE_RUN_PHASES = new Set<FileIndexRunPhase>([
  "queued",
  "discovering",
  "indexing",
]);

const COMPLETION_HOLD_MS = 8_000;

function isPdfResource(resource: {
  name: string;
  mimeType: string | null;
}): boolean {
  const mime = (resource.mimeType || "").toLowerCase();
  if (mime === "application/pdf" || mime.includes("pdf")) return true;
  return resource.name.toLowerCase().endsWith(".pdf");
}

function providerOpenLabel(provider: "google" | "box" | "mantra"): string {
  if (provider === "box") return "Open in Box";
  if (provider === "mantra") return "Open source";
  return "Open in Google";
}

function pdfViewerHref(args: {
  id: string;
  source: "drive_resource" | "provider";
  vaultId?: string;
  provider?: "google" | "box" | "mantra";
  providerFileId?: string;
  webViewLink?: string | null;
}): string {
  const params = new URLSearchParams({ source: args.source });
  if (args.vaultId) params.set("vaultId", args.vaultId);
  if (args.provider) {
    params.set("provider", args.provider);
    params.set("providerLabel", providerOpenLabel(args.provider));
  }
  if (args.webViewLink) params.set("providerHref", args.webViewLink);
  const routeId =
    args.source === "provider" && args.providerFileId
      ? args.providerFileId
      : args.id;
  return `/documents/${encodeURIComponent(routeId)}?${params.toString()}`;
}

export function resourceIcon(r: { resourceType: "file" | "folder" }) {
  return r.resourceType === "folder" ? (
    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
  );
}

function titleStyleForVault(vaultColor?: string | null): CSSProperties | undefined {
  if (!vaultColor) return undefined;
  const color = hexToRgba(vaultColor, 1) ?? vaultColor;
  return { color };
}

/** File/folder title — PDFs open in-product; other files keep provider links. */
function ResourceTitle({
  name,
  href,
  titleStyle,
  onOpen,
}: {
  name: string;
  href: string | null;
  titleStyle?: CSSProperties;
  onOpen?: (event: MouseEvent) => void;
}) {
  const className = "min-h-11 min-w-0 flex-1 truncate text-left text-sm leading-[44px]";
  if (onOpen) {
    return (
      <button
        type="button"
        className={cn(className, "hover:underline")}
        style={titleStyle}
        title={name}
        onClick={onOpen}
      >
        {name}
      </button>
    );
  }
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(className, "hover:underline")}
        style={titleStyle}
        title={name}
      >
        {name}
      </a>
    );
  }
  return (
    <span className={className} style={titleStyle} title={name}>
      {name}
    </span>
  );
}

function ExternalOpenLink({
  href,
  label,
}: {
  href: string | null;
  label: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function formatIndexStatusLabel(status: FileIndexUiStatus | undefined): string | null {
  switch (status) {
    case "self":
    case "recursive":
      return "Indexed";
    case "inherited":
      return "Indexed by folder";
    case "indexing":
      return "Indexing";
    case "stale":
      return "Stale";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Error";
    default:
      return null;
  }
}

function statusToneClass(status: FileIndexUiStatus | undefined): string {
  switch (status) {
    case "indexing":
      return "text-active";
    case "error":
      return "text-destructive";
    case "stale":
      return "text-warning";
    case "unsupported":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

export function isRunActive(run: FileIndexRun | null | undefined): boolean {
  return !!run && ACTIVE_RUN_PHASES.has(run.phase);
}

export function formatRunProgressLabel(run: FileIndexRun): string {
  if (run.phase === "queued" || run.phase === "discovering") {
    return `Discovering · ${run.filesDiscovered} files found`;
  }
  if (run.phase === "indexing") {
    const total = Math.max(run.filesEligible, run.filesDiscovered, 0);
    const done = Math.min(run.filesCompleted + run.filesUnchanged, total || run.filesCompleted);
    if (total > 0) return `Indexing · ${done} of ${total} files`;
    return `Indexing · ${run.filesCompleted} files`;
  }
  if (run.phase === "partial" || (run.phase === "failed" && run.filesFailed > 0)) {
    const indexed = run.filesCompleted + run.filesUnchanged;
    return `Indexed with ${run.filesFailed} error${run.filesFailed === 1 ? "" : "s"} · ${indexed} ok`;
  }
  if (run.phase === "complete" || run.phase === "partial") {
    const parts = [`Indexed ${run.filesCompleted + run.filesUnchanged} files`];
    if (run.filesUnchanged > 0) parts.push(`${run.filesUnchanged} unchanged`);
    if (run.filesUnsupported > 0) parts.push(`${run.filesUnsupported} unsupported`);
    if (run.filesFailed > 0) parts.push(`${run.filesFailed} failed`);
    return parts.join(" · ");
  }
  if (run.phase === "failed") {
    return run.lastError ? `Indexing failed · ${run.lastError}` : "Indexing failed";
  }
  if (run.phase === "canceled") return "Indexing canceled";
  return "Indexing";
}

export function runProgressPercent(run: FileIndexRun): number | null {
  if (run.phase !== "indexing") return null;
  const total = Math.max(run.filesEligible, run.filesDiscovered, 0);
  if (total <= 0) return null;
  const done = Math.min(run.filesCompleted + run.filesUnchanged, total);
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export function aggregateIndexRuns(statuses: FileIndexStatus[]): {
  phase: "idle" | "discovering" | "indexing" | "settling" | "error";
  label: string;
  percent: number | null;
  retryRunId: string | null;
  retryVaultId: string | null;
} {
  const runs = statuses
    .map((s) => s.reconciliationRun)
    .filter((r): r is FileIndexRun => !!r);

  const active = runs.filter((r) => isRunActive(r));
  if (active.length > 0) {
    const discovering = active.some(
      (r) => r.phase === "queued" || r.phase === "discovering",
    );
    if (discovering) {
      const found = active.reduce((n, r) => n + (r.filesDiscovered || 0), 0);
      return {
        phase: "discovering",
        label: `Discovering · ${found} files found`,
        percent: null,
        retryRunId: null,
        retryVaultId: null,
      };
    }
    const completed = active.reduce(
      (n, r) => n + (r.filesCompleted || 0) + (r.filesUnchanged || 0),
      0,
    );
    const eligible = active.reduce(
      (n, r) => n + Math.max(r.filesEligible || 0, r.filesDiscovered || 0),
      0,
    );
    const percent =
      eligible > 0
        ? Math.max(0, Math.min(100, Math.round((completed / eligible) * 100)))
        : null;
    return {
      phase: "indexing",
      label:
        eligible > 0
          ? `Indexing · ${completed} of ${eligible} files`
          : `Indexing · ${completed} files`,
      percent,
      retryRunId: null,
      retryVaultId: null,
    };
  }

  const failed = runs.filter(
    (r) =>
      (r.phase === "partial" || r.phase === "failed") && (r.filesFailed || 0) > 0,
  );
  if (failed.length > 0) {
    const errors = failed.reduce((n, r) => n + (r.filesFailed || 0), 0);
    const first = failed[0]!;
    return {
      phase: "error",
      label: `Indexed with ${errors} error${errors === 1 ? "" : "s"}`,
      percent: 100,
      retryRunId: first.id,
      retryVaultId: first.vaultId,
    };
  }

  const recentComplete = runs
    .filter((r) => r.phase === "complete" && r.completedAt)
    .sort((a, b) => {
      const at = a.completedAt ? Date.parse(a.completedAt) : 0;
      const bt = b.completedAt ? Date.parse(b.completedAt) : 0;
      return bt - at;
    })[0];
  if (recentComplete?.completedAt) {
    const age = Date.now() - Date.parse(recentComplete.completedAt);
    if (Number.isFinite(age) && age >= 0 && age < COMPLETION_HOLD_MS) {
      return {
        phase: "settling",
        label: formatRunProgressLabel(recentComplete),
        percent: 100,
        retryRunId: null,
        retryVaultId: null,
      };
    }
  }

  return {
    phase: "idle",
    label: "",
    percent: null,
    retryRunId: null,
    retryVaultId: null,
  };
}

export function useVaultIndexStatuses(vaultId: string | undefined) {
  return useQuery<{ statuses: FileIndexStatus[] }>({
    queryKey: ["/api/files/index/status", vaultId],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/files/index/status?vaultId=${encodeURIComponent(vaultId!)}`,
      );
      return res.json();
    },
    enabled: !!vaultId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const statuses = query.state.data?.statuses ?? [];
      const hasActive = statuses.some((s) => isRunActive(s.reconciliationRun));
      const hasFreshComplete = statuses.some((s) => {
        const run = s.reconciliationRun;
        if (!run?.completedAt || run.phase !== "complete") return false;
        const age = Date.now() - Date.parse(run.completedAt);
        return Number.isFinite(age) && age >= 0 && age < COMPLETION_HOLD_MS;
      });
      return hasActive || hasFreshComplete ? 2_500 : false;
    },
  });
}

function useIndexToggle(vaultId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { driveResourceId: string; enabled: boolean }) => {
      const res = await apiRequest("POST", "/api/files/index/toggle", input);
      return (await res.json()) as { status: FileIndexStatus };
    },
    onSuccess: (data) => {
      log.debug("index toggle ok", {
        driveResourceId: data.status.driveResourceId,
        status: data.status.status,
        mode: data.status.mode,
      });
      queryClient.setQueryData<{ statuses: FileIndexStatus[] }>(
        ["/api/files/index/status", vaultId],
        (prev) => {
          const list = prev?.statuses ?? [];
          const next = list.filter(
            (s) => s.driveResourceId !== data.status.driveResourceId,
          );
          next.push(data.status);
          return { statuses: next };
        },
      );
      void queryClient.invalidateQueries({
        queryKey: ["/api/files/index/status", vaultId],
      });
    },
    onError: (err: Error) => {
      log.error("index toggle failed", err.message);
    },
  });
}

function useRetryFailedRun(vaultId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest(
        "POST",
        `/api/files/index/runs/${encodeURIComponent(runId)}/retry-failed`,
      );
      return (await res.json()) as { status: FileIndexStatus };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/files/index/status", vaultId],
      });
    },
    onError: (err: Error) => {
      log.error("index retry failed", err.message);
    },
  });
}

function IndexStatusLabel({ status }: { status?: FileIndexUiStatus }) {
  const label = formatIndexStatusLabel(status);
  if (!label) return null;
  return (
    <span
      className={cn("shrink-0 text-xs", statusToneClass(status))}
      data-testid="files-index-status"
    >
      {label}
    </span>
  );
}

function IndexToggle({
  vaultId,
  driveResourceId,
  status,
  disabled,
}: {
  vaultId: string;
  driveResourceId: string | null | undefined;
  status?: FileIndexStatus;
  disabled?: boolean;
}) {
  const toggle = useIndexToggle(vaultId);
  if (!driveResourceId) {
    // Discovered children without an explicit bind cannot own a local policy in v1.
    return null;
  }
  const checked =
    status?.mode === "self" ||
    status?.mode === "recursive" ||
    status?.status === "indexing";
  return (
    <Switch
      checked={!!checked}
      disabled={disabled || toggle.isPending}
      onCheckedChange={(next) => {
        toggle.mutate({ driveResourceId, enabled: next });
      }}
      aria-label={checked ? "Disable indexing" : "Enable indexing"}
      className="shrink-0 scale-90"
      data-testid="files-index-toggle"
    />
  );
}

function RowProgress({
  vaultId,
  run,
}: {
  vaultId: string;
  run: FileIndexRun | null | undefined;
}) {
  const retry = useRetryFailedRun(vaultId);
  const [holdComplete, setHoldComplete] = useState(false);

  useEffect(() => {
    if (!run?.completedAt || run.phase !== "complete") {
      setHoldComplete(false);
      return;
    }
    const age = Date.now() - Date.parse(run.completedAt);
    if (!Number.isFinite(age) || age < 0 || age >= COMPLETION_HOLD_MS) {
      setHoldComplete(false);
      return;
    }
    setHoldComplete(true);
    const t = window.setTimeout(() => setHoldComplete(false), COMPLETION_HOLD_MS - age);
    return () => window.clearTimeout(t);
  }, [run?.id, run?.phase, run?.completedAt]);

  if (!run) return null;
  const active = isRunActive(run);
  const showError =
    (run.phase === "partial" || run.phase === "failed") && (run.filesFailed || 0) > 0;
  if (!active && !showError && !holdComplete) return null;

  const percent = runProgressPercent(run);
  const indeterminate = active && (run.phase === "queued" || run.phase === "discovering");

  return (
    <div
      className="mt-1 flex flex-col gap-1 px-2"
      style={{ paddingLeft: 28 }}
      data-testid="files-index-row-progress"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{formatRunProgressLabel(run)}</span>
        {showError && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-cta"
            disabled={retry.isPending}
            onClick={() => retry.mutate(run.id)}
          >
            {retry.isPending ? "Retrying…" : "Retry failed"}
          </Button>
        )}
      </div>
      {(active || holdComplete) && (
        <div className="relative">
          <Progress
            value={indeterminate ? undefined : percent ?? (holdComplete ? 100 : 0)}
            className={cn("h-1.5", indeterminate && "animate-pulse")}
          />
          {indeterminate && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
              <div className="h-full w-1/3 animate-pulse bg-active/60" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FilesIndexProgressBanner({
  statuses,
}: {
  statuses: FileIndexStatus[];
}) {
  const agg = useMemo(() => aggregateIndexRuns(statuses), [statuses]);
  const retry = useRetryFailedRun(agg.retryVaultId ?? "");

  if (agg.phase === "idle") return null;

  return (
    <div
      className="mb-3 rounded-md border border-border bg-card px-3 py-2"
      data-testid="files-index-progress-banner"
    >
      <div className="flex items-center gap-2 text-sm">
        {agg.phase === "discovering" || agg.phase === "indexing" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-active" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{agg.label}</span>
        {agg.phase === "error" && agg.retryRunId && agg.retryVaultId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-cta"
            disabled={retry.isPending}
            onClick={() => retry.mutate(agg.retryRunId!)}
          >
            {retry.isPending ? "Retrying…" : "Retry failed"}
          </Button>
        ) : null}
      </div>
      {(agg.phase === "discovering" ||
        agg.phase === "indexing" ||
        agg.phase === "settling") && (
        <div className="relative mt-2">
          <Progress
            value={
              agg.phase === "discovering"
                ? undefined
                : agg.percent ?? (agg.phase === "settling" ? 100 : 0)
            }
            className={cn("h-1.5", agg.phase === "discovering" && "animate-pulse")}
          />
          {agg.phase === "discovering" && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
              <div className="h-full w-1/3 animate-pulse bg-active/60" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Recursively lists the children of a bound folder. */
function FolderChildren({
  vaultId,
  driveResourceId,
  provider,
  providerFileId,
  rootDriveResourceId,
  depth,
  vaultColor,
  statusByResourceId,
}: {
  vaultId: string;
  driveResourceId?: string;
  provider?: "google" | "box" | "mantra";
  providerFileId?: string;
  rootDriveResourceId: string;
  depth: number;
  vaultColor?: string | null;
  statusByResourceId: Map<string, FileIndexStatus>;
}) {
  const [, setLocation] = useLocation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const titleStyle = titleStyleForVault(vaultColor);

  const childrenQuery = useQuery<{ children: FilesChild[]; nextPageToken: string | null }>({
    queryKey: [
      "/api/files/children",
      vaultId,
      driveResourceId ?? null,
      provider ?? null,
      providerFileId ?? null,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ vaultId });
      if (driveResourceId) params.set("driveResourceId", driveResourceId);
      if (provider) params.set("provider", provider);
      if (providerFileId) params.set("providerFileId", providerFileId);
      const res = await apiRequest("GET", `/api/files/children?${params.toString()}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  if (childrenQuery.isLoading) {
    return (
      <div
        className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: 12 + depth * 12 }}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> Loading…
      </div>
    );
  }
  if (childrenQuery.isError) {
    return (
      <div className="py-1 text-xs text-destructive" style={{ paddingLeft: 12 + depth * 12 }}>
        {(childrenQuery.error as Error)?.message || "Failed to list folder"}
      </div>
    );
  }

  const children = childrenQuery.data?.children ?? [];
  if (children.length === 0) {
    return (
      <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: 12 + depth * 12 }}>
        Empty folder
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {children.map((c) => {
        const key = c.providerFileId;
        const isOpen = !!expanded[key];
        const isFolder = c.resourceType === "folder";
        const isPdf = !isFolder && isPdfResource(c);
        const status = c.driveResourceId
          ? statusByResourceId.get(c.driveResourceId)
          : undefined;
        const openPdf = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (c.driveResourceId) {
            setLocation(
              pdfViewerHref({
                id: c.driveResourceId,
                source: "drive_resource",
                vaultId,
                provider: c.provider,
                webViewLink: c.webViewLink,
              }),
            );
            return;
          }
          setLocation(
            pdfViewerHref({
              id: c.providerFileId,
              source: "provider",
              vaultId,
              provider: c.provider,
              providerFileId: c.providerFileId,
              webViewLink: c.webViewLink,
            }),
          );
        };
        return (
          <li key={key}>
            <div
              className="group flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {resourceIcon(c)}
              <ResourceTitle
                name={c.name}
                href={isPdf ? null : c.webViewLink}
                titleStyle={titleStyle}
                onOpen={isPdf ? openPdf : undefined}
              />
              {isPdf ? (
                <ExternalOpenLink href={c.webViewLink} label={providerOpenLabel(c.provider)} />
              ) : null}
              <IndexStatusLabel status={status?.status} />
              <IndexToggle
                vaultId={vaultId}
                driveResourceId={c.driveResourceId}
                status={status}
              />
            </div>
            {status?.reconciliationRun && c.driveResourceId ? (
              <RowProgress vaultId={vaultId} run={status.reconciliationRun} />
            ) : null}
            {isFolder && isOpen && (
              <FolderChildren
                vaultId={vaultId}
                driveResourceId={c.driveResourceId ?? undefined}
                provider={c.provider}
                providerFileId={c.providerFileId}
                rootDriveResourceId={rootDriveResourceId}
                depth={depth + 1}
                vaultColor={vaultColor}
                statusByResourceId={statusByResourceId}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Tree of bound connector resources for a single vault, with index toggles.
 * Accepts already-fetched roots so a parent can fetch once and reuse for RECENT.
 */
export function DriveResourceTree({
  vaultId,
  resources,
  emptyLabel = "No files",
  vaultColor,
  statusByResourceId,
}: {
  vaultId: string;
  resources: DriveResource[];
  emptyLabel?: string;
  vaultColor?: string | null;
  statusByResourceId: Map<string, FileIndexStatus>;
}) {
  const [, setLocation] = useLocation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const titleStyle = titleStyleForVault(vaultColor);

  if (resources.length === 0) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 8 }}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {resources.map((r) => {
        const isOpen = !!expanded[r.id];
        const isFolder = r.resourceType === "folder";
        const isPdf = !isFolder && isPdfResource(r);
        const status = statusByResourceId.get(r.id);
        const openPdf = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          setLocation(
            pdfViewerHref({
              id: r.id,
              source: "drive_resource",
              vaultId,
              provider: r.provider,
              webViewLink: r.webViewLink,
            }),
          );
        };
        return (
          <li key={r.id}>
            <div
              className="group flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 }}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={() => setExpanded((s) => ({ ...s, [r.id]: !s[r.id] }))}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {resourceIcon(r)}
              <ResourceTitle
                name={r.name}
                href={isPdf ? null : r.webViewLink}
                titleStyle={titleStyle}
                onOpen={isPdf ? openPdf : undefined}
              />
              {isPdf ? (
                <ExternalOpenLink href={r.webViewLink} label={providerOpenLabel(r.provider)} />
              ) : null}
              <IndexStatusLabel status={status?.status} />
              <IndexToggle vaultId={vaultId} driveResourceId={r.id} status={status} />
            </div>
            {status?.reconciliationRun ? (
              <RowProgress vaultId={vaultId} run={status.reconciliationRun} />
            ) : null}
            {isFolder && isOpen && (
              <FolderChildren
                vaultId={vaultId}
                driveResourceId={r.id}
                provider={r.provider}
                providerFileId={r.providerFileId}
                rootDriveResourceId={r.id}
                depth={1}
                vaultColor={vaultColor}
                statusByResourceId={statusByResourceId}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A row in the flat cross-vault RECENT list (no vault badge). */
export function RecentResourceRow({
  resource,
  vaultId,
  vaultColor,
  status,
}: {
  resource: DriveResource;
  vaultId: string;
  vaultColor?: string | null;
  status?: FileIndexStatus;
}) {
  const [, setLocation] = useLocation();
  const isPdf = isPdfResource(resource);
  const openPdf = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setLocation(
      pdfViewerHref({
        id: resource.id,
        source: "drive_resource",
        vaultId,
        provider: resource.provider,
        webViewLink: resource.webViewLink,
      }),
    );
  };

  return (
    <div>
      <div className="group flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-muted/60">
        <span className="w-3.5 shrink-0" />
        {resourceIcon(resource)}
        <ResourceTitle
          name={resource.name}
          href={isPdf ? null : resource.webViewLink}
          titleStyle={titleStyleForVault(vaultColor)}
          onOpen={isPdf ? openPdf : undefined}
        />
        {isPdf ? (
          <ExternalOpenLink
            href={resource.webViewLink}
            label={providerOpenLabel(resource.provider)}
          />
        ) : null}
        <IndexStatusLabel status={status?.status} />
        <IndexToggle vaultId={vaultId} driveResourceId={resource.id} status={status} />
      </div>
      {status?.reconciliationRun ? (
        <RowProgress vaultId={vaultId} run={status.reconciliationRun} />
      ) : null}
    </div>
  );
}
