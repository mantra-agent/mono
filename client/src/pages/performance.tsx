import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DollarSign,
  Zap,
  Hash,
  ChevronLeft,
  ChevronRight,
  Eye,
  TrendingUp,
  ChevronDown,
  Database,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useTimezone } from "@/hooks/use-timezone";
import { getApiCallErrorText, shouldShowApiCallResponse } from "@/lib/api-call-diagnostics";
import { usePageHeader } from "@/hooks/use-page-header";

interface SummaryData {
  totalCalls: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

interface ModelTimeBucket {
  date?: string;
  hour?: string;
  model: string;
  cost: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

type ChartMetric = "cost" | "tokens";

interface ModelData {
  provider: string;
  model: string;
  calls: number;
  cost: number;
  tokens: number;
}

interface ProfileData {
  profile: string;
  name?: string;
  calls: number;
  cost: number;
  tokens: number;
  avgDuration: number | null;
  totalDuration: number;
  inputTokens: number;
  outputTokens: number;
}

interface ApiCallRow {
  id: number;
  timestamp: string;
  provider: string;
  model: string;
  profile: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costTotal: number;
  sessionKey: string | null;
  sessionId: number | null;
  requestContent: string | null;
  responseContent: string | null;
  durationMs: number | null;
  stopReason: string | null;
  metadata?: Record<string, unknown> | null;
}

interface InferenceSummaryResponse {
  summary: SummaryData;
  byModel: ModelData[];
  byModelByDay: ModelTimeBucket[];
  byModelByHour: ModelTimeBucket[];
  byProfile: ProfileData[];
  currentModel: string;
  groupBy: string;
}

interface CallsResponse {
  calls: ApiCallRow[];
  total: number;
  limit: number;
  offset: number;
}

type GroupBy = "tier" | "activity" | "prompt" | "hierarchy";

interface HierarchyInferenceCall { id: number; timestamp: string; provider: string; model: string; profile: string | null; inputTokens: number; outputTokens: number; totalTokens: number; costTotal: number; durationMs: number | null; runId: string | null; }
interface HierarchySession { sessionKey: string; sessionId: number | null; sessionTitle: string | null; chatSessionId: string | null; cost: number; calls: number; inputTokens: number; outputTokens: number; inferenceCalls: HierarchyInferenceCall[]; }
interface HierarchyPrompt { prompt: string; cost: number; calls: number; inputTokens: number; outputTokens: number; sessions: HierarchySession[]; }
interface HierarchyActivity { activity: string; cost: number; calls: number; inputTokens: number; outputTokens: number; prompts: HierarchyPrompt[]; }
interface HierarchyTier { tier: string; tierLabel: string; cost: number; calls: number; inputTokens: number; outputTokens: number; activities: HierarchyActivity[]; }
interface HierarchyResponse { hierarchy: HierarchyTier[]; totals: { cost: number; calls: number; inputTokens: number; outputTokens: number }; }

type HierarchySortField = "calls" | "tokens" | "pct" | "cost";
type SortDir = "asc" | "desc";

const CHART_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-2, 160 60% 45%))",
  "hsl(var(--chart-3, 30 80% 55%))",
  "hsl(var(--chart-4, 280 65% 60%))",
  "hsl(var(--chart-5, 340 75% 55%))",
  "hsl(200, 70%, 50%)",
  "hsl(45, 90%, 55%)",
  "hsl(320, 60%, 50%)",
  "hsl(100, 50%, 45%)",
  "hsl(0, 70%, 55%)",
  "hsl(240, 50%, 60%)",
  "hsl(60, 80%, 45%)",
];

const TIER_COLORS: Record<string, string> = {
  max: "hsl(45, 90%, 55%)",
  high: "hsl(280, 65%, 60%)",
  balanced: "hsl(200, 70%, 50%)",
  fast: "hsl(160, 60%, 45%)",
  embed: "hsl(100, 50%, 45%)",
  unknown: "hsl(0, 0%, 50%)",
};

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return "0";
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[parseInt(parts[1], 10) - 1] || parts[1];
    const day = parseInt(parts[2], 10);
    return `${month} ${day}`;
  }
  return dateStr;
}

