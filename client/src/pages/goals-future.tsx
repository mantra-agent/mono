import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import type { Goal, GoalIndexEntry, GoalHorizon, GoalStatus, CreateGoalInput } from "@shared/schema";
import { HORIZON_LABELS, HORIZON_ORDER, goalHorizons, goalStatuses } from "@shared/schema";
import { ReactFlow, Background, Panel, MarkerType, useReactFlow, ReactFlowProvider, type Node, type Edge, type NodeProps, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus, Loader2, Target, X, ChevronRight, User, Search, ZoomIn, ZoomOut, Maximize2, Tag, Pencil, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { UniversalTagPicker } from "@/components/universal-tag-picker";
import { usePageHeader } from "@/hooks/use-page-header";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { useMentionAutocomplete } from "@/hooks/use-mention-autocomplete";
import { MentionPopover } from "@/components/mention-popover";

type GoalWithDescription = GoalIndexEntry & { description?: string };

const HORIZON_COLORS: Record<GoalHorizon, string> = {
  today: "#ef4444",
  this_week: "#f43f5e",
  this_month: "#f59e0b",
  this_quarter: "#f97316",
  this_year: "#22c55e",
  three_year: "#3b82f6",
  ten_year: "#8b5cf6",
  lifetime: "#ec4899",
};

const STATUS_CONFIG: Record<GoalStatus, { label: string; color: string; dotClass: string }> = {
  active: { label: "Active", color: "bg-info/10 text-info-foreground dark:bg-info/10/30 dark:text-info", dotClass: "bg-info" },
  on_track: { label: "On Track", color: "bg-success/10 text-success-foreground dark:bg-success/30 dark:text-success", dotClass: "bg-success" },
  at_risk: { label: "At Risk", color: "bg-warning/10 text-warning-foreground dark:bg-warning/10/30 dark:text-warning", dotClass: "bg-warning" },
  achieved: { label: "Achieved", color: "bg-success/10 text-success-foreground", dotClass: "bg-success" },
  blocked: { label: "Blocked", color: "bg-error/10 text-error-foreground dark:bg-error/30 dark:text-error", dotClass: "bg-error" },
  dormant: { label: "Dormant", color: "bg-neutral/10 text-neutral-foreground", dotClass: "bg-neutral" },
};

const STATUS_LABELS: Record<GoalStatus, string> = Object.fromEntries(goalStatuses.map(s => [s, STATUS_CONFIG[s].label])) as Record<GoalStatus, string>;

function GoalStatusBadge({ status, size = "default" }: { status: GoalStatus; size?: "default" | "sm" }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.active;
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  const textSize = size === "sm" ? "text-xs" : "text-xs";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${textSize} ${cfg.color}`} data-testid={`badge-status-${status}`}>
      {status === "achieved" ? (
        <Check className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      ) : (
        <span className={`${dotSize} rounded-full ${cfg.dotClass}`} />
      )}
      {cfg.label}
    </span>
  );
}

function GoalNode({ data }: NodeProps) {
  const goal = data.goal as GoalWithDescription;
  const isHighlighted = data.isHighlighted as boolean;
  const isDimmed = data.isDimmed as boolean;
  const onNodeClick = data.onNodeClick as (id: string) => void;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodeClick(goal.id);
  };

  const firstTag = (goal.tags || [])[0];
  const descriptionText = goal.description
    ? goal.description.length > 200
      ? goal.description.slice(0, 200) + "…"
      : goal.description
    : "No description";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="relative cursor-pointer transition-all duration-200"
          style={{
            opacity: isDimmed ? 0.3 : 1,
            width: 200,
          }}
          onClick={handleClick}
          data-testid={`goal-node-${goal.id}`}
        >
          <Handle
            id="left"
            type="target"
            position={Position.Left}
            className="goal-handle !w-2.5 !h-2.5 !bg-muted-foreground/40 !border-2 !border-transparent hover:!bg-primary hover:!w-3 hover:!h-3 transition-all"
          />
          <div
            className="rounded-md bg-card p-3"
            style={{
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "hsl(var(--border))",
              borderLeftWidth: 3,
              borderLeftColor: HORIZON_COLORS[goal.horizon] || HORIZON_COLORS.today,
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <InlineReferenceText text={goal.shortName} className="text-xs font-medium truncate" />
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="inline-flex items-center bg-cat-event/15 text-cat-event-foreground border border-cat-event/30 rounded-sm text-xs font-medium px-2 py-0.5">
                {HORIZON_LABELS[goal.horizon]}
              </span>
              <GoalStatusBadge status={goal.status || "active"} size="sm" />
              {firstTag && (
                <Badge variant="outline" className="text-xs">
                  {firstTag}
                </Badge>
              )}
            </div>
          </div>
          <Handle
            id="right"
            type="source"
            position={Position.Right}
            className="goal-handle !w-2.5 !h-2.5 !bg-muted-foreground/40 !border-2 !border-transparent hover:!bg-primary hover:!w-3 hover:!h-3 transition-all"
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[250px] text-xs" data-testid={`tooltip-goal-${goal.id}`}>
        <p>{descriptionText}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function NewGoalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const [goalFields, setGoalFields] = useState<Partial<CreateGoalInput & { selectedParentId: string | null }>>({});
  const [parentSearch, setParentSearch] = useState("");
  const [showParentDropdown, setShowParentDropdown] = useState(false);

  const { data: goalsData } = useQuery<{ goals: GoalIndexEntry[] }>({
    queryKey: ["/api/life-goals"],
  });
  const existingGoals = useMemo(() => {
    const list = goalsData?.goals;
    return Array.isArray(list) ? list : [];
  }, [goalsData]);

  const createMutation = useMutation({
    mutationFn: async (goal: CreateGoalInput) => {
      const res = await apiRequest("POST", "/api/life-goals", goal);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      toast({ title: "Goal created", description: "Your new goal has been added to the map." });
      handleClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create goal", description: err.message, variant: "destructive" });
    },
  });

  const handleClose = () => {
    setGoalFields({});
    setParentSearch("");
    setShowParentDropdown(false);
    onOpenChange(false);
  };

  const handleCreate = () => {
    const missing: string[] = [];
    if (!goalFields.shortName) missing.push("Name");
    if (!goalFields.description) missing.push("Description");
    if (!goalFields.horizon) missing.push("Horizon");
    if (missing.length > 0) {
      toast({ title: "Missing fields", description: `Please fill in: ${missing.join(", ")}`, variant: "destructive" });
      return;
    }
    createMutation.mutate({
      shortName: goalFields.shortName!,
      description: goalFields.description!,
      rawInput: "",
      horizon: goalFields.horizon as GoalHorizon,
      parentId: goalFields.selectedParentId || null,
      owner: "me",
      tags: goalFields.tags || [],
    } as any);
  };

  const selectedParentGoal = existingGoals.find(g => g.id === goalFields.selectedParentId);

  const availableParents = useMemo(() => {
    const filtered = existingGoals;
    if (!parentSearch.trim()) return filtered;
    const q = parentSearch.toLowerCase();
    return filtered.filter(g => g.shortName.toLowerCase().includes(q));
  }, [existingGoals, parentSearch]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            New Goal
          </DialogTitle>
          <DialogDescription className="sr-only">Create a new goal</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="goal-name">Name</Label>
            <Input
              id="goal-name"
              value={goalFields.shortName || ""}
              onChange={(e) => setGoalFields(prev => ({ ...prev, shortName: e.target.value }))}
              placeholder="e.g. Learn Spanish"
              className="mt-1"
              data-testid="input-goal-name"
            />
          </div>
          <div>
            <Label htmlFor="goal-desc">Description</Label>
            <Textarea
              id="goal-desc"
              value={goalFields.description || ""}
              onChange={(e) => setGoalFields(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Describe what you want to achieve"
              rows={3}
              className="mt-1 resize-none"
              data-testid="input-goal-description"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Horizon</Label>
              <Select
                value={goalFields.horizon || ""}
                onValueChange={(v) => setGoalFields(prev => ({ ...prev, horizon: v as GoalHorizon }))}
              >
                <SelectTrigger className="mt-1" data-testid="select-horizon">
                  <SelectValue placeholder="Select horizon" />
                </SelectTrigger>
                <SelectContent>
                  {goalHorizons.map(h => (
                    <SelectItem key={h} value={h}>{HORIZON_LABELS[h]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label className="flex items-center gap-1.5 mb-1.5">
              <Tag className="h-3.5 w-3.5" />
              Tags
            </Label>
            <UniversalTagPicker
              tags={goalFields.tags || []}
              onChange={(newTags) => setGoalFields(prev => ({ ...prev, tags: newTags }))}
              placeholder="Add tag..."
              data-testid="picker-goal-tags"
            />
          </div>

          {existingGoals.length > 0 && (
            <div>
              <Label>Parent Goal</Label>
              {selectedParentGoal ? (
                <div className="flex items-center gap-2 mt-1">
                  <span className="inline-flex items-center flex-1 justify-start bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="badge-selected-parent">
                    <InlineReferenceText text={selectedParentGoal.shortName} className="truncate" />
                  </span>
                  <button
                    className="text-xs text-muted-foreground hover:underline shrink-0"
                    onClick={() => { setGoalFields(prev => ({ ...prev, selectedParentId: null })); setParentSearch(""); setShowParentDropdown(false); }}
                    data-testid="button-clear-parent"
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <div className="mt-1 space-y-1">
                  <Input
                    value={parentSearch}
                    onChange={(e) => { setParentSearch(e.target.value); setShowParentDropdown(true); }}
                    onFocus={() => setShowParentDropdown(true)}
                    placeholder="Search parent goal..."
                    className="h-8 text-sm"
                    data-testid="input-parent-search"
                  />
                  {showParentDropdown && availableParents.length > 0 && (
                    <div className="border rounded-md max-h-36 overflow-y-auto space-y-0.5 p-1" data-testid="parent-dropdown">
                      {availableParents.map(g => (
                        <div
                          key={g.id}
                          className="flex items-center gap-2 text-sm rounded-md p-1.5 cursor-pointer hover-elevate"
                          onClick={() => { setGoalFields(prev => ({ ...prev, selectedParentId: g.id })); setParentSearch(""); setShowParentDropdown(false); }}
                          data-testid={`parent-option-${g.id}`}
                        >
                          <InlineReferenceText text={g.shortName} className="flex-1 truncate" />
                          <span className="inline-flex items-center bg-cat-event/15 text-cat-event-foreground border border-cat-event/30 rounded-sm text-xs font-medium px-2 py-0.5">{HORIZON_LABELS[g.horizon]}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              data-testid="button-create-goal"
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create Goal
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GoalDetailPanel({
  goalId,
  goals,
  open,
  onOpenChange,
}: {
  goalId: string;
  goals: GoalWithDescription[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleCursor, setTitleCursor] = useState(0);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [parentSearch, setParentSearch] = useState("");

  const mention = useMentionAutocomplete({
    value: titleDraft,
    cursorPosition: titleCursor,
    onChange: (newValue, newCursor) => {
      setTitleDraft(newValue);
      setTitleCursor(newCursor);
      requestAnimationFrame(() => {
        titleInputRef.current?.setSelectionRange(newCursor, newCursor);
      });
    },
  });

  useEffect(() => {
    setShowParentPicker(false);
    setParentSearch("");
    setEditingTitle(false);
  }, [goalId]);

  const { data: fullGoal, isLoading } = useQuery<Goal>({
    queryKey: ["/api/life-goals", goalId],
    enabled: open && !!goalId,
  });

  const goal = fullGoal || goals.find(g => g.id === goalId);

  const handleTitleSave = async () => {
    if (mention.trigger) return;
    if (!titleDraft.trim()) return;
    try {
      await apiRequest("PATCH", `/api/life-goals/${goalId}`, { shortName: titleDraft.trim() });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      setEditingTitle(false);
    } catch (err: any) {
      toast({ title: "Failed to rename", description: err.message, variant: "destructive" });
    }
  };

  const handleHorizonChange = async (newHorizon: GoalHorizon) => {
    try {
      await apiRequest("PATCH", `/api/life-goals/${goalId}`, { horizon: newHorizon });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
    } catch (err: any) {
      toast({ title: "Failed to update horizon", description: err.message, variant: "destructive" });
    }
  };

  const handleStatusChange = async (newStatus: GoalStatus) => {
    try {
      await apiRequest("PATCH", `/api/life-goals/${goalId}`, { status: newStatus });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
    } catch (err: any) {
      toast({ title: "Failed to update status", description: err.message, variant: "destructive" });
    }
  };

  const handleSetParent = async (newParentId: string) => {
    try {
      if (goal && goal.parentId && goal.parentId !== newParentId) {
        await apiRequest("POST", `/api/life-goals/${goalId}/unlink-parent`, {});
      }
      await apiRequest("POST", `/api/life-goals/${goalId}/set-parent`, { parentId: newParentId });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      setShowParentPicker(false);
      setParentSearch("");
      toast({ title: "Parent goal updated" });
    } catch (err: any) {
      toast({ title: "Failed to set parent", description: err.message, variant: "destructive" });
    }
  };

  const handleUnlinkParent = async () => {
    try {
      await apiRequest("POST", `/api/life-goals/${goalId}/unlink-parent`, {});
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals", goalId] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      toast({ title: "Parent unlinked" });
    } catch (err: any) {
      toast({ title: "Failed to unlink parent", description: err.message, variant: "destructive" });
    }
  };

  if (!goal) return null;

  const parentGoal = goal.parentId ? goals.find(g => g.id === goal.parentId) : null;
  const availableParents = goals.filter(g => {
    if (g.id === goalId) return false;
    if (parentSearch.trim()) {
      const q = parentSearch.toLowerCase();
      return g.shortName.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-detail-name">
            {editingTitle ? (
              <div className="flex items-center gap-1">
                <div className="relative flex-1">
                  <Input
                    ref={titleInputRef}
                    value={titleDraft}
                    onChange={(e) => {
                      setTitleDraft(e.target.value);
                      const pos = e.target.selectionStart ?? e.target.value.length;
                      setTitleCursor(pos);
                      mention.handleInputChange(e.target.value, pos);
                    }}
                    onKeyDown={(e) => {
                      if (mention.handleKeyDown(e)) return;
                      if (e.key === "Enter") handleTitleSave();
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                    autoFocus
                    data-testid="input-edit-title"
                  />
                  <MentionPopover
                    trigger={mention.trigger}
                    suggestions={mention.suggestions}
                    isLoading={mention.isLoading}
                    activeIndex={mention.activeIndex}
                    onSelect={mention.insertSuggestion}
                    onHover={mention.setActiveIndex}
                    testIdSuffix="-future-title"
                  />
                </div>
                <Button size="icon" variant="ghost" onClick={handleTitleSave} data-testid="button-save-title">
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setEditingTitle(false)} data-testid="button-cancel-title">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <span
                className="group cursor-pointer hover:bg-muted/50 transition-colors inline-flex items-center gap-2"
                onClick={() => { setTitleDraft(goal.shortName); setTitleCursor(goal.shortName.length); setEditingTitle(true); }}
                data-testid="button-edit-title"
              >
                <InlineReferenceText text={goal.shortName} />
                <Pencil className="h-3.5 w-3.5 text-muted-foreground invisible group-hover:visible shrink-0" />
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {HORIZON_LABELS[goal.horizon]}
            {(goal.tags || []).length > 0 && ` \u00b7 ${goal.tags.join(", ")}`}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              <Select value={goal.horizon || ""} onValueChange={(v) => handleHorizonChange(v as GoalHorizon)}>
                <SelectTrigger className="w-[130px] h-7 text-xs" data-testid="select-detail-horizon">
                  <SelectValue placeholder="Set horizon" />
                </SelectTrigger>
                <SelectContent>
                  {goalHorizons.map(h => (
                    <SelectItem key={h} value={h}>{HORIZON_LABELS[h]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={goal.status || "active"} onValueChange={(v) => handleStatusChange(v as GoalStatus)}>
                <SelectTrigger className="w-[130px] h-7 text-xs" data-testid="select-detail-status">
                  <SelectValue placeholder="Set status" />
                </SelectTrigger>
                <SelectContent>
                  {goalStatuses.map(s => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(goal.tags || []).map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
              ))}
            </div>

            <div className="space-y-2 text-sm">
              {goal.owner && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <User className="h-3.5 w-3.5" />
                  <span>{goal.owner}</span>
                </div>
              )}
            </div>

            {fullGoal?.description && (
              <p className="text-sm">{fullGoal.description}</p>
            )}

            <div>
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                Parent Goal
                {!showParentPicker && (
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={() => setShowParentPicker(true)}
                    data-testid="button-edit-parent"
                  >
                    {parentGoal ? "Change" : "Set"}
                  </button>
                )}
              </span>
              {parentGoal ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <Badge
                    variant="secondary"
                    className="text-xs cursor-pointer"
                    onClick={() => { onOpenChange(false); navigate(`/goals/${parentGoal.id}`); }}
                    data-testid="badge-parent-goal"
                  >
                    <InlineReferenceText text={parentGoal.shortName} className="truncate" />
                  </Badge>
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    onClick={handleUnlinkParent}
                    data-testid="button-unlink-parent"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : !showParentPicker ? (
                <p className="text-xs text-muted-foreground mt-0.5">None (root goal)</p>
              ) : null}
              {showParentPicker && (
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-1">
                    <Input
                      value={parentSearch}
                      onChange={(e) => setParentSearch(e.target.value)}
                      placeholder="Search goals..."
                      className="h-7 text-xs flex-1"
                      autoFocus
                      data-testid="input-summary-parent-search"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() => { setShowParentPicker(false); setParentSearch(""); }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="border rounded-md max-h-32 overflow-y-auto space-y-0.5 p-1" data-testid="summary-parent-dropdown">
                    {availableParents.length === 0 && (
                      <p className="text-xs text-muted-foreground py-2 text-center">No matching goals.</p>
                    )}
                    {availableParents.map(g => (
                      <div
                        key={g.id}
                        className="flex items-center gap-2 text-xs rounded-md p-1.5 cursor-pointer hover-elevate"
                        onClick={() => handleSetParent(g.id)}
                        data-testid={`summary-parent-option-${g.id}`}
                      >
                        <InlineReferenceText text={g.shortName} className="flex-1 truncate" />
                        <span className="inline-flex items-center bg-cat-event/15 text-cat-event-foreground border border-cat-event/30 rounded-sm text-xs font-medium px-2 py-0.5">{HORIZON_LABELS[g.horizon]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { onOpenChange(false); navigate(`/goals/${goalId}`); }}
                data-testid="button-open-details"
              >
                <ChevronRight className="h-3.5 w-3.5" />
                Full Details
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function getAncestorIds(goalId: string, goals: GoalWithDescription[]): Set<string> {
  const result = new Set<string>();
  const goalMap = new Map(goals.map(g => [g.id, g]));

  function walk(id: string) {
    const g = goalMap.get(id);
    if (!g) return;
    if (g.parentId && !result.has(g.parentId)) {
      result.add(g.parentId);
      walk(g.parentId);
    }
  }

  walk(goalId);
  return result;
}

const HORIZON_COLUMNS: GoalHorizon[] = ["today", "this_week", "this_month", "this_quarter", "this_year", "three_year", "ten_year", "lifetime"];

function autoLayout(goals: GoalWithDescription[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (goals.length === 0) return positions;

  const goalMap = new Map(goals.map(g => [g.id, g]));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();

  for (const g of goals) {
    children.set(g.id, []);
    parents.set(g.id, []);
  }

  for (const g of goals) {
    if (g.parentId && goalMap.has(g.parentId)) {
      children.get(g.parentId)!.push(g.id);
      parents.get(g.id)!.push(g.parentId);
    }
  }

  const horizonGroups = new Map<GoalHorizon, GoalWithDescription[]>();
  for (const h of HORIZON_COLUMNS) horizonGroups.set(h, []);
  for (const g of goals) {
    const list = horizonGroups.get(g.horizon) || [];
    list.push(g);
    horizonGroups.set(g.horizon, list);
  }

  const layers: string[][] = [];

  for (const h of HORIZON_COLUMNS) {
    const group = horizonGroups.get(h) || [];
    if (group.length === 0) continue;

    const groupIds = new Set(group.map(g => g.id));
    const intraParents = new Map<string, string[]>();
    const intraChildren = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const g of group) {
      intraParents.set(g.id, []);
      intraChildren.set(g.id, []);
      inDegree.set(g.id, 0);
    }

    for (const g of group) {
      if (g.parentId && groupIds.has(g.parentId)) {
        intraParents.get(g.id)!.push(g.parentId);
        intraChildren.get(g.parentId)!.push(g.id);
        inDegree.set(g.id, (inDegree.get(g.id) || 0) + 1);
      }
    }

    const subLayerOf = new Map<string, number>();
    const visited = new Set<string>();

    function assignSubLayer(id: string): number {
      if (subLayerOf.has(id)) return subLayerOf.get(id)!;
      if (visited.has(id)) return 0;
      visited.add(id);
      let maxParent = -1;
      for (const p of (intraParents.get(id) || [])) {
        maxParent = Math.max(maxParent, assignSubLayer(p));
      }
      const layer = maxParent + 1;
      subLayerOf.set(id, layer);
      return layer;
    }

    for (const g of group) assignSubLayer(g.id);

    const maxSub = Math.max(...Array.from(subLayerOf.values()), 0);
    const subLayers: string[][] = Array.from({ length: maxSub + 1 }, () => []);
    for (const g of group) {
      const original = subLayerOf.get(g.id) || 0;
      subLayers[maxSub - original].push(g.id);
    }

    for (const sl of subLayers) {
      layers.push(sl);
    }
  }

  function buildPosMap(layer: string[]): Map<string, number> {
    const m = new Map<string, number>();
    for (let i = 0; i < layer.length; i++) m.set(layer[i], i);
    return m;
  }

  function countCrossings(layer1: string[], layer2: string[]): number {
    const posMap = buildPosMap(layer1);
    const edges: [number, number][] = [];
    for (let i = 0; i < layer2.length; i++) {
      for (const p of (parents.get(layer2[i]) || [])) {
        const j = posMap.get(p);
        if (j !== undefined) edges.push([j, i]);
      }
    }
    let crossings = 0;
    for (let a = 0; a < edges.length; a++) {
      for (let b = a + 1; b < edges.length; b++) {
        if ((edges[a][0] - edges[b][0]) * (edges[a][1] - edges[b][1]) < 0) crossings++;
      }
    }
    return crossings;
  }

  function barycenterSort(freeLayerIdx: number): string[] {
    const freeLayer = layers[freeLayerIdx];
    const barycenters = new Map<string, number>();
    for (let idx = 0; idx < freeLayer.length; idx++) {
      const node = freeLayer[idx];
      const allConnected = [...(parents.get(node) || []), ...(children.get(node) || [])];
      let sum = 0, count = 0;
      for (const other of allConnected) {
        for (let li = 0; li < layers.length; li++) {
          if (li === freeLayerIdx) continue;
          const posMap = buildPosMap(layers[li]);
          const pos = posMap.get(other);
          if (pos !== undefined) { sum += pos; count++; }
        }
      }
      barycenters.set(node, count > 0 ? sum / count : idx);
    }
    return [...freeLayer].sort((a, b) => (barycenters.get(a) || 0) - (barycenters.get(b) || 0));
  }

  const MAX_ITERATIONS = 24;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let improved = false;
    const order = iter % 2 === 0
      ? Array.from({ length: layers.length }, (_, i) => i)
      : Array.from({ length: layers.length }, (_, i) => layers.length - 1 - i);

    for (const i of order) {
      if (layers[i].length <= 1) continue;
      const sorted = barycenterSort(i);

      let beforeTotal = 0, afterTotal = 0;
      if (i > 0) {
        beforeTotal += countCrossings(layers[i - 1], layers[i]);
        afterTotal += countCrossings(layers[i - 1], sorted);
      }
      if (i < layers.length - 1) {
        beforeTotal += countCrossings(layers[i], layers[i + 1]);
        afterTotal += countCrossings(sorted, layers[i + 1]);
      }
      if (afterTotal < beforeTotal) { layers[i] = sorted; improved = true; }
      else if (afterTotal === beforeTotal) layers[i] = sorted;
    }
    if (!improved && iter > 1) break;
  }

  const colSpacing = 280;
  const rowSpacing = 120;

  const nodeRow = new Map<string, number>();
  const occupiedRows = new Map<number, Set<string>>();

  function claimRow(nodeId: string, row: number) {
    nodeRow.set(nodeId, row);
    if (!occupiedRows.has(row)) occupiedRows.set(row, new Set());
    occupiedRows.get(row)!.add(nodeId);
  }

  function findNearestFreeRow(targetRow: number, colNodes: Set<string>): number {
    for (let offset = 0; offset < 200; offset++) {
      const up = targetRow - offset;
      const down = targetRow + offset;
      if (offset === 0) {
        const occupants = occupiedRows.get(targetRow);
        if (!occupants || ![...occupants].some(n => colNodes.has(n))) return targetRow;
      } else {
        const upOccupants = occupiedRows.get(up);
        if (!upOccupants || ![...upOccupants].some(n => colNodes.has(n))) return up;
        const downOccupants = occupiedRows.get(down);
        if (!downOccupants || ![...downOccupants].some(n => colNodes.has(n))) return down;
      }
    }
    return targetRow + 200;
  }

  for (let col = 0; col < layers.length; col++) {
    const layer = layers[col];
    if (layer.length === 0) continue;
    const colNodeSet = new Set(layer);

    const nodesWithTarget: { id: string; targetRow: number; hasConnection: boolean }[] = [];

    for (const nodeId of layer) {
      const allConnected = [...(parents.get(nodeId) || []), ...(children.get(nodeId) || [])];
      const connectedRows: number[] = [];
      for (const c of allConnected) {
        const r = nodeRow.get(c);
        if (r !== undefined) connectedRows.push(r);
      }

      if (connectedRows.length > 0) {
        const avg = connectedRows.reduce((a, b) => a + b, 0) / connectedRows.length;
        nodesWithTarget.push({ id: nodeId, targetRow: Math.round(avg), hasConnection: true });
      } else {
        nodesWithTarget.push({ id: nodeId, targetRow: -1, hasConnection: false });
      }
    }

    const connected = nodesWithTarget.filter(n => n.hasConnection);
    const unconnected = nodesWithTarget.filter(n => !n.hasConnection);

    connected.sort((a, b) => a.targetRow - b.targetRow);
    for (const node of connected) {
      const row = findNearestFreeRow(node.targetRow, colNodeSet);
      claimRow(node.id, row);
    }

    const usedRows = connected.map(n => nodeRow.get(n.id)!);
    let nextFreeRow = usedRows.length > 0 ? Math.max(...usedRows) + 1 : 0;

    for (const node of unconnected) {
      const row = findNearestFreeRow(nextFreeRow, colNodeSet);
      claimRow(node.id, row);
      nextFreeRow = row + 1;
    }
  }

  for (let col = 0; col < layers.length; col++) {
    for (const nodeId of layers[col]) {
      const row = nodeRow.get(nodeId) || 0;
      positions.set(nodeId, {
        x: 40 + col * colSpacing,
        y: 40 + row * rowSpacing,
      });
    }
  }

  return positions;
}

function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div className="flex items-center gap-1 bg-card border border-card-border rounded-md p-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => zoomIn()}
        data-testid="button-zoom-in"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => zoomOut()}
        data-testid="button-zoom-out"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => fitView({ padding: 0.2, duration: 300 })}
        data-testid="button-fit-view"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function FutureGoalsCanvas({ inFullscreenModal = false }: { inFullscreenModal?: boolean } = {}) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [highlightedGoalId, setHighlightedGoalId] = useState<string | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const { data, isLoading } = useQuery<{ goals: GoalWithDescription[] }>({
    queryKey: ["/api/life-goals/graph"],
  });

  const allGoals = data?.goals || [];

  const filteredGoals = useMemo(() => {
    return allGoals.filter(g => {
      if (searchQuery && !g.shortName.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [allGoals, searchQuery]);

  const filteredIds = useMemo(() => new Set(filteredGoals.map(g => g.id)), [filteredGoals]);

  const ancestorIds = useMemo(() => {
    if (!highlightedGoalId) return new Set<string>();
    return getAncestorIds(highlightedGoalId, allGoals);
  }, [highlightedGoalId, allGoals]);

  const highlightedSet = useMemo(() => {
    if (!highlightedGoalId) return null;
    const s = new Set(ancestorIds);
    s.add(highlightedGoalId);
    return s;
  }, [highlightedGoalId, ancestorIds]);

  const setParentMutation = useMutation({
    mutationFn: async ({ goalId, parentId }: { goalId: string; parentId: string }) => {
      await apiRequest("POST", `/api/life-goals/${goalId}/set-parent`, { parentId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
      queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
      toast({ title: "Parent set" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to set parent", description: err.message, variant: "destructive" });
    },
  });

  const onNodeClickRef = useRef((id: string) => {});
  onNodeClickRef.current = (id: string) => {
    setSelectedGoalId(id);
    setDetailOpen(true);
    setHighlightedGoalId(prev => prev === id ? null : id);
  };
  const stableNodeClick = useCallback((id: string) => onNodeClickRef.current(id), []);

  const handleConnect = useCallback((params: { source: string | null; target: string | null }) => {
    if (!params.source || !params.target || params.source === params.target) return;
    setParentMutation.mutate({ goalId: params.source, parentId: params.target });
  }, [setParentMutation]);

  const positions = useMemo(() => autoLayout(filteredGoals), [filteredGoals]);

  const dragPositions = useRef<Map<string, { x: number; y: number }>>(new Map());

  const nodes = useMemo(() => {
    return filteredGoals.map(goal => {
      const dragPos = dragPositions.current.get(goal.id);
      const autoPos = positions.get(goal.id) || { x: 0, y: 0 };
      const pos = dragPos || autoPos;
      const isDimmed = highlightedSet !== null && !highlightedSet.has(goal.id);
      const isHighlighted = highlightedSet !== null && highlightedSet.has(goal.id);
      return {
        id: goal.id,
        type: "goalNode" as const,
        position: pos,
        data: { goal, isHighlighted, isDimmed, onNodeClick: stableNodeClick },
      };
    });
  }, [filteredGoals, highlightedSet, stableNodeClick, positions]);

  const goalHorizonMap = useMemo(() => {
    const m = new Map<string, GoalHorizon>();
    for (const g of filteredGoals) m.set(g.id, g.horizon);
    return m;
  }, [filteredGoals]);

  const edges = useMemo(() => {
    const builtEdges: Edge[] = [];
    for (const goal of filteredGoals) {
      if (goal.parentId && filteredIds.has(goal.parentId)) {
        const edgeDimmed = highlightedSet !== null && !(highlightedSet.has(goal.id) && highlightedSet.has(goal.parentId));
        const parentHorizon = goalHorizonMap.get(goal.parentId);
        const goalHorizonOrder = HORIZON_ORDER[goal.horizon] ?? 0;
        const parentHorizonOrder = parentHorizon ? (HORIZON_ORDER[parentHorizon] ?? 0) : 0;
        const isTemporalAnomaly = parentHorizonOrder < goalHorizonOrder;

        builtEdges.push({
          id: `parent:${goal.id}->${goal.parentId}`,
          source: goal.id,
          target: goal.parentId,
          sourceHandle: "right",
          targetHandle: "left",
          type: "straight",
          style: {
            stroke: isTemporalAnomaly ? "#ef4444" : "hsl(var(--muted-foreground))",
            strokeWidth: 2,
            opacity: edgeDimmed ? 0.15 : (isTemporalAnomaly ? 0.9 : 0.75),
          },
          label: isTemporalAnomaly ? "⚠" : undefined,
          labelStyle: isTemporalAnomaly ? { fontSize: 14, fill: "#ef4444", fontWeight: 700 } : undefined,
          labelBgStyle: isTemporalAnomaly ? { fill: "hsl(var(--background))", fillOpacity: 0.9 } : undefined,
          labelBgPadding: isTemporalAnomaly ? [4, 4] as [number, number] : undefined,
          labelBgBorderRadius: isTemporalAnomaly ? 4 : undefined,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isTemporalAnomaly ? "#ef4444" : "hsl(var(--muted-foreground))",
            width: 16,
            height: 12,
          },
        });
      }
    }
    return builtEdges;
  }, [filteredGoals, filteredIds, highlightedSet, goalHorizonMap]);

  const onNodesChange = useCallback((changes: any[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        dragPositions.current.set(change.id, { x: change.position.x, y: change.position.y });
      }
    }
  }, []);

  const nodeTypes = useMemo(() => ({ goalNode: GoalNode }), []);

  const handlePaneClick = useCallback(() => {
    setHighlightedGoalId(null);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (allGoals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Target className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-base font-semibold" data-testid="text-empty-heading">Your goal map starts here</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Define your aspirations and watch them connect into a living roadmap. Start by creating your first goal.
          </p>
        </div>
        <Button onClick={() => setNewGoalOpen(true)} data-testid="button-create-first-goal">
          <Plus className="h-4 w-4" />
          Create Your First Goal
        </Button>
        <NewGoalDialog open={newGoalOpen} onOpenChange={setNewGoalOpen} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-3 border-b flex-wrap">
        <div className="relative flex-1 min-w-[140px] max-w-[240px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search goals..."
            className="pl-8"
            data-testid="input-search-goals"
          />
        </div>
        <Button onClick={() => setNewGoalOpen(true)} data-testid="button-new-goal">
          <Plus className="h-4 w-4" />
          New Goal
        </Button>
        {!inFullscreenModal && (
          <Button
            variant="outline"
            onClick={() => setFullscreenOpen(true)}
            data-testid="button-goals-fullscreen"
          >
            <Maximize2 className="h-4 w-4" />
            Full screen
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={handleConnect}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          onPaneClick={handlePaneClick}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={true}
          nodesConnectable={true}
          connectionLineStyle={{ stroke: "hsl(var(--primary))", strokeWidth: 1.5 }}
        >
          <Background gap={20} size={1} />
          <Panel position="bottom-left">
            <CanvasControls />
          </Panel>
          <Panel position="top-right">
            <div className="bg-card border rounded-md p-2 shadow-sm space-y-2" data-testid="legend-horizon">
              <div>
                <span className="text-xs font-medium text-muted-foreground block mb-1">Horizon</span>
                {(Object.entries(HORIZON_COLORS) as [GoalHorizon, string][]).map(([h, color]) => (
                  <div key={h} className="flex items-center gap-1.5 py-0.5">
                    <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-xs">{HORIZON_LABELS[h]}</span>
                  </div>
                ))}
              </div>
              <div>
                <span className="text-xs font-medium text-muted-foreground block mb-1">Edges</span>
                <div className="flex items-center gap-1.5 py-0.5">
                  <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="hsl(var(--muted-foreground))" strokeWidth="2"/></svg>
                  <span className="text-xs">Parent</span>
                </div>
              </div>
            </div>
          </Panel>
        </ReactFlow>
      </div>

      <NewGoalDialog open={newGoalOpen} onOpenChange={setNewGoalOpen} />
      {selectedGoalId && (
        <GoalDetailPanel
          goalId={selectedGoalId}
          goals={allGoals}
          open={detailOpen}
          onOpenChange={setDetailOpen}
        />
      )}

      {!inFullscreenModal && (
        <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
          <DialogContent className="h-screen max-h-screen w-screen max-w-none gap-0 overflow-hidden border-0 p-0 sm:rounded-none">
            <DialogHeader className="sr-only">
              <DialogTitle>Lifetime Goals full screen</DialogTitle>
            </DialogHeader>
            <FutureGoalsView inFullscreenModal />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export default function FutureGoalsView({ inFullscreenModal = false }: { inFullscreenModal?: boolean } = {}) {
  usePageHeader({ title: "Vision", skip: inFullscreenModal });
  return (
    <ReactFlowProvider>
      <TooltipProvider delayDuration={300}>
        <FutureGoalsCanvas inFullscreenModal={inFullscreenModal} />
      </TooltipProvider>
    </ReactFlowProvider>
  );
}
