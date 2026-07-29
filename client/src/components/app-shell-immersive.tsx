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
/**
 * No greeting began by this point: reveal rather than trap the user behind a
 * silent orb. Generous because production greeting TTFT can run tens of
 * seconds; a premature reveal puts the account card on top of the intro.
 */
const CLAIM_REVEAL_NO_SPEECH_MS = 20_000;
/** Absolute settle ceiling anchored to the first real speech, never to mount. */
const CLAIM_REVEAL_MAX_AFTER_SPEECH_MS = 30_000;
/**
 * The resting state must hold this long before the greeting counts as settled:
 * multi-sentence intros dip to listening between utterances, and a momentary
 * dip must not fire the claim card mid-greeting.
 */
const CLAIM_GREETING_SETTLE_HOLD_MS = 2_000;

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
  const speechCeilingRef = useRef<number | undefined>(undefined);

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
      if (!hasSpokenRef.current) {
        hasSpokenRef.current = true;
        // Ceiling starts at the first real speech so a late greeting (slow
        // TTFT) still gets its full settle window instead of a mount-anchored
        // timer cutting it off mid-intro.
        speechCeilingRef.current = window.setTimeout(() => {
          setRevealed((current) => {
            if (!current) log.warn("Claim reveal fail-open: greeting settle ceiling reached");
            return true;
          });
        }, CLAIM_REVEAL_MAX_AFTER_SPEECH_MS);
      }
      return;
    }
    if (visualState === "degraded") {
      setRevealed(true);
      return;
    }
    if (hasSpokenRef.current && (visualState === "listening" || visualState === "idle")) {
      const settleHold = window.setTimeout(() => setGreetingSettled(true), CLAIM_GREETING_SETTLE_HOLD_MS);
      return () => window.clearTimeout(settleHold);
    }
  }, [visualState]);

  useEffect(() => () => {
    if (speechCeilingRef.current !== undefined) window.clearTimeout(speechCeilingRef.current);
  }, []);

  // Bounded fail-open: reveal when no greeting ever begins.
  useEffect(() => {
    const noSpeech = window.setTimeout(() => {
      if (!hasSpokenRef.current) {
        log.warn("Claim reveal fail-open: no greeting detected before deadline");
        setRevealed(true);
      }
    }, CLAIM_REVEAL_NO_SPEECH_MS);
    return () => window.clearTimeout(noSpeech);
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
 * in index.html), and its handoff veil lifts once the canonical authenticated
 * orb actually paints. No second orb crosses the ownership boundary.
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

    // Resolve the destination while the orb stays alive. The visitor just spoke
    // to it, so a living orb — not a dead black hold — covers the brief
    // onboarding write. The FTUE deep link is only known once completion returns,
    // so the fade must wait for it; the wait happens over the orb, and the
    // fade-to-black is a crisp final beat immediately before navigation.
    let destination = "/home";
    try {
      const status = await completeStartupOnboarding(claimedName, { recapToken: onboardingToken });
      destination = getStartupOnboardingDestination(status);
      if (status.ftueSessionId) {
        log.info("Claim complete: entering canonical authenticated FTUE", {
          sessionId: status.ftueSessionId,
        });
      } else {
        log.warn("Claim complete without FTUE session: entering authenticated Home");
      }
    } catch (err) {
      // Account claim has already established the authenticated cookie. Never
      // trap that principal inside the capability-scoped entrance if optional
      // onboarding completion fails; fall through to authenticated Home.
      log.error("Claim onboarding completion failed: entering authenticated Home", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Now the crisp fade to black, then the hard ownership handoff. The next
    // document boots already-black and lifts its veil only after the canonical
    // authenticated orb paints, avoiding any duplicate visual owner.
    setLeaving(true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, CLAIM_EXIT_FADE_MS));
    beginClaimVisualHandoff();
    window.location.replace(destination);
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
