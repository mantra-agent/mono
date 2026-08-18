import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DollarSign,
  Zap,
  Hash,
  ChevronRight,
  TrendingUp,
  ChevronDown,
  SlidersHorizontal,
} from "lucide-react";
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
import { usePageHeader } from "@/hooks/use-page-header";
import { useAuth } from "@/hooks/use-auth";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { createReferenceRef } from "@shared/references";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { cn } from "@/lib/utils";

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

interface InferenceSummaryResponse {
  summary: SummaryData;
  byModel: ModelData[];
  byModelByDay: ModelTimeBucket[];
  byModelByHour: ModelTimeBucket[];
  byProfile: ProfileData[];
  currentModel: string;
  groupBy: string;
}

type GroupBy = "tier" | "activity" | "prompt" | "hierarchy";

const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: "1h", label: "Last Hour" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

function hierarchyMatchesQuery(parts: Array<string | null | undefined>, query: string): boolean {
  if (!query) return true;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function filterHierarchyData(data: HierarchyResponse | undefined, rawQuery: string): HierarchyResponse | undefined {
  if (!data) return data;
  const query = rawQuery.trim().toLowerCase();
  if (!query) return data;

  const hierarchy = data.hierarchy
    .map((tier) => {
      if (hierarchyMatchesQuery([tier.tier, tier.tierLabel], query)) return tier;

      const activities = tier.activities
        .map((act) => {
          if (hierarchyMatchesQuery([act.activity], query)) return act;

          const prompts = act.prompts
            .map((prompt) => {
              if (hierarchyMatchesQuery([prompt.prompt], query)) return prompt;

              const sessions = prompt.sessions.filter((session) =>
                hierarchyMatchesQuery(
                  [
                    session.sessionTitle,
                    session.sessionKey,
                    session.chatSessionId,
                    ...session.inferenceCalls.flatMap((call) => [
                      String(call.id),
                      call.provider,
                      call.model,
                      call.profile,
                      call.captureId,
                      call.runId,
                    ]),
                  ],
                  query,
                ),
              );
              if (sessions.length === 0) return null;
              return { ...prompt, sessions };
            })
            .filter((prompt): prompt is HierarchyPrompt => prompt != null);

          if (prompts.length === 0) return null;
          return { ...act, prompts };
        })
        .filter((act): act is HierarchyActivity => act != null);

      if (activities.length === 0) return null;
      return { ...tier, activities };
    })
    .filter((tier): tier is HierarchyTier => tier != null);

  return { ...data, hierarchy };
}

interface HierarchyInferenceCall { id: number; timestamp: string; provider: string; model: string; profile: string | null; inputTokens: number; outputTokens: number; totalTokens: number; costTotal: number; durationMs: number | null; runId: string | null; captureId: string | null; }
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
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`;
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

function HierarchyBreakdown({ data, searchQuery }: { data?: HierarchyResponse; searchQuery: string }) {
  const [expandedTiers, setExpandedTiers] = useState<Set<string>>(new Set());
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(new Set());
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<HierarchySortField>("tokens");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const filtered = useMemo(() => filterHierarchyData(data, searchQuery), [data, searchQuery]);

  if (!filtered || filtered.hierarchy.length === 0) {
    return (
      <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="hierarchy-empty">
        {searchQuery.trim() ? "No matching usage" : "No data yet"}
      </div>
    );
  }

  const totalCost = filtered.totals.cost;
  const totalTokens = filtered.totals.inputTokens + filtered.totals.outputTokens;

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
        {sortItems(filtered.hierarchy, totalCost, totalTokens).map((tier) => {
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
                                                  return (
                                                    <div key={call.id} className={`grid ${gridCols} gap-x-2 items-center py-0.5 px-1`}>
                                                      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={`${call.provider}/${call.model}`}>
                                                        <span className="truncate">#{call.id} · {shortenModel(call.model)}</span>
                                                        {call.captureId ? (
                                                          <ReferenceRenderer
                                                            refValue={createReferenceRef({ type: "inference_context", id: call.captureId, metadata: { label: "Context" } })}
                                                            surface="simple-chip"
                                                            className="mx-0 shrink-0"
                                                          />
                                                        ) : <span className="shrink-0 text-muted-foreground/60">Context unavailable</span>}
                                                      </span>
                                                      <span className="text-right tabular-nums text-xs">1</span>
                                                      <span className="text-right tabular-nums text-xs" title="Provider input → output tokens">{formatTokens(call.inputTokens)}→{formatTokens(call.outputTokens)}</span>
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
        <span className="text-right tabular-nums text-xs font-semibold">{filtered.totals.calls}</span>
        <span className="text-right tabular-nums text-xs font-semibold">{formatTokens(totalTokens)}</span>
        <span className="text-right tabular-nums text-xs text-muted-foreground">100%</span>
        <span className="text-right tabular-nums text-sm font-semibold">{formatCost(filtered.totals.cost)}</span>
      </div>
    </div>
  );
}

export default function CostPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Cost", skip: !!embedded });
  const { timezone } = useTimezone();
  const { hasPermission } = useAuth();
  const reportsAllAccounts = hasPermission("system:read");
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState("today");
  const [groupBy, setGroupBy] = useState<GroupBy>("hierarchy");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [searchQuery, setSearchQuery] = useState("");

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
  const mixerActive =
    period !== "today" ||
    groupBy !== "hierarchy" ||
    chartMetric !== "tokens" ||
    (inferenceDebug?.enabled ?? false);

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

  const summary = summaryData?.summary;
  const byProfile = summaryData?.byProfile || [];
  const byModelByDay = summaryData?.byModelByDay || [];
  const byModelByHour = summaryData?.byModelByHour || [];

  const allKeys = useMemo(() => {
    const keySet = new Set<string>();
    for (const b of byModelByDay) keySet.add(b.model);
    for (const b of byModelByHour) keySet.add(b.model);
    return Array.from(keySet).sort((a, b) => {
      if (chartGroupBy === "tier") {
        const tierOrder = ["max", "high", "balanced", "fast", "embed", "unknown"];
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
  const breakdownTitle = groupBy === "hierarchy" ? "Usage Hierarchy" : `By ${GROUP_LABELS[groupBy]}`;

  const breakdownBody = (() => {
    if (groupBy === "hierarchy") {
      return <HierarchyBreakdown data={hierarchyData} searchQuery={searchQuery} />;
    }

    if (groupBy === "prompt") {
      const profiles = byProfile.filter((p) =>
        hierarchyMatchesQuery([p.profile, p.name], searchQuery.trim().toLowerCase()),
      );
      if (profiles.length === 0) {
        return (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {searchQuery.trim() ? "No matching usage" : "No data yet"}
          </div>
        );
      }
      return (
        <div className="space-y-3 px-2">
          {profiles.map((p) => {
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

    const query = searchQuery.trim().toLowerCase();
    const sortedKeys = Object.entries(aggregated)
      .filter(([key]) => hierarchyMatchesQuery([key], query))
      .sort((a, b) => {
        if (groupBy === "tier") {
          const tierOrder = ["max", "high", "balanced", "fast", "embed", "unknown"];
          return tierOrder.indexOf(a[0]) - tierOrder.indexOf(b[0]);
        }
        return b[1].cost - a[1].cost;
      });

    if (sortedKeys.length === 0) {
      return (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          {searchQuery.trim() ? "No matching usage" : "No data yet"}
        </div>
      );
    }

    const totalCostForPct = sortedKeys.reduce((s, [, v]) => s + v.cost, 0);

    return (
      <div className="space-y-3 px-2">
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
  })();

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="cost-page">
          <div className="mb-1 flex items-center gap-1.5">
            <div className="min-w-0 flex-1 [&>div]:mb-0">
              <HierarchySearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                inputTestId="input-search-cost"
                clearTestId="button-clear-cost-search"
                ariaLabel="Search usage hierarchy"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "mb-0 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    mixerActive && "border-foreground/40 text-foreground",
                  )}
                  aria-label="Cost mixer"
                  data-testid="button-cost-mixer"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="menu-cost-period">Period</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup value={period} onValueChange={setPeriod}>
                      {PERIOD_OPTIONS.map((option) => (
                        <DropdownMenuRadioItem
                          key={option.value}
                          value={option.value}
                          data-testid={`menu-cost-period-${option.value}`}
                        >
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="menu-cost-group-by">Group by</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)}>
                      {(["hierarchy", "tier", "activity", "prompt"] as GroupBy[]).map((g) => (
                        <DropdownMenuRadioItem
                          key={g}
                          value={g}
                          data-testid={`button-group-${g}`}
                        >
                          {GROUP_LABELS[g]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="menu-cost-chart-metric">Chart metric</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={chartMetric}
                      onValueChange={(value) => setChartMetric(value as ChartMetric)}
                    >
                      <DropdownMenuRadioItem value="tokens" data-testid="button-metric-tokens">
                        Tokens
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="cost" data-testid="button-metric-cost">
                        Cost
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuCheckboxItem
                  checked={inferenceDebug?.enabled ?? false}
                  disabled={toggleDebugMutation.isPending}
                  onCheckedChange={(checked) => toggleDebugMutation.mutate(checked === true)}
                  onSelect={(event) => event.preventDefault()}
                  data-testid="menu-cost-store-content"
                >
                  Store call content
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="space-y-1">
            <ProfileTreeRow
              label="Total Cost"
              icon={<DollarSign className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="row-total-cost"
            >
              <span data-testid="text-total-cost">
                {summaryLoading ? "…" : formatCost(summary?.totalCost || 0)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {reportsAllAccounts ? "All accounts" : "This account"}
                </span>
              </span>
            </ProfileTreeRow>
            <ProfileTreeRow
              label="API Calls"
              icon={<Hash className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="row-total-calls"
            >
              <span data-testid="text-total-calls">
                {summaryLoading ? "…" : (summary?.totalCalls || 0)}
              </span>
            </ProfileTreeRow>
            <ProfileTreeRow
              label="Input Tokens"
              icon={<Zap className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="row-input-tokens"
            >
              <span data-testid="text-input-tokens">
                {summaryLoading ? "…" : formatTokens(summary?.totalInputTokens || 0)}
              </span>
            </ProfileTreeRow>
            <ProfileTreeRow
              label="Output Tokens"
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="row-output-tokens"
            >
              <span data-testid="text-output-tokens">
                {summaryLoading ? "…" : formatTokens(summary?.totalOutputTokens || 0)}
              </span>
            </ProfileTreeRow>
          </div>

          <section data-testid="card-cost-chart" className="space-y-2 pt-2">
            <div className={HIERARCHY_SECTION_HEADER_CLASS}>{chartTitle}</div>
            {chartData.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No data yet
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
          </section>

          <section data-testid="card-breakdown" className="space-y-2 pt-2">
            <div className={HIERARCHY_SECTION_HEADER_CLASS}>{breakdownTitle}</div>
            {breakdownBody}
          </section>
        </div>
      </div>
    </div>
  );
}
