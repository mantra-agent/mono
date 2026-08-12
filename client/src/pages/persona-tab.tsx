import { useEffect, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Check, ChevronRight, Circle, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_SECTION_HEADER_CLASS, HIERARCHY_SESSION_ROW_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { Card } from "@/components/ui/card";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { PROFILE_DESCRIPTION_FRAME_CLASS, PROFILE_DESCRIPTION_TEXT_CLASS } from "@/components/profile-description-style";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
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
  routingExamples: string[];
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
  cognitiveOverrides: string;
  semanticTier: "max" | "high" | "balanced" | "fast";
  routingExamples: string;
  contextSections: Record<string, boolean>;
  toolBundle: string[];
}

type LocalField =
  | "name"
  | "description"
  | "icon"
  | "promptOverlay"
  | "expressionTags"
  | "cognitiveOverrides"
  | "semanticTier"
  | "routingExamples"
  | "contextSections"
  | "toolBundle";

function draftFromPersona(persona: Persona): PersonaPayloadDraft {
  return {
    description: persona.description,
    promptOverlay: persona.promptOverlay || "",
    expressionTags: persona.expressionTags.join(", "),
    cognitiveOverrides: JSON.stringify(persona.cognitiveOverrides || {}, null, 2),
    semanticTier: persona.semanticTier || "balanced",
    routingExamples: persona.routingExamples.join("\n"),
    contextSections: persona.contextSections || {},
    toolBundle: persona.toolBundle || [],
  };
}

