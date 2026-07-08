import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, ExternalLink, Loader2, Play, RefreshCw, Smartphone, Upload, Wifi, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { PipelineCockpit, type PipelineStatus, type PipelineStep } from "@/components/pipeline-cockpit";

// Mobile (Expo / EAS)
// ─────────────────────────────────────────────────────────────────────────────

interface ExpoStatus {
  connected: boolean;
  username?: string;
  accountName?: string;
  accounts?: { id: string; name: string }[];
  error?: string;
}

type MobileBuildSource = "main";

interface EasResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  command?: string;
  cwd?: string;
  durationMs?: number;
  runId?: string;
  source?: MobileBuildSource;
  sourceRef?: string;
  startedAt?: string;
  completedAt?: string;
  guidance?: string;
}

interface EasLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

interface EasRunSnapshot {
  runId: string;
  status: "running" | "success" | "failed";
  command: string;
  cwd: string;
  profile?: string;
  platform?: string;
  source?: MobileBuildSource;
  sourceRef?: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  result: EasResult | null;
  logs: EasLogEntry[];
}

interface ExpoProjectConfig {
  configured: boolean;
  owner?: string;
  slug?: string;
  projectId?: string;
  message?: string;
  error?: string;
}

interface ExpoBuildSnapshot {
  id?: string;
  status?: string;
  platform?: string;
  distribution?: string;
  buildProfile?: string;
  profile?: string;
  appVersion?: string;
  appBuildVersion?: string | null;
  sdkVersion?: string | null;
  gitCommitHash?: string | null;
  gitCommitMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  artifacts?: {
    buildUrl?: string | null;
    installUrl?: string | null;
    logsUrl?: string | null;
  } | null;
  error?: { message?: string } | null;
}

type MobileBuildStepState = "waiting" | "active" | "complete" | "failed";

interface MobileTelemetryEvent {
  id: number;
  kind:
    | "phase"
    | "fatal_js_error"
    | "unhandled_promise_rejection"
    | "previous_launch_incomplete"
    | "sentry_status";
  phase?: string | null;
  mobileSessionId: string;
  deviceId: string;
  platform?: string | null;
  osVersion?: string | null;
  deviceModel?: string | null;
  appVersion?: string | null;
  nativeBuildVersion?: string | null;
  runtimeVersion?: string | null;
  updateId?: string | null;
  bundleIdentifier?: string | null;
  easBuildId?: string | null;
  buildProfile?: string | null;
  gitSha?: string | null;
  sourceRef?: string | null;
  isFatal: boolean;
  errorName?: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  payload?: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
}

interface MobileTelemetryResponse {
  events: MobileTelemetryEvent[];
  sentry: { active: boolean; missing: string[] };
}

function isExpoBuildActive(status: string | undefined): boolean {
  return ["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"].includes(
    (status || "").toUpperCase(),
  );
}

function isExpoBuildFailed(status: string | undefined): boolean {
  return ["ERRORED", "CANCELED"].includes((status || "").toUpperCase());
}

function sortRemoteBuilds(
  builds: ExpoBuildSnapshot[] | undefined,
): ExpoBuildSnapshot[] {
  return [...(builds || [])].sort((a, b) => {
    const aTime = Date.parse(a.createdAt || a.updatedAt || "");
    const bTime = Date.parse(b.createdAt || b.updatedAt || "");
    return (
      (Number.isFinite(bTime) ? bTime : 0) -
      (Number.isFinite(aTime) ? aTime : 0)
    );
  });
}

function getLatestRemoteBuild(
  builds: ExpoBuildSnapshot[] | undefined,
): ExpoBuildSnapshot | null {
  return sortRemoteBuilds(builds)[0] || null;
}

function getBuildPageUrl(
  build: ExpoBuildSnapshot | null | undefined,
): string | null {
  return build?.artifacts?.installUrl || build?.artifacts?.logsUrl || null;
}

function getLatestInstallableBuild(
  builds: ExpoBuildSnapshot[] | undefined,
): ExpoBuildSnapshot | null {
  return (
    sortRemoteBuilds(builds).find(
      (build) =>
        build.status?.toUpperCase() === "FINISHED" && getBuildPageUrl(build),
    ) || null
  );
}

