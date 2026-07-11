import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  ChevronRight, ChevronDown, Loader2, Library, RefreshCw,
} from "lucide-react";
import { PageEmoji } from "./library-components";

interface IndexNode {
  id: string;
  title: string;
  slug: string;
  emoji: string | null;
  oneLiner: string | null;
  summary: string | null;
  tags: string[];
  hasChildren: boolean;
  childCount: number;
}

function IndexTreeNode({ node, depth = 0 }: { node: IndexNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth === 0 && node.hasChildren);
  const [showSummary, setShowSummary] = useState(false);

  const childrenQuery = useQuery<IndexNode[]>({
    queryKey: ["/api/library/index", node.id],
    queryFn: async () => {
      const res = await fetch(`/api/library/index?parentId=${node.id}`);
      if (!res.ok) throw new Error("Failed to fetch children");
      const data = await res.json();
      return data.nodes;
    },
    enabled: expanded && node.hasChildren,
  });

  const toggleExpand = useCallback(() => {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    if (node.summary && !showSummary) {
      setShowSummary(true);
      return;
    }
    setShowSummary(false);
    setExpanded(false);
  }, [expanded, showSummary, node.summary]);

  const handleNavigate = useCallback(() => {
    window.location.hash = `library?page=${node.slug}`;
  }, [node.slug]);

  const hasSummaryContent = node.summary;

  return (
    <div data-testid={`index-node-${node.id}`}>
      <div
        className={cn(
          "flex items-start gap-1 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer group",
          depth > 0 && "ml-4"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <button
          onClick={toggleExpand}
          className="mt-0.5 flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground"
          data-testid={`index-toggle-${node.id}`}
        >
          {(node.hasChildren || hasSummaryContent) ? (
            expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
          ) : (
            <span className="w-3" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <PageEmoji emoji={node.emoji} />
            <span
              className="text-sm font-medium truncate cursor-pointer hover:underline"
              onClick={handleNavigate}
              data-testid={`index-title-${node.id}`}
            >
              {node.title}
            </span>
            {node.hasChildren && (
              <Badge variant="secondary" className="text-xs font-mono px-1 py-0 h-4" data-testid={`index-badge-${node.id}`}>
                {node.childCount}
              </Badge>
            )}
          </div>

          {node.oneLiner && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed" data-testid={`index-oneliner-${node.id}`}>
              {node.oneLiner}
            </p>
          )}

          {showSummary && node.summary && (
            <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed border-l-2 border-muted pl-2" data-testid={`index-summary-${node.id}`}>
              {node.summary}
            </p>
          )}
        </div>
      </div>

      {expanded && node.hasChildren && (
        <div>
          {childrenQuery.isLoading && (
            <div className="flex items-center gap-1 py-1" style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}>
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading...</span>
            </div>
          )}
          {childrenQuery.data?.map(child => (
            <IndexTreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

interface BackfillStatus {
  running: boolean;
  total: number;
  enriched: number;
  errors: number;
  detail: string;
  startedAt: number | null;
  finishedAt: number | null;
}

function useBackfillStatus() {
  const { data, isLoading } = useQuery<BackfillStatus>({
    queryKey: ["/api/library/backfill/status"],
    refetchInterval: (query) => {
      const d = query.state.data as BackfillStatus | undefined;
      return d?.running ? 1000 : 10000;
    },
  });
  return { status: data, isLoading };
}

function BackfillProgressBar({ status }: { status: BackfillStatus | undefined }) {
  const prevRunningRef = useRef(false);
  const [showDone, setShowDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState("");
  const [fading, setFading] = useState(false);

  const lastSeenFinishedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!status) return;

    const justFinished = prevRunningRef.current && !status.running && status.finishedAt;
    const recentFinish = !status.running && status.finishedAt && status.finishedAt !== lastSeenFinishedRef.current && (Date.now() - status.finishedAt < 10000);

    prevRunningRef.current = status.running;

    if (justFinished || recentFinish) {
      queryClient.invalidateQueries({ queryKey: ["/api/library/index"] });
      lastSeenFinishedRef.current = status.finishedAt;

      const hasErrors = status.errors > 0;
      const msg = hasErrors
        ? `Enriched ${status.enriched} of ${status.total} pages (${status.errors} failed)`
        : `Enriched ${status.enriched} of ${status.total} pages`;
      setDoneMessage(msg);
      setShowDone(true);
      setFading(false);

      const fadeTimer = setTimeout(() => setFading(true), 4000);
      const hideTimer = setTimeout(() => {
        setShowDone(false);
        setFading(false);
      }, 5000);
      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [status?.running, status?.finishedAt]);

  if (showDone) {
    const hasErrors = doneMessage.includes("failed");
    return (
      <div
        className={cn(
          "w-full space-y-1.5 px-3 py-2 border-b transition-opacity duration-1000",
          hasErrors ? "bg-error/5 border-error/10" : "bg-success/5 border-success/10",
          fading && "opacity-0"
        )}
        data-testid="backfill-done"
      >
        <div className="flex items-center justify-between text-xs">
          <span className={cn("font-medium flex items-center gap-1.5", hasErrors ? "text-error-foreground" : "text-success-foreground")}>
            {hasErrors ? (
              <RefreshCw className="h-3 w-3" />
            ) : (
              <Library className="h-3 w-3" />
            )}
            {hasErrors ? "Index generation completed with errors" : "Index generation complete"}
          </span>
          <span className="text-muted-foreground tabular-nums">{doneMessage}</span>
        </div>
        <div className="relative h-2 w-full bg-muted rounded-full">
          <div className={cn("h-full rounded-full", hasErrors ? "bg-error" : "bg-success")} style={{ width: "100%" }} />
        </div>
      </div>
    );
  }

  if (!status?.running) return null;

  const pct = status.total > 0 ? Math.min((status.enriched / status.total) * 100, 100) : 0;

  return (
    <div className="w-full space-y-1.5 px-3 py-2 bg-warning/5 border-b border-warning/10" data-testid="backfill-progress">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3 text-warning animate-spin" />
          Enriching library pages
        </span>
        <span className="text-muted-foreground tabular-nums">
          {status.enriched} of {status.total} pages
          {status.errors > 0 && (
            <span className="text-error ml-1">({status.errors} errors)</span>
          )}
        </span>
      </div>
      <div className="relative h-2 w-full bg-muted rounded-full" data-testid="backfill-progress-track">
        <div
          className="h-full rounded-full transition-all duration-700 bg-warning"
          style={{ width: `${Math.max(0.5, pct)}%` }}
          data-testid="backfill-progress-bar"
        />
      </div>
      {status.detail && (
        <p className="text-xs text-muted-foreground/70 truncate" data-testid="backfill-progress-detail">
          {status.detail}
        </p>
      )}
    </div>
  );
}

export function IndexTab() {
  const [filter, setFilter] = useState("");
  const { status: backfillStatus } = useBackfillStatus();
  const rootQuery = useQuery<{ nodes: IndexNode[]; totalCount: number }>({
    queryKey: ["/api/library/index", null],
    queryFn: async () => {
      const res = await fetch("/api/library/index?parentId=null");
      if (!res.ok) throw new Error("Failed to fetch index");
      return res.json();
    },
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/library/backfill");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/library/backfill/status"] });
    },
  });

  const isBackfillRunning = backfillStatus?.running ?? false;

  if (rootQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="index-loading">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const nodes = rootQuery.data?.nodes || [];
  const totalCount = rootQuery.data?.totalCount || 0;
  const hasEnrichment = nodes.some(n => n.oneLiner);
  const unenrichedCount = nodes.filter(n => !n.oneLiner).length;
  const lowerFilter = filter.toLowerCase();
  const filteredNodes = lowerFilter
    ? nodes.filter(n =>
        n.title.toLowerCase().includes(lowerFilter) ||
        (n.oneLiner && n.oneLiner.toLowerCase().includes(lowerFilter)) ||
        n.tags.some(t => t.toLowerCase().includes(lowerFilter))
      )
    : nodes;

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="index-tab">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="flex items-center gap-2">
          <Library className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Library Index</span>
          <Badge variant="secondary" className="text-xs font-mono px-1 py-0" data-testid="index-total-count">
            {totalCount} pages
          </Badge>
        </div>
        {unenrichedCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending || isBackfillRunning}
            data-testid="index-backfill-button"
          >
            {(backfillMutation.isPending || isBackfillRunning) ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            {hasEnrichment ? `Enrich ${unenrichedCount} remaining` : "Generate Index"}
          </Button>
        )}
      </div>

      <BackfillProgressBar status={backfillStatus} />

      <div className="px-4 py-2 border-b">
        <input
          type="text"
          placeholder="Filter by title, tag, or keyword..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full text-sm px-2 py-1 rounded border bg-background placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="index-filter-input"
        />
      </div>

      <ScrollArea className="flex-1">
        <div className="py-2">
          {filteredNodes.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="index-empty">
              {filter ? "No matching pages." : "No library pages yet."}
            </div>
          ) : (
            filteredNodes.map(node => (
              <IndexTreeNode key={node.id} node={node} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
