import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
// focus context removed — inline expansion, no selection model
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
// useIsMobile removed — single-column layout
import { formatDistanceToNow } from "date-fns";

import {
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  Lightbulb,
  X,
  BookOpen,
  Download,
  Upload,
  Pin,

  ExternalLink,
  History,
  MoreVertical,
  Search,
  FileText,
  PauseCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useSkillFailures } from "@/components/skill-failure-indicator";
import type {
  SkillWithReferences,
  SkillWriteCategory,
  SkillInputType,
  SkillScore,
  SkillRun,
  ChecklistItem,
  CheckResult,
} from "@shared/models/skills";
import type { PromptModule } from "@shared/models/prompt-modules";

const WRITE_CATEGORIES: SkillWriteCategory[] = ["read-only", "internal-data", "internal-control", "external", "destructive"];
const INPUT_TYPES: SkillInputType[] = ["task", "people", "memories", "events", "files", "project"];

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function SkillTreeRow({
  skill,
  expanded,
  hasFailed,
  onToggleExpand,
  onEdit,
  onDelete,
  onExport,
  onPin,
}: {
  skill: SkillWithReferences;
  expanded: boolean;
  hasFailed: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
  onPin: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div data-testid={`skill-row-${skill.id}`}>
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-md px-2 py-1.5 pr-16 text-sm w-full text-left cursor-pointer select-none transition-colors overflow-hidden",
          expanded ? "bg-accent text-foreground" : "hover:bg-accent/70 hover:text-foreground",
          hasFailed ? "text-error" : "text-muted-foreground"
        )}
        onClick={onToggleExpand}
        data-testid={`button-skill-${skill.id}`}
      >
        <span className="flex items-center justify-center shrink-0">
          <Lightbulb className={cn("h-3.5 w-3.5 shrink-0", hasFailed && "text-error")} />
        </span>
        <span className="flex-1 min-w-0 truncate">{skill.name}</span>
        {/* Expand/collapse twisty — absolute right-8 per hierarchy tree standard */}
        <button
          type="button"
          className="absolute right-8 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors z-10"
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          aria-label={expanded ? "Collapse details" : "Expand details"}
          data-testid={`button-skill-twisty-${skill.id}`}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
        </button>
        {/* Overflow menu — absolute right-1 per hierarchy tree standard */}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center h-6 w-6 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent",
                expanded ? "bg-accent" : "bg-accent/50"
              )}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(true); }}
              data-testid={`button-skill-menu-${skill.id}`}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onPin(); }} data-testid="menu-pin-skill">
              <Pin className={cn("h-3.5 w-3.5 mr-2", skill.pinnedToContext && "fill-current text-info")} />
              {skill.pinnedToContext ? "Unpin from Context" : "Pin to Context"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onEdit(); }} data-testid="menu-edit-skill">
              <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onExport(); }} data-testid="menu-export-skill">
              <Download className="h-3.5 w-3.5 mr-2" /> Export
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onDelete(); }} className="text-destructive" data-testid="menu-delete-skill">
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <SkillInlineDetail skill={skill} />
      )}
    </div>
  );
}

