import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { User, Check, ChevronDown, Plus, Loader2, Trash2, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Badge } from "@/components/ui/badge";
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
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  source: "seed" | "user";
  createdAt: string;
  updatedAt: string;
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

function PersonaTreeItem({
  persona,
  onActivate,
  onDelete,
  onUpdate,
  activating,
}: {
  persona: Persona;
  onActivate: () => void;
  onDelete: () => void;
  onUpdate: (data: { description?: string; icon?: string; promptOverlay?: string; expressionTags?: string[]; semanticTier?: "max" | "high" | "balanced" | "fast" }) => void;
  activating: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editDescription, setEditDescription] = useState(persona.description);
  const [editOverlay, setEditOverlay] = useState(persona.promptOverlay || "");
  const [editTags, setEditTags] = useState(persona.expressionTags.join(", "));
  const [editIcon, setEditIcon] = useState(persona.icon);
  const [editTier, setEditTier] = useState(persona.semanticTier || "balanced");
  const overrideEntries = Object.entries(persona.cognitiveOverrides || {});
  const handleSave = () => {
    const tags = editTags.split(",").map(t => t.trim()).filter(Boolean);
    onUpdate({
      description: editDescription,
      icon: editIcon,
      promptOverlay: editOverlay || undefined,
      expressionTags: tags,
      semanticTier: editTier,
    });
    setEditing(false);
  };

  const handleCancel = () => {
    setEditDescription(persona.description);
    setEditOverlay(persona.promptOverlay || "");
    setEditTags(persona.expressionTags.join(", "));
    setEditIcon(persona.icon);
    setEditTier(persona.semanticTier || "balanced");
    setEditing(false);
  };

  const meta = (
    <span className="flex min-w-0 items-center justify-end gap-1.5">
      {persona.isDefault && <Badge variant="outline" className="text-[10px]">Default</Badge>}
      {persona.isSystem && <Badge variant="outline" className="text-[10px]">System</Badge>}
      <Badge variant="outline" className="text-[10px]">{persona.semanticTier || "balanced"}</Badge>
    </span>
  );

  const expandedContent = editing ? (
    <div className="space-y-3 rounded-md border border-border/30 bg-card/60 p-3">
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Updated {timeAgo(persona.updatedAt)}</p>
        {persona.isSystem ? (
          <p className="text-xs text-muted-foreground">Managed by Mantra. Read only.</p>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            {!persona.isActive && (
              <Button size="sm" variant="default" className="gap-1 bg-cta text-cta-foreground hover:bg-cta/90" onClick={onActivate} disabled={activating}>
                {activating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Activate
              </Button>
            )}
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
    <ProfileTreeRow
      label={<span className="flex min-w-0 items-center gap-2"><span className="truncate font-medium text-foreground">{persona.name}</span>{persona.isActive && <span className="inline-flex items-center gap-1 text-[10px] text-foreground"><Check className="h-3 w-3" />Active</span>}</span>}
      icon={<PersonaIconDisplay iconName={persona.icon} className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      defaultOpen={persona.isActive}
      expandedContent={expandedContent}
      expandedContentClassName="pl-8 pr-2"
    >
      {meta}
    </ProfileTreeRow>
  );
}

function CreatePersonaForm({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
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
      setName("");
      setDescription("");
      setIcon("Bot");
      setPromptOverlay("");
      setExpressionTags("");
      setSemanticTier("balanced");
      setOpen(false);
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Create Persona
      </Button>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="py-3 px-4 flex items-center justify-between border-b border-border/20">
        <span className="text-sm font-medium">Create Persona</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} className="h-6 w-6 p-0">
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
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

export default function PersonaTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activatingId, setActivatingId] = useState<number | null>(null);

  const { data: allPersonas, isLoading } = useQuery<Persona[]>({
    queryKey: ["/api/personas/management"],
    refetchInterval: 30000,
  });

  const activateMutation = useMutation({
    mutationFn: async (id: number) => {
      setActivatingId(id);
      await apiRequest("POST", `/api/personas/${id}/activate`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/personas/management"] });
      toast({ title: "Persona activated" });
      setActivatingId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setActivatingId(null);
    },
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const personas = allPersonas || [];
  const sortedPersonas = [...personas].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.sortOrder - b.sortOrder;
  });

  if (personas.length === 0) {
    return (
      <div className="p-4 w-full">
        <div className="py-8 text-center">
          <User className="h-6 w-6 mx-auto mb-3 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No personas configured</p>
        </div>
        <div className="mt-4">
          <CreatePersonaForm onSuccess={refresh} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 w-full">
      <div>
        <div className="rounded-lg border border-border/40 bg-muted/30 p-1">
          {sortedPersonas.map(persona => (
            <PersonaTreeItem
              key={persona.id}
              persona={persona}
              onActivate={() => activateMutation.mutate(persona.id)}
              onDelete={() => deleteMutation.mutate(persona.id)}
              onUpdate={(data) => updateMutation.mutate({ id: persona.id, data })}
              activating={activatingId === persona.id}
            />
          ))}
        </div>
      </div>

      <CreatePersonaForm onSuccess={refresh} />
    </div>
  );
}
