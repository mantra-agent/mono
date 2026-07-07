import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { UniversalTagPicker } from "@/components/universal-tag-picker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  Plus,
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  X,
  Save,
  Lightbulb,
  ExternalLink,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface BeliefEvidence {
  type: "memory" | "strategy" | "observation";
  id: string;
  summary: string;
}

interface Belief {
  id: string;
  claim: string;
  domain: string;
  confidence: number;
  evidence: BeliefEvidence[];
  status: "active" | "uncertain" | "invalidated";
  principleRef: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const statusConfig: Record<Belief["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "Active", variant: "default" },
  uncertain: { label: "Uncertain", variant: "outline" },
  invalidated: { label: "Invalidated", variant: "destructive" },
};

function BeliefCard({
  belief,
  onEdit,
  onDelete,
}: {
  belief: Belief;
  onEdit: (b: Belief) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusCfg = statusConfig[belief.status];

  return (
    <Card
      className="group transition-all duration-150 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
      data-testid={`card-belief-${belief.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-medium text-sm leading-tight" data-testid={`text-belief-claim-${belief.id}`}>
                  {belief.claim}
                </h3>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {belief.domain && (
                    <Badge variant="outline" className="text-xs h-5 no-default-hover-elevate" data-testid={`badge-domain-${belief.id}`}>
                      {belief.domain}
                    </Badge>
                  )}
                  <Badge variant={statusCfg.variant} className="text-xs h-5 no-default-hover-elevate" data-testid={`badge-status-${belief.id}`}>
                    {statusCfg.label}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 invisible group-hover:visible">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onEdit(belief); }} data-testid={`button-edit-${belief.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(belief.id); }} data-testid={`button-delete-${belief.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="mt-2">
              <div className="flex items-center gap-2">
                <Progress value={belief.confidence * 100} className="h-1.5 flex-1" />
                <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-confidence-${belief.id}`}>{Math.round(belief.confidence * 100)}%</span>
              </div>
            </div>

            {Array.isArray(belief.tags) && belief.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {belief.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs h-5 no-default-hover-elevate">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {expanded && (
              <div className="mt-3 pt-3 border-t border-border/50 space-y-3" onClick={(e) => e.stopPropagation()}>
                {belief.evidence.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Evidence</span>
                    <div className="mt-1 space-y-1">
                      {belief.evidence.map((ev, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <ExternalLink className="h-3 w-3 mt-0.5 shrink-0" />
                          <div>
                            <Badge variant="outline" className="text-xs h-4 no-default-hover-elevate mr-1">{ev.type}</Badge>
                            <span>{ev.summary}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {belief.principleRef && (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Principle Reference</span>
                    <p className="text-sm text-muted-foreground mt-1">{belief.principleRef}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateEditDialog({
  belief,
  open,
  onClose,
  onSave,
}: {
  belief: Belief | null;
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<Belief>) => void;
}) {
  const isEdit = !!belief;
  const [claim, setClaim] = useState("");
  const [domain, setDomain] = useState("");
  const [confidence, setConfidence] = useState(0.5);
  const [status, setStatus] = useState<Belief["status"]>("active");
  const [principleRef, setPrincipleRef] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  const reset = useCallback(() => {
    if (belief) {
      setClaim(belief.claim);
      setDomain(belief.domain);
      setConfidence(belief.confidence);
      setStatus(belief.status);
      setPrincipleRef(belief.principleRef);
      setTags(Array.isArray(belief.tags) ? [...belief.tags] : []);
    } else {
      setClaim("");
      setDomain("");
      setConfidence(0.5);
      setStatus("active");
      setPrincipleRef("");
      setTags([]);
    }
  }, [belief]);

  useEffect(() => { reset(); }, [reset]);

  const handleSave = () => {
    onSave({ claim, domain, confidence, status, principleRef, tags });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); else reset(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] sm:max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4" />
            {isEdit ? "Edit Belief" : "Add Belief"}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6 flex-1 min-h-0 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Claim</label>
            <Textarea value={claim} onChange={(e) => setClaim(e.target.value)} className="mt-1 min-h-[60px] resize-none text-sm" data-testid="input-belief-claim" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Domain</label>
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} className="mt-1 text-sm" data-testid="input-belief-domain" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</label>
              <Select value={status} onValueChange={(v) => setStatus(v as Belief["status"])}>
                <SelectTrigger className="mt-1" data-testid="select-belief-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="uncertain">Uncertain</SelectItem>
                  <SelectItem value="invalidated">Invalidated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Confidence ({Math.round(confidence * 100)}%)</label>
            <input type="range" min="0" max="1" step="0.05" value={confidence} onChange={(e) => setConfidence(parseFloat(e.target.value))} className="w-full mt-1" data-testid="input-belief-confidence" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Principle Reference</label>
            <Input value={principleRef} onChange={(e) => setPrincipleRef(e.target.value)} className="mt-1 text-sm" data-testid="input-belief-principleref" placeholder="Optional principle ID" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
            <div className="mt-1">
              <UniversalTagPicker tags={tags} onChange={setTags} placeholder="Add tag..." />
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!claim.trim()} data-testid="button-save-belief">
              <Save className="h-4 w-4 mr-2" />
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function BeliefsPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Beliefs" });
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Belief["status"] | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editBelief, setEditBelief] = useState<Belief | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: rawData, isLoading } = useQuery<Belief[]>({
    queryKey: ["/api/beliefs"],
  });
  const beliefs = Array.isArray(rawData) ? rawData : [];

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Belief>) => {
      const res = await apiRequest("POST", "/api/beliefs", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Belief created" });
      queryClient.invalidateQueries({ queryKey: ["/api/beliefs"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Belief> }) => {
      const res = await apiRequest("PUT", `/api/beliefs/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Belief updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/beliefs"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/beliefs/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Belief deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/beliefs"] });
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      setDeleteId(null);
    },
  });

  const handleCreateSave = useCallback((data: Partial<Belief>) => {
    createMutation.mutate(data);
  }, [createMutation]);

  const handleEditSave = useCallback((updates: Partial<Belief>) => {
    if (editBelief) {
      updateMutation.mutate({ id: editBelief.id, updates });
      setEditBelief(null);
    }
  }, [editBelief, updateMutation]);

  const filtered = beliefs.filter((b) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = !searchQuery ||
      (b.claim || "").toLowerCase().includes(q) ||
      (b.domain || "").toLowerCase().includes(q) ||
      (Array.isArray(b.tags) && b.tags.some((t) => (t || "").toLowerCase().includes(q)));
    const matchesStatus = statusFilter === "all" || b.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const deleteTarget = beliefs.find((b) => b.id === deleteId);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden" data-testid="beliefs-page">
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2">
        <Lightbulb className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 @sm:gap-4 flex-wrap text-sm min-w-0">
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{beliefs.length}</span> belief{beliefs.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-belief">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Belief
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-4">
        {beliefs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted/50 p-4 mb-4">
              <Lightbulb className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium text-lg mb-1" data-testid="text-beliefs-empty-title">No beliefs yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Beliefs represent the system's understanding of the world, tracked with confidence and evidence.
            </p>
            <Button onClick={() => setCreateOpen(true)} data-testid="button-create-first-belief">
              <Plus className="h-4 w-4 mr-2" />
              Add your first belief
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search beliefs..."
                  className="pl-8 text-sm"
                  data-testid="input-search-beliefs"
                />
                {searchQuery && (
                  <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearchQuery("")}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as Belief["status"] | "all")}>
                <SelectTrigger className="w-[130px]" data-testid="select-status-filter">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="uncertain">Uncertain</SelectItem>
                  <SelectItem value="invalidated">Invalidated</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              {filtered.map((belief) => (
                <BeliefCard
                  key={belief.id}
                  belief={belief}
                  onEdit={setEditBelief}
                  onDelete={setDeleteId}
                />
              ))}
              {filtered.length === 0 && searchQuery && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No beliefs match your search.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <CreateEditDialog
        belief={null}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSave={handleCreateSave}
      />

      <CreateEditDialog
        belief={editBelief}
        open={!!editBelief}
        onClose={() => setEditBelief(null)}
        onSave={handleEditSave}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete belief?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteTarget?.claim}". This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
