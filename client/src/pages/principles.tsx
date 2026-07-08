// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { usePageHeader } from "@/hooks/use-page-header";
import { useState, useCallback, useRef, useEffect } from "react";
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
  Plus,
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Pencil,
  Trash2,
  Link2,
  Tag,
  X,
  Check,
  Save,
  RotateCw,
  Compass,
  Layers,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const log = createLogger("Principles");

interface Principle {
  id: string;
  title: string;
  layer1: string;
  layer2: string;
  autoTags: string[];
  manualTags: string[];
  relatedIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface ForgeResult {
  title: string;
  layer1: string;
  layer2: string;
  autoTags: string[];
  relatedIds: string[];
  relatedTitles: string[];
}

function PrincipleCard({
  principle,
  allPrinciples,
  onEdit,
  onDelete,
}: {
  principle: Principle;
  allPrinciples: Principle[];
  onEdit: (p: Principle) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const allTags = Array.from(new Set([...principle.autoTags, ...principle.manualTags]));
  const relatedPrinciples = principle.relatedIds
    .map((id) => allPrinciples.find((p) => p.id === id))
    .filter(Boolean) as Principle[];

  return (
    <Card
      className="group transition-all duration-150 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
      data-testid={`card-principle-${principle.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-medium text-sm leading-tight" data-testid={`text-principle-title-${principle.id}`}>
                  {principle.title}
                </h3>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed" data-testid={`text-principle-layer1-${principle.id}`}>
                  {principle.layer1}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0 invisible group-hover:visible">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => { e.stopPropagation(); onEdit(principle); }}
                      data-testid={`button-edit-${principle.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={(e) => { e.stopPropagation(); onDelete(principle.id); }}
                      data-testid={`button-delete-${principle.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {allTags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs h-5 no-default-hover-elevate">
                    {tag}
                  </Badge>
                ))}
                {relatedPrinciples.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="text-xs h-5 no-default-hover-elevate gap-1">
                        <Link2 className="h-2.5 w-2.5" />
                        {relatedPrinciples.length}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p className="font-medium text-xs mb-1">Related principles</p>
                      {relatedPrinciples.map((rp) => (
                        <p key={rp.id} className="text-xs text-muted-foreground">{rp.title}</p>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}

            {expanded && (
              <div className="mt-3 pt-3 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-1.5 mb-2">
                  <Layers className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Deep Context</span>
                </div>
                <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap" data-testid={`text-principle-layer2-${principle.id}`}>
                  {principle.layer2 || "No expanded context yet."}
                </div>

                {relatedPrinciples.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-border/30">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Link2 className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Related</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {relatedPrinciples.map((rp) => (
                        <Badge key={rp.id} variant="outline" className="text-xs no-default-hover-elevate">
                          {rp.title}
                        </Badge>
                      ))}
                    </div>
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

function ForgeDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (result: ForgeResult) => void;
}) {
  const [step, setStep] = useState<"input" | "review">("input");
  const [rawInput, setRawInput] = useState("");
  const [forgeResult, setForgeResult] = useState<ForgeResult | null>(null);
  const [editedResult, setEditedResult] = useState<ForgeResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  const forgeMutation = useMutation({
    mutationFn: async (input: string) => {
      const res = await apiRequest("POST", "/api/principles/forge", { rawInput: input });
      return res.json() as Promise<ForgeResult>;
    },
    onSuccess: (result) => {
      setForgeResult(result);
      setEditedResult({ ...result });
      setStep("review");
    },
    onError: (err: Error) => {
      log.error("forge failed:", err);
      toast({ title: "Forge failed", description: err.message, variant: "destructive" });
    },
  });

  const handleForge = () => {
    if (!rawInput.trim()) return;
    forgeMutation.mutate(rawInput.trim());
  };

  const handleSave = () => {
    if (editedResult) {
      onSave(editedResult);
      handleReset();
    }
  };

  const handleReset = () => {
    setStep("input");
    setRawInput("");
    setForgeResult(null);
    setEditedResult(null);
    onClose();
  };

  useEffect(() => {
    if (open && step === "input") {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open, step]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleReset(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] sm:max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Compass className="h-4 w-4" />
            {step === "input" ? "Forge a Principle" : "Review & Commit"}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6 flex-1 min-h-0">
          {step === "input" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Write your thought, idea, or principle in any form. The system will distill it into a structured principle.
              </p>
              <Textarea
                ref={textareaRef}
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                placeholder="e.g., 'I think we should always prioritize clarity over cleverness in our code...'"
                className="min-h-[100px] sm:min-h-[160px] resize-none text-sm"
                data-testid="input-forge-raw"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleForge();
                  }
                }}
              />
              <div className="flex justify-end">
                <Button
                  onClick={handleForge}
                  disabled={!rawInput.trim() || forgeMutation.isPending}
                  data-testid="button-forge-submit"
                >
                  {forgeMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Forging...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-2" />
                      Forge Principle
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {step === "review" && editedResult && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</label>
                <Input
                  value={editedResult.title}
                  onChange={(e) => setEditedResult({ ...editedResult, title: e.target.value })}
                  className="mt-1 text-sm"
                  data-testid="input-forge-title"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Layer 1 — The Principle</label>
                <Textarea
                  value={editedResult.layer1}
                  onChange={(e) => setEditedResult({ ...editedResult, layer1: e.target.value })}
                  className="mt-1 min-h-[48px] sm:min-h-[60px] resize-none text-sm"
                  data-testid="input-forge-layer1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Layer 2 — Deep Context</label>
                <Textarea
                  value={editedResult.layer2}
                  onChange={(e) => setEditedResult({ ...editedResult, layer2: e.target.value })}
                  className="mt-1 min-h-[80px] sm:min-h-[120px] resize-none text-sm"
                  data-testid="input-forge-layer2"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
                <div className="flex flex-wrap gap-1 mt-1">
                  {editedResult.autoTags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs gap-1">
                      {tag}
                      <button
                        className="ml-0.5 hover:text-destructive"
                        onClick={() =>
                          setEditedResult({
                            ...editedResult,
                            autoTags: editedResult.autoTags.filter((t) => t !== tag),
                          })
                        }
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
              {editedResult.relatedTitles && editedResult.relatedTitles.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Related Principles</label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {editedResult.relatedTitles.map((title) => (
                      <Badge key={title} variant="outline" className="text-xs no-default-hover-elevate gap-1">
                        <Link2 className="h-2.5 w-2.5" />
                        {title}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
                <Button variant="ghost" onClick={() => { setStep("input"); setForgeResult(null); setEditedResult(null); }}>
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => forgeMutation.mutate(rawInput.trim())}
                    disabled={forgeMutation.isPending}
                    data-testid="button-forge-reforge"
                  >
                    {forgeMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RotateCw className="h-4 w-4 mr-2" />
                    )}
                    Re-forge
                  </Button>
                  <Button onClick={handleSave} data-testid="button-forge-save">
                    <Check className="h-4 w-4 mr-2" />
                    Commit
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  principle,
  allPrinciples,
  onClose,
  onSave,
}: {
  principle: Principle | null;
  allPrinciples: Principle[];
  onClose: () => void;
  onSave: (updated: Partial<Principle>) => void;
}) {
  const [title, setTitle] = useState("");
  const [layer1, setLayer1] = useState("");
  const [layer2, setLayer2] = useState("");
  const [manualTags, setManualTags] = useState<string[]>([]);

  useEffect(() => {
    if (principle) {
      setTitle(principle.title);
      setLayer1(principle.layer1);
      setLayer2(principle.layer2);
      setManualTags([...principle.manualTags]);
    }
  }, [principle]);

  const handleSave = () => {
    onSave({ title, layer1, layer2, manualTags });
    onClose();
  };

  if (!principle) return null;

  return (
    <Dialog open={!!principle} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] sm:max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Edit Principle
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6 flex-1 min-h-0 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 text-sm"
              data-testid="input-edit-title"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Layer 1 — The Principle</label>
            <Textarea
              value={layer1}
              onChange={(e) => setLayer1(e.target.value)}
              className="mt-1 min-h-[48px] sm:min-h-[60px] resize-none text-sm"
              data-testid="input-edit-layer1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Layer 2 — Deep Context</label>
            <Textarea
              value={layer2}
              onChange={(e) => setLayer2(e.target.value)}
              className="mt-1 min-h-[80px] sm:min-h-[120px] resize-none text-sm"
              data-testid="input-edit-layer2"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
            <div className="mt-1">
              <UniversalTagPicker
                tags={manualTags}
                onChange={setManualTags}
                autoTags={principle.autoTags}
                placeholder="Add tag..."
                data-testid="picker-edit-tags"
              />
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} data-testid="button-edit-save">
              <Save className="h-4 w-4 mr-2" />
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PrinciplesPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Principles" });
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [forgeOpen, setForgeOpen] = useState(false);
  const [editPrinciple, setEditPrinciple] = useState<Principle | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: rawData, isLoading } = useQuery<Principle[]>({
    queryKey: ["/api/principles"],
  });
  const principles = Array.isArray(rawData) ? rawData : [];

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Principle>) => {
      const res = await apiRequest("POST", "/api/principles", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Principle created" });
      queryClient.invalidateQueries({ queryKey: ["/api/principles"] });
    },
    onError: (err: Error) => {
      log.error("create failed:", err);
      toast({ title: "Failed to create", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Principle> }) => {
      const res = await apiRequest("PUT", `/api/principles/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Principle updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/principles"] });
    },
    onError: (err: Error) => {
      log.error("update failed:", err);
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/principles/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Principle deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/principles"] });
      setDeleteId(null);
    },
    onError: (err: Error) => {
      log.error("delete failed:", err);
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      setDeleteId(null);
    },
  });

  const handleForgeComplete = useCallback(
    (result: ForgeResult) => {
      createMutation.mutate({
        title: result.title,
        layer1: result.layer1,
        layer2: result.layer2,
        autoTags: result.autoTags,
        relatedIds: result.relatedIds,
      });
    },
    [createMutation]
  );

  const handleEditSave = useCallback(
    (updates: Partial<Principle>) => {
      if (editPrinciple) {
        updateMutation.mutate({ id: editPrinciple.id, updates });
        setEditPrinciple(null);
      }
    },
    [editPrinciple, updateMutation]
  );

  const allTags = Array.from(new Set(principles.flatMap((p) => [...p.autoTags, ...p.manualTags]))).sort();

  const filtered = principles.filter((p) => {
    const matchesSearch =
      !searchQuery ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.layer1.toLowerCase().includes(searchQuery.toLowerCase()) ||
      [...p.autoTags, ...p.manualTags].some((t) =>
        t.toLowerCase().includes(searchQuery.toLowerCase())
      );
    const matchesTag =
      !selectedTag ||
      [...p.autoTags, ...p.manualTags].some((t) => t.toLowerCase() === selectedTag.toLowerCase());
    return matchesSearch && matchesTag;
  });

  const deleteTarget = principles.find((p) => p.id === deleteId);

  if (isLoading) {
    return (
      <div className="flex-1 overflow-hidden p-4 space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden" data-testid="principles-page">
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2">
        <Compass className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 @sm:gap-4 flex-wrap text-sm min-w-0">
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{principles.length}</span> principle{principles.length !== 1 ? "s" : ""}
          </span>
          {allTags.length > 0 && (
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{allTags.length}</span> tag{allTags.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setForgeOpen(true)} data-testid="button-forge-principle">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Forge
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {principles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted/50 p-4 mb-4">
              <Compass className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium text-lg mb-1" data-testid="text-principles-empty-title">No principles yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Principles guide Agent's decisions. Start by forging your first principle from any thought or idea.
            </p>
            <Button onClick={() => setForgeOpen(true)} data-testid="button-forge-first">
              <Sparkles className="h-4 w-4 mr-2" />
              Forge your first principle
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
                  placeholder="Search principles..."
                  className="pl-8 text-sm"
                  data-testid="input-search-principles"
                />
                {searchQuery && (
                  <button
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearchQuery("")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedTag && (
                  <Badge
                    variant="default"
                    className="text-xs cursor-pointer gap-1"
                    onClick={() => setSelectedTag(null)}
                    data-testid="badge-active-tag-filter"
                  >
                    {selectedTag}
                    <X className="h-2.5 w-2.5" />
                  </Badge>
                )}
                {allTags
                  .filter((t) => t !== selectedTag)
                  .map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="text-xs cursor-pointer"
                      onClick={() => setSelectedTag(tag)}
                      data-testid={`badge-tag-filter-${tag}`}
                    >
                      {tag}
                    </Badge>
                  ))}
              </div>
            )}

            <div className="space-y-2">
              {filtered.map((principle) => (
                <PrincipleCard
                  key={principle.id}
                  principle={principle}
                  allPrinciples={principles}
                  onEdit={setEditPrinciple}
                  onDelete={setDeleteId}
                />
              ))}
              {filtered.length === 0 && searchQuery && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No principles match your search.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <ForgeDialog
        open={forgeOpen}
        onClose={() => setForgeOpen(false)}
        onSave={handleForgeComplete}
      />

      <EditDialog
        principle={editPrinciple}
        allPrinciples={principles}
        onClose={() => setEditPrinciple(null)}
        onSave={handleEditSave}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete principle?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteTarget?.title}". This cannot be undone.
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
