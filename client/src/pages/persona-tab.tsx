import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Check, ChevronDown, ChevronUp, ChevronRight, Plus, Loader2, Trash2, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_SECTION_HEADER_CLASS, HIERARCHY_SESSION_ROW_CLASS } from "@/components/hierarchy-section-header";
import { Card } from "@/components/ui/card";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
}

interface PersonaPayloadDraft {
  name: string;
  description: string;
  icon: string;
  promptOverlay: string;
  expressionTags: string;
  cognitiveOverrides: string;
  semanticTier: "max" | "high" | "balanced" | "fast";
  routingExamples: string;
  contextSections: Record<string, boolean>;
  toolBundle: string[];
  isDefault: boolean;
  sortOrder: number;
}

function draftFromPersona(persona: Persona): PersonaPayloadDraft {
  return {
    name: persona.name,
    description: persona.description,
    icon: persona.icon,
    promptOverlay: persona.promptOverlay || "",
    expressionTags: persona.expressionTags.join(", "),
    cognitiveOverrides: JSON.stringify(persona.cognitiveOverrides || {}, null, 2),
    semanticTier: persona.semanticTier || "balanced",
    routingExamples: persona.routingExamples.join("\n"),
    contextSections: persona.contextSections || {},
    toolBundle: persona.toolBundle || [],
    isDefault: persona.isDefault,
    sortOrder: persona.sortOrder,
  };
}

