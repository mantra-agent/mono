import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
// focus context removed — inline expansion, no selection model
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
} from "@/components/hierarchy-section-header";
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
  Download,
  Upload,
  Pin,

  ExternalLink,
  History,
  MoreVertical,
  MoreHorizontal,
  Search,
  FileText,
  PauseCircle,
  Play,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  StatusDot,
  DefaultSyncDialog,
  useDefaultSync,
  buildDiffRows,
  computeLatticeCell,
  type PendingSync,
} from "@/components/lattice-controls";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useSkillFailures } from "@/components/skill-failure-indicator";
import { useAuth } from "@/hooks/use-auth";
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
import { MOD_KEYS, type ModKey } from "@shared/models/mods";

const WRITE_CATEGORIES: SkillWriteCategory[] = ["read-only", "internal-data", "internal-control", "external", "destructive"];
const INPUT_TYPES: SkillInputType[] = ["task", "people", "memories", "events", "files", "project"];
const CATEGORY_OPTIONS = ["memory", "thinking", "chat", "goals", "people", "projects", "strategy", "reflection", "other"];
const ACTIVITY_OPTIONS = [
  { value: "c7a1e3b4-5d2f-4a89-b6e0-1f8c9d2e3a4b", label: "Chat" },
  { value: "d8b2f4c5-6e3a-4b90-c7f1-2a9d0e3f4b5c", label: "Work" },
  { value: "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d", label: "Framing" },
  { value: "f0d4b6e7-8a5c-4d12-e9b3-4c1f2a5b6d7e", label: "Recall" },
  { value: "a1e5c7f8-9b6d-4e23-f0c4-5d2a3b6c7e8f", label: "Memory" },
  { value: "b2f6d8a9-0c7e-4f34-a1d5-6e3b4c7d8f0a", label: "Thinking" },
  { value: "c3a7e9b0-1d8f-4a45-b2e6-7f4c5d8e9a1b", label: "Strategy" },
];
const FIELD_SELECT_TRIGGER_CLASS = "h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0";
const SOURCE_MOD_LABELS: Record<"core" | ModKey, string> = {
  core: "Core",
  planning: "Planning",
  build: "Build",
  business: "Business",
  wellness: "Wellness",
  network: "Network",
  finance: "Finance",
  slack: "Slack",
};
const SOURCE_MOD_ORDER: Array<"core" | ModKey> = ["core", ...MOD_KEYS];

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Skill Default Lattice grammar (Persona parity) ──────────────────────────
// Payload builders + the change-stage controls. The visual/interaction motif is
// shared with Personas via `@/components/lattice-controls`; only the skill-shaped
// payload and endpoints live here.

const SKILL_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  description: "Description",
  category: "Category",
  whenToUse: "When to use",
  process: "Process",
  outputSpec: "Output spec",
  checklist: "Checklist",
  scoreThreshold: "Score threshold",
  sessionType: "Session type",
  activity: "Activity",
  recommendedPersonaTemplateId: "Persona",
  addToMemory: "Add to memory",
  pinnedToContext: "Pinned",
  references: "References",
};

const skillLabelFor = (field: string) => SKILL_FIELD_LABELS[field] ?? field;

/** Current lattice payload of a skill — mirrors the server SKILL_PAYLOAD_FIELDS shape. */
function skillCurrentPayload(skill: SkillWithReferences): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    whenToUse: skill.whenToUse,
    process: skill.process,
    outputSpec: skill.outputSpec,
    checklist: skill.checklist ?? [],
    scoreThreshold: skill.scoreThreshold ?? null,
    sessionType: skill.sessionType ?? null,
    activity: skill.activity,
    recommendedPersonaTemplateId: skill.recommendedPersonaTemplateId ?? null,
    addToMemory: skill.addToMemory,
    pinnedToContext: skill.pinnedToContext,
    references: [...skill.references]
      .map((r) => ({ name: r.name, content: r.content }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.content.localeCompare(b.content)),
  };
}

/** The global template id this skill publishes to, or null when there is none. */
function skillTemplateId(skill: SkillWithReferences): string | null {
  return skill.templateSkillId ?? (skill.scope === "global" ? skill.id : null);
}

