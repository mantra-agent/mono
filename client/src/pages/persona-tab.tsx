import { useEffect, useMemo, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Check, ChevronRight, Circle, Loader2, MoreHorizontal, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_SECTION_HEADER_CLASS, HIERARCHY_SESSION_ROW_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { MarkdownContent } from "@/components/chat-shared";
import { Card } from "@/components/ui/card";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { PROFILE_DESCRIPTION_FRAME_CLASS, PROFILE_DESCRIPTION_TEXT_CLASS } from "@/components/profile-description-style";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { resolvePersonaIcon, AVAILABLE_ICONS } from "@/lib/persona-icons";

interface Persona {
  id: number;
  name: string;
  description: string;
  icon: string;
  promptOverlay: string | null;
  expressionTags: string[];
  cognitiveOverrides: Record<string, unknown>;
  semanticTier: "max" | "high" | "balanced" | "fast" | null;
  contextSections: Record<string, boolean>;
  toolBundle: string[];
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  source: "seed" | "user";
  templatePersonaId: number | null;
  baseRevisionId: string | null;
  currentRevisionId: string | null;
  updateState: "following" | "customized" | "update_available" | "conflict" | "pinned_legacy";
  createdAt: string;
  updatedAt: string;
  platformBaseline?: Record<string, unknown> | null;
  changedFields?: string[];
  updateAvailable?: boolean;
}

interface PersonaPayloadDraft {
  description: string;
  promptOverlay: string;
  expressionTags: string;
  memoryGraphTokenBudget: string;
  semanticTier: "max" | "high" | "balanced" | "fast";
  contextSections: Record<string, boolean>;
  toolBundle: string[];
}

type LocalField =
  | "name"
  | "description"
  | "icon"
  | "promptOverlay"
  | "expressionTags"
  | "memoryGraphTokenBudget"
  | "semanticTier"
  | "contextSections"
  | "toolBundle";

const FIELD_LABELS: Record<LocalField, string> = {
  name: "Name",
  description: "Description",
  icon: "Icon",
  promptOverlay: "Prompt",
  expressionTags: "Expressions",
  memoryGraphTokenBudget: "Memory",
  semanticTier: "Thinking",
  contextSections: "Context",
  toolBundle: "Tools",
};

const MEMORY_TIERS = [
  { value: "fast", label: "Fast", tokens: 1000 },
  { value: "balanced", label: "Balanced", tokens: 4000 },
  { value: "high", label: "High", tokens: 10000 },
  { value: "max", label: "Max", tokens: 20000 },
] as const;

/** Map a stored token budget to the closest named memory tier, or "" when unset. */
function budgetToTier(budget: string): string {
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) return "";
  let best = MEMORY_TIERS[0].value as string;
  let bestDiff = Infinity;
  for (const tier of MEMORY_TIERS) {
    const diff = Math.abs(tier.tokens - n);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = tier.value;
    }
  }
  return best;
}

function tierToBudget(tier: string): string {
  const found = MEMORY_TIERS.find((entry) => entry.value === tier);
  return found ? String(found.tokens) : "";
}

interface ApplyDiffRow {
  field: string;
  before: string;
  after: string;
}

type DefaultSyncMode = "apply" | "revert";

interface PendingSync {
  mode: DefaultSyncMode;
  title: string;
  description: string;
  rows: ApplyDiffRow[];
  run: () => Promise<void>;
}

function formatDiffValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.trim() ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) {
      return value.map(String).join(", ");
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readMemoryGraphTokenBudget(overrides: Record<string, unknown> | null | undefined): number | null {
  const budget = overrides?.memoryGraphTokenBudget;
  return typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : null;
}

function draftFromPersona(persona: Persona): PersonaPayloadDraft {
  const budget = readMemoryGraphTokenBudget(persona.cognitiveOverrides);
  return {
    description: persona.description,
    promptOverlay: persona.promptOverlay || "",
    expressionTags: persona.expressionTags.join(", "),
    memoryGraphTokenBudget: budget == null ? "" : String(budget),
    semanticTier: persona.semanticTier || "balanced",
    contextSections: persona.contextSections || {},
    toolBundle: persona.toolBundle || [],
  };
}

function payloadFromDraft(draft: PersonaPayloadDraft) {
  const trimmedBudget = draft.memoryGraphTokenBudget.trim();
  const parsedBudget = trimmedBudget === "" ? null : Number(trimmedBudget);
  return {
    description: draft.description,
    promptOverlay: draft.promptOverlay,
    expressionTags: draft.expressionTags.split(",").map((value) => value.trim()).filter(Boolean),
    cognitiveOverrides:
      parsedBudget != null && Number.isFinite(parsedBudget) && parsedBudget > 0
        ? { memoryGraphTokenBudget: parsedBudget }
        : {},
    semanticTier: draft.semanticTier,
    contextSections: draft.contextSections,
    toolBundle: draft.toolBundle,
  };
}

function fullApplyPayload(persona: Persona, draft: PersonaPayloadDraft): Record<string, unknown> {
  return { name: persona.name, icon: persona.icon, ...payloadFromDraft(draft) };
}

function buildApplyDiffRows(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
): ApplyDiffRow[] {
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after)])).sort();
  return keys
    .map((field) => {
      const left = formatDiffValue(before?.[field]);
      const right = formatDiffValue(after[field]);
      if (left === right) return null;
      return { field: FIELD_LABELS[field as LocalField] || field, before: left, after: right };
    })
    .filter((row): row is ApplyDiffRow => row != null);
}

function resolveApplyTargetId(persona: Persona): number | null {
  return persona.templatePersonaId ?? ((persona.isSystem || persona.source === "seed") ? persona.id : null);
}

function currentPayload(persona: Persona): Record<string, unknown> {
  return {
    name: persona.name,
    icon: persona.icon,
    description: persona.description,
    promptOverlay: persona.promptOverlay,
    expressionTags: persona.expressionTags,
    cognitiveOverrides: persona.cognitiveOverrides,
    semanticTier: persona.semanticTier,
    contextSections: persona.contextSections,
    toolBundle: persona.toolBundle,
  };
}

function personaBaseline(persona: Persona): Record<string, unknown> | null {
  if (persona.platformBaseline) return persona.platformBaseline as Record<string, unknown>;
  if (persona.isSystem || persona.source === "seed") return currentPayload(persona);
  return null;
}

function publishedFieldFor(field: LocalField): string {
  return field === "memoryGraphTokenBudget" ? "cognitiveOverrides" : field;
}

function buildApplyAll(persona: Persona, draft: PersonaPayloadDraft): PendingSync {
  const changes = fullApplyPayload(persona, draft);
  const targetId = resolveApplyTargetId(persona);
  return {
    mode: "apply",
    title: `Apply ${persona.name} to default?`,
    description: `Publish ${persona.name}'s current values as the platform default for everyone. Personas following the default update automatically; customized copies get an "Update available".`,
    rows: buildApplyDiffRows(personaBaseline(persona), changes),
    run: async () => {
      if (targetId == null) throw new Error("This persona has no platform default to apply to.");
      await apiRequest("POST", `/api/personas/platform/${targetId}/publish`, {
        changes,
        changeSummary: `Apply ${persona.name} to default`,
        confirmed: true,
      });
    },
  };
}

function buildApplyField(persona: Persona, draft: PersonaPayloadDraft, field: LocalField): PendingSync {
  const label = FIELD_LABELS[field];
  const payload = fullApplyPayload(persona, draft);
  const publishedField = publishedFieldFor(field);
  const changes = { [publishedField]: payload[publishedField] };
  const baseline = personaBaseline(persona);
  const targetId = resolveApplyTargetId(persona);
  return {
    mode: "apply",
    title: `Apply ${label} to default?`,
    description: `Publish ${persona.name}'s ${label} as the platform default for everyone.`,
    rows: buildApplyDiffRows({ [publishedField]: baseline?.[publishedField] }, changes),
    run: async () => {
      if (targetId == null) throw new Error("This persona has no platform default to apply to.");
      await apiRequest("POST", `/api/personas/platform/${targetId}/publish`, {
        changes,
        changeSummary: `Apply ${label} to default`,
        confirmed: true,
      });
    },
  };
}

