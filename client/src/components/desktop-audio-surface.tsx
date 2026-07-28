import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, MessagesSquare } from "lucide-react";
import type { AgentVisualState } from "@shared/agent-visualizer";
import { AgentOrb } from "@/components/agent-orb";
import { Button } from "@/components/ui/button";

interface DesktopAudioSurfaceProps {
  visualState: AgentVisualState;
  readAudioLevel: () => number;
  transcript: ReactNode;
  renderOrb?: (audioLevel: number) => ReactNode;
  testId: string;
}

/** Shared desktop presentation for live microphone-driven experiences. */
export function DesktopAudioSurface({
  visualState,
  readAudioLevel,
  transcript,
  renderOrb,
  testId,
}: DesktopAudioSurfaceProps) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (showTranscript) {
      setAudioLevel(0);
      return;
    }

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
  }, [readAudioLevel, showTranscript]);

  if (showTranscript) {
    return (
      <div className="relative flex min-h-0 flex-1 bg-background">
        {transcript}
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="absolute bottom-4 right-4 z-10 h-11 w-11 rounded-full bg-card/90 text-foreground backdrop-blur hover:bg-card"
          onClick={() => setShowTranscript(false)}
          aria-label="Return to voice orb"
          data-testid="button-voice-orb"
        >
          <MessagesSquare className="h-4 w-4" />
        </Button>
      </div>
    );
  }

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
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute bottom-4 right-4 z-10 h-11 w-11 rounded-full bg-card/80 text-muted-foreground backdrop-blur hover:bg-card hover:text-foreground"
        onClick={() => setShowTranscript(true)}
        aria-label="Show voice transcript"
        data-testid="button-voice-transcript"
      >
        <FileText className="h-4 w-4" />
      </Button>
    </div>
  );
}
