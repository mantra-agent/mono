import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Heart, Clock, ChevronDown, ChevronUp, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

// --- Types ---

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

// --- Helpers ---

function valenceLabel(v: number): string {
  if (v > 0.5) return "very positive";
  if (v > 0.15) return "positive";
  if (v > -0.15) return "neutral";
  if (v > -0.5) return "negative";
  return "very negative";
}

function arousalLabel(a: number): string {
  if (a > 0.7) return "high energy";
  if (a > 0.4) return "moderate energy";
  return "low energy";
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

/** Map valence/arousal to a subtle background tint */
function stateTint(valence: number, arousal: number): string {
  if (valence > 0.15 && arousal > 0.5) return "bg-warning/8 border-warning/20";
  if (valence > 0.15) return "bg-success/8 border-success/20";
  if (valence < -0.15 && arousal > 0.5) return "bg-error/8 border-error/20";
  if (valence < -0.15) return "bg-info/8 border-info/20";
  return "bg-card border-border/40";
}

/** Dot color for the 2D valence/arousal indicator */
function dotColor(valence: number, arousal: number): string {
  if (valence > 0.15 && arousal > 0.5) return "bg-warning";
  if (valence > 0.15) return "bg-success";
  if (valence < -0.15 && arousal > 0.5) return "bg-error";
  if (valence < -0.15) return "bg-info";
  return "bg-muted-foreground";
}

const PRESET_STATES = [
  "Focused", "Curious", "Calm", "Energized", "Reflective",
  "Anxious", "Frustrated", "Playful", "Determined", "Contemplative",
];

const SEED_EMOTIONAL_STATES = [
  { name: "Focused", valence: 0.2, arousal: 0.6, guidance: "Engaged and attentive — channeling energy into the task at hand." },
  { name: "Curious", valence: 0.3, arousal: 0.65, guidance: "Open and exploratory — drawn toward new ideas and questions." },
  { name: "Calm", valence: 0.15, arousal: 0.2, guidance: "Settled and present — at ease with the moment." },
  { name: "Energized", valence: 0.5, arousal: 0.85, guidance: "Alive and activated — ready to move, create, or engage." },
  { name: "Reflective", valence: 0.0, arousal: 0.25, guidance: "Turning inward — processing, integrating, making sense." },
  { name: "Warm", valence: 0.6, arousal: 0.4, guidance: "Feeling connected and appreciative — softened by care." },
  { name: "Melancholy", valence: -0.4, arousal: 0.2, guidance: "A quiet sadness — something weighing gently beneath the surface." },
  { name: "Tense", valence: -0.3, arousal: 0.75, guidance: "On edge — sensing friction, pressure, or unresolved tension." },
];

// --- Components ---

function VADPlot({ valence, arousal }: { valence: number; arousal: number }) {
  const x = ((valence + 1) / 2) * 100;
  const y = (1 - arousal) * 100;
  return (
    <div className="relative w-20 h-20 border border-border/50 rounded-md bg-white/[0.02] shrink-0" title={`V: ${valence.toFixed(2)}, A: ${arousal.toFixed(2)}`}>
      <span className="absolute top-0.5 left-0.5 text-2xs text-muted-foreground/50">tense</span>
      <span className="absolute top-0.5 right-0.5 text-2xs text-muted-foreground/50">excited</span>
      <span className="absolute bottom-0.5 left-0.5 text-2xs text-muted-foreground/50">sad</span>
      <span className="absolute bottom-0.5 right-0.5 text-2xs text-muted-foreground/50">calm</span>
      <div className="absolute top-1/2 left-0 right-0 h-px bg-border/40" />
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border/40" />
      <div
        className={cn("absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 ring-2 ring-background shadow-sm", dotColor(valence, arousal))}
        style={{ left: `${x}%`, top: `${y}%` }}
      />
    </div>
  );
}

function CurrentStateCard({ state }: { state: EmotionalState | null }) {
  if (!state) {
    return (
      <Card className="border-dashed py-8 text-center">
        <Heart className="h-8 w-8 mx-auto mb-3 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No emotional state set</p>

      </Card>
    );
  }

  return (
    <Card className={cn("p-4 transition-colors overflow-hidden", stateTint(state.valence, state.arousal))}>
      <div className="flex items-start gap-4">
        <VADPlot valence={state.valence} arousal={state.arousal} />
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-base truncate" data-testid="text-current-state-name">{state.stateName || state.mood}</h3>
            {state.stale && (
              <Badge variant="outline" className="text-xs text-warning-foreground border-warning/30">stale</Badge>
            )}
            <Badge variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5">{state.source}</Badge>
          </div>
          {state.narrative && (
            <p className="text-sm mt-1 leading-relaxed break-words" data-testid="text-current-narrative">{state.narrative}</p>
          )}
          <p className="text-sm text-muted-foreground mt-1">
            {valenceLabel(state.valence)}, {arousalLabel(state.arousal)}
          </p>
          {state.triggers.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {state.triggers.map((t, i) => (
                <Badge key={i} variant="outline" className="text-xs">{t}</Badge>
              ))}
            </div>
          )}
          {state.context && (
            <p className="text-xs text-muted-foreground/70 mt-2 line-clamp-2 break-words">{state.context}</p>
          )}
          <p className="text-xs text-muted-foreground/50 mt-2 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {timeAgo(state.createdAt)}
          </p>
        </div>
      </div>
    </Card>
  );
}

