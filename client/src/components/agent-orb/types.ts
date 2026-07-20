/** Agent orb voice visualizer state machine */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'tool_call' | 'speaking' | 'degraded';

export interface AgentOrbProps {
  /** Current agent state driving the visual signature */
  state: OrbState;
  /**
   * Audio amplitude 0-1. When undefined or 0, a synthetic envelope
   * is generated for states that need audio reactivity (speaking, listening).
   */
  audioLevel?: number;
  /** Additional CSS class for the container */
  className?: string;
}

/** Internal visual parameters interpolated between states */
export interface OrbVisuals {
  rimPower: number;
  rimIntensity: number;
  coreGlow: number;
  audioReactivity: number;
  swirlSpeed: number;
  swirlAmount: number;
  tickCount: number;
  tickSpeed: number;
  breathSpeed: number;
  breathDepth: number;
  pulseStrength: number;
  dimming: number;
}