function formatHourRaw(h: number): string {
  if (h === 24 || h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

function formatHour(hourStr: string): string {
  const match = hourStr.match(/(\d{2}):00$/);
  if (match) {
    return formatHourRaw(parseInt(match[1], 10));
  }
  return hourStr;
}

function formatHourInTimezone(hourStr: string, tz: string): string {
  const match = hourStr.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):00$/);
  if (match) {
    const utcDate = new Date(`${match[1]}T${match[2]}:00:00Z`);
    const localHour = parseInt(
      utcDate.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }),
      10
    );
    return formatHourRaw(localHour);
  }
  return formatHour(hourStr);
}

function formatTimestamp(ts: string, timezone: string): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: timezone,
  });
}

function shortenModel(model: string): string {
  if (model.length <= 16) return model;
  const parts = model.split("-");
  if (parts.length >= 3) {
    const datePart = parts[parts.length - 1];
    if (/^\d{8}$/.test(datePart)) {
      return parts.slice(0, -1).join("-");
    }
  }
  return model;
}

function buildStackedData(
  timeBuckets: ModelTimeBucket[],
  timeKey: "date" | "hour",
  allKeys: string[],
  metric: ChartMetric = "cost",
): Record<string, any>[] {
  const grouped: Record<string, Record<string, number>> = {};

  for (const bucket of timeBuckets) {
    const key = bucket[timeKey] || "";
    if (!grouped[key]) {
      grouped[key] = {};
    }
    grouped[key][bucket.model] = (grouped[key][bucket.model] || 0) + (bucket[metric] || 0);
  }

  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, values]) => {
      const row: Record<string, any> = { [timeKey]: time };
      for (const k of allKeys) {
        row[k] = values[k] || 0;
      }
      return row;
    });
}

const GROUP_LABELS: Record<GroupBy, string> = {
  hierarchy: "Hierarchy",
  tier: "Model Tier",
  activity: "Activity Type",
  prompt: "Prompt Type",
};

function isHourlyPeriod(period: string): boolean {
  return period === "1h" || period === "today";
}

function getColorForKey(key: string, index: number, groupBy: GroupBy): string {
  if (groupBy === "tier" && TIER_COLORS[key]) {
    return TIER_COLORS[key];
  }
  return CHART_COLORS[index % CHART_COLORS.length];
}

