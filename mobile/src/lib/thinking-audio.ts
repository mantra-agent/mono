import { Audio } from 'expo-av';
import Logger from './logger';

const LOG_TAG = 'ThinkingAudio';
const SAMPLE_RATE = 22050;
const STEP_SECONDS = 0.28;
const ARPEGGIO = [392, 493.88, 587.33, 659.25, 587.33, 493.88];
// Layer a deeper macro-cycle on top of the base phrase: bake several transposed
// passes into one loop buffer (mirrors the web thinking-loop's per-repeat
// transposition) so a long thinking span doesn't sound like the same ~1.7s
// loop repeating over and over — the full buffer takes ~7s to come back around.
const PHRASE_SEMITONES = [0, -2, 2, -1];
const MACRO_ARPEGGIO = PHRASE_SEMITONES.flatMap((semitones) => {
  const transpose = Math.pow(2, semitones / 12);
  return ARPEGGIO.map((freq) => freq * transpose);
});
const DURATION_SECONDS = STEP_SECONDS * MACRO_ARPEGGIO.length;
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

  for (let index = 0; index < frameCount; index += 1) {
    const t = index / SAMPLE_RATE;
    const phase = t / DURATION_SECONDS;
    const loopWindow = 0.5 - 0.5 * Math.cos(TWO_PI * phase);
    const stepIndex = Math.min(MACRO_ARPEGGIO.length - 1, Math.floor(t / STEP_SECONDS));
    const localT = t - stepIndex * STEP_SECONDS;
    const freq = MACRO_ARPEGGIO[stepIndex];
    const attack = Math.min(1, localT / 0.055);
    const release = Math.max(0, 1 - Math.max(0, localT - 0.16) / 0.18);
    const envelope = Math.sin(attack * Math.PI * 0.5) * release;
    const tone = Math.sin(TWO_PI * freq * t) * 0.72 + Math.sin(TWO_PI * freq * 2 * t) * 0.08;
    const sample = tone * envelope * loopWindow * 0.16;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
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
