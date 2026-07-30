import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { useFocusSession } from "@/hooks/use-focus-session";

const log = createLogger("NativeMeetingTranscription");
const SOCKET_READY_TIMEOUT_MS = 12_000;

interface NativeMeetingStartResult {
  sessionId: string;
  sourceKey: string;
}

export interface NativeMeetingStartOptions {
  retainAudio: boolean;
  retentionDays?: number;
}

interface MeetingAudioFrame {
  type: "audio_frame";
  pcm: ArrayBuffer;
  level: number;
}

interface ActiveNativeMeeting {
  sessionId: string;
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  socket: WebSocket;
}

interface NativeMeetingTranscriptionContextValue {
  activeSessionId: string | null;
  isStarting: boolean;
  readAudioLevel: () => number;
  start: (options?: NativeMeetingStartOptions) => Promise<NativeMeetingStartResult | null>;
  setSpeechPlaybackEnabled: (enabled: boolean, sessionId?: string) => void;
  stopLocalCapture: (sessionId?: string) => void;
}

const NativeMeetingTranscriptionContext = createContext<NativeMeetingTranscriptionContextValue | null>(null);

function nativeMeetingSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/native-meeting-audio?sessionId=${encodeURIComponent(sessionId)}`;
}

function permissionMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Microphone permission is required to start transcription.";
    if (error.name === "NotFoundError") return "No microphone is available.";
    if (error.name === "NotReadableError") return "The microphone is busy or unavailable.";
  }
  return error instanceof Error ? error.message : "Could not start transcription.";
}

function waitForSocketReady(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let recognitionReady = false;
    let audioReceived = false;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      if (!error && (!recognitionReady || !audioReceived)) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = window.setTimeout(
      () => settle(new Error("No microphone audio reached Mantra. Check the selected microphone and try again.")),
      SOCKET_READY_TIMEOUT_MS,
    );
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === "ready") recognitionReady = true;
        if (message.type === "audio_started") audioReceived = true;
        settle();
      } catch {
        // Ignore non-control frames.
      }
    };
    socket.onerror = () => settle(new Error("Could not connect the microphone to Mantra."));
    socket.onclose = (event) => settle(new Error(event.reason || "The transcription connection closed."));
  });
}

/**
 * Build a short, guaranteed-decodable silent WAV as an object URL. Playing it
 * synchronously inside the Listen Mode gesture unlocks the reused audio element
 * for autoplay on iOS/WebKit, where a later fetch-driven play() would otherwise
 * be blocked. Bytes are assembled by construction so decoding never fails.
 */
function buildSilentWavUrl(): string {
  const sampleRate = 8000;
  const frames = 160; // ~20ms of 8-bit mono silence.
  const bytes = new ArrayBuffer(44 + frames);
  const view = new DataView(bytes);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + frames, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byteRate = sampleRate * 1ch * 1byte
  view.setUint16(32, 1, true); // blockAlign
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, frames, true);
  for (let i = 0; i < frames; i++) view.setUint8(44 + i, 128); // 8-bit PCM silence
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/** Abortable delay used for playback backoff between failed long-poll attempts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function NativeMeetingTranscriptionProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const focus = useFocusSession();
  const activeRef = useRef<ActiveNativeMeeting | null>(null);
  const audioLevelRef = useRef(0);
  const speechPlaybackEnabledRef = useRef(false);
  const speechPollAbortRef = useRef<AbortController | null>(null);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const silentUnlockUrlRef = useRef<string | null>(null);
  const speechGenerationRef = useRef(0);
  const startPromiseRef = useRef<Promise<NativeMeetingStartResult | null> | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const stopSpeechPlayback = useCallback(() => {
    speechPlaybackEnabledRef.current = false;
    speechGenerationRef.current += 1;
    speechPollAbortRef.current?.abort();
    speechPollAbortRef.current = null;
    // Flush any in-flight utterance but keep the element so its iOS autoplay
    // authorization survives across mute/leave/re-enable cycles.
    const audio = speechAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }, []);

  const runSpeechPlayback = useCallback((capture: ActiveNativeMeeting) => {
    if (speechPollAbortRef.current || !speechPlaybackEnabledRef.current) return;
    const generation = ++speechGenerationRef.current;
    const abortController = new AbortController();
    speechPollAbortRef.current = abortController;

    // One reused element for the whole meeting. It is unlocked synchronously
    // below inside the Listen Mode gesture so later utterances — assigned after
    // an awaited fetch — keep playing without a fresh user gesture.
    let element = speechAudioRef.current;
    if (!element) {
      element = new Audio();
      element.preload = "auto";
      speechAudioRef.current = element;
    }
    const audio = element;

    // Guaranteed-decodable silent play() inside the user gesture grants this
    // element autoplay authorization on iOS/WebKit for the session.
    if (!silentUnlockUrlRef.current) silentUnlockUrlRef.current = buildSilentWavUrl();
    audio.src = silentUnlockUrlRef.current;
    void audio.play().catch(() => undefined);

    const endpoint = `/api/meetings/${encodeURIComponent(capture.sessionId)}/native-audio`;

    // Play one buffered utterance through the unlocked element. Progressive
    // streaming from a long-poll endpoint is impossible with a bare media
    // element (it cannot see the idle 204) and MSE is unsupported on iPhone
    // Safari, so each 200 utterance plays from its own object URL.
    const playClip = (url: string) =>
      new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown) => {
          abortController.signal.removeEventListener("abort", handleAbort);
          audio.onended = null;
          audio.onerror = null;
          if (error) reject(error);
          else resolve();
        };
        const handleAbort = () => {
          audio.pause();
          settle();
        };
        abortController.signal.addEventListener("abort", handleAbort, { once: true });
        audio.onended = () => settle();
        audio.onerror = () => settle(new Error("Native meeting speech playback failed"));
        audio.src = url;
        void audio.play().catch(settle);
      });

    const loop = async () => {
      while (
        !abortController.signal.aborted
        && speechPlaybackEnabledRef.current
        && activeRef.current === capture
        && speechGenerationRef.current === generation
      ) {
        let clipUrl: string | null = null;
        try {
          // Long-poll with fetch so HTTP status is visible: an idle 204 re-polls
          // immediately instead of reaching the media element as an undecodable
          // body (the source of the "operation is not supported" failures).
          const response = await fetch(endpoint, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "audio/mpeg" },
            signal: abortController.signal,
          });
          if (response.status === 204) continue;
          if (!response.ok) {
            await sleep(1_000, abortController.signal);
            continue;
          }
          const clip = await response.blob();
          if (clip.size === 0) continue;
          clipUrl = URL.createObjectURL(clip);
          await playClip(clipUrl);
        } catch (error) {
          if (abortController.signal.aborted) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (error instanceof DOMException && error.name === "NotAllowedError") {
            stopSpeechPlayback();
            log.error("Native meeting speech playback blocked", {
              sessionId: capture.sessionId,
              error: error.message,
            });
            toast({
              title: "Could not enable spoken replies",
              description: "Tap Listen mode again to retry audio playback.",
              variant: "destructive",
            });
            return;
          }
          log.warn("Native meeting speech playback retry", {
            sessionId: capture.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(1_500, abortController.signal);
        } finally {
          if (clipUrl) URL.revokeObjectURL(clipUrl);
        }
      }
    };

    void loop().finally(() => {
      if (speechPollAbortRef.current === abortController) speechPollAbortRef.current = null;
    });
  }, [stopSpeechPlayback, toast]);

  const setSpeechPlaybackEnabled = useCallback((enabled: boolean, sessionId?: string) => {
    const capture = activeRef.current;
    if (!enabled) {
      stopSpeechPlayback();
      return;
    }
    if (!capture || (sessionId && capture.sessionId !== sessionId)) return;
    speechPlaybackEnabledRef.current = true;

    // runSpeechPlayback performs a synchronous silent play() inside this Listen
    // Mode gesture to unlock iOS autoplay before any awaited network round-trip.
    runSpeechPlayback(capture);
  }, [runSpeechPlayback, stopSpeechPlayback]);

  const release = useCallback((capture: ActiveNativeMeeting | null) => {
    if (!capture) return;
    stopSpeechPlayback();
    capture.processor.port.onmessage = null;
    capture.socket.onclose = null;
    capture.socket.onerror = null;
    if (capture.socket.readyState === WebSocket.OPEN || capture.socket.readyState === WebSocket.CONNECTING) {
      capture.socket.close(1000, "capture-ended");
    }
    capture.stream.getTracks().forEach((track) => track.stop());
    capture.source.disconnect();
    capture.processor.disconnect();
    audioLevelRef.current = 0;
    void capture.audioContext.close();
  }, [stopSpeechPlayback]);

  const stopLocalCapture = useCallback((sessionId?: string) => {
    const active = activeRef.current;
    if (!active || (sessionId && active.sessionId !== sessionId)) return;
    activeRef.current = null;
    setActiveSessionId(null);
    release(active);
  }, [release]);

  const readAudioLevel = useCallback((): number => audioLevelRef.current, []);

  const start = useCallback(async (options: NativeMeetingStartOptions = { retainAudio: false }): Promise<NativeMeetingStartResult | null> => {
    if (startPromiseRef.current) return startPromiseRef.current;
    let operation!: Promise<NativeMeetingStartResult | null>;
    operation = (async () => {
      setIsStarting(true);
      let stream: MediaStream | null = null;
      let audioContext: AudioContext | null = null;
      let sessionId: string | null = null;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone transcription requires a secure browser connection.");
        }

        // WebKit requires Web Audio activation to begin inside the original
        // user gesture. Do this before the permission promise yields control.
        audioContext = new AudioContext();
        const audioContextActivation = audioContext.state === "running"
          ? Promise.resolve()
          : audioContext.resume();

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });

        let capture: ActiveNativeMeeting | null = null;
        try {
          await audioContextActivation;
          if (audioContext.state !== "running") await audioContext.resume();
          if (audioContext.state !== "running") {
            throw new Error("The microphone audio engine did not start. Tap New Transcription and try again.");
          }
          await audioContext.audioWorklet.addModule("/voice/meeting-pcm-processor.worklet.js");

          const idempotencyKey = crypto.randomUUID();
          const response = await apiRequest("POST", "/api/meetings/native", {
            idempotencyKey,
            ...(options.retainAudio ? {
              retentionConsent: true,
              consentVersion: 1,
              retentionDays: options.retentionDays ?? 7,
            } : {}),
          });
          const created = await response.json() as { sessionId: string; sourceKey: string };
          sessionId = created.sessionId;
        const source = audioContext.createMediaStreamSource(stream);
        const processor = new AudioWorkletNode(audioContext, "meeting-pcm-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        source.connect(processor);
        // AudioWorklet processing is destination-pulled. The processor writes no
        // output samples, so this keeps capture live while remaining silent.
        processor.connect(audioContext.destination);

        const socket = new WebSocket(nativeMeetingSocketUrl(sessionId));
        capture = {
          sessionId,
          stream,
          audioContext,
          source,
          processor,
          socket,
        };
        processor.port.onmessage = (event: MessageEvent<MeetingAudioFrame>) => {
          if (event.data?.type !== "audio_frame") return;
          audioLevelRef.current = Math.max(0, Math.min(1, event.data.level));
          if (socket.readyState === WebSocket.OPEN) socket.send(event.data.pcm);
        };
        await waitForSocketReady(socket);
        socket.onclose = (event) => {
          if (activeRef.current?.sessionId !== sessionId) return;
          log.warn("Native transcription socket closed", {
            sessionId,
            code: event.code,
            reason: event.reason,
          });
          stopLocalCapture(sessionId || undefined);
          toast({
            title: "Transcription stopped",
            description: event.reason || "The microphone connection ended.",
            variant: "destructive",
          });
        };
        socket.onerror = () => {
          log.warn("Native transcription socket error", { sessionId });
        };

        stopLocalCapture();
        activeRef.current = capture;
        setActiveSessionId(sessionId);
        focus.setSessionForRoute(focus.route, sessionId);
        focus.setWidgetOpen(true);
        queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/meetings/records?limit=100&includeActive=true"] });
        log.info("Native transcription started", { sessionId });
        return { sessionId, sourceKey: created.sourceKey };
        } catch (error) {
          if (capture) release(capture);
          else {
            stream.getTracks().forEach((track) => track.stop());
            void audioContext.close();
          }
          throw error;
        }
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        if (audioContext && audioContext.state !== "closed") void audioContext.close();
        if (sessionId) {
          try {
            await apiRequest("POST", `/api/meetings/${encodeURIComponent(sessionId)}/leave`);
          } catch (cleanupError) {
            log.warn("Native transcription startup cleanup failed", { sessionId, error: cleanupError });
          }
        }
        const description = permissionMessage(error);
        log.error("Native transcription start failed", { sessionId, error });
        toast({ title: "Could not start transcription", description, variant: "destructive" });
        return null;
      } finally {
        setIsStarting(false);
        startPromiseRef.current = null;
      }
    })();
    startPromiseRef.current = operation;
    return operation;
  }, [focus, stopLocalCapture, toast]);

  useEffect(() => () => release(activeRef.current), [release]);

  // Provider unmount: fully drop the reused speech element and its silent-unlock
  // object URL. stopSpeechPlayback deliberately keeps them alive across meetings.
  useEffect(() => () => {
    const audio = speechAudioRef.current;
    speechAudioRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (silentUnlockUrlRef.current) {
      URL.revokeObjectURL(silentUnlockUrlRef.current);
      silentUnlockUrlRef.current = null;
    }
  }, []);

  const value = useMemo<NativeMeetingTranscriptionContextValue>(() => ({
    activeSessionId,
    isStarting,
    readAudioLevel,
    start,
    setSpeechPlaybackEnabled,
    stopLocalCapture,
  }), [activeSessionId, isStarting, readAudioLevel, setSpeechPlaybackEnabled, start, stopLocalCapture]);

  return (
    <NativeMeetingTranscriptionContext.Provider value={value}>
      {children}
    </NativeMeetingTranscriptionContext.Provider>
  );
}

export function useNativeMeetingTranscription(): NativeMeetingTranscriptionContextValue {
  const value = useContext(NativeMeetingTranscriptionContext);
  if (!value) throw new Error("useNativeMeetingTranscription must be used inside NativeMeetingTranscriptionProvider");
  return value;
}