function HierarchyBreakdown({ data }: { data?: HierarchyResponse }) {
  const [expandedTiers, setExpandedTiers] = useState<Set<string>>(new Set());
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(new Set());
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<HierarchySortField>("tokens");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  if (!data || data.hierarchy.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground" data-testid="hierarchy-empty">
        No data yet
      </div>
    );
  }

  const totalCost = data.totals.cost;
  const totalTokens = data.totals.inputTokens + data.totals.outputTokens;

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSort = (field: HierarchySortField) => {
    if (sortBy === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(field); setSortDir("desc"); }
  };

  const sortIndicator = (field: HierarchySortField) => {
    if (sortBy !== field) return null;
    return <span className="text-primary">{sortDir === "desc" ? "↓" : "↑"}</span>;
  };

  function sortItems<T>(items: T[], parentCost: number, parentTokens: number): T[] {
    return [...items].sort((a: any, b: any) => {
      let va: number, vb: number;
      const tokensA = (a.inputTokens || 0) + (a.outputTokens || 0);
      const tokensB = (b.inputTokens || 0) + (b.outputTokens || 0);
      switch (sortBy) {
        case "calls": va = a.calls || 0; vb = b.calls || 0; break;
        case "tokens": va = tokensA; vb = tokensB; break;
        case "pct": va = parentCost > 0 ? (a.cost || 0) / parentCost : 0; vb = parentCost > 0 ? (b.cost || 0) / parentCost : 0; break;
        case "cost": va = a.cost || 0; vb = b.cost || 0; break;
        default: va = 0; vb = 0;
      }
      return sortDir === "desc" ? vb - va : va - vb;
    });
  }

  const gridCols = "grid-cols-[1fr_4rem_5rem_3rem_4.5rem]";

  const HeaderRow = () => (
    <div className={`grid ${gridCols} gap-x-2 text-xs text-muted-foreground font-medium border-b pb-1.5 mb-1`}>
      <span>Name</span>
      <button onClick={() => toggleSort("calls")} className="text-right cursor-pointer hover:text-foreground">Calls {sortIndicator("calls")}</button>
      <button onClick={() => toggleSort("tokens")} className="text-right cursor-pointer hover:text-foreground">Tokens {sortIndicator("tokens")}</button>
      <button onClick={() => toggleSort("pct")} className="text-right cursor-pointer hover:text-foreground">% {sortIndicator("pct")}</button>
      <button onClick={() => toggleSort("cost")} className="text-right cursor-pointer hover:text-foreground">Cost {sortIndicator("cost")}</button>
    </div>
  );

  const DataCells = ({ calls, tokens, pct, cost, size = "sm" }: { calls: number; tokens: number; pct: string; cost: number; size?: "sm" | "xs" }) => {
    const textClass = size === "sm" ? "text-xs" : "text-xs";
    return (
      <>
        <span className={`text-right tabular-nums ${textClass}`}>{calls}</span>
        <span className={`text-right tabular-nums ${textClass}`}>{formatTokens(tokens)}</span>
        <span className={`text-right tabular-nums ${textClass} text-muted-foreground`}>{pct}%</span>
        <span className={`text-right tabular-nums ${textClass} font-medium`}>{formatCost(cost)}</span>
      </>
    );
  };

  return (
    <div data-testid="hierarchy-breakdown">
      <HeaderRow />
      <div className="space-y-0.5">
        {sortItems(data.hierarchy, totalCost, totalTokens).map((tier) => {
          const tierExpanded = expandedTiers.has(tier.tier);
          const tierPct = totalCost > 0 ? ((tier.cost / totalCost) * 100).toFixed(0) : "0";
          const tierTokens = tier.inputTokens + tier.outputTokens;
          return (
            <div key={tier.tier} data-testid={`hierarchy-tier-${tier.tier}`}>
              <button
                className={`w-full grid ${gridCols} gap-x-2 items-center py-1.5 px-1 rounded-md hover:bg-muted/50 transition-colors`}
                onClick={() => toggleSet(setExpandedTiers, tier.tier)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {tierExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: TIER_COLORS[tier.tier] || TIER_COLORS.unknown }} />
                  <span className="text-sm font-semibold truncate">{tier.tierLabel}</span>
                </div>
                <DataCells calls={tier.calls} tokens={tierTokens} pct={tierPct} cost={tier.cost} />
              </button>

              {tierExpanded && (
                <div className="ml-5 border-l border-border/50 pl-3 space-y-0.5">
                  {sortItems(tier.activities, tier.cost, tierTokens).map((act) => {
                    const actKey = `${tier.tier}:${act.activity}`;
                    const actExpanded = expandedActivities.has(actKey);
                    const actPct = tier.cost > 0 ? ((act.cost / tier.cost) * 100).toFixed(0) : "0";
                    const actTokens = act.inputTokens + act.outputTokens;
                    return (
                      <div key={actKey}>
                        <button
                          className={`w-full grid ${gridCols} gap-x-2 items-center py-1 px-1 rounded-md hover:bg-muted/30 transition-colors`}
                          onClick={() => toggleSet(setExpandedActivities, actKey)}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {actExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                            <span className="text-sm font-medium truncate">{act.activity}</span>
                          </div>
                          <DataCells calls={act.calls} tokens={actTokens} pct={actPct} cost={act.cost} size="xs" />
                        </button>

                        {actExpanded && (
                          <div className="ml-5 border-l border-border/30 pl-3 space-y-0.5">
                            {sortItems(act.prompts, act.cost, actTokens).map((p) => {
                              const promptKey = `${actKey}:${p.prompt}`;
                              const promptExpanded = expandedPrompts.has(promptKey);
                              const promptPct = act.cost > 0 ? ((p.cost / act.cost) * 100).toFixed(0) : "0";
                              const promptTokens = p.inputTokens + p.outputTokens;
                              const hasSessions = p.sessions && p.sessions.length > 0;
                              return (
                                <div key={p.prompt}>
                                  <button
                                    className={`w-full grid ${gridCols} gap-x-2 items-center py-1 px-1 rounded-md hover:bg-muted/20 transition-colors`}
                                    onClick={() => hasSessions && toggleSet(setExpandedPrompts, promptKey)}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      {hasSessions ? (
                                        promptExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                      ) : <span className="w-3 shrink-0" />}
                                      <Badge variant="outline" className="text-xs font-normal truncate max-w-[180px]">
                                        {p.prompt === act.activity ? `${p.prompt} (unlabeled)` : p.prompt}
                                      </Badge>
                                    </div>
                                    <DataCells calls={p.calls} tokens={promptTokens} pct={promptPct} cost={p.cost} size="xs" />
                                  </button>

                                  {promptExpanded && p.sessions && (
                                    <div className="ml-5 border-l border-border/20 pl-3 space-y-0.5">
                                      {sortItems(p.sessions, p.cost, promptTokens).map((s) => {
                                        const sTokens = s.inputTokens + s.outputTokens;
                                        return (
                                          <div key={s.sessionKey}>
                                            <button
                                              className={`w-full grid ${gridCols} gap-x-2 items-center py-0.5 px-1 rounded-md hover:bg-muted/10 transition-colors`}
                                              onClick={() => toggleSet(setExpandedSessions, `${promptKey}:${s.sessionKey}`)}
                                            >
                                              <div className="flex items-center gap-1.5 min-w-0">
                                                {expandedSessions.has(`${promptKey}:${s.sessionKey}`) ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                                                {s.chatSessionId ? (
                                                  <a href={`/session?c=${encodeURIComponent(s.chatSessionId)}`} onClick={(e) => e.stopPropagation()} className="text-xs text-muted-foreground hover:text-foreground truncate transition-colors" title={s.sessionTitle || s.sessionKey}>
                                                    {s.sessionTitle || s.sessionKey}
                                                  </a>
                                                ) : (
                                                  <span className="text-xs text-muted-foreground truncate" title={s.sessionTitle || s.sessionKey}>
                                                    {s.sessionTitle || s.sessionKey}
                                                  </span>
                                                )}
                                              </div>
                                              <span className="text-right tabular-nums text-xs">{s.calls}</span>
                                              <span className="text-right tabular-nums text-xs">{formatTokens(sTokens)}</span>
                                              <span className="text-right tabular-nums text-xs text-muted-foreground">—</span>
                                              <span className="text-right tabular-nums text-xs">{formatCost(s.cost)}</span>
                                            </button>
                                            {expandedSessions.has(`${promptKey}:${s.sessionKey}`) && (
                                              <div className="ml-5 border-l border-border/10 pl-3 space-y-0.5">
                                                {s.inferenceCalls.map((call) => {
                                                  const callTokens = call.totalTokens || call.inputTokens + call.outputTokens;
                                                  return (
                                                    <div key={call.id} className={`grid ${gridCols} gap-x-2 items-center py-0.5 px-1`}>
                                                      <span className="text-xs text-muted-foreground truncate" title={`${call.provider}/${call.model}`}>
                                                        #{call.id} · {shortenModel(call.model)}
                                                      </span>
                                                      <span className="text-right tabular-nums text-xs">1</span>
                                                      <span className="text-right tabular-nums text-xs">{formatTokens(callTokens)}</span>
                                                      <span className="text-right tabular-nums text-xs text-muted-foreground">—</span>
                                                      <span className="text-right tabular-nums text-xs">{formatCost(call.costTotal)}</span>
                                                    </div>
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
          );
        })}
      </div>

      <div className={`grid ${gridCols} gap-x-2 items-center pt-3 mt-2 border-t border-border`}>
        <span className="text-sm font-semibold">Total</span>
        <span className="text-right tabular-nums text-xs font-semibold">{data.totals.calls}</span>
        <span className="text-right tabular-nums text-xs font-semibold">{formatTokens(totalTokens)}</span>
        <span className="text-right tabular-nums text-xs text-muted-foreground">100%</span>
        <span className="text-right tabular-nums text-sm font-semibold">{formatCost(data.totals.cost)}</span>
      </div>
    </div>
  );
}

export default function Performance({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Performance", skip: !!embedded });
  const { timezone } = useTimezone();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState("today");
  const [groupBy, setGroupBy] = useState<GroupBy>("hierarchy");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [page, setPage] = useState(0);
  const [selectedCall, setSelectedCall] = useState<ApiCallRow | null>(null);
  const [callLogOpen, setCallLogOpen] = useState(false);
  const pageSize = 20;

  const { data: inferenceDebug } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/settings/inference-debug"],
    queryFn: async () => {
      const res = await fetch("/api/settings/inference-debug");
      if (!res.ok) throw new Error("Failed to fetch setting");
      return res.json();
    },
  });

  const toggleDebugMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await apiRequest("PUT", "/api/settings/inference-debug", { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/inference-debug"] });
    },
  });

  const chartGroupBy = groupBy === "hierarchy" ? "tier" : groupBy;

  const { data: summaryData, isLoading: summaryLoading } =
    useQuery<InferenceSummaryResponse>({
      queryKey: ["/api/inference/summary", period, chartGroupBy, timezone],
      queryFn: async () => {
        const res = await fetch(`/api/inference/summary?period=${period}&groupBy=${chartGroupBy}&tz=${encodeURIComponent(timezone)}`);
        if (!res.ok) throw new Error("Failed to fetch summary");
        return res.json();
      },
      refetchInterval: 30000,
    });

  const { data: hierarchyData } =
    useQuery<HierarchyResponse>({
      queryKey: ["/api/inference/summary/hierarchy", period, timezone],
      queryFn: async () => {
        const res = await fetch(`/api/inference/summary/hierarchy?period=${period}&tz=${encodeURIComponent(timezone)}`);
        if (!res.ok) throw new Error("Failed to fetch hierarchy");
        return res.json();
      },
      enabled: groupBy === "hierarchy",
      refetchInterval: 30000,
    });

  const { data: callsData, isLoading: callsLoading } =
    useQuery<CallsResponse>({
      queryKey: ["/api/performance/calls", page],
      queryFn: async () => {
        const res = await fetch(`/api/performance/calls?limit=${pageSize}&offset=${page * pageSize}`);
        if (!res.ok) throw new Error("Failed to fetch calls");
        return res.json();
      },
      enabled: callLogOpen,
    });

  const summary = summaryData?.summary;
  const byModel = summaryData?.byModel || [];
  const byProfile = summaryData?.byProfile || [];
  const byModelByDay = summaryData?.byModelByDay || [];
  const byModelByHour = summaryData?.byModelByHour || [];
  const calls = callsData?.calls || [];
  const totalCalls = callsData?.total || 0;
  const totalPages = Math.ceil(totalCalls / pageSize);

  const allKeys = useMemo(() => {
    const keySet = new Set<string>();
    for (const b of byModelByDay) keySet.add(b.model);
    for (const b of byModelByHour) keySet.add(b.model);
    return Array.from(keySet).sort((a, b) => {
      if (chartGroupBy === "tier") {
        const tierOrder = ["max", "high", "balanced", "fast", "advocate", "advisary", "embed", "unknown"];
        return tierOrder.indexOf(a) - tierOrder.indexOf(b);
      }
      const valA = byModelByDay.filter(x => x.model === a).reduce((s, x) => s + (x[chartMetric] || 0), 0)
        + byModelByHour.filter(x => x.model === a).reduce((s, x) => s + (x[chartMetric] || 0), 0);
      const valB = byModelByDay.filter(x => x.model === b).reduce((s, x) => s + (x[chartMetric] || 0), 0)
        + byModelByHour.filter(x => x.model === b).reduce((s, x) => s + (x[chartMetric] || 0), 0);
      return valB - valA;
    });
  }, [byModelByDay, byModelByHour, chartGroupBy, chartMetric]);

  const useHourly = isHourlyPeriod(period);

  const chartData = useMemo(() => {
    if (useHourly) {
      return buildStackedData(byModelByHour, "hour", allKeys, chartMetric);
    }
    return buildStackedData(byModelByDay, "date", allKeys, chartMetric);
  }, [useHourly, byModelByHour, byModelByDay, allKeys, chartMetric]);

  const renderLegend = () => {
    if (allKeys.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
        {allKeys.map((key, i) => (
          <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: getColorForKey(key, i, chartGroupBy) }}
            />
            <span className="font-mono truncate max-w-[140px]">
              {chartGroupBy === "tier" ? (key.charAt(0).toUpperCase() + key.slice(1)) : shortenModel(key)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  const formatChartValue = chartMetric === "cost" ? formatCost : formatTokens;

  const stackedTooltipFormatter = (value: number, name: string) => {
    const label = chartGroupBy === "tier"
      ? (name.charAt(0).toUpperCase() + name.slice(1))
      : shortenModel(name);
    return [formatChartValue(value), label];
  };

  const chartTitle = `${chartMetric === "cost" ? "Cost" : "Tokens"} by ${useHourly ? "Hour" : "Day"}`;

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4 @sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <Label htmlFor="inference-debug" className="text-xs text-muted-foreground cursor-pointer">
            Store call content
          </Label>
          <Switch
            id="inference-debug"
            checked={inferenceDebug?.enabled ?? false}
            onCheckedChange={(checked) => toggleDebugMutation.mutate(checked)}
            disabled={toggleDebugMutation.isPending}
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center border rounded-md overflow-hidden" data-testid="toggle-group-by">
            {(["hierarchy", "tier", "activity", "prompt"] as GroupBy[]).map((g) => (
              <button
                key={g}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  groupBy === g
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setGroupBy(g)}
                data-testid={`button-group-${g}`}
              >
                {GROUP_LABELS[g]}
              </button>
            ))}
          </div>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[130px]" data-testid="select-period">
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
        </div>
      </div>

      <div className="grid gap-4 @sm:grid-cols-2 @lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-cost">
              {summaryLoading ? "..." : formatCost(summary?.totalCost || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">API Calls</CardTitle>
            <Hash className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-calls">
              {summaryLoading ? "..." : (summary?.totalCalls || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Input Tokens</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-input-tokens">
              {summaryLoading ? "..." : formatTokens(summary?.totalInputTokens || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Output Tokens</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-output-tokens">
              {summaryLoading ? "..." : formatTokens(summary?.totalOutputTokens || 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-cost-chart">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base font-semibold">{chartTitle}</CardTitle>
            <div className="flex items-center border rounded-md overflow-hidden" data-testid="toggle-chart-metric">
              <button
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  chartMetric === "cost"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setChartMetric("cost")}
                data-testid="button-metric-cost"
              >$</button>
              <button
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  chartMetric === "tokens"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setChartMetric("tokens")}
                data-testid="button-metric-tokens"
              >Tokens</button>
            </div>
          </div>
          <Badge variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="badge-group-by">
            {GROUP_LABELS[chartGroupBy]}
          </Badge>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
              No data yet. Start chatting with Agent to see usage stats.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey={useHourly ? "hour" : "date"}
                    tickFormatter={(v: string) => useHourly ? formatHour(v) : formatDate(v)}
                    className="text-xs"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatChartValue(v)}
                    className="text-xs"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    width={chartMetric === "tokens" ? 70 : 60}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={stackedTooltipFormatter}
                    labelFormatter={(label: string) => {
                      if (useHourly) {
                        const parts = label.split(" ");
                        if (parts.length === 2) {
                          return `${formatDate(parts[0])} ${formatHour(label)}`;
                        }
                        return label;
                      }
                      return formatDate(label);
                    }}
                  />
                  {allKeys.map((key, i) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="metric"
                      fill={getColorForKey(key, i, chartGroupBy)}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              {renderLegend()}
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-breakdown">
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            {groupBy === "hierarchy" ? "Usage Hierarchy" : `By ${GROUP_LABELS[groupBy]}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            if (groupBy === "hierarchy") {
              return <HierarchyBreakdown data={hierarchyData} />;
            }

            if (groupBy === "prompt") {
              if (byProfile.length === 0) {
                return (
                  <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
                    No data yet
                  </div>
                );
              }
              return (
                <div className="space-y-3">
                  {byProfile.map((p) => {
                    const pctOfTotal = summary && summary.totalCost > 0
                      ? ((p.cost / summary.totalCost) * 100).toFixed(0)
                      : "0";
                    return (
                      <div key={p.profile} className="space-y-1" data-testid={`breakdown-item-${p.profile}`}>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="bg-cat-ai/15 text-cat-ai-foreground border border-cat-ai/30 rounded-sm text-xs font-medium px-2 py-0.5">{p.name || p.profile}</Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{pctOfTotal}%</span>
                            <span className="text-sm font-medium">{formatCost(p.cost)}</span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{p.calls} calls</span>
                          <span>{p.avgDuration != null ? `avg ${formatDuration(p.avgDuration)}` : ""}</span>
                          <span>{formatTokens(p.tokens)} tokens</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            }

            const aggregated: Record<string, { cost: number; count: number }> = {};
            const buckets = useHourly ? byModelByHour : byModelByDay;
            for (const b of buckets) {
              if (!aggregated[b.model]) {
                aggregated[b.model] = { cost: 0, count: 0 };
              }
              aggregated[b.model].cost += b.cost;
              aggregated[b.model].count += 1;
            }

            const sortedKeys = Object.entries(aggregated)
              .sort((a, b) => {
                if (groupBy === "tier") {
                  const tierOrder = ["max", "high", "balanced", "fast", "advocate", "advisary", "embed", "unknown"];
                  return tierOrder.indexOf(a[0]) - tierOrder.indexOf(b[0]);
                }
                return b[1].cost - a[1].cost;
              });

            if (sortedKeys.length === 0) {
              return (
                <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
                  No data yet
                </div>
              );
            }

            const totalCostForPct = sortedKeys.reduce((s, [, v]) => s + v.cost, 0);

            return (
              <div className="space-y-3">
                {sortedKeys.map(([key, data], i) => {
                  const pctOfTotal = totalCostForPct > 0
                    ? ((data.cost / totalCostForPct) * 100).toFixed(0)
                    : "0";
                  return (
                    <div key={key} className="space-y-1" data-testid={`breakdown-item-${key}`}>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: getColorForKey(key, i, groupBy) }}
                          />
                          <span className="text-sm font-medium">
                            {groupBy === "tier" ? (key.charAt(0).toUpperCase() + key.slice(1)) : key}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{pctOfTotal}%</span>
                          <span className="text-sm font-medium">{formatCost(data.cost)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      <Collapsible open={callLogOpen} onOpenChange={setCallLogOpen}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="flex flex-row items-center justify-between gap-2 cursor-pointer hover-elevate rounded-md">
              <CardTitle className="text-base font-semibold">API Call Log</CardTitle>
              <div className="flex items-center gap-2">
                {summary && summary.totalCalls > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {summary.totalCalls} total calls
                  </span>
                )}
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${callLogOpen ? "rotate-180" : ""}`} />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent>
              {callsLoading ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  Loading...
                </div>
              ) : calls.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  No API calls recorded yet. Chat with Agent to generate activity.
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid="table-api-calls">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="pb-2 pr-3 font-medium text-muted-foreground">Time</th>
                          <th className="pb-2 pr-3 font-medium text-muted-foreground">Model</th>
                          <th className="pb-2 pr-3 font-medium text-muted-foreground text-right">Input</th>
                          <th className="pb-2 pr-3 font-medium text-muted-foreground text-right">Output</th>
                          <th className="pb-2 pr-3 font-medium text-muted-foreground text-right">Cost</th>
                          <th className="pb-2 pr-3 font-medium text-muted-foreground text-right">Duration</th>
                          <th className="pb-2 font-medium text-muted-foreground"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {calls.map((call) => (
                          <tr
                            key={call.id}
                            className="border-b last:border-b-0 hover-elevate"
                            data-testid={`row-api-call-${call.id}`}
                          >
                            <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                              {formatTimestamp(call.timestamp, timezone)}
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant="outline" className="text-xs font-mono">
                                  {call.provider}
                                </Badge>
                                <Badge variant="secondary" className="bg-cat-ai/15 text-cat-ai-foreground border border-cat-ai/30 rounded-sm text-xs font-medium font-mono px-2 py-0.5 truncate max-w-[120px]">{call.model}</Badge>
                                {call.profile && (
                                  <Badge variant="secondary" className="bg-cat-ai/15 text-cat-ai-foreground border border-cat-ai/30 rounded-sm text-xs font-medium px-2 py-0.5">
                                    {call.profile}
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-xs">
                              {formatTokens(call.inputTokens)}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-xs">
                              {formatTokens(call.outputTokens)}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-xs font-medium">
                              {formatCost(call.costTotal)}
                            </td>
                            <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
                              {formatDuration(call.durationMs)}
                            </td>
                            <td className="py-2">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setSelectedCall(call)}
                                data-testid={`button-view-call-${call.id}`}
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-2 mt-4 pt-4 border-t">
                      <span className="text-xs text-muted-foreground">
                        Page {page + 1} of {totalPages}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="outline"
                          disabled={page === 0}
                          onClick={() => setPage(Math.max(0, page - 1))}
                          data-testid="button-prev-page"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          disabled={page >= totalPages - 1}
                          onClick={() => setPage(page + 1)}
                          data-testid="button-next-page"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Dialog open={!!selectedCall} onOpenChange={(open) => !open && setSelectedCall(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">API Call Details</DialogTitle>
          </DialogHeader>
          {selectedCall && (() => {
            const errorText = getApiCallErrorText(selectedCall);
            const showResponse = shouldShowApiCallResponse(selectedCall.responseContent, errorText);

            return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-muted-foreground">Provider</span>
                  <p className="text-sm font-medium">{selectedCall.provider}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Model</span>
                  <p className="text-sm font-mono">{selectedCall.model}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Time</span>
                  <p className="text-sm">{formatTimestamp(selectedCall.timestamp, timezone)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Duration</span>
                  <p className="text-sm">{formatDuration(selectedCall.durationMs)}</p>
                </div>
                {selectedCall.profile && (
                  <div>
                    <span className="text-xs text-muted-foreground">Profile</span>
                    <p className="text-sm">
                      <Badge variant="secondary" className="bg-cat-ai/15 text-cat-ai-foreground border border-cat-ai/30 rounded-sm text-xs font-medium px-2 py-0.5">{selectedCall.profile}</Badge>
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-xs text-muted-foreground">Input Tokens</span>
                  <p className="text-sm font-mono">{selectedCall.inputTokens.toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Output Tokens</span>
                  <p className="text-sm font-mono">{selectedCall.outputTokens.toLocaleString()}</p>
                </div>
                {(selectedCall.cacheReadTokens || 0) > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground">Cache Read</span>
                    <p className="text-sm font-mono">{selectedCall.cacheReadTokens?.toLocaleString()}</p>
                  </div>
                )}
                {(selectedCall.cacheWriteTokens || 0) > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground">Cache Write</span>
                    <p className="text-sm font-mono">{selectedCall.cacheWriteTokens?.toLocaleString()}</p>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3 pt-2 border-t">
                <div>
                  <span className="text-xs text-muted-foreground">Input Cost</span>
                  <p className="text-sm font-mono">{formatCost(selectedCall.costInput)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Output Cost</span>
                  <p className="text-sm font-mono">{formatCost(selectedCall.costOutput)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Total Cost</span>
                  <p className="text-sm font-mono font-medium">{formatCost(selectedCall.costTotal)}</p>
                </div>
              </div>
              {selectedCall.requestContent && (
                <div className="pt-2 border-t">
                  <span className="text-xs text-muted-foreground">Request</span>
                  <pre className="mt-1 text-xs bg-muted/50 rounded-md p-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words">
                    {selectedCall.requestContent}
                  </pre>
                </div>
              )}
              {errorText && (
                <div className="pt-2 border-t">
                  <span className="text-xs text-error/80">Error</span>
                  <pre className="mt-1 text-xs bg-error/10 border border-error/30 rounded-md p-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words">
                    {errorText}
                  </pre>
                </div>
              )}
              {showResponse && (
                <div className="pt-2 border-t">
                  <span className="text-xs text-muted-foreground">Response</span>
                  <pre className="mt-1 text-xs bg-muted/50 rounded-md p-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words">
                    {selectedCall.responseContent}
                  </pre>
                </div>
              )}
            </div>
            );
          })()}
        </DialogContent>
      </Dialog>
        </div>
      </div>
    </div>
  );
}
