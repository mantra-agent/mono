import { useEffect, useMemo, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Check, ChevronRight, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_SECTION_HEADER_CLASS, HIERARCHY_SESSION_ROW_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { MarkdownContent } from "@/components/chat-shared";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { PROFILE_DESCRIPTION_FRAME_CLASS, PROFILE_DESCRIPTION_TEXT_CLASS } from "@/components/profile-description-style";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusDot, DefaultSyncDialog, useDefaultSync, buildDiffRows, computeLatticeCell, type PendingSync, type ApplyDiffRow } from "@/components/lattice-controls";
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
  return buildDiffRows(before, after, (field) => FIELD_LABELS[field as LocalField] || field);
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

function PersonaActionsMenu({
  onRevert,
  onUpdate,
  onMergeKeepMine,
  onMergeTakeTheirs,
  onPublish,
  showAdvancedFields,
  onToggleAdvancedFields,
}: {
  onRevert?: () => void;
  onUpdate?: () => void;
  onMergeKeepMine?: () => void;
  onMergeTakeTheirs?: () => void;
  onPublish?: () => void;
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
        {onRevert && <DropdownMenuItem onSelect={onRevert}>Revert</DropdownMenuItem>}
        {onUpdate && <DropdownMenuItem onSelect={onUpdate}>Update</DropdownMenuItem>}
        {onMergeKeepMine && <DropdownMenuItem onSelect={onMergeKeepMine}>Merge · Keep Mine</DropdownMenuItem>}
        {onMergeTakeTheirs && <DropdownMenuItem onSelect={onMergeTakeTheirs}>Merge · Take Theirs</DropdownMenuItem>}
        {onPublish && <DropdownMenuItem onSelect={onPublish}>Publish</DropdownMenuItem>}
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

function fieldChanged(field: LocalField, changedFields?: string[]): boolean {
  return field === "memoryGraphTokenBudget"
    ? Boolean(changedFields?.includes("cognitiveOverrides"))
    : Boolean(changedFields?.includes(field));
}

function fieldValueClass(changed?: boolean): string {
  return changed ? "text-white" : "text-muted-foreground";
}


function LocalEditMark({ field, changedFields }: { field: LocalField; changedFields?: string[] }) {
  if (!fieldChanged(field, changedFields)) return null;
  return <StatusDot kind="local" />;
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
            <StatusDot kind="local" />
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
              <div className={cn("prose prose-sm dark:prose-invert max-w-none break-words text-[14px] leading-tight", fieldValueClass(changed), "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-pre:overflow-x-auto")}>
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
              "text-[14px] leading-tight",
              fieldValueClass(changed),
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
  const valueTone = (field: LocalField) => fieldValueClass(fieldChanged(field, persona.changedFields));
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
          <SelectTrigger className={valueTone("memoryGraphTokenBudget")}><SelectValue placeholder="Default" /></SelectTrigger>
          <SelectContent>
            {MEMORY_TIERS.map((tier) => (
              <SelectItem key={tier.value} value={tier.value}>{tier.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ProfileTreeRow>
      <ProfileTreeRow label="Thinking" icon={mark("semanticTier")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("semanticTier")} menuVisibility="hover">
        <Select value={draft.semanticTier} onValueChange={(value) => commit("semanticTier", value as PersonaPayloadDraft["semanticTier"])}>
          <SelectTrigger className={valueTone("semanticTier")}><SelectValue /></SelectTrigger>
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
            <span className={cn("truncate", valueTone("expressionTags"))}>{draft.expressionTags || "None"}</span>
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
            <span className={valueTone("contextSections")}>{Object.keys(draft.contextSections).length} overrides</span>
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
            <span className={valueTone("toolBundle")}>{draft.toolBundle.length ? `${draft.toolBundle.length} selected` : "All tools"}</span>
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
      {changed && <StatusDot kind="local" className="shrink-0" />}
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
  const sync = useDefaultSync(onRefresh);
  // One cell, computed once: two booleans → state → its move(s) + admin Publish.
  const canPublish = canApply && resolveApplyTargetId(persona) != null;
  const canRevert = !persona.isSystem && personaBaseline(persona) != null;
  const cell = computeLatticeCell({
    localChanged: (persona.changedFields?.length ?? 0) > 0,
    defaultAdvanced: Boolean(persona.updateAvailable),
    isAdmin: canPublish,
  });
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
              <StatusDot kind="local" className="absolute -right-0.5 -top-0.5" />
            )}
          </span>
        )}
        <PersonaNameEditor
          name={persona.name}
          canEdit={!persona.isSystem}
          changed={persona.changedFields?.includes("name")}
          onCommit={(name) => onUpdate({ name })}
        />
        {persona.updateAvailable ? (
          <StatusDot kind="inbound" className="shrink-0" />
        ) : (persona.changedFields?.length ?? 0) > 0 ? (
          <StatusDot kind="local" className="shrink-0" />
        ) : null}
        {persona.isDefault && <span className="shrink-0 text-xs text-muted-foreground/70">Default</span>}
        <CollapsibleTrigger asChild>
          <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground" aria-label={open ? "Collapse persona" : "Expand persona"}>
            <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
        <PersonaActionsMenu
          onRevert={cell.showRevert && canRevert ? () => sync.request(() => buildRevertAll(persona)) : undefined}
          onUpdate={cell.showUpdate ? () => personaAction.mutate({ action: "use-updated-default" }) : undefined}
          onMergeKeepMine={cell.showMerge ? () => personaAction.mutate({ action: "keep-mine" }) : undefined}
          onMergeTakeTheirs={cell.showMerge ? () => personaAction.mutate({ action: "use-updated-default" }) : undefined}
          onPublish={cell.showPublish ? () => sync.request(() => buildApplyAll(persona, draft)) : undefined}
          showAdvancedFields={showAdvancedFields}
          onToggleAdvancedFields={() => setShowAdvancedFields((current) => !current)}
        />
      </div>
      {!open && collapsedDescription ? (
        <div className="px-2 pb-1">
          <div className={cn("whitespace-pre-wrap text-[14px] leading-tight", fieldValueClass(persona.changedFields?.includes("description")))}>
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
            onApplyField={canPublish ? (field) => sync.request(() => buildApplyField(persona, draft, field)) : undefined}
            onRevertField={canRevert ? (field) => sync.request(() => buildRevertField(persona, field)) : undefined}
            showAdvancedFields={showAdvancedFields}
          />
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
    <div className="space-y-0.5 px-2 pb-2">
      <ProfileTreeRow
        label="Name"
        icon={<IconPicker value={icon} compact onChange={setIcon} />}
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="row-new-persona-name"
        actionContent={(
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim()}
            className="text-xs text-cta disabled:text-muted-foreground"
            data-testid="button-create-persona"
          >
            {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
          </button>
        )}
      >
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim() && !mutation.isPending) mutation.mutate();
            if (event.key === "Escape") onClose();
          }}
          placeholder="Name"
          className="h-7 text-right text-xs"
          data-testid="input-new-persona-name"
        />
      </ProfileTreeRow>
      <ProfileTreeRow label="Thinking" hasValue showEmpty mobileLayout="inline" testId="row-new-persona-thinking">
        <Select value={semanticTier} onValueChange={(value) => setSemanticTier(value as typeof semanticTier)}>
          <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="max">Max</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="balanced">Balanced</SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
          </SelectContent>
        </Select>
      </ProfileTreeRow>
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
      <ProfileTreeRow label="Expressions" hasValue showEmpty mobileLayout="inline" testId="row-new-persona-expressions">
        <Input
          value={expressionTags}
          onChange={(event) => setExpressionTags(event.target.value)}
          placeholder="curious, gravitas"
          className="h-7 text-right text-xs"
        />
      </ProfileTreeRow>
    </div>
  );
}

function PlatformPersonaItem({ persona, canApply, onPublished }: { persona: Persona; canApply: boolean; onPublished: () => void }) {
  const [open, setOpen] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  useEffect(() => {
    setDraft(draftFromPersona(persona));
  }, [persona]);
  const sync = useDefaultSync(onPublished);
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
          onPublish={showApply ? () => sync.request(() => buildApplyAll(persona, draft)) : undefined}
          showAdvancedFields={showAdvancedFields}
          onToggleAdvancedFields={() => setShowAdvancedFields((current) => !current)}
        />
      </div>
      {!open && collapsedDescription ? (
        <div className="px-2 pb-1">
          <div className={cn("whitespace-pre-wrap text-[14px] leading-tight", fieldValueClass(false))}>
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
      {creating ? (
        <CreatePersonaForm onSuccess={refresh} onClose={() => setCreating(false)} />
      ) : (
        <button type="button" onClick={() => setCreating(true)} className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="button-new-persona">
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Persona</span>
        </button>
      )}
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
