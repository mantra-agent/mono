import { useEffect, useRef, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import { useLiveVoice } from "@/hooks/use-live-voice";
import { createLogger } from "@/lib/logger";

const log = createLogger("ImmersiveOrbSlot");

/** Entrance settle window before the orb follows live voice state. */
const ENTRANCE_SETTLE_MS = 3_200;

/**
 * The single persistent orb instance mounted in the center slot of the app
 * shell's immersive-orb presentation mode (see `AppShellImmersive`).
 *
 * It is a PURE visual bound to the LiveVoice bridge (`useLiveVoice`), mounted
 * ONCE ABOVE both the provisional and authenticated voice providers. The
 * provisional→authenticated claim swap changes which transport publishes to the
 * bridge, but never remounts this component — the orb DOM node persists across
 * the swap (FR-17). Transport lifecycle (start/end) is owned by the voice
 * controllers (`ProvisionalVoiceController` / `AuthenticatedVoiceController`),
 * not by the orb. The mount/unmount logs below make the no-remount guarantee
 * observable: exactly one mount, no unmount, across the entire swap.
 */
export function ImmersiveOrbSlot() {
  const { visualState, readAudioLevel } = useLiveVoice();
  const [entranceActive, setEntranceActive] = useState(true);
  const frameRef = useRef<number>();
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    log.info("Immersive orb mounted (persistent instance)");
    const timer = window.setTimeout(() => setEntranceActive(false), ENTRANCE_SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      log.info("Immersive orb unmounted");
    };
  }, []);

  useEffect(() => {
    let lastSampleAt = 0;
    const sample = (now: number) => {
      frameRef.current = requestAnimationFrame(sample);
      if (now - lastSampleAt < 1000 / 30) return;
      lastSampleAt = now;
      setAudioLevel(readAudioLevel());
    };
    frameRef.current = requestAnimationFrame(sample);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [readAudioLevel]);

  return (
    <main
      className="relative h-full w-full overflow-hidden bg-black"
      aria-label="Mantra voice conversation"
    >
      <AgentOrb
        state={entranceActive ? "entrance" : visualState}
        audioLevel={audioLevel}
        maxFrameRate={60}
        className="absolute inset-0"
      />
    </main>
  );
}
