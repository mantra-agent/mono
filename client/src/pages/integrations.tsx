// Use createLogger for logging ONLY
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { createLogger } from "@/lib/logger";

const log = createLogger("Integrations");
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { usePageHeader } from "@/hooks/use-page-header";
import { useVaults } from "@/hooks/use-vaults";
import { DriveSection } from "@/components/integrations/drive-section";
import { BoxSection } from "@/components/integrations/box-section";
import { MondaySection } from "@/components/integrations/monday-section";
import { SlackDetail } from "@/components/integrations/slack-section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Shield,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Settings,
  ChevronRight,
  MoreHorizontal,
  Play,
  Volume2,
  Loader2,
  Trash2,
  Check,
  X,
  Plug,
  Plus,
  Mail,
  Sparkles,
  ArrowRight,
  Bot,
  Eye,
  EyeOff,
  XCircle,
  Pencil,
  Landmark,
  SlidersHorizontal,
  Globe,
  Circle,
  CircleCheck,
  ExternalLink,
  Smartphone,
  Phone,
  Save,
  HelpCircle,
  Activity,
  HeartPulse,
  Mic,
  Square,
  Copy,
  Glasses,
  Radio,
  MessageSquare,
  Box,
  ClipboardList,
  Clock,
  GitBranch,
  Share2,
} from "lucide-react";
import { SiX } from "react-icons/si";
import { SecretsForSection } from "@/components/SecretControl";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { vaultTitleColor } from "@/lib/vault-title-color";
import { IntegrationTreeSection } from "@/components/integrations/integration-tree-section";
import { usePlaidLink } from "react-plaid-link";
import { useLocation } from "wouter";
import { useProductComposition } from "@/hooks/use-product-composition";
import type { ResolvedIntegrationCard } from "@shared/models/product-composition";

const INTEGRATION_ICONS = {
  Activity,
  Bot,
  Box,
  ClipboardList,
  Glasses,
  Globe,
  GitBranch,
  Landmark,
  Mail,
  MessageSquare,
  Mic,
  Phone,
  Radio,
  Settings,
  Share2,
  Shield,
  Smartphone,
  Volume2,
} as const;

type IntegrationIconKey = keyof typeof INTEGRATION_ICONS;

function integrationIcon(iconKey: string) {
  return INTEGRATION_ICONS[iconKey as IntegrationIconKey] ?? Plug;
}

function resolveStatus(
  integration: Pick<ResolvedIntegrationCard, "statusFields" | "healthField" | "readiness">,
  status: Record<string, any> | undefined,
): "ready" | "error" | "connect" {
  const fields = integration.statusFields ?? [];
  if (fields.length > 0) {
    if (!status) return "connect";
    const anySet = fields.some((field) => status[field]);
    if (!anySet) return "connect";
    if (integration.healthField && status[integration.healthField] === false) return "error";
    return "ready";
  }
  return integration.readiness === "ready" ? "ready" : "connect";
}

// ---------------------------------------------------------------------------
// Voice types
// ---------------------------------------------------------------------------

interface AudioTag {
  tag: string;
  description?: string;
}

interface TtsConfig {
  modelId: string;
  expressiveEnabled: boolean;
  suggestedAudioTags: AudioTag[];
  speed: number;
  stability: number;
  similarityBoost: number;
  style: number;
}

// VoiceEngineSection removed — single engine, no selector needed.

interface WebhookBaseUrlState {
  override: string | null;
  effective: string;
  usingOverride: boolean;
}

