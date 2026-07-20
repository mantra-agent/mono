import type { OrbState, OrbVisuals } from './types';

/** Per-state visual parameter targets. JS lerps between these during transitions. */
export const STATE_VISUALS: Record<OrbState, OrbVisuals> = {
  idle: {
    rimPower: 3.0,
    rimIntensity: 0.7,
    coreGlow: 0.02,
    audioReactivity: 0,
    swirlSpeed: 0,
    swirlAmount: 0,
    tickCount: 0,
    tickSpeed: 0,
    breathSpeed: 1.5,
    breathDepth: 0.3,
    pulseStrength: 0,
    dimming: 1.0,
  },
  listening: {
    rimPower: 2.5,
    rimIntensity: 1.0,
    coreGlow: 0.05,
    audioReactivity: 1.0,
    swirlSpeed: 0,
    swirlAmount: 0,
    tickCount: 0,
    tickSpeed: 0,
    breathSpeed: 0,
    breathDepth: 0,
    pulseStrength: 0.3,
    dimming: 1.0,
  },
  thinking: {
    rimPower: 3.5,
    rimIntensity: 0.6,
    coreGlow: 0.08,
    audioReactivity: 0,
    swirlSpeed: 0.5,
    swirlAmount: 0.35,
    tickCount: 0,
    tickSpeed: 0,
    breathSpeed: 2.0,
    breathDepth: 0.15,
    pulseStrength: 0,
    dimming: 1.0,
  },
  tool_call: {
    rimPower: 2.0,
    rimIntensity: 0.9,
    coreGlow: 0.03,
    audioReactivity: 0,
    swirlSpeed: 0,
    swirlAmount: 0,
    tickCount: 6,
    tickSpeed: 0.8,
    breathSpeed: 0,
    breathDepth: 0,
    pulseStrength: 0,
    dimming: 1.0,
  },
  speaking: {
    rimPower: 2.0,
    rimIntensity: 1.3,
    coreGlow: 0.1,
    audioReactivity: 1.0,
    swirlSpeed: 0,
    swirlAmount: 0,
    tickCount: 0,
    tickSpeed: 0,
    breathSpeed: 0,
    breathDepth: 0,
    pulseStrength: 1.0,
    dimming: 1.0,
  },
  degraded: {
    rimPower: 4.0,
    rimIntensity: 0.15,
    coreGlow: 0.01,
    audioReactivity: 0,
    swirlSpeed: 0,
    swirlAmount: 0,
    tickCount: 0,
    tickSpeed: 0,
    breathSpeed: 3.0,
    breathDepth: 0.05,
    pulseStrength: 0,
    dimming: 0.3,
  },
};

/** Transition duration in seconds */
const TRANSITION_DURATION = 0.4;

/** Smoothstep easing */
function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** Lerp a single value */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Lerp all visual parameters */
function lerpVisuals(a: OrbVisuals, b: OrbVisuals, t: number): OrbVisuals {
  const result = {} as OrbVisuals;
  for (const key of Object.keys(a) as (keyof OrbVisuals)[]) {
    result[key] = lerp(a[key], b[key], t);
  }
  return result;
}

/**
 * Generate synthetic amplitude when no real audioLevel is provided.
 * Uses deterministic pseudo-random from time to simulate speech cadence.
 */
function syntheticAmplitude(state: OrbState, time: number): number {
  if (state === 'speaking') {
    const burst = Math.sin(time * 3.7) * 0.5 + 0.5;
    const envelope = Math.sin(time * 0.8) * 0.3 + 0.55;
    const detail = Math.sin(time * 11.3) * 0.12;
    return Math.max(0, Math.min(1, burst * envelope + detail));
  }
  if (state === 'listening') {
    return Math.sin(time * 2.3) * 0.12 + 0.18;
  }
  return 0;
}

/** Mutable animation state managed by the rAF loop */
export interface AnimationState {
  prevState: OrbState;
  nextState: OrbState;
  transitionElapsed: number;
  transitionDuration: number;
  currentVisuals: OrbVisuals;
  time: number;
  effectiveAudioLevel: number;
}

export function createAnimationState(initial: OrbState): AnimationState {
  return {
    prevState: initial,
    nextState: initial,
    transitionElapsed: TRANSITION_DURATION,
    transitionDuration: TRANSITION_DURATION,
    currentVisuals: { ...STATE_VISUALS[initial] },
    time: 0,
    effectiveAudioLevel: 0,
  };
}

/**
 * Advance animation state by one frame.
 * Returns the interpolated visuals to push into shader uniforms.
 */
export function tickAnimation(
  anim: AnimationState,
  dt: number,
  targetState: OrbState,
  rawAudioLevel: number | undefined,
): OrbVisuals {
  anim.time += dt;

  // Detect state change
  if (targetState !== anim.nextState) {
    anim.prevState = anim.nextState;
    anim.nextState = targetState;
    anim.transitionElapsed = 0;
  }

  // Advance transition
  anim.transitionElapsed = Math.min(
    anim.transitionElapsed + dt,
    anim.transitionDuration,
  );
  const t = smoothstep(anim.transitionElapsed / anim.transitionDuration);

  // Interpolate visual parameters
  const from = STATE_VISUALS[anim.prevState];
  const to = STATE_VISUALS[anim.nextState];
  anim.currentVisuals = lerpVisuals(from, to, t);

  // Resolve effective audio level
  const useSynthetic = rawAudioLevel === undefined || rawAudioLevel === 0;
  const targetAudio = useSynthetic
    ? syntheticAmplitude(anim.nextState, anim.time)
    : rawAudioLevel;
  // Smooth audio level to avoid jitter
  anim.effectiveAudioLevel = lerp(
    anim.effectiveAudioLevel,
    targetAudio,
    Math.min(1, dt * 12),
  );

  return anim.currentVisuals;
}
