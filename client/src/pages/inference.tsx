import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCost } from "@/lib/format-utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Crown,
  Brain,
  Gauge,
  Zap,
  ChevronDown,
  ChevronRight,
  Loader2,
  DollarSign,
  Clock,
  Hash,
  Activity,
  X,
  Database,
  Clipboard,
  Check,
  FolderOpen,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePageHeader } from "@/hooks/use-page-header";

interface InferenceCall {
  id: number;
  timestamp: string;
  provider: string;
  model: string;
  profile: string | null;
  tier: string;
  activityType: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costTotal: number;
  durationMs: number | null;
  stopReason: string | null;
  sessionKey: string | null;
  sessionId: number | null;
  requestContent: string | null;
  responseContent: string | null;
  promptName?: string;
  runId?: string | null;
  isActive?: boolean;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  sessionId?: string;
  model?: string;
  activity?: string;
  sessionKey?: string;
  requestContent?: string;
}

interface InferenceResponse {
  calls: InferenceCall[];
  total: number;
  limit: number;
  offset: number;
  serverStartTime: string;
  sessionLabels?: Record<string, string>;
  aggregateTotalCalls: number;
  aggregateTotalCost: number;
  aggregateTotalInputTokens?: number;
  aggregateTotalOutputTokens?: number;
}

interface ActiveResponse {
  activeCount: number;
  runs: ActiveRun[];
}

interface SessionGroup {
  sessionKey: string;
  label: string;
  calls: InferenceCall[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
  runCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

const TIER_ICONS: Record<string, typeof Brain> = {
  max: Crown,
  high: Brain,
  balanced: Gauge,
  fast: Zap,
  embed: Database,
};

const TIER_COLORS: Record<string, string> = {
  max: "text-warning",
  high: "text-cat-ai",
  balanced: "text-info",
  fast: "text-success",
  embed: "text-active",
};


function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatElapsed(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed < 1000) return "just started";
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`;
  return `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`;
}

function formatSessionLabel(key: string): string {
  if (key === "system") return "System";
  if (key.startsWith("act:")) return `Act Engine ${key.slice(4, 12)}...`;
  if (key.startsWith("dashboard:")) return `Chat ${key.slice(10, 18)}...`;
  if (key.startsWith("chat:")) return `Chat ${key.slice(5, 13)}...`;
  if (key.startsWith("voice:")) return `Voice ${key.slice(6, 14)}...`;
  return key.length > 24 ? `${key.slice(0, 20)}...` : key;
}

function groupBySession(calls: InferenceCall[], sessionLabels?: Record<string, string>): SessionGroup[] {
  const map = new Map<string, InferenceCall[]>();
  for (const call of calls) {
    const key = call.sessionKey || "system";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(call);
  }
  const groups: SessionGroup[] = [];
  for (const [sessionKey, groupCalls] of map) {
    groupCalls.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const totalCost = groupCalls.reduce((s, c) => s + c.costTotal, 0);
    const totalInputTokens = groupCalls.reduce((s, c) => s + c.inputTokens, 0);
    const totalOutputTokens = groupCalls.reduce((s, c) => s + c.outputTokens, 0);
    const runCount = new Set(groupCalls.map(c => c.runId || `call:${c.id}`)).size;
    const timestamps = groupCalls.map(c => c.timestamp).sort();
    const label = sessionLabels?.[sessionKey] || formatSessionLabel(sessionKey);
    groups.push({
      sessionKey,
      label,
      calls: groupCalls,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      callCount: groupCalls.length,
      runCount,
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps[timestamps.length - 1],
    });
  }
  groups.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
  return groups;
}

function TierBadge({ tier }: { tier: string }) {
  const Icon = TIER_ICONS[tier] || Zap;
  const color = TIER_COLORS[tier] || "text-muted-foreground";
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${color}`} data-testid={`badge-tier-${tier}`}>
      <Icon className="h-3 w-3" />
      <span className="font-medium">{label}</span>
    </span>
  );
}

