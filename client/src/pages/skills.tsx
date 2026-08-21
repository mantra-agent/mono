import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { JSONContent } from "@tiptap/core";
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
import { PROFILE_DESCRIPTION_FRAME_CLASS } from "@/components/profile-description-style";
import { RichTextEditor } from "@/components/rich-text-editor";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { createReferenceRef } from "@shared/references";
import { markdownToTiptap, normalizeTiptapDoc, tiptapToMarkdown } from "@shared/markdown-tiptap";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
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
  Upload,
  ExternalLink,
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
  SkillRevision,
  SkillScore,
  SkillRun,
  CheckResult,
} from "@shared/models/skills";
import type { PromptModule } from "@shared/models/prompt-modules";
import type { Timer } from "@shared/models/timers";
import { MOD_KEYS, type ModKey } from "@shared/models/mods";

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

function skillFieldValueClass(changed?: boolean): string {
  return changed ? "text-white" : "text-muted-foreground";
}

/** Skill Process editor: Library-style TipTap so formatting stays live while editing.
 * Compact type scale only — never chat MarkdownContent reference chips. */
const SKILL_PROCESS_EDITOR_CLASS = cn(
  "!border-0 !bg-transparent !p-0 !shadow-none",
  "[&_.ProseMirror]:px-0 [&_.ProseMirror]:py-0 [&_.ProseMirror]:text-[14px] [&_.ProseMirror]:leading-snug",
  "[&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_p]:!text-[14px] [&_.ProseMirror_p]:!leading-snug",
  "[&_.ProseMirror_ul]:my-1.5 [&_.ProseMirror_ol]:my-1.5 [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_li]:!text-[14px]",
  "[&_.ProseMirror_h1]:my-2 [&_.ProseMirror_h2]:my-2 [&_.ProseMirror_h3]:my-1.5",
  "[&_.ProseMirror_h1]:!text-sm [&_.ProseMirror_h2]:!text-sm [&_.ProseMirror_h3]:!text-sm",
  "[&_.ProseMirror_h1]:font-semibold [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:font-medium",
  "[&_.ProseMirror_pre]:my-2 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:border-primary/20 [&_.ProseMirror_pre]:bg-background/60 [&_.ProseMirror_pre]:p-2 [&_.ProseMirror_pre]:text-xs",
  "[&_.ProseMirror_code]:break-all [&_.ProseMirror_code]:text-xs [&_.ProseMirror_code]:font-mono",
  "[&_.ProseMirror_blockquote]:my-2 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-primary/30 [&_.ProseMirror_blockquote]:pl-3",
);

function markdownDocFromValue(markdown: string): JSONContent | null {
  const trimmed = markdown.trim();
  if (!trimmed) return null;
  return normalizeTiptapDoc(markdownToTiptap(markdown)) ?? (markdownToTiptap(markdown) as JSONContent);
}

