import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Search,
  Copy,
  Download,
  Pause,
  Play,
  ScrollText,
  AlertCircle,
  WrapText,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTimezone } from "@/hooks/use-timezone";
import { useLogErrors } from "@/hooks/use-log-errors";
import { createLogger } from "@/lib/logger";
import { usePageHeader } from "@/hooks/use-page-header";

const log = createLogger("logs-page");

const PAGE_SIZE = 500;

/** Severity ranking for threshold-based filtering: selecting a level shows that level and above. */
const LOG_LEVEL_RANK: Record<string, number> = { verbose: -1, debug: 0, log: 1, info: 1, warn: 2, error: 3 };

interface LogEntry {
  ts: string;
  level: string;
  source: string;
  message: string;
  line: number;
}

interface PaginatedLogResult {
  entries: LogEntry[];
  total: number;
  offset: number;
  limit: number;
}

interface LogFilesResponse {
  current: string;
  files: { filename: string; size: number; createdAt: string }[];
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-error",
  warn: "text-warning",
  info: "text-success",
  debug: "text-info",
  verbose: "text-muted-foreground/50",
};

const LEVEL_BG: Record<string, string> = {
  error: "bg-error/10",
  warn: "bg-warning/10",
  info: "",
  debug: "",
};

function formatLogTime(ts: string, timezone: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
      timeZone: timezone,
    });
  } catch {
    return ts.slice(11, 23);
  }
}

function fetchPaginatedLogs(filePath: string, offset?: number, limit: number = PAGE_SIZE, level?: string): Promise<PaginatedLogResult> {
  const params = new URLSearchParams();
  params.set("file", filePath);
  params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  if (level && level !== "all") params.set("level", level);
  return fetch(`/api/logs?${params.toString()}`)
    .then(r => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    });
}

function fetchLogFiles(): Promise<LogFilesResponse> {
  return fetch("/api/logs/files").then(r => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });
}

function LogRow({ entry, timezone, wrap, isSeen }: { entry: LogEntry; timezone: string; wrap: boolean; isSeen?: boolean }) {
  const levelColor = LEVEL_COLORS[entry.level] || "text-muted-foreground";
  // Error rows keep red text but lose the red background once scrolled into view
  const rowBg = entry.level === "error" && isSeen ? "" : (LEVEL_BG[entry.level] || "");
  const isClient = entry.source.startsWith("client:");

  return (
    <div
      className={`border-b border-border/30 ${rowBg}`}
      data-testid={`log-entry-${entry.line}`}
      data-log-level={entry.level}
    >
      {/* Desktop: single-line row with inline metadata */}
      <div className={`hidden sm:flex items-start gap-1.5 px-3 py-1 text-xs font-mono hover:bg-muted/30 ${wrap ? "" : "whitespace-nowrap"}`}>
        <span className="text-muted-foreground/60 w-[85px] shrink-0 text-right tabular-nums">
          {formatLogTime(entry.ts, timezone)}
        </span>
        <span className={`w-[38px] shrink-0 uppercase font-semibold text-xs ${levelColor}`}>
          {entry.level}
        </span>
        <Badge variant="outline" className={`text-xs px-1 py-0 shrink-0 ${isClient ? "text-active border-active/30" : "text-neutral border-neutral/30"}`}>
          {entry.source}
        </Badge>
        <span className={`text-foreground/80 min-w-0 flex-1 ${wrap ? "break-words" : "truncate"}`}>{entry.message}</span>
      </div>
      {/* Mobile: stacked layout — metadata row then full-width message */}
      <div className="sm:hidden px-2 py-1 font-mono hover:bg-muted/30">
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-muted-foreground/60 tabular-nums">
            {formatLogTime(entry.ts, timezone)}
          </span>
          <span className={`uppercase font-semibold ${levelColor}`}>
            {entry.level}
          </span>
          <Badge variant="outline" className={`text-[10px] px-1 py-0 shrink-0 ${isClient ? "text-active border-active/30" : "text-neutral border-neutral/30"}`}>
            {entry.source}
          </Badge>
        </div>
        <div className={`text-[11px] text-foreground/80 mt-0.5 ${wrap ? "break-words" : "overflow-x-auto whitespace-nowrap"}`}>
          {entry.message}
        </div>
      </div>
    </div>
  );
}

