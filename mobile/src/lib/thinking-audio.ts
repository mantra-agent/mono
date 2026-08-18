import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import {
  renderVoiceThinkingTexture,
  VOICE_THINKING_LOOP_SECONDS,
} from '@shared/voice-thinking-texture';
import Logger from './logger';

const LOG_TAG = 'ThinkingAudio';
const SAMPLE_RATE = 22050;
const OUTPUT_PEAK = 0.32;
const PLAYBACK_VOLUME = 0.044;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let player: AudioPlayer | null = null;
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

function buildThinkingLoopDataUri(): string {
  const frameCount = Math.floor(SAMPLE_RATE * VOICE_THINKING_LOOP_SECONDS);
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

  const samples = renderVoiceThinkingTexture({
    sampleRate: SAMPLE_RATE,
    frameCount,
    targetPeak: OUTPUT_PEAK,
  });
  for (let index = 0; index < frameCount; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }

  return `data:audio/wav;base64,${encodeBase64(new Uint8Array(buffer))}`;
}

function getPlayer(): AudioPlayer {
  if (player) return player;
  // Imperative player only — do not take AVAudioSession from LiveKit/WebRTC.
  const created = createAudioPlayer({ uri: buildThinkingLoopDataUri() });
  created.loop = true;
  created.volume = PLAYBACK_VOLUME;
  player = created;
  return created;
}

export async function startThinkingAudioLoop(): Promise<void> {
  const requestVersion = ++playbackRequestVersion;
  try {
    const activePlayer = getPlayer();
    if (requestVersion !== playbackRequestVersion) return;
    activePlayer.loop = true;
    activePlayer.volume = PLAYBACK_VOLUME;
    await activePlayer.seekTo(0);
    if (requestVersion !== playbackRequestVersion) return;
    activePlayer.play();
    if (requestVersion !== playbackRequestVersion) {
      activePlayer.pause();
    }
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to start thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function stopThinkingAudioLoop(): Promise<void> {
  playbackRequestVersion += 1;
  try {
    const activePlayer = player;
    if (!activePlayer) return;
    activePlayer.volume = 0;
    activePlayer.pause();
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to stop thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function unloadThinkingAudioLoop(): Promise<void> {
  playbackRequestVersion += 1;
  try {
    const activePlayer = player;
    player = null;
    if (!activePlayer) return;
    activePlayer.pause();
    activePlayer.release();
  } catch (error) {
    Logger.warn(LOG_TAG, 'Failed to unload thinking audio', { error: error instanceof Error ? error.message : String(error) });
  }
}
