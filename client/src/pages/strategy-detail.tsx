import { useState, useMemo, useEffect, useCallback, useRef, useLayoutEffect, type MouseEvent as ReactMouseEvent } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronRight,
  CircleDot,
  Lightbulb,
  Loader2,
  Plus,
  TreePine,
  User,
  Users,
  Zap,
  X,
  Clock,
  CheckCircle2,
  StopCircle,
  Bot,
  Pencil,
  Trash2,
  Target,
  FileText,
  Building2,
  Shield,
  Brain,
  Link2,
  Unlink,
  Upload,
  Download,
  File as FileIcon,
  StickyNote,
  Package,
  GripVertical,
  MapPin,
  Navigation,
  ChevronDown,
  Sparkles,
  Flag,
  XCircle,
} from "lucide-react";
import type {
  Strategy,
  StrategyMoveInstance,
  StrategyMoveDefinition,
  StrategyActor,
  StrategyAssumption,
  StrategyAssumptionLink,
  StrategyContextEntry,
  StrategyEndCondition,
  StrategySimulationRun,
  SimulationProgress,
  StrategyArtifact,
  ActorState,
  StrategyState,
  StrategyMoveEndConditionEffect,
} from "@shared/models/strategy";

interface MoveTreeNode {
  kind: "move";
  move: StrategyMoveInstance;
  moveDefinition: StrategyMoveDefinition | null;
  actor: StrategyActor | null;
  children: TreeNode[];
  terminatingState: StrategyState | null;
}

interface StateTreeNode {
  kind: "state";
  state: StrategyState;
  children: TreeNode[];
}

type TreeNode = MoveTreeNode | StateTreeNode;

function buildMoveTree(
  moves: StrategyMoveInstance[],
  moveDefinitions: StrategyMoveDefinition[],
  actors: StrategyActor[],
  states: StrategyState[] = [],
): TreeNode[] {
  const defMap = new Map<string, StrategyMoveDefinition>();
  for (const d of moveDefinitions) defMap.set(d.id, d);

  const actorMap = new Map<string, StrategyActor>();
  for (const a of actors) actorMap.set(a.id, a);

  const stateMap = new Map<string, StrategyState>();
  for (const s of states) stateMap.set(s.id, s);

  const moveNodes = new Map<string, MoveTreeNode>();
  for (const m of moves) {
    const def = m.moveDefinitionId ? defMap.get(m.moveDefinitionId) || null : null;
    const actor = m.actorId ? actorMap.get(m.actorId) || null : null;
    const terminatingState = m.terminatingStateId ? stateMap.get(m.terminatingStateId) || null : null;
    moveNodes.set(m.id, {
      kind: "move",
      move: m,
      moveDefinition: def,
      actor: actor,
      children: [],
      terminatingState,
    });
  }

  const stateNodes = new Map<string, StateTreeNode>();
  for (const s of states) {
    stateNodes.set(s.id, { kind: "state", state: s, children: [] });
  }

  for (const m of moves) {
    if (m.parentStateId && stateNodes.has(m.parentStateId)) {
      stateNodes.get(m.parentStateId)!.children.push(moveNodes.get(m.id)!);
    }
  }

  for (const m of moves) {
    const node = moveNodes.get(m.id)!;
    if (m.parentMoveInstanceId && moveNodes.has(m.parentMoveInstanceId)) {
      moveNodes.get(m.parentMoveInstanceId)!.children.push(node);
    }
    if (node.terminatingState && stateNodes.has(node.terminatingState.id)) {
      node.children.push({ kind: "state", state: node.terminatingState, children: [] });
    }
  }

  const roots: TreeNode[] = [];
  for (const m of moves) {
    if (!m.parentMoveInstanceId && !m.parentStateId) {
      roots.push(moveNodes.get(m.id)!);
    }
  }
  for (const s of states) {
    roots.push(stateNodes.get(s.id)!);
  }

  return roots;
}

function getMoveFromTreeNode(node: TreeNode): StrategyMoveInstance | null {
  return node.kind === "move" ? node.move : null;
}

function probabilityColor(_p: number): string {
  return "";
}

function statusIcon(status: string) {
  switch (status) {
    case "explored":
      return <CheckCircle2 className="h-3 w-3 text-success" />;
    case "terminal":
      return <StopCircle className="h-3 w-3 text-muted-foreground" />;
    default:
      return <CircleDot className="h-3 w-3 text-info" />;
  }
}

