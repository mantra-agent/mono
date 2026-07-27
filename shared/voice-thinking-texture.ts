const TAU = Math.PI * 2;

export const VOICE_THINKING_LOOP_SECONDS = 8.4;

export interface VoiceThinkingTextureOptions {
  sampleRate: number;
  frameCount: number;
  targetPeak: number;
}

type TypingTap = {
  timeSeconds: number;
  gain: number;
};

type NoisePacketOptions = {
  startSeconds: number;
  durationSeconds: number;
  gain: number;
  lowCutoffHz: number;
  highCutoffHz: number;
  holdRateHz: number;
  seed: number;
};

const TYPING_TAPS: readonly TypingTap[] = [
  { timeSeconds: 0.14, gain: 0.78 },
  { timeSeconds: 0.32, gain: 0.64 },
  { timeSeconds: 0.57, gain: 0.82 },
  { timeSeconds: 0.73, gain: 0.58 },
  { timeSeconds: 1.16, gain: 0.88 },
  { timeSeconds: 1.34, gain: 0.67 },
  { timeSeconds: 1.65, gain: 0.75 },
  { timeSeconds: 1.88, gain: 0.62 },
  { timeSeconds: 2.07, gain: 0.8 },
  { timeSeconds: 2.52, gain: 0.71 },
  { timeSeconds: 2.68, gain: 0.57 },
  { timeSeconds: 2.97, gain: 0.84 },
  { timeSeconds: 3.19, gain: 0.65 },
  { timeSeconds: 3.72, gain: 0.9 },
  { timeSeconds: 3.88, gain: 0.61 },
  { timeSeconds: 4.14, gain: 0.76 },
  { timeSeconds: 4.33, gain: 0.56 },
  { timeSeconds: 4.62, gain: 0.81 },
  { timeSeconds: 5.08, gain: 0.7 },
  { timeSeconds: 5.25, gain: 0.59 },
  { timeSeconds: 5.58, gain: 0.87 },
  { timeSeconds: 5.76, gain: 0.63 },
  { timeSeconds: 5.98, gain: 0.77 },
  { timeSeconds: 6.44, gain: 0.83 },
  { timeSeconds: 6.65, gain: 0.6 },
  { timeSeconds: 6.82, gain: 0.72 },
  { timeSeconds: 7.13, gain: 0.66 },
  { timeSeconds: 7.62, gain: 0.86 },
  { timeSeconds: 7.79, gain: 0.58 },
  { timeSeconds: 8.08, gain: 0.74 },
] as const;

function nextNoise(state: number): [number, number] {
  const nextState = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return [nextState / 0x100000000 * 2 - 1, nextState];
}

function smoothingAlpha(cutoffHz: number, sampleRate: number): number {
  const boundedCutoff = Math.max(1, Math.min(sampleRate * 0.45, cutoffHz));
  return 1 - Math.exp(-TAU * boundedCutoff / sampleRate);
}

function addNoisePacket(
  samples: Float32Array,
  sampleRate: number,
  options: NoisePacketOptions,
): void {
  const durationFrames = Math.max(1, Math.round(sampleRate * options.durationSeconds));
  const startFrame = Math.round(options.startSeconds * sampleRate) % samples.length;
  const holdFrames = Math.max(1, Math.round(sampleRate / options.holdRateHz));
  const lowAlpha = smoothingAlpha(options.lowCutoffHz, sampleRate);
  const highAlpha = smoothingAlpha(options.highCutoffHz, sampleRate);
  const releaseFrames = Math.max(1, Math.round(sampleRate * 0.014));
  let state = options.seed >>> 0;
  let heldNoise = 0;
  let low = 0;
  let high = 0;

  for (let offset = 0; offset < durationFrames; offset += 1) {
    if (offset % holdFrames === 0) [heldNoise, state] = nextNoise(state);
    low += lowAlpha * (heldNoise - low);
    high += highAlpha * (heldNoise - high);

    const time = offset / sampleRate;
    const attackProgress = Math.min(1, time / 0.0035);
    const attack = attackProgress * attackProgress * (3 - 2 * attackProgress);
    const release = Math.min(1, (durationFrames - offset) / releaseFrames);
    const envelope = attack * release * Math.exp(-time * 38);
    const frame = (startFrame + offset) % samples.length;
    samples[frame] += (high - low) * envelope * options.gain;
  }
}

function addTypingTap(
  samples: Float32Array,
  sampleRate: number,
  tap: TypingTap,
  tapIndex: number,
): void {
  const seed = (0x4d414e54 ^ Math.imul(tapIndex + 1, 0x9e3779b1)) >>> 0;
  addNoisePacket(samples, sampleRate, {
    startSeconds: tap.timeSeconds,
    durationSeconds: 0.082,
    gain: tap.gain,
    lowCutoffHz: 320,
    highCutoffHz: 2800,
    holdRateHz: 9200,
    seed,
  });

  const digitalOffset = 0.017 + (tapIndex % 4) * 0.002;
  addNoisePacket(samples, sampleRate, {
    startSeconds: tap.timeSeconds + digitalOffset,
    durationSeconds: 0.046,
    gain: tap.gain * 0.24,
    lowCutoffHz: 1100,
    highCutoffHz: 4600,
    holdRateHz: 12800,
    seed: seed ^ 0xa5a5a5a5,
  });
}

function renderSoftDigitalTyping(samples: Float32Array, sampleRate: number): void {
  TYPING_TAPS.forEach((tap, tapIndex) => {
    addTypingTap(samples, sampleRate, tap, tapIndex);
  });
}

function normalizeTexture(samples: Float32Array, targetPeak: number): Float32Array {
  let mean = 0;
  for (let index = 0; index < samples.length; index += 1) mean += samples[index];
  mean /= samples.length;

  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.tanh((samples[index] - mean) * 1.08);
    peak = Math.max(peak, Math.abs(samples[index]));
  }

  const scale = peak > 0 ? targetPeak / peak : 1;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
  return samples;
}

/**
 * Renders one seamless thinking loop as irregular clusters of soft broadband
 * taps. Each tap has a quieter pixel-like afterstroke, suggesting digital work
 * without oscillators, melody, a fixed beat, or a continuous drone.
 */
export function renderVoiceThinkingTexture({
  sampleRate,
  frameCount,
  targetPeak,
}: VoiceThinkingTextureOptions): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return new Float32Array(0);
  if (!Number.isFinite(frameCount) || frameCount <= 0) return new Float32Array(0);

  const samples = new Float32Array(Math.floor(frameCount));
  renderSoftDigitalTyping(samples, sampleRate);
  return normalizeTexture(samples, Math.max(0, Math.min(1, targetPeak)));
}
