import { Audio } from 'expo-av';
import Logger from './logger';

const LOG_TAG = 'ThinkingAudio';
const SAMPLE_RATE = 22050;
const DURATION_SECONDS = 1.2;
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
    const breath = 0.62 + 0.38 * Math.sin(TWO_PI * 0.83 * t);
    const shimmer = Math.sin(TWO_PI * 392 * t) * 0.55 + Math.sin(TWO_PI * 587.33 * t) * 0.32;
    const sample = shimmer * breath * loopWindow * 0.22;
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
    { isLooping: true, shouldPlay: false, volume: 0.34 },
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
    await activeSound.setStatusAsync({ isLooping: true, volume: 0.34, positionMillis: 0 });
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
