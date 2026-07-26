type ChimeNote = { freq: number; offset: number; duration: number; gain: number };

type ThinkingLoop = {
  ctx: AudioContext;
  master: GainNode;
  source: AudioBufferSourceNode;
  stopped: boolean;
};

const THINKING_MASTER_GAIN = 0.42;
const THINKING_TEXTURE_GAIN = 0.14;
const THINKING_BUFFER_SECONDS = 4;

let sharedVoiceAudioContext: AudioContext | null = null;
let thinkingLoop: ThinkingLoop | null = null;

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

export function unlockVoiceAudioContext(): void {
  const ctx = getVoiceAudioContext();
  if (!ctx) return;
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
    // Non-critical: browsers that deny unlock still keep visual feedback intact.
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

function buildThinkingNoise(ctx: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * THINKING_BUFFER_SECONDS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let smoothed = 0;

  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    smoothed = (smoothed + white * 0.02) / 1.02;
    data[index] = Math.max(-1, Math.min(1, smoothed * 3.5)) * THINKING_TEXTURE_GAIN;
  }

  return buffer;
}

function closeThinkingLoop(loop: ThinkingLoop, immediate: boolean): void {
  if (loop.stopped) return;
  loop.stopped = true;
  const now = loop.ctx.currentTime;

  try {
    loop.master.gain.cancelScheduledValues(now);
    if (immediate) {
      loop.master.gain.setValueAtTime(0, now);
      loop.source.stop(now);
      return;
    }

    loop.master.gain.setValueAtTime(loop.master.gain.value, now);
    loop.master.gain.linearRampToValueAtTime(0, now + 0.12);
    loop.source.stop(now + 0.13);
  } catch {
    // The shared voice AudioContext stays alive for future feedback sounds.
  }
}

/**
 * Starts a neutral, non-melodic thinking texture. The caller owns onset and
 * speech gating; this producer owns one loop source and deterministic teardown.
 */
export function startVoiceThinkingLoop(): void {
  if (thinkingLoop) return;

  try {
    const ctx = getVoiceAudioContext();
    if (!ctx) return;
    void ctx.resume();

    const source = ctx.createBufferSource();
    source.buffer = buildThinkingNoise(ctx);
    source.loop = true;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.setValueAtTime(180, ctx.currentTime);
    highpass.Q.setValueAtTime(0.5, ctx.currentTime);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(1100, ctx.currentTime);
    lowpass.Q.setValueAtTime(0.55, ctx.currentTime);

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(THINKING_MASTER_GAIN, ctx.currentTime + 0.18);

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(master);
    master.connect(ctx.destination);

    const loop: ThinkingLoop = { ctx, master, source, stopped: false };
    thinkingLoop = loop;
    source.start(ctx.currentTime);
  } catch {
    // AudioContext may be blocked or unavailable. Visual feedback still works.
  }
}

export function stopVoiceThinkingLoop(options?: { immediate?: boolean }): void {
  const loop = thinkingLoop;
  thinkingLoop = null;
  if (!loop) return;
  closeThinkingLoop(loop, options?.immediate === true);
}
