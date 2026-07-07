import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import ForceGraph2D from "react-force-graph-2d";
import {
  Loader2, Search, Network, RefreshCcw, AlertTriangle,
  GitBranch, Activity, X, Eye, EyeOff,
  LayoutDashboard, ArrowRight, BookOpen, Focus,
  Check, Clock, Database, Cpu,
} from "lucide-react";

interface GraphNode {
  id: string;
  label: string;
  properties: {
    name?: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    heuristicLabel?: string;
    cohesion?: number;
    symbolCount?: number;
    processType?: string;
    stepCount?: number;
    communities?: string;
    entryPointId?: string;
    terminalId?: string;
  };
}

interface GraphEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence?: number;
}

const TYPE_COLORS: Record<string, string> = {
  Function: "#3b82f6",
  Class: "#a855f7",
  Method: "#6366f1",
  Interface: "#06b6d4",
  File: "#64748b",
  Folder: "#78716c",
  Community: "#f97316",
  Process: "#22c55e",
  CodeElement: "#ec4899",
};

const ALL_NODE_TYPES = ["File", "Folder", "Function", "Class", "Method", "Interface", "CodeElement", "Community", "Process"];

interface FGNode {
  id: string;
  name: string;
  nodeType: string;
  color: string;
  val: number;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  symbolCount?: number;
  cohesion?: number;
  heuristicLabel?: string;
  x?: number;
  y?: number;
}

interface FGLink {
  source: string;
  target: string;
  edgeType: string;
}

function beaconError(endpoint: string, message: string, status: string) {
  try {
    const payload = JSON.stringify({ endpoint, message, status, ts: Date.now() });
    navigator.sendBeacon("/api/client-error", new Blob([payload], { type: "application/json" }));
  } catch {
    // sendBeacon unavailable — best effort only
  }
}

function filterByVisibleTypes(nodes: GraphNode[], visibleTypes: Set<string>): GraphNode[] {
  return nodes.filter((n) => visibleTypes.has(n.label));
}

function expandFocusNeighborhood(
  filtered: GraphNode[],
  edges: GraphEdge[],
  focusNodeId: string,
  focusDepth: number,
): GraphNode[] {
  const filteredIds = new Set(filtered.map((n) => n.id));
  if (!filteredIds.has(focusNodeId) || focusDepth <= 0) return filtered;

  const neighbors = new Set<string>([focusNodeId]);
  let frontier = new Set<string>([focusNodeId]);

  for (let d = 0; d < focusDepth; d++) {
    const nextFrontier = new Set<string>();
    for (const e of edges) {
      if (frontier.has(e.sourceId) && filteredIds.has(e.targetId) && !neighbors.has(e.targetId)) {
        neighbors.add(e.targetId);
        nextFrontier.add(e.targetId);
      }
      if (frontier.has(e.targetId) && filteredIds.has(e.sourceId) && !neighbors.has(e.sourceId)) {
        neighbors.add(e.sourceId);
        nextFrontier.add(e.sourceId);
      }
    }
    frontier = nextFrontier;
  }

  return filtered.filter((n) => neighbors.has(n.id));
}

function rankAndTrimNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxNodes = 300,
): { trimmed: GraphNode[]; connectionCounts: Map<string, number> } {
  const ids = new Set(nodes.map((n) => n.id));
  const connectionCounts = new Map<string, number>();

  for (const e of edges) {
    if (ids.has(e.sourceId) && ids.has(e.targetId)) {
      connectionCounts.set(e.sourceId, (connectionCounts.get(e.sourceId) || 0) + 1);
      connectionCounts.set(e.targetId, (connectionCounts.get(e.targetId) || 0) + 1);
    }
  }

  if (nodes.length <= maxNodes) return { trimmed: nodes, connectionCounts };

  const ranked = nodes.map((n) => ({ node: n, score: connectionCounts.get(n.id) || 0 }));
  ranked.sort((a, b) => b.score - a.score);
  return { trimmed: ranked.slice(0, maxNodes).map((r) => r.node), connectionCounts };
}

function buildLinks(displayNodes: GraphNode[], edges: GraphEdge[]): FGLink[] {
  const displayIds = new Set(displayNodes.map((n) => n.id));
  const links: FGLink[] = [];
  for (const e of edges) {
    if (displayIds.has(e.sourceId) && displayIds.has(e.targetId) && e.sourceId !== e.targetId) {
      links.push({ source: e.sourceId, target: e.targetId, edgeType: e.type });
    }
  }
  return links;
}

function buildForceGraphData(
  nodes: GraphNode[],
  edges: GraphEdge[],
  visibleTypes: Set<string>,
  focusNodeId: string | null,
  focusDepth: number
): { nodes: FGNode[]; links: FGLink[] } {
  const typeFiltered = filterByVisibleTypes(nodes, visibleTypes);
  const focused = focusNodeId
    ? expandFocusNeighborhood(typeFiltered, edges, focusNodeId, focusDepth)
    : typeFiltered;
  const { trimmed, connectionCounts } = rankAndTrimNodes(focused, edges);
  const links = buildLinks(trimmed, edges);

  const fgNodes: FGNode[] = trimmed.map((n) => {
    const conns = connectionCounts.get(n.id) || 0;
    const sc = n.properties.symbolCount || 1;
    let val: number;
    if (n.label === "Community") {
      val = Math.max(4, Math.min(30, Math.sqrt(sc) * 1.5));
    } else {
      val = Math.max(2, Math.min(15, Math.sqrt(conns + 1) * 1.5));
    }
    return {
      id: n.id,
      name: n.properties.heuristicLabel || n.properties.name || n.id,
      nodeType: n.label,
      color: TYPE_COLORS[n.label] || "#94a3b8",
      val,
      filePath: n.properties.filePath,
      startLine: n.properties.startLine,
      endLine: n.properties.endLine,
      symbolCount: n.properties.symbolCount,
      cohesion: n.properties.cohesion,
      heuristicLabel: n.properties.heuristicLabel,
    };
  });

  return { nodes: fgNodes, links };
}

