import { useEffect, useState } from "react";
import { AgentOrb } from "@/components/agent-orb";
import type { OrbState } from "@/components/agent-orb";
import { VoiceCaptionOverlay } from "@/components/voice-caption-overlay";
import { decodeMeetingCaptionCues, type VoiceCaptionCue } from "@/lib/voice-caption-timeline";
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

/** Fallback decode of the plain caption header (base64url UTF-8 text). */
function decodeCaptionText(encoded: string | null): string {
  if (!encoded) return "";
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * Poll the meeting speech endpoint, play each clip, and schedule its captions
 * against the real audio clock. The server delivers true per-sentence cues
 * (`X-Meeting-Caption-Cues`) built from ElevenLabs character alignment, so each
 * caption appears exactly as that sentence is spoken — the same closed-loop
 * mechanism normal voice sessions use, instead of a word-count estimate.
 * Returns the currently visible caption for the bot tile.
 */
function useMeetingSpeech(token: string, enabled: boolean): string {
  const [caption, setCaption] = useState("");

  useEffect(() => {
    if (!token || !enabled) {
      setCaption("");
      return;
    }
    let stopped = false;
    const audio = new Audio();
    audio.preload = "auto";
    const captionTimers: number[] = [];
    const clearCaptionTimers = () => {
      captionTimers.forEach((timer) => window.clearTimeout(timer));
      captionTimers.length = 0;
    };

    const scheduleCaptions = (cues: VoiceCaptionCue[]) => {
      clearCaptionTimers();
      if (cues.length === 0) return;
      setCaption(cues[0].text);
      for (let index = 1; index < cues.length; index += 1) {
        const cue = cues[index];
        captionTimers.push(window.setTimeout(() => setCaption(cue.text), Math.max(0, cue.atMs)));
      }
    };

    const playClip = (url: string, cues: VoiceCaptionCue[]) =>
      new Promise<void>((resolve, reject) => {
        let started = false;
        const settle = (error?: unknown) => {
          audio.onended = null;
          audio.onerror = null;
          audio.onplaying = null;
          clearCaptionTimers();
          setCaption("");
          if (error) reject(error);
          else resolve();
        };
        // Anchor caption timing to actual playback start, not fetch time.
        audio.onplaying = () => {
          if (started) return;
          started = true;
          scheduleCaptions(cues);
        };
        audio.onended = () => settle();
        audio.onerror = () => settle(new Error("Meeting speech playback failed"));
        audio.src = url;
        void audio.play().catch(settle);
      });

    const loop = async () => {
      while (!stopped) {
        let clipUrl: string | null = null;
        try {
          // Fetch (not a bare media src) so the caption-cues header is readable
          // and an idle 204 re-polls immediately instead of erroring the element.
          const response = await fetch(meetingAudioEndpoint(token), {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "audio/mpeg" },
          });
          if (response.status === 204) continue;
          if (!response.ok) {
            await new Promise((resolve) => window.setTimeout(resolve, 1_500));
            continue;
          }
          const clip = await response.blob();
          if (clip.size === 0) continue;
          const fallbackText = decodeCaptionText(response.headers.get("X-Meeting-Caption"));
          const cues = decodeMeetingCaptionCues(response.headers.get("X-Meeting-Caption-Cues"))
            ?? (fallbackText ? [{ atMs: 0, text: fallbackText }] : []);
          clipUrl = URL.createObjectURL(clip);
          await playClip(clipUrl, cues);
        } catch (error) {
          if (stopped) return;
          log.debug("Meeting speech poll retry", error);
          await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        } finally {
          if (clipUrl) URL.revokeObjectURL(clipUrl);
        }
      }
    };

    void loop();
    return () => {
      stopped = true;
      clearCaptionTimers();
      audio.pause();
      audio.removeAttribute("src");
      setCaption("");
    };
  }, [enabled, token]);

  return caption;
}

function RecallMeetingVisualizer({ token, search }: { token: string; search: URLSearchParams }) {
  const feed = useMeetingVisualizerFeed(token);
  const recallMeetingLevel = useRecallMeetingLevel(Boolean(token));
  const spokenCaption = useMeetingSpeech(token, Boolean(token));

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
      {token ? <VoiceCaptionOverlay text={spokenCaption} /> : null}
    </main>
  );
}

export default function VisualizerPage() {
  const search = new URLSearchParams(window.location.search);
  const meetingToken = search.get("token")?.trim() || "";

  return <RecallMeetingVisualizer token={meetingToken} search={search} />;
}
