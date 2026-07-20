import { useEffect, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import type { OrbState } from "@/components/agent-orb";
import { createLogger } from "@/lib/logger";
import type { AgentVisualizerEvent } from "@shared/agent-visualizer";

const log = createLogger("MeetingVisualizer");
const RECONNECT_MAX_MS = 5_000;

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
} {
  const [state, setState] = useState<OrbState>(token ? "idle" : "degraded");
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);
  const [connected, setConnected] = useState(false);

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

  return { state: connected ? state : "degraded", remoteAudioLevel, connected };
}

function useMeetingSpeech(token: string, enabled: boolean): void {
  useEffect(() => {
    if (!token || !enabled) return;
    let stopped = false;
    let activeAudio: HTMLAudioElement | undefined;

    const loop = async () => {
      while (!stopped) {
        try {
          activeAudio = new Audio(meetingAudioEndpoint(token));
          activeAudio.preload = "auto";
          await activeAudio.play();
          await new Promise<void>((resolve, reject) => {
            if (!activeAudio) return reject(new Error("Meeting audio element unavailable"));
            activeAudio.onended = () => resolve();
            activeAudio.onerror = () => reject(new Error("Meeting audio playback failed"));
          });
          activeAudio.removeAttribute("src");
          activeAudio.load();
          activeAudio = undefined;
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
      activeAudio?.pause();
      activeAudio?.removeAttribute("src");
    };
  }, [enabled, token]);
}

export default function VisualizerPage() {
  const token = new URLSearchParams(window.location.search).get("token")?.trim() || "";
  const { state, remoteAudioLevel, connected } = useMeetingVisualizerFeed(token);
  const recallMeetingLevel = useRecallMeetingLevel(Boolean(token && connected));
  useMeetingSpeech(token, connected);
  const audioLevel = state === "listening"
    ? recallMeetingLevel ?? remoteAudioLevel
    : state === "speaking" ? undefined : 0;

  return (
    <main className="fixed inset-0 overflow-hidden bg-black" aria-label="Mantra Agent meeting visualizer">
      <AgentOrb
        state={state}
        audioLevel={audioLevel}
        maxFrameRate={15}
        className="absolute inset-0"
      />
    </main>
  );
}
