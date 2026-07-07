import { usePageHeader } from "@/hooks/use-page-header";
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
  ShieldCheck,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Rule {
  id: string;
  rule: string;
  source: "correction" | "reflection" | "manual";
  scope: "always" | "contextual";
  context: string;
  confidence: number;
  reinforcements: number;
  violations: number;
  principleRef: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const sourceLabels: Record<Rule["source"], string> = {
  correction: "Correction",
  reflection: "Reflection",
  manual: "Manual",
};

const scopeLabels: Record<Rule["scope"], string> = {
  always: "Always",
  contextual: "Contextual",
};

function RuleCard({
  rule,
  onEdit,
  onDelete,
  onReinforce,
  onViolation,
}: {
  rule: Rule;
  onEdit: (r: Rule) => void;
  onDelete: (id: string) => void;
  onReinforce: (id: string) => void;
  onViolation: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      className="group transition-all duration-150 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
      data-testid={`card-rule-${rule.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-medium text-sm leading-tight" data-testid={`text-rule-title-${rule.id}`}>
                  {rule.rule}
                </h3>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <Badge variant="outline" className="text-xs h-5 no-default-hover-elevate" data-testid={`badge-scope-${rule.id}`}>
                    {scopeLabels[rule.scope]}
                  </Badge>
                  <Badge variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5 no-default-hover-elevate" data-testid={`badge-source-${rule.id}`}>
                    {sourceLabels[rule.source]}
                  </Badge>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ThumbsUp className="h-3 w-3" />
                    <span data-testid={`text-reinforcements-${rule.id}`}>{rule.reinforcements}</span>
                  </div>
                  {rule.violations > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ThumbsDown className="h-3 w-3" />
                      <span data-testid={`text-violations-${rule.id}`}>{rule.violations}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 invisible group-hover:visible">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onReinforce(rule.id); }} data-testid={`button-reinforce-${rule.id}`}>
                      <ThumbsUp className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reinforce</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onViolation(rule.id); }} data-testid={`button-violation-${rule.id}`}>
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Record Violation</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onEdit(rule); }} data-testid={`button-edit-${rule.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(rule.id); }} data-testid={`button-delete-${rule.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="mt-2">
              <div className="flex items-center gap-2">
                <Progress value={rule.confidence * 100} className="h-1.5 flex-1" />
                <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-confidence-${rule.id}`}>{Math.round(rule.confidence * 100)}%</span>
              </div>
            </div>

            {rule.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {rule.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs h-5 no-default-hover-elevate">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {expanded && rule.context && (
              <div className="mt-3 pt-3 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Context</span>
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap mt-1" data-testid={`text-rule-context-${rule.id}`}>
                  {rule.context}
                </p>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateEditDialog({
  rule,
  open,
  onClose,
  onSave,
}: {
  rule: Rule | null;
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<Rule>) => void;
}) {
  const isEdit = !!rule;
  const [ruleText, setRuleText] = useState("");
  const [source, setSource] = useState<Rule["source"]>("manual");
  const [scope, setScope] = useState<Rule["scope"]>("contextual");
  const [context, setContext] = useState("");
  const [confidence, setConfidence] = useState(0.5);
  const [tags, setTags] = useState<string[]>([]);

  const reset = useCallback(() => {
    if (rule) {
      setRuleText(rule.rule);
      setSource(rule.source);
      setScope(rule.scope);
      setContext(rule.context);
      setConfidence(rule.confidence);
      setTags([...rule.tags]);
    } else {
      setRuleText("");
      setSource("manual");
      setScope("contextual");
      setContext("");
      setConfidence(0.5);
      setTags([]);
    }
  }, [rule]);

  useEffect(() => { reset(); }, [reset]);

  const handleSave = () => {
    onSave({ rule: ruleText, source, scope, context, confidence, tags });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); else reset(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] sm:max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {isEdit ? "Edit Rule" : "Create Rule"}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6 flex-1 min-h-0 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule</label>
            <Textarea value={ruleText} onChange={(e) => setRuleText(e.target.value)} className="mt-1 min-h-[60px] resize-none text-sm" data-testid="input-rule-text" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Source</label>
              <Select value={source} onValueChange={(v) => setSource(v as Rule["source"])}>
                <SelectTrigger className="mt-1" data-testid="select-rule-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="correction">Correction</SelectItem>
                  <SelectItem value="reflection">Reflection</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Scope</label>
              <Select value={scope} onValueChange={(v) => setScope(v as Rule["scope"])}>
                <SelectTrigger className="mt-1" data-testid="select-rule-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="contextual">Contextual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Context</label>
            <Textarea value={context} onChange={(e) => setContext(e.target.value)} className="mt-1 min-h-[48px] resize-none text-sm" data-testid="input-rule-context" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Confidence ({Math.round(confidence * 100)}%)</label>
            <input type="range" min="0" max="1" step="0.05" value={confidence} onChange={(e) => setConfidence(parseFloat(e.target.value))} className="w-full mt-1" data-testid="input-rule-confidence" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
            <div className="mt-1">
              <UniversalTagPicker tags={tags} onChange={setTags} placeholder="Add tag..." />
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!ruleText.trim()} data-testid="button-save-rule">
              <Save className="h-4 w-4 mr-2" />
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function RulesPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Rules" });
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editRule, setEditRule] = useState<Rule | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: rawData, isLoading } = useQuery<Rule[]>({
    queryKey: ["/api/rules"],
  });
  const rules = Array.isArray(rawData) ? rawData : [];

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Rule>) => {
      const res = await apiRequest("POST", "/api/rules", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule created" });
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Rule> }) => {
      const res = await apiRequest("PUT", `/api/rules/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/rules/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      setDeleteId(null);
    },
  });

  const reinforceMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/rules/${id}/reinforce`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule reinforced" });
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to reinforce", description: err.message, variant: "destructive" });
    },
  });

  const violationMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/rules/${id}/violation`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Violation recorded" });
      queryClient.invalidateQueries({ queryKey: ["/api/rules"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to record violation", description: err.message, variant: "destructive" });
    },
  });

  const handleCreateSave = useCallback((data: Partial<Rule>) => {
    createMutation.mutate(data);
  }, [createMutation]);

  const handleEditSave = useCallback((updates: Partial<Rule>) => {
    if (editRule) {
      updateMutation.mutate({ id: editRule.id, updates });
      setEditRule(null);
    }
  }, [editRule, updateMutation]);

  const filtered = rules.filter((r) => {
    return !searchQuery ||
      r.rule.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.context.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
  });

  const deleteTarget = rules.find((r) => r.id === deleteId);

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
    <div className="flex flex-col h-full min-w-0 overflow-hidden" data-testid="rules-page">
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 @sm:gap-4 flex-wrap text-sm min-w-0">
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{rules.length}</span> rule{rules.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-rule">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Create Rule
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-muted/50 p-4 mb-4">
              <ShieldCheck className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium text-lg mb-1" data-testid="text-rules-empty-title">No rules yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              Rules are behavioral guidelines extracted from decisions and corrections.
            </p>
            <Button onClick={() => setCreateOpen(true)} data-testid="button-create-first-rule">
              <Plus className="h-4 w-4 mr-2" />
              Create your first rule
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
                  placeholder="Search rules..."
                  className="pl-8 text-sm"
                  data-testid="input-search-rules"
                />
                {searchQuery && (
                  <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearchQuery("")}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {filtered.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  onEdit={setEditRule}
                  onDelete={setDeleteId}
                  onReinforce={(id) => reinforceMutation.mutate(id)}
                  onViolation={(id) => violationMutation.mutate(id)}
                />
              ))}
              {filtered.length === 0 && searchQuery && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No rules match your search.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <CreateEditDialog
        rule={null}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSave={handleCreateSave}
      />

      <CreateEditDialog
        rule={editRule}
        open={!!editRule}
        onClose={() => setEditRule(null)}
        onSave={handleEditSave}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this rule. This cannot be undone.
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
