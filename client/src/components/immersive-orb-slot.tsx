import { useEffect, useRef, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import { useVoiceSession } from "@/hooks/use-voice-session";

/** Entrance settle window before the orb follows live voice state. */
const ENTRANCE_SETTLE_MS = 3_200;

/**
 * The single persistent orb instance mounted in the center slot of the app
 * shell's immersive-orb presentation mode (see `AppShellImmersive`).
 *
 * Behavior is a verbatim relocation of the former standalone
 * `ProvisionalVoiceVisualizer`: on mount it starts the provisional voice
 * session (mic permission, greeting, `POST /api/voice/start`, custom-LLM
 * transport, hash-keyed lease — all owned by the surrounding
 * `VoiceSessionProvider onboardingToken=...`), plays the one-shot entrance for
 * `ENTRANCE_SETTLE_MS`, then follows the live canonical voice visual state while
 * sampling audio amplitude for reactivity. Ending the session is cleaned up on
 * unmount.
 *
 * This component owns no auth, routing, or rail state. It fills its parent slot
 * so the shell can reveal rails around it later WITHOUT remounting the orb
 * (FR-17 orb persistence).
 */
export function ImmersiveOrbSlot() {
  const voiceSession = useVoiceSession();
  const [entranceActive, setEntranceActive] = useState(true);
  const frameRef = useRef<number>();
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setEntranceActive(false), ENTRANCE_SETTLE_MS);
    void voiceSession.startSession();
    return () => {
      window.clearTimeout(timer);
      void voiceSession.endSession();
    };
    // Mount-once lifecycle: the provisional session starts and ends with this slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let lastSampleAt = 0;
    const sample = (now: number) => {
      frameRef.current = requestAnimationFrame(sample);
      if (now - lastSampleAt < 1000 / 30) return;
      lastSampleAt = now;
      setAudioLevel(voiceSession.readAudioLevel());
    };
    frameRef.current = requestAnimationFrame(sample);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [voiceSession.readAudioLevel]);

  return (
    <main
      className="relative h-full w-full overflow-hidden bg-black"
      aria-label="Mantra voice conversation"
    >
      <AgentOrb
        state={entranceActive ? "entrance" : voiceSession.visualState}
        audioLevel={audioLevel}
        maxFrameRate={60}
        className="absolute inset-0"
      />
    </main>
  );
}
