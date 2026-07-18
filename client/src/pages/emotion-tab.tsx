import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
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

/* ── VAD Plot ── */

function VADPlot({ valence, arousal }: { valence: number; arousal: number }) {
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
        className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cta shadow-sm ring-2 ring-background"
        style={{ left: `${x}%`, top: `${y}%` }}
      />
    </div>
  );
}

/* ── State Detail (read-only expanded content shared by current + history rows) ── */

function StateDetail({ state, narrativeTestId }: { state: EmotionalState; narrativeTestId?: string }) {
  return (
    <div className="flex min-w-0 gap-3 rounded-md border border-border/30 bg-card/60 p-3">
      <VADPlot valence={state.valence} arousal={state.arousal} />
      <div className="min-w-0 flex-1 space-y-1.5">
        {state.narrative ? (
          <p className="break-words text-sm leading-relaxed text-foreground" data-testid={narrativeTestId}>
            {state.narrative}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {valenceLabel(state.valence)} · {arousalLabel(state.arousal)} · {state.source}
        </p>
        {state.triggers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {state.triggers.map((t) => (
              <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
            ))}
          </div>
        ) : null}
        {state.context ? (
          <p className="break-words text-xs text-muted-foreground/70">{state.context}</p>
        ) : null}
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
      expandedContent={<StateDetail state={state} narrativeTestId={narrativeTestId} />}
      expandedContentClassName="pl-8 pr-2"
      testId={testId}
      mobileLayout="inline"
    >
      <span className="flex min-w-0 items-center justify-end gap-1.5">
        {state.stale ? (
          <Badge variant="outline" className="text-[10px] text-warning-foreground">Stale</Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">{timeAgo(state.createdAt)}</span>
      </span>
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
