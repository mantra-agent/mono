import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Copy,
  Loader2,
  MoreVertical,
  Plus,
  Swords,
  Trash2,
  Users,
  GitBranch,
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

export default function StrategyListTab() {
  const [, setLocation] = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StrategyItem | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { toast } = useToast();

  const { data: allStrategies = [], isLoading } = useQuery<StrategyItem[]>({
    queryKey: ["/api/strategy/goals", { includeArchived: true }],
    queryFn: async () => {
      const res = await fetch("/api/strategy/goals?includeArchived=true");
      if (!res.ok) throw new Error("Failed to fetch strategies");
      return res.json();
    },
  });

  const activeStrategies = allStrategies.filter(s => !s.archived);
  const archivedStrategies = allStrategies.filter(s => s.archived);

  const createMutation = useMutation({
    mutationFn: async (data: { title: string; description: string }) => {
      const res = await apiRequest("POST", "/api/strategy/goals", data);
      return res.json();
    },
    onSuccess: (strategy: StrategyItem) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy/goals"] });
      setCreateOpen(false);
      toast({ title: `Created "${strategy.title}"` });
      setLocation(`/strategy/${strategy.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create strategy", description: err.message, variant: "destructive" });
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
      toast({ title: "Strategy deleted" });
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
      toast({ title: strategy.archived ? `Archived "${strategy.title}"` : `Unarchived "${strategy.title}"` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update strategy", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-4 space-y-4" data-testid="strategy-page">
      <div className="flex items-center justify-end">
        <Button onClick={() => setCreateOpen(true)} data-testid="button-create-strategy">
          <Plus className="h-4 w-4 mr-1.5" />
          New Strategy
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3">
          {[1, 2, 3].map(i => (
            <Card key={i} className="p-4">
              <Skeleton className="h-5 w-3/4 mb-2" />
              <Skeleton className="h-3 w-full mb-3" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-12" />
              </div>
            </Card>
          ))}
        </div>
      ) : activeStrategies.length === 0 && archivedStrategies.length === 0 ? (
        <Card className="p-8" data-testid="empty-strategy">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/5">
              <Swords className="h-6 w-6 text-primary/40" />
            </div>
            <div>
              <h3 className="text-sm font-medium" data-testid="text-empty-title">No strategies yet</h3>
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-empty-description">
                Create a strategy to start modeling scenarios, actors, and possible outcomes.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)} data-testid="button-create-strategy-empty">
              <Plus className="h-4 w-4 mr-1.5" />
              Create Strategy
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {activeStrategies.length === 0 ? (
            <Card className="p-6" data-testid="empty-active-strategies">
              <p className="text-sm text-muted-foreground text-center">No active strategies. Create a new one or unarchive an existing strategy.</p>
            </Card>
          ) : (
            <div className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3" data-testid="strategies-grid">
              {activeStrategies.map(strategy => (
                <StrategyCard
                  key={strategy.id}
                  strategy={strategy}
                  onClick={() => setLocation(`/strategy/${strategy.id}`)}
                  onDelete={() => setDeleteTarget(strategy)}
                  onDuplicate={() => duplicateMutation.mutate(strategy.id)}
                  onArchive={() => archiveMutation.mutate({ id: strategy.id, archived: true })}
                />
              ))}
            </div>
          )}

          {archivedStrategies.length > 0 && (
            <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="flex items-center gap-2 text-muted-foreground" data-testid="button-toggle-archived">
                  <ChevronDown className={`h-4 w-4 transition-transform ${archivedOpen ? "rotate-0" : "-rotate-90"}`} />
                  <Archive className="h-4 w-4" />
                  Archived ({archivedStrategies.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3">
                <div className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3" data-testid="archived-strategies-grid">
                  {archivedStrategies.map(strategy => (
                    <StrategyCard
                      key={strategy.id}
                      strategy={strategy}
                      onClick={() => setLocation(`/strategy/${strategy.id}`)}
                      onDelete={() => setDeleteTarget(strategy)}
                      onDuplicate={() => duplicateMutation.mutate(strategy.id)}
                      onUnarchive={() => archiveMutation.mutate({ id: strategy.id, archived: false })}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      <CreateStrategyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(data) => createMutation.mutate(data)}
        isPending={createMutation.isPending}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-delete-dialog-title">Delete Strategy</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-dialog-description">
              Are you sure you want to delete "{deleteTarget?.title}"? This will permanently remove all actors, states, moves, and simulation data. This action cannot be undone.
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

function StrategyCard({
  strategy,
  onClick,
  onDelete,
  onDuplicate,
  onArchive,
  onUnarchive,
}: {
  strategy: StrategyItem;
  onClick: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      ", " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  return (
    <Card
      className={`p-4 cursor-pointer hover-elevate transition-colors ${strategy.archived ? "opacity-60" : ""}`}
      onClick={onClick}
      data-testid={`card-strategy-${strategy.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate" data-testid={`text-strategy-title-${strategy.id}`}>
            {strategy.title}
          </h3>
          {strategy.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2" data-testid={`text-strategy-desc-${strategy.id}`}>
              {strategy.description}
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button size="icon" variant="ghost" data-testid={`button-strategy-menu-${strategy.id}`}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              onClick={onDuplicate}
              data-testid={`button-duplicate-strategy-${strategy.id}`}
            >
              <Copy className="h-3.5 w-3.5 mr-2" />
              Duplicate
            </DropdownMenuItem>
            {onArchive && (
              <DropdownMenuItem
                onClick={onArchive}
                data-testid={`button-archive-strategy-${strategy.id}`}
              >
                <Archive className="h-3.5 w-3.5 mr-2" />
                Archive
              </DropdownMenuItem>
            )}
            {onUnarchive && (
              <DropdownMenuItem
                onClick={onUnarchive}
                data-testid={`button-unarchive-strategy-${strategy.id}`}
              >
                <ArchiveRestore className="h-3.5 w-3.5 mr-2" />
                Unarchive
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
              data-testid={`button-delete-strategy-${strategy.id}`}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {(strategy.actorCount !== undefined && strategy.actorCount > 0) && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`text-actor-count-${strategy.id}`}>
            <Users className="h-3 w-3" />
            {strategy.actorCount}
          </span>
        )}
        {(strategy.stateCount !== undefined && strategy.stateCount > 0) && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid={`text-state-count-${strategy.id}`}>
            <GitBranch className="h-3 w-3" />
            {strategy.stateCount}
          </span>
        )}
      </div>

      {strategy.updatedAt && (
        <p className="text-xs text-muted-foreground mt-2" data-testid={`text-strategy-updated-${strategy.id}`}>
          Last Updated: {formatDate(strategy.updatedAt)}
        </p>
      )}
    </Card>
  );
}

function CreateStrategyDialog({
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
          <DialogTitle data-testid="text-create-dialog-title">New Strategy</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Market Expansion Strategy"
              onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) handleSubmit(); }}
              data-testid="input-strategy-title"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the strategic objective..."
              className="min-h-[80px] resize-none"
              data-testid="input-strategy-description"
            />
          </div>
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
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