function buildSkillApplyAll(skill: SkillWithReferences, templateId: string): PendingSync {
  const changes = skillCurrentPayload(skill);
  return {
    mode: "apply",
    title: `Apply ${skill.name} to default?`,
    description: `Publish ${skill.name}'s current values as the platform default for everyone. Skills following the default update automatically; customized copies get an "Update available".`,
    rows: buildDiffRows(skill.platformBaseline, changes, skillLabelFor),
    run: async () => {
      await apiRequest("POST", `/api/skills/platform/${templateId}/publish`, {
        changes,
        changeSummary: `Apply ${skill.name} to default`,
        confirmed: true,
      });
    },
  };
}

function buildSkillApplyField(skill: SkillWithReferences, templateId: string, field: string): PendingSync {
  const label = skillLabelFor(field);
  const changes = { [field]: skillCurrentPayload(skill)[field] };
  return {
    mode: "apply",
    title: `Apply ${label} to default?`,
    description: `Publish ${skill.name}'s ${label} as the platform default for everyone.`,
    rows: buildDiffRows({ [field]: skill.platformBaseline?.[field] }, changes, skillLabelFor),
    run: async () => {
      await apiRequest("POST", `/api/skills/platform/${templateId}/publish`, {
        changes,
        changeSummary: `Apply ${label} to default`,
        confirmed: true,
      });
    },
  };
}

function buildSkillRevertAll(skill: SkillWithReferences): PendingSync {
  return {
    mode: "revert",
    title: `Revert ${skill.name} to default?`,
    description: `Discard ${skill.name}'s customizations and restore the current platform default.`,
    rows: buildDiffRows(skillCurrentPayload(skill), skill.platformBaseline, skillLabelFor),
    run: async () => {
      await apiRequest("POST", `/api/skills/${skill.id}/reset`, {});
    },
  };
}

function buildSkillRevertField(skill: SkillWithReferences, field: string): PendingSync {
  const label = skillLabelFor(field);
  const baselineValue = skill.platformBaseline?.[field];
  return {
    mode: "revert",
    title: `Revert ${label} to default?`,
    description: `Discard ${skill.name}'s ${label} customization and restore the current platform default.`,
    rows: buildDiffRows({ [field]: skillCurrentPayload(skill)[field] }, { [field]: baselineValue }, skillLabelFor),
    run: async () => {
      await apiRequest("PATCH", `/api/skills/${skill.id}`, { [field]: baselineValue });
    },
  };
}

/**
 * Expanded-row change-stage controls: inbound Keep-mine / Use-updated-default,
 * per-field Apply / Revert on local drift, and whole-skill Apply / Revert to
 * Default. Reset is Revert — it keeps the user copy. Renders nothing when there
 * is no drift, no inbound update, and no default to publish to.
 */
function SkillLatticeSection({ skill }: { skill: SkillWithReferences }) {
  const { hasPermission } = useAuth();
  const canApply = hasPermission("system:write");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
  const sync = useDefaultSync(refresh);

  const templateId = skillTemplateId(skill);
  const isUserCopy = skill.scope !== "global";
  const hasBaseline = skill.platformBaseline != null;
  // Publishing to the default is admin-gated; reverting a user's own copy is
  // owner-authed (the /reset + PATCH routes are user-writable, not system:write).
  const canPublish = canApply && templateId != null;
  const canRevert = hasBaseline && isUserCopy;
  const drift = skill.changedFields ?? [];
  // One cell decides the whole-skill moves; per-field apply/revert below stay
  // as editing affordances on individual drift rows.
  const cell = computeLatticeCell({
    localChanged: drift.length > 0,
    defaultAdvanced: Boolean(skill.updateAvailable),
    isAdmin: canPublish,
  });
  const showRevertAll = cell.showRevert && canRevert;
  const showPublishAll = cell.showPublish;

  if (drift.length === 0 && !showRevertAll && !showPublishAll) return null;

  return (
    <div className="space-y-2 rounded-md border border-border/40 bg-muted/10 p-2" data-testid={`skill-lattice-${skill.id}`}>
      {drift.length > 0 && (
        <div className="space-y-0.5">
          {drift.map((field) => (
            <div key={field} className="flex items-center gap-2 text-xs" data-testid={`skill-drift-${skill.id}-${field}`}>
              <StatusDot kind="local" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-foreground">{skillLabelFor(field)}</span>
              {(canPublish || canRevert) && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                      aria-label={`${skillLabelFor(field)} actions`}
                    >
                      <MoreHorizontal className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canPublish && <DropdownMenuItem onClick={() => sync.request(() => buildSkillApplyField(skill, templateId!, field))}>Apply to Default</DropdownMenuItem>}
                    {canRevert && <DropdownMenuItem onClick={() => sync.request(() => buildSkillRevertField(skill, field))}>Revert to Default</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))}
        </div>
      )}
      {(showPublishAll || showRevertAll) && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {showRevertAll && (
            <Button size="sm" variant="outline" onClick={() => sync.request(() => buildSkillRevertAll(skill))}>
              Revert
            </Button>
          )}
          {showPublishAll && (
            <Button size="sm" variant="outline" onClick={() => sync.request(() => buildSkillApplyAll(skill, templateId!))}>
              Publish
            </Button>
          )}
        </div>
      )}
      <DefaultSyncDialog sync={sync} />
    </div>
  );
}

