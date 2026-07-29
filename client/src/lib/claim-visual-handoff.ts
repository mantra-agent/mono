const CLAIM_VISUAL_HANDOFF_KEY = "mantra.claim-visual-handoff";
const CLAIM_VISUAL_HANDOFF_MAX_AGE_MS = 30_000;
const CANONICAL_ORB_READY_EVENT = "mantra:canonical-orb-ready";
let canonicalOrbReady = false;

interface ClaimVisualHandoffMarker {
  startedAt: number;
}

function readMarker(): ClaimVisualHandoffMarker | null {
  try {
    const raw = window.sessionStorage.getItem(CLAIM_VISUAL_HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClaimVisualHandoffMarker>;
    if (typeof parsed.startedAt !== "number" || Date.now() - parsed.startedAt > CLAIM_VISUAL_HANDOFF_MAX_AGE_MS) {
      window.sessionStorage.removeItem(CLAIM_VISUAL_HANDOFF_KEY);
      return null;
    }
    return { startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/**
 * Starts the content-free visual veil immediately before the hard claim
 * navigation. The marker deliberately carries no bearer, identity, voice, or
 * geometry state; sessionStorage scopes it to this tab and the short expiry
 * bounds stale recovery.
 */
export function beginClaimVisualHandoff(): void {
  try {
    window.sessionStorage.setItem(
      CLAIM_VISUAL_HANDOFF_KEY,
      JSON.stringify({ startedAt: Date.now() } satisfies ClaimVisualHandoffMarker),
    );
  } catch {
    // Storage can be unavailable in hardened/private browser modes. The hard
    // ownership handoff remains correct; only the optional veil drops.
  }
}

export function hasActiveClaimVisualHandoff(): boolean {
  return readMarker() !== null;
}

export function clearClaimVisualHandoff(): void {
  try {
    window.sessionStorage.removeItem(CLAIM_VISUAL_HANDOFF_KEY);
  } catch {
    // Best effort: an unreadable marker cannot reactivate the veil.
  }
}

/** Publish readiness only after a visible canonical authenticated orb paints. */
export function publishCanonicalOrbReady(element: HTMLElement): void {
  if (!hasActiveClaimVisualHandoff()) return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  canonicalOrbReady = true;
  window.dispatchEvent(new Event(CANONICAL_ORB_READY_EVENT));
}

export function subscribeToCanonicalOrbReady(listener: () => void): () => void {
  const handleReady = () => listener();
  window.addEventListener(CANONICAL_ORB_READY_EVENT, handleReady);
  if (canonicalOrbReady) listener();
  return () => window.removeEventListener(CANONICAL_ORB_READY_EVENT, handleReady);
}
