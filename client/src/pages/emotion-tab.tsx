import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CloudRain,
  Eye,
  Heart,
  Loader2,
  Moon,
  Plus,
  Search,
  Sparkles,
  Sun,
  Target,
  Zap,
} from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

/* ── Types ── */

interface EmotionalState {
  id: string;
  mood: string;
  stateName: string;
  valence: number;
  arousal: number;
  intensity: number;
  triggers: string[];
  context: string;
  narrative: string;
  source: "explicit" | "inferred" | "behavioral";
  active: boolean;
  stale: boolean;
  createdAt: string;
}

interface SeedState {
  name: string;
  valence: number;
  arousal: number;
  guidance: string;
}

/* ── Helpers ── */

function valenceLabel(v: number): string {
  if (v > 0.5) return "very positive";
  if (v > 0.15) return "positive";
  if (v > -0.15) return "neutral";
  if (v > -0.5) return "negative";
  return "very negative";
}

function arousalLabel(v: number): string {
  if (v > 0.7) return "high energy";
  if (v > 0.4) return "moderate energy";
  return "low energy";
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

/* ── Emotion → Icon mapping ── */

const EMOTION_ICONS: Record<string, typeof Heart> = {
  focused: Target,
  curious: Search,
  calm: Moon,
  energized: Zap,
  reflective: Eye,
  warm: Sun,
  melancholy: CloudRain,
  tense: AlertTriangle,
  frustrated: AlertTriangle,
  playful: Sparkles,
  determined: Target,
  contemplative: Eye,
  anxious: AlertTriangle,
};

function getEmotionIcon(name: string): typeof Heart {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(EMOTION_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return Heart;
}

/* ── Seed states ── */

const SEED_STATES: SeedState[] = [
  { name: "Focused", valence: 0.2, arousal: 0.6, guidance: "Engaged and attentive." },
  { name: "Curious", valence: 0.3, arousal: 0.65, guidance: "Open and exploratory." },
  { name: "Calm", valence: 0.15, arousal: 0.2, guidance: "Settled and present." },
  { name: "Energized", valence: 0.5, arousal: 0.85, guidance: "Alive and activated." },
  { name: "Reflective", valence: 0, arousal: 0.25, guidance: "Turning inward." },
  { name: "Warm", valence: 0.6, arousal: 0.4, guidance: "Connected and appreciative." },
  { name: "Melancholy", valence: -0.4, arousal: 0.2, guidance: "Quiet sadness." },
  { name: "Tense", valence: -0.3, arousal: 0.75, guidance: "Sensing friction." },
];

/* ── Expanded state editor (mirrors People profile details) ── */

interface EmotionalStateBaseline {
  stateName: string;
  valence: number;
  arousal: number;
  triggers: string[];
  context: string;
  narrative: string;
}

interface EmotionalStateUpdate {
  stateName?: string;
  valence?: number;
  arousal?: number;
  triggers?: string[];
  context?: string;
  narrative?: string;
  clearFields?: Array<"triggers" | "context" | "narrative">;
}

interface EmotionalStateUpdateRequest extends EmotionalStateUpdate {
  expected: EmotionalStateBaseline;
}

function stateBaseline(state: EmotionalState): EmotionalStateBaseline {
  return {
    stateName: state.stateName || state.mood,
    valence: state.valence,
    arousal: state.arousal,
    triggers: state.triggers,
    context: state.context || "",
    narrative: state.narrative || "",
  };
}

function StateDetail({ state, narrativeTestId }: { state: EmotionalState; narrativeTestId?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [stateName, setStateName] = useState(state.stateName || state.mood);
  const [valence, setValence] = useState([state.valence]);
  const [arousal, setArousal] = useState([state.arousal]);
  const [narrative, setNarrative] = useState(state.narrative || "");
  const [triggerText, setTriggerText] = useState(state.triggers.join(", "));
  const [context, setContext] = useState(state.context || "");
  const baselineRef = useRef(stateBaseline(state));
  const dirtyRef = useRef(false);

  const resetDraft = () => {
    setStateName(state.stateName || state.mood);
    setValence([state.valence]);
    setArousal([state.arousal]);
    setNarrative(state.narrative || "");
    setTriggerText(state.triggers.join(", "));
    setContext(state.context || "");
  };

  useEffect(() => {
    if (dirtyRef.current) return;
    baselineRef.current = stateBaseline(state);
    resetDraft();
  }, [state]);

  const mutation = useMutation({
    mutationFn: async (request: EmotionalStateUpdateRequest) => {
      const response = await apiRequest("PUT", `/api/emotional-state/${state.id}`, request);
      return response.json() as Promise<EmotionalState>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<EmotionalState | null>(["/api/emotional-state"], (current) =>
        current?.id === updated.id ? updated : current,
      );
      queryClient.setQueryData<EmotionalState[]>(["/api/emotional-state/history"], (history) =>
        history?.map((entry) => entry.id === updated.id ? updated : entry) || [],
      );
      baselineRef.current = stateBaseline(updated);
      dirtyRef.current = false;
      setStateName(updated.stateName || updated.mood);
      setValence([updated.valence]);
      setArousal([updated.arousal]);
      setNarrative(updated.narrative || "");
      setTriggerText(updated.triggers.join(", "));
      setContext(updated.context || "");
      toast({ title: "Emotional state updated" });
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/emotional-state"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emotional-state/history"] });
      toast({ title: "Could not update emotional state", description: error.message, variant: "destructive" });
    },
  });

  const buildUpdates = (): EmotionalStateUpdate => {
    const updates: EmotionalStateUpdate = {};
    const clearFields: NonNullable<EmotionalStateUpdate["clearFields"]> = [];
    const nextStateName = stateName.trim();
    const nextNarrative = narrative.trim();
    const nextContext = context.trim();
    const nextTriggers = triggerText.split(",").map((value) => value.trim()).filter(Boolean);

    if (nextStateName && nextStateName !== (state.stateName || state.mood)) updates.stateName = nextStateName;
    if (valence[0] !== state.valence) updates.valence = valence[0];
    if (arousal[0] !== state.arousal) updates.arousal = arousal[0];
    if (nextTriggers.join("|") !== state.triggers.join("|")) {
      if (nextTriggers.length > 0) updates.triggers = nextTriggers;
      else clearFields.push("triggers");
    }
    if (nextNarrative !== (state.narrative || "")) {
      if (nextNarrative) updates.narrative = nextNarrative;
      else clearFields.push("narrative");
    }
    if (nextContext !== (state.context || "")) {
      if (nextContext) updates.context = nextContext;
      else clearFields.push("context");
    }
    if (clearFields.length > 0) updates.clearFields = clearFields;
    return updates;
  };

  const updates = buildUpdates();
  const hasChanges = Object.keys(updates).length > 0;
  dirtyRef.current = hasChanges;
  const disabled = mutation.isPending;
  const save = () => mutation.mutate({ ...updates, expected: baselineRef.current });

  return (
    <div className="overflow-hidden rounded-md border border-border/20">
      <div className="max-h-80 max-w-none overflow-auto rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-[14px] leading-tight text-white scrollbar-thin">
        <Textarea
          value={narrative}
          disabled={disabled}
          onChange={(event) => setNarrative(event.target.value)}
          placeholder="Add narrative"
          className="min-h-24 w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-tight text-white shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-[14px]"
          data-testid={narrativeTestId || `textarea-emotion-narrative-${state.id}`}
        />
      </div>

      <ProfileTreeRow label="State" icon={<Heart className="h-3.5 w-3.5" />} hasValue showEmpty testId={`row-emotion-name-${state.id}`}>
        <Input
          value={stateName}
          disabled={disabled}
          onChange={(event) => setStateName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setStateName(state.stateName || state.mood);
              event.currentTarget.blur();
            }
          }}
          className="w-48"
          data-testid={`input-emotion-name-${state.id}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow
        label={<span>Valence <span className="font-normal text-muted-foreground/70">{valence[0].toFixed(2)}</span></span>}
        icon={<Target className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        testId={`row-emotion-valence-${state.id}`}
      >
        <Slider
          value={valence}
          disabled={disabled}
          onValueChange={setValence}
          min={-1}
          max={1}
          step={0.05}
          data-testid={`slider-emotion-valence-${state.id}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow
        label={<span>Arousal <span className="font-normal text-muted-foreground/70">{arousal[0].toFixed(2)}</span></span>}
        icon={<Zap className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        testId={`row-emotion-arousal-${state.id}`}
      >
        <Slider
          value={arousal}
          disabled={disabled}
          onValueChange={setArousal}
          min={0}
          max={1}
          step={0.05}
          data-testid={`slider-emotion-arousal-${state.id}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Triggers" icon={<AlertTriangle className="h-3.5 w-3.5" />} hasValue={state.triggers.length > 0} showEmpty testId={`row-emotion-triggers-${state.id}`}>
        <Input
          value={triggerText}
          disabled={disabled}
          onChange={(event) => setTriggerText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setTriggerText(state.triggers.join(", "));
              event.currentTarget.blur();
            }
          }}
          placeholder="Comma-separated"
          className="w-48"
          data-testid={`input-emotion-triggers-${state.id}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Context" icon={<Eye className="h-3.5 w-3.5" />} hasValue={Boolean(state.context)} showEmpty testId={`row-emotion-context-${state.id}`}>
        <Input
          value={context}
          disabled={disabled}
          onChange={(event) => setContext(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setContext(state.context || "");
              event.currentTarget.blur();
            }
          }}
          placeholder="Context"
          className="w-48"
          data-testid={`input-emotion-context-${state.id}`}
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Source" icon={<Search className="h-3.5 w-3.5" />} hasValue showEmpty testId={`row-emotion-source-${state.id}`}>
        <span className="capitalize text-muted-foreground">{state.source}</span>
      </ProfileTreeRow>

      <div className="flex justify-end gap-2 border-t border-border/20 p-2">
        <Button variant="ghost" size="sm" onClick={() => { resetDraft(); dirtyRef.current = false; }} disabled={!hasChanges || disabled} data-testid={`button-cancel-emotion-${state.id}`}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={!hasChanges || disabled || !stateName.trim()} data-testid={`button-save-emotion-${state.id}`}>
          {mutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

/* ── Emotion State Row (shared primitive: current state + history entries) ── */

function EmotionStateRow({
  state,
  testId,
  narrativeTestId,
}: {
  state: EmotionalState;
  testId?: string;
  narrativeTestId?: string;
}) {
  const name = state.stateName || state.mood;
  const Icon = getEmotionIcon(name);

  return (
    <ProfileTreeRow
      label={name}
      icon={<Icon className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      expandedContent={<StateDetail key={state.id} state={state} narrativeTestId={narrativeTestId} />}
      expandedContentClassName="pl-8 pr-2"
      testId={testId}
      mobileLayout="inline"
    >
      <span className="text-xs text-muted-foreground">{timeAgo(state.createdAt)}</span>
    </ProfileTreeRow>
  );
}

/* ── New State Form ── */

function NewStateForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [stateName, setStateName] = useState("");
  const [valence, setValence] = useState([0]);
  const [arousal, setArousal] = useState([0.5]);
  const [narrative, setNarrative] = useState("");
  const [triggerText, setTriggerText] = useState("");
  const { toast } = useToast();

  const handleSeed = (seed: SeedState) => {
    setStateName(seed.name);
    setValence([seed.valence]);
    setArousal([seed.arousal]);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const triggers = triggerText.split(",").map((s) => s.trim()).filter(Boolean);
      await apiRequest("POST", "/api/emotional-state", {
        stateName: stateName || "Manual Override",
        valence: valence[0],
        arousal: arousal[0],
        triggers,
        narrative: narrative || undefined,
        source: "explicit",
      });
    },
    onSuccess: () => {
      toast({ title: "Emotional state recorded" });
      onSuccess();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="overflow-hidden rounded-md border border-border/20">
      {/* Quick select seeds with icons */}
      <div className="space-y-1.5 border-b border-border/20 p-3">
        <Label className="text-xs text-muted-foreground">Quick select</Label>
        <div className="flex flex-wrap gap-1.5" data-testid="seed-state-buttons">
          {SEED_STATES.map((seed) => {
            const SeedIcon = getEmotionIcon(seed.name);
            return (
              <button
                key={seed.name}
                type="button"
                onClick={() => handleSeed(seed)}
                title={seed.guidance}
                className="flex items-center gap-1 rounded-md border border-border/50 bg-transparent px-2 py-1 text-xs transition-colors hover:bg-accent/70"
                data-testid={`button-seed-${seed.name.toLowerCase()}`}
              >
                <SeedIcon className="h-3 w-3" />
                {seed.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Editable fields as ProfileTreeRows */}
      <ProfileTreeRow label="State" icon={<Heart className="h-3.5 w-3.5" />} hasValue showEmpty testId="row-new-state-name">
        <Input
          value={stateName}
          onChange={(e) => setStateName(e.target.value)}
          placeholder="State name..."
          data-testid="input-state-name"
        />
      </ProfileTreeRow>

      <ProfileTreeRow
        label={<span>Valence <span className="font-normal text-muted-foreground/70">{valence[0].toFixed(2)}</span></span>}
        icon={<Target className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        testId="row-new-valence"
      >
        <Slider value={valence} onValueChange={setValence} min={-1} max={1} step={0.05} data-testid="slider-valence" />
      </ProfileTreeRow>

      <ProfileTreeRow
        label={<span>Arousal <span className="font-normal text-muted-foreground/70">{arousal[0].toFixed(2)}</span></span>}
        icon={<Zap className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        testId="row-new-arousal"
      >
        <Slider value={arousal} onValueChange={setArousal} min={0} max={1} step={0.05} data-testid="slider-arousal" />
      </ProfileTreeRow>

      <ProfileTreeRow label="Narrative" icon={<Eye className="h-3.5 w-3.5" />} hasValue showEmpty testId="row-new-narrative">
        <Textarea
          value={narrative}
          onChange={(e) => setNarrative(e.target.value)}
          placeholder="What's alive emotionally right now?"
          className="min-h-[48px] resize-y"
          data-testid="input-narrative"
        />
      </ProfileTreeRow>

      <ProfileTreeRow label="Triggers" icon={<AlertTriangle className="h-3.5 w-3.5" />} hasValue showEmpty testId="row-new-triggers">
        <Input
          value={triggerText}
          onChange={(e) => setTriggerText(e.target.value)}
          placeholder="Comma-separated"
          data-testid="input-triggers"
        />
      </ProfileTreeRow>

      {/* Actions */}
      <div className="flex gap-2 border-t border-border/20 p-3">
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !stateName}
          data-testid="button-submit-state"
        >
          {mutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          Record
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="button-cancel-state">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ── Page ── */

export default function EmotionTab() {
  const queryClient = useQueryClient();
  const [showNewForm, setShowNewForm] = useState(false);

  const { data: current, isLoading: loadingCurrent } = useQuery<EmotionalState | null>({
    queryKey: ["/api/emotional-state"],
    refetchInterval: 30000,
  });

  const { data: history, isLoading: loadingHistory } = useQuery<EmotionalState[]>({
    queryKey: ["/api/emotional-state/history"],
    refetchInterval: 60000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/emotional-state"] });
    queryClient.invalidateQueries({ queryKey: ["/api/emotional-state/history"] });
    setShowNewForm(false);
  };

  if (loadingCurrent && loadingHistory) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const historyEntries = (history || []).filter((e) => e.id !== current?.id);

  return (
    <div className="w-full space-y-1 p-2" data-testid="emotion-tree-view">
      {/* + New State activator (matches Session Menu's + New Session) */}
      <button
        type="button"
        onClick={() => setShowNewForm(!showNewForm)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80"
        data-testid="button-new-state"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New State</span>
      </button>

      {/* New state form (inline, below activator) */}
      {showNewForm ? <NewStateForm onSuccess={refresh} onCancel={() => setShowNewForm(false)} /> : null}

      {/* Current state row */}
      {current ? (
        <EmotionStateRow state={current} testId="row-current-state" narrativeTestId="text-current-narrative" />
      ) : !loadingCurrent ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No current state</div>
      ) : null}

      {/* History section header (matches Session Menu section headers) */}
      <ProfileDetailSection title="History" count={historyEntries.length} testId="section-history">
        {historyEntries.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No history yet</div>
        ) : (
          historyEntries.map((entry) => (
            <EmotionStateRow key={entry.id} state={entry} testId={`row-history-${entry.id}`} />
          ))
        )}
      </ProfileDetailSection>
    </div>
  );
}
