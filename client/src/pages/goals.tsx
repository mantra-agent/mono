// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useMemo, useRef, useCallback } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import {
  Target,
  Loader2,
  ChevronRight,
  MoreHorizontal,
  Search,
  Plus,
  X,
  Check,
} from "lucide-react";
import { useMentionAutocomplete } from "@/hooks/use-mention-autocomplete";
import { MentionPopover } from "@/components/mention-popover";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import type { GoalHorizon, GoalStatus } from "@shared/schema";
import { HORIZON_LABELS, goalHorizons } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const log = createLogger("Goals");

const LONG_TERM_HORIZONS = new Set<GoalHorizon>(["this_year", "three_year", "ten_year", "lifetime"]);

const GOALS_PAGE_SECTIONS: GoalSection[] = goalHorizons.map((horizon) => ({
  id: horizon,
  title: HORIZON_LABELS[horizon],
  items: [],
  empty: `No ${HORIZON_LABELS[horizon].toLowerCase()} goals yet.`,
  createHorizon: horizon,
}));

// ── Types ──────────────────────────────────────────────────────────

interface GoalRow {
  id: string;
  shortName: string;
  horizon: GoalHorizon;
  parentId: string | null;
  status?: GoalStatus;
  targetDate?: string | null;
  completedAt?: string | null;
}

interface GoalSection {
  id: string;
  title: string;
  items: GoalRow[];
  empty: string;
  createHorizon?: GoalHorizon;
}

interface GoalTreeSectionProps {
  section: GoalSection;
  allGoals: GoalRow[];
  selectedGoalId: string | null;
  setSelectedGoalId: (id: string | null) => void;
  creatingInHorizon: GoalHorizon | null;
  onCreateGoal: (name: string) => void;
  onCancelCreate: () => void;
  onStartCreating: (horizon: GoalHorizon) => void;
}

interface GoalTreeRowProps {
  goal: GoalRow;
  allGoals: GoalRow[];
  depth: number;
  selectedGoalId: string | null;
  setSelectedGoalId: (id: string | null) => void;
}

interface GoalRowMenuProps {
  goal: GoalRow;
  onStartRename: () => void;
}

interface InlineNewGoalInputProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

// ── Shared Helpers ─────────────────────────────────────────────────

/** Invalidate both the goal list and graph caches. */
function invalidateGoalQueries() {
  queryClient.invalidateQueries({ queryKey: ["/api/life-goals"] });
  queryClient.invalidateQueries({ queryKey: ["/api/life-goals/graph"] });
}

/**
 * Focus a temporary hidden input in the current tap/click event chain.
 * Mobile browsers (especially iOS Safari) require `.focus()` within the
 * original user gesture to open the software keyboard. The real input
 * steals focus from this temporary element on mount, keeping the keyboard open.
 */
function focusWithMobileKeyboard(): void {
  const tmp = document.createElement("input");
  tmp.className = "sr-only";
  document.body.appendChild(tmp);
  tmp.focus();
  requestAnimationFrame(() => {
    try { document.body.removeChild(tmp); } catch (_) { /* already removed */ }
  });
}

// ── Hooks ──────────────────────────────────────────────────────────

/** Encapsulates inline rename state, mutation, keyboard handling, and mention autocomplete for a goal row. */
function useGoalRename(goal: GoalRow) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(goal.shortName);
  const [renameCursor, setRenameCursor] = useState(0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const renameMutation = useMutation({
    mutationFn: async (newName: string) =>
      apiRequest("PATCH", `/api/life-goals/${goal.id}`, { shortName: newName }),
    onSuccess: () => invalidateGoalQueries(),
    onError: () => toast({ title: "Failed to rename goal", variant: "destructive" }),
  });

  const mention = useMentionAutocomplete({
    value: renameValue,
    cursorPosition: renameCursor,
    onChange: (newValue, newCursor) => {
      setRenameValue(newValue);
      setRenameCursor(newCursor);
      requestAnimationFrame(() => {
        renameInputRef.current?.setSelectionRange(newCursor, newCursor);
      });
    },
  });

  const startRename = useCallback(() => {
    setRenameValue(goal.shortName);
    setRenameCursor(goal.shortName.length);
    setIsRenaming(true);
    requestAnimationFrame(() => {
      const input = renameInputRef.current;
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }, [goal.shortName]);

  const submitRename = useCallback(() => {
    if (mention.trigger) return; // don't submit while popover is active
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== goal.shortName) {
      renameMutation.mutate(trimmed);
    }
    setIsRenaming(false);
  }, [renameValue, goal.shortName, renameMutation, mention.trigger]);

  const cancelRename = useCallback(() => {
    setRenameValue(goal.shortName);
    setIsRenaming(false);
  }, [goal.shortName]);

  return {
    isRenaming,
    renameValue,
    setRenameValue,
    setRenameCursor,
    renameInputRef,
    startRename,
    submitRename,
    cancelRename,
    mention,
  };
}

// ── Components ─────────────────────────────────────────────────────

export default function Goals() {
  usePageHeader({ title: "Goals" });
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden scrollbar-thin">
      <UnifiedGoalsView />
    </div>
  );
}

