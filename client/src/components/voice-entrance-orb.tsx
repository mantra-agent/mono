import { useEffect, useRef } from "react";
import { AgentOrb } from "@/components/agent-orb";
import type { AgentOrbProps } from "@/components/agent-orb/types";
import type { VoiceSessionContextValue } from "@/hooks/use-voice-session";

interface VoiceEntranceOrbProps extends Omit<AgentOrbProps, "initialEntrance"> {
  /** Live voice session that owns the one-shot entrance gate. */
  voiceSession: VoiceSessionContextValue;
}

/**
 * Plays the renderer-owned black voice entrance exactly once per real voice
 * start. The voice session arms `voiceEntrancePending` at the canonical start
 * (`startSession`, the single path both browser and native voice flow through);
 * this wrapper reads that gate on the mount that actually shows the orb and
 * consumes it. Orb remounts from a transcript toggle or session navigation see
 * the gate already consumed, so the entrance never replays mid-session. The
 * AgentOrb producer still owns entrance timing, settle, and reduced-motion, and
 * it follows the live canonical voice state so listening can begin mid-entrance
 * without snapping. This wrapper only decides whether the one-shot is armed for
 * this mount.
 */
export function VoiceEntranceOrb({ voiceSession, ...orbProps }: VoiceEntranceOrbProps) {
  const { voiceEntrancePending, consumeVoiceEntrance } = voiceSession;
  // Capture the armed decision once for this orb mount. Seeding a ref during
  // render is idempotent, so a StrictMode double render cannot flip the
  // decision after the entrance has been chosen for this instance.
  const armedRef = useRef<boolean | null>(null);
  if (armedRef.current === null) armedRef.current = voiceEntrancePending;

  useEffect(() => {
    if (armedRef.current) consumeVoiceEntrance();
  }, [consumeVoiceEntrance]);

  return <AgentOrb initialEntrance={armedRef.current ? "voice" : undefined} {...orbProps} />;
}
