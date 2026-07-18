import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import ForceGraph2D from "react-force-graph-2d";
import {
  Loader2, Search, Network, RefreshCcw, AlertTriangle,
  GitBranch, X, Eye, EyeOff,
  Code2, Boxes, FileCode2, FolderGit2, Focus,
  Check, Clock, Database, Cpu, Waypoints,
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

export function CodeGraphTab({ hideSearch }: { hideSearch?: boolean } = {}) {
  const [status, setStatus] = useState<"checking" | "ready" | "indexing" | "error" | "disabled">("checking");
  const [indexingEnabled, setIndexingEnabledState] = useState<boolean | null>(null);
  const [sourceInfo, setSourceInfo] = useState<any>(null);
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
  const [loadingArch, setLoadingArch] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ processes: any[]; process_symbols: any[]; definitions: any[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeView, setActiveView] = useState<"tree" | "graph">("tree");
  const [inspectedNode, setInspectedNode] = useState<FGNode | null>(null);

  const [archError, setArchError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
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

  useEffect(() => {
    if (status === "ready" && !archData) {
      loadArchitecture();
    }
    if (status === "ready" && activeView === "graph" && !graphData) {
      loadGraph();
    }
  }, [status, archData, graphData, activeView, loadArchitecture, loadGraph]);


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

  const moduleRows = [...(archData?.clusters || [])].sort(
    (left: any, right: any) => (right.symbolCount || 0) - (left.symbolCount || 0),
  );
  const flowRows = [...(archData?.processes || [])].sort(
    (left: any, right: any) => (right.stepCount || 0) - (left.stepCount || 0),
  );
  const projectName = archData?.context?.projectName
    || sourceInfo?.repo
    || "Codebase";
  const sourceLabel = sourceInfo
    ? `${sourceInfo.owner}/${sourceInfo.repo}@${sourceInfo.branch}`
    : "Indexed source";

  return (
    <div className="w-full space-y-4 p-4" data-testid="code-graph-tab">
      {!hideSearch && (
        <div className="flex flex-col gap-2 @sm:flex-row">
          <div className="flex min-w-0 flex-1 gap-2">
            <input
              type="text"
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Search codebase"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && handleSearch()}
              data-testid="input-graph-search"
            />
            <Button
              size="sm"
              className="h-9 shrink-0"
              onClick={handleSearch}
              disabled={searching}
              aria-label="Search codebase"
              data-testid="button-graph-search"
            >
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            onClick={() => setActiveView(activeView === "graph" ? "tree" : "graph")}
            data-testid={activeView === "graph" ? "button-view-tree" : "button-view-graph"}
          >
            {activeView === "graph" ? <Code2 className="mr-1.5 h-3.5 w-3.5" /> : <Network className="mr-1.5 h-3.5 w-3.5" />}
            {activeView === "graph" ? "View tree" : "View graph"}
          </Button>
        </div>
      )}
      {hideSearch && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            onClick={() => setActiveView(activeView === "graph" ? "tree" : "graph")}
            data-testid={activeView === "graph" ? "button-view-tree" : "button-view-graph"}
          >
            {activeView === "graph" ? <Code2 className="mr-1.5 h-3.5 w-3.5" /> : <Network className="mr-1.5 h-3.5 w-3.5" />}
            {activeView === "graph" ? "View tree" : "View graph"}
          </Button>
        </div>
      )}

      {!hideSearch && searchError && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-error" data-testid="search-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Search failed: {searchError}</span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleSearch} data-testid="button-retry-search">
            Retry
          </Button>
        </div>
      )}

      {!hideSearch && searchResults && (
        <div className="rounded-lg border border-border/40 bg-muted/30 p-1" data-testid="tree-search-results">
          <ProfileTreeRow
            label="Search results"
            icon={<Search className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            defaultOpen
            expandedContentClassName="pl-8 pr-2"
            expandedContent={(
              <div className="rounded-md border border-border/30 bg-background/40 p-1">
                {searchResults.processes.map((process: any, index: number) => (
                  <ProfileTreeRow
                    key={process.id || `process-${index}`}
                    label={process.summary || process.label || process.id}
                    icon={<Waypoints className="h-3.5 w-3.5" />}
                    hasValue
                    showEmpty
                    mobileLayout="inline"
                    testId={`search-result-process-${index}`}
                  >
                    <span className="truncate text-muted-foreground">
                      {process.step_count != null ? `${process.step_count} steps` : process.process_type || "Flow"}
                    </span>
                  </ProfileTreeRow>
                ))}
                {searchResults.process_symbols.map((symbol: any, index: number) => (
                  <ProfileTreeRow
                    key={symbol.id || `symbol-${index}`}
                    label={symbol.name}
                    icon={<Code2 className="h-3.5 w-3.5" />}
                    hasValue
                    showEmpty
                    mobileLayout="inline"
                    testId={`search-result-symbol-${index}`}
                  >
                    <span className="truncate font-mono text-muted-foreground">
                      {symbol.filePath || symbol.type || "Symbol"}
                    </span>
                  </ProfileTreeRow>
                ))}
                {searchResults.definitions.map((definition: any, index: number) => (
                  <ProfileTreeRow
                    key={definition.id || definition.filePath || `definition-${index}`}
                    label={definition.name || definition.filePath}
                    icon={<FileCode2 className="h-3.5 w-3.5" />}
                    hasValue
                    showEmpty
                    mobileLayout="inline"
                    testId={`search-result-def-${index}`}
                  >
                    <span className="truncate font-mono text-muted-foreground">
                      {definition.filePath || definition.type || "Definition"}
                    </span>
                  </ProfileTreeRow>
                ))}
                {searchResults.processes.length === 0
                  && searchResults.process_symbols.length === 0
                  && searchResults.definitions.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No results found.</div>
                  )}
              </div>
            )}
          >
            <span className="flex items-center justify-end gap-1 text-muted-foreground">
              <span>{searchResults.processes.length + searchResults.process_symbols.length + searchResults.definitions.length}</span>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
                onClick={() => setSearchResults(null)}
                aria-label="Clear search results"
                data-testid="button-clear-search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </ProfileTreeRow>
        </div>
      )}

      {activeView === "tree" ? (
        loadingArch ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : archError ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-error" data-testid="arch-error">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Code tree failed to load: {archError}</span>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={loadArchitecture} data-testid="button-retry-arch">
              Retry
            </Button>
          </div>
        ) : archData ? (
          <div className="rounded-lg border border-border/40 bg-muted/30 p-1" data-testid="code-tree-view">
            <ProfileTreeRow
              label={projectName}
              icon={<Code2 className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              defaultOpen
              expandedContentClassName="pl-8 pr-2"
              expandedContent={(
                <div className="rounded-md border border-border/30 bg-background/40 p-1">
                  <ProfileTreeRow
                    label="Source"
                    icon={<FolderGit2 className="h-3.5 w-3.5" />}
                    hasValue
                    showEmpty
                    mobileLayout="inline"
                    expandedContent={sourceInfo ? (
                      <div className="space-y-1 font-mono text-muted-foreground">
                        <div>{sourceInfo.platformName} / {sourceInfo.productName} / {sourceInfo.environmentName}</div>
                        <div className="break-all">{sourceLabel}</div>
                      </div>
                    ) : undefined}
                    testId="tree-row-code-source"
                  >
                    <span className="truncate font-mono text-muted-foreground">{sourceLabel}</span>
                  </ProfileTreeRow>

                  <ProfileTreeRow
                    label="Files"
                    icon={<FileCode2 className="h-3.5 w-3.5" />}
                    hasValue
                    showEmpty
                    mobileLayout="inline"
                    testId="tree-row-code-files"
                  >
                    <span className="tabular-nums text-muted-foreground">{(stats?.fileCount || 0).toLocaleString()}</span>
                  </ProfileTreeRow>

                  <ProfileTreeRow
                    label="Symbols"
                    icon={<Code2 className="h-3.5 w-3.5" />}
                    hasValue
                    showEmpty
                    mobileLayout="inline"
                    testId="tree-row-code-symbols"
                  >
                    <span className="tabular-nums text-muted-foreground">{(stats?.functionCount || 0).toLocaleString()}</span>
                  </ProfileTreeRow>

                  <ProfileTreeRow
                    label="Modules"
                    icon={<Boxes className="h-3.5 w-3.5" />}
                    hasValue={moduleRows.length > 0}
                    showEmpty
                    mobileLayout="inline"
                    expandedContentClassName="pl-8 pr-0"
                    expandedContent={moduleRows.length > 0 ? (
                      <div className="rounded-md border border-border/30 bg-background/40 p-1">
                        {moduleRows.map((module: any, index: number) => {
                          const label = module.label || module.heuristicLabel || module.name || module.id;
                          const cohesion = module.cohesion == null ? null : Math.round(module.cohesion * 100);
                          return (
                            <ProfileTreeRow
                              key={module.id || `${label}-${index}`}
                              label={label}
                              icon={<Boxes className="h-3.5 w-3.5" />}
                              hasValue
                              showEmpty
                              mobileLayout="inline"
                              expandedContent={(
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                                  <span>{(module.symbolCount || 0).toLocaleString()} symbols</span>
                                  {cohesion != null && <span>{cohesion}% cohesion</span>}
                                </div>
                              )}
                              testId={`tree-row-code-module-${index}`}
                            >
                              <span className="tabular-nums text-muted-foreground">{(module.symbolCount || 0).toLocaleString()}</span>
                            </ProfileTreeRow>
                          );
                        })}
                      </div>
                    ) : undefined}
                    testId="tree-row-code-modules"
                  >
                    <span className="tabular-nums text-muted-foreground">{moduleRows.length}</span>
                  </ProfileTreeRow>

                  <ProfileTreeRow
                    label="Flows"
                    icon={<Waypoints className="h-3.5 w-3.5" />}
                    hasValue={flowRows.length > 0}
                    showEmpty
                    mobileLayout="inline"
                    expandedContentClassName="pl-8 pr-0"
                    expandedContent={flowRows.length > 0 ? (
                      <div className="rounded-md border border-border/30 bg-background/40 p-1">
                        {flowRows.map((flow: any, index: number) => {
                          const label = flow.label || flow.heuristicLabel || flow.name || flow.id;
                          const flowType = flow.crossCommunity || flow.processType === "cross_community"
                            ? "Cross-module"
                            : flow.processType || "Internal";
                          return (
                            <ProfileTreeRow
                              key={flow.id || `${label}-${index}`}
                              label={label}
                              icon={<Waypoints className="h-3.5 w-3.5" />}
                              hasValue
                              showEmpty
                              mobileLayout="inline"
                              expandedContent={(
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                                  <span>{flow.stepCount || 0} steps</span>
                                  <span>{flowType}</span>
                                </div>
                              )}
                              testId={`tree-row-code-flow-${index}`}
                            >
                              <span className="tabular-nums text-muted-foreground">{flow.stepCount || 0} steps</span>
                            </ProfileTreeRow>
                          );
                        })}
                      </div>
                    ) : undefined}
                    testId="tree-row-code-flows"
                  >
                    <span className="tabular-nums text-muted-foreground">{flowRows.length || stats?.processCount || 0}</span>
                  </ProfileTreeRow>
                </div>
              )}
              testId="tree-row-code-root"
            >
              <span className="text-muted-foreground">
                {(stats?.fileCount || 0).toLocaleString()} files
              </span>
            </ProfileTreeRow>
          </div>
        ) : (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            <button type="button" className="text-cta hover:underline" onClick={loadArchitecture} data-testid="button-load-overview">
              Load code tree
            </button>
          </div>
        )
      ) : (
        <div data-testid="graph-view">
          {loadingGraph ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : graphError ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-error" data-testid="graph-error">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Graph failed to load: {graphError}</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={loadGraph} data-testid="button-retry-graph">
                Retry
              </Button>
            </div>
          ) : graphData ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
                <span>{graphData.nodes.length.toLocaleString()} nodes · {graphData.relationships.length.toLocaleString()} edges</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => { setGraphData(null); loadGraph(); }}
                  data-testid="button-reload-graph"
                >
                  <RefreshCcw className="mr-1 h-3 w-3" />
                  Refresh
                </Button>
              </div>
              <InteractiveGraph graphData={graphData} onNodeSelect={setInspectedNode} />
              {inspectedNode && <CodeInspector node={inspectedNode} onClose={() => setInspectedNode(null)} />}
            </div>
          ) : (
            <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="graph-empty">
              <button type="button" className="text-cta hover:underline" onClick={loadGraph} data-testid="button-load-graph">
                Load graph data
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