function NodeTypeLegend({
  visibleTypes,
  onToggle,
  nodeCounts,
}: {
  visibleTypes: Set<string>;
  onToggle: (type: string) => void;
  nodeCounts: Map<string, number>;
}) {
  return (
    <div className="space-y-1" data-testid="node-type-legend">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Node Types</div>
      {ALL_NODE_TYPES.map((type) => {
        const count = nodeCounts.get(type) || 0;
        if (count === 0) return null;
        const isVisible = visibleTypes.has(type);
        return (
          <button
            key={type}
            onClick={() => onToggle(type)}
            className={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs transition-colors ${
              isVisible ? "hover:bg-muted/50" : "opacity-40 hover:opacity-60"
            }`}
            data-testid={`toggle-type-${type.toLowerCase()}`}
          >
            <div
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: isVisible ? TYPE_COLORS[type] || "#94a3b8" : "#64748b" }}
            />
            <span className="flex-1 text-left">{type}</span>
            <span className="text-muted-foreground">{count.toLocaleString()}</span>
            {isVisible ? <Eye className="h-3 w-3 text-muted-foreground" /> : <EyeOff className="h-3 w-3 text-muted-foreground" />}
          </button>
        );
      })}
    </div>
  );
}

function CodeInspector({
  node,
  onClose,
}: {
  node: FGNode;
  onClose: () => void;
}) {
  const [source, setSource] = useState<{ content: string; startLine: number; totalLines: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setSource(null);
    setFetchError(null);
    if (!node.filePath) return;
    const start = Math.max(1, (node.startLine || 1) - 3);
    const end = (node.endLine || start + 30) + 3;
    setLoading(true);
    fetch(`/api/gitnexus/source?file=${encodeURIComponent(node.filePath)}&start=${start}&end=${end}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { setSource(data); })
      .catch((err: Error) => {
        setFetchError(err.message || "Source fetch failed");
        beaconError("/api/gitnexus/source", err.message, "source-inspector");
      })
      .finally(() => setLoading(false));
  }, [node.filePath, node.startLine, node.endLine, retryCount]);

  return (
    <Card className="border-l-2" style={{ borderLeftColor: TYPE_COLORS[node.nodeType] || "#94a3b8" }} data-testid="code-inspector">
      <CardHeader className="pb-2 pt-3 px-4 flex flex-row items-start justify-between">
        <div className="min-w-0">
          <CardTitle className="text-sm font-medium truncate">{node.name}</CardTitle>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span
              className="px-1.5 py-0.5 rounded-sm text-white"
              style={{ backgroundColor: TYPE_COLORS[node.nodeType] || "#94a3b8" }}
            >
              {node.nodeType}
            </span>
            {node.filePath && <span className="truncate">{node.filePath}</span>}
            {node.startLine && <span>L{node.startLine}{node.endLine ? `-${node.endLine}` : ""}</span>}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose} data-testid="button-close-inspector">
          <X className="h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        {node.symbolCount != null && (
          <div className="text-xs text-muted-foreground mb-2">
            {node.symbolCount} symbols
            {node.cohesion != null && <span className="ml-2">Cohesion: {(node.cohesion * 100).toFixed(0)}%</span>}
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading source...
          </div>
        ) : fetchError ? (
          <div className="flex flex-col gap-2 py-2" data-testid="inspector-fetch-error">
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Source unavailable: {fetchError}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs self-start"
              onClick={() => setRetryCount((c) => c + 1)}
              data-testid="button-retry-source"
            >
              <RefreshCcw className="h-3 w-3 mr-1" />
              Retry
            </Button>
          </div>
        ) : source ? (
          <div className="relative">
            <div className="absolute top-1 right-1 text-xs text-muted-foreground bg-background/80 px-1.5 py-0.5 rounded">
              {source.totalLines} lines total
            </div>
            <pre className="text-xs font-mono overflow-x-auto overflow-y-auto max-h-[300px] bg-muted/30 rounded-lg p-3 text-foreground leading-relaxed" data-testid="source-preview">
              {source.content.split("\n").map((line: string, i: number) => {
                const lineNum = source.startLine + i;
                const isTarget = node.startLine && node.endLine && lineNum >= node.startLine && lineNum <= node.endLine;
                return (
                  <div
                    key={i}
                    className={`flex ${isTarget ? "bg-info/10" : ""}`}
                  >
                    <span className="select-none text-muted-foreground w-8 text-right pr-2 shrink-0 border-r border-border/50 mr-2">{lineNum}</span>
                    <span className="whitespace-pre">{line}</span>
                  </div>
                );
              })}
            </pre>
          </div>
        ) : node.filePath ? (
          <div className="text-xs text-muted-foreground py-2">Source preview unavailable</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InteractiveGraph({
  graphData,
  onNodeSelect,
}: {
  graphData: { nodes: GraphNode[]; relationships: GraphEdge[] };
  onNodeSelect: (node: FGNode | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(() => new Set(["File", "Function", "Class", "Method", "Interface", "Community"]));
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 700, height: 500 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: Math.max(400, entry.contentRect.width),
          height: Math.max(300, Math.min(600, entry.contentRect.height || 500)),
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const nodeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graphData.nodes) {
      counts.set(n.label, (counts.get(n.label) || 0) + 1);
    }
    return counts;
  }, [graphData.nodes]);

  const toggleType = useCallback((type: string) => {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const fgData = useMemo(() => {
    return buildForceGraphData(graphData.nodes, graphData.relationships, visibleTypes, focusNodeId, focusDepth);
  }, [graphData, visibleTypes, focusNodeId, focusDepth]);

  const handleNodeClick = useCallback((node: any) => {
    setSelectedNodeId(node.id);
    onNodeSelect(node as FGNode);
  }, [onNodeSelect]);

  const handleFocusNode = useCallback(() => {
    if (selectedNodeId) {
      if (focusNodeId === selectedNodeId) {
        setFocusNodeId(null);
        setFocusDepth(0);
      } else {
        setFocusNodeId(selectedNodeId);
        setFocusDepth(2);
      }
    }
  }, [selectedNodeId, focusNodeId]);

  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const r = node.val || 4;
    const isSelected = node.id === selectedNodeId;
    const isFocus = node.id === focusNodeId;

    if (isFocus) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);

    if (node.nodeType === "Community") {
      ctx.fillStyle = node.color + "40";
      ctx.fill();
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = isSelected ? node.color : node.color + "cc";
      ctx.fill();
    }

    if (isSelected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const fontSize = Math.max(3, Math.min(5, 12 / globalScale));
    if (globalScale > 0.6 || r > 8 || isSelected || isFocus) {
      ctx.font = `${isSelected ? "bold " : ""}${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = isSelected ? "#ffffff" : "#cbd5e1";
      ctx.fillText(node.name, node.x, node.y + r + 2);
    }
  }, [selectedNodeId, focusNodeId]);

  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const start = link.source;
    const end = link.target;
    if (!start || !end || typeof start.x !== "number") return;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);

    const isHighlighted = selectedNodeId && (start.id === selectedNodeId || end.id === selectedNodeId);
    ctx.strokeStyle = isHighlighted ? "rgba(148, 163, 184, 0.5)" : "rgba(148, 163, 184, 0.12)";
    ctx.lineWidth = isHighlighted ? 1.5 : 0.5;
    ctx.stroke();
  }, [selectedNodeId]);

  return (
    <div className="flex gap-3" data-testid="interactive-graph">
      <div className="w-40 shrink-0 space-y-4">
        <NodeTypeLegend visibleTypes={visibleTypes} onToggle={toggleType} nodeCounts={nodeCounts} />

        {selectedNodeId && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Focus</div>
            <Button
              variant={focusNodeId === selectedNodeId ? "default" : "outline"}
              size="sm"
              className="w-full text-xs"
              onClick={handleFocusNode}
              data-testid="button-toggle-focus"
            >
              <Focus className="h-3 w-3 mr-1" />
              {focusNodeId === selectedNodeId ? "Clear Focus" : "Focus Node"}
            </Button>
            {focusNodeId && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Depth</div>
                <div className="flex gap-1">
                  {[1, 2, 3].map((d) => (
                    <Button
                      key={d}
                      variant={focusDepth === d ? "default" : "outline"}
                      size="sm"
                      className="flex-1 h-7 text-xs"
                      onClick={() => setFocusDepth(d)}
                      data-testid={`button-depth-${d}`}
                    >
                      {d}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="pt-2 border-t border-border">
          <div className="text-xs text-muted-foreground">
            {fgData.nodes.length.toLocaleString()} nodes
          </div>
          <div className="text-xs text-muted-foreground">
            {fgData.links.length.toLocaleString()} edges
          </div>
        </div>
      </div>

      <div ref={containerRef} className="flex-1 rounded-lg border border-border bg-[#0f1117] overflow-hidden" style={{ minHeight: 500 }}>
        <ForceGraph2D
          ref={fgRef}
          graphData={fgData}
          width={dimensions.width}
          height={dimensions.height}
          nodeCanvasObject={nodeCanvasObject}
          linkCanvasObject={linkCanvasObject}
          onNodeClick={handleNodeClick}
          nodeId="id"
          cooldownTicks={100}
          cooldownTime={3000}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.3}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          backgroundColor="#0f1117"
          nodeLabel={(node: any) => `${node.name} (${node.nodeType})`}
        />
      </div>
    </div>
  );
}

export function CodeGraphTab() {
  const [status, setStatus] = useState<"checking" | "ready" | "indexing" | "error" | "disabled">("checking");
  const [indexingEnabled, setIndexingEnabledState] = useState<boolean | null>(null);
  const [sourceInfo, setSourceInfo] = useState<any>(null);
  const [repoInfo, setRepoInfo] = useState<any>(null);
  const [subPhase, setSubPhase] = useState<string>("");
  const [progressMessage, setProgressMessage] = useState<string>("");
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [stageElapsedSeconds, setStageElapsedSeconds] = useState<number>(0);
  const [analyzePercent, setAnalyzePercent] = useState<number | undefined>(undefined);
  const [analyzePhaseLabel, setAnalyzePhaseLabel] = useState<string | undefined>(undefined);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<string | null>(null);
  const [lastIndexedAt, setLastIndexedAt] = useState<string | null>(null);
  const [lastErrorPhase, setLastErrorPhase] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [archData, setArchData] = useState<any>(null);
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; relationships: GraphEdge[] } | null>(null);
  const [clusters, setClusters] = useState<any[]>([]);
  const [processes, setProcesses] = useState<any[]>([]);
  const [clusterDetail, setClusterDetail] = useState<{ name: string; data: any } | null>(null);
  const [processDetail, setProcessDetail] = useState<{ name: string; data: any } | null>(null);
  const [loadingArch, setLoadingArch] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [loadingClusters, setLoadingClusters] = useState(false);
  const [loadingProcesses, setLoadingProcesses] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ processes: any[]; process_symbols: any[]; definitions: any[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeView, setActiveView] = useState<"overview" | "graph" | "processes" | "clusters">("overview");
  const [inspectedNode, setInspectedNode] = useState<FGNode | null>(null);

  const [archError, setArchError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const [processesError, setProcessesError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [pendingDetailName, setPendingDetailName] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const currentStatus = status;

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/gitnexus-status");
      const data = await res.json();
      if (data.lastIndexedAt != null) setLastIndexedAt(data.lastIndexedAt);
      setSourceInfo(data.source || null);
      if (data.ready) {
        setStatus("ready");
        setRepoInfo(data.repos);
        setErrorDetail(null);
        setLastErrorPhase(null);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } else if (data.phase === "disabled") {
        setStatus("disabled");
        setIndexingEnabledState(false);
        setProgressMessage(data.message || "Code indexing is disabled for Platform environments.");
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } else if (data.phase === "error") {
        setStatus("error");
        if (data.errorDetail) setErrorDetail(data.errorDetail);
        setErrorRaw(data.errorRaw ?? null);
        if (data.lastErrorPhase) setLastErrorPhase(data.lastErrorPhase);
      } else {
        setStatus("indexing");
        if (data.subPhase) setSubPhase(data.subPhase);
        if (data.progressMessage) setProgressMessage(data.progressMessage);
        if (data.elapsedSeconds != null) setElapsedSeconds(data.elapsedSeconds);
        if (data.stageElapsedSeconds != null) setStageElapsedSeconds(data.stageElapsedSeconds);
        setAnalyzePercent(data.analyzePercent ?? undefined);
        setAnalyzePhaseLabel(data.analyzePhaseLabel ?? undefined);
      }
    } catch (err: unknown) {
      setStatus("error");
      setErrorDetail("Could not reach server");
    }
  }, []);

  const handleRetry = useCallback(async () => {
    setStatus("indexing");
    setErrorDetail(null);
    setSubPhase("");
    setProgressMessage("Starting...");
    try {
      await fetch("/api/gitnexus/restart", { method: "POST" });
    } catch {}
    setTimeout(checkStatus, 500);
  }, [checkStatus]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    if (indexingEnabled === false) return;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    checkStatus();
    pollRef.current = setInterval(checkStatus, 2000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [checkStatus, indexingEnabled]);

  const loadArchitecture = useCallback(async () => {
    setLoadingArch(true);
    setArchError(null);
    try {
      const res = await fetch("/api/gitnexus/architecture");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setArchData(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Architecture fetch failed";
      setArchError(msg);
      beaconError("/api/gitnexus/architecture", msg, currentStatus);
    } finally {
      setLoadingArch(false);
    }
  }, [currentStatus]);

  const loadGraph = useCallback(async () => {
    setLoadingGraph(true);
    setGraphError(null);
    try {
      const res = await fetch("/api/gitnexus/graph");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGraphData(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Graph fetch failed";
      setGraphError(msg);
      beaconError("/api/gitnexus/graph", msg, currentStatus);
    } finally {
      setLoadingGraph(false);
    }
  }, [currentStatus]);

  const loadClusters = useCallback(async () => {
    setLoadingClusters(true);
    setClustersError(null);
    try {
      const res = await fetch("/api/gitnexus/clusters");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setClusters(data.clusters || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Clusters fetch failed";
      setClustersError(msg);
      beaconError("/api/gitnexus/clusters", msg, currentStatus);
    } finally {
      setLoadingClusters(false);
    }
  }, [currentStatus]);

  const loadProcesses = useCallback(async () => {
    setLoadingProcesses(true);
    setProcessesError(null);
    try {
      const res = await fetch("/api/gitnexus/processes");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setProcesses(data.processes || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Processes fetch failed";
      setProcessesError(msg);
      beaconError("/api/gitnexus/processes", msg, currentStatus);
    } finally {
      setLoadingProcesses(false);
    }
  }, [currentStatus]);

  const loadClusterDetail = useCallback(async (name: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    setPendingDetailName(name);
    setClusterDetail(null);
    try {
      const res = await fetch(`/api/gitnexus/clusters/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setClusterDetail({ name, data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Cluster detail fetch failed";
      setDetailError(msg);
      beaconError(`/api/gitnexus/clusters/${name}`, msg, currentStatus);
    } finally {
      setLoadingDetail(false);
    }
  }, [currentStatus]);

  const loadProcessDetail = useCallback(async (name: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    setPendingDetailName(name);
    setProcessDetail(null);
    try {
      const res = await fetch(`/api/gitnexus/processes/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setProcessDetail({ name, data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Process detail fetch failed";
      setDetailError(msg);
      beaconError(`/api/gitnexus/processes/${name}`, msg, currentStatus);
    } finally {
      setLoadingDetail(false);
    }
  }, [currentStatus]);

  useEffect(() => {
    if (status === "ready" && !archData) {
      loadArchitecture();
    }
    if (status === "ready" && activeView === "graph" && !graphData) {
      loadGraph();
    }
  }, [status, archData, graphData, activeView, loadArchitecture, loadGraph]);

  useEffect(() => {
    if (status === "ready" && activeView === "clusters" && clusters.length === 0 && !loadingClusters) {
      loadClusters();
    }
    if (status === "ready" && activeView === "processes" && processes.length === 0 && !loadingProcesses) {
      loadProcesses();
    }
  }, [status, activeView, clusters.length, processes.length, loadingClusters, loadingProcesses, loadClusters, loadProcesses]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/gitnexus/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSearchResults({
        processes: data.processes || [],
        process_symbols: data.process_symbols || [],
        definitions: data.definitions || [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Search failed";
      setSearchError(msg);
      beaconError("/api/gitnexus/search", msg, currentStatus);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, currentStatus]);

  const stats = archData?.context?.stats || archData?.summary?.stats;

  if (status === "checking") {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground" data-testid="code-graph-checking">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="text-sm">Checking GitNexus status...</span>
      </div>
    );
  }

  if (status === "indexing") {
    const stages = [
      { key: "syncing", label: "Sync Repository", icon: GitBranch, slowThreshold: 30 },
      { key: "analyzing", label: "Analyze Codebase", icon: Search, slowThreshold: 60 },
      { key: "initializing", label: "Start Engine", icon: Cpu, slowThreshold: 30 },
    ];

    const stageOrder = ["syncing", "analyzing", "initializing"];
    const currentStageIndex = stageOrder.indexOf(subPhase);

    const formatElapsed = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };

    const formatEta = (stageElapsed: number, pct: number): string => {
      if (pct <= 0 || stageElapsed <= 0) return "Calculating…";
      const fraction = pct / 100;
      const remaining = Math.round((stageElapsed / fraction) * (1 - fraction));
      if (remaining < 60) return "< 1 min remaining";
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      return `~${m}m ${s}s remaining`;
    };

    return (
      <div className="flex flex-col items-center justify-center py-16 gap-6 max-w-md mx-auto" data-testid="code-graph-indexing">
        <div className="text-center">
          <Network className="h-8 w-8 text-primary animate-pulse mx-auto mb-3" />
          <p className="font-medium text-lg" data-testid="text-indexing-title">Building Code Graph</p>
          <p className="text-sm text-muted-foreground mt-1">This typically takes 2–4 minutes on first run</p>
        </div>

        <div className="w-full space-y-3" data-testid="indexing-stages">
          {stages.map((stage, i) => {
            const Icon = stage.icon;
            const isCurrent = stage.key === subPhase;
            const isComplete = currentStageIndex > i;
            const isPending = currentStageIndex < i;
            const isSlow = isCurrent && stageElapsedSeconds > stage.slowThreshold;

            return (
              <div
                key={stage.key}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors ${
                  isCurrent
                    ? isSlow
                      ? "border-warning/50 bg-warning/5"
                      : "border-primary/50 bg-primary/5"
                    : isComplete
                    ? "border-success/30 bg-success/5"
                    : "border-border/50 bg-muted/30 opacity-50"
                }`}
                data-testid={`stage-${stage.key}`}
              >
                <div className="flex-shrink-0">
                  {isComplete ? (
                    <Check className="h-5 w-5 text-success" />
                  ) : isCurrent ? (
                    <Loader2 className={`h-5 w-5 animate-spin ${isSlow ? "text-warning" : "text-primary"}`} />
                  ) : (
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className={`text-sm font-medium ${isPending ? "text-muted-foreground" : ""}`}>
                      {stage.label}
                    </p>
                    {isCurrent && stageElapsedSeconds > 0 && (
                      <span className={`text-xs ${isSlow ? "text-warning" : "text-muted-foreground"}`} data-testid={`stage-time-${stage.key}`}>
                        {formatElapsed(stageElapsedSeconds)}
                      </span>
                    )}
                  </div>

                  {/* Progress bar — shown for the analyzing stage */}
                  {isCurrent && stage.key === "analyzing" && (
                    <div className="mt-2 space-y-1" data-testid="analyze-progress-container">
                      {analyzePercent !== undefined && analyzePercent > 0 ? (
                        <Progress
                          value={analyzePercent}
                          className="h-1.5"
                          data-testid="progress-bar-analyze"
                        />
                      ) : (
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full w-1/3 rounded-full bg-primary/50 animate-pulse" data-testid="progress-bar-indeterminate" />
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground truncate" data-testid="text-progress-message">
                          {analyzePercent !== undefined && analyzePercent > 0
                            ? (analyzePhaseLabel || "Calculating…")
                            : "Calculating…"}
                        </p>
                        {analyzePercent !== undefined && analyzePercent > 0 && (
                          <span className="text-xs text-muted-foreground ml-2 shrink-0" data-testid="text-analyze-pct">
                            {analyzePercent}%
                          </span>
                        )}
                      </div>
                      {stageElapsedSeconds > 5 && (
                        <p
                          className={`text-xs ${isSlow ? "text-warning" : "text-muted-foreground"}`}
                          data-testid="text-eta"
                        >
                          {analyzePercent !== undefined && analyzePercent > 5
                            ? formatEta(stageElapsedSeconds, analyzePercent)
                            : "Calculating…"}
                        </p>
                      )}
                    </div>
                  )}

                  {/* For non-analyzing stages: simple message line */}
                  {isCurrent && stage.key !== "analyzing" && progressMessage && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5" data-testid="text-progress-message">
                      {progressMessage}
                    </p>
                  )}

                  {isCurrent && isSlow && stage.key !== "analyzing" && (
                    <p className="text-xs text-warning mt-0.5" data-testid="text-slow-warning">
                      Taking longer than expected
                    </p>
                  )}
                  {isComplete && (
                    <p className="text-xs text-success-foreground mt-0.5">Complete</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground" data-testid="indexing-footer">
          <span className="flex items-center gap-1" data-testid="text-elapsed-time">
            <Clock className="h-3.5 w-3.5" />
            Total: {formatElapsed(elapsedSeconds)}
          </span>
          <Button variant="ghost" size="sm" onClick={checkStatus} className="h-7 text-xs" data-testid="button-refresh-status">
            <RefreshCcw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  if (status === "disabled") {
    return (
      <div className="flex flex-col gap-4" data-testid="code-graph-tab">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">Code Intelligence Graph</span>
          </div>
          <Badge variant="outline" data-testid="text-indexing-state">Indexing off</Badge>
        </div>
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground" data-testid="code-graph-disabled">
          <EyeOff className="h-8 w-8" />
          <div className="text-center max-w-md">
            <p className="font-medium text-foreground">GitNexus indexing is off</p>
            <p className="text-sm mt-1">
              No Platform environment source binding has code indexing enabled. The <code className="font-mono text-xs">code</code> tool will skip GitNexus and use normal repo/file inspection instead. Enable indexing on the canonical environment Source Binding when needed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground" data-testid="code-graph-error">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <div className="text-center max-w-md">
          <p className="font-medium text-foreground">GitNexus unavailable</p>
          {errorDetail ? (
            <p className="text-sm text-destructive mt-1 font-mono break-words" data-testid="text-error-detail">{errorDetail}</p>
          ) : (
            <p className="text-sm">The code intelligence server could not be reached.</p>
          )}
          {errorRaw && (
            <p className="text-xs text-muted-foreground mt-1 font-mono break-words" data-testid="text-error-raw">{errorRaw}</p>
          )}
          {lastErrorPhase && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-error-phase">
              Failed during: {lastErrorPhase}
            </p>
          )}
          {lastIndexedAt && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-last-indexed">
              Last indexed: {new Date(lastIndexedAt).toLocaleString()}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={handleRetry} data-testid="button-retry-status">
          <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="code-graph-tab">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-primary" />
          <div>
            <span className="font-medium">Code Intelligence Graph</span>
            {repoInfo && (
              <span className="text-xs text-muted-foreground ml-2">
                {Array.isArray(repoInfo) ? `${repoInfo.length} repo(s) indexed` : "Indexed"}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sourceInfo && (
            <Badge variant="outline" className="mr-2 max-w-[18rem] truncate" data-testid="text-indexing-source">
              {sourceInfo.platformName} / {sourceInfo.productName} / {sourceInfo.environmentName} · {sourceInfo.owner}/{sourceInfo.repo}@{sourceInfo.branch}
            </Badge>
          )}
          <Button
            variant={activeView === "overview" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("overview")}
            data-testid="button-view-overview"
          >
            <LayoutDashboard className="h-3.5 w-3.5 mr-1.5" />
            Overview
          </Button>
          <Button
            variant={activeView === "graph" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("graph")}
            data-testid="button-view-graph"
          >
            <Network className="h-3.5 w-3.5 mr-1.5" />
            Graph
          </Button>
          <Button
            variant={activeView === "clusters" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("clusters")}
            data-testid="button-view-clusters"
          >
            <Activity className="h-3.5 w-3.5 mr-1.5" />
            Modules
          </Button>
          <Button
            variant={activeView === "processes" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveView("processes")}
            data-testid="button-view-processes"
          >
            <GitBranch className="h-3.5 w-3.5 mr-1.5" />
            Flows
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          className="flex-1 h-8 rounded-md border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Search codebase (e.g. 'tool execution', 'memory storage')..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          data-testid="input-graph-search"
        />
        <Button size="sm" onClick={handleSearch} disabled={searching} data-testid="button-graph-search">
          {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {searchError && (
        <div className="flex items-center gap-2 text-sm text-destructive" data-testid="search-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Search failed: {searchError}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" onClick={handleSearch} data-testid="button-retry-search">
            Retry
          </Button>
        </div>
      )}

      {searchResults && (
        <Card data-testid="card-search-results">
          <CardHeader className="pb-2 pt-3 px-4 flex flex-row items-start justify-between">
            <CardTitle className="text-sm font-medium">Search Results</CardTitle>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSearchResults(null)} data-testid="button-clear-search">
              <X className="h-3.5 w-3.5" />
            </Button>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-3 max-h-80 overflow-y-auto">
            {searchResults.processes.length === 0 && searchResults.process_symbols.length === 0 && searchResults.definitions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No results found.</p>
            ) : null}
            {searchResults.processes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Processes</p>
                <div className="space-y-1.5">
                  {searchResults.processes.map((proc: any, i: number) => (
                    <div key={proc.id || i} className="rounded-md border border-border bg-muted/30 px-2.5 py-2" data-testid={`search-result-process-${i}`}>
                      <p className="text-xs font-medium text-foreground">{proc.summary || proc.label || proc.id}</p>
                      {proc.process_type && <p className="text-xs text-muted-foreground mt-0.5">{proc.process_type}{proc.step_count != null ? ` · ${proc.step_count} steps` : ""}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {searchResults.process_symbols.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Symbols</p>
                <div className="space-y-1">
                  {searchResults.process_symbols.map((sym: any, i: number) => (
                    <div key={sym.id || i} className="flex items-start gap-2" data-testid={`search-result-symbol-${i}`}>
                      <span className="text-xs font-mono bg-muted text-muted-foreground rounded px-1 py-0.5 shrink-0 mt-0.5">{sym.type || "?"}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{sym.name}</p>
                        {sym.filePath && <p className="text-xs text-muted-foreground truncate">{sym.filePath}{sym.startLine != null ? (sym.endLine != null && sym.endLine !== sym.startLine ? ` line ${sym.startLine}–${sym.endLine}` : ` line ${sym.startLine}`) : ""}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {searchResults.definitions.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Files &amp; Definitions</p>
                <div className="space-y-1">
                  {searchResults.definitions.map((def: any, i: number) => (
                    <div key={def.id || def.filePath || i} className="flex items-start gap-2" data-testid={`search-result-def-${i}`}>
                      <span className="text-xs font-mono bg-muted text-muted-foreground rounded px-1 py-0.5 shrink-0 mt-0.5">{def.type || "File"}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{def.name || def.filePath}</p>
                        {def.filePath && def.name && <p className="text-xs text-muted-foreground truncate">{def.filePath}{def.startLine != null ? (def.endLine != null && def.endLine !== def.startLine ? ` line ${def.startLine}–${def.endLine}` : ` line ${def.startLine}`) : ""}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeView === "overview" && (
        <div data-testid="overview-view">
          {loadingArch ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading architecture overview...</span>
            </div>
          ) : archError ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground" data-testid="arch-error">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm text-center">Architecture overview failed: {archError}</p>
              <Button variant="outline" size="sm" onClick={loadArchitecture} data-testid="button-retry-arch">
                <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          ) : archData ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 @sm:grid-cols-4 gap-3">
                <Card className="p-3" data-testid="overview-stat-symbols">
                  <div className="text-2xl font-bold">{(stats?.functionCount || 0).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Symbols</div>
                </Card>
                <Card className="p-3" data-testid="overview-stat-files">
                  <div className="text-2xl font-bold">{(stats?.fileCount || 0).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Files</div>
                </Card>
                <Card className="p-3" data-testid="overview-stat-modules">
                  <div className="text-2xl font-bold">{(archData.clusters?.length || stats?.communityCount || 0).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Modules</div>
                </Card>
                <Card className="p-3" data-testid="overview-stat-flows">
                  <div className="text-2xl font-bold">{(stats?.processCount || 0).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Flows</div>
                </Card>
              </div>

              <Card data-testid="overview-modules-table">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    Modules by Size
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  {archData.clusters?.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" data-testid="modules-table">
                        <thead>
                          <tr className="border-b border-border text-left text-muted-foreground">
                            <th className="pb-2 pr-3 font-medium">Module</th>
                            <th className="pb-2 pr-3 font-medium text-right">Symbols</th>
                            <th className="pb-2 pr-3 font-medium">Cohesion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...archData.clusters]
                            .sort((a: any, b: any) => (b.symbolCount || 0) - (a.symbolCount || 0))
                            .map((c: any, i: number) => {
                              const cohesion = c.cohesion ?? 0;
                              const pct = Math.round(cohesion * 100);
                              const barColor = pct >= 90 ? "bg-success" : pct >= 70 ? "bg-info" : pct >= 50 ? "bg-warning" : "bg-error";
                              return (
                                <tr
                                  key={i}
                                  className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                                  onClick={() => { setActiveView("clusters"); loadClusterDetail(c.label || c.heuristicLabel || c.name || c.id); }}
                                  data-testid={`overview-module-row-${i}`}
                                >
                                  <td className="py-1.5 pr-3 font-medium">{c.label || c.heuristicLabel || c.name || c.id}</td>
                                  <td className="py-1.5 pr-3 text-right text-muted-foreground">{(c.symbolCount || 0).toLocaleString()}</td>
                                  <td className="py-1.5 pr-3">
                                    <div className="flex items-center gap-2">
                                      <div className="flex-1 h-1.5 bg-muted rounded-full max-w-[80px]">
                                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                                      </div>
                                      <span className="text-muted-foreground w-8 text-right">{pct}%</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No modules detected</p>
                  )}
                </CardContent>
              </Card>

              <Card data-testid="overview-flows-table">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <GitBranch className="h-4 w-4" />
                    Key Execution Flows
                    <span className="text-xs font-normal text-muted-foreground ml-1">(top cross-module flows by depth)</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  {archData.processes?.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" data-testid="flows-table">
                        <thead>
                          <tr className="border-b border-border text-left text-muted-foreground">
                            <th className="pb-2 pr-3 font-medium">Flow</th>
                            <th className="pb-2 pr-3 font-medium text-right">Steps</th>
                            <th className="pb-2 pr-3 font-medium">Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...archData.processes]
                            .sort((a: any, b: any) => (b.stepCount || 0) - (a.stepCount || 0))
                            .slice(0, 20)
                            .map((p: any, i: number) => {
                              const label = p.label || p.heuristicLabel || p.name || p.id;
                              return (
                                <tr
                                  key={i}
                                  className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                                  onClick={() => { setActiveView("processes"); loadProcessDetail(label); }}
                                  data-testid={`overview-flow-row-${i}`}
                                >
                                  <td className="py-1.5 pr-3">
                                    <div className="flex items-center gap-1.5">
                                      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                      <span className="font-medium">{label}</span>
                                    </div>
                                  </td>
                                  <td className="py-1.5 pr-3 text-right text-muted-foreground">{p.stepCount || 0}</td>
                                  <td className="py-1.5 pr-3">
                                    {p.crossCommunity || p.processType === "cross_community" ? (
                                      <span className="text-info">Cross-module</span>
                                    ) : (
                                      <span className="text-muted-foreground">Internal</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No execution flows detected</p>
                  )}
                </CardContent>
              </Card>

              {archData?.context?.projectName && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <BookOpen className="h-3.5 w-3.5" />
                  Project: {archData.context.projectName}
                  {repoInfo?.[0]?.indexedAt && (
                    <span className="ml-2">Last indexed: {new Date(repoInfo[0].indexedAt).toLocaleString()}</span>
                  )}
                  <div className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => { setArchData(null); loadArchitecture(); }}
                    data-testid="button-refresh-overview"
                  >
                    <RefreshCcw className="h-3 w-3 mr-1" />
                    Refresh
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex justify-center py-8">
              <Button variant="outline" onClick={loadArchitecture} data-testid="button-load-overview">
                <LayoutDashboard className="h-4 w-4 mr-2" />
                Load architecture overview
              </Button>
            </div>
          )}
        </div>
      )}

      {activeView === "graph" && (
        <div>
          {loadingGraph ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground" data-testid="graph-loading">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading graph data...</span>
            </div>
          ) : graphError ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground" data-testid="graph-error">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm text-center">Graph failed to load: {graphError}</p>
              <Button variant="outline" size="sm" onClick={loadGraph} data-testid="button-retry-graph">
                <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          ) : graphData ? (
            <div className="space-y-3" data-testid="graph-view">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  {graphData.nodes.length.toLocaleString()} total nodes, {graphData.relationships.length.toLocaleString()} edges
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setGraphData(null); loadGraph(); }}
                  data-testid="button-reload-graph"
                >
                  <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                  Refresh
                </Button>
              </div>

              <InteractiveGraph graphData={graphData} onNodeSelect={setInspectedNode} />

              {inspectedNode && (
                <CodeInspector node={inspectedNode} onClose={() => setInspectedNode(null)} />
              )}
            </div>
          ) : (
            <div className="flex justify-center py-8" data-testid="graph-empty">
              <Button variant="outline" onClick={loadGraph} data-testid="button-load-graph">
                <Network className="h-4 w-4 mr-2" />
                Load graph data
              </Button>
            </div>
          )}
        </div>
      )}

      {activeView === "clusters" && (
        <div data-testid="clusters-view">
          {(clusterDetail || (pendingDetailName && (loadingDetail || detailError))) ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setClusterDetail(null); setPendingDetailName(null); setDetailError(null); }} data-testid="button-back-clusters">
                  &larr; All Modules
                </Button>
                <span className="font-medium text-sm">{clusterDetail?.name || pendingDetailName}</span>
              </div>
              {loadingDetail ? (
                <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Loading module details...</span>
                </div>
              ) : detailError ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3 text-muted-foreground" data-testid="cluster-detail-error">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  <p className="text-sm">Failed to load module: {detailError}</p>
                  <Button variant="outline" size="sm" onClick={() => loadClusterDetail(clusterDetail?.name || pendingDetailName!)} data-testid="button-retry-cluster-detail">
                    <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                    Retry
                  </Button>
                </div>
              ) : clusterDetail ? (
                <pre className="text-xs whitespace-pre-wrap font-mono max-h-[500px] overflow-y-auto bg-muted/30 rounded-lg p-4 text-foreground" data-testid="cluster-detail-content">
                  {typeof clusterDetail.data === "string" ? clusterDetail.data : JSON.stringify(clusterDetail.data, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : loadingClusters ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading modules...</span>
            </div>
          ) : clustersError ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground" data-testid="clusters-error">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm">Failed to load modules: {clustersError}</p>
              <Button variant="outline" size="sm" onClick={loadClusters} data-testid="button-retry-clusters">
                <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          ) : clusters.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">No modules found</div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{clusters.length} functional modules detected via Leiden community analysis</p>
              <div className="grid gap-2 max-h-[500px] overflow-y-auto">
                {clusters.map((c: any, i: number) => (
                  <Card
                    key={i}
                    className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => loadClusterDetail(c.label || c.heuristicLabel || c.name || c.id)}
                    data-testid={`card-cluster-${i}`}
                  >
                    <div className="font-medium text-sm">{c.label || c.heuristicLabel || c.name || c.id}</div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      {c.symbolCount != null && <span>{c.symbolCount} symbols</span>}
                      {c.cohesion != null && <span>Cohesion: {Math.round(c.cohesion * 100)}%</span>}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeView === "processes" && (
        <div data-testid="processes-view">
          {(processDetail || (pendingDetailName && (loadingDetail || detailError))) ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setProcessDetail(null); setPendingDetailName(null); setDetailError(null); }} data-testid="button-back-processes">
                  &larr; All Flows
                </Button>
                <span className="font-medium text-sm">{processDetail?.name || pendingDetailName}</span>
              </div>
              {loadingDetail ? (
                <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-sm">Loading flow details...</span>
                </div>
              ) : detailError ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3 text-muted-foreground" data-testid="process-detail-error">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  <p className="text-sm">Failed to load flow: {detailError}</p>
                  <Button variant="outline" size="sm" onClick={() => loadProcessDetail(processDetail?.name || pendingDetailName!)} data-testid="button-retry-process-detail">
                    <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                    Retry
                  </Button>
                </div>
              ) : processDetail ? (
                <pre className="text-xs whitespace-pre-wrap font-mono max-h-[500px] overflow-y-auto bg-muted/30 rounded-lg p-4 text-foreground" data-testid="process-detail-content">
                  {typeof processDetail.data === "string" ? processDetail.data : JSON.stringify(processDetail.data, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : loadingProcesses ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading execution flows...</span>
            </div>
          ) : processesError ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground" data-testid="processes-error">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm">Failed to load flows: {processesError}</p>
              <Button variant="outline" size="sm" onClick={loadProcesses} data-testid="button-retry-processes">
                <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          ) : processes.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">No execution flows found</div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{processes.length} execution flows traced through the codebase</p>
              <div className="grid gap-2 max-h-[500px] overflow-y-auto">
                {processes.map((p: any, i: number) => (
                  <Card
                    key={i}
                    className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => loadProcessDetail(p.label || p.heuristicLabel || p.name || p.id)}
                    data-testid={`card-process-${i}`}
                  >
                    <div className="font-medium text-sm">{p.label || p.heuristicLabel || p.name || p.id}</div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      {p.stepCount != null && <span>{p.stepCount} steps</span>}
                      {p.processType && <span>Type: {p.processType}</span>}
                      {p.crossCommunity && <span className="text-info">Cross-module</span>}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
