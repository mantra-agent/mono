type ChimeNote = { freq: number; offset: number; duration: number; gain: number };

type ThinkingLoop = {
  ctx: AudioContext;
  master: GainNode;
  filter: BiquadFilterNode;
  timers: number[];
  oscillators: OscillatorNode[];
  stopped: boolean;
  cycleIndex: number;
};

const THINKING_ARPEGGIO = [392, 493.88, 587.33, 659.25, 587.33, 493.88];
const THINKING_STEP_SECONDS = 0.28;
const THINKING_PATTERN_SECONDS = THINKING_ARPEGGIO.length * THINKING_STEP_SECONDS;

// A slower macro-cycle layered on top of the base pattern: each repeat transposes
// by one of these semitone offsets before returning to the same tone. Combined
// with the independent filter-drift cycle below, the loop doesn't sound identical
// again for ~47s, so long thinking spans don't read as a stuck ringtone.
const THINKING_PHRASE_SEMITONES = [0, -2, 2, -1];
const THINKING_FILTER_DRIFT_HZ = [1450, 1620, 1300, 1550, 1220, 1700, 1380];

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
    for (const oscillator of loop.oscillators) {
      try {
        oscillator.stop(stopAt + 0.04);
      } catch {
        // Oscillator may already have ended naturally.
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

function scheduleThinkingArpeggio(loop: ThinkingLoop, startAt: number): void {
  if (loop.stopped) return;

  const semitoneShift = THINKING_PHRASE_SEMITONES[loop.cycleIndex % THINKING_PHRASE_SEMITONES.length];
  const transpose = Math.pow(2, semitoneShift / 12);
  const reverseThisCycle = Math.floor(loop.cycleIndex / THINKING_PHRASE_SEMITONES.length) % 2 === 1;
  const notes = reverseThisCycle ? [...THINKING_ARPEGGIO].reverse() : THINKING_ARPEGGIO;

  notes.forEach((baseFreq, index) => {
    const freq = baseFreq * transpose;
    const noteStart = startAt + index * THINKING_STEP_SECONDS;
    const noteDuration = 0.34;
    const oscillator = loop.ctx.createOscillator();
    const gain = loop.ctx.createGain();
    const pan = loop.ctx.createStereoPanner();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(freq, noteStart);
    oscillator.frequency.exponentialRampToValueAtTime(freq * 1.003, noteStart + noteDuration);

    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.linearRampToValueAtTime(0.018, noteStart + 0.055);
    gain.gain.exponentialRampToValueAtTime(0.001, noteStart + noteDuration);

    pan.pan.setValueAtTime((index % 2 === 0 ? -0.08 : 0.08), noteStart);

    oscillator.connect(gain);
    gain.connect(pan);
    pan.connect(loop.filter);

    oscillator.start(noteStart);
    oscillator.stop(noteStart + noteDuration + 0.03);
    loop.oscillators.push(oscillator);
  });

  // Drift the lowpass cutoff on its own, longer-period cycle so timbre and
  // pitch don't reset in lockstep — the two cycles only realign after
  // lcm(phrase, drift) repeats, well past any normal thinking turn.
  const driftHz = THINKING_FILTER_DRIFT_HZ[loop.cycleIndex % THINKING_FILTER_DRIFT_HZ.length];
  loop.filter.frequency.cancelScheduledValues(startAt);
  loop.filter.frequency.setValueAtTime(loop.filter.frequency.value, startAt);
  loop.filter.frequency.linearRampToValueAtTime(driftHz, startAt + THINKING_PATTERN_SECONDS * 0.6);

  loop.cycleIndex += 1;
  const nextTimer = window.setTimeout(() => {
    scheduleThinkingArpeggio(loop, loop.ctx.currentTime + 0.04);
  }, THINKING_PATTERN_SECONDS * 1000);
  loop.timers.push(nextTimer);
}

/**
 * Starts the canonical thinking bed for voice turns. The sound is intentionally
 * quiet and melodic: a soft ascending/descending arpeggio that reads as active
 * work without becoming a ringtone or a drone. It stops via
 * `stopVoiceThinkingLoop()` as soon as speech begins.
 */
export function startVoiceThinkingLoop(): void {
  if (thinkingLoop) return;
  try {
    const ctx = getVoiceAudioContext();
    if (!ctx) return;
    void ctx.resume();
    const master = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.82, ctx.currentTime + 0.16);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1450, ctx.currentTime);
    filter.Q.setValueAtTime(0.45, ctx.currentTime);
    filter.connect(master);
    master.connect(ctx.destination);

    const loop: ThinkingLoop = { ctx, master, filter, timers: [], oscillators: [], stopped: false, cycleIndex: 0 };
    thinkingLoop = loop;
    scheduleThinkingArpeggio(loop, ctx.currentTime + 0.04);
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
