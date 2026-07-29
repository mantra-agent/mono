import { useEffect, useState } from "react";
import {
  clearClaimVisualHandoff,
  hasActiveClaimVisualHandoff,
  subscribeToCanonicalOrbReady,
} from "@/lib/claim-visual-handoff";
import { cn } from "@/lib/utils";

const HANDOFF_FAIL_OPEN_MS = 12_000;
const HANDOFF_FADE_MS = 240;

/**
 * A black visual veil across the mandatory provisional → authenticated full
 * document navigation. The authenticated app mounts underneath; the veil lifts
 * only after a canonical authenticated orb has painted, or after a bounded
 * fail-open. It renders no duplicate orb and owns no product or transport state.
 */
export function ClaimVisualHandoff() {
  const [active] = useState(() => hasActiveClaimVisualHandoff());
  const [leaving, setLeaving] = useState(false);
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    if (!active) return;
    let settled = false;
    let removalTimer: number | undefined;

    const revealCanonicalApp = () => {
      if (settled) return;
      settled = true;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setLeaving(true));
      });
      removalTimer = window.setTimeout(() => {
        clearClaimVisualHandoff();
        setVisible(false);
      }, HANDOFF_FADE_MS);
    };

    const unsubscribe = subscribeToCanonicalOrbReady(revealCanonicalApp);
    const failOpenTimer = window.setTimeout(revealCanonicalApp, HANDOFF_FAIL_OPEN_MS);
    return () => {
      unsubscribe();
      window.clearTimeout(failOpenTimer);
      if (removalTimer !== undefined) window.clearTimeout(removalTimer);
    };
  }, [active]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-[200] bg-black opacity-100 transition-opacity ease-out motion-reduce:transition-none",
        leaving && "opacity-0",
      )}
      style={{ transitionDuration: `${HANDOFF_FADE_MS}ms` }}
      aria-hidden="true"
      data-testid="claim-visual-handoff"
    />
  );
}
