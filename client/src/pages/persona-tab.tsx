import { useEffect, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Check, ChevronRight, Circle, Loader2, MoreHorizontal, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_SECTION_HEADER_CLASS, HIERARCHY_SESSION_ROW_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { Card } from "@/components/ui/card";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { PROFILE_DESCRIPTION_FRAME_CLASS, PROFILE_DESCRIPTION_TEXT_CLASS } from "@/components/profile-description-style";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  memoryGraphTokenBudget: "Memory graph budget",
  semanticTier: "Model",
  contextSections: "Context",
  toolBundle: "Tool bundle",
};

const UPDATE_STATE_LABELS: Record<Persona["updateState"], string> = {
  following: "Following default",
  customized: "Customized",
  update_available: "Update available",
  conflict: "Conflict",
  pinned_legacy: "Customized",
};

interface ApplyDiffRow {
  field: string;
  before: string;
  after: string;
}

interface ApplyPending {
  title: string;
  description: string;
  changes: Record<string, unknown>;
  summary: string;
  rows: ApplyDiffRow[];
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

function buildApplyAll(persona: Persona, draft: PersonaPayloadDraft): ApplyPending {
  const changes = fullApplyPayload(persona, draft);
  const baseline =
    persona.platformBaseline ||
    (persona.isSystem || persona.source === "seed"
      ? {
          name: persona.name,
          icon: persona.icon,
          description: persona.description,
          promptOverlay: persona.promptOverlay,
          expressionTags: persona.expressionTags,
          cognitiveOverrides: persona.cognitiveOverrides,
          semanticTier: persona.semanticTier,
          contextSections: persona.contextSections,
          toolBundle: persona.toolBundle,
        }
      : null);
  return {
    title: `Apply ${persona.name} to default?`,
    description: `Publish ${persona.name}'s current values as the platform default for everyone. Personas following the default update automatically; customized copies get an "Update available".`,
    changes,
    summary: `Apply ${persona.name} to default`,
    rows: buildApplyDiffRows(baseline as Record<string, unknown> | null, changes),
  };
}

function buildApplyField(persona: Persona, draft: PersonaPayloadDraft, field: LocalField): ApplyPending {
  const label = FIELD_LABELS[field];
  const payload = fullApplyPayload(persona, draft);
  const publishedField = field === "memoryGraphTokenBudget" ? "cognitiveOverrides" : field;
  const changes = { [publishedField]: payload[publishedField] };
  const beforeValue =
    persona.platformBaseline
      ? (persona.platformBaseline as Record<string, unknown>)[publishedField]
      : persona.isSystem || persona.source === "seed"
        ? (persona as unknown as Record<string, unknown>)[publishedField]
        : undefined;
  return {
    title: `Apply ${label} to default?`,
    description: `Publish ${persona.name}'s ${label} as the platform default for everyone.`,
    changes,
    summary: `Apply ${label} to default`,
    rows: buildApplyDiffRows(
      { [publishedField]: beforeValue },
      changes,
    ),
  };
}

function ApplyDiffView({ rows }: { rows: ApplyDiffRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes from the current default.</p>;
  }
  return (
    <div className="max-h-80 space-y-2 overflow-auto pr-1">
      {rows.map((row) => (
        <div key={row.field} className="rounded-md border border-border/40 bg-muted/20 p-2">
          <div className="mb-1 text-xs font-medium text-foreground">{row.field}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Current default</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 text-xs text-muted-foreground">{row.before}</pre>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">After apply</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 text-xs text-foreground">{row.after}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Promote a persona (or one field) up to its platform default, behind a confirmation prompt. */
function useApplyToDefault(persona: Persona, onDone: () => void) {
  const { toast } = useToast();
  const [pending, setPending] = useState<ApplyPending | null>(null);
  const applyTargetId = persona.templatePersonaId ?? ((persona.isSystem || persona.source === "seed") ? persona.id : null);
  const mutation = useMutation({
    mutationFn: async (input: ApplyPending) => {
      if (applyTargetId == null) throw new Error("This persona has no platform default to apply to.");
      await apiRequest("POST", `/api/personas/platform/${applyTargetId}/publish`, {
        changes: input.changes,
        changeSummary: input.summary,
        confirmed: true,
      });
    },
    onSuccess: () => {
      toast({ title: "Applied to default" });
      setPending(null);
      onDone();
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't apply to default", description: err.message, variant: "destructive" });
    },
  });
  const request = (build: () => ApplyPending) => {
    try {
      setPending(build());
    } catch (err) {
      toast({ title: "Can't apply", description: (err as Error).message, variant: "destructive" });
    }
  };
  return {
    hasTarget: applyTargetId != null,
    pending,
    request,
    cancel: () => setPending(null),
    confirm: () => {
      if (pending) mutation.mutate(pending);
    },
    applying: mutation.isPending,
  };
}

function ApplyToDefaultDialog({ apply }: { apply: ReturnType<typeof useApplyToDefault> }) {
  return (
    <AlertDialog open={apply.pending != null} onOpenChange={(o) => { if (!o) apply.cancel(); }}>
      <AlertDialogContent className="max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{apply.pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>{apply.pending?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ApplyDiffView rows={apply.pending?.rows || []} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={apply.applying || (apply.pending?.rows.length ?? 0) === 0} onClick={(event) => { event.preventDefault(); apply.confirm(); }}>
            {apply.applying ? "Applying…" : "Apply to default"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ApplyHeaderMenu({ onApplyAll }: { onApplyAll: () => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label="Persona actions"
          data-testid="button-persona-actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem onSelect={onApplyAll}>Apply to Default</DropdownMenuItem>
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
}

interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  isCore: boolean;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
    <div className="relative">
      <button
        type="button"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/70 hover:text-foreground",
          compact ? "h-5 w-5" : "h-8 gap-2 px-2",
        )}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        aria-label="Change icon"
        data-testid="button-icon-picker-toggle"
      >
        <PersonaIconDisplay iconName={value} className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 grid w-56 grid-cols-5 gap-1 rounded-md border border-border/30 bg-background p-2"
          data-testid="icon-picker-grid"
          onClick={(event) => event.stopPropagation()}
        >
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
      )}
    </div>
  );
}

function PersonaProseEditor({
  value,
  changed,
  onCommit,
  onApplyField,
  applyField,
  placeholder,
  actionLabel,
  minHeightClassName = "min-h-24",
}: {
  value: string;
  changed?: boolean;
  onCommit: (next: string) => void;
  onApplyField?: (field: LocalField) => void;
  applyField: LocalField;
  placeholder: string;
  actionLabel: string;
  minHeightClassName?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <div className={cn(PROFILE_DESCRIPTION_FRAME_CLASS, "group/editor relative")}>
      {(changed || onApplyField) && (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
          {changed && <Circle className="h-1.5 w-1.5 fill-warning text-warning" aria-label="Edited locally" />}
          {onApplyField && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/editor:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={actionLabel}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                <DropdownMenuItem onSelect={() => onApplyField(applyField)}>Apply to Default</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        placeholder={placeholder}
        className={cn(
          minHeightClassName,
          "w-full resize-none border-0 bg-transparent p-0 shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]",
          PROFILE_DESCRIPTION_TEXT_CLASS,
        )}
      />
    </div>
  );
}

function PersonaPayloadEditor({
  persona,
  draft,
  onChange,
  onCommit,
  onApplyField,
}: {
  persona: Persona;
  draft: PersonaPayloadDraft;
  onChange: (draft: PersonaPayloadDraft) => void;
  onCommit?: (draft: PersonaPayloadDraft) => void;
  onApplyField?: (field: LocalField) => void;
}) {
  const { data: sectionCatalog = [] } = useQuery<ContextSectionCatalogEntry[]>({ queryKey: ["/api/personas/section-catalog"] });
  const { data: toolCatalog = [] } = useQuery<ToolCatalogEntry[]>({ queryKey: ["/api/personas/tool-catalog"] });
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
    onApplyField ? <DropdownMenuItem onSelect={() => onApplyField(field)}>Apply to Default</DropdownMenuItem> : undefined;
  const originalBudget = readMemoryGraphTokenBudget(persona.cognitiveOverrides);
  const originalBudgetText = originalBudget == null ? "" : String(originalBudget);
  return (
    <div className="space-y-1">
      <PersonaProseEditor
        value={draft.description}
        changed={persona.changedFields?.includes("description")}
        onCommit={(description) => commit("description", description)}
        onApplyField={onApplyField}
        applyField="description"
        placeholder="Add description"
        actionLabel="Description actions"
      />
      <PersonaProseEditor
        value={draft.promptOverlay}
        changed={persona.changedFields?.includes("promptOverlay")}
        onCommit={(promptOverlay) => commit("promptOverlay", promptOverlay)}
        onApplyField={onApplyField}
        applyField="promptOverlay"
        placeholder="Add prompt"
        actionLabel="Prompt actions"
        minHeightClassName="min-h-32"
      />
      <div className="overflow-hidden">
        <ProfileTreeRow label="Expressions" icon={mark("expressionTags")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("expressionTags")} menuVisibility="hover" expandedContent={<Input value={draft.expressionTags} onChange={(event) => set("expressionTags", event.target.value)} {...commitInput("expressionTags", persona.expressionTags.join(", "))} />}>
          <span className="truncate">{draft.expressionTags || "None"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Memory graph budget"
          icon={mark("memoryGraphTokenBudget")}
          hasValue
          showEmpty
          mobileLayout="inline"
          menuContent={fieldMenu("memoryGraphTokenBudget")}
          menuVisibility="hover"
          expandedContent={
            <Input
              type="number"
              min={1}
              value={draft.memoryGraphTokenBudget}
              onChange={(event) => set("memoryGraphTokenBudget", event.target.value)}
              {...commitInput("memoryGraphTokenBudget", originalBudgetText)}
              placeholder="Default"
            />
          }
        >
          <span>{draft.memoryGraphTokenBudget || "Default"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Model" icon={mark("semanticTier")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("semanticTier")} menuVisibility="hover">
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
        <ProfileTreeRow label="Context" icon={mark("contextSections")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("contextSections")} menuVisibility="hover" expandedContent={<div>{sectionCatalog.map((entry) => {
          const on = entry.id in draft.contextSections ? draft.contextSections[entry.id] : entry.defaultIncluded;
          return (
            <button key={entry.id} type="button" className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70")} onClick={() => commit("contextSections", { ...draft.contextSections, [entry.id]: !on })}>
              <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on && "border-cta bg-cta text-cta-foreground")}>{on && <Check className="h-3 w-3" />}</span>
              <span className="text-sm">{entry.title}</span>
            </button>
          );
        })}</div>}>
          <span>{Object.keys(draft.contextSections).length} overrides</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Tool bundle" icon={mark("toolBundle")} hasValue showEmpty mobileLayout="inline" menuContent={fieldMenu("toolBundle")} menuVisibility="hover" expandedContent={<div>{toolCatalog.map((entry) => {
          const on = entry.isCore || draft.toolBundle.includes(entry.name);
          return (
            <button key={entry.name} type="button" disabled={entry.isCore} className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70 disabled:opacity-60")} onClick={() => commit("toolBundle", on ? draft.toolBundle.filter((name) => name !== entry.name) : [...draft.toolBundle, entry.name])}>
              <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on && "border-cta bg-cta text-cta-foreground")}>{on && <Check className="h-3 w-3" />}</span>
              <span className="text-sm">{entry.name}</span>
            </button>
          );
        })}</div>}>
          <span>{draft.toolBundle.length ? `${draft.toolBundle.length} selected` : "All tools"}</span>
        </ProfileTreeRow>
      </div>
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
  onRevert,
  onUpdate,
  onRefresh,
  onSetDefault,
}: {
  persona: Persona;
  canApply: boolean;
  onRevert: () => void;
  onRefresh: () => void;
  onSetDefault: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  useEffect(() => {
    setDraft(draftFromPersona(persona));
  }, [persona]);
  const apply = useApplyToDefault(persona, onRefresh);
  const showApply = canApply && apply.hasTarget;
  const { data: history = [] } = useQuery<Array<{ id: string; changeSummary: string; createdAt: string; createdByUserId: string | null }>>({
    queryKey: ["/api/personas", persona.id, "history"],
    enabled: open,
  });
  const personaAction = useMutation({
    mutationFn: async ({ action, revisionId }: { action: "restore" | "keep-mine" | "use-updated-default"; revisionId?: string }) => {
      await apiRequest("POST", `/api/personas/${persona.id}/${action}`, revisionId ? { revisionId } : {});
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
        {showApply && <ApplyHeaderMenu onApplyAll={() => apply.request(() => buildApplyAll(persona, draft))} />}
        <CollapsibleTrigger asChild>
          <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/60" aria-label={open ? "Collapse persona" : "Expand persona"}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="space-y-1 px-2 pb-2">
          <PersonaPayloadEditor
            persona={persona}
            draft={draft}
            onChange={setDraft}
            onCommit={(next) => onUpdate(payloadFromDraft(next))}
            onApplyField={showApply ? (field) => apply.request(() => buildApplyField(persona, draft, field)) : undefined}
          />
          {persona.updateAvailable && (
            <div className="px-2 text-sm">
              <p className="font-medium">Update available</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => personaAction.mutate({ action: "keep-mine" })}>Keep mine</Button>
                <Button size="sm" onClick={() => personaAction.mutate({ action: "use-updated-default" })}>Use updated default</Button>
              </div>
            </div>
          )}
          {history.length > 0 && (
            <div>
              {history.map((revision) => (
                <div key={revision.id} className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default")}>
                  <span className="min-w-0 flex-1 truncate">{revision.changeSummary}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(revision.createdAt)}</span>
                  {revision.id !== persona.currentRevisionId && revision.createdByUserId && (
                    <Button size="sm" variant="ghost" onClick={() => personaAction.mutate({ action: "restore", revisionId: revision.id })}>Restore</Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default justify-between")}>
            <p className="text-xs text-muted-foreground">{UPDATE_STATE_LABELS[persona.updateState]} · Updated {timeAgo(persona.updatedAt)}</p>
            <div className="flex items-center gap-2">
              {!persona.isSystem && !persona.isDefault && (
                <Button size="sm" variant="ghost" onClick={onSetDefault}>Set as default</Button>
              )}
              {persona.source !== "seed" && (persona.updateState === "customized" || persona.updateState === "pinned_legacy") && (
                <Button size="sm" variant="outline" className="gap-1" onClick={onRevert}>
                  <RotateCcw className="h-3 w-3" /> Revert to default
                </Button>
              )}
            </div>
          </div>
        </div>
      </CollapsibleContent>
      <ApplyToDefaultDialog apply={apply} />
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
            className={cn("min-h-24 w-full resize-none border-0 bg-transparent p-0 shadow-none md:text-[14px]", PROFILE_DESCRIPTION_TEXT_CLASS)}
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
        <Input value={expressionTags} onChange={(event) => setExpressionTags(event.target.value)} placeholder="Expressions" className="h-8 text-sm" />
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
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  useEffect(() => {
    setDraft(draftFromPersona(persona));
  }, [persona]);
  const apply = useApplyToDefault(persona, onPublished);
  const showApply = canApply && apply.hasTarget;
  const { data: history = [] } = useQuery<Array<{ id: string; payload: Record<string, unknown>; changeSummary: string; createdAt: string }>>({
    queryKey: ["/api/personas", persona.id, "history"],
    enabled: open,
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`persona-row-${persona.id}`}>
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "group hover:bg-accent/70")}>
        <PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{persona.name}</span>
        {showApply && <ApplyHeaderMenu onApplyAll={() => apply.request(() => buildApplyAll(persona, draft))} />}
        <CollapsibleTrigger asChild>
          <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/60" aria-label={open ? "Collapse persona" : "Expand persona"}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="space-y-1 px-2 pb-2">
          <PersonaPayloadEditor
            persona={persona}
            draft={draft}
            onChange={setDraft}
            onApplyField={showApply ? (field) => apply.request(() => buildApplyField(persona, draft, field)) : undefined}
          />
          {history.length > 0 && history.map((revision) => (
            <div key={revision.id} className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default")}>
              <span className="min-w-0 flex-1 truncate">{revision.changeSummary}</span>
              <span className="text-xs text-muted-foreground">{timeAgo(revision.createdAt)}</span>
              {showApply && revision.id !== persona.currentRevisionId && (
                <Button size="sm" variant="ghost" onClick={() => apply.request(() => ({
                  title: `Republish this ${persona.name} revision?`,
                  description: `Publish this earlier ${persona.name} revision as the current platform default.`,
                  changes: revision.payload,
                  summary: `Republish ${revision.changeSummary}`,
                  rows: buildApplyDiffRows(
                    {
                      name: persona.name,
                      icon: persona.icon,
                      description: persona.description,
                      promptOverlay: persona.promptOverlay,
                      expressionTags: persona.expressionTags,
                      cognitiveOverrides: persona.cognitiveOverrides,
                      semanticTier: persona.semanticTier,
                      contextSections: persona.contextSections,
                      toolBundle: persona.toolBundle,
                    },
                    revision.payload,
                  ),
                }))}>Republish</Button>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
      <ApplyToDefaultDialog apply={apply} />
    </Collapsible>
  );
}

export default function PersonasPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canApply = hasPermission("system:write");
  const [creating, setCreating] = useState(false);
  const { data: allPersonas, isLoading } = useQuery<Persona[]>({
    queryKey: ["/api/personas/management"],
    refetchInterval: 30000,
  });
  const revertMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/personas/${id}/use-updated-default`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
      toast({ title: "Persona reverted to default" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
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
  const defaultMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/personas/${id}/set-default`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
      toast({ title: "Default Persona updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
  };
  const personas = allPersonas || [];
  const sortedPersonas = [...personas].sort((a, b) => (a.isSystem ? -1 : 0) - (b.isSystem ? -1 : 0) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return (
    <div className={cn(HIERARCHY_TREE_STACK_CLASS, "w-full")}>
      <section>
        <h2 className={HIERARCHY_SECTION_HEADER_CLASS}>Personas</h2>
        <button type="button" onClick={() => setCreating(true)} className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="button-new-persona">
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Persona</span>
        </button>
        {creating && <CreatePersonaForm onSuccess={refresh} onClose={() => setCreating(false)} />}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : sortedPersonas.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No personas yet</div>
        ) : (
          <div>
            {sortedPersonas.map((persona) => persona.isSystem ? (
              <PlatformPersonaItem key={persona.id} persona={persona} canApply={canApply} onPublished={refresh} />
            ) : (
              <PersonaTreeItem
                key={persona.id}
                persona={persona}
                canApply={canApply}
                onRevert={() => revertMutation.mutate(persona.id)}
                onRefresh={refresh}
                onSetDefault={() => defaultMutation.mutate(persona.id)}
                onUpdate={(data) => updateMutation.mutate({ id: persona.id, data })}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
