import { useEffect, useRef, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import type { OrbState } from "@/components/agent-orb";
import { createLogger } from "@/lib/logger";
import type { AgentVisualizerEvent } from "@shared/agent-visualizer";

const log = createLogger("MeetingVisualizer");
const RECONNECT_MAX_MS = 5_000;
const VISUALIZER_STATES = new Set<OrbState>([
  "entrance",
  "idle",
  "listening",
  "thinking",
  "tool_call",
  "speaking",
  "degraded",
]);

function previewState(search: URLSearchParams): OrbState {
  const requestedState = search.get("state");
  if (requestedState === null) return "entrance";

  const state = requestedState.trim();
  return state && VISUALIZER_STATES.has(state as OrbState)
    ? state as OrbState
    : "idle";
}

function previewAudioLevel(search: URLSearchParams): number | undefined {
  const raw = search.get("level");
  if (raw === null || raw.trim() === "") return undefined;
  const level = Number(raw);
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : undefined;
}

function meetingAudioEndpoint(token: string): string {
  return `/api/meeting-output/${encodeURIComponent(token)}/audio`;
}

function visualizerSocketUrl(token: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/meeting-visualizer?token=${encodeURIComponent(token)}`;
}

function useRecallMeetingLevel(enabled: boolean): number | undefined {
  const [level, setLevel] = useState<number>();

  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    let frame = 0;
    let context: AudioContext | undefined;
    let stream: MediaStream | undefined;

    void navigator.mediaDevices.getUserMedia({ audio: true }).then((meetingStream) => {
      if (cancelled) {
        meetingStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = meetingStream;
      context = new AudioContext();
      const source = context.createMediaStreamSource(meetingStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const read = () => {
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        setLevel(Math.min(1, rms * 4.5));
        frame = window.setTimeout(read, 1000 / 15);
      };
      read();
      log.info("Recall meeting audio capture active");
    }).catch((error) => {
      log.warn("Recall meeting audio capture unavailable; using server level feed", error);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [enabled]);

  return level;
}

function useMeetingVisualizerFeed(token: string): {
  state: OrbState;
  remoteAudioLevel: number;
  connected: boolean;
  interruptNonce: number;
} {
  const [state, setState] = useState<OrbState>(token ? "idle" : "degraded");
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);
  const [connected, setConnected] = useState(false);
  const [interruptNonce, setInterruptNonce] = useState(0);

  useEffect(() => {
    if (!token) return;
    let socket: WebSocket | undefined;
    let stopped = false;
    let reconnectAttempt = 0;
    let reconnectTimer = 0;

    const connect = () => {
      socket = new WebSocket(visualizerSocketUrl(token));
      socket.onopen = () => {
        reconnectAttempt = 0;
        setConnected(true);
        log.info("Visualizer state feed connected");
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as AgentVisualizerEvent;
          if (event.type === "agent.state") setState(event.state);
          if (event.type === "audio.level") setRemoteAudioLevel(event.level);
          if (event.type === "speech.interrupt") setInterruptNonce((nonce) => nonce + 1);
        } catch (error) {
          log.warn("Invalid visualizer state event", error);
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = (event) => {
        setConnected(false);
        if (stopped) return;
        if (event.code === 1008) {
          setState("degraded");
          log.warn("Visualizer token rejected");
          return;
        }
        const delay = Math.min(500 * 1.7 ** reconnectAttempt++, RECONNECT_MAX_MS);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      socket?.close(1000, "visualizer-unmount");
    };
  }, [token]);

  return { state: connected ? state : "degraded", remoteAudioLevel, connected, interruptNonce };
}

function useMeetingSpeech(token: string, enabled: boolean, interruptNonce: number): void {
  const activeAudioRef = useRef<HTMLAudioElement | undefined>(undefined);

  useEffect(() => {
    if (!token || !enabled) return;
    let stopped = false;

    const loop = async () => {
      while (!stopped) {
        try {
          const audio = new Audio(meetingAudioEndpoint(token));
          audio.preload = "auto";
          activeAudioRef.current = audio;
          await audio.play();
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error("Meeting audio playback failed"));
          });
          audio.removeAttribute("src");
          audio.load();
          if (activeAudioRef.current === audio) activeAudioRef.current = undefined;
        } catch (error) {
          if (stopped) return;
          log.debug("Meeting speech poll retry", error);
          await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        }
      }
    };

    void loop();
    return () => {
      stopped = true;
      activeAudioRef.current?.pause();
      activeAudioRef.current?.removeAttribute("src");
      activeAudioRef.current = undefined;
    };
  }, [enabled, token]);

  // Barge-in: when the server signals an interrupt, immediately stop the audio
  // the element already buffered. Destroying the server stream ends delivery but
  // not playback; this halts the sound. The loop's onerror path then unwinds and
  // resumes polling for the next turn.
  useEffect(() => {
    if (!interruptNonce) return;
    const audio = activeAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    activeAudioRef.current = undefined;
    log.info("Meeting speech stopped by barge-in");
  }, [interruptNonce]);
}

function RecallMeetingVisualizer({ token, search }: { token: string; search: URLSearchParams }) {
  const feed = useMeetingVisualizerFeed(token);
  const recallMeetingLevel = useRecallMeetingLevel(Boolean(token));
  useMeetingSpeech(token, Boolean(token), feed.interruptNonce);

  const state = token ? feed.state : previewState(search);
  const audioLevel = token
    ? state === "listening"
      ? recallMeetingLevel ?? feed.remoteAudioLevel
      : state === "speaking" ? undefined : 0
    : previewAudioLevel(search);

  return (
    <main className="fixed inset-0 overflow-hidden bg-black" aria-label="Mantra Agent meeting visualizer">
      <AgentOrb
        state={state}
        audioLevel={audioLevel}
        maxFrameRate={token ? 15 : 60}
        sustainFrameProduction={Boolean(token)}
        className="absolute inset-0"
      />
    </main>
  );
}

export default function VisualizerPage() {
  const search = new URLSearchParams(window.location.search);
  const meetingToken = search.get("token")?.trim() || "";

  return <RecallMeetingVisualizer token={meetingToken} search={search} />;
}
