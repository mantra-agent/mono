import { AgentOrb } from "@/components/agent-orb";
import type { VoiceSessionContextValue } from "@/hooks/use-voice-session";

interface MobileVoiceViewportProps {
  voiceSession: VoiceSessionContextValue;
}

/**
 * Physical-mobile voice viewport. AppLayout and SessionTranscriptPanel retain
 * ownership of the existing top and bottom bars around this content surface.
 */
export function MobileVoiceViewport({ voiceSession }: MobileVoiceViewportProps) {
  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-black"
      data-testid="mobile-voice-viewport"
      data-voice-state={voiceSession.visualState}
    >
      <AgentOrb
        state={voiceSession.visualState}
        initialEntrance="voice"
        maxFrameRate={30}
        paused={!voiceSession.isHostForeground}
        className="absolute left-1/2 top-1/2 h-[60%] w-[60%] -translate-x-1/2 -translate-y-1/2"
      />
    </div>
  );
}
