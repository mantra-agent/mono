import { memo, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Copy,
  Download,
  Pause,
  Play,
  AlertCircle,
  ChevronRight,
  Loader2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTimezone } from "@/hooks/use-timezone";
import { useLogErrors } from "@/hooks/use-log-errors";
import { createLogger, setVerboseEnabled } from "@/lib/logger";
import { usePageHeader } from "@/hooks/use-page-header";

const log = createLogger("logs-page");

const PAGE_SIZE = 500;
const LOG_ROW_HEIGHT = 29;

/** Severity ranking for threshold-based filtering: selecting a level shows that level and above. */
const LOG_LEVEL_RANK: Record<string, number> = { verbose: -1, debug: 0, log: 1, info: 1, warn: 2, error: 3 };

interface LogEntry {
  id?: string;
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
  info: "text-foreground",
  log: "text-foreground",
  debug: "text-muted-foreground",
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

function getLogEntryKey(entry: LogEntry): string {
  return entry.id ?? `file:${entry.line}:${entry.ts}:${entry.source}`;
}

const LogRow = memo(function LogRow({
  entry,
  isSeen,
  onSelect,
}: {
  entry: LogEntry;
  isSeen?: boolean;
  onSelect: (entry: LogEntry) => void;
}) {
  const levelColor = LEVEL_COLORS[entry.level] || "text-muted-foreground";
  const rowBg = entry.level === "error" && isSeen ? "" : (LEVEL_BG[entry.level] || "");

  return (
    <button
      type="button"
      className={`flex w-full shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/30 px-2 text-left font-mono text-xs hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${rowBg}`}
      style={{ height: `${LOG_ROW_HEIGHT}px`, minHeight: `${LOG_ROW_HEIGHT}px` }}
      aria-label={`${entry.level} log: ${entry.message}`}
      onClick={() => onSelect(entry)}
      data-testid={`log-entry-${entry.line}`}
      data-log-level={entry.level}
      data-log-key={getLogEntryKey(entry)}
    >
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className={`min-w-0 flex-1 truncate ${levelColor}`}>
        {entry.message}
      </span>
    </button>
  );
});

function LogList({ entries, timezone, wrap, parentRef, seenErrors, onErrorsSeen }: {
  entries: LogEntry[];
  timezone: string;
  wrap: boolean;
  parentRef: React.RefObject<HTMLDivElement | null>;
  seenErrors: Set<string>;
  onErrorsSeen: (ids: string[]) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const reportedRef = useRef(new Set<string>());
  const [selectedEntry, setSelectedEntry] = useState<LogEntry | null>(null);
  const selectEntry = useCallback((entry: LogEntry) => setSelectedEntry(entry), []);

  useEffect(() => {
    const list = listRef.current;
    const root = parentRef.current;
    if (!list || !root) return;

    const observer = new IntersectionObserver((observations) => {
      const newlySeen: string[] = [];
      for (const observation of observations) {
        if (!observation.isIntersecting) continue;
        const key = (observation.target as HTMLElement).dataset.logKey;
        if (!key || reportedRef.current.has(key)) continue;
        reportedRef.current.add(key);
        newlySeen.push(key);
        observer.unobserve(observation.target);
      }
      if (newlySeen.length > 0) onErrorsSeen(newlySeen);
    }, { root, threshold: 0.5 });

    const errorRows = list.querySelectorAll<HTMLElement>('[data-log-level="error"]');
    for (const row of errorRows) {
      const key = row.dataset.logKey;
      if (key && !reportedRef.current.has(key)) observer.observe(row);
    }

    return () => observer.disconnect();
  }, [entries, parentRef, onErrorsSeen]);

  return (
    <>
      <div ref={listRef} className="w-full">
        {entries.map((entry) => {
          const entryKey = getLogEntryKey(entry);
          return (
            <LogRow
              key={entryKey}
              entry={entry}
              isSeen={seenErrors.has(entryKey)}
              onSelect={selectEntry}
            />
          );
        })}
      </div>
      <Dialog open={selectedEntry !== null} onOpenChange={(open) => { if (!open) setSelectedEntry(null); }}>
        <DialogContent className="max-h-[80dvh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-base">Log entry</DialogTitle>
          </DialogHeader>
          {selectedEntry && (
            <div className="min-h-0 space-y-3 overflow-auto font-mono text-xs">
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span className="tabular-nums">{formatLogTime(selectedEntry.ts, timezone)}</span>
                <Badge variant="outline" className={`px-1 py-0 text-xs ${selectedEntry.source.startsWith("client:") ? "border-active/30 text-active" : "border-neutral/30 text-neutral"}`}>
                  {selectedEntry.source}
                </Badge>
                <Badge variant="outline" className={`px-1 py-0 text-xs ${LEVEL_COLORS[selectedEntry.level] || "text-muted-foreground"}`}>
                  {selectedEntry.level}
                </Badge>
              </div>
              <div className={`${LEVEL_COLORS[selectedEntry.level] || "text-muted-foreground"} ${wrap ? "break-words" : "overflow-x-auto whitespace-nowrap"}`}>
                {selectedEntry.message}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function LogsPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Logs", skip: !!embedded });
  const { timezone } = useTimezone();
  const { markSeen: markLogErrorsSeen } = useLogErrors();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("info");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [seenErrors, setSeenErrors] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const realtimeConnectionId = useRef(`realtime:${Date.now().toString(36)}`);
  const realtimeSequence = useRef(0);

  // ── Verbose toggle ──────────────────────────────────────────────────
  const { data: verboseData } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/logs/verbose"],
    queryFn: () => fetch("/api/logs/verbose").then(r => r.json()),
  });
  const verboseEnabled = verboseData?.enabled ?? false;
  useEffect(() => {
    setVerboseEnabled(verboseEnabled);
  }, [verboseEnabled]);
  const toggleVerbose = useMutation({
    mutationFn: (enabled: boolean) =>
      fetch("/api/logs/verbose", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }).then(r => r.json()),
    onSuccess: (data: { enabled: boolean }) => {
      queryClient.setQueryData(["/api/logs/verbose"], data);
    },
  });

  const [loadedEntries, setLoadedEntries] = useState<LogEntry[]>([]);
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
      setLoadedOffset(initialResult.offset);
    }
  }, [initialResult]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const logsWs = new WebSocket(`${protocol}//${window.location.host}/ws`);
    let frameId: number | null = null;
    let pendingEntries: LogEntry[] = [];

