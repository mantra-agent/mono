import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { LiveVoiceProvider } from "@/hooks/use-live-voice";
import { ImmersiveOrbSlot } from "@/components/immersive-orb-slot";
import { ImmersiveClaimModal } from "@/components/immersive-claim-modal";
import { ImmersiveSimpleRail } from "@/components/immersive-simple-rail";
import {
  ProvisionalVoiceController,
  AuthenticatedVoiceController,
} from "@/components/immersive-voice";
import { completeStartupOnboarding } from "@/lib/startup-onboarding";
import { createLogger } from "@/lib/logger";

const log = createLogger("AppShellImmersive");

/**
 * Delay before the claim affordance appears over the orb, so the provisional
 * agent's greeting plays first. Aligned with the orb entrance settle window
 * (see `ImmersiveOrbSlot`) so the form arrives just after the entrance.
 */
const CLAIM_REVEAL_DELAY_MS = 3_600;

/**
 * Immersive-orb presentation phases.
 * - `provisional`: pre-claim entrance; provisional agent is the live source.
 * - `warming`: claim succeeded; authenticated FTUE transport is starting in the
 *   background while the provisional transport stays live (no seam yet).
 * - `authenticated`: the authenticated transport has produced audio; it becomes
 *   the live source, the provisional transport is torn down, and the Simple
 *   rail reveals.
 */
type ImmersivePhase = "provisional" | "warming" | "authenticated";

interface AppShellImmersiveProps {
  /**
   * Provisional onboarding token from `/visualizer?i=<token>`. Passed to the
   * provisional `VoiceSessionProvider` (mic prompt, greeting, `/api/voice/start`,
   * hash lease, `toolMode=none`) and to the claim modal as the registration
   * authorization.
   */
  onboardingToken: string;
}

/**
 * The app shell in immersive-orb presentation mode: a lean sibling of the
 * authenticated `AppShell` that mounts no heavy authenticated providers and
 * renders for a provisional visitor with no principal.
 *
 * This shell is the continuity climax of the killer-demo entrance. It owns the
 * one-orb / two-transport crossfade:
 *
 * 1. The orb (`ImmersiveOrbSlot`) is mounted ONCE inside `LiveVoiceProvider`,
 *    ABOVE both voice providers, so it is never remounted by the swap (FR-17).
 * 2. Pre-claim, the provisional `VoiceSessionProvider` runs the entrance and is
 *    the live source driving the orb.
 * 3. On claim, the authenticated FTUE session is created via the canonical
 *    onboarding path, then a chimeless authenticated `VoiceSessionProvider` is
 *    mounted alongside the provisional one and warms in the background.
 * 4. Only once the authenticated transport has PRODUCED AUDIO does the shell
 *    switch the live source, tear down the provisional transport, and slide the
 *    Simple rail in — so there is no silence, no chime, no flash, and no orb
 *    remount (ER-2 / FR-14 / FR-13 / FR-17).
 */
export function AppShellImmersive({ onboardingToken }: AppShellImmersiveProps) {
  const [claimRevealed, setClaimRevealed] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [phase, setPhase] = useState<ImmersivePhase>("provisional");
  const [ftueSessionId, setFtueSessionId] = useState<string | null>(null);
  const swapStartedRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setClaimRevealed(true), CLAIM_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Claim success → dissolve the modal immediately, create the authenticated
  // FTUE session (cookie was set by the claim), then warm its voice in the
  // background. The provisional transport keeps running until the authenticated
  // one produces audio.
  const handleClaimed = useCallback(async (claimedName: string) => {
    setClaimed(true);
    if (swapStartedRef.current) return;
    swapStartedRef.current = true;
    try {
      const status = await completeStartupOnboarding(claimedName);
      if (!status.ftueSessionId) throw new Error("onboarding returned no FTUE session id");
      log.info("Claim continuity: FTUE session ready, warming authenticated voice");
      setFtueSessionId(status.ftueSessionId);
      setPhase("warming");
    } catch (err) {
      // Degrade gracefully: the claim already established the authenticated
      // session cookie, so fall back to the real app rather than trapping the
      // user on the entrance shell.
      log.error("Claim continuity failed — falling back to app", {
        error: err instanceof Error ? err.message : String(err),
      });
      window.location.assign("/home");
    }
  }, []);

  // The authenticated transport has produced audio: promote it to the live
  // source. This unmounts the provisional provider (silent teardown) and
  // reveals the Simple rail.
  const handleAuthenticatedAudio = useCallback(() => {
    setPhase((current) => (current === "authenticated" ? current : "authenticated"));
  }, []);

  const railsRevealed = phase === "authenticated";

  return (
    <LiveVoiceProvider>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-black">
        {/* Provisional transport. Unmounted (silent teardown) only once the
            authenticated transport has produced audio (phase → authenticated).
            Chimes are suppressed the moment the crossfade begins. */}
        {phase !== "authenticated" ? (
          <VoiceSessionProvider
            onboardingToken={onboardingToken}
            suppressChimes={phase !== "provisional"}
          >
            <ProvisionalVoiceController active={phase !== "authenticated"} />
          </VoiceSessionProvider>
        ) : null}

        {/* Authenticated FTUE transport — mounted after claim, always chimeless
            so the swap has no audible connection chime. */}
        {ftueSessionId ? (
          <VoiceSessionProvider suppressChimes>
            <AuthenticatedVoiceController
              chatSessionId={ftueSessionId}
              active={phase === "authenticated"}
              onProducedAudio={handleAuthenticatedAudio}
            />
          </VoiceSessionProvider>
        ) : null}

        {/* Left rail (Simple) slides in beside the still-centered orb. The right
            rail stays hidden. */}
        <aside
          className={cn(
            "h-full shrink-0 overflow-hidden bg-background transition-[width,opacity] duration-500 ease-out",
            railsRevealed ? "w-[320px] border-r border-border/20 opacity-100" : "w-0 opacity-0",
          )}
          aria-hidden={!railsRevealed}
        >
          <div className="h-full w-[320px]">
            <ImmersiveSimpleRail />
          </div>
        </aside>

        {/* Center: the single persistent orb + non-blocking claim modal. The
            orb slot keeps a fixed position in the tree regardless of phase. */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <ImmersiveOrbSlot />
          {claimRevealed && !claimed ? (
            <ImmersiveClaimModal onboardingToken={onboardingToken} onClaimed={handleClaimed} />
          ) : null}
        </div>
      </div>
    </LiveVoiceProvider>
  );
}
