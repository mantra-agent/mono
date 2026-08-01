import { useEffect, useRef, useState } from "react";
import type { AgentVisualState } from "@shared/agent-visualizer";
import { AgentOrb } from "@/components/agent-orb";

interface DesktopAudioSurfaceProps {
  visualState: AgentVisualState;
  readAudioLevel: () => number;
  renderOrb?: (audioLevel: number) => React.ReactNode;
  testId: string;
}

/** Shared desktop orb presentation for live microphone-driven experiences. */
export function DesktopAudioSurface({
  visualState,
  readAudioLevel,
  renderOrb,
  testId,
}: DesktopAudioSurfaceProps) {
  const [audioLevel, setAudioLevel] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    let lastSampleAt = 0;
    const sample = (now: number) => {
      frameRef.current = requestAnimationFrame(sample);
      if (now - lastSampleAt < 1000 / 30) return;
      lastSampleAt = now;
      setAudioLevel(readAudioLevel());
    };
    frameRef.current = requestAnimationFrame(sample);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [readAudioLevel]);

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-black"
      data-testid={testId}
      data-voice-state={visualState}
    >
      {renderOrb ? renderOrb(audioLevel) : (
        <AgentOrb
          state={visualState}
          audioLevel={audioLevel}
          maxFrameRate={60}
          className="absolute left-1/2 top-1/2 h-[60%] w-[60%] -translate-x-1/2 -translate-y-1/2 md:inset-0 md:h-full md:w-full md:translate-x-0 md:translate-y-0"
        />
      )}
    </div>
  );
}
