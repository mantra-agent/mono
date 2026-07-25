import { Audio } from 'expo-av';
import Logger from './logger';

const LOG_TAG = 'ThinkingAudio';
const SAMPLE_RATE = 22050;
const LOOP_SECONDS = 1.9;
const TONE_HZ = 240;
const OUTPUT_PEAK = 0.62;
// Ray's listening calibration: the cue should sit at roughly one quarter of the
// perceived voice level, not compete with the response that follows it.
const PLAYBACK_VOLUME = 0.07;
const TWO_PI = Math.PI * 2;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type PulseTrain = {
  start: number;
  interval: number;
  count: number;
  gain: number;
  decay: number;
};

// Three interlocking delay trains use one pitch throughout. Their uneven clocks
// create a quiet polyrhythm while each train recedes rather than resolving into
// a melody. The final gap lets the loop breathe before it starts again.
const PULSE_TRAINS: PulseTrain[] = [
  { start: 0, interval: 0.115, count: 5, gain: 1, decay: 0.63 },
  { start: 0.34, interval: 0.173, count: 4, gain: 0.52, decay: 0.68 },
  { start: 1.02, interval: 0.127, count: 4, gain: 0.38, decay: 0.64 },
];

let sound: Audio.Sound | null = null;
let loadingPromise: Promise<Audio.Sound> | null = null;
let playbackRequestVersion = 0;

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

type Pulse = { start: number; gain: number };

function buildPulseSchedule(): Pulse[] {
  return PULSE_TRAINS.flatMap((train) =>
    Array.from({ length: train.count }, (_, index) => ({
      start: train.start + index * train.interval,
      gain: train.gain * train.decay ** index,
    })),
  );
}

/** Smooth same-tone pulses with no noise layer, pitch movement, or bit-crushed transient. */
function renderPulseBed(frameCount: number): Float32Array {
  const bed = new Float32Array(frameCount);
  const pulses = buildPulseSchedule();

  for (let index = 0; index < frameCount; index += 1) {
    const time = index / SAMPLE_RATE;
    let sample = 0;

    for (const pulse of pulses) {
      const local = time - pulse.start;
      if (local < 0 || local > 0.3) continue;

      const attack = Math.min(1, local / 0.012);
      const release = Math.min(1, (0.3 - local) / 0.06);
      const decay = Math.exp(-local / 0.082);
      const envelope = attack * Math.max(0, release) * decay;
      const fundamental = Math.sin(TWO_PI * TONE_HZ * local);
      const softOvertone = Math.sin(TWO_PI * TONE_HZ * 2 * local) * 0.045;
      sample += (fundamental + softOvertone) * envelope * pulse.gain;
    }

    bed[index] = sample;
  }

  return bed;
}

function buildThinkingLoopDataUri(): string {
  const frameCount = Math.floor(SAMPLE_RATE * LOOP_SECONDS);
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

  const samples = renderPulseBed(frameCount);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const normalize = peak > 0 ? OUTPUT_PEAK / peak : 1;

  for (let index = 0; index < frameCount; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] * normalize));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }

  return `data:audio/wav;base64,${encodeBase64(new Uint8Array(buffer))}`;
}

async function getSound(): Promise<Audio.Sound> {
  if (sound) return sound;
  if (loadingPromise) return loadingPromise;

  loadingPromise = Audio.Sound.createAsync(
    { uri: buildThinkingLoopDataUri() },
    { isLooping: true, shouldPlay: false, volume: PLAYBACK_VOLUME },
  ).then(({ sound: created }) => {
    sound = created;
    return created;
  }).finally(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

export async function startThinkingAudioLoop(): Promise<void> {
  const requestVersion = ++playbackRequestVersion;
  try {
    const activeSound = await getSound();
    if (requestVersion !== playbackRequestVersion) return;
    await activeSound.setStatusAsync({
      isLooping: true,
      volume: PLAYBACK_VOLUME,
      positionMillis: 0,
    });
    if (requestVersion !== playbackRequestVersion) return;
    await activeSound.playAsync();
    if (requestVersion !== playbackRequestVersion) {
      await activeSound.stopAsync();
    }
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to start thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function stopThinkingAudioLoop(): Promise<void> {
  playbackRequestVersion += 1;
  try {
    const activeSound = sound;
    if (!activeSound) return;
    await activeSound.stopAsync();
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to stop thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function unloadThinkingAudioLoop(): Promise<void> {
  playbackRequestVersion += 1;
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
