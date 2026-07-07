import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Plus, Loader2, MoreVertical, Trash2, Pencil, ExternalLink,
  ChevronDown, ChevronRight, ArrowLeft, Circle, CheckCircle2, XCircle, Clock,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────
type ThesisStatus = "draft" | "active" | "superseded" | "invalidated";
type ThesisConviction = "low" | "high";
type PredictionOutcome = "pending" | "correct" | "incorrect" | "expired";

interface Thesis {
  id: string;
  title: string;
  statement: string;
  tags: string[];
  status: ThesisStatus;
  conviction: ThesisConviction;
  successorId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ThesisEvidence {
  id: string;
  thesisId: string;
  content: string;
  sourceUrl: string;
  position: number;
  createdAt: string;
}

interface ThesisPrediction {
  id: string;
  thesisId: string;
  claim: string;
  deadline: string | null;
  outcome: PredictionOutcome;
  resolvedAt: string | null;
  createdAt: string;
}

interface ThesisFull extends Thesis {
  evidence: ThesisEvidence[];
  predictions: ThesisPrediction[];
}

// ── Constants ──────────────────────────────────────────────────────
const CONVICTION_DOT: Record<ThesisConviction, string> = {
  high: "bg-success",
  low: "bg-warning",
};

const OUTCOME_ICON: Record<PredictionOutcome, typeof Circle> = {
  pending: Circle,
  correct: CheckCircle2,
  incorrect: XCircle,
  expired: Clock,
};

const OUTCOME_COLOR: Record<PredictionOutcome, string> = {
  pending: "text-muted-foreground",
  correct: "text-success",
  incorrect: "text-error",
  expired: "text-muted-foreground/60",
};

const OUTCOME_CYCLE: PredictionOutcome[] = ["pending", "correct", "incorrect", "expired"];

const SIDEBAR_WIDTH_KEY = "theses-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const SAVE_DEBOUNCE_MS = 1500;

// ── Component ──────────────────────────────────────────────────────
export default function ThesesTab() {
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Thesis | null>(null);
  const [activeExpanded, setActiveExpanded] = useState(true);
  const [draftExpanded, setDraftExpanded] = useState(true);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed)) return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parsed));
    }
    return DEFAULT_SIDEBAR_WIDTH;
  });

  const { data: theses = [], isLoading } = useQuery<Thesis[]>({
    queryKey: ["/api/theses"],
  });

  const { activeList, draftList, archivedList } = useMemo(() => {
    const active: Thesis[] = [];
    const draft: Thesis[] = [];
    const archived: Thesis[] = [];
    for (const t of theses) {
      if (t.status === "active") active.push(t);
      else if (t.status === "draft") draft.push(t);
      else archived.push(t);
    }
    return { activeList: active, draftList: draft, archivedList: archived };
  }, [theses]);

  useEffect(() => {
    if (!isMobile && !selectedId && theses.length > 0) setSelectedId(theses[0].id);
  }, [theses, selectedId, isMobile]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/theses", { title: "Untitled Thesis" });
      return res.json() as Promise<Thesis>;
    },
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
      setSelectedId(t.id);
    },
    onError: (err: Error) => toast({ title: "Failed to create thesis", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/theses/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
      if (deleteTarget?.id === selectedId) setSelectedId(null);
      setDeleteTarget(null);
      toast({ title: "Thesis deleted" });
    },
    onError: (err: Error) => toast({ title: "Failed to delete", description: err.message, variant: "destructive" }),
  });

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setSidebarWidth(w => { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); return w; });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  const renderItem = (t: Thesis) => (
    <button
      key={t.id}
      onClick={() => setSelectedId(t.id)}
      className={cn(
        "w-full text-left rounded p-2 hover:bg-muted/50 transition-colors",
        selectedId === t.id && !isMobile && "bg-accent",
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("inline-block h-2 w-2 rounded-full mt-1.5 shrink-0", CONVICTION_DOT[t.conviction])} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{t.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
            {(t.tags || []).length > 0 && <span>#{(t.tags || []).slice(0, 2).join(" #")}</span>}
            <span className="uppercase">{t.conviction}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Updated {new Date(t.updatedAt).toLocaleDateString()}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100">
              <MoreVertical className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDeleteTarget(t); }}>
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </button>
  );

  const renderGroup = (label: string, items: Thesis[], expanded: boolean, toggle: () => void) => {
    if (items.length === 0) return null;
    return (
      <div key={label}>
        <button onClick={toggle} className="flex items-center gap-1 w-full text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1 hover:text-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {label} ({items.length})
        </button>
        {expanded && <div className="space-y-0.5 group">{items.map(renderItem)}</div>}
      </div>
    );
  };

  // ── Sidebar ────────────────────────────────────────────────────
  const sidebar = (
    <div className={cn("flex flex-col border-r border-border h-full", isMobile ? "w-full" : "")} style={isMobile ? {} : { width: sidebarWidth }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-muted-foreground">Theses</span>
        <Button
          variant="ghost" size="icon" className="h-6 w-6"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-1 space-y-2">
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : theses.length === 0 ? (
            <div className="text-center py-12 px-4">
              <p className="text-sm text-muted-foreground mb-1">What do you believe about the world?</p>
              <p className="text-xs text-muted-foreground/70 mb-4">A thesis is a bet. An explanation you're confident enough to write down.</p>
              <Button variant="outline" size="sm" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
                <Plus className="h-3.5 w-3.5 mr-1" /> New Thesis
              </Button>
            </div>
          ) : (
            <>
              {renderGroup("Active", activeList, activeExpanded, () => setActiveExpanded(v => !v))}
              {renderGroup("Draft", draftList, draftExpanded, () => setDraftExpanded(v => !v))}
              {renderGroup("Archived", archivedList, archivedExpanded, () => setArchivedExpanded(v => !v))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );

  // ── Mobile back ────────────────────────────────────────────────
  if (isMobile && selectedId) {
    return (
      <div className="flex flex-col h-full">
        <Button variant="ghost" size="sm" className="self-start m-2" onClick={() => setSelectedId(null)}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <ThesisDetail id={selectedId} />
        <DeleteDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} />
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="flex flex-col h-full">
        {sidebar}
        <DeleteDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {sidebar}
      <div className="w-1 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors" onMouseDown={handleResizeStart} />
      <div className="flex-1 min-w-0 overflow-hidden">
        {selectedId ? (
          <ThesisDetail id={selectedId} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a thesis or create a new one
          </div>
        )}
      </div>
      <DeleteDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} />
    </div>
  );
}

// ── Delete Dialog ────────────────────────────────────────────────
function DeleteDialog({ target, onClose, onConfirm }: { target: Thesis | null; onClose: () => void; onConfirm: () => void }) {
  return (
    <AlertDialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{target?.title}"?</AlertDialogTitle>
          <AlertDialogDescription>This will permanently delete the thesis and all its evidence and predictions.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────
function ThesisDetail({ id }: { id: string }) {
  const { toast } = useToast();
  const titleRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localTitle, setLocalTitle] = useState("");
  const [localStatement, setLocalStatement] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [newEvidenceContent, setNewEvidenceContent] = useState("");
  const [newEvidenceUrl, setNewEvidenceUrl] = useState("");
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);
  const [newPredictionClaim, setNewPredictionClaim] = useState("");
  const [newPredictionDeadline, setNewPredictionDeadline] = useState("");
  const [showPredictionForm, setShowPredictionForm] = useState(false);

  const { data: thesis, isLoading } = useQuery<ThesisFull>({
    queryKey: ["/api/theses", id],
    queryFn: async () => {
      const res = await fetch(`/api/theses/${id}`);
      if (!res.ok) throw new Error("Failed to load thesis");
      return res.json();
    },
  });

  useEffect(() => {
    if (thesis) {
      setLocalTitle(thesis.title);
      setLocalStatement(thesis.statement);
    }
  }, [thesis?.id, thesis?.title, thesis?.statement]);

  // Focus title on new thesis
  useEffect(() => {
    if (thesis?.title === "Untitled Thesis" && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, [thesis?.id]);

  const patchMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      await apiRequest("PATCH", `/api/theses/${id}`, patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/theses", id] });
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
  });

  const debouncedPatch = useCallback((patch: Record<string, unknown>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => patchMutation.mutate(patch), SAVE_DEBOUNCE_MS);
  }, [patchMutation]);

  // ── Evidence mutations ─────────────────────────────────────────
  const addEvidenceMutation = useMutation({
    mutationFn: async ({ content, sourceUrl }: { content: string; sourceUrl?: string }) => {
      await apiRequest("POST", `/api/theses/${id}/evidence`, { content, sourceUrl: sourceUrl || "" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
      setNewEvidenceContent("");
      setNewEvidenceUrl("");
      setShowEvidenceForm(false);
    },
    onError: (err: Error) => toast({ title: "Failed to add evidence", description: err.message, variant: "destructive" }),
  });

  const removeEvidenceMutation = useMutation({
    mutationFn: async (eid: string) => { await apiRequest("DELETE", `/api/theses/evidence/${eid}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
    },
    onError: (err: Error) => toast({ title: "Failed to remove evidence", description: err.message, variant: "destructive" }),
  });

  // ── Prediction mutations ───────────────────────────────────────
  const addPredictionMutation = useMutation({
    mutationFn: async ({ claim, deadline }: { claim: string; deadline?: string }) => {
      await apiRequest("POST", `/api/theses/${id}/predictions`, { claim, deadline: deadline || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
      setNewPredictionClaim("");
      setNewPredictionDeadline("");
      setShowPredictionForm(false);
    },
    onError: (err: Error) => toast({ title: "Failed to add prediction", description: err.message, variant: "destructive" }),
  });

  const resolvePredictionMutation = useMutation({
    mutationFn: async ({ pid, outcome }: { pid: string; outcome: PredictionOutcome }) => {
      await apiRequest("PATCH", `/api/theses/predictions/${pid}`, { outcome });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses", id] });
    },
    onError: (err: Error) => toast({ title: "Failed to update prediction", description: err.message, variant: "destructive" }),
  });

  const removePredictionMutation = useMutation({
    mutationFn: async (pid: string) => { await apiRequest("DELETE", `/api/theses/predictions/${pid}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/theses", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/theses"] });
    },
    onError: (err: Error) => toast({ title: "Failed to remove prediction", description: err.message, variant: "destructive" }),
  });

  const cyclePredictionOutcome = (p: ThesisPrediction) => {
    const idx = OUTCOME_CYCLE.indexOf(p.outcome);
    const next = OUTCOME_CYCLE[(idx + 1) % OUTCOME_CYCLE.length];
    resolvePredictionMutation.mutate({ pid: p.id, outcome: next });
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && tagInput.trim()) {
      const newTags = [...(thesis?.tags || []), tagInput.trim()];
      patchMutation.mutate({ tags: newTags });
      setTagInput("");
    }
  };

  const handleRemoveTag = (tag: string) => {
    const newTags = (thesis?.tags || []).filter(t => t !== tag);
    patchMutation.mutate({ tags: newTags });
  };

  if (isLoading || !thesis) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        {/* Title */}
        <Input
          ref={titleRef}
          value={localTitle}
          onChange={(e) => {
            setLocalTitle(e.target.value);
            debouncedPatch({ title: e.target.value });
          }}
          className="text-lg font-semibold border-none shadow-none px-0 focus-visible:ring-0 h-auto"
          placeholder="Thesis title..."
        />

        {/* Statement */}
        <Textarea
          value={localStatement}
          onChange={(e) => {
            setLocalStatement(e.target.value);
            debouncedPatch({ statement: e.target.value });
          }}
          className="min-h-[80px] resize-none border-muted/50"
          placeholder="The hard-to-vary claim. What do you believe and why?"
        />

        {/* Tags & Conviction */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {(thesis.tags || []).map(tag => (
              <Badge key={tag} variant="outline" className="text-xs cursor-pointer" onClick={() => handleRemoveTag(tag)}>
                #{tag} ×
              </Badge>
            ))}
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              className="h-6 w-24 text-xs border-dashed"
              placeholder="+ tag"
            />
          </div>
          <div className="ml-auto">
            <Button
              variant={thesis.conviction === "high" ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => patchMutation.mutate({ conviction: thesis.conviction === "high" ? "low" : "high" })}
            >
              <span className={cn("inline-block h-2 w-2 rounded-full mr-1.5", CONVICTION_DOT[thesis.conviction])} />
              {thesis.conviction === "high" ? "HIGH" : "LOW"}
            </Button>
          </div>
        </div>

        {/* Evidence */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Evidence ({thesis.evidence.length})
          </h3>
          <div className="space-y-2">
            {thesis.evidence.map(e => (
              <Card key={e.id} className="p-3 group/card">
                <p className="text-sm">{e.content}</p>
                {e.sourceUrl && (
                  <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-info hover:underline flex items-center gap-1 mt-1">
                    <ExternalLink className="h-3 w-3" />
                    {(() => { try { return new URL(e.sourceUrl).hostname; } catch { return e.sourceUrl; } })()}
                  </a>
                )}
                <div className="flex justify-end opacity-0 group-hover/card:opacity-100 transition-opacity mt-1">
                  <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => removeEvidenceMutation.mutate(e.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
          {showEvidenceForm ? (
            <Card className="p-3 mt-2 space-y-2">
              <Textarea
                value={newEvidenceContent}
                onChange={(e) => setNewEvidenceContent(e.target.value)}
                className="min-h-[60px] resize-none text-sm"
                placeholder="Evidence summary..."
                autoFocus
              />
              <Input
                value={newEvidenceUrl}
                onChange={(e) => setNewEvidenceUrl(e.target.value)}
                className="text-xs"
                placeholder="Source URL (optional)"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => { setShowEvidenceForm(false); setNewEvidenceContent(""); setNewEvidenceUrl(""); }}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => addEvidenceMutation.mutate({ content: newEvidenceContent, sourceUrl: newEvidenceUrl })}
                  disabled={!newEvidenceContent.trim() || addEvidenceMutation.isPending}
                >
                  {addEvidenceMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                </Button>
              </div>
            </Card>
          ) : (
            <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => setShowEvidenceForm(true)}>
              <Plus className="h-3 w-3 mr-1" /> Add Evidence
            </Button>
          )}
        </div>

        {/* Predictions */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Predictions ({thesis.predictions.length})
          </h3>
          <div className="space-y-2">
            {thesis.predictions.map(p => {
              const Icon = OUTCOME_ICON[p.outcome];
              return (
                <Card key={p.id} className="p-3 group/card">
                  <div className="flex items-start gap-2">
                    <button onClick={() => cyclePredictionOutcome(p)} className="mt-0.5 shrink-0" title={`Status: ${p.outcome}. Click to cycle.`}>
                      <Icon className={cn("h-4 w-4", OUTCOME_COLOR[p.outcome])} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{p.claim}</p>
                      {p.deadline && <p className="text-xs text-muted-foreground mt-0.5">Due: {p.deadline}</p>}
                    </div>
                    <div className="opacity-0 group-hover/card:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => removePredictionMutation.mutate(p.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
          {showPredictionForm ? (
            <Card className="p-3 mt-2 space-y-2">
              <Textarea
                value={newPredictionClaim}
                onChange={(e) => setNewPredictionClaim(e.target.value)}
                className="min-h-[60px] resize-none text-sm"
                placeholder="If this thesis is true, then..."
                autoFocus
              />
              <Input
                type="date"
                value={newPredictionDeadline}
                onChange={(e) => setNewPredictionDeadline(e.target.value)}
                className="text-xs w-40"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => { setShowPredictionForm(false); setNewPredictionClaim(""); setNewPredictionDeadline(""); }}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => addPredictionMutation.mutate({ claim: newPredictionClaim, deadline: newPredictionDeadline || undefined })}
                  disabled={!newPredictionClaim.trim() || addPredictionMutation.isPending}
                >
                  {addPredictionMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                </Button>
              </div>
            </Card>
          ) : (
            <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => setShowPredictionForm(true)}>
              <Plus className="h-3 w-3 mr-1" /> Add Prediction
            </Button>
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-3 pt-4 border-t border-border text-xs text-muted-foreground">
          <span>Created {new Date(thesis.createdAt).toLocaleDateString()}</span>
          <span>·</span>
          <span>Updated {new Date(thesis.updatedAt).toLocaleDateString()}</span>
          <div className="ml-auto">
            <Select
              value={thesis.status}
              onValueChange={(val) => patchMutation.mutate({ status: val })}
            >
              <SelectTrigger className="h-6 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="superseded">Superseded</SelectItem>
                <SelectItem value="invalidated">Invalidated</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
