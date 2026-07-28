import { VoiceEntranceOrb } from "@/components/voice-entrance-orb";
import { DesktopAudioSurface } from "@/components/desktop-audio-surface";
import type { VoiceSessionContextValue } from "@/hooks/use-voice-session";
import { publishCanonicalOrbReady } from "@/lib/claim-visual-handoff";

interface DesktopVoiceSurfaceProps {
  voiceSession: VoiceSessionContextValue;
  transcript: React.ReactNode;
}

/**
 * Default desktop visibility layer for voice. The transcript remains the same
 * canonical session projection, revealed only when explicitly requested.
 */
export function DesktopVoiceSurface({ voiceSession, transcript }: DesktopVoiceSurfaceProps) {
  return (
    <DesktopAudioSurface
      visualState={voiceSession.visualState}
      readAudioLevel={voiceSession.readAudioLevel}
      transcript={transcript}
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
  );
}
