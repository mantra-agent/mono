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
  start: () => Promise<NativeMeetingStartResult | null>;
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

export function NativeMeetingTranscriptionProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const focus = useFocusSession();
  const activeRef = useRef<ActiveNativeMeeting | null>(null);
  const audioLevelRef = useRef(0);
  const speechPlaybackEnabledRef = useRef(false);
  const speechPollAbortRef = useRef<AbortController | null>(null);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechGenerationRef = useRef(0);
  const startPromiseRef = useRef<Promise<NativeMeetingStartResult | null> | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const releaseSpeechAudio = useCallback((audio: HTMLAudioElement | null) => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const stopSpeechPlayback = useCallback(() => {
    speechPlaybackEnabledRef.current = false;
    speechGenerationRef.current += 1;
    speechPollAbortRef.current?.abort();
    speechPollAbortRef.current = null;
    const audio = speechAudioRef.current;
    speechAudioRef.current = null;
    releaseSpeechAudio(audio);
  }, [releaseSpeechAudio]);

  const runSpeechPlayback = useCallback((capture: ActiveNativeMeeting) => {
    if (speechPollAbortRef.current || !speechPlaybackEnabledRef.current) return;
    const generation = ++speechGenerationRef.current;
    const abortController = new AbortController();
    speechPollAbortRef.current = abortController;

    const audio = new Audio();
    audio.preload = "auto";
    speechAudioRef.current = audio;
    const endpoint = `/api/meetings/${encodeURIComponent(capture.sessionId)}/native-audio`;

    const loop = async () => {
      while (
        !abortController.signal.aborted
        && speechPlaybackEnabledRef.current
        && activeRef.current === capture
        && speechGenerationRef.current === generation
      ) {
        audio.src = endpoint;
        try {
          await new Promise<void>((resolve, reject) => {
            const settle = (error?: unknown) => {
              abortController.signal.removeEventListener("abort", handleAbort);
              if (error) reject(error);
              else resolve();
            };
            const handleAbort = () => settle();
            abortController.signal.addEventListener("abort", handleAbort, { once: true });
            audio.onended = () => settle();
            audio.onerror = () => settle(new Error("Native meeting speech playback failed"));
            void audio.play().catch(settle);
          });
        } catch (error) {
          if (abortController.signal.aborted) return;
          if (error instanceof DOMException && error.name === "NotAllowedError") {
            stopSpeechPlayback();
            log.error("Native meeting speech playback activation failed", {
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
          await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        } finally {
          audio.onended = null;
          audio.onerror = null;
          releaseSpeechAudio(audio);
        }
      }
    };

    void loop().finally(() => {
      if (speechPollAbortRef.current === abortController) speechPollAbortRef.current = null;
      if (speechAudioRef.current === audio) speechAudioRef.current = null;
      releaseSpeechAudio(audio);
    });
  }, [releaseSpeechAudio, stopSpeechPlayback, toast]);

  const setSpeechPlaybackEnabled = useCallback((enabled: boolean, sessionId?: string) => {
    const capture = activeRef.current;
    if (!enabled) {
      stopSpeechPlayback();
      return;
    }
    if (!capture || (sessionId && capture.sessionId !== sessionId)) return;
    speechPlaybackEnabledRef.current = true;

    // The async loop runs synchronously through its first audio.play() call,
    // preserving the Listen Mode user gesture while later requests poll in order.
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

  const start = useCallback(async (): Promise<NativeMeetingStartResult | null> => {
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
          const response = await apiRequest("POST", "/api/meetings/native", { idempotencyKey });
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
