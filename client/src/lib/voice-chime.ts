import {
  renderVoiceThinkingTexture,
  VOICE_THINKING_LOOP_SECONDS,
} from "@shared/voice-thinking-texture";

type ChimeNote = { freq: number; offset: number; duration: number; gain: number };

const THINKING_MASTER_GAIN = 0.336;
const THINKING_TEXTURE_PEAK = 0.14;
const THINKING_MEDIA_SAMPLE_RATE = 48_000;

let sharedVoiceAudioContext: AudioContext | null = null;
let thinkingAudioElement: HTMLAudioElement | null = null;
let thinkingAudioUrl: string | null = null;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  const candidate = window.AudioContext
    || (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate || null;
}

function getVoiceAudioContext(): AudioContext | null {
  try {
    if (sharedVoiceAudioContext && sharedVoiceAudioContext.state !== "closed") {
      return sharedVoiceAudioContext;
    }
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) return null;
    sharedVoiceAudioContext = new AudioContextCtor({ latencyHint: "interactive" });
    return sharedVoiceAudioContext;
  } catch {
    return null;
  }
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function buildThinkingMediaUrl(): string {
  if (thinkingAudioUrl) return thinkingAudioUrl;

  const frameCount = Math.max(1, Math.floor(THINKING_MEDIA_SAMPLE_RATE * VOICE_THINKING_LOOP_SECONDS));
  const samples = renderVoiceThinkingTexture({
    sampleRate: THINKING_MEDIA_SAMPLE_RATE,
    frameCount,
    targetPeak: THINKING_TEXTURE_PEAK,
  });
  const bytesPerSample = 2;
  const dataBytes = frameCount * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, THINKING_MEDIA_SAMPLE_RATE, true);
  view.setUint32(28, THINKING_MEDIA_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < frameCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(44 + index * bytesPerSample, Math.round(sample * 0x7fff), true);
  }

  thinkingAudioUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  return thinkingAudioUrl;
}

function getThinkingAudioElement(): HTMLAudioElement | null {
  try {
    if (thinkingAudioElement) return thinkingAudioElement;
    const element = new Audio(buildThinkingMediaUrl());
    element.loop = true;
    element.preload = "auto";
    element.volume = THINKING_MASTER_GAIN;
    thinkingAudioElement = element;
    return element;
  } catch {
    return null;
  }
}

export function unlockVoiceAudioContext(): void {
  const ctx = getVoiceAudioContext();
  if (ctx) {
    try {
      void ctx.resume();
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.035), ctx.sampleRate);
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(ctx.currentTime);
      source.stop(ctx.currentTime + 0.035);
    } catch {
      // Browsers may deny WebAudio unlock while preserving media playback.
    }
  }

  // The thinking bed uses one persistent media element. Unlocking that exact
  // element in the initiating gesture lets iOS keep it in the media playback
  // path when WebAudio is suspended after the screen locks.
  const thinkingAudio = getThinkingAudioElement();
  if (!thinkingAudio) return;
  try {
    const previousVolume = thinkingAudio.volume;
    thinkingAudio.volume = 0;
    const unlock = thinkingAudio.play();
    if (unlock) {
      void unlock.then(() => {
        thinkingAudio.pause();
        thinkingAudio.currentTime = 0;
        thinkingAudio.volume = previousVolume;
      }).catch(() => {
        thinkingAudio.volume = previousVolume;
      });
    }
  } catch {
    // Visual feedback remains available when autoplay policy denies unlock.
  }
}

function playVoiceChime(notes: ChimeNote[]): void {
  try {
    const ctx = getVoiceAudioContext();
    if (!ctx) return;
    void ctx.resume();

    const play = ({ freq, offset, duration, gain }: ChimeNote) => {
      const startAt = ctx.currentTime + offset;
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startAt);
      gainNode.gain.setValueAtTime(0, startAt);
      gainNode.gain.linearRampToValueAtTime(gain, startAt + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration);
    };

    notes.forEach(play);
  } catch {
    // AudioContext not available (server-side or blocked) — silently skip.
  }
}

/** Plays the canonical two-tone voice connection chime. */
export function playConnectionChime(): void {
  playVoiceChime([
    { freq: 880, offset: 0, duration: 0.25, gain: 0.18 },
    { freq: 1174.66, offset: 0.12, duration: 0.3, gain: 0.14 },
  ]);
}

/** Plays the canonical two-tone voice disconnection chime. */
export function playDisconnectionChime(): void {
  playVoiceChime([
    { freq: 1174.66, offset: 0, duration: 0.22, gain: 0.14 },
    { freq: 880, offset: 0.11, duration: 0.28, gain: 0.16 },
  ]);
}

/**
 * Starts the restrained soft-digital-typing texture through a persistent media
 * element. Unlike WebAudio, this playback path remains eligible for iOS
 * background and lock-screen audio alongside the conversation stream.
 */
export function startVoiceThinkingLoop(): void {
  const thinkingAudio = getThinkingAudioElement();
  if (!thinkingAudio || !thinkingAudio.paused) return;

  try {
    thinkingAudio.volume = THINKING_MASTER_GAIN;
    void thinkingAudio.play();
  } catch {
    // Audio may remain policy-blocked; visual feedback still works.
  }
}

export function stopVoiceThinkingLoop(_options?: { immediate?: boolean }): void {
  const thinkingAudio = thinkingAudioElement;
  if (!thinkingAudio || thinkingAudio.paused) return;

  // Timers and animation frames are throttled while iOS is locked. Pause at
  // the state boundary so the thinking bed cannot bleed into speech in pocket
  // mode; the next onset restores the canonical volume.
  thinkingAudio.pause();
  thinkingAudio.currentTime = 0;
  thinkingAudio.volume = THINKING_MASTER_GAIN;
}