    const flushPendingEntries = () => {
      frameId = null;
      if (pendingEntries.length === 0) return;
      const batch = pendingEntries;
      pendingEntries = [];
      setRealtimeLogs((previous) => [...previous, ...batch].slice(-2000));
    };

    logsWs.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "log" && data.log) {
          pendingEntries.push({
            id: `${realtimeConnectionId.current}:${++realtimeSequence.current}`,
            ts: data.log.timestamp || new Date().toISOString(),
            level: data.log.level || "info",
            source: data.log.source || "server",
            message: data.log.message || "",
            line: Date.now(),
          });
          if (frameId === null) frameId = window.requestAnimationFrame(flushPendingEntries);
        }
      } catch {}
    };
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      logsWs.close();
    };
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

  const handleErrorsSeen = useCallback((ids: string[]) => {
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
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="input-filter-logs"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Clear log search"
                data-testid="button-clear-log-search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" data-testid="button-log-mixer">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Mixer
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="menu-log-level">Log Level</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={levelFilter} onValueChange={setLevelFilter}>
                    <DropdownMenuRadioItem value="all">All Levels</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="error">Error {levelCounts.error ? `(${levelCounts.error})` : ""}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="warn">Warning {levelCounts.warn ? `(${levelCounts.warn})` : ""}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="info">Info</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="debug">Debug</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="verbose">Verbose</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="menu-log-sources">Sources</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={sourceFilter} onValueChange={setSourceFilter}>
                    <DropdownMenuRadioItem value="all">All Sources</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="server">Server</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="client">Client</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="menu-log-verbose">Diagnostic detail</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={verboseEnabled ? "enabled" : "disabled"}
                    onValueChange={(value) => toggleVerbose.mutate(value === "enabled")}
                  >
                    <DropdownMenuRadioItem value="enabled">Enabled</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="disabled">Disabled</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="menu-log-wrap">Wrap</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={wrap ? "enabled" : "disabled"} onValueChange={(value) => setWrap(value === "enabled")}>
                    <DropdownMenuRadioItem value="enabled">Enabled</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="disabled">Disabled</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
          <div className="flex items-center gap-1.5 ml-auto">
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
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {filter || levelFilter !== "all" || sourceFilter !== "all"
              ? "No matching logs."
              : "No log entries yet."}
          </div>
        ) : (
          <div className={wrap ? "" : "min-w-max"}>
            <LogList
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
