const CLAIM_VISUAL_HANDOFF_KEY = "mantra.claim-visual-handoff";
const CLAIM_VISUAL_HANDOFF_MAX_AGE_MS = 30_000;
const CANONICAL_ORB_READY_EVENT = "mantra:canonical-orb-ready";
let latestCanonicalOrbReady: CanonicalOrbReadyDetail | null = null;

interface ClaimVisualHandoffMarker {
  startedAt: number;
}

export interface CanonicalOrbReadyDetail {
  rect: Pick<DOMRectReadOnly, "top" | "left" | "width" | "height">;
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
 * Starts the content-free visual bridge immediately before the hard claim
 * navigation. The marker deliberately carries no bearer, identity, or voice
 * state; sessionStorage scopes it to this tab and the short expiry bounds stale
 * recovery.
 */
export function beginClaimVisualHandoff(): void {
  try {
    window.sessionStorage.setItem(
      CLAIM_VISUAL_HANDOFF_KEY,
      JSON.stringify({ startedAt: Date.now() } satisfies ClaimVisualHandoffMarker),
    );
  } catch {
    // Storage can be unavailable in hardened/private browser modes. The hard
    // ownership handoff remains correct; only the optional visual bridge drops.
  }
}

export function hasActiveClaimVisualHandoff(): boolean {
  return readMarker() !== null;
}

export function clearClaimVisualHandoff(): void {
  try {
    window.sessionStorage.removeItem(CLAIM_VISUAL_HANDOFF_KEY);
  } catch {
    // Best effort: an unreadable marker cannot reactivate the bridge.
  }
}

/** Publish only geometry from the canonical authenticated voice surface. */
export function publishCanonicalOrbReady(element: HTMLElement): void {
  if (!hasActiveClaimVisualHandoff()) return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  latestCanonicalOrbReady = {
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  };
  window.dispatchEvent(new CustomEvent<CanonicalOrbReadyDetail>(CANONICAL_ORB_READY_EVENT, {
    detail: latestCanonicalOrbReady,
  }));
}

export function subscribeToCanonicalOrbReady(
  listener: (detail: CanonicalOrbReadyDetail) => void,
): () => void {
  const handleReady = (event: Event) => {
    listener((event as CustomEvent<CanonicalOrbReadyDetail>).detail);
  };
  window.addEventListener(CANONICAL_ORB_READY_EVENT, handleReady);
  if (latestCanonicalOrbReady) listener(latestCanonicalOrbReady);
  return () => window.removeEventListener(CANONICAL_ORB_READY_EVENT, handleReady);
}
