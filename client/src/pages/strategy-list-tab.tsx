import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  Plus,
  Trash2,
  Users,
} from "lucide-react";

interface StrategyItem {
  id: string;
  title: string;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  actorCount?: number;
  stateCount?: number;
}

function formatUpdatedAt(dateStr: string) {
  const d = new Date(dateStr);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

function matchesSearch(strategy: StrategyItem, search: string) {
  if (!search.trim()) return true;
  const q = search.trim().toLowerCase();
  return (
    strategy.title.toLowerCase().includes(q) ||
    (strategy.description ?? "").toLowerCase().includes(q)
  );
}

function ScenarioRow({
  strategy,
  onOpen,
  onDelete,
  onDuplicate,
  onArchive,
  onUnarchive,
}: {
  strategy: StrategyItem;
  onOpen: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  const actorCount = strategy.actorCount ?? 0;
  const stateCount = strategy.stateCount ?? 0;

  return (
    <ProfileTreeRow
      label={<span data-testid={`text-strategy-title-${strategy.id}`}>{strategy.title}</span>}
      hasValue
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      testId={`card-strategy-${strategy.id}`}
      expandedContentClassName="px-2 pb-2 pl-2"
      expandedContent={(
        <div className="space-y-0.5">
          {strategy.description ? (
            <ProfileTreeRow
              label="Description"
              hasValue
              showEmpty
              mobileLayout="inline"
              testId={`text-strategy-desc-${strategy.id}`}
            >
              <span className="whitespace-pre-wrap text-right text-xs text-muted-foreground">
                {strategy.description}
              </span>
            </ProfileTreeRow>
          ) : null}

          <ProfileTreeRow
            label="Actors"
            icon={<Users className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`text-actor-count-${strategy.id}`}
          >
            <span className="text-xs tabular-nums text-muted-foreground">{actorCount}</span>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="States"
            icon={<GitBranch className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`text-state-count-${strategy.id}`}
          >
            <span className="text-xs tabular-nums text-muted-foreground">{stateCount}</span>
          </ProfileTreeRow>

          {strategy.updatedAt ? (
            <ProfileTreeRow
              label="Updated"
              hasValue
              showEmpty
              mobileLayout="inline"
              testId={`text-strategy-updated-${strategy.id}`}
            >
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatUpdatedAt(strategy.updatedAt)}
              </span>
            </ProfileTreeRow>
          ) : null}

          <div className="px-2 pt-1">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-sm text-cta hover:text-active"
              onClick={onOpen}
              data-testid={`button-open-strategy-${strategy.id}`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open scenario
            </button>
          </div>
        </div>
      )}
      menuContent={(
        <>
          <DropdownMenuItem onSelect={onOpen} data-testid={`button-open-menu-strategy-${strategy.id}`}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onDuplicate}
            data-testid={`button-duplicate-strategy-${strategy.id}`}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            Duplicate
          </DropdownMenuItem>
          {onArchive ? (
            <DropdownMenuItem
              onSelect={onArchive}
              data-testid={`button-archive-strategy-${strategy.id}`}
            >
              <Archive className="mr-2 h-3.5 w-3.5" />
              Archive
            </DropdownMenuItem>
          ) : null}
          {onUnarchive ? (
            <DropdownMenuItem
              onSelect={onUnarchive}
              data-testid={`button-unarchive-strategy-${strategy.id}`}
            >
              <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
              Unarchive
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDelete}
            data-testid={`button-delete-strategy-${strategy.id}`}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </>
      )}
    />
  );
}

export default function StrategyListTab() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StrategyItem | null>(null);
  const { toast } = useToast();

  const { data: allStrategies = [], isLoading } = useQuery<StrategyItem[]>({
    queryKey: ["/api/strategy/goals", { includeArchived: true }],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/strategy/goals?includeArchived=true");
      return res.json();
    },
  });

  const filtered = useMemo(
    () => allStrategies.filter((strategy) => matchesSearch(strategy, search)),
    [allStrategies, search],
  );
  const activeStrategies = filtered.filter((s) => !s.archived);
  const archivedStrategies = filtered.filter((s) => s.archived);
  const hasAny = allStrategies.length > 0;
  const searchActive = search.trim().length > 0;

  const createMutation = useMutation({
    mutationFn: async (data: { title: string; description: string }) => {
      const res = await apiRequest("POST", "/api/strategy/goals", data);
      return res.json();
    },
    onSuccess: (strategy: StrategyItem) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals"] });
      setCreateOpen(false);
      toast({ title: `Created "${strategy.title}"` });
      setLocation(`/scenarios/${strategy.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create scenario", description: err.message, variant: "destructive" });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/strategy/goals/${id}/duplicate`);
      return res.json();
    },
    onSuccess: (strategy: StrategyItem) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals"] });
      toast({ title: `Duplicated as "${strategy.title}"` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to duplicate", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategy/goals/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals"] });
      setDeleteTarget(null);
      toast({ title: "Scenario deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await apiRequest("PATCH", `/api/strategy/goals/${id}`, { archived });
      return res.json();
    },
    onSuccess: (strategy: StrategyItem) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals"] });
      toast({
        title: strategy.archived
          ? `Archived "${strategy.title}"`
          : `Unarchived "${strategy.title}"`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update scenario", description: err.message, variant: "destructive" });
    },
  });

  const renderRows = (
    rows: StrategyItem[],
    emptyCopy: string,
    mode: "active" | "archived",
  ) => {
    if (rows.length === 0) {
      return <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyCopy}</div>;
    }

    return rows.map((strategy, index) => (
      <HierarchyTreeRow
        key={strategy.id}
        continues={index < rows.length - 1}
        connectorAnchor="first-row-center"
      >
        <ScenarioRow
          strategy={strategy}
          onOpen={() => setLocation(`/scenarios/${strategy.id}`)}
          onDelete={() => setDeleteTarget(strategy)}
          onDuplicate={() => duplicateMutation.mutate(strategy.id)}
          onArchive={
            mode === "active"
              ? () => archiveMutation.mutate({ id: strategy.id, archived: true })
              : undefined
          }
          onUnarchive={
            mode === "archived"
              ? () => archiveMutation.mutate({ id: strategy.id, archived: false })
              : undefined
          }
        />
      </HierarchyTreeRow>
    ));
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="strategy-page">
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-scenarios"
            clearTestId="button-clear-scenario-search"
            ariaLabel="Search scenarios"
          />

          <button
            type="button"
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            onClick={() => setCreateOpen(true)}
            data-testid="button-create-strategy"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Scenario</span>
          </button>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !hasAny ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="empty-strategy">
              No scenarios yet.
            </div>
          ) : (
            <>
              <Collapsible defaultOpen>
                <CollapsibleTrigger
                  className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
                  data-testid="section-active-scenarios"
                >
                  <ChevronRight className="h-3 w-3 shrink-0" />
                  Active
                </CollapsibleTrigger>
                <CollapsibleContent data-testid="strategies-grid">
                  {renderRows(
                    activeStrategies,
                    searchActive ? "No matching scenarios." : "No active scenarios.",
                    "active",
                  )}
                </CollapsibleContent>
              </Collapsible>

              {allStrategies.some((s) => s.archived) ? (
                <Collapsible defaultOpen={searchActive && archivedStrategies.length > 0}>
                  <CollapsibleTrigger
                    className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
                    data-testid="button-toggle-archived"
                  >
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    Archived
                  </CollapsibleTrigger>
                  <CollapsibleContent data-testid="archived-strategies-grid">
                    {renderRows(
                      archivedStrategies,
                      searchActive ? "No matching archived scenarios." : "No archived scenarios.",
                      "archived",
                    )}
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </>
          )}
        </div>
      </div>

      <CreateScenarioDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(data) => createMutation.mutate(data)}
        isPending={createMutation.isPending}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-delete-dialog-title">Delete Scenario</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-dialog-description">
              Are you sure you want to delete &quot;{deleteTarget?.title}&quot;? This will permanently
              remove all actors, states, moves, and simulation data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateScenarioDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { title: string; description: string }) => void;
  isPending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = () => {
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), description: description.trim() });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setTitle("");
      setDescription("");
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="dialog-create-strategy">
        <DialogHeader>
          <DialogTitle data-testid="text-create-dialog-title">New Scenario</DialogTitle>
          <DialogDescription>Name the scenario and optionally describe the strategic objective.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Scenario title"
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) handleSubmit();
            }}
            data-testid="input-strategy-title"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="min-h-[80px] resize-none"
            data-testid="input-strategy-description"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} data-testid="button-cancel-create">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || isPending}
            data-testid="button-submit-create"
          >
            {isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
