type ChimeNote = { freq: number; offset: number; duration: number; gain: number };

type ThinkingLoop = {
  ctx: AudioContext;
  master: GainNode;
  reverb: ConvolverNode;
  noiseBuffer: AudioBuffer;
  timers: number[];
  sources: AudioScheduledSourceNode[];
  stopped: boolean;
  cycleIndex: number;
};

// The thinking bed is percussive, not melodic: a reverb-washed "chk-a-chk-chk"
// group of short noise transients with only a faint tonal tint. Each group is a
// firm hit, a quick quiet grace hit ("a"), then two firm hits, followed by space
// before the group repeats.
const THINKING_GROUP_OFFSETS = [0, 0.085, 0.235, 0.345];
const THINKING_HIT_GAINS = [0.9, 0.45, 0.85, 0.7];
const THINKING_GROUP_SECONDS = 0.95;
// Faint tonal color cycled across groups. Narrow intervals at low level so a long
// think reads as texture with a hint of movement, never a tune.
const THINKING_TONE_HZ = [349.23, 392, 415.3, 392];

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

function closeThinkingLoop(loop: ThinkingLoop, delayMs = 180): void {
  loop.stopped = true;
  loop.timers.forEach(window.clearTimeout);
  loop.timers.length = 0;

  const stopAt = loop.ctx.currentTime + delayMs / 1000;
  try {
    loop.master.gain.cancelScheduledValues(loop.ctx.currentTime);
    loop.master.gain.setValueAtTime(loop.master.gain.value, loop.ctx.currentTime);
    loop.master.gain.linearRampToValueAtTime(0, stopAt);
    for (const source of loop.sources) {
      try {
        source.stop(stopAt + 0.04);
      } catch {
        // Source may already have ended naturally.
      }
    }
  } catch {
    // The shared voice AudioContext stays alive for future feedback sounds.
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
    // AudioContext not available (server-side or blocked) — silently skip
  }
}

/**
 * Plays the canonical two-tone voice connection chime.
 * Used by web and iOS WebView voice so both surfaces sound identical.
 */
export function playConnectionChime(): void {
  playVoiceChime([
    { freq: 880, offset: 0, duration: 0.25, gain: 0.18 },
    { freq: 1174.66, offset: 0.12, duration: 0.3, gain: 0.14 },
  ]);
}

/**
 * Plays the canonical two-tone voice disconnection chime.
 * Same implementation path as connect so web and iOS remain identical.
 */
export function playDisconnectionChime(): void {
  playVoiceChime([
    { freq: 1174.66, offset: 0, duration: 0.22, gain: 0.14 },
    { freq: 880, offset: 0.11, duration: 0.28, gain: 0.16 },
  ]);
}

// A decaying-noise impulse response gives the bed its atmospheric reverb tail
// without a bundled asset. Generated once per loop start.
function buildReverbImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const decay = Math.pow(1 - i / length, 2.6);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return impulse;
}

// A short white-noise buffer reused for every percussive transient.
function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.12));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// One "chk": a band-passed noise transient with a fast percussive envelope, plus
// a faint triangle tick for tonal color. Both feed a dry path and a reverb send.
function scheduleThinkingHit(
  loop: ThinkingLoop,
  startAt: number,
  params: { gain: number; toneHz: number; pan: number },
): void {
  const ctx = loop.ctx;
  const { gain, toneHz, pan } = params;

  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(pan, startAt);
  panner.connect(loop.master);
  panner.connect(loop.reverb);

  const noise = ctx.createBufferSource();
  noise.buffer = loop.noiseBuffer;
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.setValueAtTime(1900, startAt);
  bandpass.Q.setValueAtTime(0.8, startAt);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, startAt);
  noiseGain.gain.linearRampToValueAtTime(gain * 0.5, startAt + 0.004);
  noiseGain.gain.exponentialRampToValueAtTime(0.0006, startAt + 0.07);
  noise.connect(bandpass);
  bandpass.connect(noiseGain);
  noiseGain.connect(panner);
  noise.start(startAt);
  noise.stop(startAt + 0.12);
  loop.sources.push(noise);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(toneHz, startAt);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.0001, startAt);
  oscGain.gain.linearRampToValueAtTime(gain * 0.16, startAt + 0.006);
  oscGain.gain.exponentialRampToValueAtTime(0.0005, startAt + 0.12);
  osc.connect(oscGain);
  oscGain.connect(panner);
  osc.start(startAt);
  osc.stop(startAt + 0.14);
  loop.sources.push(osc);
}

function scheduleThinkingGroup(loop: ThinkingLoop, startAt: number): void {
  if (loop.stopped) return;

  const toneBase = THINKING_TONE_HZ[loop.cycleIndex % THINKING_TONE_HZ.length];
  THINKING_GROUP_OFFSETS.forEach((offset, index) => {
    // The quiet grace hit ("a") sits a fifth up for a hint of movement.
    const toneHz = index === 1 ? toneBase * 1.5 : toneBase;
    const pan = index % 2 === 0 ? -0.06 : 0.06;
    scheduleThinkingHit(loop, startAt + offset, {
      gain: THINKING_HIT_GAINS[index],
      toneHz,
      pan,
    });
  });

  loop.cycleIndex += 1;
  const nextTimer = window.setTimeout(() => {
    scheduleThinkingGroup(loop, loop.ctx.currentTime + 0.03);
  }, THINKING_GROUP_SECONDS * 1000);
  loop.timers.push(nextTimer);
}

/**
 * Starts the canonical thinking bed for voice turns. The sound is a quiet,
 * reverb-washed percussive pulse ("chk-a-chk-chk") with only a faint tonal tint
 * — it reads as active processing without becoming a ringtone, a drone, or a dry
 * click track. Onset delay and barge-in are enforced by the caller; this
 * function starts producing sound the moment it is invoked. Stop via
 * `stopVoiceThinkingLoop()`.
 */
export function startVoiceThinkingLoop(): void {
  if (thinkingLoop) return;
  try {
    const ctx = getVoiceAudioContext();
    if (!ctx) return;
    void ctx.resume();

    const master = ctx.createGain();
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.2);
    master.connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = buildReverbImpulse(ctx, 1.5);
    const reverbGain = ctx.createGain();
    reverbGain.gain.setValueAtTime(0.7, ctx.currentTime);
    reverb.connect(reverbGain);
    reverbGain.connect(master);

    const loop: ThinkingLoop = {
      ctx,
      master,
      reverb,
      noiseBuffer: buildNoiseBuffer(ctx),
      timers: [],
      sources: [],
      stopped: false,
      cycleIndex: 0,
    };
    thinkingLoop = loop;
    scheduleThinkingGroup(loop, ctx.currentTime + 0.05);
  } catch {
    // AudioContext may be blocked or unavailable. Visual feedback still works.
  }
}

export function stopVoiceThinkingLoop(options?: { immediate?: boolean }): void {
  const loop = thinkingLoop;
  thinkingLoop = null;
  if (!loop) return;
  // Barge-in requires a hard stop (<=100ms); ordinary stops may fade gently.
  closeThinkingLoop(loop, options?.immediate ? 30 : 160);
}
