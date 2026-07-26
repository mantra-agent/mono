export const VOICE_INPUT_SAMPLE_INTERVAL_MS = 50;

const DEFAULT_CALIBRATION_MS = 300;
const DEFAULT_MAX_NOISE_FLOOR = 0.5;
const DEFAULT_HOLD_MS = 450;
const DEFAULT_MIN_ACTIVE_LEVEL = 0.04;
const DEFAULT_ABOVE_FLOOR_MARGIN = 0.055;
const DEFAULT_FLOOR_RATIO = 1.12;

export interface VoiceInputActivityDetector {
  sample: (level: number, now?: number) => boolean;
  corroborate: (now?: number) => boolean;
  reset: () => void;
}

/**
 * Converts a noisy microphone level into one stable input-activity signal.
 * The floor follows quiet rooms quickly and rising ambient noise slowly; an
 * attack is immediate, while release holds long enough to bridge word gaps.
 */
export function createVoiceInputActivityDetector(): VoiceInputActivityDetector {
  let noiseFloor: number | null = null;
  let calibrationStartedAt = 0;
  let calibrationPeak = 0;
  let active = false;
  let activeUntil = 0;

  const reset = () => {
    noiseFloor = null;
    calibrationStartedAt = 0;
    calibrationPeak = 0;
    active = false;
    activeUntil = 0;
  };

  const corroborate = (now = Date.now()) => {
    active = true;
    activeUntil = Math.max(activeUntil, now + DEFAULT_HOLD_MS);
    return active;
  };

  const sample = (rawLevel: number, now = Date.now()) => {
    const level = Number.isFinite(rawLevel)
      ? Math.max(0, Math.min(1, rawLevel))
      : 0;

    if (noiseFloor === null) {
      if (calibrationStartedAt === 0) calibrationStartedAt = now;
      calibrationPeak = Math.max(calibrationPeak, level);
      active = true;
      activeUntil = now + DEFAULT_HOLD_MS;
      if (now - calibrationStartedAt < DEFAULT_CALIBRATION_MS) return true;

      noiseFloor = Math.min(calibrationPeak, DEFAULT_MAX_NOISE_FLOOR);
      calibrationStartedAt = 0;
      calibrationPeak = 0;
    }

    const attackThreshold = Math.max(
      DEFAULT_MIN_ACTIVE_LEVEL,
      noiseFloor + DEFAULT_ABOVE_FLOOR_MARGIN,
      noiseFloor * DEFAULT_FLOOR_RATIO,
    );
    const releaseThreshold = Math.max(
      DEFAULT_MIN_ACTIVE_LEVEL * 0.75,
      noiseFloor + DEFAULT_ABOVE_FLOOR_MARGIN * 0.55,
      noiseFloor * 1.18,
    );

    if (level >= (active ? releaseThreshold : attackThreshold)) {
      active = true;
      activeUntil = now + DEFAULT_HOLD_MS;
      return true;
    }

    if (active && now < activeUntil) return true;
    active = false;

    const floorWeight = level < noiseFloor ? 0.18 : 0.008;
    noiseFloor += (level - noiseFloor) * floorWeight;
    return false;
  };

  return { sample, corroborate, reset };
}
