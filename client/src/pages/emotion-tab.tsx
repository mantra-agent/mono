import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Heart, Loader2, Plus } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

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

interface VADPlotProps {
  valence: number;
  arousal: number;
}

interface EmotionalStateDetailsProps {
  state: EmotionalState;
  narrativeTestId?: string;
}

interface EmotionalStateRowProps {
  state: EmotionalState;
}

interface CurrentStateRowProps {
  state: EmotionalState | null;
}

interface HistoryTreeRowProps {
  entries: EmotionalState[];
}

interface SeedStateButtonsProps {
  onSelect: (seed: SeedEmotionalState) => void;
}

interface OverrideFormProps {
  onSuccess: () => void;
}

interface SeedEmotionalState {
  name: string;
  valence: number;
  arousal: number;
  guidance: string;
}

function valenceLabel(value: number): string {
  if (value > 0.5) return "very positive";
  if (value > 0.15) return "positive";
  if (value > -0.15) return "neutral";
  if (value > -0.5) return "negative";
  return "very negative";
}

function arousalLabel(value: number): string {
  if (value > 0.7) return "high energy";
  if (value > 0.4) return "moderate energy";
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

function dotColor(valence: number, arousal: number): string {
  if (valence > 0.15 && arousal > 0.5) return "bg-warning";
  if (valence > 0.15) return "bg-success";
  if (valence < -0.15 && arousal > 0.5) return "bg-error";
  if (valence < -0.15) return "bg-info";
  return "bg-muted-foreground";
}

const PRESET_STATES = [
  "Focused",
  "Curious",
  "Calm",
  "Energized",
  "Reflective",
  "Anxious",
  "Frustrated",
  "Playful",
  "Determined",
  "Contemplative",
];

const SEED_EMOTIONAL_STATES: SeedEmotionalState[] = [
  { name: "Focused", valence: 0.2, arousal: 0.6, guidance: "Engaged and attentive, channeling energy into the task at hand." },
  { name: "Curious", valence: 0.3, arousal: 0.65, guidance: "Open and exploratory, drawn toward new ideas and questions." },
  { name: "Calm", valence: 0.15, arousal: 0.2, guidance: "Settled and present, at ease with the moment." },
  { name: "Energized", valence: 0.5, arousal: 0.85, guidance: "Alive and activated, ready to move, create, or engage." },
  { name: "Reflective", valence: 0, arousal: 0.25, guidance: "Turning inward, processing, integrating, making sense." },
  { name: "Warm", valence: 0.6, arousal: 0.4, guidance: "Feeling connected and appreciative, softened by care." },
  { name: "Melancholy", valence: -0.4, arousal: 0.2, guidance: "A quiet sadness, something weighing gently beneath the surface." },
  { name: "Tense", valence: -0.3, arousal: 0.75, guidance: "On edge, sensing friction, pressure, or unresolved tension." },
];

function VADPlot({ valence, arousal }: VADPlotProps) {
  const x = ((valence + 1) / 2) * 100;
  const y = (1 - arousal) * 100;

  return (
    <div
      className="relative h-20 w-20 shrink-0 rounded-md border border-border/50 bg-white/[0.02]"
      title={`V: ${valence.toFixed(2)}, A: ${arousal.toFixed(2)}`}
    >
      <span className="absolute left-0.5 top-0.5 text-2xs text-muted-foreground/50">tense</span>
      <span className="absolute right-0.5 top-0.5 text-2xs text-muted-foreground/50">excited</span>
      <span className="absolute bottom-0.5 left-0.5 text-2xs text-muted-foreground/50">sad</span>
      <span className="absolute bottom-0.5 right-0.5 text-2xs text-muted-foreground/50">calm</span>
      <div className="absolute left-0 right-0 top-1/2 h-px bg-border/40" />
      <div className="absolute bottom-0 left-1/2 top-0 w-px bg-border/40" />
      <div
        className={cn(
          "absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm ring-2 ring-background",
          dotColor(valence, arousal),
        )}
        style={{ left: `${x}%`, top: `${y}%` }}
      />
    </div>
  );
}

function EmotionalStateDetails({ state, narrativeTestId }: EmotionalStateDetailsProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border/30 bg-card/60 p-3 sm:flex-row sm:items-start">
      <VADPlot valence={state.valence} arousal={state.arousal} />
      <div className="min-w-0 flex-1 space-y-2">
        {state.narrative ? (
          <p className="break-words text-sm leading-relaxed text-foreground" data-testid={narrativeTestId}>
            {state.narrative}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Valence {state.valence.toFixed(2)} · Arousal {state.arousal.toFixed(2)} · Source {state.source}
        </p>
        {state.triggers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {state.triggers.map((trigger) => (
              <Badge key={trigger} variant="outline" className="text-xs">
                {trigger}
              </Badge>
            ))}
          </div>
        ) : null}
        {state.context ? <p className="break-words text-xs text-muted-foreground/70">{state.context}</p> : null}
        <p className="flex items-center gap-1 text-xs text-muted-foreground/50">
          <Clock className="h-3 w-3" />
          {timeAgo(state.createdAt)}
        </p>
      </div>
    </div>
  );
}

function CurrentStateRow({ state }: CurrentStateRowProps) {
  if (!state) {
    return (
      <ProfileTreeRow
        label="Current state"
        icon={<Heart className="h-3.5 w-3.5" />}
        hasValue={false}
        showEmpty
        testId="row-current-emotional-state"
      >
        <span className="text-muted-foreground">Not set</span>
      </ProfileTreeRow>
    );
  }

  const name = state.stateName || state.mood;

  return (
    <ProfileTreeRow
      label="Current state"
      icon={<Heart className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      expandedContent={<EmotionalStateDetails state={state} narrativeTestId="text-current-narrative" />}
      expandedContentClassName="pl-8 pr-2"
      testId="row-current-emotional-state"
    >
      <span className="flex min-w-0 items-center justify-end gap-1.5">
        <span className="truncate font-medium text-foreground" data-testid="text-current-state-name">{name}</span>
        {state.stale ? <Badge variant="outline" className="text-[10px] text-warning-foreground">Stale</Badge> : null}
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dotColor(state.valence, state.arousal))} />
      </span>
    </ProfileTreeRow>
  );
}

