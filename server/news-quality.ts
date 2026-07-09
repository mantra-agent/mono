import type { InterestTopic, RawSignal } from "./news-adapters";

export const NEWS_REJECTION_REASONS = [
  "adapter_error",
  "empty_response",
  "invalid_source_config",
  "missing_url",
  "missing_title",
  "unsupported_content_type",
  "too_old",
  "weak_topic_match",
  "low_engagement",
  "low_market_activity",
  "ticker_mismatch",
  "repo_noise",
  "category_only_match",
  "duplicate_story",
  "below_relevance_threshold",
  "curation_rejected",
] as const;

export type RejectionReason = typeof NEWS_REJECTION_REASONS[number];
export type AdapterStatus = "success" | "partial" | "failed" | "skipped";

export interface QualityCandidate {
  raw: RawSignal;
  sourceId: string;
  sourceType: string;
  matchedTopics: string[];
  relevanceScore: number;
  qualityScore: number;
  sourceMetrics: Record<string, number | string | boolean | null>;
  rejectionReason?: RejectionReason;
}

export interface QualityRejection {
  sourceId: string;
  sourceType: string;
  url?: string;
  title?: string;
  reason: RejectionReason;
  details?: string;
  sourceMetrics?: Record<string, number | string | boolean | null>;
}

export interface SourceScanDiagnosticsInput {
  scanRunId: string;
  sourceId: string;
  sourceType: string;
  sourceValue: string;
  adapterStatus: AdapterStatus;
  fetchedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  persistedCount: number;
  surfacedCount: number;
  dedupedCount: number;
  rejectedByReason: Partial<Record<RejectionReason, number>>;
  lastError?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
}

export class SourceDiagnosticsAccumulator {
  private records = new Map<string, SourceScanDiagnosticsInput>();

  constructor(private readonly scanRunId: string) {}

  registerSource(source: { id: string; sourceType: string; value: string }, startedAt: Date = new Date()): void {
    if (this.records.has(source.id)) return;
    this.records.set(source.id, {
      scanRunId: this.scanRunId,
      sourceId: source.id,
      sourceType: source.sourceType,
      sourceValue: source.value,
      adapterStatus: "skipped",
      fetchedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      persistedCount: 0,
      surfacedCount: 0,
      dedupedCount: 0,
      rejectedByReason: {},
      lastError: null,
      startedAt,
      completedAt: null,
    });
  }

  recordAdapterResult(sourceIds: string[], status: AdapterStatus, error?: string): void {
    for (const sourceId of sourceIds) {
      const record = this.records.get(sourceId);
      if (!record) continue;
      record.adapterStatus = status;
      record.completedAt = new Date();
      if (error) {
        record.lastError = error;
        this.reject(sourceId, "adapter_error");
      }
    }
  }

  accept(signal: RawSignal): QualityCandidate | null {
    const record = this.records.get(signal.sourceId);
    if (record) {
      record.fetchedCount += 1;
      record.adapterStatus = record.adapterStatus === "skipped" ? "success" : record.adapterStatus;
    }

    const sourceMetrics = extractSourceMetrics(signal);
    if (!signal.url?.trim()) {
      this.reject(signal.sourceId, "missing_url");
      return null;
    }
    if (!signal.title?.trim()) {
      this.reject(signal.sourceId, "missing_title", signal.url);
      return null;
    }

    if (record) record.acceptedCount += 1;
    return {
      raw: signal,
      sourceId: signal.sourceId,
      sourceType: signal.sourceType,
      matchedTopics: [],
      relevanceScore: 0,
      qualityScore: 1,
      sourceMetrics,
    };
  }

  reject(sourceId: string, reason: RejectionReason, details?: string): void {
    const record = this.records.get(sourceId);
    if (!record) return;
    record.rejectedCount += 1;
    record.rejectedByReason[reason] = (record.rejectedByReason[reason] ?? 0) + 1;
    if (details && !record.lastError && reason === "adapter_error") record.lastError = details;
  }

  recordDeduped(sourceId: string): void {
    const record = this.records.get(sourceId);
    if (!record) return;
    record.dedupedCount += 1;
    this.reject(sourceId, "duplicate_story");
  }

  recordPersisted(sourceId: string): void {
    const record = this.records.get(sourceId);
    if (record) record.persistedCount += 1;
  }

