import type { FeatureStage, FeatureStatus } from "@shared/feature-pipeline";
import type { ChatSession } from "@shared/models/chat";

/**
 * Fast Forward is session-local operator mode (tab sessionStorage only).
 * Settle / launch memory is process-local so the shell host and Features row
 * share one sequencer across /features remounts without a Feature column.
 */

export const FEATURE_FAST_FORWARD_KEY_PREFIX = "feature-fast-forward:";

export type FeatureFastForwardLastLaunch = {
  job: "produce" | "review";
  stage: FeatureStage;
  launchedAt: number;
};

/** Survives Strict remount and Features page unmount within the SPA tab. */
export const fastForwardLaunchInFlight = new Set<string>();
export const fastForwardLastLaunchByFeature = new Map<string, FeatureFastForwardLastLaunch>();
export const fastForwardLaunchedSessionByFeature = new Map<string, string>();

/**
 * Auto AI Review (no Fast Forward mode) remembers the last settled Review
 * attempt per Feature so a Review-fail stays operator-owned until status leaves
 * needs_review. Keyed by featureId → `${stage}:${launchedAt}`.
 */
export const autoReviewAttemptByFeature = new Map<string, string>();
export const autoReviewLaunchInFlight = new Set<string>();

export function featureFastForwardStorageKey(featureId: string): string {
  return `${FEATURE_FAST_FORWARD_KEY_PREFIX}${featureId}`;
}

export function readFeatureFastForward(featureId: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(featureFastForwardStorageKey(featureId)) === "1";
  } catch {
    return false;
  }
}

export function writeFeatureFastForward(featureId: string, on: boolean): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const key = featureFastForwardStorageKey(featureId);
    if (on) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
  } catch {
    // Private mode or quota — callers keep in-memory UI state for this mount.
  }
}

/** Clear operator mode + process-local sequencer memory for one Feature. */
export function clearFeatureFastForwardRuntime(featureId: string): void {
  writeFeatureFastForward(featureId, false);
  fastForwardLaunchInFlight.delete(featureId);
  fastForwardLastLaunchByFeature.delete(featureId);
  fastForwardLaunchedSessionByFeature.delete(featureId);
}

export function listFeatureFastForwardIdsFromStorage(): string[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const ids: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(FEATURE_FAST_FORWARD_KEY_PREFIX)) continue;
      if (sessionStorage.getItem(key) !== "1") continue;
      const featureId = key.slice(FEATURE_FAST_FORWARD_KEY_PREFIX.length);
      if (featureId) ids.push(featureId);
    }
    return ids;
  } catch {
    return [];
  }
}

export function playIsGated(availability?: { state?: string } | null): boolean {
  return availability?.state === "waiting" || availability?.state === "unknown";
}

export function sessionHasQuestion(session: ChatSession | null | undefined): boolean {
  if (!session) return false;
  return Boolean(
    session.awaitingQuestionResponse ||
      session.awaitingReview ||
      session.reviewKinds?.includes("question"),
  );
}

export function sessionHasError(session: ChatSession | null | undefined): boolean {
  if (!session) return false;
  return session.errorSeverity === "error" || Boolean(session.reviewKinds?.includes("error"));
}

export function parseClock(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

export type FeatureFastForwardRow = {
  id: string;
  summary: string;
  description?: string | null;
  stage: FeatureStage;
  status: FeatureStatus;
  product_id: number;
  product_name?: string;
  owner_person_id?: string | null;
  spec_page_id?: string | null;
  availability?: { state: "on_stage" | "waiting" | "unknown" };
  updated_at?: string;
};
