import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { LiveVoiceProvider, useLiveVoice } from "@/hooks/use-live-voice";
import { ImmersiveOrbSlot } from "@/components/immersive-orb-slot";
import { ImmersiveClaimModal } from "@/components/immersive-claim-modal";
import { ProvisionalVoiceController } from "@/components/immersive-voice";
import {
  completeStartupOnboarding,
  getStartupOnboardingDestination,
} from "@/lib/startup-onboarding";
import { beginClaimVisualHandoff } from "@/lib/claim-visual-handoff";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";

const log = createLogger("AppShellImmersive");

/**
 * The claim affordance appears only once the provisional entrance has settled
 * AND the agent has delivered and finished its first greeting, so the card never
 * overlaps the opening utterance. These bounds keep that reveal honest without
 * ever trapping the user behind a voice event that may never arrive.
 */
/** Entrance settle window, aligned with the orb entrance (see `ImmersiveOrbSlot`). */
const CLAIM_ENTRANCE_SETTLE_MS = 3_200;
/** No greeting began by this point: there is nothing to protect, so reveal. */
const CLAIM_REVEAL_NO_SPEECH_MS = 6_000;
/** Absolute ceiling: never wait past this for a greeting to settle. */
const CLAIM_REVEAL_MAX_MS = 12_000;

interface AppShellImmersiveProps {
  /**
   * Provisional onboarding token from `/visualizer?i=<token>`. Passed to the
   * provisional `VoiceSessionProvider` (mic prompt, greeting, `/api/voice/start`,
   * hash lease, `toolMode=none`) and to the claim modal as the registration
   * authorization.
   */
  onboardingToken: string;
}

interface ImmersiveClaimGateProps {
  onboardingToken: string;
  claimed: boolean;
  onClaimed: (name: string) => void;
}

/**
 * Owns the claim-affordance reveal decision from live orb/voice state instead of
 * a blind timer. The form appears only once the entrance has settled and the
 * agent has finished its first greeting (the first real `speaking` → resting
 * transition), so the card never overlaps the opening utterance.
 *
 * Three bounded fail-open paths guarantee the form still arrives when voice is
 * imperfect: an explicit `degraded` transport reveals immediately, a no-greeting
 * deadline reveals when nothing ever speaks, and an absolute ceiling reveals if
 * a greeting begins but never settles. The reveal latches — later speaking turns
 * (answering a product question) never hide the form again.
 */
function ImmersiveClaimGate({ onboardingToken, claimed, onClaimed }: ImmersiveClaimGateProps) {
  const { visualState } = useLiveVoice();
  const [revealed, setRevealed] = useState(false);
  const [entranceSettled, setEntranceSettled] = useState(false);
  const [greetingSettled, setGreetingSettled] = useState(false);
  const hasSpokenRef = useRef(false);

  // Entrance settle, aligned with the orb entrance window.
  useEffect(() => {
    const timer = window.setTimeout(() => setEntranceSettled(true), CLAIM_ENTRANCE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Track the first real greeting: mark once the agent speaks, then settle when
  // it returns to a resting state. A `degraded` transport reveals immediately so
  // a voice failure never traps the user behind a silent orb.
  useEffect(() => {
    if (visualState === "speaking") {
      hasSpokenRef.current = true;
      return;
    }
    if (visualState === "degraded") {
      setRevealed(true);
      return;
    }
    if (hasSpokenRef.current && (visualState === "listening" || visualState === "idle")) {
      setGreetingSettled(true);
    }
  }, [visualState]);

  // Bounded fail-open. Reveal if no greeting ever begins, and enforce an absolute
  // ceiling if one begins but never settles.
  useEffect(() => {
    const noSpeech = window.setTimeout(() => {
      if (!hasSpokenRef.current) {
        log.warn("Claim reveal fail-open: no greeting detected before deadline");
        setRevealed(true);
      }
    }, CLAIM_REVEAL_NO_SPEECH_MS);
    const ceiling = window.setTimeout(() => {
      setRevealed((current) => {
        if (!current) log.warn("Claim reveal fail-open: greeting settle ceiling reached");
        return true;
      });
    }, CLAIM_REVEAL_MAX_MS);
    return () => {
      window.clearTimeout(noSpeech);
      window.clearTimeout(ceiling);
    };
  }, []);

  // Reveal once both the entrance and the greeting have settled; latch true.
  useEffect(() => {
    if (entranceSettled && greetingSettled) setRevealed(true);
  }, [entranceSettled, greetingSettled]);

  if (!revealed || claimed) return null;
  return <ImmersiveClaimModal onboardingToken={onboardingToken} onClaimed={onClaimed} />;
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
/**
 * Exit fade duration before the hard claim navigation. The entrance orb fades
 * smoothly to black, the next document boots already-black (pre-hydration theme
 * in index.html), and the claim visual bridge fades the canonical orb back in
 * once it actually paints. Symmetric fades on both sides keep it one orb.
 */
const CLAIM_EXIT_FADE_MS = 320;

export function AppShellImmersive({ onboardingToken }: AppShellImmersiveProps) {
  const [claimed, setClaimed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const handoffStartedRef = useRef(false);

  const handleClaimed = useCallback(async (claimedName: string) => {
    setClaimed(true);
    if (handoffStartedRef.current) return;
    handoffStartedRef.current = true;

    // Begin the exit fade immediately, in parallel with onboarding completion,
    // and never navigate before it has finished so the exit reads as a smooth
    // fade to black rather than a hard cut.
    setLeaving(true);
    const minFade = new Promise<void>((resolve) => window.setTimeout(resolve, CLAIM_EXIT_FADE_MS));

    try {
      const status = await completeStartupOnboarding(claimedName, { recapToken: onboardingToken });
      const destination = getStartupOnboardingDestination(status);
      if (status.ftueSessionId) {
        log.info("Claim complete: entering canonical authenticated FTUE", {
          sessionId: status.ftueSessionId,
        });
      } else {
        log.warn("Claim complete without FTUE session: entering authenticated Home");
      }
      await minFade;
      beginClaimVisualHandoff();
      window.location.replace(destination);
    } catch (err) {
      // Account claim has already established the authenticated cookie. Never
      // trap that principal inside the capability-scoped entrance if optional
      // onboarding completion fails.
      log.error("Claim onboarding completion failed: entering authenticated Home", {
        error: err instanceof Error ? err.message : String(err),
      });
      await minFade;
      beginClaimVisualHandoff();
      window.location.replace("/home");
    }
  }, [onboardingToken]);

  return (
    <LiveVoiceProvider>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-black">
        <VoiceSessionProvider onboardingToken={onboardingToken} suppressChimes={claimed}>
          <ProvisionalVoiceController />
        </VoiceSessionProvider>

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <ImmersiveOrbSlot />
          <ImmersiveClaimGate
            onboardingToken={onboardingToken}
            claimed={claimed}
            onClaimed={handleClaimed}
          />
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-50 bg-black transition-opacity ease-out motion-reduce:transition-none",
              leaving ? "opacity-100" : "opacity-0",
            )}
            style={{ transitionDuration: `${CLAIM_EXIT_FADE_MS}ms` }}
            aria-hidden="true"
          />
        </div>
      </div>
    </LiveVoiceProvider>
  );
}