  recordSurfaced(sourceId: string): void {
    const record = this.records.get(sourceId);
    if (record) record.surfacedCount += 1;
  }

  finalize(): SourceScanDiagnosticsInput[] {
    const now = new Date();
    for (const record of this.records.values()) {
      if (record.adapterStatus === "skipped") record.adapterStatus = "success";
      if (record.fetchedCount === 0 && !record.lastError) {
        this.reject(record.sourceId, "empty_response");
      }
      record.completedAt = record.completedAt ?? now;
    }
    return [...this.records.values()];
  }
}

export function gateRawSignals(
  accumulator: SourceDiagnosticsAccumulator,
  signals: RawSignal[],
  context: {
    sources?: Array<{ id: string; sourceType: string; value: string }>;
    interestGraph?: InterestTopic[];
  } = {},
): QualityCandidate[] {
  const sourceById = new Map((context.sources ?? []).map(source => [source.id, source]));
  const interestGraph = context.interestGraph ?? [];

  return signals.flatMap(signal => {
    const accepted = accumulator.accept(signal);
    if (!accepted) return [];

    const decision = evaluateSourceSpecificGate(signal, sourceById.get(signal.sourceId), interestGraph);
    accepted.matchedTopics = decision.matchedTopics;
    accepted.qualityScore = decision.qualityScore;
    accepted.relevanceScore = decision.relevanceScore;
    accepted.sourceMetrics = { ...accepted.sourceMetrics, ...decision.sourceMetrics };

    if (decision.rejectionReason) {
      accumulator.reject(signal.sourceId, decision.rejectionReason, decision.details);
      return [];
    }
    return [accepted];
  });
}

interface SourceGateDecision {
  matchedTopics: string[];
  relevanceScore: number;
  qualityScore: number;
  sourceMetrics: Record<string, number | string | boolean | null>;
  rejectionReason?: RejectionReason;
  details?: string;
}

function evaluateSourceSpecificGate(
  signal: RawSignal,
  source: { id: string; sourceType: string; value: string } | undefined,
  interestGraph: InterestTopic[],
): SourceGateDecision {
  const text = `${signal.title} ${signal.snippet}`;
  const matchedTopics = matchInterestTopics(text, interestGraph);
  const sourceMatch = source ? hasMeaningfulSourceMatch(text, source.value) : false;
  const hasStrongTopicMatch = matchedTopics.length > 0 || sourceMatch;
  const metrics = extractSourceMetrics(signal);
  const relevanceScore = Math.min(1, matchedTopics.reduce((sum, topic) => {
    const weight = interestGraph.find(t => t.tag === topic)?.weight ?? 1;
    return sum + weight * 0.1;
  }, sourceMatch ? 0.2 : 0));

  switch (signal.sourceType) {
    case "hackernews":
      return gateHackerNews(signal, metrics, matchedTopics, hasStrongTopicMatch, relevanceScore);
    case "github_repo":
      return gateGitHubRepo(signal, metrics, matchedTopics, relevanceScore);
    case "polymarket":
      return gatePolymarket(signal, source?.value, metrics, matchedTopics, hasStrongTopicMatch, relevanceScore);
    case "stocktwits":
      return gateStockTwits(signal, source?.value, metrics, matchedTopics, relevanceScore);
    case "arxiv":
      return gateArxiv(signal, source?.value, metrics, matchedTopics, hasStrongTopicMatch, relevanceScore);
    case "youtube_channel":
      return gateYouTube(signal, source?.value, metrics, matchedTopics, hasStrongTopicMatch, relevanceScore);
    case "reddit":
      return gateReddit(signal, metrics, matchedTopics, hasStrongTopicMatch, relevanceScore);
    default:
      return acceptDecision(metrics, matchedTopics, relevanceScore, hasStrongTopicMatch ? 0.9 : 0.7);
  }
}

