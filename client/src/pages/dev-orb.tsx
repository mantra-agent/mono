import { useState, useEffect, useCallback, useRef } from 'react';
import { AgentOrb } from '@/components/agent-orb';
import type { OrbState } from '@/components/agent-orb';

const ALL_STATES: OrbState[] = [
  'idle',
  'listening',
  'thinking',
  'tool_call',
  'speaking',
  'degraded',
];

const STATE_LABELS: Record<OrbState, string> = {
  idle: 'Idle — breathing glow',
  listening: 'Listening — amplitude-reactive rim',
  thinking: 'Thinking — internal swirl',
  tool_call: 'Tool Call — orbital ticks',
  speaking: 'Speaking — strong pulse',
  degraded: 'Degraded — dimmed',
};

/**
 * Dev-only harness for visually testing all AgentOrb states.
 * Toggle states, drive amplitude manually, or let the synthetic envelope run.
 */
export default function DevOrbPage() {
  const [currentState, setCurrentState] = useState<OrbState>('idle');
  const [audioLevel, setAudioLevel] = useState(0);
  const [useSynthetic, setUseSynthetic] = useState(true);
  const [autoCycle, setAutoCycle] = useState(false);
  const cycleIndexRef = useRef(0);

  // Auto-cycle through states
  useEffect(() => {
    if (!autoCycle) return;
    const interval = setInterval(() => {
      cycleIndexRef.current = (cycleIndexRef.current + 1) % ALL_STATES.length;
      setCurrentState(ALL_STATES[cycleIndexRef.current]);
    }, 3000);
    return () => clearInterval(interval);
  }, [autoCycle]);

  const handleStateClick = useCallback((s: OrbState) => {
    setCurrentState(s);
    setAutoCycle(false);
  }, []);

  return (
    <div className="flex h-screen w-full bg-black">
      {/* Orb viewport */}
      <div className="flex-1 relative">
        <AgentOrb
          state={currentState}
          audioLevel={useSynthetic ? undefined : audioLevel}
          className="absolute inset-0"
        />
        {/* State indicator overlay */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-card/80 px-3 py-1.5 text-sm font-medium text-foreground backdrop-blur-sm">
          {STATE_LABELS[currentState]}
        </div>
      </div>

      {/* Controls panel */}
      <div className="w-72 shrink-0 border-l border-border/20 bg-card/50 p-4 flex flex-col gap-4 overflow-y-auto">
        <h2 className="text-base font-semibold text-foreground">
          AgentOrb Harness
        </h2>

        {/* State buttons */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            State
          </span>
          {ALL_STATES.map((s) => (
            <button
              key={s}
              onClick={() => handleStateClick(s)}
              className={`rounded px-3 py-1.5 text-left text-sm transition-colors ${
                currentState === s
                  ? 'bg-cta text-cta-foreground'
                  : 'bg-card hover:bg-accent text-foreground'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Auto-cycle toggle */}
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoCycle}
            onChange={(e) => setAutoCycle(e.target.checked)}
            className="rounded"
          />
          Auto-cycle (3s)
        </label>

        {/* Audio controls */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Audio
          </span>

          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={useSynthetic}
              onChange={(e) => setUseSynthetic(e.target.checked)}
              className="rounded"
            />
            Synthetic envelope
          </label>

          {!useSynthetic && (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Amplitude</span>
                <span>{audioLevel.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={audioLevel}
                onChange={(e) => setAudioLevel(parseFloat(e.target.value))}
                className="w-full accent-cta"
              />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="mt-auto text-xs text-muted-foreground leading-relaxed">
          <p>
            This harness renders the AgentOrb component in isolation. Each state
            has a distinct visual signature. Audio reactivity is visible in
            <strong> listening</strong> and <strong>speaking</strong> states.
          </p>
          <p className="mt-2">
            Toggle "Synthetic envelope" off to drive amplitude manually with the
            slider.
          </p>
        </div>
      </div>
    </div>
  );
}