function SkillTreeRow({
  skill,
  expanded,
  hasFailed,
  onToggleExpand,
  onRun,
  onDelete,
  onExport,
  onPin,
}: {
  skill: SkillWithReferences;
  expanded: boolean;
  hasFailed: boolean;
  onToggleExpand: () => void;
  onRun: () => void;
  onDelete: () => void;
  onExport: () => void;
  onPin: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { toast } = useToast();
  const latticeAction = useMutation({
    mutationFn: async ({ action }: { action: "keep-mine" | "use-updated-default" }) => {
      await apiRequest("POST", `/api/skills/${skill.id}/${action}`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/skills"] }),
    onError: (err: Error) => toast({ title: "Couldn't update skill", description: err.message, variant: "destructive" }),
  });
  const onKeepMine = () => latticeAction.mutate({ action: "keep-mine" });
  const onUseUpdatedDefault = () => latticeAction.mutate({ action: "use-updated-default" });
  // Inbound consume moves resolve through the single cell: Update when only the
  // default advanced, the Keep Mine / Take Theirs fork when local also changed.
  const cell = computeLatticeCell({
    localChanged: (skill.changedFields?.length ?? 0) > 0,
    defaultAdvanced: Boolean(skill.updateAvailable),
    isAdmin: false,
  });

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
        {/* Lattice marks: green inbound (default advanced), amber local-ahead. */}
        {skill.updateAvailable ? (
          <StatusDot kind="inbound" className="shrink-0" />
        ) : (skill.changedFields?.length ?? 0) > 0 ? (
          <StatusDot kind="local" className="shrink-0" />
        ) : null}
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
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onRun(); }} data-testid="menu-run-skill">
              <Play className="h-3.5 w-3.5 mr-2" /> Run
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onPin(); }} data-testid="menu-pin-skill">
              <Pin className={cn("h-3.5 w-3.5 mr-2", skill.pinnedToContext && "fill-current text-info")} />
              {skill.pinnedToContext ? "Unpin from Context" : "Pin to Context"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onToggleExpand(); }} data-testid="menu-edit-skill">
              <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
            </DropdownMenuItem>
            {cell.showUpdate && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { setMenuOpen(false); onUseUpdatedDefault(); }} data-testid="menu-update-skill">
                  Update
                </DropdownMenuItem>
              </>
            )}
            {cell.showMerge && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { setMenuOpen(false); onKeepMine(); }} data-testid="menu-keep-mine-skill">
                  Merge · Keep Mine
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setMenuOpen(false); onUseUpdatedDefault(); }} data-testid="menu-use-updated-default-skill">
                  Merge · Take Theirs
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onExport(); }} data-testid="menu-export-skill">
              <Download className="h-3.5 w-3.5 mr-2" /> Export
            </DropdownMenuItem>
            {skill.scope !== "global" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { setMenuOpen(false); onDelete(); }} className="text-destructive" data-testid="menu-delete-skill">
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <SkillEditor skill={skill} />
      )}
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
  onImport,
  onExportAll,
  onRun,
  onDelete,
  onExport,
  onPin,
  failedNames,
}: {
  skills: SkillWithReferences[];
  lastRuns: Record<string, string>;
  isLoading: boolean;
  onImport: () => void;
  onExportAll: () => void;
  onRun: (skill: SkillWithReferences) => void;
  onDelete: (skill: SkillWithReferences) => void;
  onExport: (skill: SkillWithReferences) => void;
  onPin: (skill: SkillWithReferences) => void;
  failedNames: Set<string>;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [creating, setCreating] = useState(false);
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

    const byOwner = new Map<"core" | ModKey, SkillWithReferences[]>();
    for (const skill of sortGroup(unpinned)) {
      const owner = skill.sourceMod ?? "core";
      const group = byOwner.get(owner);
      if (group) group.push(skill);
      else byOwner.set(owner, [skill]);
    }

    return {
      pinned: sortGroup(pinned),
      sections: SOURCE_MOD_ORDER
        .filter((owner) => byOwner.has(owner))
        .map((owner) => ({ owner, title: SOURCE_MOD_LABELS[owner], skills: byOwner.get(owner)! })),
    };
  }, [skills, lastRuns, searchQuery]);

  const renderRows = (items: SkillWithReferences[]) => items.map(skill => (
    <SkillTreeRow
      key={skill.id}
      skill={skill}
      expanded={expandedIds.has(skill.id)}
      hasFailed={failedNames.has(skill.name)}
      onToggleExpand={() => { setCreating(false); toggleExpanded(skill.id); }}
      onRun={() => onRun(skill)}
      onDelete={() => onDelete(skill)}
      onExport={() => onExport(skill)}
      onPin={() => onPin(skill)}
    />
  ));

  const total = sorted.pinned.length + sorted.sections.reduce((sum, section) => sum + section.skills.length, 0);

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
        {creating ? (
          <SkillEditor
            onCreated={() => setCreating(false)}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => { setExpandedIds(new Set()); setCreating(true); }}
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            data-testid="button-create-skill"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Skill</span>
          </button>
        )}
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
            {sorted.sections.map((section) => (
              <SkillTreeSection key={section.owner} title={section.title} isEmpty={section.skills.length === 0}>
                {renderRows(section.skills)}
              </SkillTreeSection>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
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


function SkillEditor({
  skill,
  onCreated,
  onCancel,
}: {
  skill?: SkillWithReferences | null;
  onCreated?: () => void;
  onCancel?: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [category, setCategory] = useState(skill?.category || "other");
  const [activity, setActivity] = useState(skill?.activity || "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d");
  const [writeCategory, setWriteCategory] = useState<SkillWriteCategory>((skill?.writeCategory as SkillWriteCategory) || "read-only");
  const [inputs, setInputs] = useState<SkillInputType[]>((skill?.inputs as SkillInputType[]) ?? []);
  const [estimatedTokens, setEstimatedTokens] = useState(skill?.estimatedTokens ?? 0);
  const [estimatedDuration, setEstimatedDuration] = useState(skill?.estimatedDuration ?? "5min");
  const [whenToUse, setWhenToUse] = useState(skill?.whenToUse ?? "");
  const [process, setProcess] = useState(skill?.process ?? "");
  const [outputSpec, setOutputSpec] = useState(skill?.outputSpec ?? "");
  const [checklist, setChecklist] = useState<ChecklistItem[]>(Array.isArray(skill?.checklist) ? skill.checklist as ChecklistItem[] : []);
  const [addToMemory, setAddToMemory] = useState(skill?.addToMemory !== false);
  const [sessionType, setSessionType] = useState<string>(skill?.sessionType || "agent");
  const [personaChoice, setPersonaChoice] = useState<number | "recommended">("recommended");
  const personaTouchedRef = useRef(false);
  const [version, setVersion] = useState(skill?.version ?? "1.0");
  const [author, setAuthor] = useState(skill?.author ?? "user");
  const [references, setReferences] = useState<{ name: string; content: string }[]>(skill?.references.map((ref) => ({ name: ref.name, content: ref.content })) ?? []);

  useEffect(() => {
    if (!skill) return;
    setName(skill.name);
    setDescription(skill.description);
    setCategory(skill.category || "other");
    setActivity(skill.activity || "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d");
    setWriteCategory(skill.writeCategory as SkillWriteCategory);
    setInputs(skill.inputs as SkillInputType[]);
    setEstimatedTokens(skill.estimatedTokens);
    setEstimatedDuration(skill.estimatedDuration);
    setWhenToUse(skill.whenToUse);
    setProcess(skill.process);
    setOutputSpec(skill.outputSpec);
    setChecklist(Array.isArray(skill.checklist) ? skill.checklist as ChecklistItem[] : []);
    setAddToMemory(skill.addToMemory !== false);
    setSessionType(skill.sessionType || "agent");
    setVersion(skill.version);
    setAuthor(skill.author);
    setReferences(skill.references.map((ref) => ({ name: ref.name, content: ref.content })));
  }, [skill]);

  const { data: personas = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/personas"],
  });

  const { data: personaConfig } = useQuery<{
    preferences: Record<string, number>;
    recommendations: Record<string, { templateId: number; name: string }>;
  }>({
    queryKey: ["/api/skills/persona-config"],
  });

  useEffect(() => {
    personaTouchedRef.current = false;
    const saved = skill ? personaConfig?.preferences[skill.id] : undefined;
    setPersonaChoice(typeof saved === "number" ? saved : "recommended");
  }, [skill, personaConfig]);

  const recommendedName = skill
    ? personaConfig?.recommendations[skill.id]?.name ?? null
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
      onCreated?.();
      toast({ title: "Skill created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create skill", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/skills/${skill!.id}`, data);
      const saved = await res.json() as { id: string };
      await savePersonaPreference(saved.id);
      return saved;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
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
      authority: skill?.authority || "full",
      writeCategory,
      inputs,
      estimatedTokens,
      estimatedDuration,
      whenToUse,
      process,
      outputSpec,
      qualityCriteria: skill?.qualityCriteria || "",
      checklist: validChecklist,
      addToMemory,
      sessionType,
      status: skill?.status || "draft",
      version,
      author,
      references,
    };
    if (skill) {
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
    <div className="space-y-1" data-testid={skill ? `skill-editor-${skill.id}` : "skill-editor-new"}>
      <ProfileDetailSection title="Skill" defaultOpen>
        <ProfileTreeRow label="Name" hasValue showEmpty mobileLayout="inline" testId="row-skill-name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-skill-name"
            className="h-7 text-right text-xs font-mono"
            data-testid="input-skill-name"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Category" hasValue showEmpty mobileLayout="inline" testId="row-skill-category">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className={FIELD_SELECT_TRIGGER_CLASS} data-testid="select-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProfileTreeRow>
        <ProfileTreeRow label="Version" hasValue showEmpty mobileLayout="inline" testId="row-skill-version">
          <Input value={version} onChange={(event) => setVersion(event.target.value)} className="h-7 text-right text-xs" data-testid="input-version" />
        </ProfileTreeRow>
        <ProfileTreeRow label="Author" hasValue showEmpty mobileLayout="inline" testId="row-skill-author">
          <Input value={author} onChange={(event) => setAuthor(event.target.value)} className="h-7 text-right text-xs" data-testid="input-author" />
        </ProfileTreeRow>
        <ProfileTreeRow label="Activity" hasValue showEmpty mobileLayout="inline" testId="row-skill-activity">
          <Select value={activity} onValueChange={setActivity}>
            <SelectTrigger className={FIELD_SELECT_TRIGGER_CLASS} data-testid="input-activity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProfileTreeRow>
        <ProfileTreeRow label="Persona" hasValue showEmpty mobileLayout="inline" testId="row-skill-persona">
          <Select
            value={personaChoice === "recommended" ? "recommended" : String(personaChoice)}
            onValueChange={(value) => {
              personaTouchedRef.current = true;
              setPersonaChoice(value === "recommended" ? "recommended" : Number(value));
            }}
          >
            <SelectTrigger className={FIELD_SELECT_TRIGGER_CLASS} data-testid="select-persona">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recommended">
                {recommendedName ? `Recommended · ${recommendedName}` : "Default persona"}
              </SelectItem>
              {personas.map((persona) => (
                <SelectItem key={persona.id} value={String(persona.id)}>{persona.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProfileTreeRow>
        <ProfileTreeRow label="Write" hasValue showEmpty mobileLayout="inline" testId="row-skill-write">
          <Select value={writeCategory} onValueChange={(value) => setWriteCategory(value as SkillWriteCategory)}>
            <SelectTrigger className={FIELD_SELECT_TRIGGER_CLASS} data-testid="select-write-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WRITE_CATEGORIES.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProfileTreeRow>
        <ProfileTreeRow label="Session" hasValue showEmpty mobileLayout="inline" testId="row-skill-session">
          <Select value={sessionType || "agent"} onValueChange={setSessionType}>
            <SelectTrigger className={FIELD_SELECT_TRIGGER_CLASS} data-testid="select-session-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="autonomous">Auto</SelectItem>
            </SelectContent>
          </Select>
        </ProfileTreeRow>
        <ProfileTreeRow label="Tokens" hasValue showEmpty mobileLayout="inline" testId="row-skill-tokens">
          <Input type="number" value={estimatedTokens} onChange={(event) => setEstimatedTokens(parseInt(event.target.value) || 0)} className="h-7 text-right text-xs" data-testid="input-estimated-tokens" />
        </ProfileTreeRow>
        <ProfileTreeRow label="Duration" hasValue showEmpty mobileLayout="inline" testId="row-skill-duration">
          <Input value={estimatedDuration} onChange={(event) => setEstimatedDuration(event.target.value)} placeholder="5min" className="h-7 text-right text-xs" data-testid="input-estimated-duration" />
        </ProfileTreeRow>
        <ProfileTreeRow label="Memory" hasValue showEmpty mobileLayout="inline" testId="row-skill-memory">
          <button
            type="button"
            onClick={() => setAddToMemory((current) => !current)}
            className="text-xs text-right"
            data-testid="toggle-add-to-memory"
          >
            {addToMemory ? "On" : "Off"}
          </button>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Inputs"
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-skill-inputs"
          expandedContent={(
            <div className="space-y-0.5">
              {INPUT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleInput(type)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent/70"
                  data-testid={`toggle-input-${type}`}
                >
                  <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", inputs.includes(type) && "border-cta bg-cta text-cta-foreground")}>
                    {inputs.includes(type) ? <CheckCircle2 className="h-3 w-3" /> : null}
                  </span>
                  {type}
                </button>
              ))}
            </div>
          )}
        >
          <span className="truncate text-xs">{inputs.length ? inputs.join(", ") : "None"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Description" hasValue={Boolean(description.trim())} showEmpty mobileLayout="stacked" testId="row-skill-description">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this skill does and when to use it..." className="min-h-[60px] text-xs" data-testid="input-description" />
        </ProfileTreeRow>
        <ProfileTreeRow label="When to Use" hasValue={Boolean(whenToUse.trim())} showEmpty mobileLayout="stacked" testId="row-skill-when-to-use">
          <Textarea value={whenToUse} onChange={(event) => setWhenToUse(event.target.value)} placeholder="Conditions that indicate this skill matches a task..." className="min-h-[60px] text-xs" data-testid="input-when-to-use" />
        </ProfileTreeRow>
        <ProfileTreeRow label="Process" hasValue={Boolean(process.trim())} showEmpty mobileLayout="stacked" testId="row-skill-process">
          <Textarea value={process} onChange={(event) => setProcess(event.target.value)} placeholder="Step-by-step workflow..." className="min-h-20 text-xs" data-testid="input-process" />
        </ProfileTreeRow>
        <ProfileTreeRow label="Output Spec" hasValue={Boolean(outputSpec.trim())} showEmpty mobileLayout="stacked" testId="row-skill-output-spec">
          <Textarea value={outputSpec} onChange={(event) => setOutputSpec(event.target.value)} placeholder="What it produces and where each output goes..." className="min-h-[60px] text-xs" data-testid="input-output-spec" />
        </ProfileTreeRow>
      </ProfileDetailSection>
      <ProfileDetailSection
        title="Checklist"
        count={checklist.length}
        headerAction={(
          <button type="button" className="text-xs text-cta" onClick={() => setChecklist([...checklist, { check: "", weight: 1 }])} data-testid="button-add-checklist-item">
            Add
          </button>
        )}
      >
        {checklist.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No custom checklist.</div>
        ) : checklist.map((item, index) => (
          <ProfileTreeRow
            key={index}
            label={`Check ${index + 1}`}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`checklist-item-${index}`}
            actionContent={(
              <button type="button" className="text-xs text-destructive" onClick={() => setChecklist(checklist.filter((_, current) => current !== index))} data-testid={`button-remove-checklist-item-${index}`}>
                Remove
              </button>
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Input
                value={item.check}
                onChange={(event) => {
                  const next = [...checklist];
                  next[index] = { ...next[index], check: event.target.value };
                  setChecklist(next);
                }}
                placeholder="What to verify..."
                className="h-7 text-right text-xs"
                data-testid={`input-checklist-check-${index}`}
              />
              <Input
                type="number"
                value={item.weight ?? 1}
                onChange={(event) => {
                  const next = [...checklist];
                  next[index] = { ...next[index], weight: parseFloat(event.target.value) || 1 };
                  setChecklist(next);
                }}
                min={0}
                step={0.5}
                className="h-7 w-16 text-right text-xs"
                title="Weight"
                data-testid={`input-checklist-weight-${index}`}
              />
            </div>
          </ProfileTreeRow>
        ))}
      </ProfileDetailSection>
      <ProfileDetailSection
        title="References"
        count={references.length}
        headerAction={(
          <button type="button" className="text-xs text-cta" onClick={() => setReferences([...references, { name: "", content: "" }])} data-testid="button-add-reference">
            Add
          </button>
        )}
      >
        {references.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No references.</div>
        ) : references.map((ref, index) => (
          <ProfileTreeRow
            key={index}
            label={ref.name || `Reference ${index + 1}`}
            hasValue
            showEmpty
            mobileLayout="stacked"
            testId={`reference-item-${index}`}
            actionContent={(
              <button type="button" className="text-xs text-destructive" onClick={() => setReferences(references.filter((_, current) => current !== index))} data-testid={`button-remove-reference-${index}`}>
                Remove
              </button>
            )}
          >
            <div className="space-y-1">
              <Input
                value={ref.name}
                onChange={(event) => {
                  const next = [...references];
                  next[index] = { ...next[index], name: event.target.value };
                  setReferences(next);
                }}
                placeholder="reference-name"
                className="h-7 text-xs"
                data-testid={`input-reference-name-${index}`}
              />
              <Textarea
                value={ref.content}
                onChange={(event) => {
                  const next = [...references];
                  next[index] = { ...next[index], content: event.target.value };
                  setReferences(next);
                }}
                placeholder="Reference content loaded into context on activation..."
                className="min-h-10 text-xs"
                data-testid={`input-reference-content-${index}`}
              />
            </div>
          </ProfileTreeRow>
        ))}
      </ProfileDetailSection>
      {skill ? <SkillLatticeSection skill={skill} /> : null}
      {skill ? <RunHistorySection skillName={skill.name} /> : null}
      <div className="flex justify-end gap-2 px-2 py-1">
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending} data-testid="button-cancel">Cancel</Button>
        ) : null}
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={isPending || !name || !description || !whenToUse || !process || !outputSpec}
          data-testid="button-save-skill"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          {skill ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}

export function SkillsContent({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Skills", skip: !!embedded });
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const [deletingSkill, setDeletingSkill] = useState<SkillWithReferences | null>(null);
  const { unseenNames } = useSkillFailures();

  const { data: allSkills = [], isLoading } = useQuery<SkillWithReferences[]>({
    queryKey: ["/api/skills"],
  });

  const { data: promptModules = [] } = useQuery<PromptModule[]>({
    queryKey: ["/api/prompt-modules"],
    enabled: hasPermission("build:read"),
    retry: false,
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
      toast({ title: "Skill deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete skill", description: err.message, variant: "destructive" });
    },
  });

  const runMutation = useMutation({
    mutationFn: async (skill: SkillWithReferences) => {
      const response = await apiRequest("POST", `/api/skills/${skill.id}/run`);
      return response.json() as Promise<Record<string, unknown>>;
    },
    onSuccess: (result, skill) => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills/last-runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/skills", skill.name, "runs"] });
      toast({
        title: `Running ${skill.name}`,
        description: "The run is starting.",
      });
    },
    onError: (err: Error, skill) => {
      toast({ title: `Failed to run ${skill.name}`, description: err.message, variant: "destructive" });
    },
  });

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
        onImport={handleImport}
        onExportAll={handleExportAll}
        onRun={(skill) => runMutation.mutate(skill)}
        onDelete={(skill) => setDeletingSkill(skill)}
        onExport={handleExportSkill}
        onPin={handlePin}
        failedNames={unseenNames}
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