function EmotionalStateRow({ state }: EmotionalStateRowProps) {
  const name = state.stateName || state.mood;

  return (
    <ProfileTreeRow
      label={name}
      icon={<span className={cn("h-2 w-2 rounded-full", dotColor(state.valence, state.arousal))} />}
      hasValue
      showEmpty
      expandedContent={<EmotionalStateDetails state={state} />}
      expandedContentClassName="pl-8 pr-0"
      testId={`row-emotional-state-${state.id}`}
      mobileLayout="inline"
    >
      <span className="truncate text-muted-foreground">{timeAgo(state.createdAt)}</span>
    </ProfileTreeRow>
  );
}

function HistoryTreeRow({ entries }: HistoryTreeRowProps) {
  const countLabel = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;

  return (
    <ProfileTreeRow
      label="History"
      icon={<Clock className="h-3.5 w-3.5" />}
      hasValue={entries.length > 0}
      showEmpty
      expandedContent={entries.length > 0 ? (
        <div className="rounded-md border border-border/30 bg-background/40 p-1">
          {entries.map((entry) => <EmotionalStateRow key={entry.id} state={entry} />)}
        </div>
      ) : undefined}
      expandedContentClassName="pl-8 pr-2"
      testId="row-emotional-state-history"
    >
      <span className="text-muted-foreground">{entries.length > 0 ? countLabel : "No history yet"}</span>
    </ProfileTreeRow>
  );
}