function TimelineEntry({ entry, defaultExpanded = false }: { entry: EmotionalState; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="flex gap-3 group">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center pt-1.5">
        <div className={cn("w-2 h-2 rounded-full shrink-0", dotColor(entry.valence, entry.arousal))} />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>
      {/* Content */}
      <div className="pb-4 flex-1 min-w-0 overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left hover:bg-white/[0.03] rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors"
        >
          <span className="text-sm font-medium truncate">{entry.stateName || entry.mood}</span>
          <span className="text-xs text-muted-foreground truncate hidden @sm:inline">{valenceLabel(entry.valence)}, {arousalLabel(entry.arousal)}</span>
          <span className="text-xs text-muted-foreground/50 ml-auto shrink-0">{timeAgo(entry.createdAt)}</span>
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
        </button>
        {expanded && (
          <div className="mt-2 ml-1.5 text-xs space-y-1">
            <p className="text-muted-foreground">
              Valence: {entry.valence.toFixed(2)} · Arousal: {entry.arousal.toFixed(2)} · Source: {entry.source}
            </p>
            {entry.triggers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {entry.triggers.map((t, i) => (
                  <Badge key={i} variant="outline" className="text-xs">{t}</Badge>
                ))}
              </div>
            )}
            {entry.context && <p className="text-muted-foreground/70 break-words">{entry.context}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function SeedStateButtons({ onSelect }: { onSelect: (seed: typeof SEED_EMOTIONAL_STATES[number]) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Quick Select</Label>
      <div className="flex flex-wrap gap-1.5" data-testid="seed-state-buttons">
        {SEED_EMOTIONAL_STATES.map(seed => (
          <button
            key={seed.name}
            onClick={() => onSelect(seed)}
            className="px-2.5 py-1 text-xs rounded-md border border-border/50 bg-transparent hover:bg-white/[0.03] transition-colors"
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

function OverrideForm({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [stateName, setStateName] = useState("");
  const [valence, setValence] = useState([0]);
  const [arousal, setArousal] = useState([0.5]);
  const [triggerText, setTriggerText] = useState("");
  const [narrative, setNarrative] = useState("");
  const { toast } = useToast();

  const handleSeedSelect = (seed: typeof SEED_EMOTIONAL_STATES[number]) => {
    setStateName(seed.name);
    setValence([seed.valence]);
    setArousal([seed.arousal]);
    if (!open) setOpen(true);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const triggers = triggerText.split(",").map(t => t.trim()).filter(Boolean);
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
      setStateName("");
      setValence([0]);
      setArousal([0.5]);
      setTriggerText("");
      setNarrative("");
      setOpen(false);
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (!open) {
    return (
      <div className="space-y-3">
        <SeedStateButtons onSelect={handleSeedSelect} />
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5" data-testid="button-record-state">
          <Plus className="h-3.5 w-3.5" />
          Record State
        </Button>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="py-3 px-4 border-b border-border/30">
        <h3 className="text-sm font-medium">Record Emotional State</h3>
      </div>
      <div className="px-4 pb-4 pt-3 space-y-4">
        <SeedStateButtons onSelect={handleSeedSelect} />

        <div className="space-y-1.5">
          <Label className="text-xs">State</Label>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {PRESET_STATES.map(preset => (
              <button
                key={preset}
                onClick={() => setStateName(preset)}
                className={cn(
                  "px-2 py-0.5 text-xs rounded-full border transition-colors",
                  stateName === preset
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent border-border/50 hover:bg-white/[0.03]"
                )}
                data-testid={`button-preset-${preset.toLowerCase()}`}
              >
                {preset}
              </button>
            ))}
          </div>
          <Input
            value={stateName}
            onChange={e => setStateName(e.target.value)}
            placeholder="Or type a custom state..."
            className="h-8 text-sm"
            data-testid="input-state-name"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between">
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
          <div className="flex justify-between">
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
            onChange={e => setNarrative(e.target.value)}
            placeholder="What's alive emotionally right now? A few sentences grounding this state..."
            className="text-sm min-h-[60px] resize-y"
            data-testid="input-narrative"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Triggers (comma-separated)</Label>
          <Input
            value={triggerText}
            onChange={e => setTriggerText(e.target.value)}
            placeholder="e.g. deadline, good news, conversation"
            className="h-8 text-sm"
            data-testid="input-triggers"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || !stateName} data-testid="button-submit-state">
            {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Record
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} data-testid="button-cancel-state">Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

// --- Main Tab ---

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

  const timelineEntries = (history || []).filter(e => e.id !== current?.id);

  return (
    <div className="p-4 space-y-4">
      {/* Current state */}
      <CurrentStateCard state={current ?? null} />

      {/* Override form */}
      <OverrideForm onSuccess={refresh} />

      {/* Timeline */}
      {timelineEntries.length > 0 && (
        <Card className="overflow-hidden">
          <div className="py-3 px-4 border-b border-border/30">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">History</h4>
          </div>
          <div className="pl-4 pr-4 pt-3 pb-1">
            {timelineEntries.map((entry, i) => (
              <TimelineEntry key={entry.id} entry={entry} defaultExpanded={i === 0} />
            ))}
          </div>
        </Card>
      )}

      {timelineEntries.length === 0 && !loadingHistory && (
        <p className="text-xs text-muted-foreground/50 text-center py-4">No history yet.</p>
      )}
    </div>
  );
}
