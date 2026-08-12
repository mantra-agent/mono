import { useEffect, useRef, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import { VoiceCaptionOverlay } from "@/components/voice-caption-overlay";
import { useLiveVoice } from "@/hooks/use-live-voice";
import { createLogger } from "@/lib/logger";

const log = createLogger("ImmersiveOrbSlot");

/** Entrance settle window before the orb follows live voice state. */
const ENTRANCE_SETTLE_MS = 3_200;

/**
 * The single persistent orb instance mounted in the center slot of the app
 * shell's immersive-orb presentation mode (see `AppShellImmersive`).
 *
 * It is a PURE visual bound to the LiveVoice bridge (`useLiveVoice`) and mounted
 * above the provisional voice provider so transport state never owns the orb
 * DOM. Transport lifecycle (start/end) is owned by
 * `ProvisionalVoiceController`, not by the orb. Account claim then replaces the
 * capability-scoped entrance URL and cleanly mounts the real authenticated app.
 */
export function ImmersiveOrbSlot() {
  const { visualState, voiceCaption, readAudioLevel } = useLiveVoice();
  const [entranceActive, setEntranceActive] = useState(true);
  const frameRef = useRef<number>();
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    log.info("Immersive entrance orb mounted");
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
      <VoiceCaptionOverlay text={voiceCaption} />
    </main>
  );
}
