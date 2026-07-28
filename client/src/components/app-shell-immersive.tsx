import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { ImmersiveOrbSlot } from "@/components/immersive-orb-slot";
import { ImmersiveClaimModal } from "@/components/immersive-claim-modal";

/**
 * Delay before the claim affordance appears over the orb, so the provisional
 * agent's greeting plays first. Aligned with the orb entrance settle window
 * (see `ImmersiveOrbSlot`) so the form arrives just after the entrance, not on
 * top of it.
 */
const CLAIM_REVEAL_DELAY_MS = 3_600;

interface AppShellImmersiveProps {
  /**
   * Provisional onboarding token. Passed straight through to
   * `VoiceSessionProvider` so the orb slot runs the exact provisional voice
   * flow (mic prompt, greeting, `/api/voice/start`, custom-LLM, hash lease,
   * `toolMode=none`). No User or chat session is created. It is also the
   * authorization the claim modal presents to promote the provisional
   * recipient into a real authenticated account.
   */
  onboardingToken: string;
  /**
   * Reveal the left/right rails around the persistent orb slot. Defaults to
   * hidden: the provisional entrance has no authenticated principal, so only
   * the orb shows on black. The polished rails reveal is a later step; it flips
   * this WITHOUT remounting the center orb slot (FR-17 orb persistence).
   */
  railsVisible?: boolean;
  /** Left rail content, rendered only when `railsVisible`. */
  leftRail?: ReactNode;
  /** Right rail content, rendered only when `railsVisible`. */
  rightRail?: ReactNode;
}

/**
 * The app shell in immersive-orb presentation mode.
 *
 * This is a deliberately lean sibling of the authenticated `AppShell`: it
 * reuses the same rails + center skeleton but does NOT mount the heavy
 * authenticated providers (data sync, focus session, executor status, sidebar),
 * so it can render for a provisional visitor with no authenticated principal.
 *
 * The center region always mounts exactly one `ImmersiveOrbSlot` in a fixed
 * position. Toggling `railsVisible` renders/hides the rail slots around it
 * without changing the center slot's position in the tree, so the orb is a
 * persistent shell slot that survives the future rails reveal without a
 * remount (FR-17).
 *
 * The account-claim affordance (`ImmersiveClaimModal`) floats over the orb as a
 * sibling of the orb slot after a short greeting delay. It is non-blocking: the
 * live orb/voice session stays fully interactive while the form waits.
 * Completing it establishes the authenticated session and hides the form
 * WITHOUT remounting the orb — the shell selection in `App.tsx` still keys off
 * the URL onboarding token, so this shell (and its single orb instance) stays
 * mounted across the claim.
 */
export function AppShellImmersive({
  onboardingToken,
  railsVisible = false,
  leftRail,
  rightRail,
}: AppShellImmersiveProps) {
  const [claimed, setClaimed] = useState(false);
  const [claimRevealed, setClaimRevealed] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setClaimRevealed(true), CLAIM_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <VoiceSessionProvider onboardingToken={onboardingToken}>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-black">
        {railsVisible && leftRail ? (
          <aside className="flex h-full shrink-0 flex-col overflow-hidden">{leftRail}</aside>
        ) : null}
        <div className={cn("relative flex min-w-0 flex-1 flex-col overflow-hidden")}>
          <ImmersiveOrbSlot />
          {claimRevealed && !claimed ? (
            <ImmersiveClaimModal
              onboardingToken={onboardingToken}
              onClaimed={() => setClaimed(true)}
            />
          ) : null}
        </div>
        {railsVisible && rightRail ? (
          <aside className="flex h-full shrink-0 flex-col overflow-hidden">{rightRail}</aside>
        ) : null}
      </div>
    </VoiceSessionProvider>
  );
}
