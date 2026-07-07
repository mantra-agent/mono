import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Pencil, Trash2, Loader2, ChevronUp, ChevronDown, ExternalLink, Compass, Heart, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Types ───────────────────────────────────────────────────────
interface ExecPassion {
  id: number;
  tier: "mission" | "value" | "exploration";
  title: string;
  content: string;
  sourceRef: string | null;
  position: number | null;
  createdAt: string;
  updatedAt: string;
}

type PassionTier = ExecPassion["tier"];

const TIERS: PassionTier[] = ["mission", "value", "exploration"];

const TIER_META: Record<PassionTier, { label: string; description: string; icon: React.ReactNode; badgeClass: string }> = {
  mission: {
    label: "Mission",
    description: "Your core purpose and reason for building",
    icon: <Compass className="h-4 w-4" />,
    badgeClass: "bg-cat-ai/15 text-cat-ai-foreground border-cat-ai/30",
  },
  value: {
    label: "Values",
    description: "Philosophical pillars that guide your decisions",
    icon: <Heart className="h-4 w-4" />,
    badgeClass: "bg-cat-growth/15 text-cat-growth-foreground border-cat-growth/30",
  },
  exploration: {
    label: "Explorations",
    description: "Themes and ideas you're actively pursuing",
    icon: <Sparkles className="h-4 w-4" />,
    badgeClass: "bg-cat-event/15 text-cat-event-foreground border-cat-event/30",
  },
};