function UnifiedGoalsView() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [creatingInHorizon, setCreatingInHorizon] = useState<GoalHorizon | null>(null);
  const { data: goalsData, isLoading, isError } = useQuery<{ goals: GoalRow[] }>({
    queryKey: ["/api/life-goals"],
  });

  const allGoals = goalsData?.goals ?? [];

  const createGoalMutation = useMutation({
    mutationFn: async ({ horizon, shortName }: { horizon: GoalHorizon; shortName: string }) =>
      apiRequest("POST", "/api/life-goals", {
        shortName,
        description: shortName,
        rawInput: "",
        horizon,
        tags: [],
        status: "active",
      }),
    onSuccess: async (res) => {
      const goal = await res.json();
      if (goal?.id) {
        // Replace the temp goal with the real server-assigned one
        queryClient.setQueryData<{ goals: GoalRow[] }>(["/api/life-goals"], (current) => ({
          goals: current?.goals
            ?.filter((g) => !g.id.startsWith("temp-"))
            .concat(current.goals.some((g) => g.id === goal.id) ? [] : [goal])
            ?? [goal],
        }));
        setSelectedGoalId(goal.id);
      }
      invalidateGoalQueries();
    },
    onError: () => {
      // Roll back optimistic insert
      queryClient.setQueryData<{ goals: GoalRow[] }>(["/api/life-goals"], (current) => ({
        goals: current?.goals?.filter((g) => !g.id.startsWith("temp-")) ?? [],
      }));
      invalidateGoalQueries();
    },
  });

  /** Create goal with optimistic insert so the row appears before the server responds. */
  const handleCreateGoal = useCallback((name: string) => {
    if (!creatingInHorizon) return;
    const tempGoal: GoalRow = {
      id: `temp-${Date.now()}`,
      shortName: name,
      horizon: creatingInHorizon,
      parentId: null,
      status: "active",
    };
    queryClient.setQueryData<{ goals: GoalRow[] }>(["/api/life-goals"], (current) => ({
      goals: [tempGoal, ...(current?.goals ?? [])],
    }));
    createGoalMutation.mutate({ horizon: creatingInHorizon, shortName: name });
    setCreatingInHorizon(null);
  }, [creatingInHorizon, createGoalMutation]);

  const startCreating = useCallback((horizon: GoalHorizon) => {
    focusWithMobileKeyboard();
    setCreatingInHorizon(horizon);
  }, []);

  const sections = useMemo<GoalSection[]>(() =>
    GOALS_PAGE_SECTIONS.map((section) => ({
      ...section,
      items: section.id === "lifetime"
        ? allGoals.filter((goal) => LONG_TERM_HORIZONS.has(goal.horizon))
        : allGoals.filter((goal) => goal.horizon === section.id),
    })),
  [allGoals]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredSections = useMemo<GoalSection[]>(() => {
    if (!normalizedSearch) return sections;
    return sections.map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        item.shortName.toLowerCase().includes(normalizedSearch),
      ),
    }));
  }, [normalizedSearch, sections]);

  const visibleSections = normalizedSearch
    ? filteredSections.filter((s) => s.items.length > 0)
    : filteredSections;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="goals-loading">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4">
        <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="goals-error">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <Target className="h-5 w-5 text-destructive" />
          </div>
          <p className="text-sm font-medium">Failed to load goals</p>
          <p className="text-xs text-muted-foreground">Something went wrong. Please try again later.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-hidden bg-background p-2" data-testid="unified-goals-tree">
      <div className="relative mb-1 min-w-0">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search goals"
          className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="input-search-goals"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            data-testid="button-clear-goals-search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => startCreating("today")}
        disabled={creatingInHorizon !== null}
        className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="button-new-goal"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Goal</span>
      </button>
      {visibleSections.map((section) => (
        <GoalTreeSection
          key={section.id}
          section={section}
          allGoals={allGoals}
          selectedGoalId={selectedGoalId}
          setSelectedGoalId={setSelectedGoalId}
          creatingInHorizon={creatingInHorizon}
          onCreateGoal={handleCreateGoal}
          onCancelCreate={() => setCreatingInHorizon(null)}
          onStartCreating={startCreating}
        />
      ))}
    </div>
  );
}

