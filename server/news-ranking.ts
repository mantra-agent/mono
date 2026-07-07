import type { InterestTopic, ScoredSignal, StoryCluster } from "./news-adapters";

export type CandidateLane = "relevance" | "importance" | "authority" | "news_search";

export interface LandscapeScanBudget {
  maxSearchQueries: number;
  maxDiscoveryQueries: number;
  maxCurationCandidates: number;
  laneQuotas: Record<CandidateLane, number>;
}

export const LANDSCAPE_SCAN_BUDGET: LandscapeScanBudget = {
  maxSearchQueries: 10,
  maxDiscoveryQueries: 8,
  maxCurationCandidates: 12,
  laneQuotas: {
    relevance: 5,
    importance: 4,
    authority: 2,
    news_search: 3,
  },
};

export interface RankedSignal extends ScoredSignal {
  importanceScore: number;
  importanceReasons: string[];
  authorityScore: number;
  newsSearchScore: number;
  storyCluster: StoryCluster;
}

export interface CandidateSelection {
  fingerprint: string;
  lane: CandidateLane;
  selectionScore: number;
  reasons: string[];
}

interface RankEntry {
  fingerprint: string;
  scored: ScoredSignal;
  cluster: StoryCluster;
}

const AUTHORITY_ENTITIES = [
  "openai",
  "anthropic",
  "anthropicai",
  "googledeepmind",
  "deepmind",
  "meta ai",
  "metaai",
  "mistral",
  "mistralai",
  "xai",
  "nvidia",
  "microsoft",
  "amazon bedrock",
  "apple",
  "snap",
  "magic leap",
  "niantic",
];

const ACTION_TERMS = [
  "announce",
  "announces",
  "announced",
  "introducing",
  "launch",
  "launches",
  "launched",
  "release",
  "releases",
  "released",
  "preview",
  "available",
  "funding",
  "raises",
  "raised",
  "acquires",
  "acquired",
  "partnership",
  "breakthrough",
  "ships",
  "open source",
];

function textFor(signal: ScoredSignal): string {
  return `${signal.title} ${signal.snippet} ${Object.values(signal.rawMetadata || {}).join(" ")}`.toLowerCase();
}

function sourceAuthority(signal: ScoredSignal): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const text = textFor(signal);
  const account = typeof signal.rawMetadata?.account === "string" ? signal.rawMetadata.account.toLowerCase() : "";
  const authorityHit = AUTHORITY_ENTITIES.find(entity => account === entity || text.includes(entity));
  if (!authorityHit) return { score: 0, reasons };
  reasons.push(`authority:${authorityHit}`);
  return { score: signal.sourceType === "x_account" ? 0.35 : 0.2, reasons };
}

function recencyScore(signal: ScoredSignal): number {
  if (!signal.publishedAt) return 0;
  const published = new Date(signal.publishedAt).getTime();
  if (!Number.isFinite(published)) return 0;
  const ageHours = Math.max(0, (Date.now() - published) / 3_600_000);
  if (ageHours <= 24) return 0.1;
  if (ageHours <= 72) return 0.05;
  return 0;
}

export function rankSignal(entry: RankEntry, interestGraph: InterestTopic[]): RankedSignal {
  const { scored, cluster } = entry;
  const text = textFor(scored);
  const reasons: string[] = [];
  let importanceScore = 0;

  const authority = sourceAuthority(scored);
  importanceScore += authority.score;
  reasons.push(...authority.reasons);

  const discoveryMode = typeof scored.rawMetadata?.discoveryMode === "string" ? scored.rawMetadata.discoveryMode : "";
  const newsSearchScore = discoveryMode === "x_news_discovery" ? 0.25 : scored.sourceType === "x" ? 0.12 : 0;
  if (newsSearchScore > 0) reasons.push(discoveryMode || "x_news");
  importanceScore += newsSearchScore;

  const sourceTypes = new Set(cluster.signals.map(s => s.sourceType));
  const consensusScore = Math.min(0.2, Math.max(0, cluster.signals.length - 1) * 0.08 + Math.max(0, sourceTypes.size - 1) * 0.06);
  if (consensusScore > 0) reasons.push(`cluster:${cluster.signals.length}/${sourceTypes.size}`);
  importanceScore += consensusScore;

  const actionHits = ACTION_TERMS.filter(term => text.includes(term)).slice(0, 3);
  if (actionHits.length > 0) {
    importanceScore += 0.15;
    reasons.push(`action:${actionHits.join(",")}`);
  }

  const entityHits = AUTHORITY_ENTITIES.filter(entity => text.includes(entity)).slice(0, 3);
  if (entityHits.length > 0) {
    importanceScore += 0.15;
    reasons.push(`entity:${entityHits.join(",")}`);
  }

  const recency = recencyScore(scored);
  if (recency > 0) reasons.push("recent");
  importanceScore += recency;

  const topicBoost = interestGraph.some(t => t.weight >= 0.8 && text.includes(t.tag.toLowerCase())) ? 0.08 : 0;
  if (topicBoost > 0) reasons.push("pinned_topic");
  importanceScore += topicBoost;

  importanceScore = Math.round(Math.min(1, importanceScore) * 100) / 100;
  const authorityScore = Math.round(Math.min(1, authority.score + (entityHits.length > 0 ? 0.15 : 0)) * 100) / 100;

  return {
    ...scored,
    importanceScore,
    importanceReasons: [...new Set(reasons)],
    authorityScore,
    newsSearchScore,
    storyCluster: cluster,
  };
}

function topByLane(
  ranked: RankedSignal[],
  lane: CandidateLane,
  quota: number,
  used: Set<string>,
): CandidateSelection[] {
  const scoreFor = (signal: RankedSignal): number => {
    switch (lane) {
      case "relevance": return signal.relevanceScore;
      case "importance": return signal.importanceScore;
      case "authority": return signal.authorityScore;
      case "news_search": return signal.newsSearchScore;
    }
  };
  const threshold: Record<CandidateLane, number> = {
    relevance: 0.12,
    importance: 0.25,
    authority: 0.2,
    news_search: 0.2,
  };
  return ranked
    .map(signal => ({ signal, score: scoreFor(signal) }))
    .filter(entry => entry.score >= threshold[lane] && !used.has(entry.signal.rawMetadata.__fingerprint as string))
    .sort((a, b) => b.score - a.score || b.signal.relevanceScore - a.signal.relevanceScore)
    .slice(0, quota)
    .map(entry => {
      const fingerprint = entry.signal.rawMetadata.__fingerprint as string;
      used.add(fingerprint);
      return {
        fingerprint,
        lane,
        selectionScore: Math.round(entry.score * 100) / 100,
        reasons: lane === "relevance" ? entry.signal.relevanceTags : entry.signal.importanceReasons,
      };
    });
}

export function selectCurationCandidates(
  ranked: RankedSignal[],
  budget: LandscapeScanBudget = LANDSCAPE_SCAN_BUDGET,
): CandidateSelection[] {
  const used = new Set<string>();
  const selections: CandidateSelection[] = [];
  for (const lane of ["relevance", "importance", "authority", "news_search"] as CandidateLane[]) {
    selections.push(...topByLane(ranked, lane, budget.laneQuotas[lane], used));
  }
  return selections
    .sort((a, b) => b.selectionScore - a.selectionScore)
    .slice(0, budget.maxCurationCandidates);
}
