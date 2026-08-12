import { useEffect } from "react";
import { useVoiceSession } from "@/hooks/use-voice-session";
import { useLiveVoicePublisher } from "@/hooks/use-live-voice";

/**
 * Owns the PROVISIONAL voice transport lifecycle for the immersive-orb
 * entrance. Starts the provisional session on mount and ends it when claim
 * navigation unmounts the entrance. It feeds visual state and audio amplitude
 * to the LiveVoice bridge that drives the orb without owning the visual tree.
 */
export function ProvisionalVoiceController() {
  const voice = useVoiceSession();
  const { publishVisualState, publishVoiceCaption, setAudioReader } = useLiveVoicePublisher();

  useEffect(() => {
    void voice.startSession();
    return () => {
      void voice.endSession();
    };
    // Mount-once provisional lifecycle: starts and ends with this controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    publishVisualState(voice.visualState);
  }, [voice.visualState, publishVisualState]);

  useEffect(() => {
    publishVoiceCaption(voice.voiceCaption);
  }, [voice.voiceCaption, publishVoiceCaption]);

  useEffect(() => {
    setAudioReader(voice.readAudioLevel);
  }, [voice.readAudioLevel, setAudioReader]);

  return null;
}
