// Use createLogger for logging ONLY
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueries } from "@tanstack/react-query";
import { createLogger } from "@/lib/logger";

const log = createLogger("Integrations");
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { usePageHeader } from "@/hooks/use-page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  RotateCcw,
  Shield,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Settings,
  ChevronRight,
  Clock,
  Hash,
  Play,
  Pause,
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
  ArrowLeft,
  Bot,
  Eye,
  EyeOff,
  XCircle,
  Pencil,
  Landmark,
  SlidersHorizontal,
  Github,
  Globe,
  Circle,
  CircleCheck,
  ExternalLink,
  Train,
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
} from "lucide-react";
import { SiX } from "react-icons/si";
import { SecretsForSection } from "@/components/SecretControl";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { RailwaySetupTab } from "@/components/railway-setup";
import { VoiceV3WebhookSecretCard } from "@/components/VoiceV3WebhookSecretCard";
import { usePlaidLink } from "react-plaid-link";
import { useRoute, useLocation } from "wouter";











// ---------------------------------------------------------------------------
// Integration grid config
// ---------------------------------------------------------------------------

interface IntegrationDef {
  id: string;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  statusFields: string[];
  healthField?: string;
  route: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "google", name: "Google", icon: Mail, statusFields: ["gmail", "gdrive"], healthField: "gmailHealthy", route: "google" },
  { id: "elevenlabs", name: "ElevenLabs", icon: Volume2, statusFields: ["elevenlabs"], route: "elevenlabs" },
  { id: "cartesia", name: "Cartesia", icon: Volume2, statusFields: ["cartesia"], route: "cartesia" },
  { id: "twilio", name: "Twilio Phone", icon: Phone, statusFields: ["twilio"], route: "twilio" },
  { id: "deepgram", name: "Deepgram", icon: Mic, statusFields: ["deepgram"], route: "deepgram" },
  { id: "openai", name: "OpenAI", icon: Bot, statusFields: ["openai", "openaiSubscription"], route: "openai" },
  { id: "claude-cli", name: "Claude Code CLI", icon: Settings, statusFields: ["claudeCli"], route: "claude-cli" },
  { id: "twitter", name: "X (Twitter)", icon: () => <SiX className="h-5 w-5" />, statusFields: ["twitter"], route: "twitter" },
  { id: "plaid", name: "Plaid", icon: Landmark, statusFields: ["plaid"], route: "plaid" },
  { id: "brave", name: "Brave Search", icon: Globe, statusFields: ["brave"], route: "brave" },
  { id: "github", name: "GitHub", icon: Github, statusFields: ["github"], route: "github" },
  { id: "railway", name: "Railway", icon: Train, statusFields: ["railway"], route: "railway" },
  { id: "automation-auth", name: "Automation Auth", icon: Shield, statusFields: ["automationAuth"], route: "automation-auth" },
  { id: "expo", name: "Expo Mobile", icon: Smartphone, statusFields: ["expo"], route: "expo" },
  { id: "sentry", name: "Sentry", icon: Shield, statusFields: ["sentry"], route: "sentry" },
  { id: "sendgrid", name: "SendGrid", icon: Mail, statusFields: ["sendgrid"], route: "sendgrid" },
  { id: "meta", name: "Meta", icon: Glasses, statusFields: ["meta"], route: "meta" },
  { id: "oura", name: "Oura Ring", icon: Activity, statusFields: ["oura"], route: "oura" },
  { id: "recall", name: "Recall", icon: Radio, statusFields: ["recall"], route: "recall" },
];