function gateHackerNews(signal: RawSignal, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], hasStrongTopicMatch: boolean, relevanceScore: number): SourceGateDecision {
  const points = numericMetric(metrics.points ?? metrics.score);
  const comments = numericMetric(metrics.numComments ?? metrics.comments);
  const queryMatched = matchedTopics.length > 0;
  if (hasStrongTopicMatch || points >= 20 || comments >= 10 || (queryMatched && points >= 5)) {
    return acceptDecision(metrics, matchedTopics, relevanceScore, Math.min(1, 0.55 + points / 100 + comments / 80));
  }
  return rejectDecision("low_engagement", metrics, matchedTopics, relevanceScore, "HN item lacks min engagement and strong topic match");
}

function gateGitHubRepo(signal: RawSignal, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], relevanceScore: number): SourceGateDecision {
  const text = `${signal.title} ${signal.snippet}`.toLowerCase();
  const prerelease = signal.rawMetadata?.prerelease === true;
  const hasRelease = /\b(release|tag|changelog|security|v?\d+\.\d+|model|agent|tool|sdk|api)\b/i.test(text);
  const emptyPrerelease = prerelease && signal.snippet.trim().length < 40;
  if (emptyPrerelease || !hasRelease) {
    return rejectDecision("repo_noise", metrics, matchedTopics, relevanceScore, "GitHub item is low-signal repo churn or empty prerelease");
  }
  return acceptDecision(metrics, matchedTopics, relevanceScore, 0.9);
}

function gatePolymarket(signal: RawSignal, sourceValue: string | undefined, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], hasStrongTopicMatch: boolean, relevanceScore: number): SourceGateDecision {
  const volume = numericMetric(metrics.volume);
  const queryMatch = sourceValue ? hasMeaningfulSourceMatch(`${signal.title} ${signal.snippet}`, sourceValue) : false;
  if (!hasStrongTopicMatch && !queryMatch) {
    return rejectDecision("weak_topic_match", metrics, matchedTopics, relevanceScore, "Polymarket market does not match configured source or interests");
  }
  if (volume > 0 && volume < 1000) {
    return rejectDecision("low_market_activity", metrics, matchedTopics, relevanceScore, "Polymarket market volume is below quality threshold");
  }
  return acceptDecision(metrics, matchedTopics, relevanceScore, volume >= 10000 ? 0.95 : 0.75);
}

function gateStockTwits(signal: RawSignal, sourceValue: string | undefined, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], relevanceScore: number): SourceGateDecision {
  const configuredTicker = normalizeTicker(sourceValue);
  const tickers = Array.isArray(signal.rawMetadata?.tickers) ? signal.rawMetadata.tickers.map(t => String(t).toUpperCase()) : [];
  if (configuredTicker && configuredTicker !== "TRENDING" && configuredTicker !== "*" && !tickers.includes(configuredTicker)) {
    return rejectDecision("ticker_mismatch", metrics, matchedTopics, relevanceScore, "StockTwits message does not reference configured ticker");
  }
  const text = `${signal.title} ${signal.snippet}`;
  if (!hasMarketSignalTerms(text) && matchedTopics.length === 0) {
    return rejectDecision("weak_topic_match", metrics, matchedTopics, relevanceScore, "StockTwits message is ticker-correct but not AI/business relevant");
  }
  return acceptDecision(metrics, matchedTopics, relevanceScore, 0.65);
}

function gateArxiv(signal: RawSignal, sourceValue: string | undefined, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], hasStrongTopicMatch: boolean, relevanceScore: number): SourceGateDecision {
  const isCategory = signal.rawMetadata?.isCategory === true;
  const queryMatch = sourceValue ? hasMeaningfulSourceMatch(`${signal.title} ${signal.snippet}`, sourceValue) : false;
  if (isOlderThan(signal.publishedAt, 7)) {
    return rejectDecision("too_old", metrics, matchedTopics, relevanceScore, "arXiv paper is outside recency window");
  }
  if (isCategory && !hasStrongTopicMatch && !queryMatch) {
    return rejectDecision("category_only_match", metrics, matchedTopics, relevanceScore, "arXiv category matched without title or abstract relevance");
  }
  if (!isCategory && !queryMatch && matchedTopics.length === 0) {
    return rejectDecision("weak_topic_match", metrics, matchedTopics, relevanceScore, "arXiv paper does not match source query or interests");
  }
  return acceptDecision(metrics, matchedTopics, relevanceScore, 0.8);
}

