import { Audio } from 'expo-av';
import Logger from './logger';

const LOG_TAG = 'ThinkingAudio';
const SAMPLE_RATE = 22050;
// Percussive "chk-a-chk-chk" bed mirroring the web synth character: short noise
// transients with a faint tonal tint, washed in a light algorithmic reverb. Two
// groups per loop so a long think doesn't read as one short bar repeating.
const GROUP_OFFSETS = [0, 0.085, 0.235, 0.345];
const HIT_GAINS = [0.9, 0.45, 0.85, 0.7];
const GROUP_SECONDS = 0.95;
const GROUP_COUNT = 2;
const TONE_HZ = [349.23, 392, 415.3, 392];
// The quiet grace hit ("a") sits a fifth up for a hint of movement.
const HIT_TONE_FIFTH = 1.5;
const DURATION_SECONDS = GROUP_SECONDS * GROUP_COUNT;
const TWO_PI = Math.PI * 2;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let sound: Audio.Sound | null = null;
let loadingPromise: Promise<Audio.Sound> | null = null;

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triplet >> 18) & 63];
    output += BASE64_ALPHABET[(triplet >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] : '=';
  }
  return output;
}

type Hit = { start: number; gain: number; toneHz: number };

function buildHitSchedule(): Hit[] {
  const hits: Hit[] = [];
  for (let group = 0; group < GROUP_COUNT; group += 1) {
    const groupStart = group * GROUP_SECONDS;
    const toneBase = TONE_HZ[group % TONE_HZ.length];
    GROUP_OFFSETS.forEach((offset, index) => {
      hits.push({
        start: groupStart + offset,
        gain: HIT_GAINS[index],
        toneHz: index === 1 ? toneBase * HIT_TONE_FIFTH : toneBase,
      });
    });
  }
  return hits;
}

/** Dry percussive bed: colored-noise transients plus faint tonal ticks, no reverb. */
function renderDryBed(frameCount: number): Float32Array {
  const dry = new Float32Array(frameCount);
  const hits = buildHitSchedule();
  let noiseLp = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const t = index / SAMPLE_RATE;
    // One-pole lowpass over white noise dulls the hiss toward a "chk".
    const white = Math.random() * 2 - 1;
    noiseLp += 0.35 * (white - noiseLp);
    const colored = noiseLp * 1.6;
    let sample = 0;
    for (const hit of hits) {
      const local = t - hit.start;
      if (local < 0 || local > 0.16) continue;
      const attack = Math.min(1, local / 0.004);
      const decay = Math.exp(-local / 0.045);
      const env = attack * decay;
      const tone = Math.sin(TWO_PI * hit.toneHz * t);
      sample += (colored * 0.5 + tone * 0.16) * env * hit.gain;
    }
    dry[index] = sample;
  }
  return dry;
}

// Compact Schroeder reverb (4 parallel combs → 2 series allpass) gives the bed
// its atmospheric tail without a bundled asset or a costly convolution.
function combFilter(input: Float32Array, size: number, feedback: number, damp: number): Float32Array {
  const out = new Float32Array(input.length);
  const buffer = new Float32Array(size);
  let index = 0;
  let store = 0;
  for (let i = 0; i < input.length; i += 1) {
    const output = buffer[index];
    store = output * (1 - damp) + store * damp;
    buffer[index] = input[i] + store * feedback;
    out[i] = output;
    index += 1;
    if (index >= size) index = 0;
  }
  return out;
}

function allpassFilter(input: Float32Array, size: number, feedback: number): Float32Array {
  const out = new Float32Array(input.length);
  const buffer = new Float32Array(size);
  let index = 0;
  for (let i = 0; i < input.length; i += 1) {
    const buffered = buffer[index];
    out[i] = -input[i] + buffered;
    buffer[index] = input[i] + buffered * feedback;
    index += 1;
    if (index >= size) index = 0;
  }
  return out;
}

function applyReverb(input: Float32Array): Float32Array {
  const combTunings = [558, 594, 638, 678];
  const wet = new Float32Array(input.length);
  for (const size of combTunings) {
    const combed = combFilter(input, size, 0.78, 0.25);
    for (let i = 0; i < wet.length; i += 1) wet[i] += combed[i] * 0.25;
  }
  let out = wet;
  for (const size of [112, 278]) out = allpassFilter(out, size, 0.5);
  return out;
}

function buildThinkingLoopDataUri(): string {
  const frameCount = Math.floor(SAMPLE_RATE * DURATION_SECONDS);
  const dataSize = frameCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const dry = renderDryBed(frameCount);

  // Run the reverb over the dry bed plus a tail, then wrap the decaying tail back
  // into the head so the loop is seamless.
  const tailFrames = Math.floor(SAMPLE_RATE * 1.2);
  const extended = new Float32Array(frameCount + tailFrames);
  extended.set(dry, 0);
  const wetExtended = applyReverb(extended);
  const wet = new Float32Array(frameCount);
  for (let i = 0; i < wetExtended.length; i += 1) {
    wet[i % frameCount] += wetExtended[i];
  }

  // Mix dry + wet, then normalize to safe headroom so transients never clip.
  const mixed = new Float32Array(frameCount);
  let peak = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const value = dry[i] * 0.9 + wet[i] * 0.5;
    mixed[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const normalize = peak > 0 ? 0.82 / peak : 1;
  for (let i = 0; i < frameCount; i += 1) {
    const clamped = Math.max(-1, Math.min(1, mixed[i] * normalize));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  return `data:audio/wav;base64,${encodeBase64(new Uint8Array(buffer))}`;
}

async function getSound(): Promise<Audio.Sound> {
  if (sound) return sound;
  if (loadingPromise) return loadingPromise;

  loadingPromise = Audio.Sound.createAsync(
    { uri: buildThinkingLoopDataUri() },
    { isLooping: true, shouldPlay: false, volume: 0.28 },
  ).then(({ sound: created }) => {
    sound = created;
    return created;
  }).finally(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

export async function startThinkingAudioLoop(): Promise<void> {
  try {
    const activeSound = await getSound();
    await activeSound.setStatusAsync({ isLooping: true, volume: 0.28, positionMillis: 0 });
    await activeSound.playAsync();
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to start thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function stopThinkingAudioLoop(): Promise<void> {
  try {
    const activeSound = sound;
    if (!activeSound) return;
    await activeSound.stopAsync();
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to stop thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function unloadThinkingAudioLoop(): Promise<void> {
  try {
    const activeSound = sound;
    sound = null;
    loadingPromise = null;
    if (!activeSound) return;
    await activeSound.unloadAsync();
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to unload thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}
