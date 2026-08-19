/**
 * Feature Fast Forward — session-local operator mode over Play / AI Review.
 *
 * Mode is tab-scoped sessionStorage. The shell-owned sequencer (not FeatureRow)
 * walks runPipelineLaunch after each Feature-owned session settles so leaving
 * /features does not tear the walk down. No Feature column. No second abort.
 */

import type { FeatureStage, FeatureStatus } from "@shared/feature-pipeline";

export const FEATURE_FAST_FORWARD_KEY_PREFIX = "feature-fast-forward:";
export const FEATURE_FAST_FORWARD_MODE_EVENT = "feature-fast-forward-mode";

export type FeatureFastForwardLastLaunch = {
  job: "produce" | "review";
  stage: FeatureStage;
  statusAtLaunch: FeatureStatus;
  launchedAt: number;
  sessionId?: string | null;
};

type ModeListener = (featureId: string, on: boolean) => void;

const modeListeners = new Set<ModeListener>();

/** Survives Strict remount and route changes so the sequencer cannot double-launch. */
export const fastForwardLaunchInFlight = new Set<string>();

/** Tab-local settle memory across FeatureRow remount and /features leave. */
const lastLaunchedByFeature = new Map<string, FeatureFastForwardLastLaunch>();
const settleRefetchKeys = new Map<string, string>();

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
    // Private mode or quota — in-memory listeners still see the write path.
  }
  if (!on) {
    lastLaunchedByFeature.delete(featureId);
    settleRefetchKeys.delete(featureId);
    fastForwardLaunchInFlight.delete(featureId);
  }
  for (const listener of modeListeners) listener(featureId, on);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(FEATURE_FAST_FORWARD_MODE_EVENT, {
        detail: { featureId, on },
      }),
    );
  }
}

export function subscribeFeatureFastForwardMode(listener: ModeListener): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

/** Active Fast Forward feature ids in this tab (sessionStorage scan). */
export function listActiveFeatureFastForwardIds(): string[] {
  if (typeof sessionStorage === "undefined") return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(FEATURE_FAST_FORWARD_KEY_PREFIX)) continue;
      if (sessionStorage.getItem(key) !== "1") continue;
      const featureId = key.slice(FEATURE_FAST_FORWARD_KEY_PREFIX.length);
      if (featureId) ids.push(featureId);
    }
  } catch {
    return ids;
  }
  return ids;
}

export function getFastForwardLastLaunch(
  featureId: string,
): FeatureFastForwardLastLaunch | null {
  return lastLaunchedByFeature.get(featureId) ?? null;
}

export function setFastForwardLastLaunch(
  featureId: string,
  launch: FeatureFastForwardLastLaunch | null,
): void {
  if (!launch) {
    lastLaunchedByFeature.delete(featureId);
    return;
  }
  lastLaunchedByFeature.set(featureId, launch);
}

export function bindFastForwardLaunchSession(
  featureId: string,
  sessionId: string,
): void {
  const last = lastLaunchedByFeature.get(featureId);
  if (!last) return;
  lastLaunchedByFeature.set(featureId, { ...last, sessionId });
}

export function getFastForwardSettleRefetchKey(featureId: string): string | null {
  return settleRefetchKeys.get(featureId) ?? null;
}

export function setFastForwardSettleRefetchKey(
  featureId: string,
  key: string | null,
): void {
  if (!key) settleRefetchKeys.delete(featureId);
  else settleRefetchKeys.set(featureId, key);
}