function SeedStateButtons({ onSelect }: SeedStateButtonsProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Quick select</Label>
      <div className="flex flex-wrap gap-1.5" data-testid="seed-state-buttons">
        {SEED_EMOTIONAL_STATES.map((seed) => (
          <button
            key={seed.name}
            type="button"
            onClick={() => onSelect(seed)}
            className="rounded-md border border-border/50 bg-transparent px-2.5 py-1 text-xs transition-colors hover:bg-accent/70"
            data-testid={`button-seed-${seed.name.toLowerCase()}`}
            title={seed.guidance}
          >
            {seed.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function OverrideForm({ onSuccess }: OverrideFormProps) {
  const [formVersion, setFormVersion] = useState(0);
  const [stateName, setStateName] = useState("");
  const [valence, setValence] = useState([0]);
  const [arousal, setArousal] = useState([0.5]);
  const [triggerText, setTriggerText] = useState("");
  const [narrative, setNarrative] = useState("");
  const { toast } = useToast();

  const handleSeedSelect = (seed: SeedEmotionalState) => {
    setStateName(seed.name);
    setValence([seed.valence]);
    setArousal([seed.arousal]);
  };

  const reset = () => {
    setStateName("");
    setValence([0]);
    setArousal([0.5]);
    setTriggerText("");
    setNarrative("");
  };

  const closeForm = () => {
    reset();
    setFormVersion((version) => version + 1);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const triggers = triggerText.split(",").map((trigger) => trigger.trim()).filter(Boolean);
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
      closeForm();
      onSuccess();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const form = (
    <div className="space-y-4 rounded-md border border-border/30 bg-card/60 p-3">
      <SeedStateButtons onSelect={handleSeedSelect} />

      <div className="space-y-1.5">
        <Label className="text-xs">State</Label>
        <div className="mb-1.5 flex flex-wrap gap-1">
          {PRESET_STATES.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setStateName(preset)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                stateName === preset
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/50 bg-transparent hover:bg-accent/70",
              )}
              data-testid={`button-preset-${preset.toLowerCase()}`}
            >
              {preset}
            </button>
          ))}
        </div>
        <Input
          value={stateName}
          onChange={(event) => setStateName(event.target.value)}
          placeholder="Or type a custom state..."
          className="h-8 text-sm"
          data-testid="input-state-name"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between gap-3">
          <Label className="text-xs">Valence</Label>
          <span className="text-xs text-muted-foreground">{valence[0].toFixed(2)} ({valenceLabel(valence[0])})</span>
        </div>
        <Slider value={valence} onValueChange={setValence} min={-1} max={1} step={0.05} data-testid="slider-valence" />
        <div className="flex justify-between text-xs text-muted-foreground/50">
          <span>negative</span>
          <span>positive</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between gap-3">
          <Label className="text-xs">Arousal</Label>
          <span className="text-xs text-muted-foreground">{arousal[0].toFixed(2)} ({arousalLabel(arousal[0])})</span>
        </div>
        <Slider value={arousal} onValueChange={setArousal} min={0} max={1} step={0.05} data-testid="slider-arousal" />
        <div className="flex justify-between text-xs text-muted-foreground/50">
          <span>low energy</span>
          <span>high energy</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Narrative</Label>
        <Textarea
          value={narrative}
          onChange={(event) => setNarrative(event.target.value)}
          placeholder="What's alive emotionally right now? A few sentences grounding this state..."
          className="min-h-[60px] resize-y text-sm"
          data-testid="input-narrative"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Triggers (comma-separated)</Label>
        <Input
          value={triggerText}
          onChange={(event) => setTriggerText(event.target.value)}
          placeholder="e.g. deadline, good news, conversation"
          className="h-8 text-sm"
          data-testid="input-triggers"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !stateName}
          data-testid="button-submit-state"
        >
          {mutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          Record
        </Button>
        <Button size="sm" variant="ghost" onClick={closeForm} data-testid="button-cancel-state">Cancel</Button>
      </div>
    </div>
  );

  return (
    <ProfileTreeRow
      key={formVersion}
      label="Record state"
      icon={<Plus className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      expandedContent={form}
      expandedContentClassName="pl-8 pr-2"
      testId="row-record-emotional-state"
    >
      <span className="text-muted-foreground">Quick select or customize</span>
    </ProfileTreeRow>
  );
}

export default function EmotionTab() {
  const queryClient = useQueryClient();

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
  };

  if (loadingCurrent && loadingHistory) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const historyEntries = (history || []).filter((entry) => entry.id !== current?.id);

  return (
    <div className="w-full p-4" data-testid="emotion-tree-view">
      <div className="rounded-lg border border-border/40 bg-muted/30 p-1">
        <CurrentStateRow state={current ?? null} />
        <OverrideForm onSuccess={refresh} />
        <HistoryTreeRow entries={historyEntries} />
      </div>
    </div>
  );
}