function gateYouTube(signal: RawSignal, sourceValue: string | undefined, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], hasStrongTopicMatch: boolean, relevanceScore: number): SourceGateDecision {
  const text = `${signal.title} ${signal.snippet}`;
  const sourceMatch = sourceValue ? hasMeaningfulSourceMatch(text, sourceValue) : false;
  if (isOlderThan(signal.publishedAt, 7)) {
    return rejectDecision("too_old", metrics, matchedTopics, relevanceScore, "YouTube video is outside recency window");
  }
  if (!hasStrongTopicMatch && !sourceMatch && !hasMarketSignalTerms(text)) {
    return rejectDecision("weak_topic_match", metrics, matchedTopics, relevanceScore, "YouTube upload is unrelated to configured interests");
  }
  return acceptDecision(metrics, matchedTopics, relevanceScore, 0.75);
}

function gateReddit(signal: RawSignal, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], hasStrongTopicMatch: boolean, relevanceScore: number): SourceGateDecision {
  const score = numericMetric(metrics.score ?? metrics.points);
  const comments = numericMetric(metrics.numComments ?? metrics.comments);
  if (hasStrongTopicMatch || score >= 10 || comments >= 5) {
    return acceptDecision(metrics, matchedTopics, relevanceScore, Math.min(0.95, 0.55 + score / 50 + comments / 40));
  }
  return rejectDecision("low_engagement", metrics, matchedTopics, relevanceScore, "Reddit post lacks min engagement and strong topic match");
}

function acceptDecision(metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], relevanceScore: number, qualityScore: number): SourceGateDecision {
  return { matchedTopics, relevanceScore, qualityScore, sourceMetrics: metrics };
}

function rejectDecision(reason: RejectionReason, metrics: Record<string, number | string | boolean | null>, matchedTopics: string[], relevanceScore: number, details: string): SourceGateDecision {
  return { matchedTopics, relevanceScore, qualityScore: 0, sourceMetrics: metrics, rejectionReason: reason, details };
}

function matchInterestTopics(text: string, interestGraph: InterestTopic[]): string[] {
  const normalized = normalizeText(text);
  return [...new Set(interestGraph
    .filter(topic => topic.weight >= 2 && phraseMatches(normalized, topic.tag))
    .map(topic => topic.tag))];
}

function hasMeaningfulSourceMatch(text: string, sourceValue: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedSource = normalizeText(sourceValue);
  if (!normalizedSource || normalizedSource === "*" || normalizedSource.length < 3) return false;
  const terms = normalizedSource.split(/\s+/).filter(term => term.length >= 3 && !SOURCE_STOP_WORDS.has(term));
  if (terms.length === 0) return false;
  return terms.some(term => normalizedText.includes(term));
}

function phraseMatches(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase || normalizedPhrase.length < 3) return false;
  if (normalizedText.includes(normalizedPhrase)) return true;
  const terms = normalizedPhrase.split(/\s+/).filter(term => term.length >= 4 && !SOURCE_STOP_WORDS.has(term));
  return terms.length > 0 && terms.some(term => normalizedText.includes(term));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9$]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTicker(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/^\$/, "").trim().toUpperCase() || null;
}

function numericMetric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isOlderThan(publishedAt: string | null, days: number): boolean {
  if (!publishedAt) return false;
  const time = new Date(publishedAt).getTime();
  return Number.isFinite(time) && time < Date.now() - days * 24 * 60 * 60 * 1000;
}

function hasMarketSignalTerms(text: string): boolean {
  return /\b(ai|artificial intelligence|agent|llm|model|openai|anthropic|google|meta|nvidia|semiconductor|chip|robot|robotics|automation|earnings|revenue|guidance|startup|funding|acquisition|product|platform|enterprise|business)\b/i.test(text);
}

const SOURCE_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "about", "what", "when", "will", "would", "could",
  "channel", "user", "feed", "search", "topic", "news", "stock", "market", "markets",
]);

function extractSourceMetrics(signal: RawSignal): Record<string, number | string | boolean | null> {
  const metrics: Record<string, number | string | boolean | null> = {};
  const source = signal.rawMetadata ?? {};
  for (const key of ["score", "points", "numComments", "comments", "volume", "volumeNum", "liquidity", "sentiment", "ticker", "tag"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      metrics[key] = value;
    }
  }
  return metrics;
}
