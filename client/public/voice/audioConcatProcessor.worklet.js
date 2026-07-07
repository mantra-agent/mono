/*
 * Vendored + patched copy of @elevenlabs/client@0.14.0's audioConcatProcessor
 * worklet. Two changes vs. the stock version:
 *
 *  1. PREBUFFER (~750 ms): the worklet outputs silence until enough samples
 *     have been queued to ride out Chrome's audio pipeline initialization
 *     and first network jitter spike. Chrome can take several seconds to
 *     stabilize when an AudioContext is created at a non-native sample rate
 *     (e.g. 16kHz vs 48kHz hardware). The prebuffer, combined with the
 *     host's pre-warm of Chrome's audio hardware, prevents the high-pitched
 *     / bit-crushed artifacts that otherwise appear in the first seconds.
 *     Once playback starts, normal behavior resumes.
 *
 *  2. RESAMPLER-READY GATE: the host can post {type:"setReady"} to allow
 *     playback. Until then, queued buffers are held back. The default is
 *     ready=true so unmodified hosts behave identically to the stock worklet.
 *
 * Otherwise the processor is byte-for-byte the original.
 *
 * ulaw decoding logic taken from the wavefile library
 * https://github.com/rochars/wavefile/blob/master/lib/codecs/mulaw.js
 * USED BY @elevenlabs/client
 */

const decodeTable = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

function decodeSample(muLawSample) {
  let sign;
  let exponent;
  let mantissa;
  let sample;
  muLawSample = ~muLawSample;
  sign = muLawSample & 0x80;
  exponent = (muLawSample >> 4) & 0x07;
  mantissa = muLawSample & 0x0F;
  sample = decodeTable[exponent] + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;
  return sample;
}

const PREBUFFER_SECONDS = 0.75;
const DEFAULT_SOURCE_RATE = 16000;
const DEFAULT_ULAW_RATE = 8000;

class AudioConcatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.fracCursor = 0;
    this.currentBuffer = null;
    this.wasInterrupted = false;
    this.finished = false;

    this.ready = true;
    this.started = false;
    this.queuedSourceSamples = 0;
    this.sourceRate = DEFAULT_SOURCE_RATE;
    this.format = "pcm";
    this.prebufferTarget = Math.max(1, Math.floor(this.sourceRate * PREBUFFER_SECONDS));

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case "setFormat":
          this.format = data.format;
          if (typeof data.sourceRate === "number" && data.sourceRate > 0) {
            this.sourceRate = data.sourceRate;
          } else {
            this.sourceRate = data.format === "ulaw" ? DEFAULT_ULAW_RATE : DEFAULT_SOURCE_RATE;
          }
          this.prebufferTarget = Math.max(1, Math.floor(this.sourceRate * PREBUFFER_SECONDS));
          break;
        case "buffer": {
          this.wasInterrupted = false;
          const buf =
            this.format === "ulaw"
              ? new Uint8Array(data.buffer)
              : new Int16Array(data.buffer);
          this.buffers.push(buf);
          this.queuedSourceSamples += buf.length;
          break;
        }
        case "interrupt":
          this.wasInterrupted = true;
          break;
        case "clearInterrupted":
          if (this.wasInterrupted) {
            this.wasInterrupted = false;
            this.buffers = [];
            this.currentBuffer = null;
            this.queuedSourceSamples = 0;
            this.fracCursor = 0;
            this.started = false;
          }
          break;
        case "setReady":
          this.ready = !!data.ready;
          break;
        case "setPrebufferSeconds":
          if (typeof data.seconds === "number" && data.seconds >= 0) {
            this.prebufferTarget = Math.max(0, Math.floor(this.sourceRate * data.seconds));
          }
          break;
        case "setSourceRate":
          if (typeof data.rate === "number" && data.rate > 0) {
            this.sourceRate = data.rate;
            this.prebufferTarget = Math.max(1, Math.floor(this.sourceRate * PREBUFFER_SECONDS));
          }
          break;
      }
    };
  }

  sampleAt(buf, idx) {
    const v = buf[idx];
    return this.format === "ulaw" ? decodeSample(v) : v;
  }

  // Linear-interpolated lookahead by 1 source sample, crossing buffer
  // boundaries when needed.
  nextSampleAt(idx) {
    const cur = this.currentBuffer;
    if (idx + 1 < cur.length) return this.sampleAt(cur, idx + 1);
    const peek = this.buffers[0];
    if (peek && peek.length > 0) {
      const v = peek[0];
      return this.format === "ulaw" ? decodeSample(v) : v;
    }
    return this.sampleAt(cur, idx);
  }

  process(_, outputs) {
    let finished = false;
    const output = outputs[0][0];

    const gateOpen =
      this.ready &&
      (this.started || this.queuedSourceSamples >= this.prebufferTarget);

    if (!gateOpen) {
      finished = this.buffers.length === 0 && !this.currentBuffer;
      if (this.finished !== finished) {
        this.finished = finished;
        this.port.postMessage({ type: "process", finished });
      }
      return true;
    }

    this.started = true;
    const ratio = this.sourceRate / sampleRate;

    for (let i = 0; i < output.length; i++) {
      if (!this.currentBuffer) {
        if (this.buffers.length === 0) {
          finished = true;
          break;
        }
        this.currentBuffer = this.buffers.shift();
        this.fracCursor = 0;
      }

      const idx = Math.floor(this.fracCursor);
      const frac = this.fracCursor - idx;
      const v0 = this.sampleAt(this.currentBuffer, idx);
      const v1 = frac > 0 ? this.nextSampleAt(idx) : v0;
      output[i] = (v0 * (1 - frac) + v1 * frac) / 32768;

      const prev = this.fracCursor;
      this.fracCursor += ratio;
      const consumed = Math.floor(this.fracCursor) - Math.floor(prev);
      if (consumed > 0) {
        this.queuedSourceSamples = Math.max(0, this.queuedSourceSamples - consumed);
      }

      while (this.currentBuffer && this.fracCursor >= this.currentBuffer.length) {
        this.fracCursor -= this.currentBuffer.length;
        if (this.buffers.length === 0) {
          this.currentBuffer = null;
        } else {
          this.currentBuffer = this.buffers.shift();
        }
      }
    }

    if (this.finished !== finished) {
      this.finished = finished;
      this.port.postMessage({ type: "process", finished });
    }

    return true;
  }
}

registerProcessor("audioConcatProcessor", AudioConcatProcessor);
