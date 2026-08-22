import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@/lib/logger";

const log = createLogger("SosLiveListening");

export interface SosLiveUtterance {
  id: string;
  text: string;
  isFinal: boolean;
  startedAt?: string;
  endedAt?: string;
  speakerId: string;
}

interface Capture {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  socket: WebSocket;
}

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/sos-live-audio`;
}

function waitForReady(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Listening connection timed out.")), 15_000);
    const fail = () => {
      window.clearTimeout(timer);
      reject(new Error("Listening connection failed."));
    };
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
        if (message.type === "ready") {
          window.clearTimeout(timer);
          resolve();
        } else if (message.type === "error") {
          window.clearTimeout(timer);
          reject(new Error(message.message || "Recognition failed."));
        }
      } catch { /* Ignore malformed provider-independent diagnostics. */ }
    };
  });
}

export function useSosLiveListening() {
  const captureRef = useRef<Capture | null>(null);
  const startingRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "starting" | "listening" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<SosLiveUtterance[]>([]);

  const stop = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      capture.processor.port.onmessage = null;
      capture.socket.onclose = null;
      capture.socket.onerror = null;
      if (capture.socket.readyState === WebSocket.OPEN || capture.socket.readyState === WebSocket.CONNECTING) capture.socket.close(1000, "Listening stopped");
      capture.processor.disconnect();
      capture.source.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      void capture.audioContext.close();
    }
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || captureRef.current) return;
    startingRef.current = true;
    setStatus("starting");
    setError(null);
    setUtterances([]);
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("A secure browser microphone is required.");
      audioContext = new AudioContext();
      const activation = audioContext.state === "running" ? Promise.resolve() : audioContext.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      await activation;
      if (audioContext.state !== "running") await audioContext.resume();
      await audioContext.audioWorklet.addModule("/voice/meeting-pcm-processor.worklet.js");
      const source = audioContext.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(audioContext, "meeting-pcm-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      source.connect(processor);
      processor.connect(audioContext.destination);
      const socket = new WebSocket(socketUrl());
      const capture: Capture = { stream, audioContext, source, processor, socket };
      captureRef.current = capture;
      processor.port.onmessage = (event: MessageEvent<{ type?: string; pcm?: ArrayBuffer }>) => {
        if (event.data?.type === "audio_frame" && socket.readyState === WebSocket.OPEN && event.data.pcm) socket.send(event.data.pcm);
      };
      await waitForReady(socket);
      if (captureRef.current !== capture) return;
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; message?: string; utterance?: SosLiveUtterance };
          if (message.type === "utterance" && message.utterance) {
            setUtterances((current) => {
              const next = current.filter((item) => item.id !== message.utterance!.id);
              return [...next, message.utterance!].slice(-24);
            });
          } else if (message.type === "error") {
            setError(message.message || "Recognition failed.");
          }
        } catch { /* Ignore malformed diagnostics. */ }
      };
      socket.onclose = (event) => {
        if (captureRef.current !== capture) return;
        log.warn("SOS listening socket closed", { code: event.code, reason: event.reason });
        stop();
        if (event.code !== 1000) {
          setStatus("error");
          setError(event.reason || "Listening connection ended.");
        }
      };
      socket.onerror = () => log.warn("SOS listening socket error");
      stream.getTracks().forEach((track) => track.addEventListener("ended", stop, { once: true }));
      setStatus("listening");
    } catch (caught) {
      if (!captureRef.current) {
        stream?.getTracks().forEach((track) => track.stop());
        if (audioContext && audioContext.state !== "closed") void audioContext.close();
      } else stop();
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Listening failed.");
    } finally {
      startingRef.current = false;
    }
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { status, error, utterances, start, stop };
}