function buildRevertAll(persona: Persona): PendingSync {
  const baseline = personaBaseline(persona);
  return {
    mode: "revert",
    title: `Revert ${persona.name} to default?`,
    description: `Discard ${persona.name}'s customizations and restore the current platform default.`,
    rows: buildApplyDiffRows(currentPayload(persona), baseline),
    run: async () => {
      if (baseline == null) throw new Error("This persona has no platform default to revert to.");
      await apiRequest("POST", `/api/personas/${persona.id}/use-updated-default`, {});
    },
  };
}

function buildRevertField(persona: Persona, field: LocalField): PendingSync {
  const label = FIELD_LABELS[field];
  const publishedField = publishedFieldFor(field);
  const baseline = personaBaseline(persona);
  const baselineValue = baseline?.[publishedField];
  return {
    mode: "revert",
    title: `Revert ${label} to default?`,
    description: `Discard ${persona.name}'s ${label} customization and restore the current platform default.`,
    rows: buildApplyDiffRows({ [publishedField]: currentPayload(persona)[publishedField] }, { [publishedField]: baselineValue }),
    run: async () => {
      if (baseline == null) throw new Error("This persona has no platform default to revert to.");
      await apiRequest("PUT", `/api/personas/${persona.id}`, { [publishedField]: baselineValue });
    },
  };
}

