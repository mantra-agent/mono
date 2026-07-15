export interface EmotionalModulationInput {
  valence: number;
  arousal: number;
}

export interface BlendWeights {
  semantic: number;
  temporal: number;
  causal: number;
  contrastive: number;
}

export type SessionType = "strategy" | "planning" | "reflection" | "debugging" | "general";

const STRATEGY_KEYWORDS = ["strategy", "strategic", "priority", "priorities", "goal", "goals", "vision", "mission", "direction", "alignment"];
const PLANNING_KEYWORDS = ["plan", "planning", "schedule", "timeline", "milestone", "deadline", "roadmap", "next steps", "action items"];
const REFLECTION_KEYWORDS = ["reflect", "reflection", "looking back", "learned", "mistake", "regret", "growth", "evolve", "changed", "used to"];
const DEBUGGING_KEYWORDS = ["debug", "error", "bug", "issue", "broken", "fix", "crash", "fail", "wrong", "problem"];

export const BLEND_WEIGHTS: Record<SessionType, BlendWeights> = {
  strategy: { semantic: 0.35, temporal: 0.15, causal: 0.35, contrastive: 0.15 },
  planning: { semantic: 0.30, temporal: 0.30, causal: 0.25, contrastive: 0.15 },
  reflection: { semantic: 0.25, temporal: 0.20, causal: 0.20, contrastive: 0.35 },
  debugging: { semantic: 0.40, temporal: 0.25, causal: 0.25, contrastive: 0.10 },
  general: { semantic: 0.40, temporal: 0.20, causal: 0.25, contrastive: 0.15 },
};

export function modulateWeights(
  base: BlendWeights,
  emotion: EmotionalModulationInput | null | undefined,
): { weights: BlendWeights; modulated: boolean; deltas: string } {
  if (!emotion) return { weights: base, modulated: false, deltas: "" };

  const { valence, arousal } = emotion;
  let semantic = base.semantic;
  let temporal = base.temporal;
  let causal = base.causal;
  let contrastive = base.contrastive;

  if (arousal > 0.7) { semantic *= 1.2; temporal *= 0.8; }
  if (arousal < 0.3) { temporal *= 1.2; causal *= 1.2; semantic *= 0.8; }
  if (valence < -0.3) contrastive *= 1.3;
  if (valence > 0.3) semantic *= 1.1;

  const total = semantic + temporal + causal + contrastive;
  const weights = {
    semantic: semantic / total,
    temporal: temporal / total,
    causal: causal / total,
    contrastive: contrastive / total,
  };
  const format = (value: number) => value.toFixed(2);
  return {
    weights,
    modulated: true,
    deltas: `s:${format(base.semantic)}→${format(weights.semantic)} t:${format(base.temporal)}→${format(weights.temporal)} c:${format(base.causal)}→${format(weights.causal)} x:${format(base.contrastive)}→${format(weights.contrastive)} (v=${format(valence)} a=${format(arousal)})`,
  };
}

export function detectSessionType(text: string): { type: SessionType; triggerKeywords: string[] } {
  const lower = text.toLowerCase();
  const matches: Array<{ type: SessionType; keywords: string[] }> = [];
  const collect = (type: SessionType, keywords: string[]) => {
    const found = keywords.filter((keyword) => lower.includes(keyword));
    if (found.length > 0) matches.push({ type, keywords: found });
  };
  collect("strategy", STRATEGY_KEYWORDS);
  collect("planning", PLANNING_KEYWORDS);
  collect("reflection", REFLECTION_KEYWORDS);
  collect("debugging", DEBUGGING_KEYWORDS);
  matches.sort((left, right) => right.keywords.length - left.keywords.length);
  return matches[0] ?? { type: "general", triggerKeywords: [] };
}