export default function StrategyDetailPage() {
  const [, params] = useRoute("/strategy/:id");
  const [, setLocation] = useLocation();
  const goalId = params?.id || "";
  const { toast } = useToast();
  const [selectedMoveId, setSelectedMoveId] = useState<string | null>(null);
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  const [stateAddMoveOpen, setStateAddMoveOpen] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState("moves");
  const [addMoveOpen, setAddMoveOpen] = useState(false);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const isMobile = useIsMobile();



  const { data: strategy, isLoading: strategyLoading } = useQuery<Strategy>({
    queryKey: ["/api/strategy/goals", goalId],
    enabled: !!goalId,
  });

  const handleTabChange = useCallback((tab: string) => {
    if (tab === "title") {
      setActiveTab("moves");
    } else {
      setActiveTab(tab);
    }
  }, []);

  useFocusContext(
    goalId
      ? {
          entity: { type: "strategy", id: goalId, label: strategy?.title },
          subView: activeTab,
          state: selectedMoveId
            ? { selectedMoveId }
            : selectedStateId
            ? { selectedStateId }
            : undefined,
        }
      : null
  );

  usePageHeader({
    title: "Strategy",
    tabs: [
      { value: "title", label: strategy?.title || "Loading..." },
      { value: "moves", label: "Moves" },
      { value: "states", label: "States" },
      { value: "actors", label: "Actors" },
      { value: "goals", label: "Goals" },
      { value: "notes", label: "Notes" },
      { value: "artifacts", label: "Artifacts" },
      { value: "setup", label: "Setup" },
    ],
    activeTab: ["moves", "states", "actors", "goals", "notes", "artifacts", "setup"].includes(activeTab) ? activeTab : "title",
    onTabChange: handleTabChange,
  });

  const { data: moveTree = [], isLoading: movesLoading } = useQuery<StrategyMoveInstance[]>({
    queryKey: ["/api/strategy/goals", goalId, "move-tree"],
    enabled: !!goalId,
  });

  const { data: actors = [] } = useQuery<StrategyActor[]>({
    queryKey: ["/api/strategy/goals", goalId, "actors"],
    enabled: !!goalId,
  });

  const { data: moveDefinitions = [] } = useQuery<StrategyMoveDefinition[]>({
    queryKey: ["/api/strategy/goals", goalId, "move-definitions"],
    enabled: !!goalId,
  });

  const { data: simulationRuns = [] } = useQuery<StrategySimulationRun[]>({
    queryKey: ["/api/strategy/goals", goalId, "simulation-runs"],
    enabled: !!goalId,
    refetchInterval: (query) => {
      const runs = query.state.data as StrategySimulationRun[] | undefined;
      if (runs?.some(r => r.status === "running")) return 3000;
      return false;
    },
  });

  const { data: endConditions = [] } = useQuery<StrategyEndCondition[]>({
    queryKey: ["/api/strategy/goals", goalId, "end-conditions"],
    enabled: !!goalId,
  });

  const { data: states = [] } = useQuery<StrategyState[]>({
    queryKey: ["/api/strategy/goals", goalId, "states"],
    enabled: !!goalId,
  });

  const { data: ecEffects = [] } = useQuery<StrategyMoveEndConditionEffect[]>({
    queryKey: ["/api/strategy/goals", goalId, "move-end-condition-effects"],
    enabled: !!goalId,
  });

  const { data: optimalPathData } = useQuery<{
    currentPositionId: string | null;
    paths: Array<{
      targetNodeId: string;
      targetNodeTitle: string;
      nodes: StrategyMoveInstance[];
      score: number;
      satisfiedEndConditions: StrategyEndCondition[];
    }>;
    unsatisfiedEndConditions: StrategyEndCondition[];
  }>({
    queryKey: ["/api/strategy/goals", goalId, "optimal-path"],
    enabled: !!goalId && !!strategy?.currentMoveInstanceId,
  });

  const reparentMoveMutation = useMutation({
    mutationFn: async (vars: { id: string; updates: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/strategy/move-instances/${vars.id}`, vars.updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
      toast({ title: "Move reparented" });
    },
    onError: (err: Error) => toast({ title: "Reparent failed", description: err.message, variant: "destructive" }),
  });

  const setCurrentPositionMutation = useMutation({
    mutationFn: async (moveInstanceId: string | null) => {
      await apiRequest("PATCH", `/api/strategy/goals/${goalId}/current-position`, { moveInstanceId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
      toast({ title: "Current position updated" });
    },
  });

  const optimalPathNodeIds = useMemo(() => {
    if (!optimalPathData?.paths?.length) return new Set<string>();
    const topPath = optimalPathData.paths[0];
    return new Set(topPath.nodes.map(n => n.id));
  }, [optimalPathData]);

  const moveSatisfiesByMove = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of ecEffects) {
      if (e.effect !== "satisfies") continue;
      if (!map.has(e.moveInstanceId)) map.set(e.moveInstanceId, new Set());
      map.get(e.moveInstanceId)!.add(e.endConditionId);
    }
    return map;
  }, [ecEffects]);

  const moveBlocksByMove = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of ecEffects) {
      if (e.effect !== "blocks") continue;
      if (!map.has(e.moveInstanceId)) map.set(e.moveInstanceId, new Set());
      map.get(e.moveInstanceId)!.add(e.endConditionId);
    }
    return map;
  }, [ecEffects]);

  const movesById = useMemo(() => new Map(moveTree.map(m => [m.id, m])), [moveTree]);
  const movesTerminatingAtState = useMemo(() => {
    const map = new Map<string, typeof moveTree>();
    for (const m of moveTree) {
      if (m.terminatingStateId) {
        if (!map.has(m.terminatingStateId)) map.set(m.terminatingStateId, []);
        map.get(m.terminatingStateId)!.push(m);
      }
    }
    return map;
  }, [moveTree]);

  const getParentMovesClient = (m: typeof moveTree[number]): typeof moveTree => {
    if (m.parentMoveInstanceId) {
      const p = movesById.get(m.parentMoveInstanceId);
      return p ? [p] : [];
    }
    if (m.parentStateId) return movesTerminatingAtState.get(m.parentStateId) || [];
    return [];
  };

  const enumerateAncestorPathsClient = (m: typeof moveTree[number]): Array<typeof moveTree> => {
    const results: Array<typeof moveTree> = [];
    const dfs = (cur: typeof moveTree[number], acc: typeof moveTree, visited: Set<string>) => {
      if (visited.has(cur.id)) return;
      const nextVisited = new Set(visited); nextVisited.add(cur.id);
      const nextAcc = [...acc, cur];
      const parents = getParentMovesClient(cur);
      if (parents.length === 0) { results.push(nextAcc); return; }
      for (const p of parents) dfs(p, nextAcc, nextVisited);
    };
    dfs(m, [], new Set());
    return results;
  };

  const goalCompletingNodeIds = useMemo(() => {
    const requiredEcIds = endConditions.filter(ec => ec.isRequired).map(ec => ec.id);
    if (requiredEcIds.length === 0) return new Set<string>();
    const result = new Set<string>();
    for (const m of moveTree) {
      const allPaths = enumerateAncestorPathsClient(m);
      for (const path of allPaths) {
        const cumulative = new Set<string>();
        let blocked = false;
        for (const node of path) {
          const blocks = moveBlocksByMove.get(node.id);
          if (blocks) {
            for (const ecId of blocks) if (requiredEcIds.includes(ecId)) { blocked = true; break; }
          }
          if (blocked) break;
          const sat = moveSatisfiesByMove.get(node.id);
          if (sat) for (const ecId of sat) cumulative.add(ecId);
        }
        if (!blocked && requiredEcIds.every(id => cumulative.has(id))) { result.add(m.id); break; }
      }
    }
    return result;
  }, [moveTree, endConditions, moveSatisfiesByMove, moveBlocksByMove, movesById, movesTerminatingAtState]);

  const partialGoalNodeIds = useMemo(() => {
    const allEcIds = endConditions.map(ec => ec.id);
    if (allEcIds.length === 0) return new Set<string>();
    const result = new Set<string>();
    for (const m of moveTree) {
      if (goalCompletingNodeIds.has(m.id)) continue;
      const allPaths = enumerateAncestorPathsClient(m);
      let hasAny = false;
      let hasAll = false;
      for (const path of allPaths) {
        const cumulative = new Set<string>();
        for (const node of path) {
          const sat = moveSatisfiesByMove.get(node.id);
          if (sat) for (const ecId of sat) cumulative.add(ecId);
        }
        if (allEcIds.some(id => cumulative.has(id))) hasAny = true;
        if (allEcIds.every(id => cumulative.has(id))) { hasAll = true; break; }
      }
      if (hasAny && !hasAll) result.add(m.id);
    }
    return result;
  }, [moveTree, endConditions, goalCompletingNodeIds, moveSatisfiesByMove, movesById, movesTerminatingAtState]);

  const blockedMoveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of ecEffects) {
      if (e.effect === "blocks") ids.add(e.moveInstanceId);
    }
    return ids;
  }, [ecEffects]);

  const activeRuns = useMemo(
    () => simulationRuns.filter(r => r.status === "running"),
    [simulationRuns]
  );

  const treeRoots = useMemo(
    () => buildMoveTree(moveTree, moveDefinitions, actors, states),
    [moveTree, moveDefinitions, actors, states]
  );

  const [sidebarAddMoveOpen, setSidebarAddMoveOpen] = useState(false);

  const TREE_PANEL_MIN = 250;
  const TREE_PANEL_MAX = 600;
  const TREE_PANEL_DEFAULT = 384;
  const [treePanelWidth, setTreePanelWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("strategy-tree-panel-width");
      if (stored) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= TREE_PANEL_MIN && val <= TREE_PANEL_MAX) return val;
      }
    } catch {}
    return TREE_PANEL_DEFAULT;
  });
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  const handleResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = treePanelWidth;

    const handleMouseMove = (ev: globalThis.MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientX - dragStartXRef.current;
      const newWidth = Math.min(TREE_PANEL_MAX, Math.max(TREE_PANEL_MIN, dragStartWidthRef.current + delta));
      setTreePanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [treePanelWidth]);

  useEffect(() => {
    try {
      localStorage.setItem("strategy-tree-panel-width", String(treePanelWidth));
    } catch {}
  }, [treePanelWidth]);

  const selectedMove = useMemo(
    () => moveTree.find(m => m.id === selectedMoveId) || null,
    [moveTree, selectedMoveId]
  );

  

  const initialExpandDone = useRef(false);
  const lastGoalIdRef = useRef(goalId);
  useEffect(() => {
    if (lastGoalIdRef.current !== goalId) {
      lastGoalIdRef.current = goalId;
      initialExpandDone.current = false;
    }
  }, [goalId]);
  useEffect(() => {
    if (treeRoots.length === 0 || initialExpandDone.current) return;
    initialExpandDone.current = true;
    const newExpanded = new Set<string>();
    for (const root of treeRoots) {
      if (root.children.length > 0) {
        const id = root.kind === "move" ? root.move.id : `state:${root.state.id}`;
        newExpanded.add(id);
      }
    }
    if (strategy?.currentMoveInstanceId) {
      const curMove = moveTree.find(m => m.id === strategy.currentMoveInstanceId);
      if (curMove?.path) {
        curMove.path.split("/").filter(Boolean).forEach(id => newExpanded.add(id));
      }
    }
    setExpandedNodes(newExpanded);
  }, [treeRoots, moveTree, strategy?.currentMoveInstanceId]);

  useEffect(() => {
    if (!optimalPathData?.paths?.length || !initialExpandDone.current) return;
    const topPath = optimalPathData.paths[0];
    setExpandedNodes(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const node of topPath.nodes) {
        if (!next.has(node.id)) { next.add(node.id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [optimalPathData]);


  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAndExpandPath = useCallback((moveId: string) => {
    setSelectedMoveId(moveId);
    setSelectedStateId(null);
    setMobileShowDetail(true);
    const move = moveTree.find(m => m.id === moveId);
    if (move?.path) {
      const pathIds = move.path.split("/").filter(Boolean);
      setExpandedNodes(prev => {
        const next = new Set(prev);
        pathIds.forEach(id => next.add(id));
        return next;
      });
    }
  }, [moveTree]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event" && msg.event) {
          const evt = msg.event;
          if (
            evt.category === "strategy" ||
            evt.event?.startsWith("strategy.simulation") ||
            evt.event?.startsWith("strategy.evaluation")
          ) {
            queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "simulation-runs"] });
            queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
            queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
          }
        }
      } catch {}
    };
    return () => {
      ws.onclose = null;
      ws.close();
    };
  }, [goalId]);

  if (strategyLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4" data-testid="strategy-not-found">
        <p className="text-muted-foreground">Strategy not found</p>
        <Button variant="ghost" onClick={() => setLocation("/strategy")} data-testid="button-back-not-found">
          Back to Strategies
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="strategy-detail-page">
      {activeRuns.length > 0 && (
        <SimulationProgressBar runs={activeRuns} goalId={goalId} />
      )}

      {activeTab === "moves" && (
        <details className="border-b shrink-0" data-testid="collapsible-assumptions">
          <summary className="px-3 py-1.5 text-xs font-semibold cursor-pointer hover-elevate active-elevate-2 select-none flex items-center gap-1.5">
            <Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="uppercase tracking-wider text-muted-foreground">Assumptions</span>
          </summary>
          <div className="border-t bg-muted/30 max-h-[50vh] overflow-y-auto scrollbar-thin p-2">
            <AssumptionsPanel goalId={goalId} />
          </div>
        </details>
      )}

      {activeTab === "setup" ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <StrategySettingsPanel goalId={goalId} strategy={strategy} />
        </div>
      ) : activeTab === "actors" ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <ActorsPanel goalId={goalId} actors={actors} moveDefinitions={moveDefinitions} />
        </div>
      ) : activeTab === "states" ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <StatesPanel
            goalId={goalId}
            states={states}
            allMoves={moveTree}
            onOpenState={(sid) => {
              setSelectedStateId(sid);
              setSelectedMoveId(null);
              setActiveTab("moves");
              setMobileShowDetail(true);
            }}
          />
        </div>
      ) : activeTab === "goals" ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <StrategyDescriptionPanel goalId={goalId} strategy={strategy} />
          <EndConditionsPanel goalId={goalId} />
        </div>
      ) : activeTab === "notes" ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <ContextPanel goalId={goalId} />
        </div>
      ) : activeTab === "artifacts" ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
          <ArtifactsPanel goalId={goalId} />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div
            className={`@md:border-r flex flex-col shrink-0 overflow-hidden relative ${mobileShowDetail ? "hidden @md:flex" : "flex w-full @md:w-auto"}`}
            style={isMobile ? undefined : { width: `${treePanelWidth}px` }}
            data-testid="panel-move-tree"
          >
              <div className="p-3 border-b">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold truncate" data-testid="text-tree-strategy-title">
                    {strategy?.title || "Move Tree"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSidebarAddMoveOpen(true)}
                    data-testid="button-sidebar-add-move"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {strategy?.description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2" data-testid="text-tree-strategy-desc">
                    {strategy.description}
                  </p>
                )}
              </div>
              {strategy?.currentMoveInstanceId && optimalPathData && optimalPathData.paths.length > 0 && (
                <div className="px-3 py-2 border-b space-y-1" data-testid="optimal-path-summary">
                  <div className="flex items-center gap-1.5">
                    <Navigation className="h-3 w-3 text-success" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Best Path</span>
                  </div>
                  {optimalPathData.paths.slice(0, 3).map((p, i) => (
                    <div key={p.targetNodeId} className="flex items-center gap-1.5 text-xs">
                      <span className={`font-mono font-medium ${i === 0 ? "text-success" : "text-muted-foreground"}`}>
                        {Math.round(p.score * 100)}%
                      </span>
                      <span className="text-muted-foreground truncate">→ {p.targetNodeTitle}</span>
                    </div>
                  ))}
                  {optimalPathData.unsatisfiedEndConditions.length > 0 && (
                    <div className="text-xs text-muted-foreground/60">
                      {optimalPathData.unsatisfiedEndConditions.length} end condition{optimalPathData.unsatisfiedEndConditions.length > 1 ? "s" : ""} unlinked
                    </div>
                  )}
                </div>
              )}
              <div className="flex-1 overflow-y-auto scrollbar-thin p-2" onClick={(e) => { if (e.target === e.currentTarget) setSelectedMoveId(null); }}>
                {movesLoading ? (
                  <div className="space-y-2 p-2">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-6 w-full" />)}
                  </div>
                ) : treeRoots.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <TreePine className="h-6 w-6 text-muted-foreground/40" />
                    <p className="text-xs text-muted-foreground" data-testid="text-empty-tree">No moves yet</p>
                    <Button
                      size="sm"
                      onClick={() => setSidebarAddMoveOpen(true)}
                      data-testid="button-create-root-empty"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add Move
                    </Button>
                  </div>
                ) : (
                  treeRoots.map(node => (
                    <MoveTreeNodeComponent
                      key={node.kind === "move" ? node.move.id : `state:${node.state.id}`}
                      node={node}
                      selectedId={selectedMoveId}
                      expandedNodes={expandedNodes}
                      onSelect={selectAndExpandPath}
                      onSelectState={(sid) => { setSelectedStateId(sid); setSelectedMoveId(null); setMobileShowDetail(true); }}
                      selectedStateId={selectedStateId}
                      onToggle={toggleExpand}
                      depth={0}
                      currentPositionId={strategy?.currentMoveInstanceId || null}
                      optimalPathNodeIds={optimalPathNodeIds}
                      goalCompletingNodeIds={goalCompletingNodeIds}
                      partialGoalNodeIds={partialGoalNodeIds}
                      blockedMoveIds={blockedMoveIds}
                      onSetCurrentPosition={(id) => setCurrentPositionMutation.mutate(id)}
                      onReparent={(movedId, target) => {
                        if (target.kind === "move") {
                          if (movedId === target.id) return;
                          reparentMoveMutation.mutate({ id: movedId, updates: { parentMoveInstanceId: target.id, parentStateId: null } });
                        } else {
                          reparentMoveMutation.mutate({ id: movedId, updates: { parentStateId: target.id, parentMoveInstanceId: null } });
                        }
                      }}
                    />
                  ))
                )}
              </div>
              <AddMoveDialog
                open={sidebarAddMoveOpen}
                onOpenChange={setSidebarAddMoveOpen}
                parentMoveId={selectedMoveId}
                goalId={goalId}
                actors={actors}
                moveDefinitions={moveDefinitions}
              />
            <div
              className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize z-10 hidden @md:flex items-center justify-center group"
              onMouseDown={handleResizeStart}
              data-testid="tree-panel-resize-handle"
            >
              <div className="w-0.5 h-8 rounded-full bg-border group-hover:bg-muted-foreground/40 transition-colors" />
            </div>
          </div>

          <div className={`flex-1 min-w-0 overflow-y-auto scrollbar-thin ${mobileShowDetail ? "flex flex-col" : "hidden @md:block"}`} data-testid="panel-move-detail">
            <div className="@md:hidden p-2 border-b">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMobileShowDetail(false)}
                data-testid="button-mobile-back-to-tree"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-180 mr-1" />
                Back to tree
              </Button>
            </div>
            {selectedStateId ? (
              <StateDetailPanel
                state={states.find(s => s.id === selectedStateId) || null}
                allMoves={moveTree}
                actors={actors}
                moveDefinitions={moveDefinitions}
                onNavigateMove={selectAndExpandPath}
                onClose={() => setSelectedStateId(null)}
                stateAddMoveOpen={stateAddMoveOpen}
                setStateAddMoveOpen={setStateAddMoveOpen}
                goalId={goalId}
              />
            ) : (
              <MoveDetailPanel
                move={selectedMove}
                goalId={goalId}
                actors={actors}
                allMoves={moveTree}
                moveDefinitions={moveDefinitions}
                onNavigateMove={selectAndExpandPath}
                addMoveOpen={addMoveOpen}
                setAddMoveOpen={setAddMoveOpen}
                endConditions={endConditions}
                states={states}
                ecEffects={ecEffects}
                currentPositionId={strategy?.currentMoveInstanceId || null}
                onSetCurrentPosition={(id) => setCurrentPositionMutation.mutate(id)}
                activeRuns={activeRuns}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MoveTreeNodeComponent({
  node,
  selectedId,
  selectedStateId,
  expandedNodes,
  onSelect,
  onSelectState,
  onToggle,
  depth,
  currentPositionId,
  optimalPathNodeIds,
  goalCompletingNodeIds,
  partialGoalNodeIds,
  blockedMoveIds,
  onSetCurrentPosition,
  visitedStateIds,
  onReparent,
}: {
  node: TreeNode;
  selectedId: string | null;
  selectedStateId?: string | null;
  expandedNodes: Set<string>;
  onSelect: (id: string) => void;
  onSelectState?: (id: string) => void;
  onToggle: (id: string) => void;
  depth: number;
  currentPositionId: string | null;
  optimalPathNodeIds: Set<string>;
  goalCompletingNodeIds: Set<string>;
  partialGoalNodeIds: Set<string>;
  blockedMoveIds: Set<string>;
  onSetCurrentPosition: (id: string | null) => void;
  visitedStateIds?: Set<string>;
  onReparent?: (movedId: string, target: { kind: "move"; id: string } | { kind: "state"; id: string }) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const visited = visitedStateIds ?? new Set<string>();
  if (node.kind === "state") {
    const nodeId = `state:${node.state.id}`;
    const isExpanded = expandedNodes.has(nodeId);
    const alreadyVisited = visited.has(node.state.id);
    const hasChildren = node.children.length > 0 && !alreadyVisited;
    const isSelectedState = selectedStateId === node.state.id;
    return (
      <div data-testid={`tree-state-${node.state.id}`}>
        <div
          className={`flex items-center gap-1 py-1 px-1.5 rounded-md cursor-pointer text-xs group ${depth === 0 ? `bg-info/5 border-l-2 ${isSelectedState ? "border-info bg-info/15" : "border-info/40"}` : `${isSelectedState ? "bg-info/15" : ""}`} ${dragOver ? "ring-2 ring-info" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 6}px` }}
          onClick={() => onSelectState?.(node.state.id)}
          data-testid={`tree-state-item-${node.state.id}`}
          onDragOver={(e) => {
            const movedId = e.dataTransfer.types.includes("application/x-move-id");
            if (movedId && onReparent) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(true); }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            const movedId = e.dataTransfer.getData("application/x-move-id");
            if (movedId && onReparent) onReparent(movedId, { kind: "state", id: node.state.id });
          }}
        >
          <button className="shrink-0 w-4 h-4 flex items-center justify-center" onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(nodeId); }}>
            {hasChildren ? <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} /> : <span className="w-3" />}
          </button>
          <Flag className="h-3 w-3 text-info shrink-0" />
          <div className="truncate flex-1 min-w-0 ml-1">
            <span className="block truncate font-medium">{node.state.name}</span>
            <span className="block truncate text-xs text-muted-foreground">State</span>
          </div>
        </div>
        {alreadyVisited && (
          <div className="text-xs text-muted-foreground italic" style={{ paddingLeft: `${(depth + 1) * 16 + 6}px` }}>
            (cycle: state already shown above)
          </div>
        )}
        {isExpanded && hasChildren && (
          <div>
            {node.children.map(child => (
              <MoveTreeNodeComponent
                key={child.kind === "move" ? child.move.id : `state:${child.state.id}`}
                node={child}
                selectedId={selectedId}
                selectedStateId={selectedStateId}
                expandedNodes={expandedNodes}
                onSelect={onSelect}
                onSelectState={onSelectState}
                onToggle={onToggle}
                depth={depth + 1}
                currentPositionId={currentPositionId}
                optimalPathNodeIds={optimalPathNodeIds}
                goalCompletingNodeIds={goalCompletingNodeIds}
                partialGoalNodeIds={partialGoalNodeIds}
                blockedMoveIds={blockedMoveIds}
                onSetCurrentPosition={onSetCurrentPosition}
                visitedStateIds={new Set([...visited, node.state.id])}
                onReparent={onReparent}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  const isSelected = node.move.id === selectedId;
  const isExpanded = expandedNodes.has(node.move.id);
  const hasChildren = node.children.length > 0;
  const nodeLabel = node.move.title || node.moveDefinition?.title || "Unknown Move";
  const isCurrentPosition = node.move.id === currentPositionId;
  const isOnOptimalPath = optimalPathNodeIds.has(node.move.id);
  const isGoalCompleting = goalCompletingNodeIds.has(node.move.id);
  const isPartialGoal = partialGoalNodeIds.has(node.move.id);
  const isBlocked = blockedMoveIds.has(node.move.id);

  const actorLabel = node.actor?.name;

  return (
    <div data-testid={`tree-node-${node.move.id}`}>
      <div
        className={`flex items-center gap-1 py-1 px-1.5 rounded-md cursor-pointer text-xs group relative ${
          isBlocked
            ? "bg-destructive/10 border-l-2 border-destructive text-destructive"
            : isCurrentPosition
              ? "bg-success/15 border-l-2 border-success"
              : isGoalCompleting
                ? "bg-success/10 border-l-2 border-success/70"
                : isOnOptimalPath
                  ? "bg-success/5 border-l-2 border-success/30"
                  : isSelected
                    ? "bg-accent text-accent-foreground"
                    : "hover-elevate"
        } ${dragOver ? "ring-2 ring-info" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
        onClick={() => onSelect(node.move.id)}
        data-testid={`tree-item-${node.move.id}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-move-id", node.move.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!onReparent) return;
          if (!e.dataTransfer.types.includes("application/x-move-id")) return;
          e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          const movedId = e.dataTransfer.getData("application/x-move-id");
          if (movedId && movedId !== node.move.id && onReparent) {
            onReparent(movedId, { kind: "move", id: node.move.id });
          }
        }}
      >
        <button
          className="shrink-0 w-4 h-4 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.move.id);
          }}
          data-testid={`tree-toggle-${node.move.id}`}
        >
          {hasChildren ? (
            <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
          ) : (
            <span className="w-3" />
          )}
        </button>
        {isBlocked ? (
          <XCircle className="h-3 w-3 text-destructive shrink-0" />
        ) : isCurrentPosition ? (
          <MapPin className="h-3 w-3 text-success shrink-0" />
        ) : isGoalCompleting ? (
          <MapPin className="h-3 w-3 text-success fill-success shrink-0" />
        ) : isPartialGoal ? (
          <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
        ) : (
          <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <div className="truncate flex-1 min-w-0 ml-1" data-testid={`tree-label-${node.move.id}`}>
          <span className="block truncate">{nodeLabel}</span>
          {actorLabel && (
            <span className="block truncate text-xs text-muted-foreground">{actorLabel}</span>
          )}
        </div>
        {node.move.source === "simulated" && (
          <Bot className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        )}
        <Badge
          variant="secondary"
          className={`no-default-hover-elevate no-default-active-elevate text-xs px-1 py-0 leading-tight shrink-0 ${probabilityColor(node.move.probability)}`}
          data-testid={`tree-prob-${node.move.id}`}
        >
          {Math.round(node.move.probability * 100)}%
        </Badge>
        {!isCurrentPosition && (
          <button
            className="shrink-0 w-4 h-4 items-center justify-center hidden group-hover:flex"
            onClick={(e) => {
              e.stopPropagation();
              onSetCurrentPosition(node.move.id);
            }}
            title="Set as current position"
            data-testid={`button-set-position-${node.move.id}`}
          >
            <MapPin className="h-2.5 w-2.5 text-muted-foreground hover:text-primary" />
          </button>
        )}
      </div>
      {isExpanded && hasChildren && (
        <div>
          {[...node.children].sort((a, b) => {
            if (a.kind === "state" && b.kind === "state") return 0;
            if (a.kind === "state") return 1;
            if (b.kind === "state") return -1;
            const aOnPath = optimalPathNodeIds.has(a.move.id) ? 1 : 0;
            const bOnPath = optimalPathNodeIds.has(b.move.id) ? 1 : 0;
            if (aOnPath !== bOnPath) return bOnPath - aOnPath;
            return b.move.probability - a.move.probability;
          }).map(child => (
            <MoveTreeNodeComponent
              key={child.kind === "move" ? child.move.id : `state:${child.state.id}`}
              node={child}
              selectedId={selectedId}
              selectedStateId={selectedStateId}
              expandedNodes={expandedNodes}
              onSelect={onSelect}
              onSelectState={onSelectState}
              onToggle={onToggle}
              depth={depth + 1}
              currentPositionId={currentPositionId}
              optimalPathNodeIds={optimalPathNodeIds}
              goalCompletingNodeIds={goalCompletingNodeIds}
              partialGoalNodeIds={partialGoalNodeIds}
              blockedMoveIds={blockedMoveIds}
              onSetCurrentPosition={onSetCurrentPosition}
              onReparent={onReparent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SimulationProgressBar({
  runs,
  goalId,
}: {
  runs: StrategySimulationRun[];
  goalId: string;
}) {
  const { toast } = useToast();

  const cancelMutation = useMutation({
    mutationFn: async (runId: string) => {
      await apiRequest("POST", `/api/strategy/simulation-runs/${runId}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "simulation-runs"] });
      toast({ title: "Simulation cancelled" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to cancel", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="border-b bg-muted/30 px-3 py-2 space-y-1" data-testid="simulation-progress-bar">
      {runs.map(run => {
        const progress = run.progress as SimulationProgress | null;
        const elapsed = run.startedAt
          ? Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)
          : 0;

        return (
          <div key={run.id} className="flex items-center gap-3 text-xs" data-testid={`sim-run-${run.id}`}>
            <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
            <span className="text-muted-foreground shrink-0" data-testid={`sim-mode-${run.id}`}>
              {run.mode === "clear_and_simulate" ? "Simulating" : "Updating"}
            </span>
            {progress?.currentMoveName && (
              <span className="truncate text-foreground" data-testid={`sim-current-${run.id}`}>
                {progress.currentMoveName}
              </span>
            )}
            <span className="text-muted-foreground shrink-0" data-testid={`sim-progress-${run.id}`}>
              {progress?.movesProcessed || 0} moves
            </span>
            <span className="text-muted-foreground shrink-0 flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {elapsed}s
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto shrink-0"
              onClick={() => cancelMutation.mutate(run.id)}
              disabled={cancelMutation.isPending}
              data-testid={`button-cancel-sim-${run.id}`}
            >
              <X className="h-3 w-3 mr-1" />
              Cancel
            </Button>
          </div>
        );
      })}
    </div>
  );
}

interface LinkedMemoryEntry {
  id: number;
  content: string;
  title?: string;
  summary?: string;
  layer: string;
  source: string;
  tags?: string[];
  createdAt?: string;
  linkId: number;
}

function StrategyLinkedMemories({ moveId, goalId }: { moveId: string; goalId: string }) {
  const { toast } = useToast();
  const { data: memories, isLoading } = useQuery<LinkedMemoryEntry[]>({
    queryKey: ["/api/memory/entity-links", "strategy", goalId],
    queryFn: async () => {
      const res = await fetch(`/api/memory/entity-links/strategy/${goalId}`);
      if (!res.ok) throw new Error("Failed to fetch linked memories");
      return res.json();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (memoryId: number) => {
      await apiRequest("DELETE", `/api/memory/entity-links/${memoryId}/strategy/${goalId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memory/entity-links", "strategy", goalId] });
      toast({ title: "Memory unlinked" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to unlink", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (!memories || memories.length === 0) return null;

  return (
    <Card className="p-4" data-testid="card-strategy-linked-memories">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2 flex items-center gap-1">
        <Brain className="h-3 w-3" />
        Linked Memories ({memories.length})
      </span>
      <div className="space-y-2">
        {memories.map((memory) => (
          <div
            key={memory.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/30 border border-border/50"
            data-testid={`strategy-memory-${memory.id}`}
          >
            <Brain className="h-3 w-3 text-muted-foreground/70 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm truncate text-foreground/80">{memory.title || memory.summary || memory.content.slice(0, 80)}</p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <Badge variant="outline" className="text-xs">{memory.layer}</Badge>
                <Badge variant="outline" className="text-xs">{memory.source}</Badge>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => unlinkMutation.mutate(memory.id)}
              disabled={unlinkMutation.isPending}
              data-testid={`button-unlink-strategy-memory-${memory.id}`}
            >
              <Unlink className="h-3 w-3 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StateDetailPanel({
  state,
  allMoves,
  actors,
  moveDefinitions,
  onNavigateMove,
  onClose,
  stateAddMoveOpen,
  setStateAddMoveOpen,
  goalId,
}: {
  state: StrategyState | null;
  allMoves: StrategyMoveInstance[];
  actors: StrategyActor[];
  moveDefinitions: StrategyMoveDefinition[];
  onNavigateMove: (id: string) => void;
  onClose: () => void;
  stateAddMoveOpen: boolean;
  setStateAddMoveOpen: (o: boolean) => void;
  goalId: string;
}) {
  if (!state) {
    return <div className="p-4 text-sm text-muted-foreground">State not found.</div>;
  }
  const terminating = allMoves.filter(m => m.terminatingStateId === state.id);
  const children = allMoves.filter(m => m.parentStateId === state.id);
  return (
    <div className="p-4 space-y-4" data-testid="panel-state-detail">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Flag className="h-4 w-4 text-info" />
          <div>
            <h2 className="text-sm font-semibold" data-testid="text-state-name">{state.name}</h2>
            {state.description && <p className="text-xs text-muted-foreground">{state.description}</p>}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-state-detail">Close</Button>
      </div>

      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Reached by ({terminating.length})
          </span>
        </div>
        {terminating.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No moves currently terminate at this state.</p>
        ) : (
          <div className="space-y-1">
            {terminating.map(m => (
              <button
                key={m.id}
                className="block w-full text-left text-xs px-2 py-1 rounded hover-elevate truncate"
                onClick={() => onNavigateMove(m.id)}
                data-testid={`link-state-terminator-${m.id}`}
              >
                {m.title || "(untitled)"}
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Branches into ({children.length})
          </span>
          <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => setStateAddMoveOpen(true)} data-testid="button-add-move-from-state">
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {children.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No follow-up moves yet. Click + to add one.</p>
        ) : (
          <div className="space-y-1">
            {children.map(m => (
              <button
                key={m.id}
                className="block w-full text-left text-xs px-2 py-1 rounded hover-elevate truncate"
                onClick={() => onNavigateMove(m.id)}
                data-testid={`link-state-child-${m.id}`}
              >
                {m.title || "(untitled)"}
              </button>
            ))}
          </div>
        )}
      </Card>

      <AddMoveDialog
        open={stateAddMoveOpen}
        onOpenChange={setStateAddMoveOpen}
        parentMoveId={null}
        parentStateId={state.id}
        goalId={goalId}
        actors={actors}
        moveDefinitions={moveDefinitions}
      />
    </div>
  );
}

function MoveDetailPanel({
  move,
  goalId,
  actors,
  allMoves,
  moveDefinitions,
  onNavigateMove,
  addMoveOpen,
  setAddMoveOpen,
  endConditions,
  states,
  ecEffects,
  currentPositionId,
  onSetCurrentPosition,
  activeRuns,
}: {
  move: StrategyMoveInstance | null;
  goalId: string;
  actors: StrategyActor[];
  allMoves: StrategyMoveInstance[];
  moveDefinitions: StrategyMoveDefinition[];
  onNavigateMove: (moveId: string) => void;
  addMoveOpen: boolean;
  setAddMoveOpen: (open: boolean) => void;
  endConditions: StrategyEndCondition[];
  states: StrategyState[];
  ecEffects: StrategyMoveEndConditionEffect[];
  currentPositionId: string | null;
  onSetCurrentPosition: (id: string | null) => void;
  activeRuns: StrategySimulationRun[];
}) {
  const { toast } = useToast();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const { data: assumptions = [] } = useQuery<StrategyAssumption[]>({
    queryKey: ["/api/strategy/goals", goalId, "assumptions"],
    enabled: !!goalId,
  });

  const { data: assumptionLinks = [] } = useQuery<StrategyAssumptionLink[]>({
    queryKey: ["/api/strategy/goals", goalId, "assumption-links"],
    enabled: !!goalId,
  });

  const updateMoveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      if (!move) return;
      const res = await apiRequest("PATCH", `/api/strategy/move-instances/${move.id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
      toast({ title: "Move updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const inlineCreateStateMutation = useMutation({
    mutationFn: async (vars: { name: string; assignAs: "parent" | "terminating" }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/states`, { name: vars.name });
      const state = await res.json();
      if (move) {
        const updates = vars.assignAs === "parent"
          ? { parentStateId: state.id }
          : { terminatingStateId: state.id };
        await apiRequest("PATCH", `/api/strategy/move-instances/${move.id}`, updates);
      }
      return state;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      toast({ title: "State created" });
    },
    onError: (err: Error) => {
      toast({ title: "Create state failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMoveMutation = useMutation({
    mutationFn: async () => {
      if (!move) return;
      await apiRequest("DELETE", `/api/strategy/move-instances/${move.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      const parentId = move?.parentMoveInstanceId;
      if (parentId) {
        onNavigateMove(parentId);
      }
      toast({ title: "Move deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const actorMap = useMemo(() => {
    const m = new Map<string, StrategyActor>();
    for (const a of actors) m.set(a.id, a);
    return m;
  }, [actors]);

  const defMap = useMemo(() => {
    const m = new Map<string, StrategyMoveDefinition>();
    for (const d of moveDefinitions) m.set(d.id, d);
    return m;
  }, [moveDefinitions]);

  const moveHistoryChain = useMemo(() => {
    if (!move) return [];
    const chain: Array<{
      move: StrategyMoveInstance;
      moveDefinition: StrategyMoveDefinition | null;
      actor: StrategyActor | null;
      parentMove: StrategyMoveInstance | null;
    }> = [];

    const moveMap = new Map<string, StrategyMoveInstance>();
    for (const m of allMoves) moveMap.set(m.id, m);

    let current: StrategyMoveInstance | undefined = move;
    while (current) {
      const def = current.moveDefinitionId ? defMap.get(current.moveDefinitionId) || null : null;
      const actor = current.actorId ? actorMap.get(current.actorId) || null : null;
      const parentMove = current.parentMoveInstanceId ? moveMap.get(current.parentMoveInstanceId) || null : null;
      chain.unshift({ move: current, moveDefinition: def, actor: actor, parentMove });
      current = current.parentMoveInstanceId ? moveMap.get(current.parentMoveInstanceId) : undefined;
    }
    return chain;
  }, [move, allMoves, defMap, actorMap]);

  const childMoves = useMemo(() => {
    if (!move) return [];
    return allMoves.filter(m => m.parentMoveInstanceId === move.id);
  }, [move, allMoves]);

  const moveActor = useMemo(() => {
    if (!move?.actorId) return null;
    return actorMap.get(move.actorId) || null;
  }, [move, actorMap]);

  const moveDef = useMemo(() => {
    if (!move?.moveDefinitionId) return null;
    return defMap.get(move.moveDefinitionId) || null;
  }, [move, defMap]);

  const effectsByMove = useMemo(() => {
    const map = new Map<string, Map<string, "satisfies" | "blocks">>();
    for (const e of ecEffects) {
      if (!map.has(e.moveInstanceId)) map.set(e.moveInstanceId, new Map());
      map.get(e.moveInstanceId)!.set(e.endConditionId, e.effect as "satisfies" | "blocks");
    }
    return map;
  }, [ecEffects]);

  const ancestorSatisfiedIds = useMemo(() => {
    if (!move) return new Set<string>();
    const ids = new Set<string>();
    const movesById = new Map(allMoves.map(m => [m.id, m]));
    let cur = move.parentMoveInstanceId ? movesById.get(move.parentMoveInstanceId) : null;
    while (cur) {
      const ancEffects = effectsByMove.get(cur.id);
      if (ancEffects) {
        for (const [ecId, ef] of ancEffects) {
          if (ef === "satisfies") ids.add(ecId);
        }
      }
      cur = cur.parentMoveInstanceId ? movesById.get(cur.parentMoveInstanceId) : null;
    }
    return ids;
  }, [move, allMoves, effectsByMove]);

  const thisMoveEffects = useMemo(() => {
    if (!move) return new Map<string, "satisfies" | "blocks">();
    return effectsByMove.get(move.id) || new Map();
  }, [move, effectsByMove]);

  const thisMoveConditionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [ecId, ef] of thisMoveEffects) {
      if (ef === "satisfies") ids.add(ecId);
    }
    return ids;
  }, [thisMoveEffects]);

  const thisMoveBlockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [ecId, ef] of thisMoveEffects) {
      if (ef === "blocks") ids.add(ecId);
    }
    return ids;
  }, [thisMoveEffects]);

  const setEcEffectMutation = useMutation({
    mutationFn: async ({ endConditionId, effect }: { endConditionId: string; effect: "satisfies" | "blocks" | "none" }) => {
      if (!move) return;
      const res = await apiRequest("PUT", `/api/strategy/move-instances/${move.id}/end-condition-effects`, { endConditionId, effect });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-end-condition-effects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const [endConditionsExpanded, setEndConditionsExpanded] = useState(false);
  const [availableMovesExpanded, setAvailableMovesExpanded] = useState(true);

  if (!move) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm p-4" data-testid="text-no-state">
        Select a move from the tree to view details
      </div>
    );
  }

  return (
    <div className="p-4" data-testid={`move-detail-${move.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        {move.refId && <span className="text-xs font-mono text-muted-foreground" data-testid="text-move-ref">#{move.refId}</span>}
        <div className="flex items-center gap-1 ml-auto">
          {move.id === currentPositionId ? (
            <Badge variant="secondary" className="no-default-hover-elevate text-xs gap-1">
              <MapPin className="h-2.5 w-2.5" />
              Current Position
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSetCurrentPosition(move.id)}
              data-testid={`button-set-current-${move.id}`}
            >
              <MapPin className="h-3.5 w-3.5 mr-1" />
              <span className="hidden @sm:inline">Set as Current</span>
              <span className="@sm:hidden">Current</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => setDeleteConfirmOpen(true)}
            data-testid={`button-delete-move-${move.id}`}
          >
            <Trash2 className="h-3.5 w-3.5 @sm:mr-1" />
            <span className="hidden @sm:inline">Delete Move</span>
          </Button>
        </div>
      </div>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-delete-move-title">Delete this move?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-move-description">
              This will also remove all child moves in this branch. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-move">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMoveMutation.mutate()}
              className="bg-destructive text-destructive-foreground"
              disabled={deleteMoveMutation.isPending}
              data-testid="button-confirm-delete-move"
            >
              {deleteMoveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Trash2 className="h-3.5 w-3.5 mr-1" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="p-3 mb-4" data-testid="card-move-history">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">Move History</span>
        <div className="space-y-1.5">
          {moveHistoryChain.map((entry, i) => {
            const entryActorStates = (entry.move.actorStates || []) as ActorState[];
            const parentActorStates = (entry.parentMove?.actorStates || []) as ActorState[];
            const parentStateMap = new Map<string, string>();
            for (const ps of parentActorStates) parentStateMap.set(ps.actorId, ps.state);
            const changedStates = entryActorStates.filter(as => {
              const prev = parentStateMap.get(as.actorId);
              return as.state && as.state.trim() !== "" && prev !== as.state;
            });
            const isCurrent = entry.move.id === move.id;

            return (
              <div key={entry.move.id} className={`rounded-md border p-2 ${isCurrent ? "bg-accent/30 border-accent" : ""}`} data-testid={`move-history-entry-${entry.move.id}`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0 w-4 text-right">{i + 1}.</span>
                  {entry.move.refId && <span className="text-xs font-mono text-muted-foreground shrink-0">#{entry.move.refId}</span>}
                  {entry.actor && (
                    <span className="text-xs text-muted-foreground shrink-0">{entry.actor.name}</span>
                  )}
                  <button
                    className="text-xs hover:underline text-foreground flex items-center gap-1 font-medium"
                    onClick={() => onNavigateMove(entry.move.id)}
                    data-testid={`move-history-link-${entry.move.id}`}
                  >
                    <Zap className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                    <span>{entry.move.title || entry.moveDefinition?.title || "Unknown Move"}</span>
                  </button>
                  <Badge
                    variant="secondary"
                    className={`no-default-hover-elevate text-xs px-1 py-0 leading-tight shrink-0 ${probabilityColor(entry.move.probability)}`}
                  >
                    {Math.round(entry.move.probability * 100)}%
                  </Badge>
                </div>
                {entry.move.description && (
                  <p className="text-xs text-muted-foreground mt-1 ml-6" data-testid={`move-history-desc-${entry.move.id}`}>{entry.move.description}</p>
                )}
                {entry.move.impact && (
                  <p className="text-xs mt-1 ml-6" data-testid={`move-history-impact-${entry.move.id}`}>
                    <span className="text-muted-foreground font-medium">Impact:</span> {entry.move.impact}
                  </p>
                )}
                {changedStates.length > 0 && (
                  <div className="mt-1 ml-6 space-y-0.5">
                    {changedStates.map(as => {
                      const actor = actorMap.get(as.actorId);
                      return (
                        <div key={as.actorId} className="flex items-center gap-1 text-xs" data-testid={`move-history-state-change-${entry.move.id}-${as.actorId}`}>
                          <Badge variant="outline" className="no-default-hover-elevate text-xs px-1 py-0 leading-tight bg-warning/15 text-warning-foreground border-warning/30">Changed</Badge>
                          <span className="font-medium">{actor?.name || "Unknown"}:</span>
                          <span className="text-muted-foreground">{as.state}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="space-y-4">

        <MoveActorStatesSection
          move={move}
          actors={actors}
          allMoves={allMoves}
          goalId={goalId}
        />

        <Card className="p-3" data-testid="card-analysis">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">Analysis</span>
          <EditableField
            value={move.evaluation}
            onSave={(v) => updateMoveMutation.mutate({ evaluation: v })}
            placeholder="Add analysis notes..."
            multiline
            testId={`edit-analysis-${move.id}`}
          />
        </Card>

        {endConditions.length > 0 && (
          <Card className="p-3" data-testid="card-end-conditions">
            <button
              className="flex items-center gap-1.5 w-full text-left"
              onClick={() => setEndConditionsExpanded(prev => !prev)}
              data-testid={`button-toggle-end-conditions-${move.id}`}
            >
              <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${endConditionsExpanded ? "" : "-rotate-90"}`} />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                End Conditions
              </span>
              {(thisMoveConditionIds.size > 0 || ancestorSatisfiedIds.size > 0 || thisMoveBlockedIds.size > 0) && (
                <Badge variant="secondary" className="no-default-hover-elevate text-xs font-mono px-1 py-0 leading-tight ml-auto">
                  {thisMoveConditionIds.size + ancestorSatisfiedIds.size}/{endConditions.length}
                  {thisMoveBlockedIds.size > 0 && <span className="text-destructive ml-1">·{thisMoveBlockedIds.size} blocked</span>}
                </Badge>
              )}
            </button>
            <div className="mt-2 space-y-1">
              {endConditions.map(ec => {
                const isSatisfiedByThis = thisMoveConditionIds.has(ec.id);
                const isBlockedByThis = thisMoveBlockedIds.has(ec.id);
                const isSatisfiedByAncestor = ancestorSatisfiedIds.has(ec.id);
                const isVisible = endConditionsExpanded || isSatisfiedByThis || isBlockedByThis || isSatisfiedByAncestor;

                if (!isVisible) return null;

                const currentEffect: "satisfies" | "blocks" | "none" = isSatisfiedByThis ? "satisfies" : isBlockedByThis ? "blocks" : "none";

                return (
                  <div
                    key={ec.id}
                    className={`flex items-start gap-2 py-1 px-1 rounded text-xs ${isSatisfiedByAncestor && !isBlockedByThis ? "opacity-60" : ""}`}
                    data-testid={`end-condition-${ec.id}`}
                  >
                    <div className="inline-flex border rounded overflow-hidden shrink-0" role="group">
                      <button
                        type="button"
                        title="No effect"
                        className={`px-1.5 py-0.5 text-xs ${currentEffect === "none" ? "bg-muted text-foreground" : "text-muted-foreground hover-elevate"}`}
                        onClick={() => { if (currentEffect !== "none") setEcEffectMutation.mutate({ endConditionId: ec.id, effect: "none" }); }}
                        data-testid={`button-ec-none-${ec.id}`}
                      >–</button>
                      <button
                        type="button"
                        title="Satisfies this end condition"
                        className={`px-1.5 py-0.5 text-xs border-l ${currentEffect === "satisfies" ? "bg-success/20 text-success-foreground" : "text-muted-foreground hover-elevate"}`}
                        onClick={() => setEcEffectMutation.mutate({ endConditionId: ec.id, effect: currentEffect === "satisfies" ? "none" : "satisfies" })}
                        data-testid={`button-ec-satisfies-${ec.id}`}
                      >✓</button>
                      <button
                        type="button"
                        title="Blocks this end condition"
                        className={`px-1.5 py-0.5 text-xs border-l ${currentEffect === "blocks" ? "bg-destructive/20 text-destructive" : "text-muted-foreground hover-elevate"}`}
                        onClick={() => setEcEffectMutation.mutate({ endConditionId: ec.id, effect: currentEffect === "blocks" ? "none" : "blocks" })}
                        data-testid={`button-ec-blocks-${ec.id}`}
                      >✗</button>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className={isSatisfiedByAncestor && !isBlockedByThis ? "italic text-muted-foreground" : isBlockedByThis ? "text-destructive" : ""}>
                        {ec.description}
                      </span>
                      {isSatisfiedByAncestor && !isBlockedByThis && (
                        <span className="text-xs text-muted-foreground/60 ml-1">(prior move)</span>
                      )}
                      {ec.isRequired && !isSatisfiedByThis && !isSatisfiedByAncestor && !isBlockedByThis && (
                        <span className="text-xs text-destructive ml-1">required</span>
                      )}
                      {isBlockedByThis && ec.isRequired && (
                        <span className="text-xs text-destructive ml-1">disqualifies path</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {!endConditionsExpanded && thisMoveConditionIds.size === 0 && thisMoveBlockedIds.size === 0 && ancestorSatisfiedIds.size === 0 && (
                <p className="text-xs text-muted-foreground py-1">No conditions met yet</p>
              )}
            </div>
          </Card>
        )}

        <Card className="p-3" data-testid="card-states">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">State (Milestone)</span>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Terminates at state (paths converge here)</label>
              <div className="flex items-center gap-1">
                <Select
                  value={move.terminatingStateId || "__none__"}
                  onValueChange={(v) => {
                    if (v === "__create__") {
                      const name = window.prompt("New state name");
                      if (name && name.trim()) {
                        inlineCreateStateMutation.mutate({ name: name.trim(), assignAs: "terminating" });
                      }
                      return;
                    }
                    updateMoveMutation.mutate({ terminatingStateId: v === "__none__" ? null : v });
                  }}
                >
                  <SelectTrigger className="h-7 text-xs flex-1" data-testid="select-terminating-state">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {states.map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                    <SelectItem value="__create__">+ Create new state…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {move.terminatingStateId && childMoves.length > 0 && (
              <p className="text-xs text-warning-foreground">
                This move terminates at a state but has {childMoves.length} child move(s). Add follow-up moves under the state instead — they will start from "{states.find(s => s.id === move.terminatingStateId)?.name}".
              </p>
            )}
          </div>
        </Card>

        <Card className="p-3">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <button
                className="flex items-center gap-1.5 flex-1 text-left"
                onClick={() => setAvailableMovesExpanded(prev => !prev)}
                data-testid={`button-toggle-available-moves-${move.id}`}
              >
                <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${availableMovesExpanded ? "" : "-rotate-90"}`} />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Available Moves ({childMoves.length})
                </span>
              </button>
              {!move.terminatingStateId && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5"
                  onClick={(e) => { e.stopPropagation(); setAddMoveOpen(true); }}
                  data-testid={`button-add-move-${move.id}`}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              )}
            </div>
            {move.terminatingStateId && (
              <p className="text-xs text-muted-foreground italic">
                This move terminates at a state. Add follow-up moves under that state instead.
              </p>
            )}

            {availableMovesExpanded && childMoves.map(child => (
              <ChildMoveCard
                key={child.id}
                move={child}
                actor={child.actorId ? actorMap.get(child.actorId) : undefined}
                definition={child.moveDefinitionId ? defMap.get(child.moveDefinitionId) : undefined}
                onNavigate={onNavigateMove}
                goalId={goalId}
                assumptions={assumptions}
                assumptionLinks={assumptionLinks}
              />
            ))}

            <AddMoveDialog
              open={addMoveOpen}
              onOpenChange={setAddMoveOpen}
              parentMoveId={move.id}
              goalId={goalId}
              actors={actors}
              moveDefinitions={moveDefinitions}
            />
          </div>
        </Card>

        <EvaluateMoveButton moveId={move.id} goalId={goalId} isAnyEvaluating={activeRuns.length > 0} />

        <StrategyLinkedMemories moveId={move.id} goalId={goalId} />
      </div>
    </div>
  );
}

function EvaluateMoveButton({ moveId, goalId, isAnyEvaluating }: { moveId: string; goalId: string; isAnyEvaluating: boolean }) {
  const { toast } = useToast();

  const evaluateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/strategy/move-instances/${moveId}/evaluate`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Evaluation started", description: "The move is being evaluated. Results will appear automatically." });
    },
    onError: (error: Error) => {
      toast({ title: "Evaluation failed", description: error.message, variant: "destructive" });
    },
  });

  const isDisabled = evaluateMutation.isPending || isAnyEvaluating;

  return (
    <Button
      className="w-full gap-2 bg-success hover:bg-success/80 text-white border-success hover:border-success/80"
      onClick={() => evaluateMutation.mutate()}
      disabled={isDisabled}
      data-testid={`button-evaluate-move-${moveId}`}
    >
      {isDisabled ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
      {isDisabled ? "Evaluating..." : "Evaluate"}
    </Button>
  );
}

function MoveActorStatesSection({
  move,
  actors,
  allMoves,
  goalId,
}: {
  move: StrategyMoveInstance;
  actors: StrategyActor[];
  allMoves: StrategyMoveInstance[];
  goalId: string;
}) {
  const { toast } = useToast();
  const currentStates = (move.actorStates || []) as ActorState[];

  const parentMove = useMemo(() => {
    if (!move.parentMoveInstanceId) return null;
    return allMoves.find(m => m.id === move.parentMoveInstanceId) || null;
  }, [move, allMoves]);

  const parentStates = useMemo(() => {
    const m = new Map<string, string>();
    if (!move.parentMoveInstanceId) return m;
    const pathIds = move.path ? move.path.split("/").filter(Boolean) : [];
    for (const ancestorId of pathIds) {
      const ancestor = allMoves.find(am => am.id === ancestorId);
      if (ancestor) {
        for (const ps of (ancestor.actorStates || []) as ActorState[]) {
          if (ps.state && ps.state.trim()) m.set(ps.actorId, ps.state);
        }
      }
    }
    return m;
  }, [move, allMoves]);

  const updateMutation = useMutation({
    mutationFn: async (newStates: ActorState[]) => {
      const res = await apiRequest("PATCH", `/api/strategy/move-instances/${move.id}`, { actorStates: newStates });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update state", description: err.message, variant: "destructive" });
    },
  });

  const getActorState = (actorId: string): string => {
    const found = currentStates.find(s => s.actorId === actorId);
    if (found) return found.state;
    return parentStates.get(actorId) || "";
  };

  const hasExplicitState = (actorId: string): boolean => {
    return currentStates.some(s => s.actorId === actorId);
  };

  const saveActorState = (actorId: string, state: string) => {
    const newStates = [...currentStates.filter(s => s.actorId !== actorId)];
    if (state.trim()) {
      newStates.push({ actorId, state: state.trim() });
    }
    updateMutation.mutate(newStates);
  };

  if (actors.length === 0) return null;

  return (
    <Card className="p-3" data-testid="card-actor-states">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-2">State</span>
      <div className="space-y-2">
        {actors.map(actor => {
          const displayState = getActorState(actor.id);
          const parentState = parentStates.get(actor.id) || "";
          const isExplicit = hasExplicitState(actor.id);
          const isChanged = isExplicit && displayState !== parentState;
          const isInherited = !isExplicit && !!parentState;

          return (
            <div key={actor.id} className="flex items-start gap-2" data-testid={`actor-state-${actor.id}`}>
              <div className="flex items-center gap-1 shrink-0 pt-1 min-w-[100px]">
                <User className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium">{actor.name}</span>
              </div>
              <div className="flex-1 min-w-0">
                <EditableField
                  value={displayState}
                  onSave={(v) => saveActorState(actor.id, v)}
                  placeholder="Describe state..."
                  multiline
                  muted={isInherited}
                  testId={`edit-actor-state-${actor.id}`}
                />
              </div>
              {displayState.trim() && (
                <Badge
                  variant="outline"
                  className={`no-default-hover-elevate text-xs px-1 py-0 leading-tight shrink-0 mt-1 ${
                    isChanged
                      ? "bg-warning/15 text-warning-foreground border-warning/30"
                      : "bg-muted text-muted-foreground border-muted-foreground/20"
                  }`}
                  data-testid={`badge-actor-state-${actor.id}`}
                >
                  {isChanged ? "Changed" : "Unchanged"}
                </Badge>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function StrategyDescriptionPanel({ goalId, strategy }: { goalId: string; strategy: Strategy }) {
  const { toast } = useToast();

  const updateStrategyMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/strategy/goals/${goalId}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId] });
      toast({ title: "Description updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card className="p-4" data-testid="strategy-description-panel">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Description</h3>
      </div>
      <EditableField
        value={strategy.description}
        onSave={(v) => updateStrategyMutation.mutate({ description: v })}
        placeholder="Describe the strategy..."
        multiline
        testId="edit-strategy-description"
      />
    </Card>
  );
}

function ArtifactsPanel({ goalId }: { goalId: string }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: artifacts = [], isLoading } = useQuery<StrategyArtifact[]>({
    queryKey: ["/api/strategy/goals", goalId, "artifacts"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/artifacts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "artifacts"] });
      toast({ title: "Artifact removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const handleUpload = async (file: globalThis.File) => {
    setUploading(true);
    try {
      const urlRes = await apiRequest("POST", "/api/uploads/request-url", {
        name: file.name,
        size: file.size,
        contentType: file.type || "application/octet-stream",
      });
      const { uploadURL, objectPath } = await urlRes.json();

      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload failed (${uploadRes.status})`);
      }

      await apiRequest("POST", `/api/strategy/goals/${goalId}/artifacts`, {
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type || "application/octet-stream",
        objectPath,
      });

      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "artifacts"] });
      toast({ title: "File uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Card className="p-4" data-testid="artifacts-panel">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium" data-testid="text-artifacts-title">Artifacts</h3>
          <span className="text-xs text-muted-foreground">({artifacts.length})</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          data-testid="button-upload-artifact"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
          Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
          data-testid="input-upload-file"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2 py-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : artifacts.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3 text-center" data-testid="text-no-artifacts">
          No artifacts uploaded yet. Upload files related to this strategy.
        </p>
      ) : (
        <div className="space-y-1.5">
          {artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="flex items-center gap-2 py-1.5 px-2 rounded-md border text-xs"
              data-testid={`artifact-${artifact.id}`}
            >
              <FileIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-medium truncate block" data-testid={`artifact-name-${artifact.id}`}>{artifact.fileName}</span>
                <span className="text-muted-foreground">{formatSize(artifact.fileSize)}</span>
              </div>
              <a
                href={`${artifact.objectPath}?name=${encodeURIComponent(artifact.fileName)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0"
                data-testid={`button-download-artifact-${artifact.id}`}
              >
                <Button size="icon" variant="ghost" className="h-6 w-6">
                  <Download className="h-3 w-3" />
                </Button>
              </a>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => deleteMutation.mutate(artifact.id)}
                data-testid={`button-delete-artifact-${artifact.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EditableField({
  value,
  onSave,
  placeholder,
  multiline,
  testId,
  muted,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  testId?: string;
  muted?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(value), [value]);

  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight, 120)}px`;
  }, []);

  useLayoutEffect(() => {
    if (editing && multiline) autoResize();
  }, [editing, multiline, autoResize]);

  if (!editing) {
    return (
      <div
        className="group flex items-start gap-2 cursor-pointer hover:bg-muted/50 transition-colors min-h-[24px]"
        onClick={() => setEditing(true)}
        data-testid={testId}
        ref={displayRef}
      >
        {value ? (
          multiline ? (
            <div className={`text-sm flex-1 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 ${muted ? "text-muted-foreground/70" : ""}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            </div>
          ) : (
            <p className={`text-sm whitespace-pre-wrap flex-1 ${muted ? "text-muted-foreground/70" : ""}`}>{value}</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground italic flex-1">{placeholder || "Click to edit..."}</p>
        )}
        <Pencil className="h-3 w-3 text-muted-foreground invisible group-hover:visible shrink-0 mt-1" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {multiline ? (
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); autoResize(); }}
          autoFocus
          className="min-h-[120px] resize-y"
          data-testid={`${testId}-textarea`}
        />
      ) : (
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          data-testid={`${testId}-input`}
        />
      )}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          onClick={() => { onSave(draft); setEditing(false); }}
          data-testid={`${testId}-save`}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setDraft(value); setEditing(false); }}
          data-testid={`${testId}-cancel`}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ChildMoveCard({
  move,
  actor,
  definition,
  onNavigate,
  goalId,
  assumptions,
  assumptionLinks,
}: {
  move: StrategyMoveInstance;
  actor?: StrategyActor;
  definition?: StrategyMoveDefinition;
  onNavigate: (moveId: string) => void;
  goalId: string;
  assumptions: StrategyAssumption[];
  assumptionLinks: StrategyAssumptionLink[];
}) {
  const { toast } = useToast();
  const baseProb = (move as any).baseProbability ?? move.probability;
  const [localBase, setLocalBase] = useState<number>(baseProb);
  const [linkOpen, setLinkOpen] = useState(false);

  useEffect(() => {
    setLocalBase((move as any).baseProbability ?? move.probability);
  }, [move.id, (move as any).baseProbability, move.probability]);

  const moveLinks = useMemo(
    () => assumptionLinks.filter(l => l.moveInstanceId === move.id),
    [assumptionLinks, move.id]
  );
  const linkedAssumptionIds = useMemo(() => new Set(moveLinks.map(l => l.assumptionId)), [moveLinks]);

  const linkedAssumptions = useMemo(() => {
    return moveLinks
      .map(l => {
        const a = assumptions.find(x => x.id === l.assumptionId);
        return a ? { assumption: a, link: l } : null;
      })
      .filter((x): x is { assumption: StrategyAssumption; link: StrategyAssumptionLink } => !!x);
  }, [moveLinks, assumptions]);

  const unlinkedAssumptions = useMemo(() => {
    return assumptions.filter(a => !linkedAssumptionIds.has(a.id));
  }, [assumptions, linkedAssumptionIds]);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/strategy/move-instances/${move.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      toast({ title: "Move deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete move", description: err.message, variant: "destructive" });
    },
  });

  const updateProbMutation = useMutation({
    mutationFn: async (baseProbability: number) => {
      await apiRequest("PATCH", `/api/strategy/move-instances/${move.id}`, { baseProbability });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update probability", description: err.message, variant: "destructive" });
    },
  });

  const invalidateAfterLinkChange = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "assumption-links"] });
    queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
    queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "optimal-path"] });
  };

  const createLinkMutation = useMutation({
    mutationFn: async ({ assumptionId, polarity }: { assumptionId: string; polarity: "positive" | "negative" }) => {
      await apiRequest("POST", `/api/strategy/assumptions/${assumptionId}/links`, { moveInstanceId: move.id, polarity });
    },
    onSuccess: invalidateAfterLinkChange,
    onError: (err: Error) => {
      toast({ title: "Failed to link assumption", description: err.message, variant: "destructive" });
    },
  });

  const updateLinkMutation = useMutation({
    mutationFn: async ({ linkId, polarity }: { linkId: string; polarity: "positive" | "negative" }) => {
      await apiRequest("PATCH", `/api/strategy/assumption-links/${linkId}`, { polarity });
    },
    onSuccess: invalidateAfterLinkChange,
    onError: (err: Error) => {
      toast({ title: "Failed to toggle polarity", description: err.message, variant: "destructive" });
    },
  });

  const deleteLinkMutation = useMutation({
    mutationFn: async (linkId: string) => {
      await apiRequest("DELETE", `/api/strategy/assumption-links/${linkId}`);
    },
    onSuccess: invalidateAfterLinkChange,
    onError: (err: Error) => {
      toast({ title: "Failed to unlink assumption", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card className="p-3" data-testid={`card-child-move-${move.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onNavigate(move.id)}>
          <div className="flex items-center gap-2 flex-wrap">
            {actor && (
              <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-child-move-actor-${move.id}`}>
                {actor.name}
              </span>
            )}
            <span className="text-sm font-medium hover:underline" data-testid={`text-child-move-title-${move.id}`}>
              {move.title || definition?.title || "Unknown Move"}
            </span>
            {move.source === "simulated" && (
              <Bot className="h-3 w-3 text-muted-foreground/50" />
            )}
          </div>
          {move.description && (
            <p className="text-xs text-muted-foreground mt-1" data-testid={`text-child-move-desc-${move.id}`}>{move.description}</p>
          )}
          {move.impact && (
            <p className="text-xs mt-1" data-testid={`text-child-move-impact-${move.id}`}>
              <span className="text-muted-foreground">Impact:</span> {move.impact}
            </p>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          data-testid={`button-delete-child-move-${move.id}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-muted-foreground shrink-0">Base</span>
        <Slider
          value={[localBase]}
          min={0}
          max={1}
          step={0.05}
          onValueChange={([v]) => setLocalBase(v)}
          onValueCommit={([v]) => updateProbMutation.mutate(v)}
          className="flex-1"
          data-testid={`slider-child-base-prob-${move.id}`}
        />
        <span
          className={`text-xs font-mono w-10 text-right shrink-0 ${probabilityColor(localBase)} px-1 py-0.5 rounded`}
          data-testid={`text-child-base-prob-${move.id}`}
        >
          {Math.round(localBase * 100)}%
        </span>
      </div>
      {moveLinks.length > 0 && (
        <div className="flex items-center gap-2 mt-1 text-xs" onClick={(e) => e.stopPropagation()}>
          <span className="text-muted-foreground shrink-0">Effective</span>
          <span className={`font-mono shrink-0 ${probabilityColor(move.probability)}`} data-testid={`text-child-eff-prob-${move.id}`}>
            {Math.round(move.probability * 100)}%
          </span>
          <span className="text-muted-foreground/60">(after assumptions)</span>
        </div>
      )}
      <div className="mt-2 pt-2 border-t" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-xs text-muted-foreground">Linked Assumptions</span>
          {unlinkedAssumptions.length > 0 && (
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-xs"
                onClick={() => setLinkOpen(!linkOpen)}
                data-testid={`button-link-assumption-${move.id}`}
              >
                <Plus className="h-3 w-3 mr-0.5" />
                Link
              </Button>
              {linkOpen && (
                <div className="absolute right-0 top-6 z-50 bg-popover border rounded-md shadow-md p-1 min-w-[240px] max-h-[240px] overflow-y-auto scrollbar-thin">
                  {unlinkedAssumptions.map(a => (
                    <div key={a.id} className="flex items-center gap-1 px-1 py-0.5">
                      <span className="flex-1 truncate text-xs">{a.title}</span>
                      <span className={`text-xs font-mono ${probabilityColor(a.probability)}`}>
                        {Math.round(a.probability * 100)}%
                      </span>
                      <button
                        className="text-xs px-1.5 py-0.5 rounded border hover-elevate"
                        title="Link as positive (+)"
                        onClick={() => { createLinkMutation.mutate({ assumptionId: a.id, polarity: "positive" }); setLinkOpen(false); }}
                        data-testid={`button-link-assumption-option-pos-${a.id}`}
                      >+</button>
                      <button
                        className="text-xs px-1.5 py-0.5 rounded border hover-elevate"
                        title="Link as negative (−)"
                        onClick={() => { createLinkMutation.mutate({ assumptionId: a.id, polarity: "negative" }); setLinkOpen(false); }}
                        data-testid={`button-link-assumption-option-neg-${a.id}`}
                      >−</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {linkedAssumptions.length > 0 ? (
          <div className="space-y-1">
            {linkedAssumptions.map(({ assumption: a, link }) => (
              <div key={link.id} className="flex items-center gap-2 text-xs group" data-testid={`linked-assumption-${move.id}-${a.id}`}>
                <button
                  className={`text-xs font-mono px-1 py-0.5 rounded border shrink-0 ${link.polarity === "negative" ? "text-error border-error/40" : "text-success border-success/40"}`}
                  title={`Polarity: ${link.polarity}. Click to toggle.`}
                  onClick={() => updateLinkMutation.mutate({ linkId: link.id, polarity: link.polarity === "positive" ? "negative" : "positive" })}
                  data-testid={`button-toggle-polarity-${move.id}-${a.id}`}
                >
                  {link.polarity === "negative" ? "−" : "+"}
                </button>
                <span className="flex-1 truncate text-muted-foreground">{a.title}</span>
                <span className={`text-xs font-mono shrink-0 ${probabilityColor(a.probability)}`}>
                  {Math.round(a.probability * 100)}%
                </span>
                <button
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  onClick={() => deleteLinkMutation.mutate(link.id)}
                  data-testid={`button-unlink-assumption-${move.id}-${a.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/50">No linked assumptions</p>
        )}
      </div>
    </Card>
  );
}

function AddMoveDialog({
  open,
  onOpenChange,
  parentMoveId,
  parentStateId,
  goalId,
  actors,
  moveDefinitions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentMoveId: string | null;
  parentStateId?: string | null;
  goalId: string;
  actors: StrategyActor[];
  moveDefinitions: StrategyMoveDefinition[];
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [actorId, setActorId] = useState("");
  const [selectedDefId, setSelectedDefId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [impact, setImpact] = useState("");
  const [probability, setProbability] = useState(0.5);
  const { toast } = useToast();

  const filteredDefs = useMemo(
    () => actorId ? moveDefinitions.filter(d => d.actorId === actorId) : [],
    [actorId, moveDefinitions]
  );

  const selectedDef = useMemo(
    () => moveDefinitions.find(d => d.id === selectedDefId),
    [selectedDefId, moveDefinitions]
  );

  const createMutation = useMutation({
    mutationFn: async () => {
      let moveDefinitionId: string | null = null;
      let moveTitle = "";
      let moveDescription = "";

      if (mode === "existing" && selectedDef) {
        moveDefinitionId = selectedDef.id;
        moveTitle = selectedDef.title;
        moveDescription = selectedDef.description || "";
      } else {
        const defRes = await apiRequest("POST", `/api/strategy/goals/${goalId}/move-definitions`, {
          actorId,
          title: title.trim(),
          description: description.trim(),
        });
        const def = await defRes.json();
        moveDefinitionId = def.id;
        moveTitle = title.trim();
        moveDescription = description.trim();
      }

      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/move-instances`, {
        parentMoveInstanceId: parentStateId ? null : (parentMoveId || null),
        parentStateId: parentStateId || null,
        title: moveTitle,
        description: moveDescription,
        actorId: actorId || null,
        moveDefinitionId,
        impact: impact.trim(),
        probability,
        status: "unexplored",
        source: "manual",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-tree"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-definitions"] });
      onOpenChange(false);
      resetForm();
      toast({ title: "Move created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create move", description: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setMode("existing");
    setActorId("");
    setSelectedDefId("");
    setTitle("");
    setDescription("");
    setImpact("");
    setProbability(0.5);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleActorChange = (val: string) => {
    setActorId(val);
    setSelectedDefId("");
  };

  const canSubmit = mode === "existing"
    ? !!(actorId && selectedDefId)
    : !!(actorId && title.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto scrollbar-thin" data-testid="dialog-add-move">
        <DialogHeader>
          <DialogTitle data-testid="text-add-move-title">Add Move</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-1 p-0.5 bg-muted rounded-md">
            <button
              type="button"
              className={`flex-1 text-xs py-1.5 px-3 rounded transition-colors ${mode === "existing" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setMode("existing")}
              data-testid="tab-pick-existing"
            >
              Pick Existing
            </button>
            <button
              type="button"
              className={`flex-1 text-xs py-1.5 px-3 rounded transition-colors ${mode === "new" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setMode("new")}
              data-testid="tab-create-new"
            >
              Create New
            </button>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Actor</label>
            <Select value={actorId} onValueChange={handleActorChange}>
              <SelectTrigger data-testid="select-move-actor">
                <SelectValue placeholder="Select actor..." />
              </SelectTrigger>
              <SelectContent>
                {actors.map(a => (
                  <SelectItem key={a.id} value={a.id} data-testid={`option-actor-${a.id}`}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {mode === "existing" ? (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Move Definition</label>
                {!actorId ? (
                  <p className="text-xs text-muted-foreground italic">Select an actor first</p>
                ) : filteredDefs.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No definitions for this actor. Switch to "Create New" to define one.</p>
                ) : (
                  <Select value={selectedDefId} onValueChange={setSelectedDefId}>
                    <SelectTrigger data-testid="select-move-definition">
                      <SelectValue placeholder="Select move definition..." />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredDefs.map(d => (
                        <SelectItem key={d.id} value={d.id} data-testid={`option-def-${d.id}`}>
                          {d.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {selectedDef && (
                <Card className="p-3 bg-muted/50">
                  <p className="text-xs font-medium" data-testid="text-selected-def-title">{selectedDef.title}</p>
                  {selectedDef.description && (
                    <p className="text-xs text-muted-foreground mt-1" data-testid="text-selected-def-desc">{selectedDef.description}</p>
                  )}
                </Card>
              )}
            </>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Title</label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Move title..."
                  data-testid="input-new-move-title"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe this move..."
                  className="min-h-[40px] resize-none"
                  data-testid="input-new-move-description"
                />
              </div>
            </>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Impact</label>
            <Textarea
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              placeholder="Expected impact..."
              className="min-h-[40px] resize-none"
              data-testid="input-move-impact"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Probability: {Math.round(probability * 100)}%
            </label>
            <Slider
              value={[probability]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={([v]) => setProbability(v)}
              data-testid="slider-new-move-prob"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} data-testid="button-cancel-add-move">
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
            data-testid="button-submit-add-move"
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            Add Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PersonSearchResult {
  id: string;
  name: string;
  nicknames: string[];
}

interface PersonDetails {
  trust?: string | null;
  company?: string | null;
  role?: string | null;
  aiSummary?: string | null;
  quickSummary?: string | null;
}

function StrategySettingsPanel({ goalId, strategy }: { goalId: string; strategy: Strategy }) {
  const { toast } = useToast();

  const updateStrategyMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/strategy/goals/${goalId}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId] });
      toast({ title: "Strategy updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });


  return (
    <Card className="p-4" data-testid="settings-panel">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Settings</h3>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Strategy Name</label>
          <EditableField
            value={strategy.title}
            onSave={(v) => updateStrategyMutation.mutate({ title: v })}
            placeholder="Strategy name..."
            testId="edit-strategy-name"
          />
        </div>

      </div>
    </Card>
  );
}

function ActorsPanel({ goalId, actors, moveDefinitions }: { goalId: string; actors: StrategyActor[]; moveDefinitions: StrategyMoveDefinition[] }) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StrategyActor | null>(null);
  const [deleteDefTarget, setDeleteDefTarget] = useState<StrategyMoveDefinition | null>(null);
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const [personSearch, setPersonSearch] = useState("");
  const [addDefForActorId, setAddDefForActorId] = useState<string | null>(null);
  const [defTitle, setDefTitle] = useState("");
  const [defDescription, setDefDescription] = useState("");
  const [editDefId, setEditDefId] = useState<string | null>(null);
  const [editDefTitle, setEditDefTitle] = useState("");
  const [editDefDescription, setEditDefDescription] = useState("");

  const isLoading = false;

  const { data: searchResults } = useQuery<{ people: PersonSearchResult[] }>({
    queryKey: ["/api/people/search", personSearch],
    queryFn: async () => {
      const res = await fetch(`/api/people/search?q=${encodeURIComponent(personSearch)}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: personSearch.length >= 2,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; personId: string }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/actors`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "actors"] });
      resetForm();
      setShowAdd(false);
      toast({ title: "Actor added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add actor", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/actors/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "actors"] });
      setDeleteTarget(null);
      toast({ title: "Actor removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove actor", description: err.message, variant: "destructive" });
    },
  });

  const createDefMutation = useMutation({
    mutationFn: async (data: { actorId: string; title: string; description: string }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/move-definitions`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-definitions"] });
      setAddDefForActorId(null);
      setDefTitle("");
      setDefDescription("");
      toast({ title: "Move definition added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add move", description: err.message, variant: "destructive" });
    },
  });

  const updateDefMutation = useMutation({
    mutationFn: async ({ id, title, description }: { id: string; title: string; description: string }) => {
      const res = await apiRequest("PATCH", `/api/strategy/move-definitions/${id}`, { title, description });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-definitions"] });
      setEditDefId(null);
      setEditDefTitle("");
      setEditDefDescription("");
      toast({ title: "Move definition updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update move", description: err.message, variant: "destructive" });
    },
  });

  const deleteDefMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/move-definitions/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "move-definitions"] });
      setDeleteDefTarget(null);
      toast({ title: "Move definition removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete move", description: err.message, variant: "destructive" });
    },
  });

  const defsByActor = useMemo(() => {
    const m = new Map<string, StrategyMoveDefinition[]>();
    for (const d of moveDefinitions) {
      const arr = m.get(d.actorId) || [];
      arr.push(d);
      m.set(d.actorId, arr);
    }
    return m;
  }, [moveDefinitions]);

  const resetForm = () => {
    setName("");
    setPersonId(null);
    setPersonSearch("");
  };

  const selectPerson = (person: PersonSearchResult) => {
    setPersonId(person.id);
    setName(person.name);
    setPersonSearch("");
  };

  const handleSubmit = () => {
    if (!name.trim() || !personId) return;
    createMutation.mutate({ name: name.trim(), personId });
  };

  return (
    <Card className="p-4" data-testid="actors-panel">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium" data-testid="text-actors-title">Actors</h3>
          <span className="text-xs text-muted-foreground">({actors.length})</span>
        </div>
        {!showAdd && (
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} data-testid="button-add-actor">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Actor
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : actors.length === 0 && !showAdd ? (
        <p className="text-xs text-muted-foreground py-3 text-center" data-testid="text-no-actors">
          No actors yet. Add people involved in this strategy.
        </p>
      ) : (
        <div className="space-y-3">
          {actors.map((actor) => {
            const actorDefs = defsByActor.get(actor.id) || [];
            return (
              <div key={actor.id} className="border rounded-md" data-testid={`actor-section-${actor.id}`}>
                <ActorRow actor={actor} onDelete={() => setDeleteTarget(actor)} goalId={goalId} />
                <div className="px-3 pb-3">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Potential Moves ({actorDefs.length})</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={() => { setAddDefForActorId(actor.id); setDefTitle(""); setDefDescription(""); }}
                      data-testid={`button-add-def-${actor.id}`}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      <span className="text-xs">Add</span>
                    </Button>
                  </div>
                  {actorDefs.length === 0 && addDefForActorId !== actor.id && (
                    <p className="text-xs text-muted-foreground italic">No moves defined yet.</p>
                  )}
                  {actorDefs.map(def => (
                    editDefId === def.id ? (
                      <div key={def.id} className="mt-1 mb-1 space-y-2 border rounded-md p-2" data-testid={`def-edit-form-${def.id}`}>
                        <Input value={editDefTitle} onChange={(e) => setEditDefTitle(e.target.value)} placeholder="Move title..." className="h-8 text-xs" data-testid={`input-edit-def-title-${def.id}`} />
                        <Textarea value={editDefDescription} onChange={(e) => setEditDefDescription(e.target.value)} placeholder="Description..." className="min-h-[30px] resize-none text-xs" data-testid={`input-edit-def-description-${def.id}`} />
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEditDefId(null); setEditDefTitle(""); setEditDefDescription(""); }} data-testid={`button-cancel-edit-def-${def.id}`}>Cancel</Button>
                          <Button size="sm" className="h-7 text-xs" onClick={() => updateDefMutation.mutate({ id: def.id, title: editDefTitle.trim(), description: editDefDescription.trim() })} disabled={!editDefTitle.trim() || updateDefMutation.isPending} data-testid={`button-save-edit-def-${def.id}`}>
                            {updateDefMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div key={def.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md border text-xs mb-1" data-testid={`move-def-${def.id}`}>
                        <div className="flex-1 min-w-0">
                          <span className="font-medium">{def.title}</span>
                          {def.description && <p className="text-muted-foreground mt-0.5 line-clamp-1">{def.description}</p>}
                        </div>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => { setEditDefId(def.id); setEditDefTitle(def.title); setEditDefDescription(def.description || ""); }} data-testid={`button-edit-move-def-${def.id}`}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setDeleteDefTarget(def)} data-testid={`button-delete-move-def-${def.id}`}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )
                  ))}
                  {addDefForActorId === actor.id && (
                    <div className="mt-2 space-y-2 border rounded-md p-2" data-testid={`def-form-${actor.id}`}>
                      <Input value={defTitle} onChange={(e) => setDefTitle(e.target.value)} placeholder="Move title..." className="h-8 text-xs" data-testid="input-def-title" />
                      <Textarea value={defDescription} onChange={(e) => setDefDescription(e.target.value)} placeholder="Description..." className="min-h-[30px] resize-none text-xs" data-testid="input-def-description" />
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddDefForActorId(null)} data-testid="button-cancel-def">Cancel</Button>
                        <Button size="sm" className="h-7 text-xs" onClick={() => createDefMutation.mutate({ actorId: actor.id, title: defTitle.trim(), description: defDescription.trim() })} disabled={!defTitle.trim() || createDefMutation.isPending} data-testid="button-save-def">
                          {createDefMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                          Add
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <div className="mt-3 space-y-3 border rounded-md p-3" data-testid="actor-form">
          <div className="relative">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Person (required)</label>
            <div className="flex items-center gap-2">
              <Input
                value={personSearch}
                onChange={(e) => setPersonSearch(e.target.value)}
                placeholder="Search people..."
                data-testid="input-actor-person-search"
              />
              {personId && (
                <Button size="icon" variant="ghost" onClick={() => { setPersonId(null); setName(""); setPersonSearch(""); }} data-testid="button-clear-person">
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {personId && (
              <p className="text-xs text-success-foreground mt-1">Selected: {name}</p>
            )}
            {personSearch.length >= 2 && searchResults?.people && searchResults.people.length > 0 && !personId && (
              <div className="absolute z-20 top-full mt-1 w-full border rounded-md bg-popover shadow-md max-h-40 overflow-y-auto scrollbar-thin" data-testid="person-search-results">
                {searchResults.people.slice(0, 8).map((person) => (
                  <div
                    key={person.id}
                    className="px-3 py-2 text-sm hover-elevate cursor-pointer"
                    onClick={() => selectPerson(person)}
                    data-testid={`person-result-${person.id}`}
                  >
                    {person.name}
                    {person.nicknames?.length > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">({person.nicknames[0]})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => { setShowAdd(false); resetForm(); }} data-testid="button-cancel-actor">Cancel</Button>
            <Button onClick={handleSubmit} disabled={!name.trim() || !personId || createMutation.isPending} data-testid="button-save-actor">
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Add
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Actor</AlertDialogTitle>
            <AlertDialogDescription>
              Remove "{deleteTarget?.name}" from this strategy? This will also remove their move definitions and instances.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-actor">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-actor"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteDefTarget} onOpenChange={(open) => { if (!open) setDeleteDefTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Move Definition</AlertDialogTitle>
            <AlertDialogDescription>
              Remove "{deleteDefTarget?.title}"? This will not affect existing move instances in the tree.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-def">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteDefTarget && deleteDefMutation.mutate(deleteDefTarget.id)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-def"
            >
              {deleteDefMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ActorRow({ actor, onDelete, goalId }: { actor: StrategyActor; onDelete: () => void; goalId: string }) {
  const { toast } = useToast();
  const [influenceValue, setInfluenceValue] = useState(Math.round((actor.influence ?? 0.5) * 100));
  const { data: personDetails } = useQuery<PersonDetails>({
    queryKey: ["/api/strategy/actors", actor.id, "person-details"],
  });

  useEffect(() => {
    setInfluenceValue(Math.round((actor.influence ?? 0.5) * 100));
  }, [actor.influence]);

  const updateInfluenceMutation = useMutation({
    mutationFn: async (value: number) => {
      const res = await apiRequest("PATCH", `/api/strategy/actors/${actor.id}`, { influence: value / 100 });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "actors"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update influence", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex items-start gap-3 py-2 px-3" data-testid={`actor-row-${actor.id}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium" data-testid={`text-actor-name-${actor.id}`}>{actor.name}</span>
        </div>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {personDetails?.trust && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`text-actor-trust-${actor.id}`}>
              <Shield className="h-2.5 w-2.5" />
              {personDetails.trust}
            </span>
          )}
          {personDetails?.company && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`text-actor-company-${actor.id}`}>
              <Building2 className="h-2.5 w-2.5" />
              {personDetails.company}
            </span>
          )}
        </div>
        {(personDetails?.aiSummary || personDetails?.quickSummary) && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2" data-testid={`text-actor-analysis-${actor.id}`}>
            {personDetails.aiSummary || personDetails.quickSummary}
          </p>
        )}
        <div className="mt-2" data-testid={`actor-influence-${actor.id}`}>
          <span className="text-xs font-medium text-muted-foreground block mb-1" data-testid={`text-actor-influence-${actor.id}`}>
            Influence: {influenceValue}%
          </span>
          <Slider
            min={0}
            max={100}
            step={1}
            value={[influenceValue]}
            onValueChange={(v) => setInfluenceValue(v[0])}
            onValueCommit={(v) => updateInfluenceMutation.mutate(v[0])}
            data-testid={`slider-actor-influence-${actor.id}`}
          />
        </div>
      </div>
      <Button size="icon" variant="ghost" onClick={onDelete} data-testid={`button-delete-actor-${actor.id}`}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ContextPanel({ goalId }: { goalId: string }) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [type, setType] = useState<string>("historical");
  const [content, setContent] = useState("");

  const { data: entries = [], isLoading } = useQuery<StrategyContextEntry[]>({
    queryKey: ["/api/strategy/goals", goalId, "context"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { type: string; content: string }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/context`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "context"] });
      resetForm();
      setShowAdd(false);
      toast({ title: "Context entry added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add context", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<{ type: string; content: string }> }) => {
      const res = await apiRequest("PATCH", `/api/strategy/context/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "context"] });
      setEditingId(null);
      resetForm();
      toast({ title: "Context entry updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update context", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/context/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "context"] });
      toast({ title: "Context entry removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete context", description: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setType("historical");
    setContent("");
  };

  const startEdit = (entry: StrategyContextEntry) => {
    setEditingId(entry.id);
    setType(entry.type);
    setContent(entry.content);
  };

  const handleSubmit = () => {
    if (!content.trim()) return;
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: { type, content: content.trim() } });
    } else {
      createMutation.mutate({ type, content: content.trim() });
    }
  };

  const handleCancel = () => {
    setShowAdd(false);
    setEditingId(null);
    resetForm();
  };

  const contextTypeLabels: Record<string, string> = {
    historical: "Historical",
    current_position: "Current Position",
  };

  const historicalEntries = entries.filter((e) => e.type === "historical");
  const currentEntries = entries.filter((e) => e.type === "current_position");
  const formActive = showAdd || editingId;

  return (
    <Card className="p-4" data-testid="context-panel">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium" data-testid="text-context-title">Context</h3>
          <span className="text-xs text-muted-foreground">({entries.length})</span>
        </div>
        {!formActive && (
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} data-testid="button-add-context">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Context
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : entries.length === 0 && !formActive ? (
        <p className="text-xs text-muted-foreground py-3 text-center" data-testid="text-no-context">
          No context entries yet. Add historical facts or current position details.
        </p>
      ) : (
        <div className="space-y-2">
          {[...historicalEntries, ...currentEntries].map((entry) =>
            editingId === entry.id ? null : (
              <div key={entry.id} className="flex items-start gap-3 py-2 px-3 rounded-md border" data-testid={`context-row-${entry.id}`}>
                <div className="flex-1 min-w-0">
                  <Badge variant="outline" className="text-xs mb-1" data-testid={`badge-context-type-${entry.id}`}>
                    {contextTypeLabels[entry.type] || entry.type}
                  </Badge>
                  <p className="text-xs" data-testid={`text-context-content-${entry.id}`}>{entry.content}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="icon" variant="ghost" onClick={() => startEdit(entry)} data-testid={`button-edit-context-${entry.id}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(entry.id)} data-testid={`button-delete-context-${entry.id}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {formActive && (
        <div className="mt-3 space-y-3 border rounded-md p-3" data-testid="context-form">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger data-testid="select-context-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="historical">Historical Fact</SelectItem>
                <SelectItem value="current_position">Current Position</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Content</label>
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Add context..." className="min-h-[60px] resize-none" data-testid="input-context-content" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-context">Cancel</Button>
            <Button onClick={handleSubmit} disabled={!content.trim() || createMutation.isPending || updateMutation.isPending} data-testid="button-save-context">
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {editingId ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function EndConditionsPanel({ goalId }: { goalId: string }) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [isRequired, setIsRequired] = useState(false);

  const { data: conditions = [], isLoading } = useQuery<StrategyEndCondition[]>({
    queryKey: ["/api/strategy/goals", goalId, "end-conditions"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { description: string; isRequired: boolean }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/end-conditions`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "end-conditions"] });
      resetForm();
      setShowAdd(false);
      toast({ title: "End condition added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add end condition", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<{ description: string; isRequired: boolean; isSatisfied: boolean }> }) => {
      const res = await apiRequest("PATCH", `/api/strategy/end-conditions/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "end-conditions"] });
      setEditingId(null);
      resetForm();
      toast({ title: "End condition updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update end condition", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/end-conditions/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "end-conditions"] });
      toast({ title: "End condition removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete end condition", description: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setDescription("");
    setIsRequired(false);
  };

  const startEdit = (c: StrategyEndCondition) => {
    setEditingId(c.id);
    setDescription(c.description);
    setIsRequired(c.isRequired);
  };

  const handleSubmit = () => {
    if (!description.trim()) return;
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: { description: description.trim(), isRequired } });
    } else {
      createMutation.mutate({ description: description.trim(), isRequired });
    }
  };

  const handleCancel = () => {
    setShowAdd(false);
    setEditingId(null);
    resetForm();
  };

  const toggleSatisfied = (c: StrategyEndCondition) => {
    updateMutation.mutate({ id: c.id, data: { isSatisfied: !c.isSatisfied } });
  };

  const formActive = showAdd || editingId;

  return (
    <Card className="p-4" data-testid="end-conditions-panel">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium" data-testid="text-conditions-title">Goals</h3>
          <span className="text-xs text-muted-foreground">({conditions.length})</span>
        </div>
        {!formActive && (
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} data-testid="button-add-condition">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Goal
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : conditions.length === 0 && !formActive ? (
        <p className="text-xs text-muted-foreground py-3 text-center" data-testid="text-no-conditions">
          No goals defined. Add conditions that define success or completion.
        </p>
      ) : (
        <div className="space-y-1.5">
          {conditions.map((c) =>
            editingId === c.id ? null : (
              <div key={c.id} className="flex items-center gap-3 py-2 px-3 rounded-md border" data-testid={`condition-row-${c.id}`}>
                <Checkbox
                  checked={c.isSatisfied}
                  onCheckedChange={() => toggleSatisfied(c)}
                  data-testid={`checkbox-satisfied-${c.id}`}
                />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs ${c.isSatisfied ? "line-through text-muted-foreground" : ""}`} data-testid={`text-condition-desc-${c.id}`}>
                    {c.description}
                  </p>
                </div>
                <Badge variant={c.isRequired ? "default" : "outline"} className="text-xs shrink-0" data-testid={`badge-condition-type-${c.id}`}>
                  {c.isRequired ? "Required" : "Optional"}
                </Badge>
                <div className="flex gap-1 shrink-0">
                  <Button size="icon" variant="ghost" onClick={() => startEdit(c)} data-testid={`button-edit-condition-${c.id}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(c.id)} data-testid={`button-delete-condition-${c.id}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {formActive && (
        <div className="mt-3 space-y-3 border rounded-md p-3" data-testid="condition-form">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs to be true for this strategy to succeed?" className="min-h-[60px] resize-none" data-testid="input-condition-description" />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="is-required" checked={isRequired} onCheckedChange={(checked) => setIsRequired(checked === true)} data-testid="checkbox-condition-required" />
            <label htmlFor="is-required" className="text-xs">Required condition</label>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-condition">Cancel</Button>
            <Button onClick={handleSubmit} disabled={!description.trim() || createMutation.isPending || updateMutation.isPending} data-testid="button-save-condition">
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {editingId ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function AssumptionProbSlider({
  assumption,
  onCommit,
}: {
  assumption: StrategyAssumption;
  onCommit: (probability: number) => void;
}) {
  const [local, setLocal] = useState(assumption.probability);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setLocal(assumption.probability);
  }, [assumption.probability]);

  const probColor = (p: number) => {
    if (p >= 0.7) return "text-success-foreground";
    if (p >= 0.3) return "text-warning-foreground";
    return "text-error-foreground";
  };

  return (
    <div className="mt-2 flex items-center gap-3">
      <Slider
        value={[local]}
        min={0}
        max={1}
        step={0.05}
        onValueChange={(vals) => {
          dragging.current = true;
          setLocal(vals[0]);
        }}
        onValueCommit={(vals) => {
          dragging.current = false;
          setLocal(vals[0]);
          onCommit(vals[0]);
        }}
        className="flex-1"
        data-testid={`slider-assumption-prob-${assumption.id}`}
      />
      <span
        className={`text-xs font-mono font-semibold w-9 text-right shrink-0 ${probColor(local)}`}
        data-testid={`text-assumption-slider-prob-${assumption.id}`}
      >
        {Math.round(local * 100)}%
      </span>
    </div>
  );
}

function AssumptionsPanel({ goalId }: { goalId: string }) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [probability, setProbability] = useState(0.5);

  const { data: assumptions = [], isLoading } = useQuery<StrategyAssumption[]>({
    queryKey: ["/api/strategy/goals", goalId, "assumptions"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { title: string; description: string; probability: number }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/assumptions`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "assumptions"] });
      resetForm();
      setShowAdd(false);
      toast({ title: "Assumption added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add assumption", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<{ title: string; description: string; probability: number }> }) => {
      const res = await apiRequest("PATCH", `/api/strategy/assumptions/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "assumptions"] });
      setEditingId(null);
      resetForm();
      toast({ title: "Assumption updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update assumption", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/assumptions/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "assumptions"] });
      toast({ title: "Assumption removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete assumption", description: err.message, variant: "destructive" });
    },
  });

  const updateProbabilityMutation = useMutation({
    mutationFn: async ({ id, probability: prob }: { id: string; probability: number }) => {
      const res = await apiRequest("PATCH", `/api/strategy/assumptions/${id}`, { probability: prob });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "assumptions"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update probability", description: err.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setProbability(0.5);
  };

  const startEdit = (a: StrategyAssumption) => {
    setEditingId(a.id);
    setTitle(a.title);
    setDescription(a.description);
    setProbability(a.probability);
  };

  const handleSubmit = () => {
    if (!title.trim()) return;
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: { title: title.trim(), description: description.trim(), probability } });
    } else {
      createMutation.mutate({ title: title.trim(), description: description.trim(), probability });
    }
  };

  const handleCancel = () => {
    setShowAdd(false);
    setEditingId(null);
    resetForm();
  };

  const probColor = (p: number) => {
    if (p >= 0.7) return "text-success-foreground";
    if (p >= 0.3) return "text-warning-foreground";
    return "text-error-foreground";
  };

  const formActive = showAdd || editingId;

  return (
    <Card className="p-2" data-testid="assumptions-panel">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground" data-testid="text-assumptions-count">({assumptions.length})</span>
        </div>
        {!formActive && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setShowAdd(true)} data-testid="button-add-assumption">
            <Plus className="h-3 w-3 mr-1" />
            Add Assumption
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : assumptions.length === 0 && !formActive ? (
        <p className="text-xs text-muted-foreground py-2 text-center" data-testid="text-no-assumptions">
          No assumptions defined. Add key assumptions that affect strategic outcomes.
        </p>
      ) : (
        <div className="space-y-1.5">
          {assumptions.map((a) =>
            editingId === a.id ? null : (
              <div key={a.id} className="py-1.5 px-2 rounded-md border" data-testid={`assumption-row-${a.id}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-medium" data-testid={`text-assumption-title-${a.id}`}>{a.title}</span>
                      <span className={`text-xs font-mono font-semibold ${probColor(a.probability)}`} data-testid={`text-assumption-prob-${a.id}`}>
                        {Math.round(a.probability * 100)}%
                      </span>
                    </div>
                    {a.description && (
                      <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-assumption-desc-${a.id}`}>{a.description}</p>
                    )}
                  </div>
                  <div className="flex gap-0.5 shrink-0">
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEdit(a)} data-testid={`button-edit-assumption-${a.id}`}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => deleteMutation.mutate(a.id)} data-testid={`button-delete-assumption-${a.id}`}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <AssumptionProbSlider
                  assumption={a}
                  onCommit={(prob) => updateProbabilityMutation.mutate({ id: a.id, probability: prob })}
                />
                <div className="mt-0.5 text-xs text-muted-foreground/70">
                  Drag to adjust — releases will recompute affected moves.
                </div>
              </div>
            )
          )}
        </div>
      )}

      {formActive && (
        <div className="mt-2 space-y-2 border rounded-md p-2" data-testid="assumption-form">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-0.5 block">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Competitor won't lower prices" className="h-7 text-xs" data-testid="input-assumption-title" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-0.5 block">Description</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Why do we believe this? What evidence supports it?" className="min-h-[50px] resize-none text-xs" data-testid="input-assumption-description" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-0.5 block">
              Probability: <span className={`font-mono font-semibold ${probColor(probability)}`}>{Math.round(probability * 100)}%</span>
            </label>
            <Slider
              value={[probability]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(vals) => setProbability(vals[0])}
              data-testid="slider-new-assumption-prob"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleCancel} data-testid="button-cancel-assumption">Cancel</Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleSubmit} disabled={!title.trim() || createMutation.isPending || updateMutation.isPending} data-testid="button-save-assumption">
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              {editingId ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}


function StatesPanel({
  goalId,
  states,
  allMoves,
  onOpenState,
}: {
  goalId: string;
  states: StrategyState[];
  allMoves: StrategyMoveInstance[];
  onOpenState: (id: string) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${goalId}/states`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "states"] });
      setName("");
      setDescription("");
      toast({ title: "State created" });
    },
    onError: (err: Error) => toast({ title: "Create failed", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<StrategyState> }) => {
      const res = await apiRequest("PATCH", `/api/strategy/states/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "states"] });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/strategy/states/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals", goalId, "states"] });
      toast({ title: "State deleted" });
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  const refCounts = useMemo(() => {
    const counts = new Map<string, { terminating: number; child: number }>();
    for (const s of states) counts.set(s.id, { terminating: 0, child: 0 });
    for (const m of allMoves) {
      if (m.terminatingStateId && counts.has(m.terminatingStateId)) counts.get(m.terminatingStateId)!.terminating += 1;
      if (m.parentStateId && counts.has(m.parentStateId)) counts.get(m.parentStateId)!.child += 1;
    }
    return counts;
  }, [states, allMoves]);

  return (
    <>
      <Card className="p-4" data-testid="card-create-state">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Flag className="h-4 w-4" /> Create State (Milestone)
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          A state represents a shared point that multiple move paths can converge on, and from which multiple move paths can branch out. Use states for things like "Funding secured" or "Product launched".
        </p>
        <div className="space-y-2">
          <Input
            placeholder="State name (e.g. 'Funding secured')"
            value={name}
            onChange={e => setName(e.target.value)}
            data-testid="input-state-name"
          />
          <Textarea
            placeholder="Optional description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            data-testid="input-state-description"
          />
          <Button
            size="sm"
            onClick={() => name.trim() && createMutation.mutate({ name: name.trim(), description: description.trim() })}
            disabled={!name.trim() || createMutation.isPending}
            data-testid="button-create-state"
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Create State
          </Button>
        </div>
      </Card>

      <Card className="p-4" data-testid="card-state-list">
        <h3 className="text-sm font-semibold mb-3">States ({states.length})</h3>
        {states.length === 0 ? (
          <p className="text-xs text-muted-foreground">No states defined yet.</p>
        ) : (
          <div className="space-y-2">
            {states.map(state => {
              const refs = refCounts.get(state.id) || { terminating: 0, child: 0 };
              const totalRefs = refs.terminating + refs.child;
              return (
                <div key={state.id} className="border rounded p-2 space-y-1" data-testid={`state-row-${state.id}`}>
                  <div className="flex items-center gap-2">
                    <Flag className="h-3.5 w-3.5 text-muted-foreground" />
                    <EditableField
                      value={state.name}
                      onSave={(v) => updateMutation.mutate({ id: state.id, updates: { name: v } })}
                      placeholder="State name"
                      testId={`edit-state-name-${state.id}`}
                    />
                    <Badge variant="secondary" className="no-default-hover-elevate text-xs font-mono px-1 py-0">
                      {refs.terminating} ending · {refs.child} starting
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-6 text-xs"
                      onClick={() => onOpenState(state.id)}
                      data-testid={`button-open-state-${state.id}`}
                    >
                      Open
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-destructive"
                      onClick={() => {
                        if (totalRefs > 0) {
                          toast({ title: "Cannot delete", description: `${totalRefs} move(s) reference this state. Unlink them first.`, variant: "destructive" });
                          return;
                        }
                        deleteMutation.mutate(state.id);
                      }}
                      data-testid={`button-delete-state-${state.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <EditableField
                    value={state.description || ""}
                    onSave={(v) => updateMutation.mutate({ id: state.id, updates: { description: v } })}
                    placeholder="Add description..."
                    multiline
                    testId={`edit-state-description-${state.id}`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