function GoalTreeSection({
  section,
  allGoals,
  selectedGoalId,
  setSelectedGoalId,
  creatingInHorizon,
  onCreateGoal,
  onCancelCreate,
  onStartCreating,
}: GoalTreeSectionProps) {
  const [open, setOpen] = useState(true);
  const sectionGoals = section.items;
  const rootGoals = useMemo(() => {
    const ids = new Set(sectionGoals.map((g) => g.id));
    const roots = sectionGoals.filter((g) => !g.parentId || !ids.has(g.parentId));
    return roots.sort((a, b) => {
      const aComplete = a.status === "achieved" ? 1 : 0;
      const bComplete = b.status === "achieved" ? 1 : 0;
      return aComplete - bComplete;
    });
  }, [sectionGoals]);

  return (
    <div className="min-w-0 max-w-full" data-testid={`goals-section-${section.id}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
        data-testid={`goals-section-header-${section.id}`}
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="truncate">{section.title}</span>
        <span className="ml-auto text-[10px] font-normal text-muted-foreground/60">{sectionGoals.length || ""}</span>
      </button>
      {open && (
        <div className="pb-2">
          {section.createHorizon && creatingInHorizon === section.createHorizon && (
            <InlineNewGoalInput onSubmit={onCreateGoal} onCancel={onCancelCreate} />
          )}
          {sectionGoals.length === 0 && (!section.createHorizon || creatingInHorizon !== section.createHorizon) ? (
            <div className="ml-5 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground" data-testid={`goals-section-empty-${section.id}`}>
              <span>{section.empty}</span>
              <button
                type="button"
                onClick={() => section.createHorizon && onStartCreating(section.createHorizon)}
                className="rounded px-1.5 py-0.5 text-xs text-cta transition-colors hover:bg-accent/70"
              >
                + Add
              </button>
            </div>
          ) : (
            rootGoals.map((goal) => (
              <GoalTreeRow
                key={goal.id}
                goal={goal}
                allGoals={sectionGoals}
                depth={0}
                selectedGoalId={selectedGoalId}
                setSelectedGoalId={setSelectedGoalId}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline text input for naming a new goal before creation.
 * Enter submits; Escape or blur cancels. Single submit path (Enter only)
 * eliminates the Enter+blur double-fire race structurally.
 */
/**
 * Inline text input for naming a new goal before creation.
 * onBlur is the single submit/cancel path — works for Enter, tap-outside,
 * and mobile keyboard dismiss alike. Enter just blurs (delegating to onBlur).
 * Escape clears the value first so onBlur sees empty and cancels.
 */
function InlineNewGoalInput({ onSubmit, onCancel }: InlineNewGoalInputProps) {
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const mention = useMentionAutocomplete({
    value,
    cursorPosition: cursorPos,
    onChange: (newValue, newCursor) => {
      setValue(newValue);
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(newCursor, newCursor);
      });
    },
  });

  // Stable ref callback: focuses the input exactly once on mount,
  // stealing focus from the temporary mobile-keyboard input.
  const mountRef = useCallback((el: HTMLInputElement | null) => {
    if (el) el.focus();
    (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
  }, []);

  const handleBlur = useCallback(() => {
    // Don't submit/cancel if the popover is active (user is selecting)
    if (mention.trigger) return;
    const trimmed = inputRef.current?.value.trim() ?? "";
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  }, [onSubmit, onCancel, mention.trigger]);

  return (
    <div className="relative ml-5 flex items-center gap-2 rounded-md px-2 py-1.5">
      <span className="shrink-0">
        <SimpleCheckCircle checked={false} interactive={false} />
      </span>
      <div className="relative min-w-0 flex-1">
        <input
          ref={mountRef}
          className="w-full bg-transparent border-b border-primary outline-none text-sm"
          placeholder="Goal name..."
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            const pos = e.target.selectionStart ?? e.target.value.length;
            setCursorPos(pos);
            mention.handleInputChange(e.target.value, pos);
          }}
          onKeyDown={(e) => {
            if (mention.handleKeyDown(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur(); // delegate to onBlur
            } else if (e.key === "Escape") {
              e.preventDefault();
              setValue(""); // clear so onBlur sees empty → cancel
              e.currentTarget.blur();
            }
          }}
          onBlur={handleBlur}
          data-testid="input-new-goal-inline"
        />
        <MentionPopover
          trigger={mention.trigger}
          suggestions={mention.suggestions}
          isLoading={mention.isLoading}
          activeIndex={mention.activeIndex}
          onSelect={mention.insertSuggestion}
          onHover={mention.setActiveIndex}
          testIdSuffix="-new-goal"
        />
      </div>
    </div>
  );
}

function GoalRowMenu({ goal, onStartRename }: GoalRowMenuProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const updateHorizonMutation = useMutation({
    mutationFn: async (newHorizon: GoalHorizon) =>
      apiRequest("PATCH", `/api/life-goals/${goal.id}`, { horizon: newHorizon }),
    onSuccess: () => { invalidateGoalQueries(); toast({ title: "Horizon updated" }); },
    onError: () => toast({ title: "Failed to update horizon", variant: "destructive" }),
  });

  const updateStatusMutation = useMutation({
    mutationFn: async (newStatus: GoalStatus) =>
      apiRequest("PATCH", `/api/life-goals/${goal.id}`, { status: newStatus }),
    onSuccess: () => { invalidateGoalQueries(); toast({ title: "Status updated" }); },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/life-goals/${goal.id}`),
    onSuccess: () => { invalidateGoalQueries(); toast({ title: "Goal deleted" }); },
    onError: () => toast({ title: "Failed to delete goal", variant: "destructive" }),
  });

  return (
    <DropdownMenu modal={false} onOpenChange={(open) => { if (!open) setDeleteConfirm(false); }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Goal actions"
          data-testid="goal-row-menu"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => setLocation(`/goals/${goal.id}`)}>Details</DropdownMenuItem>
        <DropdownMenuItem onClick={(e) => { e.preventDefault(); onStartRename(); }}>Rename</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Horizon</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {goalHorizons.map((h) => (
              <DropdownMenuItem
                key={h}
                onClick={() => updateHorizonMutation.mutate(h)}
                disabled={goal.horizon === h}
              >
                <span className="flex items-center gap-2">
                  {goal.horizon === h && <Check className="h-3 w-3" />}
                  <span className={goal.horizon === h ? "font-medium" : ""}>{HORIZON_LABELS[h]}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {(["active", "on_track", "at_risk", "achieved", "blocked", "dormant"] as const).map((st) => (
              <DropdownMenuItem
                key={st}
                onClick={() => updateStatusMutation.mutate(st)}
                disabled={goal.status === st}
              >
                <span className="flex items-center gap-2">
                  {goal.status === st && <Check className="h-3 w-3" />}
                  <span className={`capitalize ${goal.status === st ? "font-medium" : ""}`}>{st.replace(/_/g, " ")}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {deleteConfirm ? (
          <DropdownMenuItem
            onClick={() => deleteMutation.mutate()}
            className="text-destructive focus:text-destructive font-medium"
          >
            Confirm delete
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={(e) => { e.preventDefault(); setDeleteConfirm(true); }}
            className="text-destructive focus:text-destructive"
          >
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GoalTreeRow({ goal, allGoals, depth, selectedGoalId, setSelectedGoalId }: GoalTreeRowProps) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(true);
  const {
    isRenaming, renameValue, setRenameValue, setRenameCursor, renameInputRef,
    startRename, submitRename, cancelRename, mention,
  } = useGoalRename(goal);
  const children = useMemo(() => allGoals.filter((item) => item.parentId === goal.id), [allGoals, goal.id]);
  const hasChildren = children.length > 0;
  const achieved = goal.status === "achieved";
  const blocked = goal.status === "blocked";
  const isSelected = selectedGoalId === goal.id;

  const handleRowClick = () => {
    if (isRenaming) return;
    if (isSelected) {
      setLocation(`/goals/${goal.id}`);
    } else {
      setSelectedGoalId(goal.id);
    }
  };

  return (
    <>
      {/* paddingLeft is dynamic (depth × 16px) — cannot be expressed as a static Tailwind class */}
      <div className="flex min-w-0 max-w-full items-stretch" style={{ paddingLeft: depth * 16 }}>
        {depth > 0 && (
          <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
            <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border" />
            <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
          </div>
        )}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            onClick={handleRowClick}
            className={`group relative flex w-full cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 ${hasChildren ? "pr-16" : "pr-9"} text-left text-sm text-muted-foreground transition-colors ${isSelected ? "bg-accent" : "hover:bg-accent/70 hover:text-foreground"}`}
            data-testid={`goals-tree-goal-${goal.id}`}
          >
            <span className="shrink-0">
              {blocked ? (
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-error bg-transparent text-error">
                  <X className="h-3 w-3" />
                </span>
              ) : (
                <SimpleCheckCircle checked={achieved} interactive={false} />
              )}
            </span>
            {isRenaming ? (
              <div className="relative min-w-0 flex-1" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <input
                  ref={renameInputRef}
                  className="w-full bg-transparent border-b border-primary outline-none text-sm"
                  value={renameValue}
                  onChange={(e) => {
                    setRenameValue(e.target.value);
                    const pos = e.target.selectionStart ?? e.target.value.length;
                    setRenameCursor(pos);
                    mention.handleInputChange(e.target.value, pos);
                  }}
                  onKeyDown={(e) => {
                    if (mention.handleKeyDown(e)) return;
                    if (e.key === "Enter") { e.preventDefault(); submitRename(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                  }}
                  onBlur={submitRename}
                  data-testid={`input-rename-goal-${goal.id}`}
                />
                <MentionPopover
                  trigger={mention.trigger}
                  suggestions={mention.suggestions}
                  isLoading={mention.isLoading}
                  activeIndex={mention.activeIndex}
                  onSelect={mention.insertSuggestion}
                  onHover={mention.setActiveIndex}
                  testIdSuffix={`-rename-${goal.id}`}
                />
              </div>
            ) : (
              <span className="flex-1 min-w-0 overflow-hidden">
                <button
                  type="button"
                  className={`inline-flex max-w-full min-w-0 items-baseline text-left align-baseline ${isSelected ? "cursor-text" : "cursor-pointer"} ${achieved ? "text-neutral line-through decoration-neutral/60" : ""}`}
                  onClick={(e) => {
                    if (!isSelected) return;
                    e.stopPropagation();
                    startRename();
                  }}
                  aria-label={isSelected ? `Rename ${goal.shortName}` : goal.shortName}
                  data-testid={`button-rename-goal-${goal.id}`}
                >
                  <InlineReferenceText text={goal.shortName} className="truncate" />
                </button>
              </span>
            )}
            <GoalRowMenu goal={goal} onStartRename={startRename} />
          </div>
          {hasChildren && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
              className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              aria-label={open ? "Collapse" : "Expand"}
              data-testid={`goal-toggle-${goal.id}`}
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
            </button>
          )}
        </div>
      </div>
      {hasChildren && open && (
        <div>
          {children.map((child) => (
            <GoalTreeRow
              key={child.id}
              goal={child}
              allGoals={allGoals}
              depth={depth + 1}
              selectedGoalId={selectedGoalId}
              setSelectedGoalId={setSelectedGoalId}
            />
          ))}
        </div>
      )}
    </>
  );
}
