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
 * Read-only, orb-facing view of whichever voice transport is currently live.
 * The immersive orb consumes this instead of a specific `VoiceSessionProvider`,
 * so the provisional→authenticated claim swap changes the published values
 * without remounting the orb (FR-17).
 */
export interface LiveVoiceView {
  visualState: AgentVisualState;
  /** Reads the live transport's current audio amplitude 0-1 without re-rendering. */
  readAudioLevel: () => number;
}

/**
 * Publisher API used by the transport controllers. Exactly one controller is
 * the live source at a time and drives the bridge; inactive controllers stay
 * silent so the orb only reacts to the live session.
 */
export interface LiveVoicePublisher {
  publishVisualState: (state: AgentVisualState) => void;
  setAudioReader: (reader: (() => number) | null) => void;
}

const LiveVoiceViewContext = createContext<LiveVoiceView | null>(null);
const LiveVoicePublisherContext = createContext<LiveVoicePublisher | null>(null);

/**
 * Owns the single orb-facing voice view and lets exactly one transport
 * controller ("whichever session is live") drive it at a time.
 *
 * The orb reads `useLiveVoice()` from a fixed position ABOVE both voice
 * providers, so swapping the live source never remounts the orb — only the
 * published `visualState` (context state) and audio reader (a ref, so amplitude
 * never drives re-renders) change.
 */
export function LiveVoiceProvider({ children }: { children: ReactNode }) {
  const [visualState, setVisualState] = useState<AgentVisualState>("idle");
  const audioReaderRef = useRef<(() => number) | null>(null);

  const publishVisualState = useCallback((state: AgentVisualState) => {
    setVisualState((current) => (current === state ? current : state));
  }, []);

  const setAudioReader = useCallback((reader: (() => number) | null) => {
    audioReaderRef.current = reader;
  }, []);

  const readAudioLevel = useCallback(() => audioReaderRef.current?.() ?? 0, []);

  const view = useMemo<LiveVoiceView>(
    () => ({ visualState, readAudioLevel }),
    [visualState, readAudioLevel],
  );
  const publisher = useMemo<LiveVoicePublisher>(
    () => ({ publishVisualState, setAudioReader }),
    [publishVisualState, setAudioReader],
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