function resolveStatus(
  integration: IntegrationDef,
  status: Record<string, any> | undefined,
): "ready" | "error" | "connect" {
  if (!status) return "connect";
  const anySet = integration.statusFields.some((f) => status[f]);
  if (!anySet) return "connect";
  if (integration.healthField && status[integration.healthField] === false) return "error";
  return "ready";
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
        Public URL ElevenLabs uses to call back into this server (custom-LLM for v2/v2.5,
        tool webhooks for v3). Override the auto-detected URL when testing voice in
        development against a known-reachable address. Leave blank to use the default.
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold" data-testid="text-pronunciation-title">Pronunciation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground" data-testid="text-pronunciation-note">
          Teach Agent how to pronounce names, brands, and terms. Entries are case-sensitive — add separate entries for different capitalizations if needed (e.g. "nginx" and "Nginx").
        </p>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-pronunciation-empty">
            No pronunciation entries yet.
          </div>
        ) : (
          <div className="space-y-1" data-testid="pronunciation-entries-list">
            {entries.map(entry => (
              <div
                key={entry.word}
                className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors"
                data-testid={`pronunciation-entry-${entry.word}`}
              >
                {editingWord === entry.word ? (
                  <>
                    <span className="text-sm font-medium min-w-[80px]">{entry.word}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <Input
                      value={editAlias}
                      onChange={e => setEditAlias(e.target.value)}
                      className="flex-1 h-8 text-sm"
                      placeholder="Pronounce as..."
                      onKeyDown={e => e.key === "Enter" && handleUpdate(entry.word)}
                      data-testid={`input-edit-alias-${entry.word}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => handleUpdate(entry.word)}
                      disabled={updateMutation.isPending}
                      data-testid={`button-save-edit-${entry.word}`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => { setEditingWord(null); setEditAlias(""); }}
                      data-testid={`button-cancel-edit-${entry.word}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium min-w-[80px]" data-testid={`text-word-${entry.word}`}>{entry.word}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-sm text-muted-foreground flex-1" data-testid={`text-alias-${entry.word}`}>{entry.alias}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => { setEditingWord(entry.word); setEditAlias(entry.alias); }}
                      data-testid={`button-edit-${entry.word}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => removeMutation.mutate(entry.word)}
                      disabled={removeMutation.isPending}
                      data-testid={`button-remove-${entry.word}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
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
            {addMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
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
    <Card data-testid="card-elevenlabs-ivc">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base font-semibold">Instant Voice Clone</CardTitle>
          <p className="text-sm text-muted-foreground">
            Isolated FTUE voice mirror prototype. Record short samples, create an ElevenLabs voice, then use the returned voice ID later.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="button-open-ivc-wizard">
          <Sparkles className="h-4 w-4 mr-2" />
          Create clone
        </Button>
      </CardHeader>
      <CardContent>
        {latestVoice ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Latest clone: {latestVoice.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{latestVoice.voiceId}</p>
              <p className="text-xs text-muted-foreground">
                {latestVoice.sampleCount} samples · {latestVoice.requiresVerification ? "requires verification" : "ready in ElevenLabs"}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => copyVoiceId(latestVoice.voiceId)}>
              <Copy className="h-3.5 w-3.5 mr-2" />
              Copy ID
            </Button>
          </div>
        ) : (
          <div className="py-12 text-center rounded-md border border-dashed">
            <Mic className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No Instant Voice Clone has been created from this wizard yet.</p>
          </div>
        )}
      </CardContent>

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
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold" data-testid="text-voice-title">
          Voice Selection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isConfigured && currentVoice && (
          <div className="flex items-center gap-3 p-3 rounded-md border border-primary/30 bg-primary/5">
            <Volume2 className="h-4 w-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" data-testid="text-current-voice-name">
                {currentVoice.name}
              </p>
              <div className="flex flex-wrap gap-1 mt-1">
                {Object.entries(currentVoice.labels).map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5">
                    {v}
                  </Badge>
                ))}
              </div>
            </div>
            {currentVoice.preview_url && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => handlePreview(currentVoice)}
                data-testid="button-preview-current-voice"
              >
                {playingId === currentVoice.voice_id ? (
                  <X className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        )}
        {!isConfigured && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-voice-configured">
            No voice configured. Set up ElevenLabs API key and select a voice below.
          </p>
        )}

        <Button
          variant="outline"
          onClick={() => setShowBrowser(!showBrowser)}
          data-testid="button-toggle-voice-browser"
        >
          {showBrowser ? "Close Browser" : "Browse Voices"}
        </Button>

        {showBrowser && (
          <div className="space-y-3 border rounded-md p-3">
            <div className="flex gap-2">
              <Input
                placeholder="Search voices..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1"
                data-testid="input-voice-search"
              />
              {categories.length > 0 && (
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="w-36" data-testid="select-voice-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {voicesLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto space-y-2" data-testid="list-voice-browser">
                {filtered.map((voice) => {
                  const isSelected = voice.voice_id === currentVoiceId;
                  return (
                    <div
                      key={voice.voice_id}
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-md border transition-colors",
                        isSelected ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50",
                      )}
                      data-testid={`voice-option-${voice.voice_id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{voice.name}</span>
                          {isSelected && (
                            <Badge className="text-xs">current</Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {Object.entries(voice.labels).map(([k, v]) => (
                            <Badge key={k} variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5">
                              {v}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {voice.preview_url && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handlePreview(voice)}
                          >
                            {playingId === voice.voice_id ? (
                              <X className="h-3.5 w-3.5" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {!isSelected && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => selectVoiceMutation.mutate(voice.voice_id)}
                            disabled={selectVoiceMutation.isPending}
                          >
                            {selectVoiceMutation.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Select"
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AgentStatusCard() {
  const { toast } = useToast();
  const { data: status, isLoading: statusLoading } = useExecutorStatus();

  const actionMutation = useMutation({
    mutationFn: async (action: string) => {
      const res = await apiRequest("POST", `/api/gateway/${action}`);
      return res.json();
    },
    onSuccess: (data, action) => {
      toast({
        title: `Agent ${action}`,
        description: data.message || `Successfully ${action}ed the agent.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
    onError: (error: Error) => {
      log.error("gateway action failed:", error);
      toast({
        title: "Action Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const isRunning = status?.status === "running";
  const isStopped = status?.status === "stopped";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold">Agent</CardTitle>
        <div className="flex items-center gap-2">
          {statusLoading ? (
            <Skeleton className="h-5 w-20" />
          ) : (
            <Badge
              variant={isRunning ? "default" : isStopped ? "secondary" : "outline"}
              data-testid="badge-agent-status-settings"
            >
              {status?.status || "Unknown"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {isRunning && status?.uptime != null && (
              <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatSettingsUptime(status.uptime)}
              </span>
            )}
            {isRunning && status?.pid != null && (
              <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                <Hash className="h-3 w-3" />
                PID {status.pid}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => actionMutation.mutate("restart")}
                  disabled={actionMutation.isPending}
                  data-testid="button-restart-agent-settings"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Restart
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => actionMutation.mutate("stop")}
                  disabled={actionMutation.isPending}
                  data-testid="button-stop-agent-settings"
                >
                  <Pause className="h-3.5 w-3.5 mr-1.5" />
                  Pause
                </Button>
              </>
            ) : (
              <Button
                onClick={() => actionMutation.mutate("start")}
                disabled={actionMutation.isPending}
                data-testid="button-start-agent-settings"
              >
                <Play className="h-4 w-4 mr-2" />
                {actionMutation.isPending ? "Starting..." : "Resume"}
              </Button>
            )}
          </div>
        </div>

        {status?.error && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="font-mono text-xs">{status.error}</span>
          </div>
        )}

      </CardContent>
    </Card>
  );
}

function formatSettingsUptime(seconds?: number): string {
  if (!seconds) return "N/A";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}






function OpenAISubscriptionSection() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canManageSystemIntegrations = hasPermission("system:write");

  const { data: statusData, isLoading, refetch } = useQuery<{
    connected: boolean;
    email?: string;
    label?: string;
    hasTokens?: boolean;
  }>({
    queryKey: ["/api/openai-subscription/status"],
    refetchInterval: 30000,
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/openai-subscription/disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openai-subscription/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/models/available"] });
      toast({ title: "ChatGPT account disconnected" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to disconnect", description: err.message, variant: "destructive" });
    },
  });

  const [showUrlPaste, setShowUrlPaste] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [exchangeState, setExchangeState] = useState("");
  const [isExchanging, setIsExchanging] = useState(false);

  const exchangeCode = async (code: string, state: string) => {
    setIsExchanging(true);
    try {
      const res = await fetch("/api/openai-subscription/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code, state }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Exchange failed");
      toast({ title: "ChatGPT account connected", description: data.email || "Success" });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/models/available"] });
      setShowUrlPaste(false);
      setPasteUrl("");
    } catch (err: any) {
      toast({ title: "Failed to connect", description: err.message, variant: "destructive" });
    } finally {
      setIsExchanging(false);
    }
  };

  const handleConnect = async () => {
    try {
      if (!canManageSystemIntegrations) {
        toast({ title: "Admin only", description: "Only admins can change system model integrations.", variant: "destructive" });
        return;
      }
      const res = await fetch("/api/openai-subscription/oauth/start", { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start OAuth");
      }
      const { url, state } = await res.json();
      setExchangeState(state);
      const popup = window.open(url, "openai-subscription-oauth", "width=600,height=700,scrollbars=yes");
      if (!popup) {
        toast({ title: "Popup blocked", description: "Please allow popups and try again.", variant: "destructive" });
        return;
      }
      let handled = false;
      // Show the paste box after a short delay — the popup will land on
      // localhost:1455 (connection refused) so the user needs to copy the URL.
      const pasteTimer = setTimeout(() => {
        if (!handled) setShowUrlPaste(true);
      }, 4000);
      const check = setInterval(() => {
        if (handled) return;
        try {
          const popupUrl = popup.location.href;
          if (popupUrl && popupUrl.includes("/auth/callback")) {
            const params = new URL(popupUrl).searchParams;
            const code = params.get("code");
            const urlState = params.get("state");
            if (code && urlState) {
              handled = true;
              clearInterval(check);
              clearTimeout(pasteTimer);
              popup.close();
              exchangeCode(code, urlState);
              return;
            }
          }
        } catch (_e) { /* cross-origin, expected */ }
        if (popup.closed && !handled) {
          clearInterval(check);
          clearTimeout(pasteTimer);
          setShowUrlPaste(true);
        }
      }, 300);
    } catch (err: any) {
      toast({ title: "Failed to start OAuth", description: err.message, variant: "destructive" });
    }
  };

  const handlePasteSubmit = () => {
    try {
      const url = new URL(pasteUrl.trim());
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || exchangeState;
      if (!code) {
        toast({ title: "Invalid URL", description: "No authorization code found in URL", variant: "destructive" });
        return;
      }
      exchangeCode(code, state);
    } catch {
      toast({ title: "Invalid URL", description: "Please paste the full URL from the browser address bar", variant: "destructive" });
    }
  };

  const connected = statusData?.connected ?? false;

  return (
    <Card data-testid="card-openai-subscription">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Bot className="h-4 w-4" />
          OpenAI Subscription
        </CardTitle>
        <Badge
          variant={connected ? "default" : "secondary"}
          data-testid="badge-openai-subscription-status"
        >
          {connected ? "Connected" : "Not Connected"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Connect your ChatGPT Plus, Pro, or Codex subscription to use subscription models (GPT-5.4, GPT-5.3 Codex, Codex Mini) at no per-token cost. When your subscription limit is hit, calls fail explicitly with a clear error.
        </p>

        {!canManageSystemIntegrations && (
          <p className="text-xs text-muted-foreground italic">System integration. Visible to all users; admin-only to connect or disconnect.</p>
        )}

        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : connected ? (
          <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-primary/30 bg-primary/5">
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" data-testid="text-openai-subscription-email">
                  {statusData?.email || statusData?.label || "ChatGPT Account"}
                </p>
                <p className="text-xs text-muted-foreground">Subscription models available in tier selectors</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending || !canManageSystemIntegrations}
              title={canManageSystemIntegrations ? undefined : "Admin only"}
              data-testid="button-disconnect-openai-subscription"
            >
              {disconnectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Button
              variant="outline"
              onClick={handleConnect}
              disabled={isExchanging || !canManageSystemIntegrations}
              title={canManageSystemIntegrations ? undefined : "Admin only"}
              data-testid="button-connect-openai-subscription"
            >
              {isExchanging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {isExchanging ? "Connecting..." : "Connect ChatGPT Account"}
            </Button>
            {showUrlPaste && (
              <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                <p className="text-xs text-muted-foreground">
                  The popup will show a "can't be reached" error — that's expected. Copy the full URL from the popup's address bar and paste it below:
                </p>
                <div className="flex gap-2">
                  <Input
                    value={pasteUrl}
                    onChange={(e) => setPasteUrl(e.target.value)}
                    placeholder="Paste the callback URL here..."
                    className="text-xs"
                    data-testid="input-oauth-callback-url"
                  />
                  <Button
                    size="sm"
                    onClick={handlePasteSubmit}
                    disabled={!pasteUrl.trim() || isExchanging}
                    data-testid="button-submit-oauth-url"
                  >
                    {isExchanging ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground border-t pt-2">
          Uses OAuth PKCE flow with the official Codex CLI client ID. Your credentials are encrypted and stored locally.
        </p>
      </CardContent>
    </Card>
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
  permissions: GooglePermissions;
}

const GMAIL_PERMISSIONS: Array<{ key: keyof GooglePermissions; label: string; description: string }> = [
  { key: "gmailRead", label: "Read emails", description: "Search and read email messages" },
  { key: "gmailSend", label: "Send emails", description: "Send emails on your behalf" },
  { key: "gmailDraft", label: "Create drafts", description: "Create draft emails for review" },
  { key: "gmailDownloadAttachments", label: "Download attachments", description: "Download email attachments to workspace" },
];

const CALENDAR_PERMISSIONS: Array<{ key: keyof GooglePermissions; label: string; description: string }> = [
  { key: "calendarView", label: "View events", description: "List and read calendar events" },
  { key: "calendarCreate", label: "Create events", description: "Schedule new meetings and events" },
  { key: "calendarEdit", label: "Edit events", description: "Update existing calendar events" },
  { key: "calendarDelete", label: "Delete events", description: "Remove events from calendar" },
];


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
    <Card data-testid="card-twitter-accounts">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <SiX className="h-4 w-4" />
          X (Twitter)
        </CardTitle>
        <Badge variant="secondary" className="font-mono px-1 py-0" data-testid="badge-twitter-account-count">
          {accounts.length} connected
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
          </div>
        ) : accounts.length === 0 && !showAddForm ? (
          <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-twitter-accounts">
            No X (Twitter) accounts connected yet. Add your API credentials to enable tweeting.
          </p>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => (
              <div key={account.id} className="space-y-2">
                <div
                  className={`flex items-center gap-3 p-3 rounded-md border ${!account.valid ? "border-destructive/40" : ""}`}
                  data-testid={`twitter-account-${account.id}`}
                >
                  <SiX className={`h-4 w-4 shrink-0 ${!account.valid ? "text-destructive" : "text-muted-foreground"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate" data-testid={`text-twitter-username-${account.id}`}>
                        {account.username ? `@${account.username}` : account.label}
                      </span>
                      {account.valid ? (
                        <Badge variant="default" data-testid={`badge-twitter-valid-${account.id}`}>Connected</Badge>
                      ) : (
                        <Badge variant="destructive" data-testid={`badge-twitter-invalid-${account.id}`}>
                          {account.error || "Invalid credentials"}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-twitter-date-${account.id}`}>
                      Added {new Date(account.addedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeMutation.mutate(account.id)}
                    disabled={removeMutation.isPending}
                    data-testid={`button-remove-twitter-${account.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {account.valid && (
                  <div className="ml-7 space-y-1.5 text-sm">
                    <p className="text-xs font-medium text-muted-foreground">Permissions</p>
                    {(["post", "reply", "delete"] as const).map((perm) => (
                      <div key={perm} className="flex items-center justify-between">
                        <span className="text-xs capitalize">{perm === "post" ? "Post tweets" : perm === "reply" ? "Reply to tweets" : "Delete tweets"}</span>
                        <Switch
                          checked={account.permissions[perm]}
                          onCheckedChange={(checked) =>
                            permMutation.mutate({ accountId: account.id, perms: { [perm]: checked } })
                          }
                          data-testid={`switch-twitter-perm-${perm}-${account.id}`}
                        />
                      </div>
                    ))}
                    <div className="pt-2 border-t mt-2">
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">Bearer Token</p>
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
                      <p className="text-[10px] text-muted-foreground mt-1">Required for landscape X Search scanning</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {showAddForm && (
          <div className="border rounded-md p-3 space-y-3">
            <div className="space-y-2">
              <label className="text-xs font-medium">API Key</label>
              <Input
                type={showSecrets ? "text" : "password"}
                placeholder="Enter API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                data-testid="input-twitter-api-key"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium">API Secret</label>
              <Input
                type={showSecrets ? "text" : "password"}
                placeholder="Enter API Secret"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                data-testid="input-twitter-api-secret"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium">Access Token</label>
              <Input
                type={showSecrets ? "text" : "password"}
                placeholder="Enter Access Token"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                data-testid="input-twitter-access-token"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium">Access Token Secret</label>
              <Input
                type={showSecrets ? "text" : "password"}
                placeholder="Enter Access Token Secret"
                value={accessTokenSecret}
                onChange={(e) => setAccessTokenSecret(e.target.value)}
                data-testid="input-twitter-access-token-secret"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium">Bearer Token <span className="text-muted-foreground">(optional)</span></label>
              <Input
                type={showSecrets ? "text" : "password"}
                placeholder="Enter Bearer Token (for news/article endpoints)"
                value={bearerToken}
                onChange={(e) => setBearerToken(e.target.value)}
                data-testid="input-twitter-bearer-token"
              />
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSecrets(!showSecrets)}
                data-testid="button-toggle-twitter-secrets"
              >
                {showSecrets ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                {showSecrets ? "Hide" : "Show"} values
              </Button>
              <Button
                onClick={handleAddAccount}
                disabled={!apiKey.trim() || !apiSecret.trim() || !accessToken.trim() || !accessTokenSecret.trim() || isAdding}
                data-testid="button-connect-twitter"
              >
                {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Get your credentials from{" "}
              <a href="https://developer.x.com" target="_blank" rel="noopener noreferrer" className="underline">
                developer.x.com
              </a>
              . Create a Project &amp; App, then generate API Key, API Secret, Access Token, and Access Token Secret with Read and Write permissions. Optionally add a Bearer Token to enable reading X Articles and news content.
            </p>
          </div>
        )}

        <Button
          variant="outline"
          onClick={() => setShowAddForm(!showAddForm)}
          data-testid="button-add-twitter-account"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          {showAddForm ? "Cancel" : "Add X (Twitter) Account"}
        </Button>
      </CardContent>
    </Card>
  );
}


function GoogleAccountsSection() {
  const { toast } = useToast();
  const [addLabel, setAddLabel] = useState("Work");
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

  const { data: gmailStatus } = useQuery<{ oauthConfigured: boolean }>({
    queryKey: ["/api/gmail/status"],
  });

  const { data: accountsData, isLoading } = useQuery<{ accounts: Array<{ id: string; email: string; label: string; addedAt: string; scopes?: { hasGmailRead: boolean; hasSend: boolean }; healthy?: boolean; healthError?: string }> }>({
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

  const removeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      await apiRequest("DELETE", `/api/gmail/accounts/${accountId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
      toast({ title: "Account removed" });
    },
    onError: (err: Error) => {
      log.error("Google account remove failed:", err);
      toast({ title: "Failed to remove account", description: err.message, variant: "destructive" });
    },
  });

  const permMutation = useMutation({
    mutationFn: async ({ accountId, perms, label }: { accountId: string; perms: Partial<GooglePermissions>; label: string }) => {
      const res = await apiRequest("PUT", `/api/connected-accounts/${accountId}/permissions`, perms);
      return { data: await res.json(), label };
    },
    onSuccess: ({ label }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "google"] });
      toast({ title: "Permission updated", description: label });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update permission", description: err.message, variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["/api/connected-accounts", "google"] });
    },
  });

  const accounts = accountsData?.accounts || [];
  const permAccounts = (permsData?.accounts || []).filter((a) => a.provider === "google");

  const toggleExpanded = (accountId: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const handlePermToggle = (accountId: string, key: keyof GooglePermissions, currentValue: boolean) => {
    const permLabel = [...GMAIL_PERMISSIONS, ...CALENDAR_PERMISSIONS].find((p) => p.key === key)?.label || key;
    const accountEmail = permAccounts.find((a) => a.accountId === accountId)?.email || accountId;
    const label = `${!currentValue ? "Enabled" : "Disabled"}: ${permLabel} for ${accountEmail}`;
    permMutation.mutate({ accountId, perms: { [key]: !currentValue }, label });
  };

  if (!gmailStatus?.oauthConfigured) {
    return (
      <Card data-testid="card-google-accounts">
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Google Accounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground" data-testid="text-google-oauth-required">
            Google integration requires OAuth credentials. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your Secrets to enable account connections.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-google-accounts">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Google Accounts
        </CardTitle>
        <Badge variant="secondary" className="font-mono px-1 py-0" data-testid="badge-google-account-count">
          {accounts.length} connected
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-google-accounts">
            No Google accounts connected yet. Add one to enable Gmail import and email features.
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.map((account) => {
              const missingScopes: string[] = (account as any).missingScopes || ((account.scopes as any)?.missingScopes) || [];
              const needsReauth = missingScopes.length > 0 || (account.scopes && !account.scopes.hasGmailRead);
              const tokenExpired = account.healthy === false;
              const isHealthy = account.healthy === true && !needsReauth;
              const showReauth = needsReauth || tokenExpired;
              const permAccount = permAccounts.find((p) => p.email === account.email);
              const isExpanded = expandedAccounts.has(account.id);
              return (
                <div
                  key={account.id}
                  className={`rounded-md border overflow-hidden ${
                    showReauth ? "border-destructive/40 bg-destructive/5" : isHealthy ? "border-primary/30 bg-primary/5" : ""
                  }`}
                  data-testid={`google-account-${account.id}`}
                >
                <div className="flex items-center gap-3 p-3">
                  {showReauth ? (
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                  ) : isHealthy ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate" data-testid={`text-account-email-${account.id}`}>
                        {account.email}
                      </span>
                      <Badge variant="secondary" className="bg-cat-channel/15 text-cat-channel-foreground border border-cat-channel/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid={`badge-account-label-${account.id}`}>
                        {account.label}
                      </Badge>
                      {tokenExpired && (
                        <Badge variant="destructive" data-testid={`badge-token-expired-${account.id}`}>
                          Token Expired
                        </Badge>
                      )}
                      {needsReauth && !tokenExpired && (
                        <Badge variant="destructive" data-testid={`badge-needs-reauth-${account.id}`}>
                          Missing permissions
                        </Badge>
                      )}
                      {missingScopes.length > 0 && (
                        <span className="text-xs text-destructive" data-testid={`text-missing-scopes-${account.id}`}>
                          Missing: {missingScopes.map(s => s.split('/').pop() || s).join(', ')}
                        </span>
                      )}
                      {isHealthy && (
                        <Badge variant="default" data-testid={`badge-verified-${account.id}`}>
                          Verified
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-account-date-${account.id}`}>
                      Added {new Date(account.addedAt).toLocaleDateString()}
                      {account.healthError && <span className="text-destructive ml-2">— {account.healthError}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant={showReauth ? "outline" : "ghost"}
                      size="sm"
                      onClick={async () => {
                        try {
                          const res = await apiRequest("POST", "/api/gmail/accounts/add", { label: account.label });
                          const data = await res.json();
                          if (data.url) {
                            window.open(data.url, "_blank", "width=500,height=700");
                            setTimeout(() => {
                              queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
                              queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
                            }, 5000);
                          }
                        } catch (err: any) {
                          log.error("Google reauth failed:", err);
                          toast({ title: "Failed to start re-authorization", description: err.message, variant: "destructive" });
                        }
                      }}
                      data-testid={`button-reauth-account-${account.id}`}
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      Reconnect
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeMutation.mutate(account.id)}
                      disabled={removeMutation.isPending}
                      data-testid={`button-remove-account-${account.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleExpanded(account.id)}
                      data-testid={`button-expand-perms-${account.id}`}
                    >
                      <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                    </Button>
                  </div>
                </div>
                {isExpanded && permAccount && (
                  <div className="px-3 pb-3 space-y-4 border-t pt-3">
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Gmail</h4>
                      {GMAIL_PERMISSIONS.map((perm) => (
                        <div key={perm.key} className="flex items-center justify-between gap-3 py-1.5 min-h-[44px]" data-testid={`perm-row-${permAccount.accountId}-${perm.key}`}>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium">{perm.label}</div>
                            <div className="text-xs text-muted-foreground">{perm.description}</div>
                          </div>
                          <Switch
                            checked={permAccount.permissions[perm.key]}
                            onCheckedChange={() => handlePermToggle(permAccount.accountId, perm.key, permAccount.permissions[perm.key])}
                            disabled={permMutation.isPending}
                            data-testid={`switch-perm-${permAccount.accountId}-${perm.key}`}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="border-t" />
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Calendar</h4>
                      {CALENDAR_PERMISSIONS.map((perm) => (
                        <div key={perm.key} className="flex items-center justify-between gap-3 py-1.5 min-h-[44px]" data-testid={`perm-row-${permAccount.accountId}-${perm.key}`}>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium">{perm.label}</div>
                            <div className="text-xs text-muted-foreground">{perm.description}</div>
                          </div>
                          <Switch
                            checked={permAccount.permissions[perm.key]}
                            onCheckedChange={() => handlePermToggle(permAccount.accountId, perm.key, permAccount.permissions[perm.key])}
                            disabled={permMutation.isPending}
                            data-testid={`switch-perm-${permAccount.accountId}-${perm.key}`}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                </div>
              );
            })}
          </div>
        )}

        {showAddForm && (
          <div className="border rounded-md p-3 space-y-2">
            <label className="text-xs font-medium">Account label</label>
            <div className="flex gap-2">
              <Select value={addLabel} onValueChange={setAddLabel}>
                <SelectTrigger data-testid="select-google-account-label" className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Work">Work</SelectItem>
                  <SelectItem value="Personal">Personal</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={async () => {
                  try {
                    const res = await apiRequest("POST", "/api/gmail/accounts/add", { label: addLabel });
                    const data = await res.json();
                    if (data.url) {
                      window.open(data.url, "_blank", "width=500,height=700");
                      setTimeout(() => {
                        queryClient.invalidateQueries({ queryKey: ["/api/gmail/accounts"] });
                        setShowAddForm(false);
                      }, 5000);
                    }
                  } catch (err: any) {
                    log.error("Google OAuth failed:", err);
                    toast({ title: "Failed to start OAuth", description: err.message, variant: "destructive" });
                  }
                }}
                data-testid="button-connect-google-account"
              >
                Connect
              </Button>
            </div>
          </div>
        )}

        <Button
          variant="outline"
          onClick={() => setShowAddForm(!showAddForm)}
          data-testid="button-add-google-account"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Add Google Account
        </Button>
      </CardContent>
    </Card>
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5" />
            Financial Accounts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground" data-testid="text-plaid-not-configured">
            To connect bank accounts, set the following environment variables:
          </p>
          <ul className="space-y-1.5 text-sm" data-testid="list-plaid-config-status">
            <li className="flex items-center gap-2" data-testid="status-plaid-client-id">
              <span className={clientIdOk ? "text-success-foreground" : "text-error-foreground"}>
                {clientIdOk ? "✓" : "✗"}
              </span>
              <code className="text-xs bg-muted px-1 py-0.5 rounded">PLAID_CLIENT_ID</code>
              {clientIdOk ? (
                <span className="text-muted-foreground">set</span>
              ) : (
                <span className="text-error-foreground">not set</span>
              )}
            </li>
            <li className="flex items-center gap-2" data-testid="status-plaid-secret">
              <span className={secretOk ? "text-success-foreground" : "text-error-foreground"}>
                {secretOk ? "✓" : "✗"}
              </span>
              <code className="text-xs bg-muted px-1 py-0.5 rounded">PLAID_SECRET</code>
              {secretOk ? (
                <span className="text-muted-foreground">set</span>
              ) : (
                <span className="text-error-foreground">not set</span>
              )}
            </li>
            <li className="flex items-center gap-2" data-testid="status-plaid-env">
              <span className={envOk ? "text-success-foreground" : "text-error-foreground"}>
                {envOk ? "✓" : "✗"}
              </span>
              <code className="text-xs bg-muted px-1 py-0.5 rounded">PLAID_ENV</code>
              {envOk ? (
                <span className="text-muted-foreground">{envValue}</span>
              ) : !envSet ? (
                <span className="text-error-foreground">not set — must be <code className="text-xs">sandbox</code>, <code className="text-xs">development</code>, or <code className="text-xs">production</code></span>
              ) : (
                <span className="text-error-foreground">invalid value &ldquo;{envValue}&rdquo; — must be <code className="text-xs">sandbox</code>, <code className="text-xs">development</code>, or <code className="text-xs">production</code></span>
              )}
            </li>
          </ul>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Landmark className="h-5 w-5" />
          Financial Accounts
        </CardTitle>
        <div className="flex items-center gap-2">
          {accounts && accounts.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              data-testid="button-refresh-finance"
            >
              <RefreshCw className={cn("h-4 w-4", refreshMutation.isPending && "animate-spin")} />
            </Button>
          )}
          <PlaidLinkButton onSuccess={(token) => exchangeMutation.mutate(token)} />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !accounts || accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-plaid-accounts">
            No financial accounts connected yet. Click "Connect Bank" to link your accounts.
          </p>
        ) : (
          <div className="space-y-3">
            {accounts.map((item) => (
              <div
                key={item.accountId}
                className="flex items-center justify-between p-3 border rounded-lg"
                data-testid={`card-plaid-item-${item.accountId}`}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    item.healthy ? "bg-success" : "bg-error"
                  )} />
                  <div>
                    <p className="text-sm font-medium" data-testid={`text-institution-${item.accountId}`}>
                      {item.institutionName || "Unknown Institution"}
                    </p>
                    {item.accounts && item.accounts.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {item.accounts.length} account{item.accounts.length !== 1 ? "s" : ""} — {
                          item.accounts.map(a => a.type).filter((v, i, arr) => arr.indexOf(v) === i).join(", ")
                        }
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeMutation.mutate(item.accountId)}
                  disabled={removeMutation.isPending}
                  data-testid={`button-remove-plaid-${item.accountId}`}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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

function isAppleCredentialsBlock(run: ExpoBuildLogRun | null | undefined): boolean {
  const text = `${run?.result?.guidance || ""}
${run?.result?.stderr || ""}
${run?.result?.error || ""}`.toLowerCase();
  return text.includes("credentials suitable for internal distribution") || text.includes("interactive credential setup");
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
  publicUrlMismatch?: boolean;
  error?: string;
}

function IntegrationTreeSection({
  label,
  children,
  initialOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex min-h-11 w-full items-center gap-1.5 rounded-md px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover-elevate"
        data-testid={`button-recall-section-${label.toLowerCase().replaceAll(" ", "-")}`}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0 space-y-0">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
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

      {recallStatus?.publicUrlMismatch && (
        <div
          className="mx-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          data-testid="banner-recall-public-url-mismatch"
        >
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            PUBLIC_URL mismatch
          </div>
          <p className="mt-1 text-muted-foreground">
            This deployment serves <code>{recallStatus.servingHost}</code> but its{" "}
            <code>PUBLIC_URL</code> Railway variable is <code>{recallStatus.publicUrl ?? "unset"}</code>.
            Webhook URLs below use the serving host, but fix the Railway variable for environment{" "}
            <code>{recallStatus.runtimeEnvironment}</code> to clear this warning.
          </p>
        </div>
      )}

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
  mediaStreamUrl?: string;
  servingHost?: string | null;
  publicUrl?: string | null;
  publicUrlMismatch?: boolean;
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
      {status?.publicUrlMismatch && <div className="mx-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"><div className="flex items-center gap-2 font-medium text-warning"><AlertTriangle className="h-4 w-4" />PUBLIC_URL mismatch</div><p className="mt-1 text-muted-foreground">Callbacks use the serving host <code>{status.servingHost}</code>, not <code>{status.publicUrl}</code>.</p></div>}
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
        <ProfileTreeRow label="Media stream" icon={<Radio className="h-3.5 w-3.5" />} hasValue showEmpty><code className="break-all text-xs">{status?.mediaStreamUrl ?? "Available after setup"}</code></ProfileTreeRow>
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
  return <div className="min-w-0 space-y-2"><IntegrationTreeSection label="Connection" initialOpen={!status?.connected}><ProviderConnectionRow provider="deepgram" connected={Boolean(status?.connected)} error={status?.error} pending={test.isPending} onTest={() => test.mutate()} /></IntegrationTreeSection><IntegrationTreeSection label="Credentials" initialOpen={!status?.hasApiKey}><div className="min-w-0 px-2 py-1.5"><SecretsForSection section="deepgram" /></div></IntegrationTreeSection></div>;
}

function SentryDetail() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Shield className="h-4 w-4" />
            Sentry Crash Reporting
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
            Add these values to activate mobile crash reporting and symbolicated stack traces. Build &gt; Mobile reads this same setup status, so Sentry will stay visibly inactive until the required keys are present.
          </div>
          <SecretsForSection section="sentry" />
          <div className="grid gap-2 text-xs text-muted-foreground @md:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="font-medium text-foreground">Mobile app runtime</div>
              <p>Requires <code>EXPO_PUBLIC_SENTRY_DSN</code>. This DSN is client-safe and lets the app send crash reports.</p>
            </div>
            <div className="rounded-lg border p-3">
              <div className="font-medium text-foreground">EAS source maps</div>
              <p>Requires <code>SENTRY_AUTH_TOKEN</code>, <code>SENTRY_ORG</code>, and <code>SENTRY_PROJECT</code>. Add the auth token as an EAS secret before relying on production stack traces.</p>
            </div>
          </div>
        </CardContent>
      </Card>
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
  const credentialsBlocked = isAppleCredentialsBlock(buildLogData?.run);
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
  const appleCredentialBadgeVariant = easRunStatus === "success" ? "default" : easRunStatus === "failed" || credentialsBlocked ? "destructive" : "secondary";

  return (
    <div className="space-y-4">
      <Card data-testid="card-expo-token">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Expo Access Token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SecretsForSection section="expo" />
          <p className="text-xs text-muted-foreground">
            Create a token at{" "}
            <a href="https://expo.dev/settings/access-tokens" target="_blank" rel="noopener noreferrer" className="underline text-primary">
              expo.dev → Account Settings → Access Tokens
            </a>
            . Use a "Personal" token with no scope restrictions.
          </p>
        </CardContent>
      </Card>

      <Card data-testid="card-expo-account">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Account Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {statusLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : expoStatus?.connected ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm font-medium">Connected as @{expoStatus.username}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Account</span>
                  <p>{expoStatus.accountName}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Organizations</span>
                  <p>{expoStatus.accounts?.length || 1}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Build and deploy from the{" "}
                <a href="/platforms/environments/13" className="underline text-primary">Platforms → Mantra / Mobile / dev</a> page.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {expoStatus?.error || "Not connected. Add your access token above."}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-expo-app-configuration">
        <CardHeader>
          <CardTitle className="text-base font-semibold">App Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Bundle ID</span>
              <p className="font-mono text-xs">com.oniops.firstglasses</p>
            </div>
            <div>
              <span className="text-muted-foreground">Deep Link</span>
              <p className="font-mono text-xs">agentglasses://</p>
            </div>
            <div>
              <span className="text-muted-foreground">Framework</span>
              <p>Expo ~52 + Router</p>
            </div>
            <div>
              <span className="text-muted-foreground">Voice SDK</span>
              <p>ElevenLabs RN</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-expo-apple-credentials">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-semibold">Apple Signing Credentials</CardTitle>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>Required once for iOS device builds through EAS.</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Badge variant={appleCredentialBadgeVariant} data-testid="badge-expo-apple-credentials">
              {appleCredentialStatus}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 @md:grid-cols-3 text-sm">
            <div>
              <span className="text-muted-foreground">Bundle</span>
              <p className="font-medium">{appleCredentials?.bundleIdentifier || "Not set"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Apple Team</span>
              <p className="font-medium">{appleCredentials?.teamId || "Not set"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Last EAS run</span>
              <p className="font-medium capitalize">{easRunStatus}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => setCredentialsWizardOpen(true)}
              disabled={!expoStatus?.connected || !projectConfig?.configured}
              data-testid="button-expo-open-credentials-wizard"
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              {activeInteractiveEasRun ? "Continue setup" : appleCredentialsConfigured ? "Set up credentials" : "Start setup"}
            </Button>
            {!projectConfig?.configured && (
              <p className="text-sm text-muted-foreground">Link the Expo project before configuring Apple signing.</p>
            )}
          </div>
        </CardContent>
      </Card>

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

      <Card data-testid="card-expo-dependencies">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Dependencies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>ElevenLabs Agent</span>
            <Badge
              variant={elevenlabsReady ? "default" : "secondary"}
              data-testid="badge-expo-elevenlabs"
            >
              {elevenlabsReady ? "Ready" : "Not configured"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            The mobile app uses the same ElevenLabs Conversational AI agent as the web voice client.
            Configure it on the ElevenLabs integration page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration Grid
// ---------------------------------------------------------------------------

function IntegrationGrid({
  status,
}: {
  status: Record<string, any> | undefined;
}) {
  const [, setLocation] = useLocation();

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 @sm:grid-cols-2 @lg:grid-cols-4 gap-4">
        {INTEGRATIONS.map((integration) => {
          const s = resolveStatus(integration, status);
          const Icon = integration.icon;
          return (
            <Card
              key={integration.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setLocation(`/integrations/${integration.route}`)}
              data-testid={`tile-${integration.id}`}
            >
              <CardContent className="flex flex-col items-center gap-3 pt-6 pb-4">
                <Icon className="h-8 w-8 text-muted-foreground" />
                <span className="text-sm font-medium">{integration.name}</span>
                <Badge
                  variant={s === "ready" ? "default" : s === "error" ? "destructive" : "secondary"}
                  data-testid={`badge-tile-${integration.id}`}
                >
                  {s === "ready" ? "Ready" : s === "error" ? "Error" : "Connect"}
                </Badge>
              </CardContent>
            </Card>
          );
        })}
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
  const applicationStatus = data.applicationIdConfigured || !!draft.applicationId?.trim();
  const mwdatStatus = data.mwdatConfigured || !!draft.mwdatPlistEntry?.trim();

  return (
    <div className="space-y-4">
      <Card data-testid="card-meta-wearables">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base font-semibold">Wearables / Device Access Toolkit</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Source of truth for Ray-Ban Display DAT registration used by the iOS Magic Demo build.
              </p>
            </div>
            <Badge variant={data.enabled ? "default" : "secondary"} data-testid="badge-meta-wearables-status">
              {data.enabled ? "Configured" : "Draft"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 @md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="input-meta-bundle-id">iOS Bundle ID</Label>
              <Input
                id="input-meta-bundle-id"
                value={draft.bundleId ?? ""}
                onChange={(e) => updateDraft("bundleId", e.target.value)}
                className="font-mono text-xs"
                data-testid="input-meta-bundle-id"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="input-meta-universal-link">Universal Link</Label>
              <Input
                id="input-meta-universal-link"
                value={draft.universalLink ?? ""}
                onChange={(e) => updateDraft("universalLink", e.target.value)}
                className="font-mono text-xs"
                data-testid="input-meta-universal-link"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="input-meta-release-channel">Release Channel</Label>
              <Input
                id="input-meta-release-channel"
                value={draft.releaseChannel ?? ""}
                onChange={(e) => updateDraft("releaseChannel", e.target.value)}
                data-testid="input-meta-release-channel"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="input-meta-application-id">Application ID</Label>
              <Input
                id="input-meta-application-id"
                type="password"
                value={draft.applicationId ?? ""}
                onChange={(e) => updateDraft("applicationId", e.target.value)}
                placeholder={data.applicationIdConfigured ? `Already saved ••••${data.applicationIdLast4 ?? ""}` : "Paste Meta Application ID"}
                className="font-mono text-xs"
                data-testid="input-meta-application-id"
              />
              <p className="text-xs text-muted-foreground">
                {applicationStatus ? "Application ID saved or staged." : "Required for registered-app mode."}
              </p>
            </div>
          </div>

          <div className="flex flex-col @sm:flex-row gap-4 border rounded-md p-3 bg-muted/20">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={!!draft.enabled}
                onCheckedChange={(checked) => updateDraft("enabled", checked === true)}
                data-testid="checkbox-meta-enabled"
              />
              Enable Meta integration
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={developerMode}
                onCheckedChange={(checked) => updateDraft("developerMode", checked === true)}
                data-testid="checkbox-meta-developer-mode"
              />
              Developer Mode first
            </label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="textarea-meta-mwdat">MWDAT Info.plist entry</Label>
            <Textarea
              id="textarea-meta-mwdat"
              value={draft.mwdatPlistEntry ?? ""}
              onChange={(e) => updateDraft("mwdatPlistEntry", e.target.value)}
              placeholder={data.mwdatConfigured ? "Already saved. Paste a new value only if rotating/updating." : "Paste the <key>MWDAT</key> plist block from Meta"}
              className="min-h-28 font-mono text-xs"
              data-testid="textarea-meta-mwdat"
            />
            <p className="text-xs text-muted-foreground">
              {mwdatStatus ? "MWDAT plist config saved or staged." : "Leave empty for pure Developer Mode validation."}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="textarea-meta-notes">Notes</Label>
            <Textarea
              id="textarea-meta-notes"
              value={draft.notes ?? ""}
              onChange={(e) => updateDraft("notes", e.target.value)}
              placeholder="Camera access rationale, org/app notes, tester/channel details"
              className="min-h-20"
              data-testid="textarea-meta-notes"
            />
          </div>

          <div className="rounded-md border p-3 space-y-2 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">iOS build consumption</div>
            <ul className="list-disc pl-4 space-y-1">
              <li>{developerMode ? "Developer Mode build uses the URL-scheme callback and should omit Associated Domains unless the Apple profile has that capability." : <>Enable associated domain entitlement for <span className="font-mono">applinks:{(draft.universalLink || data.universalLink).replace(/^https?:\/\//, "")}</span> after the Apple profile supports it.</>}</li>
              <li>{developerMode ? "AASA hosting is optional for this first validation path." : <>Host <span className="font-mono">/.well-known/apple-app-site-association</span> on the universal-link domain.</>}</li>
              <li>{developerMode ? "First build can use MWDAT MetaAppID=0 for Developer Mode validation." : "Registered-app build should inject the MWDAT plist entry."}</li>
            </ul>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => saveMutation.mutate(draft)}
              disabled={saveMutation.isPending}
              data-testid="button-save-meta-wearables"
            >
              {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Save Wearables Config
            </Button>
          </div>
        </CardContent>
      </Card>
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
    mutationFn: async () => {
      const res = await fetch("/api/oura/oauth/start");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start Oura OAuth");
      return data as { url: string };
    },
    onSuccess: ({ url }) => {
      const popup = window.open(url, "oura-oauth", "width=600,height=760,scrollbars=yes");
      if (!popup) {
        toast({ title: "Popup blocked", description: "Allow popups and try again.", variant: "destructive" });
        return;
      }
      toast({ title: "Oura authorization opened", description: "Finish the Oura approval, then return here." });
      const check = setInterval(() => {
        if (popup.closed) {
          clearInterval(check);
          queryClient.invalidateQueries({ queryKey: ["/api/oura/status"] });
        }
      }, 750);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to start Oura connection", description: err.message, variant: "destructive" });
    },
  });

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
    <div className="space-y-4" data-testid="oura-detail">
      <Card data-testid="card-secret-oura">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Oura API Credentials
          </CardTitle>
          <OuraStatusBadge status={status} />
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground" data-testid="text-oura-copy">
            Connect Oura once. Agent will pull sleep, readiness, activity, workouts, heart rate, and recovery signals into Health without manual exports.
          </p>
          <SecretsForSection section="oura" />
        </CardContent>
      </Card>

      <Card data-testid="card-oura-account">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <HeartPulse className="h-4 w-4" />
            Ring Connection
          </CardTitle>
          <div className="flex items-center gap-2">
            {status?.connected && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                data-testid="button-sync-oura"
              >
                {syncMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Sync now
              </Button>
            )}
            {!status?.connected && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => connectMutation.mutate()}
                disabled={!status?.oauthConfigured || connectMutation.isPending}
                data-testid="button-connect-oura"
              >
                {connectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plug className="h-3.5 w-3.5 mr-1.5" />}
                Connect Oura
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      {status?.connected && (
        <div className="grid gap-4 @lg:grid-cols-2">
          <Card data-testid="card-oura-scopes">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Scopes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {scopes.length > 0 ? scopes.map((scope) => (
                  <Badge key={scope} variant="outline" className="font-mono text-xs" data-testid={`badge-oura-scope-${scope}`}>{scope}</Badge>
                )) : <span className="text-sm text-muted-foreground">No scopes reported.</span>}
              </div>
              {missingScopes.length > 0 && (
                <p className="text-xs text-destructive">Missing: {missingScopes.join(", ")}</p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-oura-webhooks">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Automatic Updates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Webhook token</span>
                <Badge variant={status?.webhookConfigured ? "outline" : "secondary"} data-testid="badge-oura-webhook-token">
                  {status?.webhookConfigured ? "Configured" : "Not set"}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Subscriptions</span>
                <span className="text-sm font-medium" data-testid="text-oura-webhook-count">{webhooks?.subscriptions?.length || 0}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Last notification</span>
                <span className="text-sm text-right" data-testid="text-oura-last-webhook">{formatOuraDateTime(webhooks?.lastNotificationAt)}</span>
              </div>
              {webhooks?.lastSubscriptionError && (
                <p className="text-xs text-warning-foreground border-t pt-3" data-testid="text-oura-webhook-warning">{webhooks.lastSubscriptionError}</p>
              )}
              <p className="text-xs text-muted-foreground border-t pt-3">Webhooks only trigger bounded syncs. Health data still comes from Oura API reads.</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration Detail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub detail — multi-credential management
// ---------------------------------------------------------------------------

interface GitHubCredential {
  id: number;
  label: string;
  githubLogin: string | null;
  last4: string;
  urlPatterns: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}


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

interface GitHubStatus {
  connected: boolean;
  status?: "connected" | "disconnected" | "error";
  error?: string;
  login?: string;
  repoUrlSet: boolean;
  repoUrlDisplay?: string;
  credentials?: GitHubCredential[];
}

function GitHubDetail() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<GitHubStatus>({
    queryKey: ["/api/integrations/github/status"],
  });

  const { data: credsData, refetch: refetchCreds } = useQuery<{ ok: boolean; credentials: GitHubCredential[] }>({
    queryKey: ["/api/integrations/github/credentials"],
  });
  const credentials = credsData?.credentials || data?.credentials || [];

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

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [patternsInput, setPatternsInput] = useState("");
  const [isDefaultInput, setIsDefaultInput] = useState(false);
  const [validatedLogin, setValidatedLogin] = useState<string | null>(null);
  const [showProviderDialog, setShowProviderDialog] = useState(false);
  const [editingProviderConnection, setEditingProviderConnection] = useState<ProviderConnection | null>(null);
  const [providerLabelInput, setProviderLabelInput] = useState("");
  const [providerTokenInput, setProviderTokenInput] = useState("");
  const [providerAccountTypeInput, setProviderAccountTypeInput] = useState("source");

  const addCredentialMutation = useMutation({
    mutationFn: async (params: { token: string; label: string; urlPatterns: string[]; isDefault: boolean }) => {
      const res = await apiRequest("POST", "/api/integrations/github/credentials", params);
      return (await res.json()) as { ok: boolean; credential: GitHubCredential };
    },
    onSuccess: (res) => {
      toast({ title: "Account added", description: `Connected as @${res.credential.githubLogin || "unknown"}.` });
      setShowAddDialog(false);
      setTokenInput("");
      setLabelInput("");
      setPatternsInput("");
      setIsDefaultInput(false);
      setValidatedLogin(null);
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/github/status"] });
      refetchCreds();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add account", description: err.message, variant: "destructive" });
    },
  });

  const updateCredentialMutation = useMutation({
    mutationFn: async (params: { id: number; label?: string; urlPatterns?: string[]; isDefault?: boolean }) => {
      const { id, ...body } = params;
      const res = await apiRequest("PUT", `/api/integrations/github/credentials/${id}`, body);
      return (await res.json()) as { ok: boolean; credential: GitHubCredential };
    },
    onSuccess: () => {
      toast({ title: "Credential updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/github/status"] });
      refetchCreds();
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteCredentialMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/integrations/github/credentials/${id}`);
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: () => {
      toast({ title: "Account removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/github/status"] });
      refetchCreds();
    },
    onError: (err: Error) => {
      toast({ title: "Remove failed", description: err.message, variant: "destructive" });
    },
  });

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

  const [repoUrlInput, setRepoUrlInput] = useState(data?.repoUrlDisplay ? `https://${data.repoUrlDisplay}` : "");

  const saveRepoUrlMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/integrations/github/repo-url", { url });
      return (await res.json()) as { ok: true; repoUrlSet: boolean };
    },
    onSuccess: (res) => {
      toast({ title: res.repoUrlSet ? "Repository URL saved" : "Repository URL cleared" });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/github/status"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save URL", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="github-tab-loading">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const connected = !!data?.connected || hasPlatformGitHubConnection;
  const hasError = !connected;
  const isProd = import.meta.env.MODE === "production";
  const repoMisconfigured = isProd && !data?.repoUrlSet;

  return (
    <div className="space-y-6" data-testid="github-tab">
      {hasError && credentials.length === 0 && !isLoadingProviderConnections && (
        <Card
          className="border-error/30 dark:border-error/50 bg-error/5 dark:bg-error/20"
          data-testid="github-error-banner"
        >
          <CardContent className="py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-error-foreground dark:text-error">
              <AlertTriangle className="h-4 w-4" />
              No GitHub credentials connected
            </div>
            <p className="text-sm text-muted-foreground">
              Add either a Platform GitHub connection or a legacy GitHub Personal Access Token to enable git operations.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Connected accounts */}
      <Card data-testid="github-accounts-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Legacy Accounts</CardTitle>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShowAddDialog(true)}
              data-testid="button-github-add-account"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Account
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {credentials.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No legacy accounts connected. Platform Connections below are preferred for new git operations.
            </p>
          )}

          {credentials.map((cred) => (
            <div
              key={cred.id}
              className="flex items-start justify-between gap-3 p-3 rounded-lg border bg-card"
              data-testid={`github-credential-${cred.id}`}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <CircleCheck className="h-3.5 w-3.5 text-success shrink-0" />
                  <span className="text-sm font-medium truncate">
                    {cred.githubLogin ? `@${cred.githubLogin}` : cred.label}
                  </span>
                  {cred.isDefault && (
                    <Badge variant="outline" className="text-xs shrink-0">default</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {cred.label}{cred.last4 ? ` · ••••${cred.last4}` : ""}
                </div>
                {cred.urlPatterns.length > 0 && (
                  <div className="text-xs text-muted-foreground font-mono">
                    {cred.urlPatterns.join(", ")}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!cred.isDefault && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 px-2"
                    onClick={() => updateCredentialMutation.mutate({ id: cred.id, isDefault: true })}
                    data-testid={`button-github-set-default-${cred.id}`}
                  >
                    Set default
                  </Button>
                )}
                {credentials.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 px-2 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Remove @${cred.githubLogin || cred.label}? Git operations using this credential will stop working.`)) {
                        deleteCredentialMutation.mutate(cred.id);
                      }
                    }}
                    data-testid={`button-github-remove-${cred.id}`}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card data-testid="github-platform-connections-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm font-medium">Platform Connections</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                GitHub provider connections used by Platforms source bindings. Credentials are stored encrypted and never displayed.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openProviderDialog()}
              data-testid="button-github-add-provider-connection"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Connection
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {githubConnections.length === 0 && (
            <div className="py-12 text-center rounded-md border border-dashed">
              <Github className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No GitHub platform connections yet.</p>
            </div>
          )}

          {githubConnections.map((connection) => {
            const usage = sourceUsageByConnectionId.get(connection.id) || [];
            const isTesting = testProviderConnectionMutation.isPending;
            return (
              <div
                key={connection.id}
                className="space-y-3 p-3 rounded-lg border bg-card"
                data-testid={`github-provider-connection-${connection.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <CircleCheck className={cn("h-3.5 w-3.5 shrink-0", connection.status === "active" ? "text-success" : "text-muted-foreground")} />
                      <span className="text-sm font-medium truncate">{connection.label}</span>
                      <Badge variant="outline" className="text-xs shrink-0">{connection.accountType || "source"}</Badge>
                      <Badge variant={connection.status === "active" ? "secondary" : "destructive"} className="text-xs shrink-0">
                        {connection.status}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ID {connection.id}
                      {connection.lastVerifiedAt ? ` · verified ${new Date(connection.lastVerifiedAt).toLocaleString()}` : " · not verified"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => testProviderConnectionMutation.mutate(connection)}
                      disabled={isTesting}
                      data-testid={`button-github-test-provider-${connection.id}`}
                    >
                      {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Activity className="h-3.5 w-3.5 mr-1.5" />}
                      Test
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => openProviderDialog(connection)}
                      data-testid={`button-github-edit-provider-${connection.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-1.5" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
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
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                      Delete
                    </Button>
                  </div>
                </div>

                <div className="space-y-2 border-t pt-3">
                  <div className="text-xs font-medium text-muted-foreground">Used by</div>
                  {usage.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No Platform source bindings currently use this connection.</p>
                  ) : (
                    <div className="space-y-1">
                      {usage.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-3 text-xs rounded-md bg-muted/30 px-2 py-1.5">
                          <span className="truncate">
                            {item.platformName} / {item.productName} / {item.environmentName}
                          </span>
                          <span className="font-mono text-muted-foreground truncate max-w-[45%] text-right">
                            {item.owner}/{item.repo}:{item.branch}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

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

      {/* Add Account Dialog */}
      {showAddDialog && (
        <Card className="border-primary/30" data-testid="github-add-dialog">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Add GitHub Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium">Personal Access Token</label>
              <div className="text-xs text-muted-foreground">
                Required scopes: <span className="font-mono">repo</span>{" "}
                <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                  Create a token <ExternalLink className="h-3 w-3 inline" />
                </a>
              </div>
              <Input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ghp_… or github_pat_…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                data-testid="input-github-add-token"
              />
            </div>

            {validatedLogin && (
              <div className="text-xs text-success-foreground flex items-center gap-1">
                <CircleCheck className="h-3 w-3" /> Validated as @{validatedLogin}
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-medium">Label</label>
              <Input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder={validatedLogin || "e.g., Personal Brand"}
                autoComplete="off"
                className="text-xs"
                data-testid="input-github-add-label"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">URL Patterns</label>
              <div className="text-xs text-muted-foreground">
                Comma-separated. E.g., <span className="font-mono">github.com/myorg/*</span>
              </div>
              <Input
                type="text"
                value={patternsInput}
                onChange={(e) => setPatternsInput(e.target.value)}
                placeholder={validatedLogin ? `github.com/${validatedLogin}/*` : "github.com/org/*"}
                autoComplete="off"
                className="font-mono text-xs"
                data-testid="input-github-add-patterns"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="github-add-default"
                checked={isDefaultInput}
                onChange={(e) => setIsDefaultInput(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="github-add-default" className="text-xs text-muted-foreground">
                Set as default credential
              </label>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const v = tokenInput.trim();
                  if (!v) {
                    toast({ title: "Token required", variant: "destructive" });
                    return;
                  }
                  const patterns = patternsInput
                    .split(",")
                    .map((p) => p.trim())
                    .filter(Boolean);
                  addCredentialMutation.mutate({
                    token: v,
                    label: labelInput.trim(),
                    urlPatterns: patterns,
                    isDefault: isDefaultInput,
                  });
                }}
                disabled={addCredentialMutation.isPending}
                data-testid="button-github-add-save"
              >
                {addCredentialMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Add Account
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowAddDialog(false);
                  setTokenInput("");
                  setLabelInput("");
                  setPatternsInput("");
                  setIsDefaultInput(false);
                  setValidatedLogin(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="github-repo-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">GITHUB_REPO_URL</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Configured</span>
            {data?.repoUrlSet ? (
              <Badge
                className="bg-success/15 text-success-foreground border-success/30"
                data-testid="badge-repo-url-set"
              >
                Set
              </Badge>
            ) : (
              <Badge
                variant={repoMisconfigured ? "destructive" : "secondary"}
                data-testid="badge-repo-url-set"
              >
                Not set
              </Badge>
            )}
          </div>
          {data?.repoUrlSet && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">Repository</span>
              <span
                className="text-sm font-mono truncate max-w-[60%] text-right"
                data-testid="text-repo-url-display"
              >
                {data.repoUrlDisplay}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={repoUrlInput}
              onChange={(e) => setRepoUrlInput(e.target.value)}
              placeholder="https://github.com/org/repo"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              data-testid="input-repo-url"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                saveRepoUrlMutation.mutate(repoUrlInput.trim());
              }}
              disabled={saveRepoUrlMutation.isPending}
              data-testid="button-repo-url-save"
            >
              {saveRepoUrlMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Save
            </Button>
            {data?.repoUrlSet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (confirm("Clear GITHUB_REPO_URL? GitNexus will not be able to sync the repo in production.")) {
                    saveRepoUrlMutation.mutate("");
                  }
                }}
                disabled={saveRepoUrlMutation.isPending}
                data-testid="button-repo-url-clear"
              >
                Clear
              </Button>
            )}
          </div>

          {repoMisconfigured && (
            <div className="text-xs text-error-foreground border-t pt-3" data-testid="text-repo-url-warning">
              Production is running without GITHUB_REPO_URL. GitNexus cannot sync the repo from origin. Set it below or add it as an environment variable.
            </div>
          )}
          {!repoMisconfigured && !data?.repoUrlSet && (
            <div className="text-xs text-muted-foreground border-t pt-3">
              GITHUB_REPO_URL is optional in development. In production it is required so GitNexus can sync the repo on startup.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AutomationAuthSection() {
  const { toast } = useToast();
  const [showToken, setShowToken] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useQuery<{ configured: boolean; lastChars: string | null }>({
    queryKey: ["/api/integrations/automation-auth"],
  });

  const saveMutation = useMutation({
    mutationFn: async (body: { token?: string; generate?: boolean }) => {
      const res = await apiRequest("PUT", "/api/integrations/automation-auth", body);
      return res.json() as Promise<{ configured: boolean; lastChars: string | null; token?: string }>;
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

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <Card data-testid="card-automation-auth">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Automation Auth Token</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Shared bearer token for cross-instance automation authentication. Used by test runners, Playwright, and agent calls. Set the same token on both Dev and Prod.
        </p>

        {data?.configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono">
                {showToken ? `••••••••••••••••••••••••${data.lastChars}` : "••••••••••••••••••••••••••••••••"}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setShowToken(!showToken)}
                data-testid="button-toggle-token-visibility"
              >
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveMutation.mutate({ generate: true })}
                disabled={saveMutation.isPending}
                data-testid="button-regenerate-token"
              >
                {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Regenerate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setManualMode(!manualMode)}
                data-testid="button-manual-token"
              >
                Set manually
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate({ generate: true })}
              disabled={saveMutation.isPending}
              data-testid="button-generate-token"
            >
              {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Generate Token
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setManualMode(!manualMode)}
              data-testid="button-set-manual-token"
            >
              Set manually
            </Button>
          </div>
        )}

        {manualMode && (
          <div className="flex items-center gap-2 pt-1">
            <Input
              placeholder="Paste token (min 32 chars)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="flex-1 h-8 text-sm font-mono"
              data-testid="input-manual-token"
            />
            <Button
              size="sm"
              onClick={() => saveMutation.mutate({ token: draft })}
              disabled={!draft || draft.length < 32 || saveMutation.isPending}
              data-testid="button-save-manual-token"
            >
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
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
    <div className="space-y-4">
      <Card data-testid="card-sendgrid-status">
        <CardHeader>
          <CardTitle className="text-base font-semibold">SendGrid Email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading || !status ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={configured ? "default" : "secondary"} data-testid="badge-sendgrid-configured">
                  {configured ? "Configured" : "Not configured"}
                </Badge>
                <Badge variant={status.hasApiKey ? "default" : "outline"} data-testid="badge-sendgrid-api-key">
                  API key {status.hasApiKey ? "set" : "missing"}
                </Badge>
                <Badge variant={status.hasFromEmail ? "default" : "outline"} data-testid="badge-sendgrid-from-email">
                  From email {status.hasFromEmail ? "set" : "missing"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure Twilio SendGrid for Mantra outbound email. The API key stays server-side;
                the browser can only trigger authenticated sends through Mantra.
              </p>
            </>
          )}
          <SecretsForSection section="sendgrid" />
        </CardContent>
      </Card>

      <Card data-testid="card-sendgrid-test-email">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Send test email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="input-sendgrid-test-to">To</Label>
            <Input
              id="input-sendgrid-test-to"
              type="email"
              placeholder="ray@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="input-sendgrid-test-to"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="input-sendgrid-test-subject">Subject</Label>
            <Input
              id="input-sendgrid-test-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="input-sendgrid-test-subject"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="textarea-sendgrid-test-body">Body</Label>
            <Textarea
              id="textarea-sendgrid-test-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              data-testid="textarea-sendgrid-test-body"
            />
          </div>
          {!configured && (
            <p className="text-xs text-muted-foreground" data-testid="text-sendgrid-test-disabled">
              Set `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` before sending a test email.
            </p>
          )}
          <Button
            onClick={() => sendMutation.mutate()}
            disabled={!canSend}
            data-testid="button-sendgrid-send-test"
          >
            {sendMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
            Send test email
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function IntegrationDetail({ provider }: { provider: string }) {
  const [, setLocation] = useLocation();

  const integration = INTEGRATIONS.find((i) => i.route === provider);

  if (!integration) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setLocation("/integrations")} data-testid="button-back-to-grid">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Integrations
        </Button>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground" data-testid="text-integration-not-found">
              Integration not found.{" "}
              <button className="underline text-primary" onClick={() => setLocation("/integrations")}>
                Back to integrations
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const Icon = integration.icon;

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={() => setLocation("/integrations")} data-testid="button-back-to-grid">
        <ArrowLeft className="h-4 w-4 mr-2" />
        Integrations
      </Button>

      {provider !== "recall" && (
        <div className="flex items-center gap-3">
          <Icon className="h-6 w-6" />
          <h2 className="text-lg font-semibold">{integration.name}</h2>
        </div>
      )}

      {provider === "google" && (
        <div className="space-y-4">
          <Card data-testid="card-secret-google-oauth">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Google OAuth Client</CardTitle>
            </CardHeader>
            <CardContent>
              <SecretsForSection section="google" />
            </CardContent>
          </Card>
          <GoogleAccountsSection />
        </div>
      )}

      {provider === "elevenlabs" && (
        <div className="space-y-4">
          <Card data-testid="card-secret-elevenlabs">
            <CardHeader>
              <CardTitle className="text-base font-semibold">ElevenLabs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <SecretsForSection section="elevenlabs" excludeNames={["VOICE_V3_WEBHOOK_SECRET"]} />
              <VoiceV3WebhookSecretCard />
            </CardContent>
          </Card>
          <WebhookBaseUrlSection />
          <InstantVoiceCloneWizard />
          <VoiceBrowserSection />
          {/* Voice engine selector removed — single engine */}
          <ExpressivenessSection />
          <VoiceTuningSection />
          <PronunciationSection />
        </div>
      )}

      {provider === "cartesia" && (
        <Card className="overflow-hidden min-w-0" data-testid="card-secret-cartesia">
          <CardHeader><CardTitle className="text-base font-semibold">Cartesia meeting speech</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Primary low-latency voice for answers spoken into live meetings. ElevenLabs is used automatically when Cartesia fails or is not configured.</p>
            <SecretsForSection section="cartesia" />
          </CardContent>
        </Card>
      )}

      {provider === "openai" && (
        <div className="space-y-4">
          <OpenAISubscriptionSection />
        </div>
      )}

      {provider === "claude-cli" && (
        <div className="space-y-4">
          <Card data-testid="card-secret-claude-cli">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Claude Code CLI</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">System integration. Visible to all users; admin-only to edit.</p>
              <SecretsForSection section="claude-cli" />
            </CardContent>
          </Card>
        </div>
      )}

      {provider === "twitter" && (
        <div className="space-y-4">
          <TwitterAccountsSection />
        </div>
      )}

      {provider === "plaid" && (
        <div className="space-y-4">
          <Card data-testid="card-secret-plaid">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Plaid</CardTitle>
            </CardHeader>
            <CardContent>
              <SecretsForSection section="plaid" />
            </CardContent>
          </Card>
          <PlaidAccountsSection />
        </div>
      )}

      {provider === "brave" && (
        <div className="space-y-4">
          <Card data-testid="card-secret-brave">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Brave Search</CardTitle>
            </CardHeader>
            <CardContent>
              <SecretsForSection section="brave" />
            </CardContent>
          </Card>
        </div>
      )}

      {provider === "github" && <GitHubDetail />}

      {provider === "railway" && <RailwaySetupTab />}

      {provider === "automation-auth" && (
        <div className="space-y-4">
          <AutomationAuthSection />
        </div>
      )}

      {provider === "expo" && <ExpoDetail />}
      {provider === "sentry" && <SentryDetail />}
      {provider === "recall" && <RecallDetail />}
      {provider === "twilio" && <TwilioDetail />}
      {provider === "deepgram" && <DeepgramDetail />}
      {provider === "sendgrid" && <SendGridDetail />}
      {provider === "meta" && <MetaDetail />}

      {provider === "oura" && <OuraDetail />}
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

  usePageHeader({ title: "Integrations" });

  const [match, params] = useRoute("/integrations/:provider");

  return (
    <div className="flex flex-col gap-6 p-6">
      {match && params?.provider ? (
        <IntegrationDetail provider={params.provider} />
      ) : (
        <IntegrationGrid status={status} />
      )}
    </div>
  );
}