function SkillInlineDetail({ skill }: { skill: SkillWithReferences }) {
  return (
    <div className="ml-5 mr-1 mb-2 mt-1 space-y-3 border-l border-border/50 pl-3">
      <div className="flex items-center gap-1 flex-wrap">
        {skill.category && (
          <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 capitalize">{skill.category}</Badge>
        )}
        {skill.author === "system" && (
          <span className="inline-flex items-center bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5 h-4">built-in</span>
        )}
        <span className="text-xs text-muted-foreground">v{skill.version} · {skill.estimatedTokens.toLocaleString()} tokens · {skill.writeCategory}</span>
      </div>
      <p className="text-xs text-muted-foreground">{skill.description}</p>

      {skill.whenToUse && (
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block font-medium">When to Use</Label>
          <pre className="text-xs bg-muted/50 rounded-md p-2 whitespace-pre-wrap max-h-32 overflow-y-auto" data-testid="text-when-to-use">
            {skill.whenToUse}
          </pre>
        </div>
      )}

      <CollapsibleSection title="Process">
        <pre className="text-xs bg-muted/50 rounded-md p-2 whitespace-pre-wrap max-h-48 overflow-y-auto" data-testid="text-process">
          {skill.process}
        </pre>
      </CollapsibleSection>

      <CollapsibleSection title="Output Spec">
        <pre className="text-xs bg-muted/50 rounded-md p-2 whitespace-pre-wrap max-h-32 overflow-y-auto" data-testid="text-output-spec">
          {skill.outputSpec}
        </pre>
      </CollapsibleSection>

      <CollapsibleSection title="Checklist">
        {Array.isArray(skill.checklist) && (skill.checklist as ChecklistItem[]).length > 0 ? (
          <ul className="space-y-1" data-testid="list-checklist">
            {(skill.checklist as ChecklistItem[]).map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-xs bg-muted/50 rounded-md px-2 py-1.5" data-testid={`text-checklist-item-${i}`}>
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <span className="flex-1">{item.check}</span>
                {item.weight != null && item.weight !== 1 && (
                  <span className="text-muted-foreground shrink-0">w:{item.weight}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground italic" data-testid="text-checklist-empty">No custom checklist — default scoring checklist will be used.</p>
        )}
      </CollapsibleSection>

      {skill.inputs.length > 0 && (
        <CollapsibleSection title="Inputs">
          <div className="flex flex-wrap gap-1">
            {skill.inputs.map((input, i) => (
              <Badge key={i} variant="outline" className="text-xs">{input}</Badge>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {skill.references.length > 0 && (
        <CollapsibleSection title={`References (${skill.references.length})`}>
          <div className="space-y-2">
            {skill.references.map((ref) => (
              <div key={ref.id} className="bg-muted/50 rounded-md p-2">
                <span className="text-xs font-medium flex items-center gap-1 mb-1">
                  <BookOpen className="h-3 w-3" />
                  {ref.name}
                </span>
                <pre className="text-xs whitespace-pre-wrap max-h-20 overflow-y-auto">{ref.content}</pre>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      <RunHistorySection skillName={skill.name} />
    </div>
  );
}

function SkillTreeSection({
  title,
  children,
  defaultOpen = true,
  isEmpty = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  isEmpty?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (isEmpty) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="truncate">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0.5 pb-1">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SkillListSidebar({
  skills,
  lastRuns,
  isLoading,
  onCreate,
  onImport,
  onExportAll,
  onEdit,
  onDelete,
  onExport,
  onPin,
  failedNames,
}: {
  skills: SkillWithReferences[];
  lastRuns: Record<string, string>;
  isLoading: boolean;
  onCreate: () => void;
  onImport: () => void;
  onExportAll: () => void;
  onEdit: (skill: SkillWithReferences) => void;
  onDelete: (skill: SkillWithReferences) => void;
  onExport: (skill: SkillWithReferences) => void;
  onPin: (skill: SkillWithReferences) => void;
  failedNames: Set<string>;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [globalMenuOpen, setGlobalMenuOpen] = useState(false);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sorted = useMemo(() => {
    let filtered = skills;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = skills.filter(s => s.name.toLowerCase().includes(q));
    }

    const pinned: SkillWithReferences[] = [];
    const unpinned: SkillWithReferences[] = [];
    for (const s of filtered) {
      if (s.pinnedToContext) {
        pinned.push(s);
      } else {
        unpinned.push(s);
      }
    }

    const sortGroup = (group: SkillWithReferences[]) => {
      const withRun: SkillWithReferences[] = [];
      const withoutRun: SkillWithReferences[] = [];
      for (const s of group) {
        if (lastRuns[s.name]) {
          withRun.push(s);
        } else {
          withoutRun.push(s);
        }
      }
      withRun.sort((a, b) => {
        const aTime = new Date(lastRuns[a.name]).getTime();
        const bTime = new Date(lastRuns[b.name]).getTime();
        return bTime - aTime;
      });
      withoutRun.sort((a, b) => a.name.localeCompare(b.name));
      return [...withRun, ...withoutRun];
    };

    return {
      pinned: sortGroup(pinned),
      skills: sortGroup(unpinned),
    };
  }, [skills, lastRuns, searchQuery]);

  const renderRows = (items: SkillWithReferences[]) => items.map(skill => (
    <SkillTreeRow
      key={skill.id}
      skill={skill}
      expanded={expandedIds.has(skill.id)}
      hasFailed={failedNames.has(skill.name)}
      onToggleExpand={() => toggleExpanded(skill.id)}
      onEdit={() => onEdit(skill)}
      onDelete={() => onDelete(skill)}
      onExport={() => onExport(skill)}
      onPin={() => onPin(skill)}
    />
  ));

  const total = sorted.pinned.length + sorted.skills.length;

  return (
    <ScrollArea className="flex-1">
      <div className="min-w-0 p-2 space-y-1">
        {/* Search bar + global overflow */}
        <div className="flex items-center gap-1 mb-1">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-7 pl-7 pr-7 rounded-md border border-input bg-background text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="input-filter-skills"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                data-testid="button-clear-search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <DropdownMenu open={globalMenuOpen} onOpenChange={setGlobalMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" data-testid="button-skills-overflow">
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { setGlobalMenuOpen(false); onImport(); }} data-testid="menu-import-skills">
                <Upload className="h-3.5 w-3.5 mr-2" /> Import
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setGlobalMenuOpen(false); onExportAll(); }} data-testid="menu-export-all-skills">
                <Download className="h-3.5 w-3.5 mr-2" /> Export All
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* + New Skill button */}
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors"
          data-testid="button-create-skill"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Skill</span>
        </button>
        {isLoading ? (
          <div className="space-y-2 pt-2">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
          </div>
        ) : total === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="empty-skills-list">
            {searchQuery.trim() ? "No matching skills." : "No skills yet."}
          </div>
        ) : (
          <div className="space-y-1">
            <SkillTreeSection title="PINNED" isEmpty={sorted.pinned.length === 0}>
              {renderRows(sorted.pinned)}
            </SkillTreeSection>
            <SkillTreeSection title="SKILLS" isEmpty={sorted.skills.length === 0}>
              {renderRows(sorted.skills)}
            </SkillTreeSection>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full text-left py-1 hover:bg-muted/30 rounded px-1 transition-colors" data-testid={`button-toggle-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {open ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-4 pt-1 pb-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ChecklistResultsView({ results, comparativeWinner, comparativeReason }: {
  results: CheckResult[];
  comparativeWinner?: string | null;
  comparativeReason?: string | null;
}) {
  return (
    <div className="pl-6 pr-2 pb-2 space-y-1" data-testid="section-checklist-results">
      {results.map((result, i) => (
        <div
          key={i}
          className="flex items-start gap-2 text-xs bg-muted/40 rounded px-2 py-1.5"
          data-testid={`row-checklist-result-${i}`}
        >
          {result.passed ? (
            <CheckCircle2 className="h-3 w-3 mt-0.5 text-success shrink-0" />
          ) : (
            <XCircle className="h-3 w-3 mt-0.5 text-error shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">{result.check}</div>
            {result.evidence && (
              <div className="text-muted-foreground mt-0.5">{result.evidence}</div>
            )}
          </div>
        </div>
      ))}
      {comparativeWinner && (
        <div className="flex items-start gap-2 text-xs bg-muted/40 rounded px-2 py-1.5 border-l-2 border-info" data-testid="row-comparative-result">
          <span className="font-medium text-info-foreground">Comparative:</span>
          <span className="text-muted-foreground">
            Winner: <span className="font-medium text-foreground">{comparativeWinner}</span>
            {comparativeReason && ` — ${comparativeReason}`}
          </span>
        </div>
      )}
    </div>
  );
}

function RunStatusIcon({ status, passRate }: { status: string; passRate?: number | null }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 text-info shrink-0 animate-spin" />;
  if (status === "yielded") return <Clock className="h-3.5 w-3.5 text-warning shrink-0" />;
  if (status === "checkpoint") return <PauseCircle className="h-3.5 w-3.5 text-info shrink-0" />;
  if (status === "degraded") return <AlertCircle className="h-3.5 w-3.5 text-warning shrink-0" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-error shrink-0" />;
  if (passRate != null) {
    if (passRate > 0.5) return <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />;
    if (passRate >= 0.3) return <AlertCircle className="h-3.5 w-3.5 text-warning shrink-0" />;
    return <XCircle className="h-3.5 w-3.5 text-error shrink-0" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />;
}

function RunHistorySection({ skillName }: { skillName: string }) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const { data: runs, isLoading: runsLoading } = useQuery<SkillRun[]>({
    queryKey: ["/api/skills", skillName, "runs"],
    queryFn: async () => {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/runs?limit=20`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: !!skillName,
  });

  const { data: scores, isLoading: scoresLoading } = useQuery<SkillScore[]>({
    queryKey: ["/api/skills", skillName, "scores"],
    queryFn: async () => {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/scores?limit=20`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: !!skillName && (!runs || runs.length === 0),
  });

  const isLoading = runsLoading || ((!runs || runs.length === 0) && scoresLoading);
  const hasRuns = runs && runs.length > 0;

  const sessionIds = useMemo(() => {
    if (hasRuns) return runs.filter(r => r.sessionId).map(r => r.sessionId);
    if (!scores) return [];
    return scores.filter(s => s.sessionId).map(s => s.sessionId);
  }, [runs, scores, hasRuns]);

  const { data: libraryPageMap = {} } = useQuery<Record<string, { id: string; title: string; slug: string }[]>>({
    queryKey: ["/api/skills/library-pages-by-sessions", skillName, sessionIds],
    queryFn: async () => {
      if (sessionIds.length === 0) return {};
      const res = await apiRequest("POST", "/api/skills/library-pages-by-sessions", { sessionIds });
      return res.json();
    },
    enabled: sessionIds.length > 0,
  });

  const toggleExpanded = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const items = hasRuns ? runs : (scores || []);
  const isEmpty = items.length === 0;

  return (
    <div className="border-t border-border pt-3" data-testid="section-run-history">
      <div className="flex items-center gap-1.5 mb-2 px-1">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Run History</span>
      </div>

      {isLoading ? (
        <div className="space-y-2 px-1">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full rounded" />)}
        </div>
      ) : isEmpty ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="empty-run-history">No runs yet.</div>
      ) : hasRuns ? (
        <div className="space-y-1 px-1">
          {runs.map(run => {
            const isExpanded = expandedIds.has(run.id);
            const checklistResults = Array.isArray(run.checklistResults) ? run.checklistResults as CheckResult[] : [];
            const pages = run.sessionId ? libraryPageMap[run.sessionId] : undefined;
            const pct = run.passRate != null ? Math.round(run.passRate * 100) : null;
            return (
              <div key={run.id} data-testid={`row-run-${run.id}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpanded(run.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(run.id); } }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 transition-colors text-xs w-full text-left cursor-pointer"
                  data-testid={`button-expand-run-${run.id}`}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  )}
                  <RunStatusIcon status={run.status} passRate={run.passRate} />
                  {pct != null ? (
                    <span className={cn("font-medium", pct > 50 ? "text-success-foreground" : pct >= 30 ? "text-warning-foreground" : "text-error-foreground")}>
                      {pct}%
                    </span>
                  ) : (
                    <span className={cn("font-medium capitalize",
                      run.status === "succeeded" ? "text-success-foreground" :
                      run.status === "running" ? "text-info-foreground" :
                      run.status === "checkpoint" ? "text-info" :
                      run.status === "degraded" ? "text-warning-foreground" :
                      run.status === "yielded" ? "text-warning-foreground" : "text-error-foreground"
                    )}>
                      {run.status}
                    </span>
                  )}
                  {run.durationMs != null && (
                    <span className="text-muted-foreground">
                      {run.durationMs >= 60000
                        ? `${Math.round(run.durationMs / 60000)}m`
                        : `${Math.round(run.durationMs / 1000)}s`}
                    </span>
                  )}
                  {pages && pages.length > 0 && (
                    <span className="flex items-center gap-0.5">
                      {pages.map(p => (
                        <a
                          key={p.id}
                          href={`/info#library?page=${p.slug}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-primary hover:underline"
                          title={p.title}
                          data-testid={`link-library-page-${p.id}`}
                        >
                          <FileText className="h-3 w-3" />
                        </a>
                      ))}
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto">
                    {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}
                  </span>
                  {run.sessionId && (
                    <a
                      href={`/session?c=${encodeURIComponent(run.sessionId)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-primary hover:underline shrink-0"
                      title="View session"
                      data-testid={`link-session-${run.id}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                {isExpanded && (
                  <>
                    {run.failureReason && (
                      <div className="pl-6 pr-2 pb-2" data-testid={`section-failure-reason-${run.id}`}>
                        <div className="text-xs bg-error/10 border border-error/20 rounded px-3 py-2 text-error-foreground">
                          {run.failureReason}
                        </div>
                      </div>
                    )}
                    {(checklistResults.length > 0 || run.comparativeWinner) && (
                      <ChecklistResultsView
                        results={checklistResults}
                        comparativeWinner={run.comparativeWinner}
                        comparativeReason={run.comparativeReason}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-1 px-1">
          {(scores || []).map(score => {
            const passed = score.passRate > 0.5;
            const partial = score.passRate >= 0.3 && score.passRate <= 0.5;
            const pct = Math.round(score.passRate * 100);
            const isExpanded = expandedIds.has(score.id);
            const checklistResults = Array.isArray(score.checklistResults) ? score.checklistResults as CheckResult[] : [];
            const pages = score.sessionId ? libraryPageMap[score.sessionId] : undefined;
            return (
              <div key={score.id} data-testid={`row-run-${score.id}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpanded(score.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(score.id); } }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 transition-colors text-xs w-full text-left cursor-pointer"
                  data-testid={`button-expand-run-${score.id}`}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  )}
                  {passed ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                  ) : partial ? (
                    <AlertCircle className="h-3.5 w-3.5 text-warning shrink-0" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-error shrink-0" />
                  )}
                  <span className={cn("font-medium", passed ? "text-success-foreground" : partial ? "text-warning-foreground" : "text-error-foreground")}>
                    {pct}%
                  </span>
                  {score.durationMs != null && (
                    <span className="text-muted-foreground">
                      {score.durationMs >= 60000
                        ? `${Math.round(score.durationMs / 60000)}m`
                        : `${Math.round(score.durationMs / 1000)}s`}
                    </span>
                  )}
                  {pages && pages.length > 0 && (
                    <span className="flex items-center gap-0.5">
                      {pages.map(p => (
                        <a
                          key={p.id}
                          href={`/info#library?page=${p.slug}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-primary hover:underline"
                          title={p.title}
                          data-testid={`link-library-page-${p.id}`}
                        >
                          <FileText className="h-3 w-3" />
                        </a>
                      ))}
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto">
                    {formatDistanceToNow(new Date(score.scoredAt), { addSuffix: true })}
                  </span>
                  {score.sessionId && (
                    <a
                      href={`/session?c=${encodeURIComponent(score.sessionId)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-primary hover:underline shrink-0"
                      title="View session"
                      data-testid={`link-session-${score.id}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                {isExpanded && (checklistResults.length > 0 || score.comparativeWinner) && (
                  <ChecklistResultsView
                    results={checklistResults}
                    comparativeWinner={score.comparativeWinner}
                    comparativeReason={score.comparativeReason}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
      setInput("");
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          placeholder={placeholder}
          className="h-8 text-xs"
          data-testid="input-tag"
        />
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addTag} data-testid="button-add-tag">
          <Plus className="h-3 w-3" />
        </Button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((tag, i) => (
            <span key={i} className="inline-flex items-center bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium font-mono px-2 py-0.5">
              {tag}
              <button
                type="button"
                className="ml-1 hover:text-destructive"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                data-testid={`button-remove-tag-${i}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillEditorDialog({
  open,
  onOpenChange,
  editingSkill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingSkill: SkillWithReferences | null;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("other");
  const [activity, setActivity] = useState("e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d");
  const [writeCategory, setWriteCategory] = useState<SkillWriteCategory>("read-only");
  const [inputs, setInputs] = useState<SkillInputType[]>([]);
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [estimatedDuration, setEstimatedDuration] = useState("5min");
  const [whenToUse, setWhenToUse] = useState("");
  const [process, setProcess] = useState("");
  const [outputSpec, setOutputSpec] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [addToMemory, setAddToMemory] = useState(true);
  const [sessionType, setSessionType] = useState<string>("agent");
  const [personaChoice, setPersonaChoice] = useState<number | "recommended">("recommended");
  const personaTouchedRef = useRef(false);
  const [version, setVersion] = useState("1.0");
  const [author, setAuthor] = useState("user");
  const [references, setReferences] = useState<{ name: string; content: string }[]>([]);

  useEffect(() => {
    if (editingSkill) {
      setName(editingSkill.name);
      setDescription(editingSkill.description);
      setCategory(editingSkill.category || "other");
      setActivity(editingSkill.activity || "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d");
      setWriteCategory(editingSkill.writeCategory as SkillWriteCategory);
      setInputs(editingSkill.inputs as SkillInputType[]);
      setEstimatedTokens(editingSkill.estimatedTokens);
      setEstimatedDuration(editingSkill.estimatedDuration);
      setWhenToUse(editingSkill.whenToUse);
      setProcess(editingSkill.process);
      setOutputSpec(editingSkill.outputSpec);
      setChecklist(Array.isArray(editingSkill.checklist) ? editingSkill.checklist as ChecklistItem[] : []);
      setAddToMemory(editingSkill.addToMemory !== false);
      setSessionType(editingSkill.sessionType || "agent");
      setVersion(editingSkill.version);
      setAuthor(editingSkill.author);
      setReferences(editingSkill.references.map(r => ({ name: r.name, content: r.content })));
    } else {
      setName("");
      setDescription("");
      setCategory("other");
      setActivity("e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d");
      setWriteCategory("read-only");
      setInputs([]);
      setEstimatedTokens(0);
      setEstimatedDuration("5min");
      setWhenToUse("");
      setProcess("");
      setOutputSpec("");
      setChecklist([]);
      setAddToMemory(true);
      setSessionType("agent");
      setVersion("1.0");
      setAuthor("user");
      setReferences([]);
    }
  }, [editingSkill, open]);

  const { data: personas = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/personas"],
    enabled: open,
  });

  const { data: personaConfig } = useQuery<{
    preferences: Record<string, number>;
    recommendations: Record<string, { templateId: number; name: string }>;
  }>({
    queryKey: ["/api/skills/persona-config"],
    enabled: open,
  });

  // Hydrate the persona choice from the user's saved preference. "recommended"
  // means no override: the run falls back to the product recommendation.
  useEffect(() => {
    if (!open) {
      personaTouchedRef.current = false;
      return;
    }
    if (personaTouchedRef.current) return;
    const saved = editingSkill
      ? personaConfig?.preferences[editingSkill.id]
      : undefined;
    setPersonaChoice(typeof saved === "number" ? saved : "recommended");
  }, [open, editingSkill, personaConfig]);

  const recommendedName = editingSkill
    ? personaConfig?.recommendations[editingSkill.id]?.name ?? null
    : null;

  const savePersonaPreference = async (skillId: string) => {
    if (!personaTouchedRef.current) return;
    await apiRequest("PUT", `/api/skills/${skillId}/persona-preference`, {
      personaId: personaChoice === "recommended" ? null : personaChoice,
    });
    await queryClient.invalidateQueries({
      queryKey: ["/api/skills/persona-config"],
    });
  };

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/skills", data);
      const skill = await res.json() as { id: string };
      await savePersonaPreference(skill.id);
      return skill;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      onOpenChange(false);
      toast({ title: "Skill created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create skill", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/skills/${editingSkill!.id}`, data);
      const skill = await res.json() as { id: string };
      await savePersonaPreference(skill.id);
      return skill;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      onOpenChange(false);
      toast({ title: "Skill updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update skill", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    const validChecklist = checklist.filter(item => item.check.trim().length > 0);
    const data = {
      name,
      description,
      category,
      activity,
      authority: editingSkill?.authority || "full",
      writeCategory,
      inputs,
      estimatedTokens,
      estimatedDuration,
      whenToUse,
      process,
      outputSpec,
      qualityCriteria: editingSkill?.qualityCriteria || "",
      checklist: validChecklist,
      addToMemory,
      sessionType,
      status: editingSkill?.status || "draft",
      version,
      author,
      references,
    };
    if (editingSkill) {
      updateMutation.mutate(data);
    } else {
      createMutation.mutate(data);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const toggleInput = (input: SkillInputType) => {
    setInputs(prev =>
      prev.includes(input)
        ? prev.filter(i => i !== input)
        : [...prev, input]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-skill-editor">
        <DialogHeader>
          <DialogTitle data-testid="text-dialog-title">{editingSkill ? "Edit Skill" : "New Skill"}</DialogTitle>
          <DialogDescription>
            {editingSkill ? "Modify the skill definition below." : "Define a new compound capability."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identity</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill-name" className="h-8 text-xs font-mono" data-testid="input-skill-name" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs mb-1 block">Category</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["memory", "thinking", "chat", "goals", "people", "projects", "strategy", "reflection", "other"].map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Version</Label>
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} className="h-8 text-xs" data-testid="input-version" />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Author</Label>
                  <Input value={author} onChange={(e) => setAuthor(e.target.value)} className="h-8 text-xs" data-testid="input-author" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Activity</Label>
                <Select value={activity} onValueChange={setActivity}>
                  <SelectTrigger className="h-8 text-xs" data-testid="input-activity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="c7a1e3b4-5d2f-4a89-b6e0-1f8c9d2e3a4b">Chat</SelectItem>
                    <SelectItem value="d8b2f4c5-6e3a-4b90-c7f1-2a9d0e3f4b5c">Work</SelectItem>
                    <SelectItem value="e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d">Framing</SelectItem>
                    <SelectItem value="f0d4b6e7-8a5c-4d12-e9b3-4c1f2a5b6d7e">Recall</SelectItem>
                    <SelectItem value="a1e5c7f8-9b6d-4e23-f0c4-5d2a3b6c7e8f">Memory</SelectItem>
                    <SelectItem value="b2f6d8a9-0c7e-4f34-a1d5-6e3b4c7d8f0a">Thinking</SelectItem>
                    <SelectItem value="c3a7e9b0-1d8f-4a45-b2e6-7f4c5d8e9a1b">Strategy</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Persona</Label>
                <Select
                  value={personaChoice === "recommended" ? "recommended" : String(personaChoice)}
                  onValueChange={(v) => {
                    personaTouchedRef.current = true;
                    setPersonaChoice(v === "recommended" ? "recommended" : Number(v));
                  }}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid="select-persona">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recommended">
                      {recommendedName ? `Recommended · ${recommendedName}` : "Default persona"}
                    </SelectItem>
                    {personas.map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this skill does and when to use it..." className="text-xs min-h-[60px]" data-testid="input-description" />
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Write Category</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Write Category</Label>
                <Select value={writeCategory} onValueChange={(v) => setWriteCategory(v as SkillWriteCategory)}>
                  <SelectTrigger className="h-8 text-xs" data-testid="select-write-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WRITE_CATEGORIES.map(c => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>


          <div className="space-y-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Inputs</h4>
            <div className="flex flex-wrap gap-1.5">
              {INPUT_TYPES.map(type => (
                <Badge
                  key={type}
                  variant={inputs.includes(type) ? "default" : "outline"}
                  className="text-xs cursor-pointer select-none"
                  onClick={() => toggleInput(type)}
                  data-testid={`toggle-input-${type}`}
                >
                  {type}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Cost Envelope</h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Est. Tokens</Label>
                <Input type="number" value={estimatedTokens} onChange={(e) => setEstimatedTokens(parseInt(e.target.value) || 0)} className="h-8 text-xs" data-testid="input-estimated-tokens" />
              </div>
              <div>
                <Label className="text-xs mb-1 block">Est. Duration</Label>
                <Input value={estimatedDuration} onChange={(e) => setEstimatedDuration(e.target.value)} placeholder="5min" className="h-8 text-xs" data-testid="input-estimated-duration" />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Instructions</h4>
            <div>
              <Label className="text-xs mb-1 block">When to Use</Label>
              <Textarea value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} placeholder="Conditions that indicate this skill matches a task..." className="text-xs min-h-[60px]" data-testid="input-when-to-use" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Process</Label>
              <Textarea value={process} onChange={(e) => setProcess(e.target.value)} placeholder="Step-by-step workflow..." className="text-xs min-h-[80px]" data-testid="input-process" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Output Spec</Label>
              <Textarea value={outputSpec} onChange={(e) => setOutputSpec(e.target.value)} placeholder="What it produces and where each output goes..." className="text-xs min-h-[60px]" data-testid="input-output-spec" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs mb-0 block">Checklist</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setChecklist([...checklist, { check: "", weight: 1 }])}
                  data-testid="button-add-checklist-item"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add Check
                </Button>
              </div>
              {checklist.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No checklist items. A default checklist will be used for scoring.</p>
              )}
              {checklist.map((item, i) => (
                <div key={i} className="flex items-start gap-2 border rounded-md p-2" data-testid={`checklist-item-${i}`}>
                  <div className="flex-1">
                    <Input
                      value={item.check}
                      onChange={(e) => {
                        const next = [...checklist];
                        next[i] = { ...next[i], check: e.target.value };
                        setChecklist(next);
                      }}
                      placeholder="What to verify..."
                      className="h-7 text-xs"
                      data-testid={`input-checklist-check-${i}`}
                    />
                  </div>
                  <div className="w-16">
                    <Input
                      type="number"
                      value={item.weight ?? 1}
                      onChange={(e) => {
                        const next = [...checklist];
                        next[i] = { ...next[i], weight: parseFloat(e.target.value) || 1 };
                        setChecklist(next);
                      }}
                      min={0}
                      step={0.5}
                      className="h-7 text-xs"
                      title="Weight"
                      data-testid={`input-checklist-weight-${i}`}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive shrink-0"
                    onClick={() => setChecklist(checklist.filter((_, j) => j !== i))}
                    data-testid={`button-remove-checklist-item-${i}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={addToMemory}
                onChange={(e) => setAddToMemory(e.target.checked)}
                id="add-to-memory"
                className="h-4 w-4 rounded border-border"
                data-testid="toggle-add-to-memory"
              />
              <Label htmlFor="add-to-memory" className="text-xs cursor-pointer">Add exchanges to memory</Label>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Session Type</Label>
              <Select value={sessionType || "agent"} onValueChange={(v) => setSessionType(v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-session-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="autonomous">Auto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">References</h4>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setReferences([...references, { name: "", content: "" }])}
                data-testid="button-add-reference"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
            {references.map((ref, i) => (
              <div key={i} className="border rounded-md p-3 space-y-2 relative">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 absolute top-2 right-2 text-destructive"
                  onClick={() => setReferences(references.filter((_, j) => j !== i))}
                  data-testid={`button-remove-reference-${i}`}
                >
                  <X className="h-3 w-3" />
                </Button>
                <div>
                  <Label className="text-xs mb-1 block">Name</Label>
                  <Input
                    value={ref.name}
                    onChange={(e) => {
                      const next = [...references];
                      next[i] = { ...next[i], name: e.target.value };
                      setReferences(next);
                    }}
                    placeholder="reference-name"
                    className="h-8 text-xs"
                    data-testid={`input-reference-name-${i}`}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Content</Label>
                  <Textarea
                    value={ref.content}
                    onChange={(e) => {
                      const next = [...references];
                      next[i] = { ...next[i], content: e.target.value };
                      setReferences(next);
                    }}
                    placeholder="Reference content loaded into context on activation..."
                    className="text-xs min-h-[40px]"
                    data-testid={`input-reference-content-${i}`}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending} data-testid="button-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !name || !description || !whenToUse || !process || !outputSpec}
              data-testid="button-save-skill"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {editingSkill ? "Save Changes" : "Create Skill"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SkillsContent({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Skills", skip: !!embedded });
  const { toast } = useToast();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillWithReferences | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<SkillWithReferences | null>(null);
  const { unseenNames } = useSkillFailures();

  const { data: allSkills = [], isLoading } = useQuery<SkillWithReferences[]>({
    queryKey: ["/api/skills"],
  });

  const { data: promptModules = [] } = useQuery<PromptModule[]>({
    queryKey: ["/api/prompt-modules"],
  });

  const hiddenInternalPromptSkillNames = useMemo(() => new Set(
    promptModules
      .map((module) => module.sourceSkillName)
      .filter((name): name is string => Boolean(name))
  ), [promptModules]);

  const skills = useMemo(() =>
    allSkills.filter((skill) => !hiddenInternalPromptSkillNames.has(skill.name)),
    [allSkills, hiddenInternalPromptSkillNames]
  );

  const { data: lastRuns = {} } = useQuery<Record<string, string>>({
    queryKey: ["/api/skills/last-runs"],
  });

  // No selection model — details expand inline per row

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/skills/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      setDeletingSkill(null);
      setSelectedId(null);
      toast({ title: "Skill deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete skill", description: err.message, variant: "destructive" });
    },
  });

  const handleEdit = (skill: SkillWithReferences) => {
    setEditingSkill(skill);
    setEditorOpen(true);
  };

  const handleCreate = () => {
    setEditingSkill(null);
    setEditorOpen(true);
  };

  const handleExportSkill = async (skill: SkillWithReferences) => {
    try {
      const res = await fetch(`/api/skills/${skill.id}/export`);
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      downloadJson(data, `skill-${skill.name}.json`);
      toast({ title: `Exported "${skill.name}"` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const handleExportAll = async () => {
    try {
      const res = await fetch("/api/skills/export");
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      downloadJson(data, `skills-export-${new Date().toISOString().slice(0, 10)}.json`);
      toast({ title: `Exported ${data.length} skills` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const handlePin = async (skill: SkillWithReferences) => {
    try {
      await apiRequest("PATCH", `/api/skills/${skill.id}`, {
        pinnedToContext: !skill.pinnedToContext,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      toast({
        title: skill.pinnedToContext ? "Unpinned from context" : "Pinned to context",
      });
    } catch {
      toast({ title: "Failed to update pin status", variant: "destructive" });
    }
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const res = await apiRequest("POST", "/api/skills/import", json);
        const body = await res.json();
        const resultList = (body.results || []) as { action: string }[];
        const created = resultList.filter(r => r.action === "created").length;
        const updated = resultList.filter(r => r.action === "updated").length;
        const errors = resultList.filter(r => r.action === "error").length;
        queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
        toast({ title: `Import complete: ${created} created, ${updated} updated${errors ? `, ${errors} errors` : ""}` });
      } catch {
        toast({ title: "Import failed", variant: "destructive" });
      }
    };
    input.click();
  };

  return (
    <div className={`flex flex-col h-full min-w-0 overflow-hidden ${embedded ? "" : ""}`}>
      <SkillListSidebar
        skills={skills}
        lastRuns={lastRuns}
        isLoading={isLoading}
        onCreate={handleCreate}
        onImport={handleImport}
        onExportAll={handleExportAll}
        onEdit={handleEdit}
        onDelete={(skill) => setDeletingSkill(skill)}
        onExport={handleExportSkill}
        onPin={handlePin}
        failedNames={unseenNames}
      />

      <SkillEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editingSkill={editingSkill}
      />

      <AlertDialog open={!!deletingSkill} onOpenChange={() => setDeletingSkill(null)}>
        <AlertDialogContent data-testid="dialog-delete-skill">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-mono font-medium">{deletingSkill?.name}</span> and all its references. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingSkill && deleteMutation.mutate(deletingSkill.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SkillsContent;