function ApplyDiffView({ rows, mode }: { rows: ApplyDiffRow[]; mode: DefaultSyncMode }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No differences from the current default.</p>;
  }
  const leftLabel = mode === "revert" ? "Current" : "Current default";
  const rightLabel = mode === "revert" ? "After revert" : "After apply";
  return (
    <div className="max-h-80 space-y-2 overflow-auto pr-1">
      {rows.map((row) => (
        <div key={row.field} className="rounded-md border border-border/40 bg-muted/20 p-2">
          <div className="mb-1 text-xs font-medium text-foreground">{row.field}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{leftLabel}</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 text-xs text-muted-foreground">{row.before}</pre>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{rightLabel}</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 text-xs text-foreground">{row.after}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Apply a persona (or one field) to its platform default, or revert it back, behind a confirmation prompt. */
function usePersonaDefaultSync(onDone: () => void) {
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingSync | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: PendingSync) => {
      await input.run();
    },
    onSuccess: (_data, input) => {
      toast({ title: input.mode === "revert" ? "Reverted to default" : "Applied to default" });
      setPending(null);
      onDone();
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't update default", description: err.message, variant: "destructive" });
    },
  });
  const request = (build: () => PendingSync) => {
    try {
      setPending(build());
    } catch (err) {
      toast({ title: "Can't continue", description: (err as Error).message, variant: "destructive" });
    }
  };
  return {
    pending,
    request,
    cancel: () => setPending(null),
    confirm: () => {
      if (pending) mutation.mutate(pending);
    },
    working: mutation.isPending,
  };
}

function DefaultSyncDialog({ sync }: { sync: ReturnType<typeof usePersonaDefaultSync> }) {
  const mode: DefaultSyncMode = sync.pending?.mode ?? "apply";
  return (
    <AlertDialog open={sync.pending != null} onOpenChange={(o) => { if (!o) sync.cancel(); }}>
      <AlertDialogContent className="max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{sync.pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>{sync.pending?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ApplyDiffView rows={sync.pending?.rows || []} mode={mode} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={sync.working || (sync.pending?.rows.length ?? 0) === 0} onClick={(event) => { event.preventDefault(); sync.confirm(); }}>
            {sync.working ? "Working…" : mode === "revert" ? "Revert to default" : "Apply to default"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PersonaActionsMenu({
  onApplyAll,
  onRevertAll,
  showAdvancedFields,
  onToggleAdvancedFields,
}: {
  onApplyAll?: () => void;
  onRevertAll?: () => void;
  showAdvancedFields: boolean;
  onToggleAdvancedFields: () => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label="Persona actions"
          data-testid="button-persona-actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        {onApplyAll && <DropdownMenuItem onSelect={onApplyAll}>Apply to Default</DropdownMenuItem>}
        {onRevertAll && <DropdownMenuItem onSelect={onRevertAll}>Revert to Default</DropdownMenuItem>}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onToggleAdvancedFields();
          }}
        >
          <Check className={cn("mr-2 h-3.5 w-3.5", showAdvancedFields ? "text-cta" : "text-muted-foreground/30")} />
          {showAdvancedFields ? "Hide Advanced Fields" : "Show Advanced Fields"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ContextSectionCatalogEntry {
  id: string;
  title: string;
  description: string;
  recommendedFor: string;
  tokenCost: "small" | "medium" | "large";
  defaultIncluded: boolean;
  lockedByRoot?: boolean;
}

interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  isCore: boolean;
}

function PersonaIconDisplay({ iconName, className }: { iconName: string; className?: string }) {
  const Icon = resolvePersonaIcon(iconName);
  return <Icon className={className} />;
}

function LocalEditMark({ field, changedFields }: { field: LocalField; changedFields?: string[] }) {
  const matches =
    field === "memoryGraphTokenBudget"
      ? changedFields?.includes("cognitiveOverrides")
      : changedFields?.includes(field);
  if (!matches) return null;
  return <Circle className="h-1.5 w-1.5 fill-warning text-warning" aria-label="Edited locally" />;
}

function IconPicker({
  value,
  onChange,
  compact,
}: {
  value: string;
  onChange: (icon: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
            compact ? "h-6 w-6 min-h-6 min-w-6" : "h-8 gap-2 px-2",
          )}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label="Change icon"
          data-testid="button-icon-picker-toggle"
        >
          <PersonaIconDisplay iconName={value} className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-56 p-2"
        data-testid="icon-picker-grid"
        onClick={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="grid grid-cols-5 gap-1">
          {AVAILABLE_ICONS.map((iconName) => (
            <button
              key={iconName}
              type="button"
              onClick={() => {
                onChange(iconName);
                setOpen(false);
              }}
              className={cn(
                "flex h-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                value === iconName && "bg-accent text-foreground",
              )}
              title={iconName}
              data-testid={`icon-option-${iconName}`}
            >
              <PersonaIconDisplay iconName={iconName} className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PersonaProseEditor({
  value,
  changed,
  onCommit,
  onApplyField,
  onRevertField,
  applyField,
  placeholder,
  actionLabel,
  minHeightClassName = "min-h-[2.75rem]",
  markdown = false,
}: {
  value: string;
  changed?: boolean;
  onCommit: (next: string) => void;
  onApplyField?: (field: LocalField) => void;
  onRevertField?: (field: LocalField) => void;
  applyField: LocalField;
  placeholder: string;
  actionLabel: string;
  minHeightClassName?: string;
  markdown?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const showMenu = Boolean(onApplyField || onRevertField);
  const showMarkdownPreview = markdown && !editing;
  const commitDraft = () => {
    if (draft !== value) onCommit(draft);
    setEditing(false);
  };
  return (
    <div className="group/editor grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-0 px-2 py-1.5">
      <div className={cn(PROFILE_DESCRIPTION_FRAME_CLASS, "min-w-0")}>
        {changed && (
          <div className="mb-1 flex justify-end">
            <Circle className="h-1.5 w-1.5 fill-warning text-warning" aria-label="Edited locally" />
          </div>
        )}
        {showMarkdownPreview ? (
          <button
            type="button"
            className={cn(
              minHeightClassName,
              "w-full cursor-text rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
            onClick={() => setEditing(true)}
            aria-label={`Edit ${actionLabel.replace(/ actions$/i, "").toLowerCase()}`}
          >
            {value.trim() ? (
              <div className={cn("prose prose-sm dark:prose-invert max-w-none break-words", PROFILE_DESCRIPTION_TEXT_CLASS, "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-pre:overflow-x-auto")}>
                <MarkdownContent content={value} compact />
              </div>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </button>
        ) : (
          <Textarea
            value={draft}
            autoFocus={markdown}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              if (markdown) setEditing(true);
            }}
            onBlur={commitDraft}
            placeholder={placeholder}
            className={cn(
              minHeightClassName,
              "w-full resize-none border-0 bg-transparent p-0 shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]",
              PROFILE_DESCRIPTION_TEXT_CLASS,
            )}
          />
        )}
      </div>
      {showMenu ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 min-h-6 w-6 min-w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/editor:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={actionLabel}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
            {onApplyField && <DropdownMenuItem onSelect={() => onApplyField(applyField)}>Apply to Default</DropdownMenuItem>}
            {onRevertField && <DropdownMenuItem onSelect={() => onRevertField(applyField)}>Revert to Default</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="h-6 w-6 shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}

function PersonaPayloadEditor({
  persona,
  draft,
  onChange,
  onCommit,
  onApplyField,
  onRevertField,
  showAdvancedFields,
}: {
  persona: Persona;
  draft: PersonaPayloadDraft;
  onChange: (draft: PersonaPayloadDraft) => void;
  onCommit?: (draft: PersonaPayloadDraft) => void;
  onApplyField?: (field: LocalField) => void;
  onRevertField?: (field: LocalField) => void;
  showAdvancedFields: boolean;
}) {
  const { data: sectionCatalog = [] } = useQuery<ContextSectionCatalogEntry[]>({ queryKey: ["/api/personas/section-catalog"] });
  const { data: toolCatalog = [] } = useQuery<ToolCatalogEntry[]>({ queryKey: ["/api/personas/tool-catalog"] });
  const { data: allPersonas = [] } = useQuery<Persona[]>({ queryKey: ["/api/personas/management"] });
  const rootPersona = allPersonas.find((entry) => entry.isSystem && entry.name === "Root");
  const rootContextOn = new Set(Object.entries(rootPersona?.contextSections || {}).filter(([, on]) => on).map(([id]) => id));
  const rootToolsOn = new Set(rootPersona?.toolBundle || []);
  const set = <K extends keyof PersonaPayloadDraft>(key: K, value: PersonaPayloadDraft[K]) => onChange({ ...draft, [key]: value });
  const commit = <K extends keyof PersonaPayloadDraft>(key: K, value: PersonaPayloadDraft[K]) => {
    const next = { ...draft, [key]: value };
    onChange(next);
    onCommit?.(next);
  };
  const commitInput = <K extends keyof PersonaPayloadDraft>(key: K, original: PersonaPayloadDraft[K]) => ({
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value as PersonaPayloadDraft[K];
      if (value !== original) commit(key, value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur();
      if (event.key === "Escape") {
        event.currentTarget.value = String(original);
        set(key, original);
        event.currentTarget.blur();
      }
    },
  });
  const mark = (field: LocalField) => <LocalEditMark field={field} changedFields={persona.changedFields} />;
  const fieldMenu = (field: LocalField) =>
    onApplyField || onRevertField ? (
      <>
        {onApplyField && <DropdownMenuItem onSelect={() => onApplyField(field)}>Apply to Default</DropdownMenuItem>}
        {onRevertField && <DropdownMenuItem onSelect={() => onRevertField(field)}>Revert to Default</DropdownMenuItem>}
      </>
    ) : undefined;
  return (
    <div>
      <PersonaProseEditor
        value={draft.description}
        changed={persona.changedFields?.includes("description")}
        onCommit={(description) => commit("description", description)}
        onApplyField={onApplyField}
        onRevertField={onRevertField}
        applyField="description"
        placeholder="Add description"
        actionLabel="Description actions"
      />
      <ProfileTreeRow label="Memory" icon={mark("memoryGraphTokenBudget")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("memoryGraphTokenBudget")} menuVisibility="hover">
        <Select value={budgetToTier(draft.memoryGraphTokenBudget) || undefined} onValueChange={(value) => commit("memoryGraphTokenBudget", tierToBudget(value))}>
          <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
          <SelectContent>
            {MEMORY_TIERS.map((tier) => (
              <SelectItem key={tier.value} value={tier.value}>{tier.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ProfileTreeRow>
      <ProfileTreeRow label="Thinking" icon={mark("semanticTier")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("semanticTier")} menuVisibility="hover">
        <Select value={draft.semanticTier} onValueChange={(value) => commit("semanticTier", value as PersonaPayloadDraft["semanticTier"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="max">Max</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="balanced">Balanced</SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
          </SelectContent>
        </Select>
      </ProfileTreeRow>
      {showAdvancedFields && (
        <>
          <ProfileTreeRow label="Expressions" icon={mark("expressionTags")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("expressionTags")} menuVisibility="hover" expandedContent={<Input value={draft.expressionTags} placeholder="curious, gravitas" onChange={(event) => set("expressionTags", event.target.value)} {...commitInput("expressionTags", persona.expressionTags.join(", "))} />}>
            <span className="truncate">{draft.expressionTags || "None"}</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Context" icon={mark("contextSections")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("contextSections")} menuVisibility="hover" expandedContent={<div>{sectionCatalog.map((entry) => {
            const locked = Boolean(entry.lockedByRoot) || rootContextOn.has(entry.id);
            const on = locked || (entry.id in draft.contextSections ? draft.contextSections[entry.id] : entry.defaultIncluded);
            return (
              <button key={entry.id} type="button" disabled={locked && !persona.isSystem} className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70 disabled:opacity-60")} onClick={() => {
                if (locked && !persona.isSystem) return;
                commit("contextSections", { ...draft.contextSections, [entry.id]: !on });
              }}>
                <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on && "border-cta bg-cta text-cta-foreground", locked && "border-muted-foreground/50 bg-muted text-muted-foreground")}>{on && <Check className="h-3 w-3" />}</span>
                <span className="text-sm">{entry.title}</span>
                {locked && <span className="ml-auto text-xs text-muted-foreground">Root</span>}
              </button>
            );
          })}</div>}>
            <span>{Object.keys(draft.contextSections).length} overrides</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Tools" icon={mark("toolBundle")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("toolBundle")} menuVisibility="hover" expandedContent={<div>{toolCatalog.map((entry) => {
            const locked = entry.isCore || rootToolsOn.has(entry.name);
            const on = locked || draft.toolBundle.includes(entry.name);
            return (
              <button key={entry.name} type="button" disabled={locked} className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70 disabled:opacity-60")} onClick={() => commit("toolBundle", on ? draft.toolBundle.filter((name) => name !== entry.name) : [...draft.toolBundle, entry.name])}>
                <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on && "border-cta bg-cta text-cta-foreground", locked && "border-muted-foreground/50 bg-muted text-muted-foreground")}>{on && <Check className="h-3 w-3" />}</span>
                <span className="text-sm">{entry.name}</span>
                {locked && <span className="ml-auto text-xs text-muted-foreground">{entry.isCore ? "Core" : "Root"}</span>}
              </button>
            );
          })}</div>}>
            <span>{draft.toolBundle.length ? `${draft.toolBundle.length} selected` : "All tools"}</span>
          </ProfileTreeRow>
        </>
      )}
      <PersonaProseEditor
        value={draft.promptOverlay}
        changed={persona.changedFields?.includes("promptOverlay")}
        onCommit={(promptOverlay) => commit("promptOverlay", promptOverlay)}
        onApplyField={onApplyField}
        onRevertField={onRevertField}
        applyField="promptOverlay"
        placeholder="Add prompt"
        actionLabel="Prompt actions"
        minHeightClassName="min-h-32"
        markdown
      />
    </div>
  );
}

function PersonaNameEditor({
  name,
  canEdit,
  changed,
  onCommit,
}: {
  name: string;
  canEdit: boolean;
  changed?: boolean;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [name]);
  const stop = (event: MouseEvent) => event.stopPropagation();
  if (editing && canEdit) {
    return (
      <Input
        value={draft}
        autoFocus
        onClick={stop}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next && next !== name) onCommit(next);
          else setDraft(name);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
        className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none ring-0 focus-visible:ring-0"
      />
    );
  }
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
      onClick={(event) => {
        if (!canEdit) return;
        event.stopPropagation();
        setEditing(true);
      }}
    >
      <span className="min-w-0 truncate text-foreground">{name}</span>
      {changed && <Circle className="h-1.5 w-1.5 shrink-0 fill-warning text-warning" aria-label="Edited locally" />}
    </button>
  );
}

function PersonaTreeItem({
  persona,
  canApply,
  onUpdate,
  onRefresh,
}: {
  persona: Persona;
  canApply: boolean;
  onRefresh: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  useEffect(() => {
    setDraft(draftFromPersona(persona));
  }, [persona]);
  const sync = usePersonaDefaultSync(onRefresh);
  const showApply = canApply && resolveApplyTargetId(persona) != null;
  const showRevert = showApply && personaBaseline(persona) != null;
  const collapsedDescription = draft.description.trim();
  const personaAction = useMutation({
    mutationFn: async ({ action }: { action: "keep-mine" | "use-updated-default" }) => {
      await apiRequest("POST", `/api/personas/${persona.id}/${action}`, {});
    },
    onSuccess: onRefresh,
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`persona-row-${persona.id}`}>
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "group hover:bg-accent/70")}>
        {persona.isSystem ? (
          <PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className="relative shrink-0">
            <IconPicker value={persona.icon} compact onChange={(icon) => onUpdate({ icon })} />
            {persona.changedFields?.includes("icon") && (
              <Circle className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 fill-warning text-warning" aria-label="Edited locally" />
            )}
          </span>
        )}
        <PersonaNameEditor
          name={persona.name}
          canEdit={!persona.isSystem}
          changed={persona.changedFields?.includes("name")}
          onCommit={(name) => onUpdate({ name })}
        />
        {persona.isDefault && <span className="shrink-0 text-xs text-muted-foreground/70">Default</span>}
        <CollapsibleTrigger asChild>
          <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground" aria-label={open ? "Collapse persona" : "Expand persona"}>
            <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
        <PersonaActionsMenu
          onApplyAll={showApply ? () => sync.request(() => buildApplyAll(persona, draft)) : undefined}
          onRevertAll={showRevert ? () => sync.request(() => buildRevertAll(persona)) : undefined}
          showAdvancedFields={showAdvancedFields}
          onToggleAdvancedFields={() => setShowAdvancedFields((current) => !current)}
        />
      </div>
      {!open && collapsedDescription ? (
        <div className="px-2 pb-1">
          <div className={cn(PROFILE_DESCRIPTION_TEXT_CLASS, "whitespace-pre-wrap text-white/80")}>
            {collapsedDescription}
          </div>
        </div>
      ) : null}
      <CollapsibleContent>
        <div className="px-2 pb-2">
          <PersonaPayloadEditor
            persona={persona}
            draft={draft}
            onChange={setDraft}
            onCommit={(next) => onUpdate(payloadFromDraft(next))}
            onApplyField={showApply ? (field) => sync.request(() => buildApplyField(persona, draft, field)) : undefined}
            onRevertField={showRevert ? (field) => sync.request(() => buildRevertField(persona, field)) : undefined}
            showAdvancedFields={showAdvancedFields}
          />
          {persona.updateAvailable && (
            <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default")}>
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">Update available</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => personaAction.mutate({ action: "keep-mine" })}>Keep mine</Button>
                  <Button size="sm" onClick={() => personaAction.mutate({ action: "use-updated-default" })}>Use updated default</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
      <DefaultSyncDialog sync={sync} />
    </Collapsible>
  );
}

function CreatePersonaForm({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("Bot");
  const [promptOverlay, setPromptOverlay] = useState("");
  const [expressionTags, setExpressionTags] = useState("");
  const [semanticTier, setSemanticTier] = useState<"max" | "high" | "balanced" | "fast">("balanced");
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/personas", {
        name,
        description,
        icon,
        promptOverlay: promptOverlay || undefined,
        expressionTags: expressionTags.split(",").map((tag) => tag.trim()).filter(Boolean),
        cognitiveOverrides: {},
        semanticTier,
      });
    },
    onSuccess: () => {
      toast({ title: "Persona created" });
      onClose();
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });
  return (
    <Card className="overflow-hidden">
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between border-b border-border/20")}>
        <span className="text-sm">New Persona</span>
        <Button size="sm" variant="ghost" onClick={onClose} className="h-5 w-5 p-0">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-2 px-2 py-2">
        <div className="flex items-center gap-2">
          <IconPicker value={icon} onChange={setIcon} />
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" className="h-8 text-sm" />
        </div>
        <div className={PROFILE_DESCRIPTION_FRAME_CLASS}>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Add description"
            className={cn("min-h-[2.75rem] w-full resize-none border-0 bg-transparent p-0 shadow-none md:text-[14px]", PROFILE_DESCRIPTION_TEXT_CLASS)}
          />
        </div>
        <div className={PROFILE_DESCRIPTION_FRAME_CLASS}>
          <Textarea
            value={promptOverlay}
            onChange={(event) => setPromptOverlay(event.target.value)}
            placeholder="Add prompt"
            className={cn("min-h-32 w-full resize-none border-0 bg-transparent p-0 shadow-none md:text-[14px]", PROFILE_DESCRIPTION_TEXT_CLASS)}
          />
        </div>
        <Select value={semanticTier} onValueChange={(value) => setSemanticTier(value as typeof semanticTier)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="max">Max</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="balanced">Balanced</SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
          </SelectContent>
        </Select>
        <Input value={expressionTags} onChange={(event) => setExpressionTags(event.target.value)} placeholder="curious, gravitas" className="h-8 text-sm" />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || !name}>
            {mutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

function PlatformPersonaItem({ persona, canApply, onPublished }: { persona: Persona; canApply: boolean; onPublished: () => void }) {
  const [open, setOpen] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  useEffect(() => {
    setDraft(draftFromPersona(persona));
  }, [persona]);
  const sync = usePersonaDefaultSync(onPublished);
  const showApply = canApply && resolveApplyTargetId(persona) != null;
  const collapsedDescription = draft.description.trim();
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`persona-row-${persona.id}`}>
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "group hover:bg-accent/70")}>
        <PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{persona.name}</span>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground" aria-label={open ? "Collapse persona" : "Expand persona"}>
            <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
        <PersonaActionsMenu
          onApplyAll={showApply ? () => sync.request(() => buildApplyAll(persona, draft)) : undefined}
          showAdvancedFields={showAdvancedFields}
          onToggleAdvancedFields={() => setShowAdvancedFields((current) => !current)}
        />
      </div>
      {!open && collapsedDescription ? (
        <div className="px-2 pb-1">
          <div className={cn(PROFILE_DESCRIPTION_TEXT_CLASS, "whitespace-pre-wrap text-white/80")}>
            {collapsedDescription}
          </div>
        </div>
      ) : null}
      <CollapsibleContent>
        <div className="px-2 pb-2">
          <PersonaPayloadEditor
            persona={persona}
            draft={draft}
            onChange={setDraft}
            onApplyField={showApply ? (field) => sync.request(() => buildApplyField(persona, draft, field)) : undefined}
            showAdvancedFields={showAdvancedFields}
          />
        </div>
      </CollapsibleContent>
      <DefaultSyncDialog sync={sync} />
    </Collapsible>
  );
}

export default function PersonasPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canApply = hasPermission("system:write");
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const { data: allPersonas, isLoading } = useQuery<Persona[]>({
    queryKey: ["/api/personas/management"],
    refetchInterval: 30000,
  });
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      await apiRequest("PUT", `/api/personas/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
  };
  const personas = allPersonas || [];
  const sortedPersonas = useMemo(
    () =>
      [...personas].sort(
        (a, b) => (a.isSystem ? -1 : 0) - (b.isSystem ? -1 : 0) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [personas],
  );
  const trimmedSearch = searchQuery.trim().toLowerCase();
  const visiblePersonas = useMemo(() => {
    if (!trimmedSearch) return sortedPersonas;
    return sortedPersonas.filter((persona) => {
      const haystack = [
        persona.name,
        persona.description,
        persona.promptOverlay || "",
        persona.expressionTags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedSearch);
    });
  }, [sortedPersonas, trimmedSearch]);
  return (
    <div className={cn(HIERARCHY_TREE_STACK_CLASS, "w-full")}>
      <HierarchySearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        inputTestId="input-search-personas"
        clearTestId="button-clear-search-personas"
        ariaLabel="Search personas"
      />
      <button type="button" onClick={() => setCreating(true)} className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="button-new-persona">
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Persona</span>
      </button>
      {creating && <CreatePersonaForm onSuccess={refresh} onClose={() => setCreating(false)} />}
      <section>
        <h2 className={HIERARCHY_SECTION_HEADER_CLASS}>Personas</h2>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : visiblePersonas.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {trimmedSearch ? `No personas match "${searchQuery.trim()}"` : "No personas yet"}
          </div>
        ) : (
          <div>
            {visiblePersonas.map((persona) =>
              persona.isSystem ? (
                <PlatformPersonaItem key={persona.id} persona={persona} canApply={canApply} onPublished={refresh} />
              ) : (
                <PersonaTreeItem
                  key={persona.id}
                  persona={persona}
                  canApply={canApply}
                  onRefresh={refresh}
                  onUpdate={(data) => updateMutation.mutate({ id: persona.id, data })}
                />
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
}