// ── Create / Edit Dialog ────────────────────────────────────────
function PassionDialog({
  open,
  onOpenChange,
  passion,
  defaultTier,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passion?: ExecPassion;
  defaultTier: PassionTier;
  onSave: (data: { tier: PassionTier; title: string; content: string; sourceRef?: string }) => void;
  saving: boolean;
}) {
  const [tier, setTier] = useState<PassionTier>(passion?.tier || defaultTier);
  const [title, setTitle] = useState(passion?.title || "");
  const [content, setContent] = useState(passion?.content || "");
  const [sourceRef, setSourceRef] = useState(passion?.sourceRef || "");

  const handleSave = () => {
    if (!title.trim() || !content.trim()) return;
    onSave({ tier, title: title.trim(), content: content.trim(), sourceRef: sourceRef.trim() || undefined });
  };

  // Reset form when dialog opens with different passion
  const resetKey = passion?.id ?? "new";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" key={resetKey}>
        <DialogHeader>
          <DialogTitle>{passion ? "Edit Entry" : "Add Entry"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {!passion && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Tier</label>
              <Select value={tier} onValueChange={(v) => setTier(v as PassionTier)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIERS.map((t) => (
                    <SelectItem key={t} value={t}>{TIER_META[t].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tier === "mission" ? "Your mission statement title" : "Entry title"}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Content</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What this means and why it matters..."
              rows={tier === "mission" ? 4 : 3}
            />
          </div>
          {(tier === "exploration" || sourceRef) && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Source Reference</label>
              <Input
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                placeholder="URL or reference (optional)"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !title.trim() || !content.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {passion ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Passion Card ────────────────────────────────────────────────
function PassionCard({
  passion,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  isMission,
}: {
  passion: ExecPassion;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst: boolean;
  isLast: boolean;
  isMission?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-border bg-card p-4 ${isMission ? "p-6" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className={`font-semibold text-foreground ${isMission ? "text-lg" : "text-sm"}`}>
            {passion.title}
          </h4>
          <p className={`text-muted-foreground mt-1 whitespace-pre-wrap ${isMission ? "text-base leading-relaxed" : "text-sm"}`}>
            {passion.content}
          </p>
          {passion.sourceRef && (
            <a
              href={passion.sourceRef.startsWith("http") ? passion.sourceRef : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              {passion.sourceRef}
            </a>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {!isMission && onMoveUp && (
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onMoveUp} disabled={isFirst}>
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
          )}
          {!isMission && onMoveDown && (
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onMoveDown} disabled={isLast}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Tier Section ────────────────────────────────────────────────
function TierSection({
  tier,
  passions,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
}: {
  tier: PassionTier;
  passions: ExecPassion[];
  onAdd: (tier: PassionTier) => void;
  onEdit: (passion: ExecPassion) => void;
  onDelete: (passion: ExecPassion) => void;
  onReorder: (id: number, direction: "up" | "down") => void;
}) {
  const meta = TIER_META[tier];
  const isMission = tier === "mission";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{meta.icon}</span>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{meta.label}</h3>
          <Badge variant="secondary" className={meta.badgeClass}>{passions.length}</Badge>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onAdd(tier)}>
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>

      {passions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-muted-foreground text-sm">{meta.description}</p>
          <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => onAdd(tier)}>
            Add your first {tier === "mission" ? "mission statement" : tier === "value" ? "value" : "exploration"}
          </Button>
        </div>
      ) : (
        <div className={isMission ? "space-y-3" : "grid gap-3 @sm:grid-cols-2"}>
          {passions.map((p, i) => (
            <PassionCard
              key={p.id}
              passion={p}
              isMission={isMission}
              onEdit={() => onEdit(p)}
              onDelete={() => onDelete(p)}
              onMoveUp={() => onReorder(p.id, "up")}
              onMoveDown={() => onReorder(p.id, "down")}
              isFirst={i === 0}
              isLast={i === passions.length - 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Main Tab ────────────────────────────────────────────────────
export default function ExecPassionsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPassion, setEditingPassion] = useState<ExecPassion | undefined>();
  const [dialogTier, setDialogTier] = useState<PassionTier>("mission");
  const [deleteTarget, setDeleteTarget] = useState<ExecPassion | null>(null);

  const { data: passions = [], isLoading } = useQuery<ExecPassion[]>({
    queryKey: ["/api/exec/passions"],
  });

  const grouped = useMemo(() => {
    const g: Record<PassionTier, ExecPassion[]> = { mission: [], value: [], exploration: [] };
    for (const p of passions) {
      if (p.tier in g) g[p.tier].push(p);
    }
    return g;
  }, [passions]);

  const createMutation = useMutation({
    mutationFn: async (data: { tier: PassionTier; title: string; content: string; sourceRef?: string }) => {
      const tierPassions = grouped[data.tier];
      const position = tierPassions.length;
      const res = await apiRequest("POST", "/api/exec/passions", { ...data, position });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/passions"] });
      setDialogOpen(false);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/exec/passions/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/passions"] });
      setDialogOpen(false);
      setEditingPassion(undefined);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/exec/passions/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/exec/passions"] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleAdd = useCallback((tier: PassionTier) => {
    setEditingPassion(undefined);
    setDialogTier(tier);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback((passion: ExecPassion) => {
    setEditingPassion(passion);
    setDialogTier(passion.tier);
    setDialogOpen(true);
  }, []);

  const handleSave = useCallback((data: { tier: PassionTier; title: string; content: string; sourceRef?: string }) => {
    if (editingPassion) {
      updateMutation.mutate({ id: editingPassion.id, updates: data });
    } else {
      createMutation.mutate(data);
    }
  }, [editingPassion, createMutation, updateMutation]);

  const handleReorder = useCallback((id: number, direction: "up" | "down") => {
    const passion = passions.find((p) => p.id === id);
    if (!passion) return;
    const tierList = grouped[passion.tier];
    const idx = tierList.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= tierList.length) return;
    const swapTarget = tierList[swapIdx];
    // Swap positions
    updateMutation.mutate({ id, updates: { position: swapTarget.position ?? swapIdx } });
    updateMutation.mutate({ id: swapTarget.id, updates: { position: passion.position ?? idx } });
  }, [passions, grouped, updateMutation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="p-4 space-y-8">
        {TIERS.map((tier) => (
          <TierSection
            key={tier}
            tier={tier}
            passions={grouped[tier]}
            onAdd={handleAdd}
            onEdit={handleEdit}
            onDelete={setDeleteTarget}
            onReorder={handleReorder}
          />
        ))}
      </div>

      {/* Create / Edit Dialog */}
      <PassionDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingPassion(undefined);
        }}
        passion={editingPassion}
        defaultTier={dialogTier}
        onSave={handleSave}
        saving={createMutation.isPending || updateMutation.isPending}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.title}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