function payloadFromDraft(draft: PersonaPayloadDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description,
    icon: draft.icon,
    promptOverlay: draft.promptOverlay,
    expressionTags: draft.expressionTags.split(",").map((value) => value.trim()).filter(Boolean),
    cognitiveOverrides: JSON.parse(draft.cognitiveOverrides || "{}") as Record<string, unknown>,
    semanticTier: draft.semanticTier,
    routingExamples: draft.routingExamples.split("\n").map((value) => value.trim()).filter(Boolean),
    contextSections: draft.contextSections,
    toolBundle: draft.toolBundle,
    isDefault: draft.isDefault,
    sortOrder: draft.sortOrder,
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

function overrideLabel(key: string): string {
  const labels: Record<string, string> = {
    semanticWeight: "Semantic",
    temporalWeight: "Temporal",
    causalWeight: "Causal",
    contrastiveWeight: "Contrastive",
    memoryGraphTokenBudget: "Memory Graph Budget",
  };
  return labels[key] || key;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function PersonaIconDisplay({ iconName, className }: { iconName: string; className?: string }) {
  const Icon = resolvePersonaIcon(iconName);
  return <Icon className={className} />;
}

function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Icon</Label>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setOpen(!open)}
          data-testid="button-icon-picker-toggle"
        >
          <PersonaIconDisplay iconName={value} className="h-4 w-4" />
          <span className="text-xs">{value}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
        {open && (
          <div className="mt-2 grid grid-cols-5 gap-1 p-2 border border-border/30 rounded-md bg-background max-h-[200px] overflow-y-auto" data-testid="icon-picker-grid">
            {AVAILABLE_ICONS.map((iconName) => {
              const isSelected = value === iconName;
              return (
                <button
                  key={iconName}
                  type="button"
                  onClick={() => { onChange(iconName); setOpen(false); }}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md p-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected && "bg-accent text-foreground ring-1 ring-border",
                  )}
                  title={iconName}
                  data-testid={`icon-option-${iconName}`}
                >
                  <PersonaIconDisplay iconName={iconName} className="h-4 w-4" />
                  <span className="text-xs text-muted-foreground truncate w-full text-center">{iconName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PersonaPayloadEditor({ persona, draft, onChange, allowName }: { persona: Persona; draft: PersonaPayloadDraft; onChange: (draft: PersonaPayloadDraft) => void; allowName: boolean }) {
  const { data: sectionCatalog = [] } = useQuery<ContextSectionCatalogEntry[]>({ queryKey: ["/api/personas/section-catalog"] });
  const { data: toolCatalog = [] } = useQuery<ToolCatalogEntry[]>({ queryKey: ["/api/personas/tool-catalog"] });
  const set = <K extends keyof PersonaPayloadDraft>(key: K, value: PersonaPayloadDraft[K]) => onChange({ ...draft, [key]: value });
  return <div className="border-l border-border/40">
    <ProfileTreeRow label="Name" hasValue showEmpty mobileLayout="inline">{allowName ? <Input value={draft.name} onChange={(event) => set("name", event.target.value)} /> : <span>{draft.name}</span>}</ProfileTreeRow>
    <ProfileTreeRow label="Icon" hasValue showEmpty expandedContent={<IconPicker value={draft.icon} onChange={(value) => set("icon", value)} />}><span>{draft.icon}</span></ProfileTreeRow>
    <ProfileTreeRow label="Description" hasValue showEmpty expandedContent={<Textarea value={draft.description} onChange={(event) => set("description", event.target.value)} />}><span className="truncate">{draft.description || "None"}</span></ProfileTreeRow>
    <ProfileTreeRow label="Prompt overlay" hasValue showEmpty expandedContent={<Textarea className="min-h-40 font-mono" value={draft.promptOverlay} onChange={(event) => set("promptOverlay", event.target.value)} />}><span>{draft.promptOverlay ? "Configured" : "None"}</span></ProfileTreeRow>
    <ProfileTreeRow label="Expression tags" hasValue showEmpty expandedContent={<Input value={draft.expressionTags} onChange={(event) => set("expressionTags", event.target.value)} />}><span className="truncate">{draft.expressionTags || "None"}</span></ProfileTreeRow>
    <ProfileTreeRow label="Cognitive overrides" hasValue showEmpty expandedContent={<Textarea className="min-h-28 font-mono" value={draft.cognitiveOverrides} onChange={(event) => set("cognitiveOverrides", event.target.value)} />}><span>{Object.keys(persona.cognitiveOverrides || {}).length} fields</span></ProfileTreeRow>
    <ProfileTreeRow label="Semantic tier" hasValue showEmpty><Select value={draft.semanticTier} onValueChange={(value) => set("semanticTier", value as PersonaPayloadDraft["semanticTier"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="max">Max</SelectItem><SelectItem value="high">High</SelectItem><SelectItem value="balanced">Balanced</SelectItem><SelectItem value="fast">Fast</SelectItem></SelectContent></Select></ProfileTreeRow>
    <ProfileTreeRow label="Routing examples" hasValue showEmpty expandedContent={<Textarea className="min-h-28" value={draft.routingExamples} onChange={(event) => set("routingExamples", event.target.value)} />}><span>{draft.routingExamples.split("\n").filter(Boolean).length} examples</span></ProfileTreeRow>
    <ProfileTreeRow label="Context sections" hasValue showEmpty expandedContent={<div>{sectionCatalog.map((entry) => { const on = entry.id in draft.contextSections ? draft.contextSections[entry.id] : entry.defaultIncluded; return <button key={entry.id} type="button" className="flex min-h-11 w-full items-center gap-2 px-2 text-left hover:bg-accent/70" onClick={() => set("contextSections", { ...draft.contextSections, [entry.id]: !on })}><span className={cn("flex h-4 w-4 items-center justify-center rounded-sm border", on && "border-cta bg-cta text-cta-foreground")}>{on && <Check className="h-3 w-3" />}</span><span className="text-sm">{entry.title}</span></button>; })}</div>}><span>{Object.keys(draft.contextSections).length} overrides</span></ProfileTreeRow>
    <ProfileTreeRow label="Tool bundle" hasValue showEmpty expandedContent={<div>{toolCatalog.map((entry) => { const on = entry.isCore || draft.toolBundle.includes(entry.name); return <button key={entry.name} type="button" disabled={entry.isCore} className="flex min-h-11 w-full items-center gap-2 px-2 text-left hover:bg-accent/70 disabled:opacity-60" onClick={() => set("toolBundle", on ? draft.toolBundle.filter((name) => name !== entry.name) : [...draft.toolBundle, entry.name])}><span className={cn("flex h-4 w-4 items-center justify-center rounded-sm border", on && "border-cta bg-cta text-cta-foreground")}>{on && <Check className="h-3 w-3" />}</span><span className="text-sm">{entry.name}</span></button>; })}</div>}><span>{draft.toolBundle.length ? `${draft.toolBundle.length} selected` : "All tools"}</span></ProfileTreeRow>
    <ProfileTreeRow label="Default" hasValue showEmpty mobileLayout="inline"><button type="button" onClick={() => set("isDefault", !draft.isDefault)}>{draft.isDefault ? "Yes" : "No"}</button></ProfileTreeRow>
    <ProfileTreeRow label="Order" hasValue showEmpty mobileLayout="inline"><Input type="number" value={draft.sortOrder} onChange={(event) => set("sortOrder", Number(event.target.value))} /></ProfileTreeRow>
  </div>;
}

function PersonaTreeItem({
  persona,
  onDelete,
  onUpdate,
  onRefresh,
}: {
  persona: Persona;
  onDelete: () => void;
  onRefresh: () => void;
  onUpdate: (data: { description?: string; icon?: string; promptOverlay?: string; expressionTags?: string[]; semanticTier?: "max" | "high" | "balanced" | "fast"; contextSections?: Record<string, boolean>; toolBundle?: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFromPersona(persona));
  const [editDescription, setEditDescription] = useState(persona.description);
  const [editOverlay, setEditOverlay] = useState(persona.promptOverlay || "");
  const [editTags, setEditTags] = useState(persona.expressionTags.join(", "));
  const [editIcon, setEditIcon] = useState(persona.icon);
  const [editTier, setEditTier] = useState(persona.semanticTier || "balanced");
  const [editContextSections, setEditContextSections] = useState<Record<string, boolean>>(persona.contextSections || {});
  const { data: sectionCatalog = [] } = useQuery<ContextSectionCatalogEntry[]>({ queryKey: ["/api/personas/section-catalog"] });
  const sectionOn = (entry: ContextSectionCatalogEntry) =>
    entry.id in editContextSections ? editContextSections[entry.id] : entry.defaultIncluded;
  const toggleSection = (entry: ContextSectionCatalogEntry) =>
    setEditContextSections(prev => ({ ...prev, [entry.id]: !(entry.id in prev ? prev[entry.id] : entry.defaultIncluded) }));
  const [editToolBundle, setEditToolBundle] = useState<string[]>(persona.toolBundle || []);
  const { data: toolCatalog = [] } = useQuery<ToolCatalogEntry[]>({ queryKey: ["/api/personas/tool-catalog"] });
  const toolOn = (entry: ToolCatalogEntry) => entry.isCore || editToolBundle.includes(entry.name);
  const toggleTool = (entry: ToolCatalogEntry) => {
    if (entry.isCore) return;
    setEditToolBundle(prev => prev.includes(entry.name) ? prev.filter(n => n !== entry.name) : [...prev, entry.name]);
  };
  const overrideEntries = Object.entries(persona.cognitiveOverrides || {});
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
  const handleSave = () => {
    onUpdate(payloadFromDraft(draft));
    setEditing(false);
  };

  const handleCancel = () => {
    setEditDescription(persona.description);
    setEditOverlay(persona.promptOverlay || "");
    setEditTags(persona.expressionTags.join(", "));
    setEditIcon(persona.icon);
    setEditTier(persona.semanticTier || "balanced");
    setEditContextSections(persona.contextSections || {});
    setEditToolBundle(persona.toolBundle || []);
    setEditing(false);
  };

  const expandedContent = editing ? (
    <div className="space-y-3">
      <PersonaPayloadEditor persona={persona} draft={draft} onChange={setDraft} allowName={!persona.isSystem} />
      <div className="hidden">
      <IconPicker value={editIcon} onChange={setEditIcon} />
      <div className="space-y-1.5">
        <Label className="text-xs">Description</Label>
        <Input value={editDescription} onChange={e => setEditDescription(e.target.value)} className="h-8 text-sm" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Prompt Overlay</Label>
        <Textarea value={editOverlay} onChange={e => setEditOverlay(e.target.value)} className="min-h-[140px] font-mono text-sm" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Model Tier</Label>
        <Select value={editTier} onValueChange={(value) => setEditTier(value as typeof editTier)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="max">Max</SelectItem><SelectItem value="high">High</SelectItem>
            <SelectItem value="balanced">Balanced</SelectItem><SelectItem value="fast">Fast</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Expression Tags</Label>
        <Input value={editTags} onChange={e => setEditTags(e.target.value)} className="h-8 text-sm" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Context Sections</Label>
        <p className="text-[11px] text-muted-foreground">Optional context sections this persona loads. Bootstrap sections always load and aren't listed.</p>
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-border/40 bg-background/70 p-2">
          {sectionCatalog.map((entry) => {
            const on = sectionOn(entry);
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => toggleSection(entry)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-accent/40"
                data-testid={`context-section-toggle-${entry.id}`}
              >
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border", on ? "border-cta bg-cta text-cta-foreground" : "border-border/60")}>
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{entry.title}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{entry.description}</span>
                </span>
                <Badge variant="outline" className="text-[9px]">{entry.tokenCost}</Badge>
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Tool Inclusions</Label>
        <p className="text-[11px] text-muted-foreground">Tools this persona loads. Core tools always load. Leave everything below off to load all tools; turn any on to scope this persona to core + your selection.</p>
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-border/40 bg-background/70 p-2">
          {toolCatalog.map((entry) => {
            const on = toolOn(entry);
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => toggleTool(entry)}
                disabled={entry.isCore}
                className={cn("flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors", entry.isCore ? "cursor-default opacity-70" : "hover:bg-accent/40")}
                data-testid={`tool-toggle-${entry.name}`}
              >
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border", on ? "border-cta bg-cta text-cta-foreground" : "border-border/60")}>
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{entry.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{entry.description}</span>
                </span>
                {entry.isCore && <Badge variant="outline" className="text-[9px]">core</Badge>}
              </button>
            );
          })}
        </div>
      </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave}>Save</Button>
        <Button size="sm" variant="ghost" onClick={handleCancel}>Cancel</Button>
      </div>
    </div>
  ) : (
    <div className="space-y-3 rounded-md border border-border/30 bg-card/60 p-3">
      <p className="text-sm leading-normal text-muted-foreground">{persona.description}</p>
      {persona.promptOverlay ? (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Prompt Overlay</p>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-background/70 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {persona.promptOverlay}
          </div>
        </div>
      ) : <p className="text-xs italic text-muted-foreground/50">No prompt overlay configured.</p>}
      {persona.expressionTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {persona.expressionTags.map((tag, i) => <Badge key={i} variant="outline" className="text-xs">{tag}</Badge>)}
        </div>
      )}
      {overrideEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {overrideEntries.map(([key, val]) => (
            <Badge key={key} variant="outline" className="rounded-sm px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {overrideLabel(key)}: {String(val)}
            </Badge>
          ))}
        </div>
      )}
      {persona.updateState === "update_available" && (
        <div className="border-l border-border/40 pl-3 text-sm">
          <p className="font-medium">Update available</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => personaAction.mutate({ action: "keep-mine" })}>Keep mine</Button>
            <Button size="sm" onClick={() => personaAction.mutate({ action: "use-updated-default" })}>Use updated default</Button>
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div className="border-l border-border/40 pl-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">History</p>
          {history.map((revision) => (
            <div key={revision.id} className="flex min-h-11 items-center gap-2 border-b border-border/20 text-sm">
              <span className="min-w-0 flex-1 truncate">{revision.changeSummary}</span>
              <span className="text-xs text-muted-foreground">{timeAgo(revision.createdAt)}</span>
              {revision.id !== persona.currentRevisionId && revision.createdByUserId && (
                <Button size="sm" variant="ghost" onClick={() => personaAction.mutate({ action: "restore", revisionId: revision.id })}>Restore</Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{persona.updateState.replaceAll("_", " ")} · Updated {timeAgo(persona.updatedAt)}</p>
        {persona.isSystem ? (
          <p className="text-xs text-muted-foreground">Managed by Mantra. Read only.</p>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            {persona.source !== "seed" && (
              <Button size="sm" variant="destructive" className="gap-1" onClick={onDelete}>
                <Trash2 className="h-3 w-3" /> Delete
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`persona-row-${persona.id}`}>
      <CollapsibleTrigger className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70")}>
        <PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{persona.name}</span>
        {persona.isDefault && <span className="shrink-0 text-xs text-muted-foreground/70">Default</span>}
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-2 pl-8">
          {expandedContent}
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
      const tags = expressionTags.split(",").map(t => t.trim()).filter(Boolean);
      await apiRequest("POST", "/api/personas", {
        name,
        description,
        icon,
        promptOverlay: promptOverlay || undefined,
        expressionTags: tags,
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
      <div className="py-3 px-4 flex items-center justify-between border-b border-border/20">
        <span className="text-sm font-medium">New Persona</span>
        <Button size="sm" variant="ghost" onClick={onClose} className="h-6 w-6 p-0">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="px-4 pb-4 pt-3 space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Name</Label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Researcher"
            className="h-8 text-sm"
          />
        </div>
        <IconPicker value={icon} onChange={setIcon} />
        <div className="space-y-1.5">
          <Label className="text-xs">Description</Label>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Brief description of this persona's role..."
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Prompt Overlay</Label>
          <Textarea
            value={promptOverlay}
            onChange={e => setPromptOverlay(e.target.value)}
            placeholder="Behavioral instructions when this persona is active..."
            className="text-sm min-h-[100px] font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Model Tier</Label>
          <Select value={semanticTier} onValueChange={(value) => setSemanticTier(value as typeof semanticTier)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="max">Max</SelectItem><SelectItem value="high">High</SelectItem>
              <SelectItem value="balanced">Balanced</SelectItem><SelectItem value="fast">Fast</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Expression Tags (comma-separated)</Label>
          <Input
            value={expressionTags}
            onChange={e => setExpressionTags(e.target.value)}
            placeholder="e.g. [calm], [curious]"
            className="h-8 text-sm"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || !name}>
            {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
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
  const [description, setDescription] = useState(persona.description);
  const [promptOverlay, setPromptOverlay] = useState(persona.promptOverlay || "");
  const [changeSummary, setChangeSummary] = useState("");
  const [preview, setPreview] = useState<{ changedFields: string[]; impact: { advancing: number; updateAvailable: number } } | null>(null);
  const { data: history = [] } = useQuery<Array<{ id: string; payload: Record<string, unknown>; changeSummary: string; createdAt: string }>>({
    queryKey: ["/api/personas", persona.id, "history"],
    enabled: open,
  });
  const previewMutation = useMutation({ mutationFn: async () => {
    const response = await apiRequest("POST", `/api/personas/platform/${persona.id}/preview`, { changes: payloadFromDraft(draft) });
    return response.json();
  }, onSuccess: setPreview });
  const publishMutation = useMutation({ mutationFn: async (changes: ReturnType<typeof payloadFromDraft>) => {
    await apiRequest("POST", `/api/personas/platform/${persona.id}/publish`, { changes, changeSummary, confirmed: true });
  }, onSuccess: () => { setPreview(null); setOpen(false); onPublished(); } });
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70")}>
        <PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{persona.name}</span>
        <span className="text-xs text-muted-foreground">{persona.name === "Root" ? "Always active" : "Platform"}</span>
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent><div className="space-y-3 py-2 pl-6">
        <PersonaPayloadEditor persona={persona} draft={draft} onChange={setDraft} allowName={!persona.isSystem} />
        <div className="hidden">
        <Label>Description<Input value={description} onChange={(event) => setDescription(event.target.value)} /></Label>
        <Label>Prompt overlay<Textarea className="min-h-40 font-mono text-sm" value={promptOverlay} onChange={(event) => setPromptOverlay(event.target.value)} /></Label>
        </div>
        <Button variant="outline" onClick={() => previewMutation.mutate()}>Review impact</Button>
        {preview && <div className="space-y-2 text-sm">
          <p>{preview.changedFields.length ? preview.changedFields.join(", ") : "No changes"}</p>
          <p className="text-muted-foreground">{preview.impact.advancing} advance automatically · {preview.impact.updateAvailable} receive Update available</p>
          <Label>Change summary<Input value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} /></Label>
          <Button disabled={!changeSummary.trim() || preview.changedFields.length === 0 || publishMutation.isPending} onClick={() => publishMutation.mutate(payloadFromDraft(draft))}>Publish revision</Button>
        </div>}
        {history.length > 0 && <div className="border-l border-border/40 pl-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">History</p>
          {history.map((revision) => <div key={revision.id} className="flex min-h-11 items-center gap-2 border-b border-border/20 text-sm">
            <span className="min-w-0 flex-1 truncate">{revision.changeSummary}</span>
            <span className="text-xs text-muted-foreground">{timeAgo(revision.createdAt)}</span>
            {revision.id !== persona.currentRevisionId && <Button size="sm" variant="ghost" onClick={() => {
              const payload = revision.payload;
              const priorDescription = typeof payload.description === "string" ? payload.description : "";
              const priorOverlay = typeof payload.promptOverlay === "string" ? payload.promptOverlay : "";
              setChangeSummary(`Republish ${revision.changeSummary}`);
              publishMutation.mutate({ ...payloadFromDraft(draft), ...payload, description: priorDescription, promptOverlay: priorOverlay } as ReturnType<typeof payloadFromDraft>);
            }}>Republish</Button>}
          </div>)}
        </div>}
      </div></CollapsibleContent>
    </Collapsible>
  );
}

export default function PersonasPage() {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);

  const { data: allPersonas, isLoading } = useQuery<Persona[]>({
    queryKey: ["/api/personas/management"],
    refetchInterval: 30000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/personas/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
      toast({ title: "Persona deleted" });
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
      toast({ title: "Persona updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
  };

  const personas = allPersonas || [];
  const sortedPersonas = personas.filter((persona) => !persona.isSystem).sort((a, b) => a.sortOrder - b.sortOrder);
  const { data: platformDefaults = [] } = useQuery<Persona[]>({ queryKey: ["/api/personas/platform/defaults"], enabled: hasPermission("system:write") });

  return (
    <div className="p-2 space-y-4 w-full">
      <section>
        <h2 className={HIERARCHY_SECTION_HEADER_CLASS}>My Personas</h2>
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-cta hover:text-cta/80 hover:bg-accent/70 rounded-md transition-colors"
        data-testid="button-new-persona"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Persona</span>
      </button>

      {creating && (
        <CreatePersonaForm onSuccess={refresh} onClose={() => setCreating(false)} />
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : sortedPersonas.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No personas yet</div>
      ) : (
        <div className="space-y-0.5">
          {sortedPersonas.map(persona => (
            <PersonaTreeItem
              key={persona.id}
              persona={persona}
              onDelete={() => deleteMutation.mutate(persona.id)}
              onRefresh={refresh}
              onUpdate={(data) => updateMutation.mutate({ id: persona.id, data })}
            />
          ))}
        </div>
      )}
      </section>
      {hasPermission("system:write") && (
        <section className="border-t border-border/30 pt-4">
          <h2 className={HIERARCHY_SECTION_HEADER_CLASS}>Platform Defaults</h2>
          <div className="space-y-0.5">
            {platformDefaults.map((persona) => <PlatformPersonaItem key={persona.id} persona={persona} onPublished={() => { refresh(); queryClient.invalidateQueries({ queryKey: ["/api/personas/platform/defaults"] }); }} />)}
          </div>
        </section>
      )}
    </div>
  );
}
