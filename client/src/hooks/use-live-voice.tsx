import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AgentVisualState } from "@shared/agent-visualizer";

/**
 * Read-only, orb-facing view of the provisional entrance voice transport. The
 * immersive orb consumes this instead of a specific `VoiceSessionProvider`, so
 * transport state changes never remount the orb.
 */
export interface LiveVoiceView {
  visualState: AgentVisualState;
  /** Current synchronized phrase for the provisional voice entrance. */
  voiceCaption: string;
  /** Reads the live transport's current audio amplitude 0-1 without re-rendering. */
  readAudioLevel: () => number;
}

/**
 * Publisher API used by the provisional transport controller to drive the orb
 * without coupling the visual tree to the transport provider.
 */
export interface LiveVoicePublisher {
  publishVisualState: (state: AgentVisualState) => void;
  publishVoiceCaption: (caption: string) => void;
  setAudioReader: (reader: (() => number) | null) => void;
}

const LiveVoiceViewContext = createContext<LiveVoiceView | null>(null);
const LiveVoicePublisherContext = createContext<LiveVoicePublisher | null>(null);

/**
 * Owns the single orb-facing voice view. The orb reads `useLiveVoice()` from a
 * fixed position above the provisional provider, so transport state updates
 * change only the published `visualState` and audio reader; account claim exits
 * this tree and lets the authenticated AppShell become authoritative.
 */
export function LiveVoiceProvider({ children }: { children: ReactNode }) {
  const [visualState, setVisualState] = useState<AgentVisualState>("idle");
  const [voiceCaption, setVoiceCaption] = useState("");
  const audioReaderRef = useRef<(() => number) | null>(null);

  const publishVisualState = useCallback((state: AgentVisualState) => {
    setVisualState((current) => (current === state ? current : state));
  }, []);

  const publishVoiceCaption = useCallback((caption: string) => {
    setVoiceCaption((current) => (current === caption ? current : caption));
  }, []);

  const setAudioReader = useCallback((reader: (() => number) | null) => {
    audioReaderRef.current = reader;
  }, []);

  const readAudioLevel = useCallback(() => audioReaderRef.current?.() ?? 0, []);

  const view = useMemo<LiveVoiceView>(
    () => ({ visualState, voiceCaption, readAudioLevel }),
    [visualState, voiceCaption, readAudioLevel],
  );
  const publisher = useMemo<LiveVoicePublisher>(
    () => ({ publishVisualState, publishVoiceCaption, setAudioReader }),
    [publishVisualState, publishVoiceCaption, setAudioReader],
  );

  return (
    <LiveVoicePublisherContext.Provider value={publisher}>
      <LiveVoiceViewContext.Provider value={view}>{children}</LiveVoiceViewContext.Provider>
    </LiveVoicePublisherContext.Provider>
  );
}

export function useLiveVoice(): LiveVoiceView {
  const ctx = useContext(LiveVoiceViewContext);
  if (!ctx) throw new Error("useLiveVoice must be used within LiveVoiceProvider");
  return ctx;
}

export function useLiveVoicePublisher(): LiveVoicePublisher {
  const ctx = useContext(LiveVoicePublisherContext);
  if (!ctx) throw new Error("useLiveVoicePublisher must be used within LiveVoiceProvider");
  return ctx;
}
