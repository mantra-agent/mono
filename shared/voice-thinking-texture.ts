const TAU = Math.PI * 2;

export const VOICE_THINKING_LOOP_SECONDS = 8.4;

export interface VoiceThinkingTextureOptions {
  sampleRate: number;
  frameCount: number;
  targetPeak: number;
}

type RhythmLayer = {
  intervalSeconds: number;
  offsetSeconds: number;
  gain: number;
  frequencyScale: number;
  pattern: readonly number[];
};

const GLASS_FREQUENCIES = [560, 720, 930, 1210] as const;
const RHYTHM_LAYERS: readonly RhythmLayer[] = [
  {
    intervalSeconds: 0.7,
    offsetSeconds: 0,
    gain: 0.34,
    frequencyScale: 1,
    pattern: [0, 1, 2, 1, 3, 2, 0, 2, 1, 3, 2, 1],
  },
  {
    intervalSeconds: 0.84,
    offsetSeconds: 0.28,
    gain: 0.23,
    frequencyScale: 1.08,
    pattern: [2, 0, 1, 3, 1, 2, 0, 3, 2, 1],
  },
] as const;

function createPeriodicNoise(frameCount: number): Float32Array {
  const noise = new Float32Array(frameCount);
  let state = 0x4d414e54;
  for (let index = 0; index < frameCount; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    noise[index] = state / 0xffffffff * 2 - 1;
  }
  return noise;
}

function circularMovingAverage(source: Float32Array, windowSize: number): Float32Array {
  const length = source.length;
  const size = Math.max(1, Math.min(length, Math.round(windowSize)));
  const output = new Float32Array(length);
  let sum = 0;

  for (let index = length - size; index < length; index += 1) {
    sum += source[index];
  }
  for (let index = 0; index < length; index += 1) {
    sum += source[index] - source[(index - size + length) % length];
    output[index] = sum / size;
  }
  return output;
}

function renderCircularAir(samples: Float32Array, sampleRate: number): void {
  const noise = createPeriodicNoise(samples.length);
  const fast = circularMovingAverage(noise, sampleRate / 2100);
  const slow = circularMovingAverage(noise, sampleRate / 310);

  for (let index = 0; index < samples.length; index += 1) {
    const loopPhase = index / samples.length;
    const breath = 0.72
      + Math.sin(TAU * (loopPhase * 5 + 0.11)) * 0.16
      + Math.sin(TAU * (loopPhase * 6 + 0.43)) * 0.1;
    samples[index] = (fast[index] - slow[index]) * breath * 0.24;
  }
}

function addGlassEvent(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  frequency: number,
  gain: number,
  phase: number,
): void {
  const durationFrames = Math.round(sampleRate * 0.56);
  const startFrame = Math.round(startSeconds * sampleRate) % samples.length;

  for (let offset = 0; offset < durationFrames; offset += 1) {
    const time = offset / sampleRate;
    const attack = Math.min(1, time / 0.012);
    const release = Math.min(1, (durationFrames - offset) / (sampleRate * 0.04));
    const envelope = attack * release * Math.exp(-time * 7.2);
    const glass = Math.sin(TAU * frequency * time + phase)
      + Math.sin(TAU * frequency * 1.4142 * time + phase * 1.7) * 0.43
      + Math.sin(TAU * frequency * 2.08 * time + phase * 0.61) * 0.2;
    const frame = (startFrame + offset) % samples.length;
    samples[frame] += glass * envelope * gain;
  }
}

function renderGlassLattices(samples: Float32Array, sampleRate: number): void {
  const loopSeconds = samples.length / sampleRate;
  RHYTHM_LAYERS.forEach((layer, layerIndex) => {
    for (let eventIndex = 0; ; eventIndex += 1) {
      const startSeconds = layer.offsetSeconds + eventIndex * layer.intervalSeconds;
      if (startSeconds >= loopSeconds) break;
      const pitchIndex = layer.pattern[eventIndex % layer.pattern.length];
      const accent = 0.82 + ((eventIndex * 3 + layerIndex) % 5) * 0.045;
      addGlassEvent(
        samples,
        sampleRate,
        startSeconds,
        GLASS_FREQUENCIES[pitchIndex] * layer.frequencyScale,
        layer.gain * accent,
        (eventIndex + layerIndex * 0.37) * 0.71,
      );
    }
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
 * Renders one seamless thinking loop: a quiet circular air bed beneath two
 * interlocking 5:6 glass lattices. The stepped resonances imply motion without
 * resolving into a tune, and deterministic rendering keeps web/native parity.
 */
export function renderVoiceThinkingTexture({
  sampleRate,
  frameCount,
  targetPeak,
}: VoiceThinkingTextureOptions): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return new Float32Array(0);
  if (!Number.isFinite(frameCount) || frameCount <= 0) return new Float32Array(0);

  const samples = new Float32Array(Math.floor(frameCount));
  renderCircularAir(samples, sampleRate);
  renderGlassLattices(samples, sampleRate);
  return normalizeTexture(samples, Math.max(0, Math.min(1, targetPeak)));
}