function payloadFromDraft(draft: PersonaPayloadDraft) {
  return {
    description: draft.description,
    promptOverlay: draft.promptOverlay,
    expressionTags: draft.expressionTags.split(",").map((value) => value.trim()).filter(Boolean),
    cognitiveOverrides: JSON.parse(draft.cognitiveOverrides || "{}") as Record<string, unknown>,
    semanticTier: draft.semanticTier,
    routingExamples: draft.routingExamples.split("\n").map((value) => value.trim()).filter(Boolean),
    contextSections: draft.contextSections,
    toolBundle: draft.toolBundle,
  };
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
  if (!changedFields?.includes(field)) return null;
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

function PersonaDescriptionEditor({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <div className={PROFILE_DESCRIPTION_FRAME_CLASS}>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        placeholder="Add description"
        className={cn(
          "min-h-24 w-full resize-none border-0 bg-transparent p-0 shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]",
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
}: {
  persona: Persona;
  draft: PersonaPayloadDraft;
  onChange: (draft: PersonaPayloadDraft) => void;
  onCommit?: (draft: PersonaPayloadDraft) => void;
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
  return (
    <div className="space-y-1">
      <div className="relative">
        {persona.changedFields?.includes("description") && (
          <Circle className="absolute right-2 top-2 h-1.5 w-1.5 fill-warning text-warning" aria-label="Edited locally" />
        )}
        <PersonaDescriptionEditor
          value={draft.description}
          onCommit={(description) => commit("description", description)}
        />
      </div>
      <div className="overflow-hidden">
        <ProfileTreeRow label="Prompt overlay" icon={mark("promptOverlay")} hasValue showEmpty mobileLayout="inline" expandedContent={<Textarea className="min-h-32 font-mono" value={draft.promptOverlay} onChange={(event) => set("promptOverlay", event.target.value)} {...commitInput("promptOverlay", persona.promptOverlay || "")} />}>
          <span>{draft.promptOverlay ? "Configured" : "None"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Expressions" icon={mark("expressionTags")} hasValue showEmpty mobileLayout="inline" expandedContent={<Input value={draft.expressionTags} onChange={(event) => set("expressionTags", event.target.value)} {...commitInput("expressionTags", persona.expressionTags.join(", "))} />}>
          <span className="truncate">{draft.expressionTags || "None"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Cognitive overrides" icon={mark("cognitiveOverrides")} hasValue showEmpty mobileLayout="inline" expandedContent={<Textarea className="min-h-24 font-mono" value={draft.cognitiveOverrides} onChange={(event) => set("cognitiveOverrides", event.target.value)} {...commitInput("cognitiveOverrides", JSON.stringify(persona.cognitiveOverrides || {}, null, 2))} />}>
          <span>{Object.keys(persona.cognitiveOverrides || {}).length} fields</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Model" icon={mark("semanticTier")} hasValue showEmpty mobileLayout="inline">
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
        <ProfileTreeRow label="Routing examples" icon={mark("routingExamples")} hasValue showEmpty mobileLayout="inline" expandedContent={<Textarea className="min-h-24" value={draft.routingExamples} onChange={(event) => set("routingExamples", event.target.value)} {...commitInput("routingExamples", persona.routingExamples.join("\n"))} />}>
          <span>{draft.routingExamples.split("\n").filter(Boolean).length} examples</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Context" icon={mark("contextSections")} hasValue showEmpty mobileLayout="inline" expandedContent={<div>{sectionCatalog.map((entry) => {
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
        <ProfileTreeRow label="Tool bundle" icon={mark("toolBundle")} hasValue showEmpty mobileLayout="inline" expandedContent={<div>{toolCatalog.map((entry) => {
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
  onRevert,
  onUpdate,
  onRefresh,
  onSetDefault,
}: {
  persona: Persona;
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
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70")}>
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
          <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/60" aria-label={open ? "Collapse persona" : "Expand persona"}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="space-y-1 px-2 pb-2">
          <PersonaPayloadEditor persona={persona} draft={draft} onChange={setDraft} onCommit={(next) => onUpdate(payloadFromDraft(next))} />
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
            <p className="text-xs text-muted-foreground">{persona.updateState.replaceAll("_", " ")} · Updated {timeAgo(persona.updatedAt)}</p>
            <div className="flex items-center gap-2">
              {!persona.isSystem && !persona.isDefault && (
                <Button size="sm" variant="ghost" onClick={onSetDefault}>Set as default</Button>
              )}
              {persona.source !== "seed" && persona.updateState === "customized" && (
                <Button size="sm" variant="outline" className="gap-1" onClick={onRevert}>
                  <RotateCcw className="h-3 w-3" /> Revert to default
                </Button>
              )}
            </div>
          </div>
        </div>
      </CollapsibleContent>
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
        <Textarea value={promptOverlay} onChange={(event) => setPromptOverlay(event.target.value)} placeholder="Prompt overlay" className="min-h-24 font-mono text-sm" />
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

function PlatformPersonaItem({ persona, onPublished }: { persona: Persona; onPublished: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  const [changeSummary, setChangeSummary] = useState("");
  const [preview, setPreview] = useState<{ changedFields: string[]; impact: { advancing: number; updateAvailable: number } } | null>(null);
  const { data: history = [] } = useQuery<Array<{ id: string; payload: Record<string, unknown>; changeSummary: string; createdAt: string }>>({
    queryKey: ["/api/personas", persona.id, "history"],
    enabled: open,
  });
  const previewMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/personas/platform/${persona.id}/preview`, { changes: payloadFromDraft(draft) });
      return response.json();
    },
    onSuccess: setPreview,
  });
  const publishMutation = useMutation({
    mutationFn: async (changes: ReturnType<typeof payloadFromDraft>) => {
      await apiRequest("POST", `/api/personas/platform/${persona.id}/publish`, { changes, changeSummary, confirmed: true });
    },
    onSuccess: () => {
      setPreview(null);
      setOpen(false);
      onPublished();
    },
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70")}>
        <PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{persona.name}</span>
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 px-2 py-1">
          <PersonaPayloadEditor persona={persona} draft={draft} onChange={setDraft} />
          <Button variant="outline" size="sm" onClick={() => previewMutation.mutate()}>Review impact</Button>
          {preview && (
            <div className="space-y-1 px-2 text-sm">
              <p>{preview.changedFields.length ? preview.changedFields.join(", ") : "No changes"}</p>
              <p className="text-muted-foreground">{preview.impact.advancing} advance automatically · {preview.impact.updateAvailable} receive Update available</p>
              <Label>Change summary<Input value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} /></Label>
              <Button disabled={!changeSummary.trim() || preview.changedFields.length === 0 || publishMutation.isPending} onClick={() => publishMutation.mutate(payloadFromDraft(draft))}>Publish revision</Button>
            </div>
          )}
          {history.length > 0 && history.map((revision) => (
            <div key={revision.id} className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default")}>
              <span className="min-w-0 flex-1 truncate">{revision.changeSummary}</span>
              <span className="text-xs text-muted-foreground">{timeAgo(revision.createdAt)}</span>
              {revision.id !== persona.currentRevisionId && (
                <Button size="sm" variant="ghost" onClick={() => {
                  setChangeSummary(`Republish ${revision.changeSummary}`);
                  publishMutation.mutate({ ...payloadFromDraft(draft), ...revision.payload } as ReturnType<typeof payloadFromDraft>);
                }}>Republish</Button>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function PersonasPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
              <PlatformPersonaItem key={persona.id} persona={persona} onPublished={refresh} />
            ) : (
              <PersonaTreeItem
                key={persona.id}
                persona={persona}
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
