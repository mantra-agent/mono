import { getSetting, setSetting } from "./system-settings";

/**
 * Producer/consumer handoff between the news `batch_curate` tool (producer) and
 * the landscape scan (consumer).
 *
 * The `curate` skill scores candidate signals and calls `batch_curate`, which
 * buffers its decisions into a per-user settings key. The in-progress scan that
 * spawned the skill then reads that buffer, applies each decision onto the
 * signal rows it upserts, and clears the buffer.
 *
 * `batch_curate` therefore NEVER persists curation to signal rows itself — it is
 * a handoff buffer. Buffering only means something while a scan consumer is
 * present to apply it; a standalone curate run has no consumer and cannot
 * persist anything. This module is the single source of truth for the handoff
 * keys and protocol so the producer and consumer cannot drift.
 */

export interface CurationDecision {
  fingerprint: string;
  isRelevant: boolean;
  score: number;
  title: string;
  reason: string;
  matchedTopics: string[];
  summary?: string;
}

/** A scan's consumer marker is treated as stale after this window, so a crashed
 *  scan cannot make a later standalone curate run falsely report a live consumer. */
const CONSUMER_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** Per-user buffer of decisions awaiting application by the scan consumer. */
export function curationBufferKey(userId: string): string {
  return `skill.news-curation.lastResults.${userId}`;
}

/** Per-user marker set by the scan while it is actively consuming the buffer. */
function scanConsumerKey(userId: string): string {
  return `skill.news-curation.scanConsumer.${userId}`;
}

interface ScanConsumerMarker {
  scanRunId: string;
  at: number;
}

/** Consumer side: declare that a scan is present and will apply buffered decisions. */
export async function markScanConsumerActive(userId: string, scanRunId: string): Promise<void> {
  await setSetting(scanConsumerKey(userId), { scanRunId, at: Date.now() } satisfies ScanConsumerMarker);
}

/** Consumer side: withdraw the marker once the scan has finished consuming. */
export async function clearScanConsumer(userId: string): Promise<void> {
  await setSetting(scanConsumerKey(userId), null);
}

/** Producer side: is a fresh scan consumer present to apply buffered decisions? */
export async function isScanConsumerActive(userId: string): Promise<boolean> {
  const marker = await getSetting<ScanConsumerMarker>(scanConsumerKey(userId));
  if (!marker || typeof marker.at !== "number") return false;
  return Date.now() - marker.at < CONSUMER_ACTIVE_WINDOW_MS;
}

export type CurationBufferResult =
  | { status: "buffered"; buffered: number }
  | { status: "no_consumer"; buffered: number };

/**
 * Producer side: buffer decisions for the scan consumer to apply.
 *
 * Only writes the buffer when a scan consumer is present. When invoked with no
 * consumer (a standalone curate run), it returns a `no_consumer` discriminant
 * and writes nothing — refusing to assert a persistence that will never happen.
 */
export async function bufferCurationDecisions(
  userId: string,
  decisions: CurationDecision[],
): Promise<CurationBufferResult> {
  if (!(await isScanConsumerActive(userId))) {
    return { status: "no_consumer", buffered: decisions.length };
  }
  await setSetting(curationBufferKey(userId), decisions);
  return { status: "buffered", buffered: decisions.length };
}

/** Consumer side: read the buffered decisions for this scan, then clear them so
 *  stale results are never reused by a later scan. */
export async function readAndClearCurationBuffer(userId: string): Promise<CurationDecision[] | null> {
  const key = curationBufferKey(userId);
  try {
    const results = await getSetting<CurationDecision[]>(key);
    if (!results || !Array.isArray(results)) return null;
    await setSetting(key, null);
    return results;
  } catch {
    return null;
  }
}
