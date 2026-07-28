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
  const startPromiseRef = useRef<Promise<NativeMeetingStartResult | null> | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const release = useCallback((capture: ActiveNativeMeeting | null) => {
    if (!capture) return;
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
  }, []);

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
      let sessionId: string | null = null;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone transcription requires a secure browser connection.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });

        const audioContext = new AudioContext();
        let capture: ActiveNativeMeeting | null = null;
        try {
          await audioContext.audioWorklet.addModule("/voice/meeting-pcm-processor.worklet.js");
          await audioContext.resume();

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
    stopLocalCapture,
  }), [activeSessionId, isStarting, readAudioLevel, start, stopLocalCapture]);

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
