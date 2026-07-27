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

type MicroDropletOptions = {
  startSeconds: number;
  durationSeconds: number;
  gain: number;
  startFrequencyHz: number;
  endFrequencyHz: number;
};

type CascadeStep = {
  delaySeconds: number;
  gainScale: number;
};

const DROPLET_CASCADE: readonly CascadeStep[] = [
  { delaySeconds: 0, gainScale: 1 },
  { delaySeconds: 0.136, gainScale: 0.42 },
  { delaySeconds: 0.28, gainScale: 0.21 },
  { delaySeconds: 0.432, gainScale: 0.1 },
  { delaySeconds: 0.592, gainScale: 0.045 },
] as const;

const TYPING_TAPS: readonly TypingTap[] = [
  { timeSeconds: 0.14, gain: 0.78 },
  { timeSeconds: 0.23, gain: 0.55 },
  { timeSeconds: 0.32, gain: 0.64 },
  { timeSeconds: 0.45, gain: 0.73 },
  { timeSeconds: 0.57, gain: 0.82 },
  { timeSeconds: 0.66, gain: 0.52 },
  { timeSeconds: 0.73, gain: 0.58 },
  { timeSeconds: 0.94, gain: 0.76 },
  { timeSeconds: 1.16, gain: 0.88 },
  { timeSeconds: 1.25, gain: 0.6 },
  { timeSeconds: 1.34, gain: 0.67 },
  { timeSeconds: 1.48, gain: 0.79 },
  { timeSeconds: 1.65, gain: 0.75 },
  { timeSeconds: 1.77, gain: 0.54 },
  { timeSeconds: 1.88, gain: 0.62 },
  { timeSeconds: 1.98, gain: 0.7 },
  { timeSeconds: 2.07, gain: 0.8 },
  { timeSeconds: 2.32, gain: 0.59 },
  { timeSeconds: 2.52, gain: 0.71 },
  { timeSeconds: 2.6, gain: 0.81 },
  { timeSeconds: 2.68, gain: 0.57 },
  { timeSeconds: 2.83, gain: 0.69 },
  { timeSeconds: 2.97, gain: 0.84 },
  { timeSeconds: 3.08, gain: 0.53 },
  { timeSeconds: 3.19, gain: 0.65 },
  { timeSeconds: 3.46, gain: 0.78 },
  { timeSeconds: 3.72, gain: 0.9 },
  { timeSeconds: 3.8, gain: 0.56 },
  { timeSeconds: 3.88, gain: 0.61 },
  { timeSeconds: 4.01, gain: 0.74 },
  { timeSeconds: 4.14, gain: 0.76 },
  { timeSeconds: 4.24, gain: 0.51 },
  { timeSeconds: 4.33, gain: 0.56 },
  { timeSeconds: 4.48, gain: 0.68 },
  { timeSeconds: 4.62, gain: 0.81 },
  { timeSeconds: 4.84, gain: 0.58 },
  { timeSeconds: 5.08, gain: 0.7 },
  { timeSeconds: 5.17, gain: 0.77 },
  { timeSeconds: 5.25, gain: 0.59 },
  { timeSeconds: 5.43, gain: 0.65 },
  { timeSeconds: 5.58, gain: 0.87 },
  { timeSeconds: 5.67, gain: 0.55 },
  { timeSeconds: 5.76, gain: 0.63 },
  { timeSeconds: 5.88, gain: 0.72 },
  { timeSeconds: 5.98, gain: 0.77 },
  { timeSeconds: 6.19, gain: 0.57 },
  { timeSeconds: 6.44, gain: 0.83 },
  { timeSeconds: 6.55, gain: 0.69 },
  { timeSeconds: 6.65, gain: 0.6 },
  { timeSeconds: 6.74, gain: 0.75 },
  { timeSeconds: 6.82, gain: 0.72 },
  { timeSeconds: 6.96, gain: 0.52 },
  { timeSeconds: 7.13, gain: 0.66 },
  { timeSeconds: 7.38, gain: 0.79 },
  { timeSeconds: 7.62, gain: 0.86 },
  { timeSeconds: 7.7, gain: 0.54 },
  { timeSeconds: 7.79, gain: 0.58 },
  { timeSeconds: 7.92, gain: 0.71 },
  { timeSeconds: 8.08, gain: 0.74 },
  { timeSeconds: 8.25, gain: 0.62 },
] as const;

function addMicroDroplet(
  samples: Float32Array,
  sampleRate: number,
  options: MicroDropletOptions,
): void {
  const durationFrames = Math.max(1, Math.round(sampleRate * options.durationSeconds));
  const startFrame = Math.round(options.startSeconds * sampleRate) % samples.length;
  const releaseFrames = Math.max(1, Math.round(sampleRate * 0.006));
  const glideRatio = options.endFrequencyHz / options.startFrequencyHz;
  let phase = 0;

  for (let offset = 0; offset < durationFrames; offset += 1) {
    const time = offset / sampleRate;
    const progress = durationFrames > 1 ? offset / (durationFrames - 1) : 1;
    const frequency = options.startFrequencyHz * Math.pow(glideRatio, progress);
    phase += TAU * frequency / sampleRate;

    const attackProgress = Math.min(1, time / 0.003);
    const attack = attackProgress * attackProgress * (3 - 2 * attackProgress);
    const releaseProgress = Math.min(1, (durationFrames - offset) / releaseFrames);
    const release = releaseProgress * releaseProgress * (3 - 2 * releaseProgress);
    const envelope = attack * release * Math.exp(-time * 96);
    const frame = (startFrame + offset) % samples.length;
    samples[frame] += Math.sin(phase) * envelope * options.gain;
  }
}

function addTypingTap(
  samples: Float32Array,
  sampleRate: number,
  tap: TypingTap,
  tapIndex: number,
): void {
  const startVariation = (Math.imul(tapIndex + 1, 0x9e3779b1) >>> 0) / 0x100000000;
  const glideVariation = (Math.imul(tapIndex + 1, 0x45d9f3b) >>> 0) / 0x100000000;
  const startFrequencyHz = 820 + startVariation * 280;
  const endFrequencyHz = startFrequencyHz * (0.52 + glideVariation * 0.08);

  DROPLET_CASCADE.forEach((step) => {
    addMicroDroplet(samples, sampleRate, {
      startSeconds: tap.timeSeconds + step.delaySeconds,
      durationSeconds: 0.03,
      gain: tap.gain * step.gainScale,
      startFrequencyHz,
      endFrequencyHz,
    });
  });
}

function renderDropletTyping(samples: Float32Array, sampleRate: number): void {
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
    samples[index] -= mean;
    peak = Math.max(peak, Math.abs(samples[index]));
  }

  const scale = peak > 0 ? targetPeak / peak : 1;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
  return samples;
}

/**
 * Renders one seamless thinking loop as dense, irregular clusters of short,
 * rounded micro-droplets. Four progressively quieter delayed copies make each
 * cascade distinct without reverb, a fixed pitch, or a continuous bed.
 */
export function renderVoiceThinkingTexture({
  sampleRate,
  frameCount,
  targetPeak,
}: VoiceThinkingTextureOptions): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return new Float32Array(0);
  if (!Number.isFinite(frameCount) || frameCount <= 0) return new Float32Array(0);

  const samples = new Float32Array(Math.floor(frameCount));
  renderDropletTyping(samples, sampleRate);
  return normalizeTexture(samples, Math.max(0, Math.min(1, targetPeak)));
}
