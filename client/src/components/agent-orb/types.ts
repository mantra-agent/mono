import type { AgentVisualState } from '@shared/agent-visualizer';

/**
 * Agent orb render states. The one-shot entrance belongs to this visual boundary,
 * while AgentVisualState remains the canonical six-state voice/meeting protocol.
 */
export type OrbState = AgentVisualState | 'entrance';

export interface AgentOrbProps {
  /** Current agent state driving the visual signature */
  state: OrbState;
  /**
   * Audio amplitude 0-1. When undefined, a synthetic envelope is generated
   * for states that need audio reactivity (speaking, listening).
   */
  audioLevel?: number;
  /** Maximum rendered frames per second. Recall Output Media streams at 15fps. */
  maxFrameRate?: number;
  /** Pause frame production while preserving the mounted GPU scene. */
  paused?: boolean;
  /** Additional CSS class for the container */
  className?: string;
}

/** Internal visual parameters interpolated between states. */
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
  fieldEnergy: number;
  filamentDensity: number;
  cloudDensity: number;
  flowSpeed: number;
  flowStrength: number;
  coherence: number;
  attractorStrength: number;
  knotStrength: number;
  orbitPrecision: number;
  waveEnergy: number;
  coreDarkness: number;
}
