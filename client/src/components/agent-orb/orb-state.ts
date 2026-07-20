import type { OrbState, OrbVisuals } from './types';

/** Per-state targets for one continuous field. JS lerps every parameter. */
export const STATE_VISUALS: Record<OrbState, OrbVisuals> = {
  idle: {
    rimPower: 3.0, rimIntensity: 0.7, coreGlow: 0.02,
    audioReactivity: 0, swirlSpeed: 0.1, swirlAmount: 0.04,
    tickCount: 0, tickSpeed: 0, breathSpeed: 1.5, breathDepth: 0.3,
    pulseStrength: 0, dimming: 1.0,
    fieldEnergy: 0.72, filamentDensity: 0.7, cloudDensity: 0.3,
    flowSpeed: 0.12, flowStrength: 0.28, coherence: 0.86,
    attractorStrength: 0, knotStrength: 0.08, orbitPrecision: 0,
    waveEnergy: 0.05, coreDarkness: 0.72,
  },
  listening: {
    rimPower: 2.5, rimIntensity: 1.0, coreGlow: 0.05,
    audioReactivity: 1.0, swirlSpeed: 0.18, swirlAmount: 0.08,
    tickCount: 0, tickSpeed: 0, breathSpeed: 0, breathDepth: 0,
    pulseStrength: 0.3, dimming: 1.0,
    fieldEnergy: 0.9, filamentDensity: 0.7, cloudDensity: 0.3,
    flowSpeed: 0.2, flowStrength: 0.34, coherence: 0.88,
    attractorStrength: 0.78, knotStrength: 0.08, orbitPrecision: 0,
    waveEnergy: 0.2, coreDarkness: 0.66,
  },
  thinking: {
    rimPower: 3.5, rimIntensity: 0.6, coreGlow: 0.08,
    audioReactivity: 0, swirlSpeed: 0.5, swirlAmount: 0.35,
    tickCount: 0, tickSpeed: 0, breathSpeed: 2.0, breathDepth: 0.15,
    pulseStrength: 0, dimming: 1.0,
    fieldEnergy: 0.86, filamentDensity: 0.76, cloudDensity: 0.24,
    flowSpeed: 0.34, flowStrength: 0.44, coherence: 0.9,
    attractorStrength: 0, knotStrength: 0.88, orbitPrecision: 0,
    waveEnergy: 0.06, coreDarkness: 0.74,
  },
  tool_call: {
    rimPower: 2.0, rimIntensity: 0.9, coreGlow: 0.03,
    audioReactivity: 0, swirlSpeed: 0.22, swirlAmount: 0.08,
    tickCount: 6, tickSpeed: 0.8, breathSpeed: 0, breathDepth: 0,
    pulseStrength: 0, dimming: 1.0,
    fieldEnergy: 0.94, filamentDensity: 0.78, cloudDensity: 0.22,
    flowSpeed: 0.24, flowStrength: 0.2, coherence: 1.0,
    attractorStrength: 0, knotStrength: 0.04, orbitPrecision: 1.0,
    waveEnergy: 0.04, coreDarkness: 0.76,
  },
  speaking: {
    rimPower: 2.0, rimIntensity: 1.3, coreGlow: 0.1,
    audioReactivity: 1.0, swirlSpeed: 0.24, swirlAmount: 0.1,
    tickCount: 0, tickSpeed: 0, breathSpeed: 0, breathDepth: 0,
    pulseStrength: 1.0, dimming: 1.0,
    fieldEnergy: 1.0, filamentDensity: 0.68, cloudDensity: 0.32,
    flowSpeed: 0.28, flowStrength: 0.38, coherence: 0.9,
    attractorStrength: 0, knotStrength: 0.05, orbitPrecision: 0,
    waveEnergy: 1.0, coreDarkness: 0.58,
  },
  degraded: {
    rimPower: 3.2, rimIntensity: 0.44, coreGlow: 0.028,
    audioReactivity: 0, swirlSpeed: 0.04, swirlAmount: 0.02,
    tickCount: 0, tickSpeed: 0, breathSpeed: 3.0, breathDepth: 0.05,
    pulseStrength: 0, dimming: 0.68,
    fieldEnergy: 0.56, filamentDensity: 0.62, cloudDensity: 0.38,
    flowSpeed: 0.05, flowStrength: 0.12, coherence: 0.22,
    attractorStrength: 0, knotStrength: 0, orbitPrecision: 0,
    waveEnergy: 0, coreDarkness: 0.82,
  },
};

const TRANSITION_DURATION = 0.55;

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVisuals(a: OrbVisuals, b: OrbVisuals, t: number): OrbVisuals {
  const result = {} as OrbVisuals;
  for (const key of Object.keys(a) as (keyof OrbVisuals)[]) {
    result[key] = lerp(a[key], b[key], t);
  }
  return result;
}

/** Deterministic fallback when a host cannot provide a real level. */
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

export function tickAnimation(
  anim: AnimationState,
  dt: number,
  targetState: OrbState,
  rawAudioLevel: number | undefined,
): OrbVisuals {
  anim.time += dt;

  if (targetState !== anim.nextState) {
    anim.prevState = anim.nextState;
    anim.nextState = targetState;
    anim.transitionElapsed = 0;
  }

  anim.transitionElapsed = Math.min(
    anim.transitionElapsed + dt,
    anim.transitionDuration,
  );
  const t = smoothstep(anim.transitionElapsed / anim.transitionDuration);
  anim.currentVisuals = lerpVisuals(
    STATE_VISUALS[anim.prevState],
    STATE_VISUALS[anim.nextState],
    t,
  );

  const targetAudio = rawAudioLevel === undefined
    ? syntheticAmplitude(anim.nextState, anim.time)
    : Math.max(0, Math.min(1, rawAudioLevel));
  anim.effectiveAudioLevel = lerp(
    anim.effectiveAudioLevel,
    targetAudio,
    Math.min(1, dt * 12),
  );

  return anim.currentVisuals;
}
