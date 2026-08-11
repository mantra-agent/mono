import { VoiceEntranceOrb } from "@/components/voice-entrance-orb";
import { DesktopAudioSurface } from "@/components/desktop-audio-surface";
import { VoiceCaptionOverlay } from "@/components/voice-caption-overlay";
import { useVoiceCaptionsPreference } from "@/hooks/use-voice-captions-preference";
import type { VoiceSessionContextValue } from "@/hooks/use-voice-session";
import { publishCanonicalOrbReady } from "@/lib/claim-visual-handoff";

interface DesktopVoiceSurfaceProps {
  voiceSession: VoiceSessionContextValue;
}

/**
 * Desktop orb projection for Zero visibility during an active voice session.
 */
export function DesktopVoiceSurface({ voiceSession }: DesktopVoiceSurfaceProps) {
  const { voiceCaptions } = useVoiceCaptionsPreference();

  return (
    <div className="relative flex min-h-0 flex-1">
      <DesktopAudioSurface
        visualState={voiceSession.visualState}
        readAudioLevel={voiceSession.readAudioLevel}
        testId="desktop-voice-surface"
        renderOrb={(audioLevel) => (
          <VoiceEntranceOrb
            voiceSession={voiceSession}
            state={voiceSession.visualState}
            audioLevel={audioLevel}
            maxFrameRate={60}
            onFirstFrame={publishCanonicalOrbReady}
            className="absolute left-1/2 top-1/2 h-[60%] w-[60%] -translate-x-1/2 -translate-y-1/2 md:inset-0 md:h-full md:w-full md:translate-x-0 md:translate-y-0"
          />
        )}
      />
      {voiceCaptions ? <VoiceCaptionOverlay text={voiceSession.voiceCaption} /> : null}
    </div>
  );
}