function InferenceListItem({
  call,
  isSelected,
  onSelect,
}: {
  call: InferenceCall;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors rounded-md ${
        isSelected
          ? "bg-primary/10 border border-primary/30"
          : "hover:bg-muted/50 border border-transparent"
      }`}
      onClick={onSelect}
      data-testid={`button-select-call-${call.id}`}
    >
      {call.isActive ? (
        <span className="inline-flex items-center gap-1 text-xs text-info">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="font-medium">Running</span>
        </span>
      ) : (
        <TierBadge tier={call.tier} />
      )}

      <Badge variant="outline" className="text-xs px-1.5 py-0 shrink-0" data-testid={`badge-activity-${call.id}`}>
        {call.activityType}
      </Badge>

      <span className="text-xs text-muted-foreground truncate min-w-0 flex-1" data-testid={`text-profile-${call.id}`}>
        {call.promptName || call.profile || "unknown"}
      </span>

      {call.isActive ? (
        <span className="text-xs text-info shrink-0" data-testid={`text-elapsed-${call.id}`}>
          {formatElapsed(new Date(call.timestamp).getTime())}
        </span>
      ) : (
        <>
          <span className="text-xs font-medium shrink-0" data-testid={`text-cost-${call.id}`}>
            {formatCost(call.costTotal)}
          </span>

          <span className="text-xs text-muted-foreground shrink-0 hidden @sm:inline" data-testid={`text-tokens-${call.id}`} title="Provider request tokens for this model call">
            {formatTokens(call.inputTokens)}→{formatTokens(call.outputTokens)} req tokens
          </span>

          <span className="text-xs text-muted-foreground shrink-0 hidden @lg:inline" data-testid={`text-time-${call.id}`}>
            {formatTimestamp(call.timestamp)}
          </span>
        </>
      )}
    </button>
  );
}

function SessionGroupView({
  group,
  selectedId,
  onSelect,
  highlightSession,
}: {
  group: SessionGroup;
  selectedId: number | null;
  onSelect: (call: InferenceCall) => void;
  highlightSession?: string | null;
}) {
  const isHighlighted = highlightSession === group.sessionKey;
  const [open, setOpen] = useState(true);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isHighlighted && groupRef.current) {
      groupRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [isHighlighted]);

  return (
    <div ref={groupRef} className={`space-y-0.5 ${isHighlighted ? "ring-1 ring-primary/40 rounded-md" : ""}`} data-testid={`session-group-${group.sessionKey}`}>
      <button
        className="flex items-center gap-2 w-full text-left py-1.5 px-2 hover:bg-muted/30 rounded-md transition-colors"
        onClick={() => setOpen(!open)}
        data-testid={`button-toggle-session-${group.sessionKey}`}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium truncate">{group.label}</span>
        <Badge variant="secondary" className="text-xs font-mono px-1 py-0 ml-1" data-testid={`badge-session-count-${group.sessionKey}`}>
          {group.callCount} req
        </Badge>
        <span className="text-xs text-muted-foreground shrink-0 hidden @sm:inline">
          {group.runCount} run{group.runCount === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground ml-auto shrink-0">
          {formatTokens(group.totalInputTokens)}→{formatTokens(group.totalOutputTokens)} provider tokens
        </span>
        <span className="text-xs text-muted-foreground shrink-0 hidden @sm:inline">
          {formatCost(group.totalCost)}
        </span>
        <span className="text-xs text-muted-foreground shrink-0 hidden @md:inline">
          {group.firstTimestamp === group.lastTimestamp
            ? formatTimestamp(group.lastTimestamp)
            : `${formatTimestamp(group.firstTimestamp)} → ${formatTimestamp(group.lastTimestamp)}`}
        </span>
      </button>
      {open && (
        <div className="space-y-0.5 pl-5 border-l border-border/50 ml-3">
          {group.calls.map(call => (
            <InferenceListItem
              key={call.id}
              call={call}
              isSelected={selectedId === call.id}
              onSelect={() => onSelect(call)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CallGroup({
  title,
  calls,
  icon,
  defaultOpen,
  color,
  selectedId,
  onSelect,
  groupBySessionKey,
  sessionLabels,
  highlightSession,
}: {
  title: string;
  calls: InferenceCall[];
  icon: typeof Activity;
  defaultOpen: boolean;
  color: string;
  selectedId: number | null;
  onSelect: (call: InferenceCall) => void;
  groupBySessionKey?: boolean;
  sessionLabels?: Record<string, string>;
  highlightSession?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = icon;
  const totalCost = calls.reduce((s, c) => s + c.costTotal, 0);
  const sessionGroups = useMemo(() => {
    if (!groupBySessionKey || calls.length === 0) return null;
    return groupBySession(calls, sessionLabels);
  }, [calls, groupBySessionKey, sessionLabels]);

  return (
    <div className="space-y-1" data-testid={`group-${title.toLowerCase()}`}>
      <button
        className="flex items-center gap-2 w-full text-left py-1"
        onClick={() => setOpen(!open)}
        data-testid={`button-toggle-group-${title.toLowerCase()}`}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <Icon className={`h-4 w-4 ${color}`} />
        <span className="text-sm font-medium">{title}</span>
        <Badge variant="secondary" className="text-xs font-mono px-1 py-0 ml-1" data-testid={`badge-count-${title.toLowerCase()}`}>
          {calls.length}
        </Badge>
        <span className="text-xs text-muted-foreground ml-auto">
          {formatCost(totalCost)}
        </span>
      </button>
      {open && (
        <div className="space-y-0.5 pl-2">
          {calls.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2 pl-4">No calls</p>
          ) : sessionGroups && sessionGroups.length > 0 ? (
            sessionGroups.map(group => (
              <SessionGroupView
                key={group.sessionKey}
                group={group}
                selectedId={selectedId}
                onSelect={onSelect}
                highlightSession={highlightSession}
              />
            ))
          ) : (
            calls.map(call => (
              <InferenceListItem
                key={call.id}
                call={call}
                isSelected={selectedId === call.id}
                onSelect={() => onSelect(call)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function RawContent({ content, label }: { content: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="relative mt-1">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
        data-testid={`button-copy-${label}`}
        title="Copy to clipboard"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Clipboard className="h-3.5 w-3.5" />}
      </button>
      <pre className="text-xs whitespace-pre-wrap break-words bg-muted rounded-md p-3 pr-8 font-mono overflow-y-auto" style={{ maxHeight: "60vh" }}>
        {content}
      </pre>
    </div>
  );
}

function DetailPanel({ call, onClose }: { call: InferenceCall; onClose: () => void }) {
  const [showInput, setShowInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  const { data: detail, isLoading: detailLoading } = useQuery<InferenceCall>({
    queryKey: ["/api/inference/calls", call.id],
    queryFn: async () => {
      const res = await fetch(`/api/inference/calls/${call.id}`);
      if (!res.ok) throw new Error("Failed to fetch call detail");
      return res.json();
    },
    enabled: !call.isActive,
  });

  const hasInput = call.isActive ? call.requestContent : detail?.requestContent;
  const hasOutput = detail?.responseContent;

  return (
    <div className="flex flex-col h-full" data-testid={`detail-panel-${call.id}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          {call.isActive ? (
            <span className="inline-flex items-center gap-1 text-xs text-info">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="font-medium">Running</span>
            </span>
          ) : (
            <TierBadge tier={call.tier} />
          )}
          <Badge variant="outline" className="text-xs px-1.5 py-0 shrink-0">
            {call.activityType}
          </Badge>
          <span className="text-xs text-muted-foreground truncate" data-testid={`detail-prompt-name-${call.id}`}>
            {call.promptName || call.profile || "unknown"}
          </span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={onClose} data-testid="button-close-detail">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-4">
          {call.isActive ? (
            <>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted-foreground block mb-0.5">Model</span>
                <span className="font-mono text-xs">{call.model}</span>
              </div>
              <div>
                <span className="text-muted-foreground block mb-0.5">Elapsed</span>
                <span className="text-info">{formatElapsed(new Date(call.timestamp).getTime())}</span>
              </div>
              {call.sessionKey && (
                <div>
                  <span className="text-muted-foreground block mb-0.5">Session</span>
                  <span className="font-mono text-xs">{call.sessionKey}</span>
                </div>
              )}
            </div>

            <div>
              <button
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors py-1"
                onClick={() => setShowInput(!showInput)}
                data-testid={`button-toggle-input-${call.id}`}
              >
                {showInput ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Input
                {!hasInput && <span className="text-xs ml-1 opacity-50">(empty)</span>}
              </button>
              {showInput && hasInput && (
                <div data-testid={`text-input-content-${call.id}`}>
                  <RawContent content={call.requestContent!} label="input" />
                </div>
              )}
            </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-muted-foreground block mb-0.5">Model</span>
                  <span className="font-mono text-xs" data-testid={`detail-model-${call.id}`}>{call.model}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-0.5">Provider</span>
                  <span className="font-mono text-xs">{call.provider}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-0.5">Duration</span>
                  <span>{formatDuration(call.durationMs)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-0.5">Stop Reason</span>
                  <span>{call.stopReason || "-"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-0.5">Provider Request Input</span>
                  <span>{call.inputTokens.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-0.5">Provider Request Output</span>
                  <span>{call.outputTokens.toLocaleString()}</span>
                </div>
                {call.runId && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground block mb-0.5">Run</span>
                    <span className="font-mono text-xs">{call.runId}</span>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground block mb-0.5">Total Cost</span>
                  <span className="font-medium">{formatCost(call.costTotal)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block mb-0.5">Timestamp</span>
                  <span>{formatTimestamp(call.timestamp)}</span>
                </div>
                {call.sessionKey && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground block mb-0.5">Session</span>
                    <span className="font-mono text-xs">{call.sessionKey}</span>
                  </div>
                )}
              </div>

              {detailLoading && (showInput || showOutput) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading content...
                </div>
              )}

              <div>
                <button
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors py-1"
                  onClick={() => setShowInput(!showInput)}
                  data-testid={`button-toggle-input-${call.id}`}
                >
                  {showInput ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Input
                  {!hasInput && !detailLoading && <span className="text-xs ml-1 opacity-50">(empty)</span>}
                </button>
                {showInput && (
                  detailLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </div>
                  ) : hasInput ? (
                    <div data-testid={`text-input-content-${call.id}`}>
                      <RawContent content={detail!.requestContent!} label="input" />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground py-2">No input content recorded</p>
                  )
                )}
              </div>

              <div>
                <button
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors py-1"
                  onClick={() => setShowOutput(!showOutput)}
                  data-testid={`button-toggle-output-${call.id}`}
                >
                  {showOutput ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Output
                  {!hasOutput && !detailLoading && <span className="text-xs ml-1 opacity-50">(empty)</span>}
                </button>
                {showOutput && (
                  detailLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </div>
                  ) : hasOutput ? (
                    <div data-testid={`text-output-content-${call.id}`}>
                      <RawContent content={detail!.responseContent!} label="output" />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground py-2">No output content recorded</p>
                  )
                )}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default function InferencePage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Inference", skip: !!embedded });
  const highlightSession = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("session") || null;
  }, []);

  const [statusFilter, setStatusFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selectedCall, setSelectedCall] = useState<InferenceCall | null>(null);
  const pageSize = 100;

  const { data, isLoading } = useQuery<InferenceResponse>({
    queryKey: ["/api/inference/calls", statusFilter, periodFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (periodFilter !== "all") params.set("period", periodFilter);
      const res = await fetch(`/api/inference/calls?${params}`);
      if (!res.ok) throw new Error("Failed to fetch inference calls");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: activeData } = useQuery<ActiveResponse>({
    queryKey: ["/api/inference/active"],
    refetchInterval: 5000,
  });

  const allCalls = data?.calls || [];
  const serverStartTime = data?.serverStartTime;
  const sessionLabels = data?.sessionLabels;
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / pageSize);

  const activityTypes = useMemo(() => {
    const types = new Set<string>();
    for (const c of allCalls) {
      if (c.activityType) types.add(c.activityType);
    }
    if (activeData?.runs) {
      for (const r of activeData.runs) {
        if (r.activity) types.add(r.activity);
      }
    }
    return Array.from(types).sort();
  }, [allCalls, activeData]);

  const calls = useMemo(() => {
    if (activityFilter === "all") return allCalls;
    return allCalls.filter(c => c.activityType === activityFilter);
  }, [allCalls, activityFilter]);

  const activeCalls = useMemo((): InferenceCall[] => {
    if (!activeData?.runs?.length) return [];
    const mapped = activeData.runs.map((run, idx) => ({
      id: -(idx + 1),
      timestamp: new Date(run.startedAt).toISOString(),
      provider: "unknown",
      model: run.model || "unknown",
      profile: run.activity || null,
      tier: "unknown",
      activityType: run.activity || "unknown",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costTotal: 0,
      durationMs: null,
      stopReason: null,
      sessionKey: run.sessionKey || null,
      sessionId: null,
      requestContent: run.requestContent || null,
      responseContent: null,
      runId: run.runId,
      isActive: true,
    }));
    if (activityFilter === "all") return mapped;
    return mapped.filter(c => c.activityType === activityFilter);
  }, [activeData, activityFilter]);

  const { completeCalls, pastCalls } = useMemo(() => {
    if (statusFilter !== "all") {
      return { completeCalls: calls, pastCalls: [] };
    }
    if (!serverStartTime) {
      return { completeCalls: calls, pastCalls: [] };
    }
    const startMs = new Date(serverStartTime).getTime();
    const complete: InferenceCall[] = [];
    const past: InferenceCall[] = [];
    for (const c of calls) {
      const ts = new Date(c.timestamp).getTime();
      if (ts >= startMs) complete.push(c);
      else past.push(c);
    }
    return { completeCalls: complete, pastCalls: past };
  }, [calls, serverStartTime, statusFilter]);

  const summaryStats = useMemo(() => {
    return {
      totalCalls: data?.aggregateTotalCalls ?? calls.length,
      totalCost: data?.aggregateTotalCost ?? calls.reduce((s, c) => s + c.costTotal, 0),
      totalInputTokens: data?.aggregateTotalInputTokens ?? calls.reduce((s, c) => s + c.inputTokens, 0),
      totalOutputTokens: data?.aggregateTotalOutputTokens ?? calls.reduce((s, c) => s + c.outputTokens, 0),
    };
  }, [data, calls]);

  const handleSelect = (call: InferenceCall) => {
    setSelectedCall(prev => prev?.id === call.id ? null : call);
  };

  const listContent = (
    <>
      {isLoading ? (
        <div className="space-y-3 p-2">
          {[1, 2, 3, 4, 5].map(i => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : statusFilter === "all" ? (
        <div className="space-y-3">
          <CallGroup
            title="Active"
            calls={activeCalls}
            icon={Loader2}
            defaultOpen={true}
            color="text-info"
            selectedId={selectedCall?.id ?? null}
            onSelect={handleSelect}
          />
          <CallGroup
            title="Complete"
            calls={completeCalls}
            icon={Activity}
            defaultOpen={true}
            color="text-success"
            selectedId={selectedCall?.id ?? null}
            onSelect={handleSelect}
            groupBySessionKey={true}
            sessionLabels={sessionLabels}
            highlightSession={highlightSession}
          />
          <CallGroup
            title="Past"
            calls={pastCalls}
            icon={Clock}
            defaultOpen={pastCalls.length > 0 && completeCalls.length === 0}
            color="text-muted-foreground"
            selectedId={selectedCall?.id ?? null}
            onSelect={handleSelect}
            groupBySessionKey={true}
            sessionLabels={sessionLabels}
            highlightSession={highlightSession}
          />
        </div>
      ) : (
        <div className="space-y-0.5">
          {calls.length === 0 ? (
            <Card className="p-8">
              <div className="flex flex-col items-center gap-2 text-center">
                <Activity className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground" data-testid="text-empty">No inference calls found</p>
              </div>
            </Card>
          ) : (
            groupBySession(calls, sessionLabels).map(group => (
              <SessionGroupView
                key={group.sessionKey}
                group={group}
                selectedId={selectedCall?.id ?? null}
                onSelect={handleSelect}
                highlightSession={highlightSession}
              />
            ))
          )}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            data-testid="button-prev-page"
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="text-page-info">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            data-testid="button-next-page"
          >
            Next
          </Button>
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-4 flex-wrap px-4 @md:px-6 pt-4 @md:pt-6 pb-2 shrink-0">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1" data-testid="stat-total-calls" title="Completed provider requests in this period">
            <Hash className="h-3 w-3" />
            {summaryStats.totalCalls} provider requests
          </span>
          <span className="flex items-center gap-1" data-testid="stat-total-tokens" title="Summed provider request tokens. Tool-loop iterations and parallel child sessions resend context, so this is not a unique-context estimate.">
            <Brain className="h-3 w-3" />
            {formatTokens(summaryStats.totalInputTokens)}→{formatTokens(summaryStats.totalOutputTokens)} provider tokens
          </span>
          <span className="flex items-center gap-1" data-testid="stat-total-cost">
            <DollarSign className="h-3 w-3" />
            {formatCost(summaryStats.totalCost)}
          </span>
          {(activeData?.activeCount ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-info" data-testid="stat-active-count">
              <Loader2 className="h-3 w-3 animate-spin" />
              {activeData?.activeCount} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={periodFilter} onValueChange={(v) => { setPeriodFilter(v); setPage(0); }}>
            <SelectTrigger className="w-[130px]" data-testid="select-period-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last Hour</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={activityFilter} onValueChange={(v) => { setActivityFilter(v); setPage(0); }}>
            <SelectTrigger className="w-[140px]" data-testid="select-activity-filter">
              <SelectValue placeholder="Activity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Activities</SelectItem>
              {activityTypes.map(type => (
                <SelectItem key={type} value={type}>{type}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="w-[120px]" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="complete">Current Run</SelectItem>
              <SelectItem value="past">Past Runs</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 px-4 @md:px-6 pb-4 @md:pb-6 gap-4">
        <ScrollArea className={`flex-1 min-h-0 ${selectedCall ? "hidden @md:block @md:flex-1" : ""}`}>
          <div className="pr-2 py-1">
            {listContent}
          </div>
        </ScrollArea>

        {selectedCall && (
          <div className="w-full @md:w-[420px] @lg:w-[480px] shrink-0 border border-border rounded-lg bg-card min-h-0 flex flex-col">
            <DetailPanel call={selectedCall} onClose={() => setSelectedCall(null)} />
          </div>
        )}
      </div>
    </div>
  );
}
