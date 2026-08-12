import { VoiceEntranceOrb } from "@/components/voice-entrance-orb";
import { VoiceCaptionOverlay } from "@/components/voice-caption-overlay";
import { useVoiceCaptionsPreference } from "@/hooks/use-voice-captions-preference";
import type { VoiceSessionContextValue } from "@/hooks/use-voice-session";
import { publishCanonicalOrbReady } from "@/lib/claim-visual-handoff";
import { stripExpressionTags } from "@shared/expression-tags";

interface MobileVoiceViewportProps {
  voiceSession: VoiceSessionContextValue;
}

/**
 * Physical-mobile voice viewport. AppLayout and SessionTranscriptPanel retain
 * ownership of the existing top and bottom bars around this content surface.
 */
export function MobileVoiceViewport({ voiceSession }: MobileVoiceViewportProps) {
  const { voiceCaptions } = useVoiceCaptionsPreference();

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-black"
      data-testid="mobile-voice-viewport"
      data-voice-state={voiceSession.visualState}
    >
      <VoiceEntranceOrb
        voiceSession={voiceSession}
        state={voiceSession.visualState}
        maxFrameRate={30}
        paused={!voiceSession.isHostForeground}
        onFirstFrame={publishCanonicalOrbReady}
        className="absolute left-1/2 top-1/2 h-[60%] w-[60%] -translate-x-1/2 -translate-y-1/2"
      />
      {voiceCaptions ? <VoiceCaptionOverlay text={stripExpressionTags(voiceSession.voiceCaption)} className="bottom-6" /> : null}
    </div>
  );
}