function getRelevantRemoteBuild(
  builds: ExpoBuildSnapshot[] | undefined,
  run: EasRunSnapshot | null | undefined,
): ExpoBuildSnapshot | null {
  if (!run) return null;

  const sortedBuilds = sortRemoteBuilds(builds);
  const startedAtMs = Date.parse(run.startedAt || "");
  if (!Number.isFinite(startedAtMs)) return null;

  const profile = run.profile?.toLowerCase();
  const platform = run.platform?.toLowerCase();
  return (
    sortedBuilds.find((build) => {
      const createdAtMs = Date.parse(build.createdAt || build.updatedAt || "");
      if (!Number.isFinite(createdAtMs) || createdAtMs < startedAtMs - 30_000)
        return false;
      const buildProfile = (
        build.buildProfile ||
        build.profile ||
        ""
      ).toLowerCase();
      const buildPlatform = (build.platform || "").toLowerCase();
      if (profile && buildProfile && buildProfile !== profile) return false;
      if (platform && buildPlatform && buildPlatform !== platform) return false;
      return true;
    }) || null
  );
}

function formatBuildStatusLabel(status: string | undefined): string {
  if (!status) return "Waiting";
  return status.toLowerCase().replace(/_/g, " ");
}

function remoteBuildErrorMessage(
  build: ExpoBuildSnapshot | null,
): string | null {
  if (!build) return null;
  return (
    build.error?.message ||
    (isExpoBuildFailed(build.status)
      ? `Expo reported ${formatBuildStatusLabel(build.status)}.`
      : null)
  );
}

function formatShortSha(value: string | null | undefined): string | null {
  return value ? value.slice(0, 7) : null;
}

function buildIdentityLabel(build: ExpoBuildSnapshot): string {
  const version = build.appVersion || "app ?";
  const native = build.appBuildVersion ? ` (${build.appBuildVersion})` : "";
  const sha = formatShortSha(build.gitCommitHash);
  return [version + native, sha].filter(Boolean).join(" · ");
}

