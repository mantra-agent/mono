import { useEffect, useRef } from "react";
import { useVoiceSession } from "@/hooks/use-voice-session";
import { useLiveVoicePublisher } from "@/hooks/use-live-voice";
import { createLogger } from "@/lib/logger";

const log = createLogger("ImmersiveVoice");

/**
 * Bounds the crossfade overlap: if the authenticated FTUE greeting is slow to
 * produce audio after the transport connects, proceed anyway so the user is
 * never stranded on a torn-down provisional session.
 */
const AUTHENTICATED_AUDIO_FALLBACK_MS = 4_000;

/**
 * Owns the PROVISIONAL voice transport lifecycle for the immersive-orb
 * entrance. Starts the provisional session on mount and ends it on unmount
 * (the shell unmounts this only after the authenticated transport has produced
 * audio). While it is the live source, it feeds visual state and audio
 * amplitude to the LiveVoice bridge that drives the persistent orb.
 */
export function ProvisionalVoiceController({ active }: { active: boolean }) {
  const voice = useVoiceSession();
  const { publishVisualState, setAudioReader } = useLiveVoicePublisher();

  useEffect(() => {
    void voice.startSession();
    return () => {
      void voice.endSession();
    };
    // Mount-once provisional lifecycle: starts and ends with this controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    publishVisualState(voice.visualState);
  }, [active, voice.visualState, publishVisualState]);

  useEffect(() => {
    if (!active) return;
    setAudioReader(voice.readAudioLevel);
  }, [active, voice.readAudioLevel, setAudioReader]);

  return null;
}

/**
 * Owns the AUTHENTICATED FTUE voice transport for the immersive-orb claim swap.
 * On mount it binds the freshly created FTUE chat session and starts a
 * chimeless voice session under the newly claimed principal. It signals
 * `onProducedAudio` the moment the authenticated agent begins speaking (its
 * FTUE greeting) — the gate the shell waits on before tearing down the
 * provisional transport. Once it is the live source it drives the orb bridge.
 */
export function AuthenticatedVoiceController({
  chatSessionId,
  active,
  onProducedAudio,
}: {
  chatSessionId: string;
  active: boolean;
  onProducedAudio: () => void;
}) {
  const voice = useVoiceSession();
  const { publishVisualState, setAudioReader } = useLiveVoicePublisher();
  const startedRef = useRef(false);
  const producedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    voice.setActiveConversationId(chatSessionId);
    void voice.startSession();
    // Mount-once authenticated lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Primary "produced audio" signal: the authenticated FTUE greeting begins.
  useEffect(() => {
    if (producedRef.current) return;
    if (voice.status === "active" && voice.agentMode === "speaking") {
      producedRef.current = true;
      log.info("Authenticated FTUE produced first audio (agent speaking)");
      onProducedAudio();
    }
  }, [voice.status, voice.agentMode, onProducedAudio]);

  // Fallback: once connected, bound the crossfade so a slow greeting cannot
  // strand the user on the torn-down provisional transport.
  useEffect(() => {
    if (voice.status !== "active") return;
    const timer = window.setTimeout(() => {
      if (producedRef.current) return;
      producedRef.current = true;
      log.warn("Authenticated FTUE audio fallback — proceeding after connect settle");
      onProducedAudio();
    }, AUTHENTICATED_AUDIO_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [voice.status, onProducedAudio]);

  useEffect(() => {
    if (!active) return;
    publishVisualState(voice.visualState);
  }, [active, voice.visualState, publishVisualState]);

  useEffect(() => {
    if (!active) return;
    setAudioReader(voice.readAudioLevel);
  }, [active, voice.readAudioLevel, setAudioReader]);

  return null;
}
