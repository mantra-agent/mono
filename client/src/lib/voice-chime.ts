type ChimeNote = { freq: number; offset: number; duration: number; gain: number };

type ThinkingLoop = {
  ctx: AudioContext;
  master: GainNode;
  modulator: OscillatorNode;
  modulatorGain: GainNode;
  carrierA: OscillatorNode;
  carrierB: OscillatorNode;
  carrierAGain: GainNode;
  carrierBGain: GainNode;
  filter: BiquadFilterNode;
};

let thinkingLoop: ThinkingLoop | null = null;

function closeThinkingLoop(loop: ThinkingLoop, delayMs = 180): void {
  const stopAt = loop.ctx.currentTime + delayMs / 1000;
  try {
    loop.master.gain.cancelScheduledValues(loop.ctx.currentTime);
    loop.master.gain.setValueAtTime(loop.master.gain.value, loop.ctx.currentTime);
    loop.master.gain.linearRampToValueAtTime(0, stopAt);
    loop.carrierA.stop(stopAt + 0.04);
    loop.carrierB.stop(stopAt + 0.04);
    loop.modulator.stop(stopAt + 0.04);
    setTimeout(() => loop.ctx.close(), delayMs + 120);
  } catch {
    loop.ctx.close().catch(() => {});
  }
}

function playVoiceChime(notes: ChimeNote[]): void {
  try {
    const ctx = new AudioContext();

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
    setTimeout(() => ctx.close(), 700);
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

/**
 * Starts the canonical thinking bed for voice turns. The sound is intentionally
 * quiet, tonal, and loop-safe: a soft two-oscillator shimmer through a low-pass
 * filter, amplitude-modulated slowly enough to read as work without becoming an
 * alert. It stops via `stopVoiceThinkingLoop()` as soon as speech begins.
 */
export function startVoiceThinkingLoop(): void {
  if (thinkingLoop) return;
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const modulator = ctx.createOscillator();
    const modulatorGain = ctx.createGain();
    const carrierA = ctx.createOscillator();
    const carrierB = ctx.createOscillator();
    const carrierAGain = ctx.createGain();
    const carrierBGain = ctx.createGain();

    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.026, ctx.currentTime + 0.16);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1350, ctx.currentTime);
    filter.Q.setValueAtTime(0.7, ctx.currentTime);

    modulator.type = "sine";
    modulator.frequency.setValueAtTime(0.42, ctx.currentTime);
    modulatorGain.gain.setValueAtTime(0.008, ctx.currentTime);

    carrierA.type = "sine";
    carrierA.frequency.setValueAtTime(392, ctx.currentTime);
    carrierAGain.gain.setValueAtTime(0.018, ctx.currentTime);

    carrierB.type = "sine";
    carrierB.frequency.setValueAtTime(587.33, ctx.currentTime);
    carrierBGain.gain.setValueAtTime(0.011, ctx.currentTime);

    modulator.connect(modulatorGain);
    modulatorGain.connect(carrierAGain.gain);
    modulatorGain.connect(carrierBGain.gain);
    carrierA.connect(carrierAGain);
    carrierB.connect(carrierBGain);
    carrierAGain.connect(filter);
    carrierBGain.connect(filter);
    filter.connect(master);
    master.connect(ctx.destination);

    carrierA.start();
    carrierB.start();
    modulator.start();

    thinkingLoop = { ctx, master, modulator, modulatorGain, carrierA, carrierB, carrierAGain, carrierBGain, filter };
  } catch {
    // AudioContext may be blocked or unavailable. Visual feedback still works.
  }
}

export function stopVoiceThinkingLoop(): void {
  const loop = thinkingLoop;
  thinkingLoop = null;
  if (!loop) return;
  closeThinkingLoop(loop);
}