function MobileTelemetryPanel({
  telemetry,
}: {
  telemetry: MobileTelemetryResponse | undefined;
}) {
  const events = telemetry?.events || [];
  const latest = events[0];
  const latestFatal = events.find(
    (event) =>
      event.isFatal ||
      event.kind === "fatal_js_error" ||
      event.kind === "unhandled_promise_rejection",
  );
  const latestMounted = events.find((event) => event.phase === "app_mounted");
  const latestIncomplete = events.find(
    (event) => event.kind === "previous_launch_incomplete",
  );
  const status = latestFatal
    ? { label: "Startup error", tone: "text-error", Icon: Bug }
    : latestIncomplete &&
        (!latestMounted ||
          new Date(latestIncomplete.receivedAt) >
            new Date(latestMounted.receivedAt))
      ? {
          label: "Startup incomplete",
          tone: "text-warning",
          Icon: AlertTriangle,
        }
      : latestMounted
        ? { label: "Launched", tone: "text-success", Icon: CheckCircle2 }
        : latest
          ? { label: "Telemetry received", tone: "text-active", Icon: Activity }
          : {
              label: "No launch telemetry",
              tone: "text-muted-foreground",
              Icon: CircleDot,
            };
  const Icon = status.Icon;
  const detailEvent =
    latestFatal || latestIncomplete || latestMounted || latest;
  const identity = detailEvent
    ? [
        detailEvent.appVersion
          ? `${detailEvent.appVersion}${detailEvent.nativeBuildVersion ? ` (${detailEvent.nativeBuildVersion})` : ""}`
          : null,
        formatShortSha(detailEvent.gitSha),
        detailEvent.deviceModel,
        detailEvent.osVersion
          ? `${detailEvent.platform || "ios"} ${detailEvent.osVersion}`
          : detailEvent.platform,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div
      className="shrink-0 rounded-xl border bg-background/50 p-3"
      data-testid="mobile-telemetry-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={cn(
              "flex items-center gap-2 text-sm font-medium",
              status.tone,
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{status.label}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {detailEvent
              ? `${detailEvent.phase || detailEvent.kind}${identity ? ` · ${identity}` : ""} · ${formatDistanceToNow(new Date(detailEvent.receivedAt), { addSuffix: true })}`
              : "Install and open a mobile build to populate startup telemetry."}
          </p>
        </div>
        <Badge variant={telemetry?.sentry?.active ? "default" : "secondary"}>
          {telemetry?.sentry?.active ? "Sentry active" : "Sentry inactive"}
        </Badge>
      </div>
      {!telemetry?.sentry?.active && telemetry?.sentry?.missing?.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Missing: {telemetry.sentry.missing.join(", ")}. First-party startup
          telemetry is independent.
        </p>
      ) : null}
      {events.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Recent startup events
          </summary>
          <div className="mt-2 max-h-56 space-y-1 overflow-auto rounded-md border bg-background p-2">
            {events.slice(0, 12).map((event) => (
              <div
                key={event.id}
                className="grid grid-cols-[72px_1fr_auto] gap-2 text-xs"
              >
                <span className="text-muted-foreground tabular-nums">
                  {formatLogClockTime(event.receivedAt)}
                </span>
                <span
                  className={cn(
                    "min-w-0 truncate",
                    event.isFatal
                      ? "text-error"
                      : event.kind === "previous_launch_incomplete"
                        ? "text-warning"
                        : "text-foreground",
                  )}
                >
                  {event.phase || event.kind}
                  {event.errorMessage ? ` · ${event.errorMessage}` : ""}
                </span>
                <span className="text-muted-foreground">
                  {formatShortSha(event.gitSha) ||
                    event.nativeBuildVersion ||
                    event.mobileSessionId.slice(0, 6)}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function formatLogClockTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function MobileBuildLogPanel({
  run,
  isLoading,
}: {
  run: EasRunSnapshot | null | undefined;
  isLoading: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.logs.length, run?.runId]);

  const statusTone =
    run?.status === "failed"
      ? "text-error"
      : run?.status === "running"
        ? "text-active"
        : run?.status === "success"
          ? "text-success"
          : "text-muted-foreground";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-testid="mobile-build-log-panel"
    >
      {run ? (
        <>
          {run.result?.guidance && (
            <div
              className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
              data-testid="panel-mobile-build-guidance"
            >
              <div className="font-medium mb-1">Next action</div>
              <p>{run.result.guidance}</p>
            </div>
          )}
          <div
            ref={containerRef}
            className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-3 font-mono text-xs"
            data-testid="mobile-build-log-output"
          >
            {run.logs.length === 0 ? (
              <div className="text-muted-foreground">
                Waiting for EAS output…
              </div>
            ) : (
              run.logs.map((entry, index) => {
                const tone =
                  entry.stream === "stderr"
                    ? "text-error"
                    : entry.stream === "system"
                      ? statusTone
                      : "text-foreground";
                return (
                  <div
                    key={`${entry.timestamp}-${index}`}
                    className="flex gap-3 leading-tight py-0.5"
                  >
                    <span
                      className="shrink-0 text-muted-foreground tabular-nums"
                      title={entry.timestamp}
                    >
                      {formatLogClockTime(entry.timestamp)}
                    </span>
                    <span className={cn("shrink-0 uppercase", tone)}>
                      {entry.stream}
                    </span>
                    <span
                      className={cn("whitespace-pre-wrap break-words", tone)}
                    >
                      {entry.message}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {isLoading
            ? "Loading latest EAS run…"
            : "No mobile build command has run since this server started."}
        </div>
      )}
    </div>
  );
}

export function MobileBuildCard() {
  const { toast } = useToast();
  const { data: expoStatus, isLoading: statusLoading } = useQuery<ExpoStatus>({
    queryKey: ["/api/integrations/expo/status"],
  });

  const { data: projectConfig } = useQuery<ExpoProjectConfig>({
    queryKey: ["/api/integrations/expo/project-config"],
    enabled: !!expoStatus?.connected,
  });

  const { data: buildsData, refetch: refetchBuilds } = useQuery<{
    builds: ExpoBuildSnapshot[];
  }>({
    queryKey: ["/api/integrations/expo/builds"],
    enabled: !!expoStatus?.connected,
    refetchInterval: (query) =>
      isExpoBuildActive(getLatestRemoteBuild(query.state.data?.builds)?.status)
        ? 5000
        : 30000,
  });

  const { data: buildLogData, isLoading: buildLogLoading } = useQuery<{
    run: EasRunSnapshot | null;
  }>({
    queryKey: ["/api/integrations/expo/build-log"],
    enabled: !!expoStatus?.connected,
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 1000 : 5000,
  });

  const { data: telemetryData } = useQuery<MobileTelemetryResponse>({
    queryKey: ["/api/mobile/telemetry/startup?limit=25"],
    enabled: !!expoStatus?.connected,
    refetchInterval: 15000,
  });

  const { data: autoBuildData } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/integrations/expo/auto-build"],
    enabled: !!expoStatus?.connected,
  });

  const autoBuildMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/integrations/expo/auto-build", { enabled });
      return res.json() as Promise<{ enabled: boolean }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/expo/auto-build"] });
      toast({
        title: `Auto-build ${result.enabled ? "enabled" : "disabled"}`,
        description: result.enabled
          ? "Pushes to main will trigger a mobile build."
          : "Pushes to main will be ignored. Manual builds still work.",
      });
    },
  });

  const buildMutation = useMutation({
    mutationFn: async ({
      profile,
      platform,
    }: {
      profile: string;
      platform: string;
    }) => {
      const res = await apiRequest("POST", "/api/integrations/expo/build", {
        profile,
        platform,
      });
      return res.json() as Promise<{
        ok: boolean;
        guidance?: string;
        stderr?: string;
        error?: string;
        stdout?: string;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/integrations/expo/build-log"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/integrations/expo/builds"],
      });
      if (result.ok) {
        toast({
          title: "Mobile build started",
          description: "EAS accepted the iOS preview build.",
        });
      } else {
        const message =
          result.guidance ||
          result.stderr ||
          result.error ||
          result.stdout ||
          "EAS build failed.";
        toast({
          title: "Build needs attention",
          description: message.slice(0, 300),
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) =>
      toast({
        title: "Build failed",
        description: err.message,
        variant: "destructive",
      }),
  });

  const currentRun = buildLogData?.run || null;
  const currentRemoteBuild = getRelevantRemoteBuild(
    buildsData?.builds,
    currentRun,
  );
  const latestInstallableBuild = getLatestInstallableBuild(buildsData?.builds);
  const latestInstallPageUrl = getBuildPageUrl(latestInstallableBuild);
  const runSourceLabel =
    currentRun?.source === "main"
      ? "latest GitHub main"
      : currentRun?.source === "local"
        ? "deployed local filesystem"
        : null;
  const selectedSourceLabel = "latest GitHub main";
  const remoteStatus = (currentRemoteBuild?.status || "").toUpperCase();
  const remoteFailed = isExpoBuildFailed(remoteStatus);
  const remoteFinished = remoteStatus === "FINISHED";
  const localFailed = currentRun?.status === "failed";
  const cloudBuildObserved =
    Boolean(currentRemoteBuild) ||
    isExpoBuildActive(remoteStatus) ||
    remoteFinished ||
    remoteFailed;
  const hasSubmissionUrl =
    Boolean(currentRemoteBuild) ||
    Boolean(
      currentRun?.logs?.some((entry) =>
        /expo\.dev\/accounts\/.+\/builds\//i.test(entry.message),
      ),
    );
  const uploadComplete =
    hasSubmissionUrl || currentRun?.status === "success" || cloudBuildObserved;
  const remoteError = remoteBuildErrorMessage(currentRemoteBuild);
  const buildPageUrl = getBuildPageUrl(currentRemoteBuild);
  const recentCloudBuilds = buildsData?.builds?.length ? (
    <div className="rounded-xl border bg-background/50 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium">Recent cloud builds</div>
        <div className="text-xs text-muted-foreground">Expo status</div>
      </div>
      <div className="space-y-2">
        {buildsData.builds.slice(0, 10).map((b, i) => (
          <div
            key={b.id || i}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <div className="flex min-w-0 items-center gap-2">
              {b.status === "FINISHED" ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : isExpoBuildFailed(b.status) ? (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-error" />
              ) : isExpoBuildActive(b.status) ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-active" />
              ) : (
                <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="text-xs text-muted-foreground">{formatBuildStatusLabel(b.status)}</span>
              <span className="text-xs text-muted-foreground">{b.platform}</span>
              <span className="truncate text-xs text-muted-foreground">
                {b.buildProfile || b.profile}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {buildIdentityLabel(b)}
              </span>
              {b.error?.message && (
                <span className="truncate text-xs text-error">{b.error.message}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {getBuildPageUrl(b) && (
                <a
                  href={getBuildPageUrl(b) || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-cta underline transition-colors hover:text-active"
                >
                  Expo page
                </a>
              )}
              <span className="text-xs text-muted-foreground">
                {b.createdAt
                  ? formatDistanceToNow(new Date(b.createdAt), {
                      addSuffix: true,
                    })
                  : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  const mobileBuildLogs =
    currentRun || buildLogLoading ? (
      <div className="flex h-full max-h-[42vh] min-h-[220px] flex-col overflow-hidden rounded-xl border bg-card">
        <div className="shrink-0 border-b px-3 py-2">
          <h3 className="text-sm font-semibold">Build logs</h3>
          <p className="text-xs text-muted-foreground">
            EAS command output and provider handoff diagnostics.
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
          <MobileBuildLogPanel run={currentRun} isLoading={buildLogLoading} />
        </div>
      </div>
    ) : null;

  const mobileStatus: PipelineStatus =
    buildMutation.isPending ||
    currentRun?.status === "running" ||
    isExpoBuildActive(remoteStatus)
      ? "running"
      : localFailed || remoteFailed
        ? "failed"
        : remoteFinished || currentRun?.status === "success"
          ? "succeeded"
          : projectConfig?.configured
            ? "ready"
            : "blocked";

  const mobileSteps: PipelineStep[] = [
    {
      id: "queue-build",
      label: "Queue EAS build",
      status: currentRun
        ? localFailed && !uploadComplete
          ? "failed"
          : "succeeded"
        : buildMutation.isPending
          ? "running"
          : "pending",
      description: currentRun?.command
        ? `${currentRun.command} · ${runSourceLabel || "Source"}${currentRun.sourceRef ? ` @ ${currentRun.sourceRef.slice(0, 7)}` : ""}`
        : `Start a preview iOS build from ${selectedSourceLabel}.`,
      icon: Upload,
      detail: (
        <div className="space-y-3">
          <div className="rounded-lg border bg-card/60 p-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Build source
            </div>
            <div className="text-sm font-medium" data-testid="mobile-build-source-main">Main</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Mobile builds always use the latest committed main checkout.
            </p>
          </div>
          {currentRun?.runId || currentRun?.sourceRef ? (
            <div className="grid gap-2 @md:grid-cols-2">
              {currentRun?.runId ? (
                <div className="rounded-lg border bg-card/60 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run ID</div>
                  <div className="mt-1 font-mono text-sm">{currentRun.runId.slice(0, 8)}</div>
                </div>
              ) : null}
              {currentRun?.sourceRef ? (
                <div className="rounded-lg border bg-card/60 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Commit</div>
                  <div className="mt-1 font-mono text-sm">{currentRun.sourceRef.slice(0, 7)}</div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="rounded-lg border bg-card/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Auto-build on push</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Automatically trigger a build when main is updated.
                </p>
              </div>
              <Switch
                checked={autoBuildData?.enabled !== false}
                onCheckedChange={(checked) => autoBuildMutation.mutate(checked)}
                disabled={autoBuildMutation.isPending}
                data-testid="toggle-mobile-auto-build"
              />
            </div>
          </div>
          {mobileBuildLogs}
        </div>
      ),
    },
    {
      id: "cloud-build",
      label: ["NEW", "IN_QUEUE"].includes(remoteStatus)
        ? "Queued with Expo"
        : "Build on Expo",
      status: remoteFailed
        ? "failed"
        : remoteFinished
          ? "succeeded"
          : cloudBuildObserved || currentRun?.status === "running"
            ? "running"
            : "pending",
      description:
        remoteError ||
        (currentRemoteBuild
          ? formatBuildStatusLabel(currentRemoteBuild.status)
          : "Waiting for Expo cloud build status."),
      icon: Wifi,
      detail: (
        <div className="space-y-3">
          {currentRemoteBuild?.id ? (
            <div className="rounded-lg border bg-card/60 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">EAS build</div>
              <div className="mt-1 font-mono text-sm">{currentRemoteBuild.id.slice(0, 8)}</div>
            </div>
          ) : null}
          {remoteError && (
            <div
              className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error"
              data-testid="mobile-build-cloud-error"
            >
              <div className="mb-1 font-medium">Expo error</div>
              <p>{remoteError}</p>
            </div>
          )}
          <MobileTelemetryPanel telemetry={telemetryData} />
        </div>
      ),
    },
    {
      id: "artifact",
      label: "Surface install artifact",
      status: remoteFinished
        ? "succeeded"
        : remoteFailed
          ? "failed"
          : "pending",
      description: buildPageUrl
        ? "Install or inspect the build on Expo."
        : "Artifact link appears when the cloud build finishes.",
      icon: Download,
      detail: (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {buildPageUrl ? (
              <Button asChild variant="outline" className="h-9">
                <a href={buildPageUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" /> Expo build page
                </a>
              </Button>
            ) : null}
            {currentRemoteBuild?.artifacts?.installUrl ? (
              <Button asChild variant="outline" className="h-9">
                <a href={currentRemoteBuild.artifacts.installUrl} target="_blank" rel="noopener noreferrer">
                  <Download className="mr-2 h-4 w-4" /> Install
                </a>
              </Button>
            ) : null}
            {currentRemoteBuild?.artifacts?.logsUrl ? (
              <Button asChild variant="outline" className="h-9">
                <a href={currentRemoteBuild.artifacts.logsUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" /> Provider logs
                </a>
              </Button>
            ) : null}
          </div>
          {recentCloudBuilds}
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-0">
      <PipelineCockpit
        title="Mobile"
        status={mobileStatus}
        primaryAction={{
          label: "Build",
          onClick: () =>
            buildMutation.mutate({
              profile: "preview",
              platform: "ios",
            }),
          disabled: buildMutation.isPending || !projectConfig?.configured,
          pending: buildMutation.isPending,
          icon: <Play className="h-4 w-4" />,
          testId: "button-expo-build-standalone",
        }}
        primaryActionPosition="right"
        secondaryActions={
          latestInstallPageUrl ? (
            <Button
              asChild
              variant="outline"
              size="icon"
              className="h-7 w-7"
              data-testid="button-expo-install-latest"
            >
              <a
                href={latestInstallPageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download className="h-4 w-4" />
                <span className="sr-only">Download</span>
              </a>
            </Button>
          ) : null
        }
        summary={[
          {
            label: "Profile",
            value: currentRun?.profile || "preview",
            detail: currentRun?.platform || "ios",
          },
          {
            label: "Source",
            value: selectedSourceLabel,
            detail: currentRun?.sourceRef ? (
              <span className="font-mono">
                {currentRun.sourceRef.slice(0, 7)}
              </span>
            ) : (
              "No active run"
            ),
          },
          {
            label: "Expo status",
            value: currentRemoteBuild
              ? formatBuildStatusLabel(currentRemoteBuild.status)
              : "Waiting",
            detail: currentRemoteBuild
              ? buildIdentityLabel(currentRemoteBuild)
              : "No matching cloud build yet",
          },
          {
            label: "Latest artifact",
            value: latestInstallPageUrl ? "Available" : "Unavailable",
            detail: latestInstallableBuild
              ? buildIdentityLabel(latestInstallableBuild)
              : "No finished installable build",
          },
        ]}
        steps={mobileSteps}
        testId="card-mobile-builds"
      />
    </div>
  );
}

