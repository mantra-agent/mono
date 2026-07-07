import { usePageHeader } from "@/hooks/use-page-header";
import { useState, useCallback } from "react";
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
  Heart,
  ThumbsUp,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Preference {
  id: string;
  domain: string;
  preference: string;
  evidence: string[];
  confidence: number;
  reinforcements: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function PreferenceCard({
  preference,
  onEdit,
  onDelete,
}: {
  preference: Preference;
  onEdit: (p: Preference) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      className="group transition-all duration-150 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
      data-testid={`card-preference-${preference.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-medium text-sm leading-tight" data-testid={`text-preference-title-${preference.id}`}>
                  {preference.preference}
                </h3>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {preference.domain && (
                    <Badge variant="outline" className="text-xs h-5 no-default-hover-elevate" data-testid={`badge-domain-${preference.id}`}>
                      {preference.domain}
                    </Badge>
                  )}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ThumbsUp className="h-3 w-3" />
                    <span data-testid={`text-reinforcements-${preference.id}`}>{preference.reinforcements}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 invisible group-hover:visible">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onEdit(preference); }} data-testid={`button-edit-${preference.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(preference.id); }} data-testid={`button-delete-${preference.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="mt-2">
              <div className="flex items-center gap-2">
                <Progress value={preference.confidence * 100} className="h-1.5 flex-1" />
                <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-confidence-${preference.id}`}>{Math.round(preference.confidence * 100)}%</span>
              </div>
            </div>

            {preference.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {preference.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs h-5 no-default-hover-elevate">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {expanded && preference.evidence.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Evidence</span>
                <ul className="mt-1 space-y-1">
                  {preference.evidence.map((ev, i) => (
                    <li key={i} className="text-sm text-muted-foreground leading-relaxed flex items-start gap-2">
                      <span className="text-muted-foreground/50 mt-0.5 shrink-0">-</span>
                      <span>{ev}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateEditDialog({
  preference,
  open,
  onClose,
  onSave,
}: {
  preference: Preference | null;
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<Preference>) => void;
}) {
  const isEdit = !!preference;
  const [prefText, setPrefText] = useState("");
  const [domain, setDomain] = useState("");
  const [confidence, setConfidence] = useState(0.5);
  const [evidenceText, setEvidenceText] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  const reset = useCallback(() => {
    if (preference) {
      setPrefText(preference.preference);
      setDomain(preference.domain);
      setConfidence(preference.confidence);
      setEvidenceText(preference.evidence.join("\n"));
      setTags([...preference.tags]);
    } else {
      setPrefText("");
      setDomain("");
      setConfidence(0.5);
      setEvidenceText("");
      setTags([]);
    }
  }, [preference]);

  useState(() => { reset(); });

  const handleSave = () => {
    const evidence = evidenceText.split("\n").map((s) => s.trim()).filter(Boolean);
    onSave({ preference: prefText, domain, confidence, evidence, tags });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); else reset(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] sm:max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Heart className="h-4 w-4" />
            {isEdit ? "Edit Preference" : "Add Preference"}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6 flex-1 min-h-0 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Preference</label>
            <Textarea value={prefText} onChange={(e) => setPrefText(e.target.value)} className="mt-1 min-h-[60px] resize-none text-sm" data-testid="input-preference-text" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Domain</label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} className="mt-1 text-sm" data-testid="input-preference-domain" placeholder="e.g., communication, scheduling" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Confidence ({Math.round(confidence * 100)}%)</label>
            <input type="range" min="0" max="1" step="0.05" value={confidence} onChange={(e) => setConfidence(parseFloat(e.target.value))} className="w-full mt-1" data-testid="input-preference-confidence" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Evidence (one per line)</label>
            <Textarea value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} className="mt-1 min-h-[60px] resize-none text-sm" data-testid="input-preference-evidence" placeholder="Each line is a piece of evidence..." />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
            <div className="mt-1">
              <UniversalTagPicker tags={tags} onChange={setTags} placeholder="Add tag..." />
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!prefText.trim()} data-testid="button-save-preference">
              <Save className="h-4 w-4 mr-2" />
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PreferencesPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Preferences" });
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editPreference, setEditPreference] = useState<Preference | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: rawData, isLoading } = useQuery<Preference[]>({
    queryKey: ["/api/preferences"],
  });
  const preferences = Array.isArray(rawData) ? rawData : [];

  const domains = Array.from(new Set(preferences.map((p) => p.domain).filter(Boolean))).sort();

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Preference>) => {
      const res = await apiRequest("POST", "/api/preferences", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Preference created" });
      queryClient.invalidateQueries({ queryKey: ["/api/preferences"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Preference> }) => {
      const res = await apiRequest("PUT", `/api/preferences/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Preference updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/preferences"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/preferences/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Preference deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/preferences"] });
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      setDeleteId(null);
    },
  });

  const handleCreateSave = useCallback((data: Partial<Preference>) => {
    createMutation.mutate(data);
  }, [createMutation]);

  const handleEditSave = useCallback((updates: Partial<Preference>) => {
    if (editPreference) {
      updateMutation.mutate({ id: editPreference.id, updates });
      setEditPreference(null);
    }
  }, [editPreference, updateMutation]);

  const filtered = preferences.filter((p) => {
    return !searchQuery ||
      p.preference.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.domain.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
  });

  const groupedByDomain = filtered.reduce<Record<string, Preference[]>>((acc, p) => {
    const key = p.domain || "Uncategorized";
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  const deleteTarget = preferences.find((p) => p.id === deleteId);

  if (isLoading) {
    return (
      <div className="flex-1 overflow-hidden p-4 space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden" data-testid="preferences-page">
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2">
        <Heart className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 @sm:gap-4 flex-wrap text-sm min-w-0">
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{preferences.length}</span> preference{preferences.length !== 1 ? "s" : ""}
          </span>
          {domains.length > 0 && (
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{domains.length}</span> domain{domains.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-preference">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Preference
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {preferences.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted/50 p-4 mb-4">
              <Heart className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium text-lg mb-1" data-testid="text-preferences-empty-title">No preferences yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Preferences track learned patterns about how things should be done, grouped by domain.
            </p>
            <Button onClick={() => setCreateOpen(true)} data-testid="button-create-first-preference">
              <Plus className="h-4 w-4 mr-2" />
              Add your first preference
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
                  placeholder="Search preferences..."
                  className="pl-8 text-sm"
                  data-testid="input-search-preferences"
                />
                {searchQuery && (
                  <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearchQuery("")}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {Object.entries(groupedByDomain).sort(([a], [b]) => a.localeCompare(b)).map(([domain, prefs]) => (
              <div key={domain}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{domain}</span>
                  <span className="text-xs text-muted-foreground">({prefs.length})</span>
                </div>
                <div className="space-y-2">
                  {prefs.map((pref) => (
                    <PreferenceCard
                      key={pref.id}
                      preference={pref}
                      onEdit={setEditPreference}
                      onDelete={setDeleteId}
                    />
                  ))}
                </div>
              </div>
            ))}

            {filtered.length === 0 && searchQuery && (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No preferences match your search.
              </div>
            )}
          </div>
        )}
      </div>

      <CreateEditDialog
        preference={null}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSave={handleCreateSave}
      />

      <CreateEditDialog
        preference={editPreference}
        open={!!editPreference}
        onClose={() => setEditPreference(null)}
        onSave={handleEditSave}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preference?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteTarget?.preference}". This cannot be undone.
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
