import type { AgentOrbInitialEntrance, OrbState, OrbVisuals } from './types';

/** Per-state targets for one continuous field. JS lerps every parameter. */
export const STATE_VISUALS: Record<OrbState, OrbVisuals> = {
  entrance: {
    rimPower: 3.0, rimIntensity: 0.7, coreGlow: 0.02,
    audioReactivity: 0, swirlSpeed: 0.1, swirlAmount: 0.04,
    tickCount: 0, tickSpeed: 0, breathSpeed: 1.5, breathDepth: 0.3,
    pulseStrength: 0, dimming: 1.0,
    fieldEnergy: 0.72, filamentDensity: 0.7, cloudDensity: 0.3,
    flowSpeed: 0.12, flowStrength: 0.28, coherence: 0.86,
    attractorStrength: 0, knotStrength: 0.08, orbitPrecision: 0,
    waveEnergy: 0.05, coreDarkness: 0.72,
  },
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
    audioReactivity: 1.0, swirlSpeed: 0.4, swirlAmount: 0.12,
    tickCount: 0, tickSpeed: 0, breathSpeed: 0, breathDepth: 0,
    pulseStrength: 0.3, dimming: 1.0,
    fieldEnergy: 0.95, filamentDensity: 0.72, cloudDensity: 0.32,
    flowSpeed: 0.55, flowStrength: 0.52, coherence: 0.8,
    attractorStrength: 0, knotStrength: 0.24, orbitPrecision: 0,
    waveEnergy: 0.24, coreDarkness: 0.64,
  },
  thinking: {
    rimPower: 3.2, rimIntensity: 0.74, coreGlow: 0.1,
    audioReactivity: 0, swirlSpeed: 1.15, swirlAmount: 0.48,
    tickCount: 0, tickSpeed: 0, breathSpeed: 2.45, breathDepth: 0.22,
    pulseStrength: 0, dimming: 1.0,
    fieldEnergy: 1.08, filamentDensity: 0.84, cloudDensity: 0.22,
    flowSpeed: 0.78, flowStrength: 0.68, coherence: 0.9,
    attractorStrength: 1.06, knotStrength: 1.08, orbitPrecision: 0,
    waveEnergy: 0.12, coreDarkness: 0.52,
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
export const ENTRANCE_DURATION = 3.2;
export const VOICE_ENTRANCE_DURATION = 1.9;

const VOICE_ENTRANCE_VISUALS: OrbVisuals = {
  rimPower: 4.8, rimIntensity: 0, coreGlow: 0,
  audioReactivity: 0, swirlSpeed: 0.08, swirlAmount: 0.02,
  tickCount: 0, tickSpeed: 0, breathSpeed: 0, breathDepth: 0,
  pulseStrength: 0, dimming: 0,
  fieldEnergy: 0.12, filamentDensity: 0.86, cloudDensity: 0.08,
  flowSpeed: 0.08, flowStrength: 0.12, coherence: 0.96,
  attractorStrength: 0.72, knotStrength: 0.24, orbitPrecision: 0,
  waveEnergy: 0, coreDarkness: 0.84,
};

export interface EntranceVeil {
  radiusPercent: number;
  opacity: number;
}

const ENTRANCE_REVEAL_VISUALS: OrbVisuals = {
  rimPower: 1.8, rimIntensity: 1.65, coreGlow: 0.16,
  audioReactivity: 0, swirlSpeed: 0.36, swirlAmount: 0.18,
  tickCount: 0, tickSpeed: 0, breathSpeed: 0, breathDepth: 0,
  pulseStrength: 0, dimming: 1.0,
  fieldEnergy: 1.18, filamentDensity: 0.82, cloudDensity: 0.18,
  flowSpeed: 0.42, flowStrength: 0.46, coherence: 0.94,
  attractorStrength: 0.88, knotStrength: 0.52, orbitPrecision: 0,
  waveEnergy: 0.08, coreDarkness: 0.42,
};

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

/** Entrance owns its full arc and settles into the canonical idle target. */
function entranceVisuals(elapsed: number): OrbVisuals {
  const settle = smoothstep((elapsed - 1.72) / 1.28);
  return lerpVisuals(ENTRANCE_REVEAL_VISUALS, STATE_VISUALS.idle, settle);
}

/**
 * Full-frame white holds first, then contracts into a soft terminal veil over
 * the same field. The last trace fades only after the shell is fully resolved.
 */
export function entranceVeil(elapsed: number, reducedMotion: boolean): EntranceVeil {
  if (reducedMotion) return { radiusPercent: 0, opacity: 0 };
  const progress = Math.max(0, Math.min(1, elapsed / ENTRANCE_DURATION));
  const contraction = smoothstep((progress - 0.12) / 0.46);
  const disappearance = smoothstep((progress - 0.62) / 0.2);
  return {
    radiusPercent: lerp(150, 13, contraction),
    opacity: 1 - disappearance,
  };
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
  /**
   * Snapshot of the visuals actually rendered when the current transition
   * began. Interpolating from this snapshot, rather than the prior canonical
   * target, keeps every state change continuous even when a target reverses
   * mid-blend, so rapid cadence like idle -> listening -> idle never snaps.
   */
  fromVisuals: OrbVisuals;
  nextState: OrbState;
  transitionElapsed: number;
  transitionDuration: number;
  currentVisuals: OrbVisuals;
  time: number;
  effectiveAudioLevel: number;
  entranceElapsed: number;
  initialEntrance: AgentOrbInitialEntrance | null;
  initialEntranceElapsed: number;
  initialEntranceStartProgress: number;
}

export function createAnimationState(
  initial: OrbState,
  initialEntrance?: AgentOrbInitialEntrance,
): AnimationState {
  const currentVisuals = initialEntrance === 'voice'
    ? { ...VOICE_ENTRANCE_VISUALS }
    : initial === 'entrance'
      ? entranceVisuals(0)
      : { ...STATE_VISUALS[initial] };
  return {
    fromVisuals: { ...currentVisuals },
    nextState: initial,
    transitionElapsed: TRANSITION_DURATION,
    transitionDuration: TRANSITION_DURATION,
    currentVisuals,
    time: 0,
    effectiveAudioLevel: 0,
    entranceElapsed: 0,
    initialEntrance: initialEntrance ?? null,
    initialEntranceElapsed: initialEntrance ? 0 : VOICE_ENTRANCE_DURATION,
    initialEntranceStartProgress: 0,
  };
}

/** Normalized renderer-local entrance progress for mesh presentation. */
export function initialEntranceProgress(anim: AnimationState): number {
  return smoothstep(anim.initialEntranceElapsed / VOICE_ENTRANCE_DURATION);
}

export function tickAnimation(
  anim: AnimationState,
  dt: number,
  targetState: OrbState,
  rawAudioLevel: number | undefined,
): OrbVisuals {
  anim.time += dt;

  if (targetState !== anim.nextState) {
    // Snapshot the visuals currently on screen as the transition origin so the
    // blend stays continuous through reversals instead of resetting to the prior
    // canonical target. Entrance owns its own arc and ignores this source.
    anim.fromVisuals = { ...anim.currentVisuals };
    anim.nextState = targetState;
    anim.transitionElapsed = 0;
    if (anim.initialEntrance === 'voice') {
      anim.initialEntranceStartProgress = initialEntranceProgress(anim);
    }
    if (targetState === 'entrance') anim.entranceElapsed = 0;
  }

  if (anim.initialEntrance === 'voice') {
    anim.initialEntranceElapsed = Math.min(
      anim.initialEntranceElapsed + dt,
      VOICE_ENTRANCE_DURATION,
    );
    const progress = initialEntranceProgress(anim);
    const retargetProgress = smoothstep(
      (progress - anim.initialEntranceStartProgress)
      / Math.max(0.001, 1 - anim.initialEntranceStartProgress),
    );
    anim.currentVisuals = lerpVisuals(
      anim.fromVisuals,
      STATE_VISUALS[anim.nextState],
      retargetProgress,
    );
    if (anim.initialEntranceElapsed >= VOICE_ENTRANCE_DURATION) {
      anim.initialEntrance = null;
      anim.fromVisuals = { ...anim.currentVisuals };
      anim.transitionElapsed = anim.transitionDuration;
    }
  } else if (anim.nextState === 'entrance') {
    anim.entranceElapsed = Math.min(anim.entranceElapsed + dt, ENTRANCE_DURATION);
    anim.currentVisuals = entranceVisuals(anim.entranceElapsed);
  } else {
    anim.transitionElapsed = Math.min(
      anim.transitionElapsed + dt,
      anim.transitionDuration,
    );
    const t = smoothstep(anim.transitionElapsed / anim.transitionDuration);
    anim.currentVisuals = lerpVisuals(
      anim.fromVisuals,
      STATE_VISUALS[anim.nextState],
      t,
    );
  }

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
