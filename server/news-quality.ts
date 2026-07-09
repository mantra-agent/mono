import type { RawSignal } from "./news-adapters";

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
): QualityCandidate[] {
  return signals.flatMap(signal => {
    const accepted = accumulator.accept(signal);
    return accepted ? [accepted] : [];
  });
}

function extractSourceMetrics(signal: RawSignal): Record<string, number | string | boolean | null> {
  const metrics: Record<string, number | string | boolean | null> = {};
  const source = signal.rawMetadata ?? {};
  for (const key of ["score", "points", "numComments", "comments", "volume", "liquidity", "sentiment", "ticker"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      metrics[key] = value;
    }
  }
  return metrics;
}