function SkillDescriptionEditor({
  value,
  changed,
  onChange,
  onCommit,
  onApplyField,
  onRevertField,
  applyField,
  placeholder = "Add description",
  testId = "input-description",
  minHeightClass = "min-h-[2.75rem]",
  markdown = false,
}: {
  value: string;
  changed?: boolean;
  onChange?: (next: string) => void;
  onCommit?: (next: string) => void;
  onApplyField?: (field: string) => void;
  onRevertField?: (field: string) => void;
  applyField?: string;
  placeholder?: string;
  testId?: string;
  minHeightClass?: string;
  markdown?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [doc, setDoc] = useState<JSONContent | null>(() => (markdown ? markdownDocFromValue(value) : null));
  const draftRef = useRef(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(value);
    draftRef.current = value;
    if (markdown) setDoc(markdownDocFromValue(value));
  }, [value, markdown]);
  const persist = (next: string) => {
    if (onCommit) {
      if (next !== value) onCommit(next);
      return;
    }
    onChange?.(next);
  };
  const commitDraft = (next = draftRef.current) => {
    persist(next);
  };
  const handleRichChange = useCallback((json: JSONContent) => {
    const next = tiptapToMarkdown(json).trimEnd();
    draftRef.current = next;
    setDraft(next);
    setDoc(json);
    onChange?.(next);
  }, [onChange]);
  const showMenu = Boolean((onApplyField || onRevertField) && applyField);
  return (
    <div className="group/editor grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-0 px-2 py-1.5">
      <div className={cn(PROFILE_DESCRIPTION_FRAME_CLASS, "min-w-0")}>
        {changed ? (
          <div className="mb-1 flex justify-end">
            <StatusDot kind="local" />
          </div>
        ) : null}
        {markdown ? (
          <div
            className={cn(minHeightClass, skillFieldValueClass(changed), "w-full")}
            data-testid={testId === "input-process" ? "skill-process-preview" : undefined}
          >
            <RichTextEditor
              value={doc}
              onChange={handleRichChange}
              placeholder={placeholder}
              plainTextFallback={value}
              className="h-auto"
              contentClassName={cn(SKILL_PROCESS_EDITOR_CLASS, minHeightClass, "[&_.ProseMirror]:!min-h-[inherit]")}
              onFocusChange={(focused) => {
                focusedRef.current = focused;
                if (!focused) commitDraft();
              }}
              data-testid={testId}
            />
          </div>
        ) : (
          <Textarea
            value={onCommit ? draft : value}
            onChange={(event) => {
              const next = event.target.value;
              if (onCommit) {
                setDraft(next);
                draftRef.current = next;
              } else {
                onChange?.(next);
              }
            }}
            onBlur={() => {
              if (onCommit) commitDraft();
            }}
            placeholder={placeholder}
            className={cn(
              minHeightClass,
              "w-full resize-none border-0 bg-transparent p-0 shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]",
              "text-[14px] leading-tight",
              skillFieldValueClass(changed),
            )}
            data-testid={testId}
          />
        )}
      </div>
      {showMenu ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 min-h-6 w-6 min-w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/editor:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`${applyField} actions`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
            {onApplyField && applyField ? <DropdownMenuItem onSelect={() => onApplyField(applyField)}>Apply to Default</DropdownMenuItem> : null}
            {onRevertField && applyField ? <DropdownMenuItem onSelect={() => onRevertField(applyField)}>Revert to Default</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="h-6 w-6 shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}

// ─── Skill Default Lattice grammar (Persona parity) ──────────────────────────
// Payload builders + the change-stage controls. The visual/interaction motif is
// shared with Personas via `@/components/lattice-controls`; only the skill-shaped
// payload and endpoints live here.

const SKILL_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  displayName: "Name",
  description: "Description",
  process: "Process",
  scoreThreshold: "Score threshold",
  sessionType: "System",
  recommendedPersonaTemplateId: "Persona",
  pinnedToContext: "Pinned",
  references: "References",
};

const skillLabelFor = (field: string) => SKILL_FIELD_LABELS[field] ?? field;

function skillLabel(skill: { name: string; displayName?: string | null }): string {
  const label = typeof skill.displayName === "string" ? skill.displayName.trim() : "";
  return label || skill.name;
}

/** Current lattice payload of a skill — mirrors the server SKILL_PAYLOAD_FIELDS shape. */
function skillCurrentPayload(skill: SkillWithReferences): Record<string, unknown> {
  return {
    name: skill.name,
    displayName: skill.displayName ?? skill.name,
    description: skill.description,
    process: skill.process,
    checklist: skill.checklist ?? [],
    scoreThreshold: skill.scoreThreshold ?? null,
    sessionType: skill.sessionType ?? null,
    recommendedPersonaTemplateId: skill.recommendedPersonaTemplateId ?? null,
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
  const label = skillLabel(skill);
  return {
    mode: "apply",
    title: `Apply ${label} to default?`,
    description: `Publish ${label}'s current values as the platform default for everyone. Skills following the default update automatically; customized copies get an "Update available".`,
    rows: buildDiffRows(skill.platformBaseline, changes, skillLabelFor),
    run: async () => {
      const [configResponse, personasResponse] = await Promise.all([
        apiRequest("GET", "/api/skills/persona-config"),
        apiRequest("GET", "/api/personas"),
      ]);
      const config = await configResponse.json() as { preferences: Record<string, number> };
      const personas = await personasResponse.json() as Array<{ id: number; templatePersonaId: number | null; source: "seed" | "user" }>;
      const preferenceId = config.preferences[skill.id];
      const preference = personas.find((persona) => persona.id === preferenceId);
      const publishChanges = {
        ...changes,
        recommendedPersonaTemplateId: preference
          ? (preference.source === "seed" ? preference.id : preference.templatePersonaId)
          : skill.recommendedPersonaTemplateId ?? null,
      };
      await apiRequest("POST", `/api/skills/platform/${templateId}/publish`, {
        changes: publishChanges,
        changeSummary: `Apply ${skillLabel(skill)} to default`,
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
    description: `Publish ${skillLabel(skill)}'s ${label} as the platform default for everyone.`,
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
    title: `Revert ${skillLabel(skill)} to default?`,
    description: `Discard ${skillLabel(skill)}'s customizations and restore the current platform default.`,
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
    description: `Discard ${skillLabel(skill)}'s ${label} customization and restore the current platform default.`,
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
function useSkillLattice(skill: SkillWithReferences) {
  const { hasPermission } = useAuth();
  const canApply = hasPermission("system:write");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
  const sync = useDefaultSync(refresh);
  const templateId = skillTemplateId(skill);
  const canPublish = canApply && templateId != null;
  const canRevert = skill.platformBaseline != null && skill.scope !== "global";
  const cell = computeLatticeCell({
    localChanged: (skill.changedFields?.length ?? 0) > 0,
    defaultAdvanced: Boolean(skill.updateAvailable),
    isAdmin: canPublish,
  });
  return {
    sync,
    templateId,
    canPublish,
    canRevert,
    cell,
    applyField: (field: string) => {
      if (!templateId) return;
      sync.request(() => buildSkillApplyField(skill, templateId, field));
    },
    revertField: (field: string) => sync.request(() => buildSkillRevertField(skill, field)),
    revertAll: () => sync.request(() => buildSkillRevertAll(skill)),
    publishAll: () => {
      if (!templateId) return;
      sync.request(() => buildSkillApplyAll(skill, templateId));
    },
  };
}

function SkillTreeRow({
  skill,
  expanded,
  hasFailed,
  onToggleExpand,
  onRun,
  onDelete,
}: {
  skill: SkillWithReferences;
  expanded: boolean;
  hasFailed: boolean;
  onToggleExpand: () => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(skillLabel(skill));
  const { toast } = useToast();
  const renameSkill = useMutation({
    mutationFn: async (displayName: string) => {
      // Free human label only — machine `name` stays the durable id.
      await apiRequest("PATCH", `/api/skills/${skill.id}`, { displayName });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/skills"] }),
    onError: (err: Error) => toast({ title: "Couldn't rename skill", description: err.message, variant: "destructive" }),
    onSettled: () => setEditingName(false),
  });
  const commitName = () => {
    const next = nameDraft.trim();
    const current = skillLabel(skill);
    if (!next || next === current) {
      setNameDraft(current);
      setEditingName(false);
      return;
    }
    renameSkill.mutate(next);
  };
  const latticeAction = useMutation({
    mutationFn: async ({ action }: { action: "keep-mine" | "use-updated-default" }) => {
      await apiRequest("POST", `/api/skills/${skill.id}/${action}`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/skills"] }),
    onError: (err: Error) => toast({ title: "Couldn't update skill", description: err.message, variant: "destructive" }),
  });
  const onKeepMine = () => latticeAction.mutate({ action: "keep-mine" });
  const onUseUpdatedDefault = () => latticeAction.mutate({ action: "use-updated-default" });
  const lattice = useSkillLattice(skill);
  const cell = lattice.cell;

  return (
    <div data-testid={`skill-row-${skill.id}`}>
      <div
        className={cn(
          HIERARCHY_SESSION_ROW_CLASS,
          "pr-16",
          expanded ? "bg-accent text-foreground" : "hover:bg-accent/70 hover:text-foreground",
          hasFailed ? "text-error" : "text-muted-foreground",
        )}
        onClick={onToggleExpand}
        data-testid={`button-skill-${skill.id}`}
      >
        <span className="flex items-center justify-center shrink-0">
          <Lightbulb className={cn("h-3.5 w-3.5 shrink-0", hasFailed && "text-error")} />
        </span>
        {editingName ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitName();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setNameDraft(skillLabel(skill));
                setEditingName(false);
              }
            }}
            onBlur={commitName}
            className="h-6 flex-1 min-w-0 border-0 bg-muted/40 px-1.5 text-sm shadow-none focus-visible:ring-1"
            data-testid={`input-skill-row-name-${skill.id}`}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm"
            onClick={(event) => {
              event.stopPropagation();
              setNameDraft(skillLabel(skill));
              setEditingName(true);
            }}
            data-testid={`text-skill-name-${skill.id}`}
          >
            {skillLabel(skill)}
          </button>
        )}
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
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={() => { setMenuOpen(false); onRun(); }} data-testid="menu-run-skill">
              <Play className="h-3.5 w-3.5 mr-2" /> Run
            </DropdownMenuItem>
            {(cell.showRevert && lattice.canRevert) || cell.showUpdate || cell.showMerge || (cell.showPublish && lattice.canPublish) || skill.scope !== "global" ? (
              <DropdownMenuSeparator />
            ) : null}
            {cell.showRevert && lattice.canRevert ? (
              <DropdownMenuItem onClick={() => { setMenuOpen(false); lattice.revertAll(); }} data-testid="menu-revert-skill">
                Revert
              </DropdownMenuItem>
            ) : null}
            {cell.showUpdate ? (
              <DropdownMenuItem onClick={() => { setMenuOpen(false); onUseUpdatedDefault(); }} data-testid="menu-update-skill">
                Update
              </DropdownMenuItem>
            ) : null}
            {cell.showMerge ? (
              <>
                <DropdownMenuItem onClick={() => { setMenuOpen(false); onKeepMine(); }} data-testid="menu-keep-mine-skill">
                  Merge · Keep Mine
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setMenuOpen(false); onUseUpdatedDefault(); }} data-testid="menu-use-updated-default-skill">
                  Merge · Take Theirs
                </DropdownMenuItem>
              </>
            ) : null}
            {cell.showPublish && lattice.canPublish ? (
              <DropdownMenuItem onClick={() => { setMenuOpen(false); lattice.publishAll(); }} data-testid="menu-publish-skill">
                Publish
              </DropdownMenuItem>
            ) : null}
            {skill.scope !== "global" && (
              <DropdownMenuItem onClick={() => { setMenuOpen(false); onDelete(); }} className="text-destructive" data-testid="menu-delete-skill">
                <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <SkillEditor skill={skill} lattice={lattice} />
      )}
      <DefaultSyncDialog sync={lattice.sync} />
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
      <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0 space-y-0">
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
  onRun,
  onDelete,
  failedNames,
}: {
  skills: SkillWithReferences[];
  lastRuns: Record<string, string>;
  isLoading: boolean;
  onImport: () => void;
  onRun: (skill: SkillWithReferences) => void;
  onDelete: (skill: SkillWithReferences) => void;
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
      filtered = skills.filter((s) => skillLabel(s).toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
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
      withoutRun.sort((a, b) => skillLabel(a).localeCompare(skillLabel(b)));
      return [...withRun, ...withoutRun];
    };

    const byOwner = new Map<"core" | ModKey, SkillWithReferences[]>();
    for (const skill of sortGroup(filtered)) {
      const owner = skill.sourceMod ?? "core";
      const group = byOwner.get(owner);
      if (group) group.push(skill);
      else byOwner.set(owner, [skill]);
    }

    return {
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
    />
  ));

  const total = sorted.sections.reduce((sum, section) => sum + section.skills.length, 0);

  return (
    <ScrollArea className="flex-1">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
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
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { setGlobalMenuOpen(false); onImport(); }} data-testid="menu-import-skills">
                <Upload className="h-3.5 w-3.5 mr-2" /> Import
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
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const { data: runs, isLoading: runsLoading } = useQuery<SkillRun[]>({
    queryKey: ["/api/skills", skillName, "runs"],
    queryFn: async () => {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/runs?limit=20`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: open && !!skillName,
  });

  const { data: scores, isLoading: scoresLoading } = useQuery<SkillScore[]>({
    queryKey: ["/api/skills", skillName, "scores"],
    queryFn: async () => {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/scores?limit=20`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: open && !!skillName && (!runs || runs.length === 0),
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
    <ProfileDetailSection
      title="Run History"
      count={open ? items.length : undefined}
      defaultOpen={false}
      open={open}
      onOpenChange={setOpen}
      testId="section-run-history"
    >
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
    </ProfileDetailSection>
  );
}


function SkillRevisionHistory({ skill }: { skill: SkillWithReferences }) {
  const { toast } = useToast();
  const { data: revisions = [] } = useQuery<SkillRevision[]>({
    queryKey: ["/api/skills", skill.id, "history"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/skills/${skill.id}/history`);
      return response.json();
    },
  });
  const restore = useMutation({
    mutationFn: async (revisionId: string) => {
      await apiRequest("POST", `/api/skills/${skill.id}/restore`, { revisionId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/skills", skill.id, "history"] });
      toast({ title: "Skill restored" });
    },
    onError: (error: Error) => toast({ title: "Couldn't restore skill", description: error.message, variant: "destructive" }),
  });
  if (revisions.length === 0) return null;
  return (
    <ProfileDetailSection label="History" defaultOpen={false} testId="section-skill-history">
      {revisions.map((revision) => (
        <ProfileTreeRow
          key={revision.id}
          label={revision.changeSummary}
          hasValue
          showEmpty
          mobileLayout="inline"
          menuContent={revision.scope === "user" && revision.id !== skill.currentRevisionId ? (
            <DropdownMenuItem onSelect={() => restore.mutate(revision.id)}>Restore</DropdownMenuItem>
          ) : undefined}
          menuVisibility="hover"
        >
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(revision.createdAt), { addSuffix: true })}
          </span>
        </ProfileTreeRow>
      ))}
    </ProfileDetailSection>
  );
}

function SkillEditor({
  skill,
  lattice,
  onCreated,
  onCancel,
}: {
  skill?: SkillWithReferences | null;
  lattice?: ReturnType<typeof useSkillLattice>;
  onCreated?: () => void;
  onCancel?: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(skill ? skillLabel(skill) : "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [process, setProcess] = useState(skill?.process ?? "");
  const [sessionType, setSessionType] = useState<string>(skill?.sessionType || "agent");
  /** Personal runtime choice, or "recommended" to follow the product default. */
  const [personaChoice, setPersonaChoice] = useState<number | "recommended">("recommended");
  const [version, setVersion] = useState(skill?.version ?? "1.0");

  useEffect(() => {
    if (!skill) return;
    setName(skillLabel(skill));
    setDescription(skill.description);
    setProcess(skill.process);
    setSessionType(skill.sessionType || "agent");
    setVersion(skill.version);
    setPersonaChoice("recommended");
  }, [skill]);

  const { data: personas = [] } = useQuery<{
    id: number;
    name: string;
    source: "seed" | "user";
    templatePersonaId: number | null;
    isSystem?: boolean;
  }[]>({
    queryKey: ["/api/personas"],
  });

  // The runtime choice may use the caller's visible persona copy. Seeds are
  // hidden when their user copies exist, so filtering to seeds erases the real catalog.
  const personaChoices = useMemo(
    () => personas.filter((p) => !p.isSystem),
    [personas],
  );

  const { data: personaConfig } = useQuery<{
    preferences: Record<string, number>;
    recommendations: Record<string, { templateId: number; name: string }>;
  }>({
    queryKey: ["/api/skills/persona-config"],
    enabled: Boolean(skill),
  });

  useEffect(() => {
    if (!skill) return;
    const preference = personaConfig?.preferences[skill.id];
    setPersonaChoice(typeof preference === "number" ? preference : "recommended");
  }, [skill, personaConfig]);

  const recommendedTemplateId = skill?.recommendedPersonaTemplateId ?? null;
  const recommendedName =
    (recommendedTemplateId != null
      ? personaConfig?.recommendations[skill?.id ?? ""]?.name
      : null) ?? null;

  // /api/timers returns { timers, globalPaused } — same envelope as the Timers page.
  // Treating the body as Timer[] made expand crash with `.filter is not a function`.
  const { data: timersData } = useQuery<{ timers: Timer[]; globalPaused: boolean }>({
    queryKey: ["/api/timers"],
    enabled: Boolean(skill),
  });
  const timers = Array.isArray(timersData?.timers) ? timersData.timers : [];

  const drivingTimers = useMemo(() => {
    if (!skill) return [];
    const keys = new Set([skill.id, skill.name, skill.templateSkillId].filter((value): value is string => Boolean(value)));
    return timers.filter((timer) => timer.skillId && keys.has(timer.skillId));
  }, [skill, timers]);

  const commitField = async (patch: Record<string, unknown>) => {
    if (!skill) return;
    try {
      await apiRequest("PATCH", `/api/skills/${skill.id}`, patch);
      await queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
    } catch (err) {
      toast({
        title: "Couldn't update skill",
        description: err instanceof Error ? err.message : "Update failed",
        variant: "destructive",
      });
    }
  };

  const fieldMenu = (field: string) => {
    if (!lattice) return undefined;
    const canApply = lattice.canPublish;
    const canRevert = lattice.canRevert;
    if (!canApply && !canRevert) return undefined;
    return (
      <>
        {canApply ? <DropdownMenuItem onSelect={() => lattice.applyField(field)}>Apply to Default</DropdownMenuItem> : null}
        {canRevert ? <DropdownMenuItem onSelect={() => lattice.revertField(field)}>Revert to Default</DropdownMenuItem> : null}
      </>
    );
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/skills", {
        displayName: name.trim(),
        description,
        authority: "full",
        process,
        qualityCriteria: "",
        sessionType,
        status: "draft",
        version,
        recommendedPersonaTemplateId:
          personaChoice === "recommended" ? null : personaChoice,
      });
      return await res.json() as { id: string };
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

  return (
    <div className="space-y-0" data-testid={skill ? `skill-editor-${skill.id}` : "skill-editor-new"}>
      {!skill ? (
        <ProfileTreeRow label="Name" hasValue showEmpty mobileLayout="inline" testId="row-skill-name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Skill name"
            className="h-7 text-right text-xs"
            data-testid="input-skill-name"
          />
        </ProfileTreeRow>
      ) : null}
      <SkillDescriptionEditor
        value={description}
        changed={skill?.changedFields?.includes("description")}
        onChange={setDescription}
        onCommit={skill ? (next) => {
          setDescription(next);
          void commitField({ description: next });
        } : undefined}
        onApplyField={lattice?.canPublish ? lattice.applyField : undefined}
        onRevertField={lattice?.canRevert ? lattice.revertField : undefined}
        applyField="description"
      />
      <ProfileTreeRow
        label="Version"
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="row-skill-version"
      >
        <Input
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          onBlur={() => {
            if (skill && version !== skill.version) void commitField({ version });
          }}
          className="h-7 text-right text-xs"
          data-testid="input-version"
        />
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Persona"
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="row-skill-persona"
      >
        <Select
          value={personaChoice === "recommended" ? "recommended" : String(personaChoice)}
          onValueChange={(value) => {
            const next = value === "recommended" ? "recommended" : Number(value);
            setPersonaChoice(next);
            if (skill) {
              void apiRequest("PUT", `/api/skills/${skill.id}/persona-preference`, {
                personaId: next === "recommended" ? null : next,
              }).then(() => queryClient.invalidateQueries({ queryKey: ["/api/skills/persona-config"] })).catch((err) => {
                toast({
                  title: "Couldn't update persona",
                  description: err instanceof Error ? err.message : "Update failed",
                  variant: "destructive",
                });
              });
            }
          }}
        >
          <SelectTrigger className={FIELD_SELECT_TRIGGER_CLASS} data-testid="select-persona">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recommended">
              {recommendedName ? `Recommended · ${recommendedName}` : "Default persona"}
            </SelectItem>
            {personaChoices.map((persona) => (
              <SelectItem key={persona.id} value={String(persona.id)}>{persona.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ProfileTreeRow>
      {skill ? <SkillRevisionHistory skill={skill} /> : null}
      <ProfileTreeRow
        label="System"
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="row-skill-system"
        menuContent={fieldMenu("sessionType")}
        menuVisibility="hover"
      >
        <button
          type="button"
          onClick={() => {
            const next = sessionType === "autonomous" ? "agent" : "autonomous";
            setSessionType(next);
            if (skill) void commitField({ sessionType: next });
          }}
          className="text-sm text-right"
          data-testid="toggle-skill-system"
        >
          {sessionType === "autonomous" ? "On" : "Off"}
        </button>
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Timer"
        hasValue={drivingTimers.length > 0}
        showEmpty
        mobileLayout="inline"
        testId="row-skill-timer"
      >
        {drivingTimers.length === 0 ? (
          <span className="text-sm text-muted-foreground">None</span>
        ) : (
          <div className="flex flex-wrap justify-end gap-1">
            {drivingTimers.map((timer) => (
              <ReferenceRenderer
                key={timer.id}
                refValue={createReferenceRef({
                  type: "timer",
                  id: timer.id,
                  metadata: {
                    label: timer.name,
                    href: `/timers?timer=${encodeURIComponent(timer.id)}`,
                  },
                })}
                surface="simple-chip"
              />
            ))}
          </div>
        )}
      </ProfileTreeRow>
      <SkillDescriptionEditor
        value={process}
        changed={skill?.changedFields?.includes("process")}
        onChange={setProcess}
        onCommit={skill ? (next) => {
          setProcess(next);
          void commitField({ process: next });
        } : undefined}
        onApplyField={lattice?.canPublish ? lattice.applyField : undefined}
        onRevertField={lattice?.canRevert ? lattice.revertField : undefined}
        applyField="process"
        placeholder="Step-by-step workflow..."
        testId="input-process"
        minHeightClass="min-h-20"
        markdown
      />
      {skill ? <RunHistorySection skillName={skill.name} /> : null}
      {!skill ? (
        <div className="flex justify-end gap-2 px-2 py-1">
          {onCancel ? (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={createMutation.isPending} data-testid="button-cancel">Cancel</Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !name || !description || !process}
            data-testid="button-save-skill"
          >
            {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Create
          </Button>
        </div>
      ) : null}
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
    onSuccess: (_result, skill) => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills/last-runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/skills", skill.name, "runs"] });
      toast({
        title: `Running ${skillLabel(skill)}`,
        description: "The run is starting.",
      });
    },
    onError: (err: Error, skill) => {
      toast({ title: `Failed to run ${skillLabel(skill)}`, description: err.message, variant: "destructive" });
    },
  });

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
        onRun={(skill) => runMutation.mutate(skill)}
        onDelete={(skill) => setDeletingSkill(skill)}
        failedNames={unseenNames}
      />

      <AlertDialog open={!!deletingSkill} onOpenChange={() => setDeletingSkill(null)}>
        <AlertDialogContent data-testid="dialog-delete-skill">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-medium">{deletingSkill ? skillLabel(deletingSkill) : ""}</span> and all its references. This action cannot be undone.
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