function VirtualizedLogList({ entries, timezone, wrap, parentRef, seenErrors, onErrorsSeen }: {
  entries: LogEntry[];
  timezone: string;
  wrap: boolean;
  parentRef: React.RefObject<HTMLDivElement | null>;
  seenErrors: Set<number>;
  onErrorsSeen: (ids: number[]) => void;
}) {
  const reportedRef = useRef(new Set<number>());

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 30,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Mark error entries as "seen" when they appear in the virtualizer's rendered range
  useEffect(() => {
    const newSeen: number[] = [];
    for (const item of virtualItems) {
      const entry = entries[item.index];
      if (entry?.level === "error" && !reportedRef.current.has(entry.line)) {
        reportedRef.current.add(entry.line);
        newSeen.push(entry.line);
      }
    }
    if (newSeen.length > 0) onErrorsSeen(newSeen);
  }, [virtualItems, entries, onErrorsSeen]);

  return (
    <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
      {virtualItems.map((virtualRow) => {
        const entry = entries[virtualRow.index];
        return (
          <div
            key={virtualRow.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
          >
            <LogRow entry={entry} timezone={timezone} wrap={wrap} isSeen={seenErrors.has(entry.line)} />
          </div>
        );
      })}
    </div>
  );
}

export default function LogsPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Logs", skip: !!embedded });
  const { timezone } = useTimezone();
  const { markSeen: markLogErrorsSeen } = useLogErrors();
  const { toast } = useToast();
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("info");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [seenErrors, setSeenErrors] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Verbose toggle ──────────────────────────────────────────────────
  const { data: verboseData } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/logs/verbose"],
    queryFn: () => fetch("/api/logs/verbose").then(r => r.json()),
  });
  const verboseEnabled = verboseData?.enabled ?? false;
  const toggleVerbose = useMutation({
    mutationFn: (enabled: boolean) =>
      fetch("/api/logs/verbose", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }).then(r => r.json()),
    onSuccess: (data: { enabled: boolean }) => {
      // Optimistic update via queryClient isn't needed — React Query will refetch
    },
  });

  const [loadedEntries, setLoadedEntries] = useState<LogEntry[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [loadedOffset, setLoadedOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [realtimeLogs, setRealtimeLogs] = useState<LogEntry[]>([]);

  const { data: logFilesData } = useQuery<LogFilesResponse>({
    queryKey: ["/api/logs/files"],
    queryFn: fetchLogFiles,
  });

  const currentFile = logFilesData?.current;

  const { data: initialResult } = useQuery<PaginatedLogResult>({
    queryKey: ["/api/logs", currentFile, "initial", levelFilter],
    queryFn: () => fetchPaginatedLogs(currentFile!, undefined, PAGE_SIZE, levelFilter),
    enabled: !!currentFile,
  });

  useEffect(() => {
    if (initialResult) {
      setLoadedEntries(initialResult.entries);
      setTotalEntries(initialResult.total);
      setLoadedOffset(initialResult.offset);
    }
  }, [initialResult]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const logsWs = new WebSocket(`${protocol}//${window.location.host}/ws`);
    logsWs.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "log" && data.log) {
          const entry: LogEntry = {
            ts: data.log.timestamp || new Date().toISOString(),
            level: data.log.level || "info",
            source: data.log.source || "server",
            message: data.log.message || "",
            line: Date.now(),
          };
          setRealtimeLogs(prev => [...prev.slice(-2000), entry]);
        }
      } catch {}
    };
    return () => { logsWs.close(); };
  }, []);

  const allLogs = useMemo(() => {
    const fileEntries = loadedEntries;
    const seen = new Set(fileEntries.map(e => `${e.ts}-${e.source}-${e.message}`));
    const newRealtime = realtimeLogs.filter(e => !seen.has(`${e.ts}-${e.source}-${e.message}`));
    return [...fileEntries, ...newRealtime];
  }, [loadedEntries, realtimeLogs]);

  const [pausedLogs, setPausedLogs] = useState<LogEntry[]>([]);
  useEffect(() => {
    if (!paused) setPausedLogs(allLogs);
  }, [allLogs, paused]);

  const displayLogs = paused ? pausedLogs : allLogs;

  const filteredLogs = useMemo(() => {
    const filtered = displayLogs.filter((entry) => {
      if (levelFilter !== "all" && LOG_LEVEL_RANK[entry.level] < LOG_LEVEL_RANK[levelFilter]) return false;
      if (sourceFilter !== "all") {
        if (sourceFilter === "client" && !entry.source.startsWith("client:")) return false;
        if (sourceFilter === "server" && entry.source.startsWith("client:")) return false;
      }
      if (filter) {
        const searchStr = `${entry.message} ${entry.source}`.toLowerCase();
        if (!searchStr.includes(filter.toLowerCase())) return false;
      }
      return true;
    });
    return [...filtered].reverse();
  }, [displayLogs, levelFilter, sourceFilter, filter]);

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of displayLogs) {
      counts[e.level] = (counts[e.level] || 0) + 1;
    }
    return counts;
  }, [displayLogs]);

  const hasMoreHistory = loadedOffset > 0;

  const loadMoreHistory = useCallback(async () => {
    if (!currentFile || loadingMore || !hasMoreHistory) return;
    setLoadingMore(true);
    try {
      const newOffset = Math.max(0, loadedOffset - PAGE_SIZE);
      const fetchLimit = loadedOffset - newOffset;
      const result = await fetchPaginatedLogs(currentFile, newOffset, fetchLimit, levelFilter);
      setLoadedEntries(prev => [...result.entries, ...prev]);
      setLoadedOffset(newOffset);
      setTotalEntries(result.total);
    } catch (err) {
      log.error("Failed to load more log history", err);
    } finally {
      setLoadingMore(false);
    }
  }, [currentFile, loadingMore, hasMoreHistory, loadedOffset, levelFilter]);

  const handleCopy = useCallback(() => {
    const text = filteredLogs.map(e =>
      `${e.ts} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`
    ).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied", description: `${filteredLogs.length} log entries copied` });
    });
  }, [filteredLogs, toast]);

  const handleDownload = useCallback(() => {
    const text = filteredLogs.map(e =>
      `${e.ts} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`
    ).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile || "logs.log";
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs, currentFile]);

  const handleErrorsSeen = useCallback((ids: number[]) => {
    setSeenErrors(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
    markLogErrorsSeen();
  }, [markLogErrorsSeen]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (atBottom && hasMoreHistory && !loadingMore) {
      loadMoreHistory();
    }
  }, [hasMoreHistory, loadingMore, loadMoreHistory]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  const errorCount = filteredLogs.filter(e => e.level === "error").length;
  const warnCount = filteredLogs.filter(e => e.level === "warn").length;

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex flex-col gap-1.5 px-3 sm:px-4 py-2 border-b shrink-0">
        {/* Row 1: Search + filter selects */}
        <div className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 text-xs flex-1 min-w-0"
            data-testid="input-filter-logs"
          />
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="w-[80px] sm:w-[100px] h-7 text-xs shrink-0" data-testid="select-log-level">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="error">Error {levelCounts.error ? `(${levelCounts.error})` : ""}</SelectItem>
              <SelectItem value="warn">Warning {levelCounts.warn ? `(${levelCounts.warn})` : ""}</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="verbose">Verbose</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[80px] sm:w-[120px] h-7 text-xs shrink-0" data-testid="select-log-source">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              <SelectItem value="server">Server</SelectItem>
              <SelectItem value="client">Client</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* Row 2: Badges, count, and action buttons */}
        <div className="flex items-center gap-1.5">
          {errorCount > 0 && (
            <Badge variant="destructive" className="text-xs gap-1" data-testid="badge-level-error">
              <AlertCircle className="h-2.5 w-2.5" />
              {errorCount}
            </Badge>
          )}
          {warnCount > 0 && (
            <Badge variant="secondary" className="text-xs gap-1 text-warning" data-testid="badge-level-warn">
              {warnCount}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground/50 tabular-nums">
            {filteredLogs.length}{totalEntries > displayLogs.length ? ` / ${totalEntries}` : ""}
          </span>
          <div className="flex items-center gap-1.5 ml-auto">
            <div className="hidden sm:flex items-center gap-1.5">
              <Switch
                id="verbose-toggle"
                checked={verboseEnabled}
                onCheckedChange={(checked) => toggleVerbose.mutate(checked)}
                className="scale-75"
                data-testid="switch-verbose-logging"
              />
              <Label htmlFor="verbose-toggle" className="text-xs text-muted-foreground cursor-pointer">
                Verbose
              </Label>
            </div>
            <Button
              size="icon"
              variant={wrap ? "secondary" : "ghost"}
              onClick={() => setWrap(!wrap)}
              className="h-7 w-7"
              title={wrap ? "Disable text wrap" : "Enable text wrap"}
              data-testid="button-wrap-logs"
            >
              <WrapText className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant={paused ? "secondary" : "ghost"}
              onClick={() => setPaused(!paused)}
              className="h-7 w-7"
              title={paused ? "Resume live updates" : "Pause live updates"}
              data-testid="button-pause-logs"
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCopy}
              className="h-7 w-7"
              title="Copy logs"
              data-testid="button-copy-logs"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={handleDownload}
              className="h-7 w-7"
              title="Download logs"
              data-testid="button-download-logs"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto scrollbar-thin"
        data-testid="logs-scroll-container"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ScrollText className="h-6 w-6 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              {filter || levelFilter !== "all" || sourceFilter !== "all"
                ? "No logs match your filters"
                : "No log entries yet"}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Application logs stream here in real-time
            </p>
          </div>
        ) : (
          <div className={wrap ? "" : "min-w-max"}>
            <VirtualizedLogList
              entries={filteredLogs}
              timezone={timezone}
              wrap={wrap}
              parentRef={scrollRef}
              seenErrors={seenErrors}
              onErrorsSeen={handleErrorsSeen}
            />
            {hasMoreHistory && (
              <div className="flex justify-center py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1.5"
                  onClick={loadMoreHistory}
                  disabled={loadingMore}
                  data-testid="button-load-more-logs"
                >
                  {loadingMore ? (
                    <><Loader2 className="h-3 w-3 animate-spin" /> Loading...</>
                  ) : (
                    <>Load older entries ({loadedOffset} remaining)</>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
