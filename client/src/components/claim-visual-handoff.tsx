import { useEffect, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import {
  clearClaimVisualHandoff,
  hasActiveClaimVisualHandoff,
  subscribeToCanonicalOrbReady,
  type CanonicalOrbReadyDetail,
} from "@/lib/claim-visual-handoff";
import { cn } from "@/lib/utils";

const HANDOFF_FAIL_OPEN_MS = 12_000;
const HANDOFF_FADE_MS = 240;

interface HandoffTarget {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * A visual-only bridge across the mandatory provisional → authenticated full
 * document navigation. It renders no product data and owns no transport. The
 * real app mounts underneath; once its canonical authenticated orb paints, the
 * bridge aligns to that exact rectangle and leaves.
 */
export function ClaimVisualHandoff() {
  const [active] = useState(() => hasActiveClaimVisualHandoff());
  const [target, setTarget] = useState<HandoffTarget | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    if (!active) return;
    let settled = false;
    let removalTimer: number | undefined;

    const revealCanonicalApp = (detail?: CanonicalOrbReadyDetail) => {
      if (settled) return;
      settled = true;
      if (detail) setTarget(detail.rect);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setLeaving(true));
      });
      removalTimer = window.setTimeout(() => {
        clearClaimVisualHandoff();
        setVisible(false);
      }, HANDOFF_FADE_MS);
    };

    const unsubscribe = subscribeToCanonicalOrbReady(revealCanonicalApp);
    const failOpenTimer = window.setTimeout(() => revealCanonicalApp(), HANDOFF_FAIL_OPEN_MS);
    return () => {
      unsubscribe();
      window.clearTimeout(failOpenTimer);
      if (removalTimer !== undefined) window.clearTimeout(removalTimer);
    };
  }, [active]);

  if (!visible) return null;

  const style = target
    ? {
        top: target.top,
        left: target.left,
        width: target.width,
        height: target.height,
      }
    : undefined;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-[200] overflow-hidden bg-black transition-[background-color,opacity] duration-200 ease-out motion-reduce:transition-none",
        leaving && "bg-transparent",
      )}
      aria-hidden="true"
      data-testid="claim-visual-handoff"
    >
      <div
        className={cn(
          "absolute inset-0 transition-[top,left,width,height,opacity] duration-200 ease-out motion-reduce:transition-none",
          leaving && "opacity-0",
        )}
        style={style}
      >
        <AgentOrb
          state="listening"
          maxFrameRate={60}
          className="absolute inset-0"
        />
      </div>
    </div>
  );
}