function WebhookBaseUrlSection() {
  const { toast } = useToast();
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useQuery<WebhookBaseUrlState>({
    queryKey: ["/api/voice/webhook-base-url"],
  });

  useEffect(() => {
    if (data && !dirty) {
      setDraft(data.override ?? "");
    }
  }, [data, dirty]);

  const saveMutation = useMutation({
    mutationFn: async (url: string | null) => {
      const res = await apiRequest("PUT", "/api/voice/webhook-base-url", { url });
      return res.json() as Promise<WebhookBaseUrlState & {
        reapplied: "v2" | "v3" | "skipped";
        reapplyError: string | null;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/voice/webhook-base-url"] });
      setDirty(false);
      const reapplyMsg =
        result.reapplied === "skipped"
          ? "Saved. (No agent configured to re-apply.)"
          : result.reapplyError
            ? `Saved, but re-apply failed: ${result.reapplyError}`
            : `Saved and re-applied to agent (${result.reapplied}).`;
      toast({
        title: result.override ? "Webhook URL override set" : "Webhook URL override cleared",
        description: reapplyMsg,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return <Skeleton className="h-24 w-full" />;
  }

  const trimmed = draft.trim();
  const canSave = !saveMutation.isPending && trimmed !== (data.override ?? "");
  const canClear = !saveMutation.isPending && data.override !== null;

  return (
    <div
      className="space-y-2 pt-3 border-t"
      data-testid="section-webhook-base-url"
    >
      <div className="flex items-center justify-between">
        <Label htmlFor="input-webhook-base-url" className="text-sm font-medium">
          ElevenLabs Webhook Base URL
        </Label>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="text-webhook-base-url-description">
        Public URL ElevenLabs uses for the custom-LLM callback. Override the auto-detected
        URL when testing voice in development against a known-reachable address. Leave blank
        to use the default.
      </p>
      <Input
        id="input-webhook-base-url"
        placeholder="https://your-public-url.example.com"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        data-testid="input-webhook-base-url"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="text-webhook-base-url-effective">
          Effective: <span className="font-mono">{data.effective}</span>
        </span>
        {data.usingOverride && (
          <Badge variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="badge-webhook-using-override">
            override active
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate(trimmed.length > 0 ? trimmed : null)}
          disabled={!canSave}
          data-testid="button-save-webhook-base-url"
        >
          {saveMutation.isPending ? "Saving..." : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft("");
            setDirty(false);
            saveMutation.mutate(null);
          }}
          disabled={!canClear}
          data-testid="button-clear-webhook-base-url"
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

function ExpressivenessSection() {
  const { toast } = useToast();
  const [newTag, setNewTag] = useState("");
  const [newTagDesc, setNewTagDesc] = useState("");

  const { data: ttsConfig, isLoading } = useQuery<TtsConfig>({
    queryKey: ["/api/elevenlabs/agent/tts-config"],
  });

  const updateMutation = useMutation({
    mutationFn: async (update: Partial<TtsConfig>) => {
      const res = await apiRequest("POST", "/api/elevenlabs/agent/tts-config", update);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/elevenlabs/agent/tts-config"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !ttsConfig) {
    return <Skeleton className="h-10 w-full mt-3" />;
  }

  const isV3 = ttsConfig.modelId === "eleven_v3_conversational";
  const tags = ttsConfig.suggestedAudioTags || [];

  const handleToggleModel = () => {
    const newModelId = isV3 ? "eleven_flash_v2" : "eleven_v3_conversational";
    const expressive = newModelId === "eleven_v3_conversational";
    updateMutation.mutate({
      modelId: newModelId,
      expressiveEnabled: expressive,
    });
    toast({
      title: expressive ? "Expressive mode enabled" : "Flash mode enabled",
      description: expressive
        ? "Using v3 Conversational — slightly higher latency for more expressive speech"
        : "Using Flash v2 — lower latency, no emotion tags",
    });
  };

  const handleAddTag = () => {
    const trimmed = newTag.trim().toLowerCase();
    if (!trimmed) return;
    if (tags.length >= 20) {
      toast({ title: "Limit reached", description: "Maximum 20 audio tags allowed", variant: "destructive" });
      return;
    }
    if (tags.some(t => t.tag === trimmed)) {
      toast({ title: "Duplicate", description: "This tag already exists", variant: "destructive" });
      return;
    }
    const newTagObj: AudioTag = { tag: trimmed };
    if (newTagDesc.trim()) newTagObj.description = newTagDesc.trim();
    updateMutation.mutate({ suggestedAudioTags: [...tags, newTagObj] });
    setNewTag("");
    setNewTagDesc("");
  };

  const handleRemoveTag = (tagToRemove: string) => {
    updateMutation.mutate({ suggestedAudioTags: tags.filter(t => t.tag !== tagToRemove) });
  };

  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Expressiveness</Label>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="text-tts-model-label">
            {isV3 ? "v3 Conversational" : "Flash v2"}
          </span>
          <Switch
            checked={isV3}
            onCheckedChange={handleToggleModel}
            disabled={updateMutation.isPending}
            data-testid="switch-expressive-mode"
          />
        </div>
      </div>

      {isV3 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="text-latency-note">
            <Clock className="h-3 w-3 shrink-0" />
            Slightly higher latency for more expressive speech
          </p>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Expression Tags ({tags.length}/20)</Label>
            <div className="flex flex-wrap gap-1.5" data-testid="tag-list">
              {tags.map(t => (
                <Tooltip key={t.tag}>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs gap-1 pr-1 cursor-default" data-testid={`tag-${t.tag}`}>
                      {t.tag}
                      <button
                        onClick={() => handleRemoveTag(t.tag)}
                        className="ml-0.5 rounded-full hover:bg-destructive/20 p-0.5"
                        data-testid={`button-remove-tag-${t.tag}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  </TooltipTrigger>
                  {t.description && (
                    <TooltipContent>
                      <p className="text-xs">{t.description}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              ))}
            </div>

            {tags.length < 20 && (
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Tag name"
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  className="flex-1 h-8 text-sm"
                  onKeyDown={e => e.key === "Enter" && handleAddTag()}
                  data-testid="input-new-tag"
                />
                <Input
                  placeholder="Description (optional)"
                  value={newTagDesc}
                  onChange={e => setNewTagDesc(e.target.value)}
                  className="flex-1 h-8 text-sm"
                  onKeyDown={e => e.key === "Enter" && handleAddTag()}
                  data-testid="input-new-tag-description"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddTag}
                  disabled={!newTag.trim() || updateMutation.isPending}
                  className="h-8"
                  data-testid="button-add-tag"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VoiceTuningSection() {
  const { toast } = useToast();

  const { data: ttsConfig, isLoading } = useQuery<TtsConfig>({
    queryKey: ["/api/elevenlabs/agent/tts-config"],
  });

  const updateMutation = useMutation({
    mutationFn: async (update: Partial<TtsConfig>) => {
      const res = await apiRequest("POST", "/api/elevenlabs/agent/tts-config", update);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/elevenlabs/agent/tts-config"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const defaults = { speed: 1.0, stability: 0.5, similarityBoost: 0.75, style: 0.0 };

  const [localValues, setLocalValues] = useState<Record<string, number>>(defaults);

  useEffect(() => {
    if (ttsConfig) {
      setLocalValues({
        speed: ttsConfig.speed ?? defaults.speed,
        stability: ttsConfig.stability ?? defaults.stability,
        similarityBoost: ttsConfig.similarityBoost ?? defaults.similarityBoost,
        style: ttsConfig.style ?? defaults.style,
      });
    }
  }, [ttsConfig]);

  if (isLoading || !ttsConfig) {
    return <Skeleton className="h-32 w-full mt-3" />;
  }

  const sliders: Array<{
    key: keyof Pick<TtsConfig, "speed" | "stability" | "similarityBoost" | "style">;
    label: string;
    description: string;
    min: number;
    max: number;
    step: number;
  }> = [
    {
      key: "speed",
      label: "Speed",
      description: "Playback speed of generated speech",
      min: 0.5,
      max: 2.0,
      step: 0.05,
    },
    {
      key: "stability",
      label: "Stability",
      description: "Higher values produce more consistent speech; lower values add variation",
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      key: "similarityBoost",
      label: "Similarity Boost",
      description: "How closely the voice matches the original; higher can reduce variation",
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      key: "style",
      label: "Style",
      description: "Amplifies the speaking style of the voice; can increase latency",
      min: 0,
      max: 1,
      step: 0.05,
    },
  ];

  return (
    <div className="space-y-4 pt-3 border-t" data-testid="section-voice-tuning">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        <Label className="text-sm font-medium">Voice Tuning</Label>
      </div>
      {sliders.map(({ key, label, description, min, max, step }) => (
        <div key={key} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">{label}</Label>
            <span className="text-xs text-muted-foreground tabular-nums" data-testid={`text-tuning-${key}`}>
              {(localValues[key] ?? 0).toFixed(2)}
            </span>
          </div>
          <Slider
            min={min}
            max={max}
            step={step}
            value={[localValues[key] ?? 0]}
            onValueChange={([val]) => setLocalValues(prev => ({ ...prev, [key]: val }))}
            onValueCommit={([val]) => updateMutation.mutate({ [key]: val })}
            disabled={updateMutation.isPending}
            data-testid={`slider-tuning-${key}`}
          />
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      ))}
    </div>
  );
}


interface PronunciationEntryData {
  word: string;
  alias: string;
  createdAt: string;
}

function PronunciationSection() {
  const { toast } = useToast();
  const [newWord, setNewWord] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editAlias, setEditAlias] = useState("");

  const { data: pronunciationData, isLoading } = useQuery<{ entries: PronunciationEntryData[] }>({
    queryKey: ["/api/pronunciation"],
  });

  const entries = pronunciationData?.entries || [];

  const addMutation = useMutation({
    mutationFn: async ({ word, alias }: { word: string; alias: string }) => {
      const res = await apiRequest("POST", "/api/pronunciation", { word, alias });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Pronunciation added", description: `"${newWord}" → "${newAlias}"` });
      setNewWord("");
      setNewAlias("");
      queryClient.invalidateQueries({ queryKey: ["/api/pronunciation"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error adding pronunciation", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ word, alias }: { word: string; alias: string }) => {
      const res = await apiRequest("PUT", "/api/pronunciation", { word, alias });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({ title: "Pronunciation updated", description: `"${vars.word}" → "${vars.alias}"` });
      setEditingWord(null);
      setEditAlias("");
      queryClient.invalidateQueries({ queryKey: ["/api/pronunciation"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error updating pronunciation", description: err.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (word: string) => {
      const res = await apiRequest("DELETE", "/api/pronunciation", { word });
      return res.json();
    },
    onSuccess: (_data, word) => {
      toast({ title: "Pronunciation removed", description: `Removed entry for "${word}"` });
      queryClient.invalidateQueries({ queryKey: ["/api/pronunciation"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error removing pronunciation", description: err.message, variant: "destructive" });
    },
  });

  const handleAdd = () => {
    const word = newWord.trim();
    const alias = newAlias.trim();
    if (!word || !alias) return;
    addMutation.mutate({ word, alias });
  };

  const handleUpdate = (word: string) => {
    const alias = editAlias.trim();
    if (!alias) return;
    updateMutation.mutate({ word, alias });
  };

  return (
    <div className="min-w-0" data-testid="text-pronunciation-title">
      <IntegrationTreeSection label="Pronunciation" initialOpen icon={<Volume2 className="h-3.5 w-3.5" />} testIdPrefix="pronunciation">
        {isLoading ? (
          <ProfileTreeRow label="Entries" icon={<Volume2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          </ProfileTreeRow>
        ) : entries.length === 0 ? (
          <ProfileTreeRow label="Entries" icon={<Volume2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground" data-testid="text-pronunciation-empty">None yet</span>
          </ProfileTreeRow>
        ) : entries.map(entry => (
          <ProfileTreeRow
            key={entry.word}
            label={entry.word}
            icon={<Volume2 className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            testId={`pronunciation-entry-${entry.word}`}
            defaultOpen={editingWord === entry.word}
            expandedContent={editingWord === entry.word ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editAlias}
                  onChange={e => setEditAlias(e.target.value)}
                  className="flex-1 h-8 text-sm"
                  placeholder="Pronounce as..."
                  onKeyDown={e => e.key === "Enter" && handleUpdate(entry.word)}
                  data-testid={`input-edit-alias-${entry.word}`}
                />
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleUpdate(entry.word)} disabled={updateMutation.isPending} data-testid={`button-save-edit-${entry.word}`}>
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditingWord(null); setEditAlias(""); }} data-testid={`button-cancel-edit-${entry.word}`}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : undefined}
            menuContent={(
              <>
                <DropdownMenuItem onClick={() => { setEditingWord(entry.word); setEditAlias(entry.alias); }} data-testid={`button-edit-${entry.word}`}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => removeMutation.mutate(entry.word)} disabled={removeMutation.isPending} data-testid={`button-remove-${entry.word}`}>
                  Remove
                </DropdownMenuItem>
              </>
            )}
          >
            <span className="truncate text-muted-foreground" data-testid={`text-alias-${entry.word}`}>{entry.alias}</span>
          </ProfileTreeRow>
        ))}
        <ProfileTreeRow
          label="Add"
          icon={<Plus className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          defaultOpen
          expandedContent={(
            <div className="flex items-center gap-2">
              <Input
                placeholder="Word (e.g. Siobhan)"
                value={newWord}
                onChange={e => setNewWord(e.target.value)}
                className="flex-1 h-8 text-sm"
                data-testid="input-new-pronunciation-word"
              />
              <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
              <Input
                placeholder="Say as (e.g. Shivawn)"
                value={newAlias}
                onChange={e => setNewAlias(e.target.value)}
                className="flex-1 h-8 text-sm"
                onKeyDown={e => e.key === "Enter" && handleAdd()}
                data-testid="input-new-pronunciation-alias"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleAdd}
                disabled={!newWord.trim() || !newAlias.trim() || addMutation.isPending}
                data-testid="button-add-pronunciation"
              >
                {addMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              </Button>
            </div>
          )}
        >
          <span className="text-muted-foreground">New entry</span>
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice browser (extracted from old VoiceTab)
// ---------------------------------------------------------------------------

interface VoiceInfo {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview_url: string | null;
  description: string | null;
}

interface IvcLatestVoice {
  voiceId: string;
  requiresVerification: boolean;
  name: string;
  description: string | null;
  sampleCount: number;
  removeBackgroundNoise: boolean;
  createdAt: string;
}

interface RecordedVoiceSample {
  id: string;
  prompt: string;
  blob: Blob;
  durationSeconds: number;
}

const IVC_PROMPTS = [
  "My name is Raymond Kallmeyer, and I give permission to create a temporary voice clone for this demo.",
  "Agent should help me hear what matters clearly, choose the next move, and act with confidence.",
  "The future I am building is one where intelligence helps every being become more fully alive.",
];

function InstantVoiceCloneWizard() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [voiceName, setVoiceName] = useState(`Ray IVC ${new Date().toLocaleDateString()}`);
  const [removeBackgroundNoise, setRemoveBackgroundNoise] = useState(true);
  const [recordingPromptIndex, setRecordingPromptIndex] = useState<number | null>(null);
  const [samples, setSamples] = useState<RecordedVoiceSample[]>([]);
  const [createdVoice, setCreatedVoice] = useState<IvcLatestVoice | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordingStartedAtRef = useRef<number>(0);

  const { data: latestData } = useQuery<{ latest: IvcLatestVoice | null }>({
    queryKey: ["/api/elevenlabs/voices/ivc/latest"],
  });

  const latestVoice = createdVoice ?? latestData?.latest ?? null;
  const sampleByPrompt = new Map(samples.map((sample) => [sample.prompt, sample]));
  const allPromptsRecorded = IVC_PROMPTS.every((prompt) => sampleByPrompt.has(prompt));

  const stopMediaStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => stopMediaStream();
  }, [stopMediaStream]);

  const startRecording = useCallback(async (promptIndex: number) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
      streamRef.current = stream;
      chunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const durationSeconds = Math.max(1, Math.round((Date.now() - recordingStartedAtRef.current) / 1000));
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const prompt = IVC_PROMPTS[promptIndex];
        setSamples((prev) => [
          ...prev.filter((sample) => sample.prompt !== prompt),
          { id: `${promptIndex}-${Date.now()}`, prompt, blob, durationSeconds },
        ]);
        setRecordingPromptIndex(null);
        stopMediaStream();
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecordingPromptIndex(promptIndex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Recording failed", description: message, variant: "destructive" });
      stopMediaStream();
      setRecordingPromptIndex(null);
    }
  }, [stopMediaStream, toast]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const createVoiceMutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("name", voiceName.trim());
      form.append("consent", String(consent));
      form.append("removeBackgroundNoise", String(removeBackgroundNoise));
      form.append("description", "Created from Mantra Integrations Instant Voice Clone wizard for Magic Demo FTUE validation.");
      samples.forEach((sample, index) => {
        form.append("samples", sample.blob, `ivc-sample-${index + 1}.webm`);
      });
      const res = await fetch("/api/elevenlabs/voices/ivc", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      return await res.json() as IvcLatestVoice;
    },
    onSuccess: (voice) => {
      setCreatedVoice(voice);
      queryClient.invalidateQueries({ queryKey: ["/api/elevenlabs/voices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/elevenlabs/voices/ivc/latest"] });
      toast({ title: "Instant voice clone created", description: `Voice ID: ${voice.voiceId}` });
    },
    onError: (err: Error) => {
      log.error("IVC creation failed:", err);
      toast({ title: "Voice clone failed", description: err.message, variant: "destructive" });
    },
  });

  const copyVoiceId = useCallback(async (voiceId: string) => {
    await navigator.clipboard.writeText(voiceId);
    toast({ title: "Copied", description: "Voice ID copied to clipboard." });
  }, [toast]);

  const canCreate = consent && voiceName.trim().length > 0 && allPromptsRecorded && createVoiceMutation.isPending === false;

  return (
    <div className="min-w-0" data-testid="card-elevenlabs-ivc">
      <IntegrationTreeSection
        label="Instant Voice Clone"
        initialOpen
        icon={<Mic className="h-3.5 w-3.5" />}
        testIdPrefix="elevenlabs-ivc"
        actions={(
          <Button size="sm" variant="outline" className="mr-2" onClick={() => setOpen(true)} data-testid="button-open-ivc-wizard">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Create clone
          </Button>
        )}
      >
        {latestVoice ? (
          <ProfileTreeRow
            label={latestVoice.name}
            icon={<Mic className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            menuContent={<DropdownMenuItem onClick={() => copyVoiceId(latestVoice.voiceId)}>Copy ID</DropdownMenuItem>}
          >
            <span className="truncate font-mono text-muted-foreground">{latestVoice.voiceId}</span>
          </ProfileTreeRow>
        ) : (
          <ProfileTreeRow label="Latest clone" icon={<Mic className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground">None yet</span>
          </ProfileTreeRow>
        )}
      </IntegrationTreeSection>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Instant Voice Clone Wizard</DialogTitle>
            <DialogDescription>
              Consent-first prototype for validating ElevenLabs IVC latency, quality, and FTUE viability. Raw samples are uploaded to Mantra, forwarded to ElevenLabs, then discarded by this server.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="ivc-voice-name">Voice name</Label>
              <Input id="ivc-voice-name" value={voiceName} onChange={(event) => setVoiceName(event.target.value)} />
            </div>

            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox id="ivc-consent" checked={consent} onCheckedChange={(checked) => setConsent(checked === true)} />
              <Label htmlFor="ivc-consent" className="text-sm leading-relaxed cursor-pointer">
                I consent to recording these samples and sending them to ElevenLabs to create an Instant Voice Clone for demo validation.
              </Label>
            </div>

            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox id="ivc-noise" checked={removeBackgroundNoise} onCheckedChange={(checked) => setRemoveBackgroundNoise(checked === true)} />
              <Label htmlFor="ivc-noise" className="text-sm leading-relaxed cursor-pointer">
                Remove background noise. Use this in noisy rooms; turn it off for clean studio-quality samples.
              </Label>
            </div>

            <div className="space-y-3">
              <div>
                <h3 className="text-lg font-semibold">Recording prompts</h3>
                <p className="text-sm text-muted-foreground">Read each prompt naturally. Aim for 10-20 seconds per prompt in a quiet room.</p>
              </div>
              <div className="space-y-3">
                {IVC_PROMPTS.map((prompt, index) => {
                  const sample = sampleByPrompt.get(prompt);
                  const isRecording = recordingPromptIndex === index;
                  return (
                    <div key={prompt} className="rounded-md border p-3 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <Badge variant="outline">Prompt {index + 1}</Badge>
                          <p className="text-sm">{prompt}</p>
                          {sample && <p className="text-xs text-muted-foreground">Recorded {sample.durationSeconds}s</p>}
                        </div>
                        <Button
                          variant={isRecording ? "destructive" : sample ? "outline" : "default"}
                          size="sm"
                          onClick={() => isRecording ? stopRecording() : startRecording(index)}
                          disabled={recordingPromptIndex !== null && !isRecording}
                        >
                          {isRecording ? <Square className="h-3.5 w-3.5 mr-2" /> : <Mic className="h-3.5 w-3.5 mr-2" />}
                          {isRecording ? "Stop" : sample ? "Re-record" : "Record"}
                        </Button>
                      </div>
                      {sample && <audio controls src={URL.createObjectURL(sample.blob)} className="w-full" />}
                    </div>
                  );
                })}
              </div>
            </div>

            {createdVoice && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <p className="text-sm font-medium">Voice created in ElevenLabs</p>
                </div>
                <p className="text-xs text-muted-foreground font-mono break-all">{createdVoice.voiceId}</p>
                <p className="text-xs text-muted-foreground">
                  {createdVoice.requiresVerification ? "ElevenLabs says this voice requires verification before full use." : "ElevenLabs returned this voice as ready."}
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            <Button onClick={() => createVoiceMutation.mutate()} disabled={!canCreate} data-testid="button-create-ivc-voice">
              {createVoiceMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
              Create voice in ElevenLabs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VoiceBrowserSection() {
  const { toast } = useToast();
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { data: voicesData, isLoading: voicesLoading } = useQuery<{ voices: VoiceInfo[] }>({
    queryKey: ["/api/elevenlabs/voices"],
    enabled: showBrowser,
  });

  const { data: currentVoiceData } = useQuery<{ voiceId: string | null; configured: boolean }>({
    queryKey: ["/api/elevenlabs/agent/voice"],
  });

  const selectVoiceMutation = useMutation({
    mutationFn: async (voiceId: string) => {
      const res = await apiRequest("POST", "/api/elevenlabs/agent/voice", { voiceId });
      return res.json();
    },
    onSuccess: (_data: any, voiceId: string) => {
      const voice = voices.find((v) => v.voice_id === voiceId);
      toast({ title: "Voice updated", description: `Set to ${voice?.name || voiceId}` });
      queryClient.invalidateQueries({ queryKey: ["/api/elevenlabs/agent/voice"] });
      setShowBrowser(false);
      setSearchQuery("");
      setCategoryFilter("all");
    },
    onError: (err: Error) => {
      log.error("voice selection failed:", err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const voices = voicesData?.voices || [];
  const currentVoiceId = currentVoiceData?.voiceId;
  const isConfigured = currentVoiceData?.configured ?? false;

  const categories = Array.from(new Set(voices.map((v) => v.category))).sort();

  const filtered = voices.filter((v) => {
    const matchesSearch =
      !searchQuery ||
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      Object.values(v.labels).some((l) => l.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = categoryFilter === "all" || v.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const currentVoice = voices.find((v) => v.voice_id === currentVoiceId);

  const handlePreview = useCallback(
    (voice: VoiceInfo) => {
      if (!voice.preview_url) return;
      if (playingId === voice.voice_id) {
        audioRef.current?.pause();
        audioRef.current = null;
        setPlayingId(null);
        return;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      const audio = new Audio(voice.preview_url);
      audio.onended = () => {
        setPlayingId(null);
        audioRef.current = null;
      };
      audio.play();
      audioRef.current = audio;
      setPlayingId(voice.voice_id);
    },
    [playingId],
  );

  return (
    <div className="min-w-0" data-testid="text-voice-title">
      <IntegrationTreeSection
        label="Voice"
        initialOpen
        icon={<Volume2 className="h-3.5 w-3.5" />}
        testIdPrefix="voice"
        actions={(
          <Button size="sm" variant="outline" className="mr-2" onClick={() => setShowBrowser(!showBrowser)} data-testid="button-toggle-voice-browser">
            {showBrowser ? "Close browser" : "Browse voices"}
          </Button>
        )}
      >
        {isConfigured && currentVoice ? (
          <ProfileTreeRow
            label="Current"
            icon={<Volume2 className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            actionContent={currentVoice.preview_url ? (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handlePreview(currentVoice)} data-testid="button-preview-current-voice">
                {playingId === currentVoice.voice_id ? <X className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
            ) : undefined}
          >
            <span className="truncate" data-testid="text-current-voice-name">{currentVoice.name}</span>
          </ProfileTreeRow>
        ) : (
          <ProfileTreeRow label="Current" icon={<Volume2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground" data-testid="text-no-voice-configured">Not configured</span>
          </ProfileTreeRow>
        )}
        {showBrowser && (
          <>
            <ProfileTreeRow label="Search" icon={<Volume2 className="h-3.5 w-3.5" />} hasValue showEmpty defaultOpen expandedContent={(
              <div className="flex gap-2">
                <Input placeholder="Search voices..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="flex-1" data-testid="input-voice-search" />
                {categories.length > 0 && (
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="w-36" data-testid="select-voice-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}>
              <span className="text-muted-foreground">{filtered.length} voices</span>
            </ProfileTreeRow>
            {voicesLoading ? (
              <ProfileTreeRow label="Voices" icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />} hasValue showEmpty>
                <span className="text-muted-foreground">Loading</span>
              </ProfileTreeRow>
            ) : (
              <div data-testid="list-voice-browser">
                {filtered.map((voice) => {
                  const isSelected = voice.voice_id === currentVoiceId;
                  return (
                    <ProfileTreeRow
                      key={voice.voice_id}
                      label={voice.name}
                      icon={<Volume2 className="h-3.5 w-3.5" />}
                      hasValue
                      showEmpty
                      testId={`voice-option-${voice.voice_id}`}
                      actionContent={voice.preview_url ? (
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handlePreview(voice)}>
                          {playingId === voice.voice_id ? <X className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </Button>
                      ) : undefined}
                      menuContent={!isSelected ? (
                        <DropdownMenuItem onClick={() => selectVoiceMutation.mutate(voice.voice_id)} disabled={selectVoiceMutation.isPending}>
                          Select
                        </DropdownMenuItem>
                      ) : undefined}
                    >
                      <span className="truncate text-muted-foreground">{isSelected ? "Current" : Object.values(voice.labels).slice(0, 2).join(" · ")}</span>
                    </ProfileTreeRow>
                  );
                })}
              </div>
            )}
          </>
        )}
      </IntegrationTreeSection>
    </div>
  );
}








interface GooglePermissions {
  gmailRead: boolean;
  gmailSend: boolean;
  gmailDraft: boolean;
  gmailDownloadAttachments: boolean;
  calendarView: boolean;
  calendarCreate: boolean;
  calendarEdit: boolean;
  calendarDelete: boolean;
}

interface ConnectedAccountWithPerms {
  id: number;
  accountId: string;
  provider: string;
  email: string | null;
  label: string;
  vaultId: string | null;
  vault: { id: string; name: string; color: string | null } | null;
  permissions: GooglePermissions;
}



function TwitterAccountsSection() {
  const { toast } = useToast();
  const [showAddForm, setShowAddForm] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [accessTokenSecret, setAccessTokenSecret] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const { data: accountsData, isLoading } = useQuery<{
    accounts: Array<{
      id: string;
      label: string;
      addedAt: string;
      valid: boolean;
      username?: string;
      error?: string;
      permissions: { post: boolean; reply: boolean; delete: boolean };
    }>;
  }>({
    queryKey: ["/api/twitter/accounts"],
  });

  const removeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      await apiRequest("DELETE", `/api/twitter/accounts/${accountId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "X (Twitter) account removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove account", description: err.message, variant: "destructive" });
    },
  });

  const permMutation = useMutation({
    mutationFn: async ({ accountId, perms }: { accountId: string; perms: Record<string, boolean> }) => {
      const res = await apiRequest("PATCH", `/api/twitter/accounts/${accountId}/permissions`, perms);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/accounts"] });
      toast({ title: "Permissions updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update permissions", description: err.message, variant: "destructive" });
    },
  });

  const [editBearerToken, setEditBearerToken] = useState<Record<string, string>>({});
  const [savingBearer, setSavingBearer] = useState<string | null>(null);

  const bearerMutation = useMutation({
    mutationFn: async ({ accountId, token }: { accountId: string; token: string }) => {
      setSavingBearer(accountId);
      await apiRequest("PATCH", `/api/twitter/accounts/${accountId}/tokens`, { bearerToken: token });
    },
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/accounts"] });
      toast({ title: "Bearer token updated" });
      setEditBearerToken((prev) => { const next = { ...prev }; delete next[accountId]; return next; });
      setSavingBearer(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update bearer token", description: err.message, variant: "destructive" });
      setSavingBearer(null);
    },
  });

  const accounts = accountsData?.accounts || [];

  const handleAddAccount = async () => {
    if (!apiKey.trim() || !apiSecret.trim() || !accessToken.trim() || !accessTokenSecret.trim()) return;
    setIsAdding(true);
    try {
      await apiRequest("POST", "/api/twitter/accounts/add", {
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        accessToken: accessToken.trim(),
        accessTokenSecret: accessTokenSecret.trim(),
        ...(bearerToken.trim() ? { bearerToken: bearerToken.trim() } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "X (Twitter) account connected" });
      setApiKey("");
      setApiSecret("");
      setAccessToken("");
      setAccessTokenSecret("");
      setBearerToken("");
      setShowAddForm(false);
      setShowSecrets(false);
    } catch (err: any) {
      toast({ title: "Failed to connect", description: err.message, variant: "destructive" });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="min-w-0" data-testid="card-twitter-accounts">
      <IntegrationTreeSection
        label="X (Twitter)"
        initialOpen
        icon={<SiX className="h-3.5 w-3.5" />}
        testIdPrefix="twitter"
        actions={<span className="pr-2 text-xs text-muted-foreground" data-testid="badge-twitter-account-count">{accounts.length} connected</span>}
      >
        {isLoading ? (
          <ProfileTreeRow label="Accounts" icon={<SiX className="h-3.5 w-3.5" />} hasValue showEmpty>
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          </ProfileTreeRow>
        ) : accounts.length === 0 ? (
          <ProfileTreeRow label="Accounts" icon={<SiX className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground" data-testid="text-no-twitter-accounts">None connected</span>
          </ProfileTreeRow>
        ) : accounts.map((account) => (
          <ProfileTreeRow
            key={account.id}
            label={<span data-testid={`text-twitter-username-${account.id}`}>{account.username ? `@${account.username}` : account.label}</span>}
            icon={<SiX className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            testId={`twitter-account-${account.id}`}
            defaultOpen={account.valid}
            expandedContent={account.valid ? (
              <div className="space-y-2">
                {(["post", "reply", "delete"] as const).map((perm) => (
                  <div key={perm} className="flex items-center justify-between">
                    <span className="text-xs capitalize">{perm === "post" ? "Post tweets" : perm === "reply" ? "Reply to tweets" : "Delete tweets"}</span>
                    <Switch
                      checked={account.permissions[perm]}
                      onCheckedChange={(checked) => permMutation.mutate({ accountId: account.id, perms: { [perm]: checked } })}
                      data-testid={`switch-twitter-perm-${perm}-${account.id}`}
                    />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="Enter Bearer Token for X Search"
                    value={editBearerToken[account.id] ?? ""}
                    onChange={(e) => setEditBearerToken((prev) => ({ ...prev, [account.id]: e.target.value }))}
                    className="h-7 text-xs"
                    data-testid={`input-bearer-token-${account.id}`}
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={!editBearerToken[account.id]?.trim() || savingBearer === account.id}
                    onClick={() => bearerMutation.mutate({ accountId: account.id, token: editBearerToken[account.id] })}
                    data-testid={`button-save-bearer-${account.id}`}
                  >
                    {savingBearer === account.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </Button>
                </div>
              </div>
            ) : undefined}
            menuContent={(
              <DropdownMenuItem onClick={() => removeMutation.mutate(account.id)} disabled={removeMutation.isPending} data-testid={`button-remove-twitter-${account.id}`}>
                Remove
              </DropdownMenuItem>
            )}
          >
            <span className="truncate text-muted-foreground" data-testid={account.valid ? `badge-twitter-valid-${account.id}` : `badge-twitter-invalid-${account.id}`}>
              {account.valid ? "Connected" : (account.error || "Invalid credentials")}
              {" · "}
              <span data-testid={`text-twitter-date-${account.id}`}>Added {new Date(account.addedAt).toLocaleDateString()}</span>
            </span>
          </ProfileTreeRow>
        ))}
        <ProfileTreeRow
          label="Add account"
          icon={<Plus className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          defaultOpen={showAddForm}
          expandedContent={showAddForm ? (
            <div className="space-y-3">
              <Input type={showSecrets ? "text" : "password"} placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="input-twitter-api-key" />
              <Input type={showSecrets ? "text" : "password"} placeholder="API Secret" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} data-testid="input-twitter-api-secret" />
              <Input type={showSecrets ? "text" : "password"} placeholder="Access Token" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} data-testid="input-twitter-access-token" />
              <Input type={showSecrets ? "text" : "password"} placeholder="Access Token Secret" value={accessTokenSecret} onChange={(e) => setAccessTokenSecret(e.target.value)} data-testid="input-twitter-access-token-secret" />
              <Input type={showSecrets ? "text" : "password"} placeholder="Bearer Token (optional)" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} data-testid="input-twitter-bearer-token" />
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setShowSecrets(!showSecrets)} data-testid="button-toggle-twitter-secrets">
                  {showSecrets ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                  {showSecrets ? "Hide" : "Show"} values
                </Button>
                <Button onClick={handleAddAccount} disabled={!apiKey.trim() || !apiSecret.trim() || !accessToken.trim() || !accessTokenSecret.trim() || isAdding} data-testid="button-connect-twitter">
                  {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
                </Button>
              </div>
            </div>
          ) : undefined}
          actionContent={(
            <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)} data-testid="button-add-twitter-account">
              {showAddForm ? "Cancel" : "Add"}
            </Button>
          )}
        >
          <span className="text-muted-foreground">{showAddForm ? "Enter credentials" : "Connect another"}</span>
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}


function GoogleAccountsSection({ oauthConfigured, drivePickerConfigured }: { oauthConfigured: boolean; drivePickerConfigured: boolean }) {
  const { toast } = useToast();
  const [showAddForm, setShowAddForm] = useState(false);
  const [justConnectedAccountId, setJustConnectedAccountId] = useState<string | null>(null);
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [accountPendingRemoval, setAccountPendingRemoval] = useState<{ id: string; email: string; confirmToken: string } | null>(null);
  const [removalConfirmation, setRemovalConfirmation] = useState("");
  const { vaults, activeVaultId } = useVaults();

  const openAddForm = () => {
    setSelectedVaultId(activeVaultId || "");
    setShowAddForm(true);
  };

  // Auto-open the New Account dialog when arriving from the Email + Link Email
  // action (`/integrations/google?action=new-account`). Consume the param once
  // so a refresh does not reopen it.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!oauthConfigured || autoOpenedRef.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("action") !== "new-account") return;
    autoOpenedRef.current = true;
    openAddForm();
    params.delete("action");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthConfigured]);

  const { data: accountsData, isLoading } = useQuery<{
    accounts: Array<{
      id: string;
      email: string;
      label: string;
      scopes?: { hasGmailRead: boolean; hasSend: boolean; hasDrive?: boolean; missingScopes?: string[] };
      missingScopes?: string[];
      healthy?: boolean;
      healthError?: string;
    }>;
  }>({
    queryKey: ["/api/gmail/accounts"],
  });

  const { data: permsData } = useQuery<{ accounts: ConnectedAccountWithPerms[] }>({
    queryKey: ["/api/connected-accounts", "google"],
    queryFn: async () => {
      const res = await fetch("/api/connected-accounts?provider=google");
      if (!res.ok) throw new Error("Failed to load accounts");
      return res.json();
    },
  });

  const assignVaultMutation = useMutation({
    mutationFn: async ({ accountId, vaultId }: { accountId: string; vaultId: string }) => {
      await apiRequest("PUT", `/api/connected-accounts/${encodeURIComponent(accountId)}/vault`, { vaultId });
    },
    onMutate: async ({ accountId, vaultId }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/connected-accounts", "google"] });
      const previous = queryClient.getQueryData<{ accounts: ConnectedAccountWithPerms[] }>([
        "/api/connected-accounts",
        "google",
      ]);
      const vault = vaults.find((candidate) => candidate.id === vaultId);
      if (vault) {
        queryClient.setQueryData<{ accounts: ConnectedAccountWithPerms[] }>(
          ["/api/connected-accounts", "google"],
          (current) => current ? {
            ...current,
            accounts: current.accounts.map((candidate) => candidate.accountId === accountId ? {
              ...candidate,
              vaultId,
              vault: { id: vault.id, name: vault.name, color: vault.color ?? null },
            } : candidate),
          } : current,
        );
      }
      return { previous };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "google"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/gmail/status"] }),
      ]);
      toast({ title: "Vault assigned" });
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/connected-accounts", "google"], context.previous);
      }
      toast({ title: "Failed to assign vault", description: error.message, variant: "destructive" });
    },
  });
  const removeMutation = useMutation({
    mutationFn: async ({ accountId, confirmation }: { accountId: string; confirmation: string }) => {
      await apiRequest("DELETE", `/api/gmail/accounts/${accountId}`, { confirmation });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "google"] });
      setAccountPendingRemoval(null);
      setRemovalConfirmation("");
      toast({ title: "Account removed" });
    },
    onError: (err: Error) => {
      log.error("Google account remove failed:", err);
      toast({ title: "Failed to remove account", description: err.message, variant: "destructive" });
    },
  });

  const accounts = accountsData?.accounts || [];
  const permAccounts = (permsData?.accounts || []).filter((account) => account.provider === "google");
  const needsAttention = !oauthConfigured || accounts.some((account) => {
    const missingScopes = account.missingScopes || account.scopes?.missingScopes || [];
    const bound = permAccounts.find((candidate) => candidate.email === account.email);
    return !bound?.vaultId || account.healthy === false || missingScopes.length > 0 || Boolean(account.scopes && !account.scopes.hasGmailRead);
  });

  const refreshGoogleQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
    queryClient.invalidateQueries({ queryKey: ["/api/gmail/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "google"] });
    queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
  }, [queryClient]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; status?: string; accountId?: string } | null;
      if (!data || data.type !== "mantra:google-oauth") return;
      refreshGoogleQueries();
      if (data.status === "connected") {
        if (data.accountId) setJustConnectedAccountId(data.accountId);
        setShowAddForm(false);
        toast({ title: "Google account connected" });
      }
    };
    const onFocus = () => refreshGoogleQueries();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshGoogleQueries();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshGoogleQueries, toast]);

  const startOAuth = async (vaultId: string, accountId?: string) => {
    try {
      // Reauth and first-time connect both mint a full-scope consent URL
      // (drive.file included). createConnectedAccountInVault upserts by
      // provider+email, so re-consent updates the existing account scopes.
      const res = await apiRequest("POST", "/api/gmail/accounts/add", { vaultId });
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "mantra-google-oauth", "width=500,height=700");
        // Fallback if the popup cannot postMessage (opener severed).
        window.setTimeout(() => {
          refreshGoogleQueries();
          if (!accountId) setShowAddForm(false);
        }, 5000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error(accountId ? "Google reauth failed:" : "Google OAuth failed:", error);
      toast({
        title: accountId ? "Failed to start re-authorization" : "Failed to start OAuth",
        description: message,
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {oauthConfigured ? (
        <div className="px-2 py-1">
          <button
            type="button"
            onClick={openAddForm}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80"
            data-testid="button-add-google-account"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Account</span>
          </button>
        </div>
      ) : null}
      <Dialog open={showAddForm} onOpenChange={setShowAddForm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a Google account</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="google-account-vault">Vault</Label>
            <Select value={selectedVaultId} onValueChange={setSelectedVaultId}>
              <SelectTrigger id="google-account-vault" data-testid="select-google-account-vault" aria-label="Select account Vault"><SelectValue placeholder="Select Vault" /></SelectTrigger>
              <SelectContent>{vaults.map((vault) => <SelectItem key={vault.id} value={vault.id}>{vault.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddForm(false)}>Cancel</Button>
            <Button disabled={!selectedVaultId} onClick={() => startOAuth(selectedVaultId)} data-testid="button-connect-google-account">Connect to Google</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!oauthConfigured ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-google-oauth-required">
          Add the Google client ID and client secret under Credentials before connecting an account.
        </p>
      ) : isLoading ? (
        <div className="space-y-1 px-2 py-1.5">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : accounts.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-no-google-accounts">
          No Google accounts connected.
        </p>
      ) : (
        <div className="space-y-0">
          <div className="px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Accounts</div>
          {(() => {
            const vaultById = new Map(vaults.map((vault) => [vault.id, vault]));
            return accounts.map((account) => {
        const missingScopes = account.missingScopes || account.scopes?.missingScopes || [];
        const needsReauth = missingScopes.length > 0 || Boolean(account.scopes && !account.scopes.hasGmailRead);
        const tokenExpired = account.healthy === false;
        const isHealthy = account.healthy === true && !needsReauth;
        const showReauth = needsReauth || tokenExpired;
        const hasEmail = Boolean(account.email && account.email.trim());
        const permAccount = permAccounts.find((permissionAccount) =>
          hasEmail
            ? permissionAccount.email === account.email
            : permissionAccount.accountId === account.id,
        ) || permAccounts.find((permissionAccount) => permissionAccount.accountId === account.id);
        const isOrphan = !hasEmail || !permAccount?.vaultId;
        const vaultRequired = !permAccount?.vaultId;
        const status = !hasEmail
          ? "Orphan"
          : vaultRequired
            ? "Vault required"
            : tokenExpired
              ? "Token expired"
              : needsReauth
                ? "Missing permissions"
                : isHealthy
                  ? "Verified"
                  : "Connected";
        const accountTitleColor = vaultTitleColor(
          permAccount?.vaultId ? [permAccount.vaultId] : undefined,
          vaultById,
          activeVaultId,
          1,
        );
        const displayLabel = hasEmail ? account.email : `Orphan · ${account.id.slice(0, 18)}…`;
        const confirmToken = hasEmail ? account.email : account.id;

        const statusIcon = showReauth || isOrphan
          ? <XCircle className="h-3.5 w-3.5 text-destructive" />
          : isHealthy
            ? <CheckCircle2 className="h-3.5 w-3.5 text-active" />
            : <Mail className="h-3.5 w-3.5" />;

        return (
          <IntegrationTreeSection
            key={account.id}
            label={displayLabel}
            initialOpen={showReauth || vaultRequired || isOrphan || account.id === justConnectedAccountId}
            testIdPrefix={`google-account-${account.id}`}
            expanderRight
            variant="item"
            icon={<Mail className="h-3.5 w-3.5" />}
            persistKey={`google-account-${account.id}`}
            labelColor={accountTitleColor}
            actions={(
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="mr-1 h-8 w-8 text-muted-foreground" aria-label={`Actions for ${displayLabel}`} data-testid={`button-google-account-actions-${account.id}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {hasEmail ? (
                    <DropdownMenuItem
                      onClick={() => startOAuth(permAccount?.vaultId || vaults[0]?.id, account.id)}
                      disabled={!permAccount?.vaultId && vaults.length === 0}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" /> Reconnect
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => {
                      setAccountPendingRemoval({ id: account.id, email: account.email || "", confirmToken });
                      setRemovalConfirmation("");
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> {isOrphan ? "Destroy" : "Remove"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          >
            <HierarchyTreeRow continues connectorAnchor="first-row-center">
              <ProfileTreeRow label={<span>Status</span>} icon={statusIcon} hasValue showEmpty mobileLayout="inline" valueLayout="compact" testId={`row-google-status-${account.id}`}>
                <span className={cn(showReauth && "text-destructive", isHealthy && "text-active")}>{status}</span>
              </ProfileTreeRow>
            </HierarchyTreeRow>
            <HierarchyTreeRow continues connectorAnchor="first-row-center">
              <ProfileTreeRow label={<span>Vault</span>} icon={<Shield className="h-3.5 w-3.5" />} hasValue={Boolean(permAccount?.vault)} showEmpty mobileLayout="inline" valueLayout="compact" testId={`row-google-vault-${account.id}`}>
                {permAccount?.vault ? (
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: permAccount.vault.color || undefined }} />{permAccount.vault.name}</span>
                ) : permAccount && vaults.length > 0 ? (
                  <Select
                    value={permAccount.vaultId ?? undefined}
                    onValueChange={(vaultId) => assignVaultMutation.mutate({
                      accountId: permAccount.accountId,
                      vaultId,
                    })}
                    disabled={assignVaultMutation.isPending}
                  >
                    <SelectTrigger className="h-8 w-44" aria-label="Assign vault" data-testid={`select-assign-google-vault-${account.id}`}>
                      <SelectValue placeholder="Assign" />
                    </SelectTrigger>
                    <SelectContent>
                      {vaults.map((vault) => (
                        <SelectItem key={vault.id} value={vault.id}>{vault.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </ProfileTreeRow>
            </HierarchyTreeRow>
            {(account.healthError || missingScopes.length > 0) ? (
              <HierarchyTreeRow continues connectorAnchor="first-row-center">
                <div className="min-w-0 space-y-1 px-2 py-1.5">
                  {account.healthError ? (
                    <p className="text-xs text-destructive" data-testid={`text-account-health-${account.id}`}>{account.healthError}</p>
                  ) : null}
                  {missingScopes.length > 0 ? (
                    <p className="text-xs text-destructive" data-testid={`text-missing-scopes-${account.id}`}>
                      Missing: {missingScopes.map((scope) => scope.split("/").pop() || scope).join(", ")}
                    </p>
                  ) : null}
                </div>
              </HierarchyTreeRow>
            ) : null}
            <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
              <DriveSection
                vaultId={permAccount?.vaultId ?? undefined}
                connectedAccountId={permAccount?.accountId}
                drivePickerConfigured={drivePickerConfigured}
                hasDriveScope={Boolean(account.scopes?.hasDrive)}
              />
            </HierarchyTreeRow>
          </IntegrationTreeSection>
        );
            });
          })()}
        </div>
      )}

      <AlertDialog
        open={Boolean(accountPendingRemoval)}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) {
            setAccountPendingRemoval(null);
            setRemovalConfirmation("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {accountPendingRemoval && !accountPendingRemoval.email ? "Destroy orphan Google connector?" : "Remove Google account?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {accountPendingRemoval && !accountPendingRemoval.email
                ? `This permanently deletes the dead connector ${accountPendingRemoval.id} and any cached email state bound to it. There is no email to reconnect.`
                : `This permanently deletes the cached emails, enrichment, triage history, drafts, dismissals, and sync cursor for ${accountPendingRemoval?.email}. Reconnect instead if you only need to replace OAuth credentials.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="google-account-removal-confirmation">
              Type <span className="font-mono text-foreground break-all">{accountPendingRemoval?.confirmToken}</span> to confirm
            </Label>
            <Input
              id="google-account-removal-confirmation"
              value={removalConfirmation}
              onChange={(event) => setRemovalConfirmation(event.target.value)}
              autoComplete="off"
              data-testid="input-confirm-google-account-removal"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!accountPendingRemoval || removalConfirmation !== accountPendingRemoval.confirmToken || removeMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!accountPendingRemoval || removalConfirmation !== accountPendingRemoval.confirmToken) return;
                removeMutation.mutate({
                  accountId: accountPendingRemoval.id,
                  confirmation: removalConfirmation,
                });
              }}
              data-testid="button-confirm-google-account-removal"
            >
              {removeMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : accountPendingRemoval && !accountPendingRemoval.email
                  ? "Destroy connector"
                  : "Remove account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function GoogleDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: gmailStatus, isLoading } = useQuery<{
    oauthConfigured: boolean;
    drivePickerConfigured?: boolean;
  }>({
    queryKey: ["/api/gmail/status"],
  });
  const { data: googleAccountsData } = useQuery<{
    accounts: Array<{ id: string; scopes?: { hasDrive?: boolean } }>;
  }>({
    queryKey: ["/api/gmail/accounts"],
    enabled: Boolean(gmailStatus?.oauthConfigured),
  });
  const { data: permsData } = useQuery<{
    accounts: Array<{ accountId: string; provider: string; email: string; vaultId: string | null }>;
  }>({
    queryKey: ["/api/connected-accounts", "google"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/connected-accounts?provider=google");
      return res.json();
    },
    enabled: Boolean(gmailStatus?.oauthConfigured),
  });
  const { activeVaultId } = useVaults();
  const oauthConfigured = Boolean(gmailStatus?.oauthConfigured);
  const driveAccount = googleAccountsData?.accounts?.find((account) => account.scopes?.hasDrive)
    ?? googleAccountsData?.accounts?.[0];
  const reconnectGoogle = useCallback(async () => {
    if (!driveAccount) return;
    const bound = permsData?.accounts?.find(
      (candidate) => candidate.provider === "google" && candidate.accountId === driveAccount.id,
    ) ?? permsData?.accounts?.find((candidate) => candidate.provider === "google" && candidate.vaultId);
    const vaultId = bound?.vaultId || activeVaultId;
    if (!vaultId) {
      toast({
        title: "Vault required",
        description: "Assign this Google account to a Vault before reconnecting Drive.",
        variant: "destructive",
      });
      return;
    }
    try {
      const res = await apiRequest("POST", "/api/gmail/accounts/add", { vaultId });
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "mantra-google-oauth", "width=500,height=700");
        window.setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
          queryClient.invalidateQueries({ queryKey: ["/api/gmail/status"] });
          queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "google"] });
        }, 5000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast({ title: "Failed to start re-authorization", description: message, variant: "destructive" });
    }
  }, [activeVaultId, driveAccount, permsData?.accounts, queryClient, toast]);

  if (isLoading) {
    return (
      <div className="space-y-2 px-2 py-1.5">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <GoogleAccountsSection oauthConfigured={oauthConfigured} drivePickerConfigured={gmailStatus?.drivePickerConfigured !== false} />
    </div>
  );
}

function BoxDetail() {
  const { activeVaultId } = useVaults();
  return (
    <div className="min-w-0" data-testid="box-detail">
      <IntegrationTreeSection label="Box account" initialOpen>
        <BoxSection vaultId={activeVaultId || undefined} />
      </IntegrationTreeSection>
    </div>
  );
}

function MondayDetail() {
  const { activeVaultId } = useVaults();
  return (
    <div className="min-w-0" data-testid="monday-detail">
      <IntegrationTreeSection label="Monday account" initialOpen>
        <MondaySection vaultId={activeVaultId || undefined} />
      </IntegrationTreeSection>
    </div>
  );
}

function PlaidLinkButton({ onSuccess }: { onSuccess: (publicToken: string, metadata: any) => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkTokenError, setLinkTokenError] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchLinkToken = () => {
    setLinkTokenError(null);
    apiRequest("POST", "/api/plaid/create-link-token")
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setLinkTokenError(data.error);
          toast({ title: "Unable to connect bank", description: data.error, variant: "destructive" });
        } else {
          setLinkToken(data.linkToken);
        }
      })
      .catch((err) => {
        let msg = "Failed to reach server. Please try again.";
        try {
          const parsed = JSON.parse(err?.message?.replace(/^\d+:\s*/, "") ?? "");
          if (parsed?.error) msg = parsed.error;
        } catch { if (err?.message) msg = err.message; }
        setLinkTokenError(msg);
        toast({ title: "Unable to connect bank", description: msg, variant: "destructive" });
      });
  };

  useEffect(() => {
    fetchLinkToken();
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => onSuccess(publicToken, metadata),
  });

  if (linkTokenError) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-destructive" data-testid="text-plaid-error">{linkTokenError}</p>
        <Button
          onClick={fetchLinkToken}
          variant="outline"
          size="sm"
          data-testid="button-connect-bank-retry"
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={() => open()}
      disabled={!ready || !linkToken}
      variant="outline"
      size="sm"
      data-testid="button-connect-bank"
    >
      <Plus className="h-4 w-4 mr-1.5" />
      Connect Bank
    </Button>
  );
}

function PlaidAccountsSection() {
  const { toast } = useToast();

  const { data: status } = useQuery<{
    configured: boolean;
    diagnostics?: {
      missing: string[];
      invalid: string[];
      details: {
        PLAID_CLIENT_ID: { set: boolean };
        PLAID_SECRET: { set: boolean };
        PLAID_ENV: { set: boolean; value: string | null; valid: boolean; validValues: string[] };
      };
    };
  }>({
    queryKey: ["/api/plaid/status"],
  });

  const { data: accounts, isLoading } = useQuery<Array<{
    accountId: string;
    itemId: string;
    institutionName: string;
    healthy: boolean;
    accounts?: Array<{ name: string; type: string; subtype: string | null; currentBalance: number | null }>;
  }>>({
    queryKey: ["/api/plaid/accounts"],
    enabled: status?.configured === true,
  });

  const exchangeMutation = useMutation({
    mutationFn: async (publicToken: string) => {
      const res = await apiRequest("POST", "/api/plaid/exchange-token", { publicToken });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
      toast({ title: "Bank connected", description: "Your financial accounts have been linked." });
    },
    onError: (err: any) => {
      toast({ title: "Connection failed", description: err.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      await apiRequest("DELETE", `/api/plaid/items/${accountId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
      toast({ title: "Account removed" });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/plaid/refresh");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/accounts"] });
      toast({ title: "Accounts refreshed" });
    },
  });

  if (!status?.configured) {
    const diag = status?.diagnostics;
    const clientIdOk = diag?.details?.PLAID_CLIENT_ID?.set ?? false;
    const secretOk = diag?.details?.PLAID_SECRET?.set ?? false;
    const envSet = diag?.details?.PLAID_ENV?.set ?? false;
    const envValid = diag?.details?.PLAID_ENV?.valid ?? false;
    const envOk = envSet && envValid;
    const envValue = diag?.details?.PLAID_ENV?.value;

    return (
      <div className="min-w-0 space-y-2">
        <IntegrationTreeSection label="Accounts" initialOpen icon={<Landmark className="h-3.5 w-3.5" />} testIdPrefix="plaid-accounts">
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-plaid-not-configured">
            Credentials not set.
          </div>
          <div data-testid="list-plaid-config-status">
            <ProfileTreeRow
              label="PLAID_CLIENT_ID"
              icon={<Landmark className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="status-plaid-client-id"
            >
              {clientIdOk ? "Set" : "Not set"}
            </ProfileTreeRow>
            <ProfileTreeRow
              label="PLAID_SECRET"
              icon={<Landmark className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="status-plaid-secret"
            >
              {secretOk ? "Set" : "Not set"}
            </ProfileTreeRow>
            <ProfileTreeRow
              label="PLAID_ENV"
              icon={<Landmark className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId="status-plaid-env"
            >
              {envOk ? envValue : !envSet ? "Not set" : `Invalid: ${envValue}`}
            </ProfileTreeRow>
          </div>
        </IntegrationTreeSection>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <IntegrationTreeSection
        label="Accounts"
        initialOpen
        icon={<Landmark className="h-3.5 w-3.5" />}
        testIdPrefix="plaid-accounts"
        actions={(
          <div className="flex items-center gap-2 pr-2">
            {accounts && accounts.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                data-testid="button-refresh-finance"
              >
                <RefreshCw className={cn("h-4 w-4", refreshMutation.isPending && "animate-spin")} />
              </Button>
            ) : null}
            <PlaidLinkButton onSuccess={(token) => exchangeMutation.mutate(token)} />
          </div>
        )}
      >
        {isLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>
        ) : !accounts || accounts.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-no-plaid-accounts">
            No financial accounts yet.
          </div>
        ) : (
          accounts.map((item) => (
            <ProfileTreeRow
              key={item.accountId}
              label={item.institutionName || "Unknown Institution"}
              icon={<Landmark className={cn("h-3.5 w-3.5", item.healthy ? "text-success" : "text-error")} />}
              hasValue
              showEmpty
              mobileLayout="inline"
              testId={`card-plaid-item-${item.accountId}`}
              actionContent={(
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeMutation.mutate(item.accountId)}
                  disabled={removeMutation.isPending}
                  data-testid={`button-remove-plaid-${item.accountId}`}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              )}
            >
              <span className="text-xs text-muted-foreground" data-testid={`text-institution-${item.accountId}`}>
                {item.accounts && item.accounts.length > 0
                  ? `${item.accounts.length} account${item.accounts.length !== 1 ? "s" : ""}`
                  : item.healthy ? "Healthy" : "Unhealthy"}
              </span>
            </ProfileTreeRow>
          ))
        )}
      </IntegrationTreeSection>
    </div>
  );
}

interface QuickBooksAccountSummary {
  accountId: string;
  companyName: string;
  legalName: string | null;
  country: string | null;
  healthy: boolean;
  healthError: string | null;
  lastCompanyInfoSyncAt: string | null;
  vaultId: string | null;
  readOnly: true;
}

interface QuickBooksStatus {
  configured: boolean;
  connected: boolean;
  healthy?: boolean;
  readOnly: true;
  accounts: QuickBooksAccountSummary[];
}

function QuickBooksAccountsSection() {
  const { toast } = useToast();
  const { vaults, activeVaultId } = useVaults();
  const [selectedVaultId, setSelectedVaultId] = useState(activeVaultId || "");

  useEffect(() => {
    if (!selectedVaultId && activeVaultId) setSelectedVaultId(activeVaultId);
  }, [activeVaultId, selectedVaultId]);

  const { data: status, isLoading } = useQuery<QuickBooksStatus>({
    queryKey: ["/api/quickbooks/status"],
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/quickbooks/oauth/start", { vaultId: selectedVaultId });
      return response.json() as Promise<{ url: string }>;
    },
    onSuccess: ({ url }) => {
      window.open(url, "_blank", "width=500,height=700");
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/quickbooks/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      }, 5000);
    },
    onError: (error: Error) => toast({ title: "Connection failed", description: error.message, variant: "destructive" }),
  });

  const refreshMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const response = await apiRequest("POST", `/api/quickbooks/accounts/${accountId}/company-info`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/quickbooks/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "Company refreshed" });
    },
    onError: (error: Error) => toast({ title: "Refresh failed", description: error.message, variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: async (accountId: string) => apiRequest("DELETE", `/api/quickbooks/accounts/${accountId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/quickbooks/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "QuickBooks disconnected" });
    },
    onError: (error: Error) => toast({ title: "Disconnect failed", description: error.message, variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="space-y-2 px-2 py-1.5"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>;
  }

  const accounts = status?.accounts || [];
  return (
    <IntegrationTreeSection label="Companies" initialOpen testIdPrefix="quickbooks">
      {!status?.configured ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">Add the QuickBooks client ID, client secret, and environment under Credentials.</p>
      ) : accounts.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No QuickBooks companies connected.</p>
      ) : accounts.map((account) => (
        <ProfileTreeRow
          key={account.accountId}
          label={account.companyName}
          icon={account.healthy ? <CheckCircle2 className="h-3.5 w-3.5 text-active" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
          value={account.healthy ? "Read-only" : "Needs attention"}
          showEmpty
          defaultOpen={!account.healthy}
          testId={`quickbooks-account-${account.accountId}`}
          expandedContentClassName="min-w-0 space-y-3"
          expandedContent={
            <>
              <div className="space-y-1 text-sm">
                {account.legalName ? <p>{account.legalName}</p> : null}
                <p className="text-muted-foreground">{account.country || "Company connected"}{account.lastCompanyInfoSyncAt ? ` · Updated ${new Date(account.lastCompanyInfoSyncAt).toLocaleString()}` : ""}</p>
                {account.healthError ? <p className="text-destructive">{account.healthError}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => refreshMutation.mutate(account.accountId)} disabled={refreshMutation.isPending}>
                  <RefreshCw className={cn("h-3.5 w-3.5", refreshMutation.isPending && "animate-spin")} />
                  Refresh
                </Button>
                <Button variant="ghost" size="sm" onClick={() => disconnectMutation.mutate(account.accountId)} disabled={disconnectMutation.isPending}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Disconnect
                </Button>
              </div>
            </>
          }
        />
      ))}

      {status?.configured ? (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
          <Select value={selectedVaultId} onValueChange={setSelectedVaultId}>
            <SelectTrigger className="w-48" aria-label="Select QuickBooks Vault"><SelectValue placeholder="Select Vault" /></SelectTrigger>
            <SelectContent>{vaults.map((vault) => <SelectItem key={vault.id} value={vault.id}>{vault.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={() => startMutation.mutate()} disabled={!selectedVaultId || startMutation.isPending} data-testid="button-connect-quickbooks">
            {startMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Connect
          </Button>
        </div>
      ) : null}
    </IntegrationTreeSection>
  );
}

function QuickBooksDetail() {
  return (
    <div className="min-w-0 space-y-2">
      <QuickBooksAccountsSection />
      <IntegrationTreeSection label="Credentials" testIdPrefix="quickbooks">
        <div className="min-w-0 px-2 py-1.5"><SecretsForSection section="quickbooks" /></div>
      </IntegrationTreeSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration Grid
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Expo Mobile detail
// ---------------------------------------------------------------------------

interface ExpoStatus {
  connected: boolean;
  username?: string;
  accountName?: string;
  accounts?: { id: string; name: string }[];
  error?: string;
}

interface ExpoProjectConfig {
  configured: boolean;
  owner?: string;
  slug?: string;
  projectId?: string;
  message?: string;
  error?: string;
}

interface ExpoBuildLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

interface ExpoBuildLogRun {
  status: "running" | "success" | "failed" | "cancelled";
  result: { guidance?: string; stderr?: string; error?: string } | null;
  logs?: ExpoBuildLogEntry[];
  interactive?: boolean;
  inputCount?: number;
}

interface ExpoAppleCredentialsConfig {
  configured: boolean;
  appleIdEmail?: string;
  teamId?: string;
  bundleIdentifier?: string;
  updatedAt?: string;
  error?: string;
}

function expoCredentialsUrl(config: ExpoProjectConfig | undefined): string {
  if (config?.owner && config?.slug) {
    return `https://expo.dev/accounts/${encodeURIComponent(config.owner)}/projects/${encodeURIComponent(config.slug)}/credentials`;
  }
  return "https://expo.dev/accounts";
}


interface EasPromptOption {
  label: string;
  selected: boolean;
}

interface EasPromptView {
  prompt: string;
  options: EasPromptOption[];
  selectedIndex: number;
  yesNo?: boolean;
}

function cleanEasPromptLine(message: string): string {
  return message.replace(/^\?\s*/, "").trim();
}

function isEasPromptLine(message: string): boolean {
  const line = cleanEasPromptLine(message);
  if (/^[›>✓✔-]/.test(line)) return false;
  return /^\?\s+/.test(message.trim()) || /Select .+›\s*$|Choose .+›\s*$|\(Y\/n\)|\(y\/N\)|Please enter|Apple ID|password|verification|2FA|team/i.test(line);
}

function isTerminalStatusLine(message: string): boolean {
  const line = message.trim();
  return (
    line.length === 0 ||
    /^[✓✔-]\s/.test(line) ||
    /^Learn more:/i.test(line) ||
    /^Sent response #\d+ to EAS prompt\.?$/i.test(line) ||
    /^Two-factor Authentication/i.test(line) ||
    /^Logging in/i.test(line) ||
    /^Logged in/i.test(line)
  );
}

function parseInlineEasChoices(prompt: string): EasPromptOption[] {
  const match = prompt.match(/›\s*([^›]+)$/);
  const tail = match?.[1]?.trim();
  if (!tail || !tail.includes(" / ")) return [];
  return tail
    .split(" / ")
    .map((label, index) => ({ label: label.trim(), selected: index === 0 }))
    .filter((option) => option.label.length > 0 && !/[?]/.test(option.label));
}

function isFreeformEasPrompt(prompt: string): boolean {
  if (/\((?:Y\/n|y\/N)\)/.test(prompt)) return false;
  if (/^(Select|Choose)\b/i.test(prompt)) return false;
  return /Please enter|\benter\b|code|password|Apple ID|email/i.test(prompt);
}

function parseEasPromptView(logs: ExpoBuildLogEntry[]): EasPromptView | null {
  const promptIndex = [...logs]
    .map((entry, index) => ({ entry, index }))
    .reverse()
    .find(({ entry }) => entry.stream !== "system" && isEasPromptLine(entry.message))?.index;

  if (promptIndex === undefined) return null;

  const prompt = cleanEasPromptLine(logs[promptIndex].message);
  const yesNo = /\((?:Y\/n|y\/N)\)/.test(prompt);
  if (yesNo || isFreeformEasPrompt(prompt)) {
    return { prompt, options: [], selectedIndex: 0, yesNo };
  }

  const inlineOptions = parseInlineEasChoices(prompt);
  if (inlineOptions.length > 0) {
    return { prompt, options: inlineOptions, selectedIndex: 0, yesNo: false };
  }

  const optionLines: string[] = [];
  for (const entry of logs.slice(promptIndex + 1, promptIndex + 12)) {
    const line = entry.message.trimEnd();
    if (!line.trim()) continue;
    if (entry.stream === "system" || isEasPromptLine(line) || isTerminalStatusLine(line)) break;
    // Real inquirer lists are contiguous lines after the prompt. Status/output lines are not options.
    optionLines.push(line);
  }

  const options = optionLines
    .map((line) => {
      const selected = /^\s*[›>]/.test(line);
      const label = line.replace(/^\s*[›>]?\s*/, "").trim();
      return { label, selected };
    })
    .filter((option) => option.label.length > 0)
    .filter((option) => !isTerminalStatusLine(option.label) && !isEasPromptLine(option.label))
    .filter((option, index, all) => all.findIndex((candidate) => candidate.label === option.label) === index);

  return {
    prompt,
    options,
    selectedIndex: Math.max(0, options.findIndex((option) => option.selected)),
    yesNo: false,
  };
}

function easSelectionInput(fromIndex: number, toIndex: number): string {
  const safeFrom = Math.max(0, fromIndex);
  const safeTo = Math.max(0, toIndex);
  if (safeTo === safeFrom) return "";
  const direction = safeTo > safeFrom ? "\u001b[B" : "\u001b[A";
  return direction.repeat(Math.abs(safeTo - safeFrom));
}


interface RecallStatus {
  connected: boolean;
  hasKey?: boolean;
  region?: string | null;
  hasWebhookSecret?: boolean;
  hasWorkspaceVerificationSecret?: boolean;
  statusWebhookUrl?: string;
  transcriptWebhookUrl?: string;
  runtimeEnvironment?: string;
  servingHost?: string | null;
  publicUrl?: string | null;
  error?: string;
}

function RecallDetail() {
  const { toast } = useToast();
  const { data: recallStatus, isLoading } = useQuery<RecallStatus>({
    queryKey: ["/api/integrations/recall/status"],
    refetchInterval: false,
  });
  const { data: secretMetadata } = useQuery<{ secrets: Array<{ name: string; status: "set" | "not_set" | "invalid" }> }>({
    queryKey: ["/api/secrets/metadata"],
  });
  const [connectionTestError, setConnectionTestError] = useState<string | null>(null);
  const testConnection = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/integrations/recall/test");
      return (await response.json()) as RecallStatus;
    },
    onSuccess: (status) => {
      queryClient.setQueryData(["/api/integrations/recall/status"], status);
      setConnectionTestError(status.connected ? null : status.error ?? "Check the API key and region, then try again.");
      toast({
        title: status.connected ? "Recall.ai connected" : "Recall.ai connection failed",
        description: status.connected
          ? `API credentials verified${status.region ? ` in ${status.region}` : ""}. Complete the status webhook setup below before live testing.`
          : status.error ?? "Check the API key and region, then try again.",
        variant: status.connected ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      setConnectionTestError(error.message);
      toast({
        title: "Recall.ai connection test failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const statusLabel = recallStatus?.connected
    ? `API connected${recallStatus.region ? ` (${recallStatus.region})` : ""}`
    : recallStatus?.error
      ? `Not connected: ${recallStatus.error}`
      : "Not connected";
  const recallSecretStatuses = new Map(
    (secretMetadata?.secrets ?? [])
      .filter((secret) => secret.name.startsWith("RECALL_"))
      .map((secret) => [secret.name, secret.status] as const),
  );
  const credentialsReady = ["RECALL_API_KEY", "RECALL_REGION", "RECALL_WEBHOOK_SECRET", "RECALL_WORKSPACE_VERIFICATION_SECRET"]
    .every((name) => recallSecretStatuses.get(name) === "set");
  const credentialsLoading = !secretMetadata;
  const webhookReady = Boolean(
    recallStatus?.connected &&
    recallStatus?.hasWebhookSecret &&
    recallStatus?.hasWorkspaceVerificationSecret &&
    recallSecretStatuses.get("RECALL_WEBHOOK_SECRET") === "set" &&
    recallSecretStatuses.get("RECALL_WORKSPACE_VERIFICATION_SECRET") === "set",
  );
  const connectionNeedsAttention = isLoading || !recallStatus?.connected || Boolean(recallStatus?.error);
  const credentialsNeedAttention = credentialsLoading || !credentialsReady;
  const webhookNeedsAttention = isLoading || credentialsLoading || !webhookReady;

  return (
    <div className="min-w-0 space-y-2" data-testid="card-recall-status">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
        <Radio className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Recall</h2>
          <p className="text-sm text-muted-foreground">
            Joins Zoom and Google Meet calls as "Mantra Agent" and streams speaker-attributed transcripts.
          </p>
        </div>
      </div>



      <IntegrationTreeSection label="Connection" initialOpen={connectionNeedsAttention}>
        <ProfileTreeRow
          label="Status"
          icon={recallStatus?.connected
            ? <CheckCircle2 className="h-3.5 w-3.5 text-active" />
            : <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
          hasValue
          showEmpty
          testId="recall-connection-status"
          expandedContent={recallStatus?.error || connectionTestError ? (
            <p className="text-destructive">{connectionTestError ?? recallStatus?.error}</p>
          ) : undefined}
        >
          {isLoading ? (
            <Skeleton className="h-4 w-28" />
          ) : (
            <span className={cn(recallStatus?.connected ? "text-active" : "text-muted-foreground")}>
              {statusLabel}
            </span>
          )}
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Connection test"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => testConnection.mutate()}
            disabled={testConnection.isPending}
            data-testid="button-recall-test-connection"
          >
            {testConnection.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test connection"}
          </Button>
        </ProfileTreeRow>
      </IntegrationTreeSection>

      <IntegrationTreeSection label="Credentials" initialOpen={credentialsNeedAttention}>
        <div className="min-w-0 px-2 py-1.5">
          <SecretsForSection section="recall" />
        </div>
      </IntegrationTreeSection>

      <IntegrationTreeSection label="Webhook setup" initialOpen={webhookNeedsAttention}>
        <ProfileTreeRow
          label="API key + region"
          icon={<Globe className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          expandedContent={
            <p className="text-muted-foreground">
              Create a key in the Recall.ai dashboard. Keys are region-specific. Set <code>RECALL_REGION</code>
              {" "}to the region shown in your dashboard URL: us-east-1, us-west-2, eu-central-1, or ap-northeast-1.
            </p>
          }
        >
          <span className="text-muted-foreground">{recallStatus?.region ?? "Required"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Status webhook"
          icon={webhookReady
            ? <CheckCircle2 className="h-3.5 w-3.5 text-active" />
            : <AlertTriangle className="h-3.5 w-3.5 text-warning" />}
          hasValue
          showEmpty
          expandedContentClassName="min-w-0 space-y-2"
          defaultOpen={webhookNeedsAttention}
          expandedContent={
            <>
              <p className="text-muted-foreground">
                In the Recall dashboard for this region, open <strong>Webhooks</strong>, choose <strong>Add Endpoint</strong>, and add:
              </p>
              <code className="block min-w-0 break-all rounded bg-muted p-2 text-xs">
                {recallStatus?.statusWebhookUrl ?? `${window.location.origin}/api/webhooks/recall`}
              </code>
              <p className="text-muted-foreground">
                Subscribe to all <code>bot.*</code> status events, especially joining, waiting room, in-call recording,
                call ended, done, and fatal. Save this endpoint's Svix signing secret as <code>RECALL_WEBHOOK_SECRET</code>.
                Separately save the workspace verification secret from <strong>Developers → API Keys & Secrets</strong> as
                <code>RECALL_WORKSPACE_VERIFICATION_SECRET</code>. Recall uses it for per-bot real-time transcript endpoints.
                Legacy workspaces require both secrets; they are not interchangeable.
              </p>
            </>
          }
        >
          <span className={webhookReady ? "text-active" : "text-warning"}>
            {webhookReady ? "Configured" : "Required"}
          </span>
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}


interface TwilioStatus {
  connected: boolean;
  hasAccountSid?: boolean;
  hasAuthToken?: boolean;
  hasPhoneNumber?: boolean;
  configuredPhoneNumber?: string | null;
  configuredNumberOwned?: boolean;
  accountName?: string;
  accountStatus?: string;
  ownedNumbers?: Array<{ sid: string; phoneNumber: string; friendlyName: string }>;
  voiceWebhookUrl?: string;
  voiceProvider?: string;
  servingHost?: string | null;
  publicUrl?: string | null;
  error?: string;
}

interface DeepgramStatus {
  connected: boolean;
  hasApiKey?: boolean;
  projectCount?: number;
  error?: string;
}

function ProviderConnectionRow({ provider, connected, error, pending, onTest }: {
  provider: string;
  connected: boolean;
  error?: string;
  pending: boolean;
  onTest: () => void;
}) {
  return (
    <ProfileTreeRow
      label="Connection"
      icon={connected ? <CheckCircle2 className="h-3.5 w-3.5 text-active" /> : <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
      hasValue
      showEmpty
      expandedContent={error ? <p className="text-destructive">{error}</p> : undefined}
    >
      <Button variant="outline" size="sm" onClick={onTest} disabled={pending} data-testid={`button-${provider}-test-connection`}>
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : connected ? "Test again" : "Test connection"}
      </Button>
    </ProfileTreeRow>
  );
}

function TwilioDetail() {
  const { toast } = useToast();
  const { data: status, isLoading } = useQuery<TwilioStatus>({ queryKey: ["/api/integrations/twilio/status"], refetchInterval: false });
  const test = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/integrations/twilio/test")).json() as Promise<TwilioStatus>,
    onSuccess: (result) => {
      queryClient.setQueryData(["/api/integrations/twilio/status"], result);
      toast({ title: result.connected ? "Twilio connected" : "Twilio connection failed", description: result.connected ? `${result.ownedNumbers?.length ?? 0} owned number(s) found.` : result.error, variant: result.connected ? "default" : "destructive" });
    },
    onError: (error: Error) => toast({ title: "Twilio connection test failed", description: error.message, variant: "destructive" }),
  });
  const credentialsReady = Boolean(status?.hasAccountSid && status?.hasAuthToken && status?.hasPhoneNumber);
  return (
    <div className="min-w-0 space-y-2">
      <IntegrationTreeSection label="Connection" initialOpen={!status?.connected}>
        <ProviderConnectionRow provider="twilio" connected={Boolean(status?.connected)} error={status?.error} pending={test.isPending} onTest={() => test.mutate()} />
        <ProfileTreeRow label="Account" icon={<Phone className="h-3.5 w-3.5" />} hasValue showEmpty>{isLoading ? <Skeleton className="h-4 w-24" /> : <span className="text-muted-foreground">{status?.accountName || status?.accountStatus || "Not verified"}</span>}</ProfileTreeRow>
      </IntegrationTreeSection>
      <IntegrationTreeSection label="Credentials" initialOpen={!credentialsReady}><div className="min-w-0 px-2 py-1.5"><SecretsForSection section="twilio" /></div></IntegrationTreeSection>
      <IntegrationTreeSection label="Owned numbers" initialOpen={Boolean(status?.connected && !status.configuredNumberOwned)}>
        {(status?.ownedNumbers ?? []).length ? (status?.ownedNumbers ?? []).map((number) => <ProfileTreeRow key={number.sid} label={number.friendlyName} icon={<Phone className="h-3.5 w-3.5" />} hasValue showEmpty><span className={number.phoneNumber === status?.configuredPhoneNumber ? "text-active" : "text-muted-foreground"}>{number.phoneNumber}{number.phoneNumber === status?.configuredPhoneNumber ? " · selected" : ""}</span></ProfileTreeRow>) : <p className="px-2 py-1.5 text-sm text-muted-foreground">No owned numbers found.</p>}
      </IntegrationTreeSection>
      <IntegrationTreeSection label="Phone endpoints">
        <ProfileTreeRow label="Voice webhook" icon={<Globe className="h-3.5 w-3.5" />} hasValue showEmpty><code className="break-all text-xs">{status?.voiceWebhookUrl ?? "Available after setup"}</code></ProfileTreeRow>
        <ProfileTreeRow label="Voice provider" icon={<Radio className="h-3.5 w-3.5" />} hasValue showEmpty><span className="text-sm text-muted-foreground">{status?.voiceProvider ?? "ElevenLabs register-call"}</span></ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}

function DeepgramDetail() {
  const { toast } = useToast();
  const { data: status } = useQuery<DeepgramStatus>({ queryKey: ["/api/integrations/deepgram/status"], refetchInterval: false });
  const test = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/integrations/deepgram/test")).json() as Promise<DeepgramStatus>,
    onSuccess: (result) => { queryClient.setQueryData(["/api/integrations/deepgram/status"], result); toast({ title: result.connected ? "Deepgram connected" : "Deepgram connection failed", description: result.connected ? "Nova-3 streaming credentials verified." : result.error, variant: result.connected ? "default" : "destructive" }); },
    onError: (error: Error) => toast({ title: "Deepgram connection test failed", description: error.message, variant: "destructive" }),
  });
  return <div className="min-w-0 space-y-2"><IntegrationTreeSection label="Connection" initialOpen={!status?.connected}><ProviderConnectionRow provider="deepgram" connected={Boolean(status?.connected)} error={status?.error} pending={test.isPending} onTest={() => test.mutate()} /></IntegrationTreeSection></div>;
}

type SentryAvailabilityStatus =
  | { status: "not_configured"; configured: false; crashReportingConfigured: false; missing: string[] }
  | { status: "monitor_pending"; configured: true; crashReportingConfigured: true; checkCount: number; expectedChecks: number; coverage: number; periodStart: string; periodEnd: string }
  | { status: "ready"; configured: true; crashReportingConfigured: true; checkCount: number; expectedChecks: number; coverage: number; availability: number; failureRate: number; periodStart: string; periodEnd: string }
  | { status: "unavailable"; configured: true; crashReportingConfigured: true; error: string };

function SentryDetail() {
  const { toast } = useToast();
  const { data: secretsStatus, isLoading: secretsLoading } = useQuery<Record<string, any>>({
    queryKey: ["/api/setup/secrets-status"],
  });
  const crashReady = Boolean(secretsStatus?.sentry);
  const { data: status, isLoading } = useQuery<SentryAvailabilityStatus>({
    queryKey: ["/api/integrations/sentry/status"],
    refetchInterval: false,
  });
  const sync = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/integrations/sentry/sync-availability")).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/sentry/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/business/metrics"] });
      toast({ title: "Availability synced", description: "The completed day is now in Metrics." });
    },
    onError: (error: Error) => toast({ title: "Availability not synced", description: error.message, variant: "destructive" }),
  });
  const crashValue = secretsLoading
    ? <Skeleton className="h-4 w-28" />
    : crashReady
      ? <span className="text-active">One setup arms all surfaces</span>
      : <span className="text-muted-foreground">Needs DSN + API credentials</span>;
  const uptimeValue = isLoading
    ? <Skeleton className="h-4 w-28" />
    : status?.status === "ready"
      ? <span className="text-active">{status.availability.toFixed(3)}% · {status.checkCount} checks</span>
      : status?.status === "monitor_pending"
        ? <span className="text-foreground">Waiting for a complete day · {status.checkCount}/{status.expectedChecks}</span>
        : status?.status === "unavailable"
          ? <span className="text-error">{status.error}</span>
          : !crashReady && !secretsLoading
            ? <span className="text-muted-foreground">Add DSN + API credentials once</span>
            : <span className="text-muted-foreground">Uptime status is unavailable</span>;

  return (
    <div className="min-w-0 space-y-2">
      <IntegrationTreeSection label="Crash reporting" initialOpen={!crashReady} testIdPrefix="sentry">
        <ProfileTreeRow label="Web · Mobile · Server" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
          {crashValue}
        </ProfileTreeRow>
        <div className="min-w-0 px-2 py-1.5"><SecretsForSection section="sentry" /></div>
      </IntegrationTreeSection>
      <IntegrationTreeSection label="Uptime" initialOpen={status?.status !== "ready"} testIdPrefix="sentry">
        <ProfileTreeRow
          label="Service availability"
          icon={<Activity className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          valueLayout="compact"
          menuContent={status?.status === "ready" ? <DropdownMenuItem onSelect={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? "Syncing…" : "Sync completed day"}</DropdownMenuItem> : undefined}
        >
          {uptimeValue}
        </ProfileTreeRow>
        <ProfileTreeRow label="Monitor target" icon={<Globe className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
          <code className="text-xs text-muted-foreground">https://app.trymantra.ai/api/health</code>
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}

function ExpoDetail() {
  const { toast } = useToast();
  const { data: secretsStatus } = useQuery<Record<string, any>>({
    queryKey: ["/api/setup/secrets-status"],
  });

  const { data: expoStatus, isLoading: statusLoading } = useQuery<ExpoStatus>({
    queryKey: ["/api/integrations/expo/status"],
    refetchInterval: false,
  });

  const { data: projectConfig } = useQuery<ExpoProjectConfig>({
    queryKey: ["/api/integrations/expo/project-config"],
    enabled: !!expoStatus?.connected,
  });

  const { data: buildLogData } = useQuery<{ run: ExpoBuildLogRun | null }>({
    queryKey: ["/api/integrations/expo/build-log"],
    enabled: !!expoStatus?.connected,
    refetchInterval: 5000,
  });

  const { data: appleCredentials } = useQuery<ExpoAppleCredentialsConfig>({
    queryKey: ["/api/integrations/expo/apple-credentials"],
    enabled: !!expoStatus?.connected,
  });

  const [appleIdEmail, setAppleIdEmail] = useState("");
  const [teamId, setTeamId] = useState("");
  const [bundleIdentifier, setBundleIdentifier] = useState("");
  const [easPromptReply, setEasPromptReply] = useState("");
  const [credentialsWizardOpen, setCredentialsWizardOpen] = useState(false);
  const [showEasLog, setShowEasLog] = useState(false);

  useEffect(() => {
    if (!appleCredentials) return;
    setAppleIdEmail(appleCredentials.appleIdEmail || "");
    setTeamId(appleCredentials.teamId || "");
    setBundleIdentifier(appleCredentials.bundleIdentifier || "");
  }, [appleCredentials]);

  const saveAppleCredentialsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/integrations/expo/apple-credentials", {
        appleIdEmail,
        teamId,
        bundleIdentifier,
      });
      return res.json() as Promise<ExpoAppleCredentialsConfig>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/expo/apple-credentials"] });
      toast({ title: "Apple setup requirements saved", description: "Start the guided EAS setup when ready." });
    },
    onError: (err: Error) => toast({ title: "Could not save Apple settings", description: err.message, variant: "destructive" }),
  });

  const setupAppleCredentialsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/expo/apple-credentials/setup", {});
      return res.json() as Promise<{ run: ExpoBuildLogRun }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/expo/build-log"] });
      toast({ title: "Interactive EAS setup started", description: "Answer the Apple/EAS prompt in the setup wizard." });
    },
    onError: (err: Error) => toast({ title: "Credential setup failed", description: err.message, variant: "destructive" }),
  });

  const sendEasInputMutation = useMutation({
    mutationFn: async (input?: string) => {
      const res = await apiRequest("POST", "/api/integrations/expo/apple-credentials/input", { input: input ?? easPromptReply });
      return res.json() as Promise<{ run: ExpoBuildLogRun }>;
    },
    onSuccess: () => {
      setEasPromptReply("");
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/expo/build-log"] });
    },
    onError: (err: Error) => toast({ title: "Could not send response", description: err.message, variant: "destructive" }),
  });

  const cancelEasSetupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/expo/apple-credentials/cancel", {});
      return res.json() as Promise<{ run: ExpoBuildLogRun }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/expo/build-log"] });
      toast({ title: "Interactive EAS setup cancelled" });
    },
    onError: (err: Error) => toast({ title: "Could not cancel setup", description: err.message, variant: "destructive" }),
  });

  const buildMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/expo/build", { profile: "preview", platform: "ios" });
      return res.json() as Promise<{ ok: boolean; guidance?: string; stderr?: string; error?: string; stdout?: string }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/expo/build-log"] });
      if (result.ok) {
        toast({ title: "Mobile build started", description: "EAS accepted the iOS standalone preview build." });
      } else {
        const message = result.guidance || result.stderr || result.error || result.stdout || "EAS build failed.";
        toast({ title: "Credential setup required", description: message.slice(0, 300), variant: "destructive" });
      }
    },
    onError: (err: Error) => toast({ title: "Build failed", description: err.message, variant: "destructive" }),
  });

  const elevenlabsReady = !!secretsStatus?.elevenlabs;
  const credentialsHref = expoCredentialsUrl(projectConfig);
  const appleSettingsReady = Boolean(appleIdEmail.trim() && teamId.trim() && bundleIdentifier.trim());
  const activeInteractiveEasRun = buildLogData?.run?.interactive && buildLogData.run.status === "running";
  const easLogs = buildLogData?.run?.logs || [];
  const easPromptView = parseEasPromptView(easLogs);
  const currentEasPrompt = easPromptView?.prompt;
  const sendEasChoice = (optionIndex: number) => {
    const selectedIndex = easPromptView?.selectedIndex ?? 0;
    sendEasInputMutation.mutate(easSelectionInput(selectedIndex, optionIndex));
  };
  const easRunStatus = buildLogData?.run?.status || "idle";
  const appleCredentialsConfigured = Boolean(appleCredentials?.configured);
  const appleCredentialStatus = activeInteractiveEasRun
    ? "Running"
    : easRunStatus === "success"
      ? "Configured"
      : easRunStatus === "failed"
        ? "Needs retry"
        : appleCredentialsConfigured
          ? "Ready to set up"
          : "Needs setup";

  return (
    <div className="min-w-0 space-y-0">
      <div data-testid="card-expo-token">
        <IntegrationTreeSection label="Expo Access Token" initialOpen icon={<Smartphone className="h-3.5 w-3.5" />} testIdPrefix="expo-token">
          <ProfileTreeRow label="Credentials" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="text-muted-foreground">Manage on Secrets</span>
          </ProfileTreeRow>
        </IntegrationTreeSection>
      </div>

      <div data-testid="card-expo-account">
        <IntegrationTreeSection label="Account" initialOpen icon={<CheckCircle2 className="h-3.5 w-3.5" />} testIdPrefix="expo-account">
          {statusLoading ? (
            <ProfileTreeRow label="Status" icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />} hasValue showEmpty>
              <span className="text-muted-foreground">Loading</span>
            </ProfileTreeRow>
          ) : expoStatus?.connected ? (
            <>
              <ProfileTreeRow label="Status" icon={<CheckCircle2 className="h-3.5 w-3.5 text-success" />} hasValue showEmpty>
                <span>Connected as @{expoStatus.username}</span>
              </ProfileTreeRow>
              <ProfileTreeRow label="Account" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
                <span className="truncate">{expoStatus.accountName}</span>
              </ProfileTreeRow>
              <ProfileTreeRow label="Organizations" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
                <span>{expoStatus.accounts?.length || 1}</span>
              </ProfileTreeRow>
            </>
          ) : (
            <ProfileTreeRow label="Status" icon={<XCircle className="h-3.5 w-3.5" />} hasValue showEmpty>
              <span className="text-muted-foreground">{expoStatus?.error || "Not connected"}</span>
            </ProfileTreeRow>
          )}
        </IntegrationTreeSection>
      </div>

      <div data-testid="card-expo-app-configuration">
        <IntegrationTreeSection label="App Configuration" initialOpen icon={<Smartphone className="h-3.5 w-3.5" />} testIdPrefix="expo-app">
          <ProfileTreeRow label="Bundle ID" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="font-mono">com.oniops.firstglasses</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Deep Link" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="font-mono">agentglasses://</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Framework" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span>Expo ~52 + Router</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Voice SDK" icon={<Volume2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span>ElevenLabs RN</span>
          </ProfileTreeRow>
        </IntegrationTreeSection>
      </div>

      <div data-testid="card-expo-apple-credentials">
        <IntegrationTreeSection
          label="Apple Signing"
          initialOpen
          icon={<Smartphone className="h-3.5 w-3.5" />}
          testIdPrefix="expo-apple"
          actions={(
            <Button
              size="sm"
              variant="outline"
              className="mr-2"
              onClick={() => setCredentialsWizardOpen(true)}
              disabled={!expoStatus?.connected || !projectConfig?.configured}
              data-testid="button-expo-open-credentials-wizard"
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              {activeInteractiveEasRun ? "Continue" : appleCredentialsConfigured ? "Set up" : "Start"}
            </Button>
          )}
        >
          <ProfileTreeRow label="Status" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span data-testid="badge-expo-apple-credentials">{appleCredentialStatus}</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Bundle" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span>{appleCredentials?.bundleIdentifier || "Not set"}</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Apple Team" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span>{appleCredentials?.teamId || "Not set"}</span>
          </ProfileTreeRow>
          <ProfileTreeRow label="Last EAS run" icon={<Smartphone className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span className="capitalize">{easRunStatus}</span>
          </ProfileTreeRow>
        </IntegrationTreeSection>
      </div>

      <Dialog open={credentialsWizardOpen} onOpenChange={setCredentialsWizardOpen}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto" data-testid="dialog-expo-eas-credentials">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>Set up Apple signing</DialogTitle>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>Agent runs EAS on Railway. You answer only the prompts Apple or Expo require.</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid gap-2 sm:grid-cols-3 text-sm">
              {[
                { label: "Requirements", active: !appleCredentialsConfigured, done: appleCredentialsConfigured },
                { label: "EAS setup", active: appleCredentialsConfigured && easRunStatus !== "success", done: easRunStatus === "success" },
                { label: "Ready", active: easRunStatus === "success", done: easRunStatus === "success" },
              ].map((step, index) => (
                <div key={step.label} className={cn(
                  "rounded-md border p-3",
                  step.active && "border-primary/40 bg-primary/5",
                  step.done && "border-green-500/30 bg-green-500/10"
                )}>
                  <div className="flex items-center gap-2">
                    {step.done ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <span className="flex h-5 w-5 items-center justify-center rounded-full border text-xs">{index + 1}</span>}
                    <span className="font-medium">{step.label}</span>
                  </div>
                </div>
              ))}
            </div>

            {!appleCredentialsConfigured && (
              <div className="space-y-4 rounded-md border p-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">Setup requirements</h3>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>Saved in Agent, not chat.</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="expo-wizard-apple-id-email">Apple ID email</Label>
                    <Input
                      id="expo-wizard-apple-id-email"
                      value={appleIdEmail}
                      onChange={(event) => setAppleIdEmail(event.target.value)}
                      placeholder="ray@example.com"
                      autoComplete="off"
                      data-testid="input-expo-apple-id-email"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="expo-wizard-team-id">Apple Team ID</Label>
                    <Input
                      id="expo-wizard-team-id"
                      value={teamId}
                      onChange={(event) => setTeamId(event.target.value.toUpperCase())}
                      placeholder="ABCDE12345"
                      autoComplete="off"
                      data-testid="input-expo-apple-team-id"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="expo-wizard-bundle-id">Bundle identifier</Label>
                    <Input
                      id="expo-wizard-bundle-id"
                      value={bundleIdentifier}
                      onChange={(event) => setBundleIdentifier(event.target.value)}
                      placeholder="com.oniops.firstglasses"
                      autoComplete="off"
                      data-testid="input-expo-bundle-identifier"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => saveAppleCredentialsMutation.mutate()}
                    disabled={!appleSettingsReady || saveAppleCredentialsMutation.isPending}
                    data-testid="button-expo-save-apple-settings"
                  >
                    {saveAppleCredentialsMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    Save requirements
                  </Button>
                </div>
              </div>
            )}

            {appleCredentialsConfigured && easRunStatus !== "success" && (
              <div className="space-y-4 rounded-md border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">Interactive EAS setup</h3>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>EAS creates or selects Apple certificates and provisioning profiles.</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Badge variant="outline" className="font-mono text-xs">{appleCredentials?.bundleIdentifier}</Badge>
                  </div>
                  <Badge variant={activeInteractiveEasRun ? "default" : easRunStatus === "failed" ? "destructive" : "secondary"}>
                    {activeInteractiveEasRun ? "Running" : easRunStatus === "failed" ? "Stopped" : "Ready"}
                  </Badge>
                </div>

                {activeInteractiveEasRun ? (
                  <div className="space-y-3">
                    <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="panel-expo-current-eas-prompt">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">Current prompt</p>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpCircle className="h-4 w-4 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent>Open the technical log only if you need exact terminal output. Responses are not echoed.</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap font-mono text-xs">{currentEasPrompt || "Waiting for EAS…"}</p>
                    </div>
                    {easPromptView?.yesNo ? (
                      <div className="flex flex-wrap gap-2" data-testid="controls-expo-eas-yes-no">
                        <Button
                          onClick={() => sendEasInputMutation.mutate("y")}
                          disabled={sendEasInputMutation.isPending}
                          data-testid="button-expo-eas-answer-yes"
                        >
                          Yes
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => sendEasInputMutation.mutate("n")}
                          disabled={sendEasInputMutation.isPending}
                          data-testid="button-expo-eas-answer-no"
                        >
                          No
                        </Button>
                      </div>
                    ) : easPromptView && easPromptView.options.length > 0 ? (
                      <div className="grid gap-2" data-testid="controls-expo-eas-choice-list">
                        {easPromptView.options.map((option, index) => (
                          <Button
                            key={`${option.label}-${index}`}
                            variant={option.selected ? "default" : "outline"}
                            className="justify-start text-left"
                            onClick={() => sendEasChoice(index)}
                            disabled={sendEasInputMutation.isPending}
                            data-testid={`button-expo-eas-choice-${index}`}
                          >
                            {option.selected ? <Check className="h-4 w-4 mr-2" /> : <Circle className="h-4 w-4 mr-2" />}
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={easPromptReply}
                          onChange={(event) => setEasPromptReply(event.target.value)}
                          placeholder="Type response to current prompt"
                          autoComplete="off"
                          data-testid="input-expo-eas-prompt-reply"
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && easPromptReply.length > 0 && !sendEasInputMutation.isPending) {
                              sendEasInputMutation.mutate(undefined);
                            }
                          }}
                        />
                        <Button
                          onClick={() => sendEasInputMutation.mutate(undefined)}
                          disabled={easPromptReply.length === 0 || sendEasInputMutation.isPending}
                          data-testid="button-expo-send-eas-input"
                        >
                          {sendEasInputMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowRight className="h-4 w-4 mr-2" />}
                          Send response
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex justify-end gap-2">
                    <Button
                      onClick={() => setupAppleCredentialsMutation.mutate()}
                      disabled={setupAppleCredentialsMutation.isPending}
                      data-testid="button-expo-setup-apple-credentials"
                    >
                      {setupAppleCredentialsMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                      {easRunStatus === "failed" ? "Retry EAS setup" : "Start EAS setup"}
                    </Button>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <Button size="sm" variant="ghost" onClick={() => setShowEasLog((value) => !value)} data-testid="button-expo-toggle-eas-log">
                    {showEasLog ? <EyeOff className="h-3.5 w-3.5 mr-1.5" /> : <Eye className="h-3.5 w-3.5 mr-1.5" />}
                    {showEasLog ? "Hide technical log" : "Show technical log"}
                  </Button>
                  <div className="flex gap-2">
                    {activeInteractiveEasRun && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelEasSetupMutation.mutate()}
                        disabled={cancelEasSetupMutation.isPending}
                        data-testid="button-expo-cancel-eas-setup"
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => window.open(credentialsHref, "_blank", "noopener,noreferrer")}
                      data-testid="button-expo-open-credentials"
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      Expo dashboard
                    </Button>
                  </div>
                </div>

                {showEasLog && (
                  <div className="max-h-72 overflow-auto rounded bg-background p-3 font-mono text-xs" data-testid="log-expo-eas-interactive">
                    {easLogs.length === 0 ? (
                      <p className="text-muted-foreground">No EAS output yet.</p>
                    ) : (
                      easLogs.slice(-140).map((entry, index) => (
                        <div key={`${entry.timestamp}-${index}`} className={cn(
                          "whitespace-pre-wrap break-words",
                          entry.stream === "stderr" && "text-destructive",
                          entry.stream === "system" && "text-amber-600 dark:text-amber-300"
                        )}>
                          <span className="text-muted-foreground">[{entry.stream}] </span>{entry.message}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {easRunStatus === "success" && (
              <div className="space-y-4 rounded-md border border-green-500/30 bg-green-500/10 p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5" />
                  <h3 className="text-sm font-semibold">Apple signing is ready</h3>
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setCredentialsWizardOpen(false)} data-testid="button-expo-close-credentials-wizard">Done</Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <div data-testid="card-expo-dependencies">
        <IntegrationTreeSection label="Dependencies" initialOpen icon={<Volume2 className="h-3.5 w-3.5" />} testIdPrefix="expo-deps">
          <ProfileTreeRow label="ElevenLabs Agent" icon={<Volume2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <span data-testid="badge-expo-elevenlabs">{elevenlabsReady ? "Ready" : "Not configured"}</span>
          </ProfileTreeRow>
        </IntegrationTreeSection>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration Tree
// ---------------------------------------------------------------------------

type IntegrationStatus = ReturnType<typeof resolveStatus>;

const INTEGRATION_STATUS_PRESENTATION: Record<
  IntegrationStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  ready: { label: "Ready", icon: CheckCircle2, className: "text-success" },
  error: { label: "Error", icon: XCircle, className: "text-destructive" },
  connect: { label: "Connect", icon: Circle, className: "text-muted-foreground" },
};

interface IntegrationTreeProps {
  status: Record<string, any> | undefined;
}

interface IntegrationSectionProps {
  title: string;
  integrations: ResolvedIntegrationCard[];
  status: Record<string, any> | undefined;
  hasQuery: boolean;
  onOpen: (route: string) => void;
  sectionTestId: string;
}

function IntegrationSection({
  title,
  integrations,
  status,
  hasQuery,
  onOpen,
  sectionTestId,
}: IntegrationSectionProps) {
  const [sectionOpen, setSectionOpen] = useState(true);
  const isOpen = hasQuery || sectionOpen;

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(open) => {
        if (!hasQuery) setSectionOpen(open);
      }}
    >
      <CollapsibleTrigger
        className={cn(
          HIERARCHY_SECTION_HEADER_CLASS,
          "min-h-11 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:min-h-0",
        )}
        data-testid={sectionTestId}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
          aria-hidden="true"
        />
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5">
        {integrations.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            No matching integrations.
          </div>
        ) : (
          integrations.map((integration) => {
            const integrationStatus = resolveStatus(integration, status);
            const statusPresentation = INTEGRATION_STATUS_PRESENTATION[integrationStatus];
            const Icon = integrationIcon(integration.iconKey);
            const StatusIcon = statusPresentation.icon;
            const route = integration.route ?? integration.connectorKey;

            return (
              <button
                key={integration.id}
                type="button"
                className={cn(
                  HIERARCHY_SESSION_ROW_CLASS,
                  "min-h-11 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:min-h-0",
                )}
                onClick={() => onOpen(route)}
                data-testid={`row-integration-${integration.connectorKey}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{integration.label}</span>
                <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-xs", statusPresentation.className)}>
                  <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {statusPresentation.label}
                </span>
              </button>
            );
          })
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function IntegrationTree({ status }: IntegrationTreeProps) {
  const [, setLocation] = useLocation();
  const { data: composition } = useProductComposition();
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLowerCase();
  const hasQuery = normalizedSearch.length > 0;

  const { userIntegrations, systemIntegrations, hasSystem } = useMemo(() => {
    const listed = (composition?.integrations ?? []).filter((integration) => integration.route);
    const matches = listed.filter((integration) =>
      integration.label.toLowerCase().includes(normalizedSearch),
    );
    return {
      userIntegrations: matches.filter((integration) => integration.audience === "primary"),
      systemIntegrations: matches.filter((integration) => integration.audience !== "primary"),
      hasSystem: listed.some((integration) => integration.audience !== "primary"),
    };
  }, [composition?.integrations, normalizedSearch]);

  const openIntegration = (route: string) => setLocation(`/integrations/${route}`);

  return (
    <div className="w-full min-w-0">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <div className="[&_input]:h-11 [&_input]:pr-12 md:[&_input]:h-7 md:[&_input]:pr-7 [&_button]:h-11 [&_button]:w-11 md:[&_button]:h-4 md:[&_button]:w-4 [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-1 [&_button]:focus-visible:ring-ring">
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-integrations-search"
            clearTestId="button-integrations-search-clear"
            ariaLabel="Search integrations"
          />
        </div>

        <IntegrationSection
          title="Connectors"
          integrations={userIntegrations}
          status={status}
          hasQuery={hasQuery}
          onOpen={openIntegration}
          sectionTestId="button-integrations-section-connectors"
        />

        {hasSystem && (
          <IntegrationSection
            title="System"
            integrations={systemIntegrations}
            status={status}
            hasQuery={hasQuery}
            onOpen={openIntegration}
            sectionTestId="button-integrations-section-system"
          />
        )}
      </div>
    </div>
  );
}



// ---------------------------------------------------------------------------
// Meta detail
// ---------------------------------------------------------------------------

interface MetaWearablesConfig {
  enabled: boolean;
  developerMode: boolean;
  bundleId: string;
  universalLink: string;
  applicationIdConfigured: boolean;
  applicationIdLast4: string | null;
  mwdatConfigured: boolean;
  applicationId: string;
  mwdatPlistEntry: string;
  releaseChannel: string;
  notes: string;
}

function MetaDetail() {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Partial<MetaWearablesConfig>>({});

  const { data, isLoading } = useQuery<MetaWearablesConfig>({
    queryKey: ["/api/integrations/meta/wearables"],
  });

  useEffect(() => {
    if (data) {
      setDraft({
        enabled: data.enabled,
        developerMode: data.developerMode,
        bundleId: data.bundleId,
        universalLink: data.universalLink,
        applicationId: "",
        mwdatPlistEntry: "",
        releaseChannel: data.releaseChannel,
        notes: data.notes,
      });
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (body: Partial<MetaWearablesConfig>) => {
      const res = await apiRequest("PUT", "/api/integrations/meta/wearables", body);
      return res.json() as Promise<MetaWearablesConfig>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/meta/wearables"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "Meta Wearables saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const updateDraft = <K extends keyof MetaWearablesConfig>(key: K, value: MetaWearablesConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const developerMode = draft.developerMode !== false;

  return (
    <div className="min-w-0 space-y-2" data-testid="card-meta-wearables">
      <IntegrationTreeSection label="Device Access" initialOpen icon={<Glasses className="h-3.5 w-3.5" />} testIdPrefix="meta-wearables">
        <ProfileTreeRow
          label="Status"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="badge-meta-wearables-status"
          actionContent={(
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate(draft)}
              disabled={saveMutation.isPending}
              data-testid="button-save-meta-wearables"
            >
              {saveMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          )}
        >
          {data.enabled ? "Configured" : "Draft"}
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Enabled"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-enabled"
        >
          <Checkbox
            checked={!!draft.enabled}
            onCheckedChange={(checked) => updateDraft("enabled", checked === true)}
            data-testid="checkbox-meta-enabled"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Developer Mode"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-developer-mode"
        >
          <Checkbox
            checked={developerMode}
            onCheckedChange={(checked) => updateDraft("developerMode", checked === true)}
            data-testid="checkbox-meta-developer-mode"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Bundle ID"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-bundle-id"
        >
          <Input
            id="input-meta-bundle-id"
            value={draft.bundleId ?? ""}
            onChange={(e) => updateDraft("bundleId", e.target.value)}
            className="h-7 font-mono text-xs"
            data-testid="input-meta-bundle-id"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Universal Link"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-universal-link"
        >
          <Input
            id="input-meta-universal-link"
            value={draft.universalLink ?? ""}
            onChange={(e) => updateDraft("universalLink", e.target.value)}
            className="h-7 font-mono text-xs"
            data-testid="input-meta-universal-link"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Release Channel"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-release-channel"
        >
          <Input
            id="input-meta-release-channel"
            value={draft.releaseChannel ?? ""}
            onChange={(e) => updateDraft("releaseChannel", e.target.value)}
            className="h-7 text-xs"
            data-testid="input-meta-release-channel"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Application ID"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-application-id"
        >
          <Input
            id="input-meta-application-id"
            type="password"
            value={draft.applicationId ?? ""}
            onChange={(e) => updateDraft("applicationId", e.target.value)}
            placeholder={data.applicationIdConfigured ? `Already saved ••••${data.applicationIdLast4 ?? ""}` : "Paste Meta Application ID"}
            className="h-7 font-mono text-xs"
            data-testid="input-meta-application-id"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="MWDAT"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-mwdat"
        >
          <Textarea
            id="textarea-meta-mwdat"
            value={draft.mwdatPlistEntry ?? ""}
            onChange={(e) => updateDraft("mwdatPlistEntry", e.target.value)}
            placeholder={data.mwdatConfigured ? "Already saved. Paste a new value only if rotating." : "Paste the MWDAT plist block from Meta"}
            className="min-h-24 font-mono text-xs"
            data-testid="textarea-meta-mwdat"
          />
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Notes"
          icon={<Glasses className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-meta-notes"
        >
          <Textarea
            id="textarea-meta-notes"
            value={draft.notes ?? ""}
            onChange={(e) => updateDraft("notes", e.target.value)}
            placeholder="Camera access rationale, org/app notes, tester/channel details"
            className="min-h-16 text-xs"
            data-testid="textarea-meta-notes"
          />
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Oura Ring detail
// ---------------------------------------------------------------------------

interface OuraWebhookStatus {
  subscriptions?: Array<{
    id: string;
    callbackUrl: string;
    eventType: string;
    dataType: string;
    expirationTime: string;
  }>;
  lastSubscriptionAttemptAt?: string;
  lastSubscriptionSuccessAt?: string;
  lastSubscriptionError?: string | null;
  lastNotificationAt?: string;
  lastNotificationDataType?: string;
  lastNotificationEventType?: string;
  lastNotificationAccepted?: boolean;
  lastNotificationError?: string | null;
}

interface OuraSyncStatus {
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastSyncMode?: string;
  lastSyncStartDate?: string;
  lastSyncEndDate?: string;
  lastSyncInserted?: number;
  lastSyncMetricRows?: number;
  lastSyncCompletionsLogged?: number;
  lastSyncCompletionsUpgraded?: number;
  lastSyncError?: string | null;
}

interface OuraAccountStatus {
  accountId: string;
  provider: string;
  email?: string | null;
  label?: string | null;
  healthy?: boolean;
  healthError?: string | null;
  healthCheckedAt?: string | null;
  missingScopes?: string[] | null;
  addedAt?: string;
  updatedAt?: string;
  scopes?: string[];
  sync?: OuraSyncStatus | null;
  webhooks?: OuraWebhookStatus | null;
  warnings?: string[];
}

interface OuraStatus {
  connected: boolean;
  oauthConfigured?: boolean;
  webhookConfigured?: boolean;
  account?: OuraAccountStatus | null;
  accounts?: number;
  warnings?: string[];
  error?: string;
}

function formatOuraDateTime(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatOuraNumber(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

function OuraStatusBadge({ status }: { status: OuraStatus | undefined }) {
  if (!status?.oauthConfigured) {
    return <Badge variant="secondary" data-testid="badge-oura-credentials">Credentials needed</Badge>;
  }
  if (!status.connected) {
    return <Badge variant="secondary" data-testid="badge-oura-connection">Ready to connect</Badge>;
  }
  if (status.account?.healthy === false) {
    return <Badge variant="destructive" data-testid="badge-oura-health">Needs attention</Badge>;
  }
  if ((status.warnings?.length || 0) > 0 || (status.account?.warnings?.length || 0) > 0) {
    return <Badge variant="outline" className="border-warning/40 text-warning-foreground" data-testid="badge-oura-warning">Connected with warning</Badge>;
  }
  return <Badge className="bg-success/15 text-success-foreground border-success/30" data-testid="badge-oura-health">Healthy</Badge>;
}

function OuraDetail() {
  const { toast } = useToast();
  const { data: status, isLoading } = useQuery<OuraStatus>({
    queryKey: ["/api/oura/status"],
    refetchInterval: 30000,
  });

  const connectMutation = useMutation({
    mutationFn: async (popup: Window) => {
      const res = await fetch("/api/oura/oauth/start");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start Oura OAuth");
      popup.location.replace((data as { url: string }).url);
    },
    onError: (err: Error, popup) => {
      popup.close();
      toast({ title: "Failed to start Oura connection", description: err.message, variant: "destructive" });
    },
  });

  const startOuraOAuth = useCallback(() => {
    const popup = window.open("about:blank", "oura-oauth", "width=600,height=760,scrollbars=yes");
    if (!popup) {
      toast({ title: "Popup blocked", description: "Allow popups and try again.", variant: "destructive" });
      return;
    }
    connectMutation.mutate(popup);
  }, [connectMutation, toast]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; status?: string; message?: string } | null;
      if (!data || data.type !== "mantra:oura-oauth") return;
      await queryClient.refetchQueries({ queryKey: ["/api/oura/status"] });
      if (data.status === "connected") {
        toast({ title: "Oura connected" });
      } else {
        toast({
          title: "Oura connection failed",
          description: data.message || "Please try connecting again.",
          variant: "destructive",
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toast]);

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/oura/sync", { mode: status?.account?.sync?.lastSuccessfulSyncAt ? "incremental" : "initial" });
      return res.json();
    },
    onSuccess: (data: { result?: { inserted?: number; metricRows?: number } }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/oura/status"] });
      toast({
        title: "Oura sync complete",
        description: `${formatOuraNumber(data.result?.metricRows)} rows mapped, ${formatOuraNumber(data.result?.inserted)} inserted.`,
      });
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/oura/status"] });
      toast({ title: "Oura sync failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/oura/disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/oura/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      toast({ title: "Oura disconnected" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to disconnect Oura", description: err.message, variant: "destructive" });
    },
  });

  const account = status?.account;
  const sync = account?.sync || null;
  const webhooks = account?.webhooks || null;
  const scopes = account?.scopes || [];
  const warnings = [...(status?.warnings || []), ...(account?.warnings || [])].filter((v, i, arr) => v && arr.indexOf(v) === i);
  const missingScopes = account?.missingScopes || [];

  return (
    <div className="min-w-0 space-y-2" data-testid="oura-detail">
      <IntegrationTreeSection label="Ring Connection" initialOpen={!status?.connected || warnings.length > 0} testIdPrefix="oura" icon={<HeartPulse className="h-3.5 w-3.5" />}>
        <ProfileTreeRow label="Status" icon={status?.connected && account?.healthy !== false ? <CheckCircle2 className="h-3.5 w-3.5 text-active" /> : <XCircle className="h-3.5 w-3.5 text-muted-foreground" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact" testId="oura-connection-status"><OuraStatusBadge status={status} /></ProfileTreeRow>
        <ProfileTreeRow label="Actions" icon={<HeartPulse className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
          <div className="flex flex-wrap items-center gap-2">
            {status?.connected ? <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} data-testid="button-sync-oura">{syncMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}Sync now</Button> : <Button variant="outline" size="sm" onClick={startOuraOAuth} disabled={!status?.oauthConfigured || connectMutation.isPending} data-testid="button-connect-oura">{connectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plug className="h-3.5 w-3.5 mr-1.5" />}Connect Oura</Button>}
            {status?.connected && <Button variant="ghost" size="sm" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending} data-testid="button-disconnect-oura">{disconnectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}Disconnect</Button>}
          </div>
        </ProfileTreeRow>
        <ProfileTreeRow label="Account" icon={<HeartPulse className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span className="text-muted-foreground">{account?.email || account?.label || (status?.connected ? "Oura Ring" : "Not connected")}</span></ProfileTreeRow>
        <div className="space-y-4">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : !status?.oauthConfigured ? (
            <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/5 p-3" data-testid="oura-credentials-required">
              <AlertTriangle className="h-4 w-4 text-warning-foreground mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Credentials required</p>
                <p className="text-xs text-muted-foreground">Set OURA_CLIENT_ID and OURA_CLIENT_SECRET above. Add OURA_WEBHOOK_VERIFY_TOKEN for automatic updates.</p>
              </div>
            </div>
          ) : !status.connected ? (
            <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3" data-testid="oura-not-connected">
              <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Ready for one-click OAuth</p>
                <p className="text-xs text-muted-foreground">No personal access token. Authorize Oura in the popup, then Agent handles sync and webhook setup.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className={cn("flex items-center justify-between gap-3 rounded-md border p-3", account?.healthy === false ? "border-destructive/40 bg-destructive/5" : "border-success/30 bg-success/5")}>
                <div className="flex items-center gap-2 min-w-0">
                  {account?.healthy === false ? <XCircle className="h-4 w-4 text-destructive shrink-0" /> : <CheckCircle2 className="h-4 w-4 text-success-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" data-testid="text-oura-account-label">{account?.email || account?.label || "Oura Ring"}</p>
                    <p className="text-xs text-muted-foreground">Connected {formatOuraDateTime(account?.addedAt)}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  data-testid="button-disconnect-oura"
                >
                  {disconnectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Disconnect
                </Button>
              </div>

              {account?.healthError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="oura-health-error">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{account.healthError}</span>
                </div>
              )}

              {warnings.length > 0 && (
                <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3" data-testid="oura-warnings">
                  {warnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-2 text-sm">
                      <AlertTriangle className="h-4 w-4 text-warning-foreground mt-0.5 shrink-0" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-3 @md:grid-cols-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Last sync</p>
                  <p className="text-sm font-medium" data-testid="text-oura-last-sync">{formatOuraDateTime(sync?.lastSuccessfulSyncAt || sync?.lastSyncAt)}</p>
                  <p className="text-xs text-muted-foreground">{sync?.lastSyncMode || "not run"}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Rows mapped</p>
                  <p className="text-sm font-medium" data-testid="text-oura-row-count">{formatOuraNumber(sync?.lastSyncMetricRows)}</p>
                  <p className="text-xs text-muted-foreground">{formatOuraNumber(sync?.lastSyncInserted)} inserted</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Completions</p>
                  <p className="text-sm font-medium" data-testid="text-oura-completions">{formatOuraNumber(sync?.lastSyncCompletionsLogged)} logged</p>
                  <p className="text-xs text-muted-foreground">{formatOuraNumber(sync?.lastSyncCompletionsUpgraded)} upgraded</p>
                </div>
              </div>

              {sync?.lastSyncError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="oura-sync-error">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{sync.lastSyncError}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </IntegrationTreeSection>
      {status?.connected && <IntegrationTreeSection label="Scopes" initialOpen={missingScopes.length > 0} testIdPrefix="oura-scopes"><ProfileTreeRow label="Granted" icon={<CheckCircle2 className="h-3.5 w-3.5 text-active" />} hasValue showEmpty expandedContent={<div className="flex flex-wrap gap-2">{scopes.map((scope) => <Badge key={scope} variant="outline" className="font-mono text-xs">{scope}</Badge>)}</div>}><span className="text-muted-foreground">{scopes.length} scopes</span></ProfileTreeRow>{missingScopes.length > 0 && <ProfileTreeRow label="Missing" icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />} hasValue showEmpty><span className="text-warning">{missingScopes.join(", ")}</span></ProfileTreeRow>}</IntegrationTreeSection>}
      {status?.connected && <IntegrationTreeSection label="Automatic Updates" initialOpen={Boolean(webhooks?.lastSubscriptionError) || !status.webhookConfigured} testIdPrefix="oura-updates"><ProfileTreeRow label="Webhook token" icon={status.webhookConfigured ? <CheckCircle2 className="h-3.5 w-3.5 text-active" /> : <AlertTriangle className="h-3.5 w-3.5 text-warning" />} hasValue showEmpty><span className={status.webhookConfigured ? "text-active" : "text-warning"}>{status.webhookConfigured ? "Configured" : "Not set"}</span></ProfileTreeRow><ProfileTreeRow label="Subscriptions" icon={<RefreshCw className="h-3.5 w-3.5" />} hasValue showEmpty><span className="text-muted-foreground">{webhooks?.subscriptions?.length || 0}</span></ProfileTreeRow><ProfileTreeRow label="Last notification" icon={<Activity className="h-3.5 w-3.5" />} hasValue showEmpty><span className="text-muted-foreground">{formatOuraDateTime(webhooks?.lastNotificationAt)}</span></ProfileTreeRow>{webhooks?.lastSubscriptionError && <ProfileTreeRow label="Subscription warning" icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />} hasValue showEmpty><span className="text-warning">{webhooks.lastSubscriptionError}</span></ProfileTreeRow>}</IntegrationTreeSection>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration Detail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub detail — multi-credential management
// ---------------------------------------------------------------------------

interface ProviderConnection {
  id: number;
  provider: string;
  label: string;
  accountType: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasCredential?: boolean;
}

interface PlatformEnvironmentUsage {
  id: number;
  platformName: string;
  productName: string;
  environmentName: string;
  owner: string;
  repo: string;
  branch: string;
}

interface PlatformListItem {
  id: number;
  name: string;
  products?: Array<{
    id: number;
    name: string;
    environments?: Array<{
      id: number;
      name: string;
    }>;
  }>;
}

interface PlatformEnvironmentDetails {
  platform: { id: number; name: string };
  product: { id: number; name: string };
  environment: { id: number; name: string };
  source?: {
    connectionId?: number | null;
    owner?: string;
    repo?: string;
    branch?: string;
  } | null;
}


function GitHubDetail() {
  const { toast } = useToast();
  const {
    data: providerConnections = [],
    refetch: refetchProviderConnections,
    isLoading: isLoadingProviderConnections,
  } = useQuery<ProviderConnection[]>({
    queryKey: ["/api/provider-connections"],
  });

  const githubConnections = providerConnections.filter((connection) => connection.provider === "github");
  const hasPlatformGitHubConnection = githubConnections.some((connection) => connection.status === "active");

  const { data: platformsData = [] } = useQuery<PlatformListItem[]>({
    queryKey: ["/api/platforms"],
  });

  const platformEnvironmentIds = useMemo(() => {
    return platformsData.flatMap((platform) =>
      (platform.products || []).flatMap((product) =>
        (product.environments || []).map((environment) => environment.id),
      ),
    );
  }, [platformsData]);

  const environmentQueries = useQueries({
    queries: platformEnvironmentIds.map((environmentId) => ({
      queryKey: [`/api/platforms/environments/${environmentId}/details`],
      enabled: Number.isFinite(environmentId),
    })),
  });

  const sourceUsageByConnectionId = useMemo(() => {
    const usage = new Map<number, PlatformEnvironmentUsage[]>();
    for (const query of environmentQueries) {
      const details = query.data;
      const connectionId = details?.source?.connectionId;
      if (!details || !connectionId) continue;
      const list = usage.get(connectionId) || [];
      list.push({
        id: details.environment.id,
        platformName: details.platform.name,
        productName: details.product.name,
        environmentName: details.environment.name,
        owner: details.source?.owner || "",
        repo: details.source?.repo || "",
        branch: details.source?.branch || "",
      });
      usage.set(connectionId, list);
    }
    return usage;
  }, [environmentQueries.map((query) => query.dataUpdatedAt).join(":")]);

  const [showProviderDialog, setShowProviderDialog] = useState(false);
  const [editingProviderConnection, setEditingProviderConnection] = useState<ProviderConnection | null>(null);
  const [providerLabelInput, setProviderLabelInput] = useState("");
  const [providerTokenInput, setProviderTokenInput] = useState("");
  const [providerAccountTypeInput, setProviderAccountTypeInput] = useState("source");

  const resetProviderForm = () => {
    setShowProviderDialog(false);
    setEditingProviderConnection(null);
    setProviderLabelInput("");
    setProviderTokenInput("");
    setProviderAccountTypeInput("source");
  };

  const openProviderDialog = (connection?: ProviderConnection) => {
    setEditingProviderConnection(connection || null);
    setProviderLabelInput(connection?.label || "");
    setProviderAccountTypeInput(connection?.accountType || "source");
    setProviderTokenInput("");
    setShowProviderDialog(true);
  };

  const refreshProviderConnections = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
    queryClient.invalidateQueries({ queryKey: ["/api/platforms"] });
    refetchProviderConnections();
  };

  const saveProviderConnectionMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = {
        provider: "github",
        label: providerLabelInput.trim(),
        accountType: providerAccountTypeInput.trim() || "source",
      };
      const token = providerTokenInput.trim();
      if (token) body.credential = token;

      if (!body.label) throw new Error("Label required");
      if (!editingProviderConnection && !token) throw new Error("Token required");

      const res = editingProviderConnection
        ? await apiRequest("PUT", `/api/provider-connections/${editingProviderConnection.id}`, body)
        : await apiRequest("POST", "/api/provider-connections", body);
      return (await res.json()) as ProviderConnection;
    },
    onSuccess: () => {
      toast({ title: editingProviderConnection ? "Connection updated" : "Connection created" });
      resetProviderForm();
      refreshProviderConnections();
    },
    onError: (err: Error) => {
      toast({ title: "Connection save failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteProviderConnectionMutation = useMutation({
    mutationFn: async (connection: ProviderConnection) => {
      const res = await apiRequest("DELETE", `/api/provider-connections/${connection.id}`);
      return (await res.json()) as { success: boolean };
    },
    onSuccess: () => {
      toast({ title: "Connection deleted" });
      refreshProviderConnections();
    },
    onError: (err: Error) => {
      toast({ title: "Delete blocked", description: err.message, variant: "destructive" });
    },
  });

  const testProviderConnectionMutation = useMutation({
    mutationFn: async (connection: ProviderConnection) => {
      const res = await apiRequest("POST", `/api/provider-connections/${connection.id}/test`, {});
      return (await res.json()) as { ok: boolean; message: string };
    },
    onSuccess: (result) => {
      toast({
        title: result.ok ? "Connection healthy" : "Connection test failed",
        description: result.message,
        variant: result.ok ? "default" : "destructive",
      });
      refreshProviderConnections();
    },
    onError: (err: Error) => {
      toast({ title: "Connection test failed", description: err.message, variant: "destructive" });
    },
  });

  const hasError = !hasPlatformGitHubConnection;

  return (
    <div className="space-y-6" data-testid="github-tab">
      {hasError && !isLoadingProviderConnections && (
        <Card
          className="border-error/30 dark:border-error/50 bg-error/5 dark:bg-error/20"
          data-testid="github-error-banner"
        >
          <CardContent className="py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-error-foreground dark:text-error">
              <AlertTriangle className="h-4 w-4" />
              No GitHub Platform connection
            </div>
            <p className="text-sm text-muted-foreground">
              Add a Platform GitHub connection and attach it to each Platform Environment source binding that needs repository access.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Canonical Design TreeView: flat settings sections, object branches, row-local actions. */}
      <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="github-detail">
        <ProfileDetailSection title="Platform connections" defaultOpen testId="github-connections">
          <button
            type="button"
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            onClick={() => openProviderDialog()}
            data-testid="button-github-add-provider-connection"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">New connection</span>
          </button>
            {githubConnections.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                No GitHub platform connections yet. Credentials are stored encrypted and never displayed.
              </p>
            ) : githubConnections.map((connection, index) => {
              const usage = sourceUsageByConnectionId.get(connection.id) || [];
              const isTesting = testProviderConnectionMutation.isPending;
              return (
                <HierarchyTreeRow key={connection.id} continues={index < githubConnections.length - 1} connectorAnchor="first-row-center">
                <ProfileTreeRow
                  label={connection.label}
                  icon={<CircleCheck className={cn("h-3.5 w-3.5", connection.status === "active" ? "text-active" : "text-muted-foreground")} />}
                  hasValue
                  showEmpty
                  defaultOpen={usage.length > 0}
                  testId={`github-provider-connection-${connection.id}`}
                  expandedContentClassName="min-w-0 space-y-3"
                  menuVisibility="hover"
                  menuContent={(
                    <>
                      <DropdownMenuItem
                        onClick={() => testProviderConnectionMutation.mutate(connection)}
                        disabled={isTesting}
                        data-testid={`button-github-test-provider-${connection.id}`}
                      >
                        <Activity className="mr-2 h-4 w-4" /> Test
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => openProviderDialog(connection)}
                        data-testid={`button-github-edit-provider-${connection.id}`}
                      >
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => {
                          if (usage.length > 0) {
                            toast({
                              title: "Connection in use",
                              description: "Remove or reassign Platform source bindings before deleting this connection.",
                              variant: "destructive",
                            });
                            return;
                          }
                          if (confirm(`Delete GitHub connection ${connection.label}? This cannot be undone.`)) {
                            deleteProviderConnectionMutation.mutate(connection);
                          }
                        }}
                        data-testid={`button-github-delete-provider-${connection.id}`}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </>
                  )}
                  expandedContent={(
                    <>
                      <p className="text-sm text-muted-foreground">
                        ID {connection.id}
                        {connection.lastVerifiedAt ? ` · verified ${new Date(connection.lastVerifiedAt).toLocaleString()}` : " · not verified"}
                      </p>
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">Used by</div>
                        {usage.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No Platform source bindings currently use this connection.</p>
                        ) : (
                          <div className="space-y-1">
                            {usage.map((item) => (
                              <div key={item.id} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/30 px-2 py-1.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                                <span className="min-w-0 break-words sm:truncate">{item.platformName} / {item.productName} / {item.environmentName}</span>
                                <span className="min-w-0 break-all font-mono text-muted-foreground sm:max-w-[45%] sm:truncate sm:text-right">{item.owner}/{item.repo}:{item.branch}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                />
                </HierarchyTreeRow>
              );
            })}
        </ProfileDetailSection>
      </div>

      <Dialog open={showProviderDialog} onOpenChange={(open) => { if (!open) resetProviderForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingProviderConnection ? "Edit GitHub Platform Connection" : "New GitHub Platform Connection"}</DialogTitle>
            <DialogDescription>
              Add or rotate the token Platforms uses for GitHub source operations. Existing credentials are replaced only when a new token is entered.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="github-provider-label">Label</Label>
              <Input
                id="github-provider-label"
                value={providerLabelInput}
                onChange={(event) => setProviderLabelInput(event.target.value)}
                placeholder="Mantra GitHub"
                data-testid="input-github-provider-label"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="github-provider-account-type">Account type</Label>
              <Input
                id="github-provider-account-type"
                value={providerAccountTypeInput}
                onChange={(event) => setProviderAccountTypeInput(event.target.value)}
                placeholder="source"
                data-testid="input-github-provider-account-type"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="github-provider-token">Personal Access Token</Label>
              <p className="text-xs text-muted-foreground">
                Required for new connections. Leave blank while editing to keep the existing encrypted credential.
              </p>
              <Input
                id="github-provider-token"
                type="password"
                value={providerTokenInput}
                onChange={(event) => setProviderTokenInput(event.target.value)}
                placeholder="github_pat_…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                data-testid="input-github-provider-token"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={resetProviderForm}>Cancel</Button>
            <Button
              type="button"
              onClick={() => saveProviderConnectionMutation.mutate()}
              disabled={saveProviderConnectionMutation.isPending}
              data-testid="button-github-provider-save"
            >
              {saveProviderConnectionMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Save Connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

function AutomationAuthSection() {
  const { toast } = useToast();
  const [showToken, setShowToken] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [boundDraft, setBoundDraft] = useState("");

  const { data, isLoading } = useQuery<{
    configured: boolean;
    lastChars: string | null;
    boundUserId?: string | null;
    boundUserEmail?: string | null;
  }>({
    queryKey: ["/api/integrations/automation-auth"],
  });

  const saveMutation = useMutation({
    mutationFn: async (body: {
      token?: string;
      generate?: boolean;
      boundUserEmail?: string;
      clearBoundUser?: boolean;
    }) => {
      const res = await apiRequest("PUT", "/api/integrations/automation-auth", body);
      return res.json() as Promise<{
        configured: boolean;
        lastChars: string | null;
        token?: string;
        boundUserId?: string | null;
        boundUserEmail?: string | null;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/automation-auth"] });
      queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
      if (result.token) {
        navigator.clipboard.writeText(result.token).then(
          () => toast({ title: "Token generated", description: "Copied to clipboard" }),
          () => toast({ title: "Token generated", description: "Copy it from the response — clipboard unavailable" }),
        );
      } else {
        toast({ title: "Token saved" });
      }
      setManualMode(false);
      setDraft("");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) return <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="min-w-0 space-y-2" data-testid="card-automation-auth">
      <IntegrationTreeSection label="Token" initialOpen icon={<Shield className="h-3.5 w-3.5" />} testIdPrefix="automation-auth">
        <ProfileTreeRow
          label="Status"
          icon={<Shield className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-automation-auth-status"
        >
          {data?.configured ? "Configured" : "Not set"}
        </ProfileTreeRow>
        {data?.configured ? (
          <ProfileTreeRow
            label="Token"
            icon={<Shield className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId="row-automation-auth-token"
            actionContent={(
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setShowToken(!showToken)}
                data-testid="button-toggle-token-visibility"
              >
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            )}
          >
            <span className="font-mono text-xs">
              {showToken ? `••••••••••••••••••••••••${data.lastChars}` : "••••••••••••••••••••••••••••••••"}
            </span>
          </ProfileTreeRow>
        ) : null}
        <ProfileTreeRow
          label="Actions"
          icon={<Shield className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-automation-auth-actions"
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => saveMutation.mutate({ generate: true })}
              disabled={saveMutation.isPending}
              data-testid={data?.configured ? "button-regenerate-token" : "button-generate-token"}
            >
              {saveMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : data?.configured ? <RefreshCw className="mr-1 h-3 w-3" /> : null}
              {data?.configured ? "Regenerate" : "Generate Token"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setManualMode(!manualMode)}
              data-testid={data?.configured ? "button-manual-token" : "button-set-manual-token"}
            >
              Set manually
            </Button>
          </div>
        </ProfileTreeRow>
        {manualMode ? (
          <ProfileTreeRow
            label="Manual"
            icon={<Shield className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId="row-automation-auth-manual"
            actionContent={(
              <Button
                size="sm"
                onClick={() => saveMutation.mutate({ token: draft })}
                disabled={!draft || draft.length < 32 || saveMutation.isPending}
                data-testid="button-save-manual-token"
              >
                Save
              </Button>
            )}
          >
            <Input
              placeholder="Paste token (min 32 chars)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-7 font-mono text-xs"
              data-testid="input-manual-token"
            />
          </ProfileTreeRow>
        ) : null}
        <ProfileTreeRow
          label="Stage user"
          icon={<Shield className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="row-automation-auth-bound-user"
          actionContent={(
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                onClick={() => saveMutation.mutate({ boundUserEmail: boundDraft.trim() })}
                disabled={!boundDraft.trim() || saveMutation.isPending}
                data-testid="button-save-bound-user"
              >
                Bind
              </Button>
              {data?.boundUserId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => saveMutation.mutate({ clearBoundUser: true })}
                  disabled={saveMutation.isPending}
                  data-testid="button-clear-bound-user"
                >
                  Clear
                </Button>
              ) : null}
            </div>
          )}
        >
          <div className="min-w-0 space-y-1">
            <div className="text-xs text-muted-foreground">
              {data?.boundUserEmail || data?.boundUserId || "Not bound — Stage Smoke ingest stays blocked"}
            </div>
            <Input
              placeholder="Stage user email"
              value={boundDraft}
              onChange={(e) => setBoundDraft(e.target.value)}
              className="h-7 text-xs"
              data-testid="input-bound-user-email"
            />
          </div>
        </ProfileTreeRow>
      </IntegrationTreeSection>
    </div>
  );
}


interface SendGridStatus {
  configured: boolean;
  hasApiKey: boolean;
  hasFromEmail: boolean;
  hasFromName: boolean;
}

function SendGridDetail() {
  const { toast } = useToast();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("Mantra SendGrid test");
  const [body, setBody] = useState("This is a SendGrid test email from Mantra.");

  const { data: status, isLoading } = useQuery<SendGridStatus>({
    queryKey: ["/api/notifications/sendgrid/status"],
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/notifications/send", {
        channel: "email",
        to,
        subject,
        body,
        metadata: { source: "integrations-ui", provider: "sendgrid" },
      });
      return res.json() as Promise<{ ok: boolean; status: string; providerMessageId?: string }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Test email accepted",
        description: result.providerMessageId ? `SendGrid message ${result.providerMessageId}` : "SendGrid accepted the email.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Test email failed", description: err.message, variant: "destructive" });
    },
  });

  const configured = Boolean(status?.configured);
  const canSend = configured && to.trim().length > 0 && (body.trim().length > 0) && !sendMutation.isPending;

  return (
    <div className="min-w-0 space-y-2">
      <div data-testid="card-sendgrid-status">
        <IntegrationTreeSection label="Email" initialOpen icon={<Mail className="h-3.5 w-3.5" />} testIdPrefix="sendgrid">
          {isLoading || !status ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <ProfileTreeRow
                label="Status"
                icon={<Mail className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
                mobileLayout="inline"
                testId="badge-sendgrid-configured"
              >
                {configured ? "Configured" : "Not configured"}
              </ProfileTreeRow>
              <ProfileTreeRow
                label="API key"
                icon={<Mail className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
                mobileLayout="inline"
                testId="badge-sendgrid-api-key"
              >
                {status.hasApiKey ? "Set" : "Missing"}
              </ProfileTreeRow>
              <ProfileTreeRow
                label="From email"
                icon={<Mail className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
                mobileLayout="inline"
                testId="badge-sendgrid-from-email"
              >
                {status.hasFromEmail ? "Set" : "Missing"}
              </ProfileTreeRow>
            </>
          )}
          <div className="min-w-0 px-2 py-1.5">
            <SecretsForSection section="sendgrid" />
          </div>
        </IntegrationTreeSection>
      </div>
      <div data-testid="card-sendgrid-test-email">
        <IntegrationTreeSection label="Send test" initialOpen icon={<Mail className="h-3.5 w-3.5" />} testIdPrefix="sendgrid-test">
          <ProfileTreeRow
            label="To"
            icon={<Mail className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId="row-sendgrid-test-to"
          >
            <Input
              id="input-sendgrid-test-to"
              type="email"
              placeholder="ray@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-7 text-right text-xs"
              data-testid="input-sendgrid-test-to"
            />
          </ProfileTreeRow>
          <ProfileTreeRow
            label="Subject"
            icon={<Mail className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId="row-sendgrid-test-subject"
          >
            <Input
              id="input-sendgrid-test-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-7 text-right text-xs"
              data-testid="input-sendgrid-test-subject"
            />
          </ProfileTreeRow>
          <ProfileTreeRow
            label="Body"
            icon={<Mail className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId="row-sendgrid-test-body"
            actionContent={(
              <Button
                size="sm"
                onClick={() => sendMutation.mutate()}
                disabled={!canSend}
                data-testid="button-sendgrid-send-test"
              >
                {sendMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Send
              </Button>
            )}
          >
            <Textarea
              id="textarea-sendgrid-test-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="min-h-[72px] text-xs"
              data-testid="textarea-sendgrid-test-body"
            />
          </ProfileTreeRow>
          {!configured ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-sendgrid-test-disabled">
              Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL first.
            </div>
          ) : null}
        </IntegrationTreeSection>
      </div>
    </div>
  );
}

const INTEGRATION_DETAIL_SURFACES: Record<string, () => React.ReactNode> = {
  google: () => <GoogleDetail />,
  box: () => <BoxDetail />,
  monday: () => <MondayDetail />,
  elevenlabs: () => (
    <div className="space-y-4">
      <WebhookBaseUrlSection />
      <InstantVoiceCloneWizard />
      <VoiceBrowserSection />
      <ExpressivenessSection />
      <VoiceTuningSection />
      <PronunciationSection />
    </div>
  ),
  twitter: () => (
    <div className="space-y-4">
      <TwitterAccountsSection />
    </div>
  ),
  quickbooks: () => <QuickBooksDetail />,
  plaid: () => (
    <div className="min-w-0 space-y-2">
      <div data-testid="card-secret-plaid">
        <IntegrationTreeSection label="Credentials" initialOpen icon={<Landmark className="h-3.5 w-3.5" />} testIdPrefix="plaid">
          <div className="min-w-0 px-2 py-1.5">
            <SecretsForSection section="plaid" />
          </div>
        </IntegrationTreeSection>
      </div>
      <PlaidAccountsSection />
    </div>
  ),
  brave: () => (
    <div className="min-w-0 space-y-2" data-testid="card-secret-brave">
      <IntegrationTreeSection label="API" initialOpen icon={<Globe className="h-3.5 w-3.5" />} testIdPrefix="brave">
        <div className="min-w-0 px-2 py-1.5">
          <SecretsForSection section="brave" />
        </div>
      </IntegrationTreeSection>
    </div>
  ),
  github: () => <GitHubDetail />,
  "automation-auth": () => (
    <div className="space-y-4">
      <AutomationAuthSection />
    </div>
  ),
  expo: () => <ExpoDetail />,
  sentry: () => <SentryDetail />,
  recall: () => <RecallDetail />,
  twilio: () => <TwilioDetail />,
  deepgram: () => <DeepgramDetail />,
  sendgrid: () => <SendGridDetail />,
  meta: () => <MetaDetail />,
  oura: () => <OuraDetail />,
  slack: () => <SlackDetail />,
};

function IntegrationDetail({ integration }: { integration: ResolvedIntegrationCard }) {
  const surface = integration.detailSurface
    ? INTEGRATION_DETAIL_SURFACES[integration.detailSurface]
    : undefined;
  const Icon = integrationIcon(integration.iconKey);

  return (
    <div className="space-y-4">
      {!integration.ownsTitle && (
        <div className="flex items-center gap-3">
          <Icon className="h-6 w-6" />
          <h2 className="text-lg font-semibold">{integration.label}</h2>
        </div>
      )}
      {surface?.()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page (default export)
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  const { data: status } = useQuery<Record<string, any>>({
    queryKey: ["/api/setup/secrets-status"],
    refetchInterval: 15000,
  });
  const { data: composition, isLoading: compositionLoading } = useProductComposition();
  const [location, setLocation] = useLocation();
  const providerMatch = /^\/integrations\/([^/]+)\/?$/.exec(location);
  const provider = providerMatch ? decodeURIComponent(providerMatch[1]) : null;
  const integration = provider
    ? (composition?.integrations ?? []).find((item) => item.route === provider)
    : undefined;

  usePageHeader({ title: integration?.label || "Integrations", titleHref: "/integrations" });

  if (provider && compositionLoading) {
    return <div className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (provider && !integration) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-integration-not-found">
          Integration not found.{" "}
          <button className="underline text-cta" onClick={() => setLocation("/integrations")}>
            Back to integrations
          </button>
        </div>
      </div>
    );
  }

  return integration ? (
    <div className="flex flex-col gap-6 p-6">
      <IntegrationDetail integration={integration} />
    </div>
  ) : (
    <IntegrationTree status={status} />
  );
}
