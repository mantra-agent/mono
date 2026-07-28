import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { LiveVoiceProvider } from "@/hooks/use-live-voice";
import { ImmersiveOrbSlot } from "@/components/immersive-orb-slot";
import { ImmersiveClaimModal } from "@/components/immersive-claim-modal";
import { ProvisionalVoiceController } from "@/components/immersive-voice";
import {
  completeStartupOnboarding,
  getStartupOnboardingDestination,
} from "@/lib/startup-onboarding";
import { beginClaimVisualHandoff } from "@/lib/claim-visual-handoff";
import { createLogger } from "@/lib/logger";

const log = createLogger("AppShellImmersive");

/**
 * Delay before the claim affordance appears over the orb, so the provisional
 * agent's greeting plays first. Aligned with the orb entrance settle window
 * (see `ImmersiveOrbSlot`) so the form arrives just after the entrance.
 */
const CLAIM_REVEAL_DELAY_MS = 3_600;

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
 * The capability-scoped provisional entrance. It deliberately owns no
 * authenticated app surface: after account claim it completes the canonical
 * onboarding mutation, then hard-navigates into the real authenticated Home
 * shell and its ordinary FTUE session deep link.
 *
 * The hard navigation is the ownership boundary. It removes the onboarding
 * capability from the active URL and cleanly mounts
 * `AuthGate → BootGate → VaultProvider → AppShell`; this provisional shell must
 * never grow a parallel authenticated Home, Simple, Session, or provider tree.
 */
export function AppShellImmersive({ onboardingToken }: AppShellImmersiveProps) {
  const [claimRevealed, setClaimRevealed] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const handoffStartedRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setClaimRevealed(true), CLAIM_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const handleClaimed = useCallback(async (claimedName: string) => {
    setClaimed(true);
    if (handoffStartedRef.current) return;
    handoffStartedRef.current = true;

    try {
      const status = await completeStartupOnboarding(claimedName);
      const destination = getStartupOnboardingDestination(status);
      if (status.ftueSessionId) {
        log.info("Claim complete: entering canonical authenticated FTUE", {
          sessionId: status.ftueSessionId,
        });
      } else {
        log.warn("Claim complete without FTUE session: entering authenticated Home");
      }
      beginClaimVisualHandoff();
      window.location.replace(destination);
    } catch (err) {
      // Account claim has already established the authenticated cookie. Never
      // trap that principal inside the capability-scoped entrance if optional
      // onboarding completion fails.
      log.error("Claim onboarding completion failed: entering authenticated Home", {
        error: err instanceof Error ? err.message : String(err),
      });
      beginClaimVisualHandoff();
      window.location.replace("/home");
    }
  }, []);

  return (
    <LiveVoiceProvider>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-black">
        <VoiceSessionProvider onboardingToken={onboardingToken} suppressChimes={claimed}>
          <ProvisionalVoiceController />
        </VoiceSessionProvider>

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
