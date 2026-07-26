class MeetingPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputRate = 16000;
    this.step = sampleRate / this.outputRate;
    this.sourcePosition = 0;
    this.pending = [];
    this.frameSamples = 1600;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    while (this.sourcePosition < input.length) {
      const left = Math.floor(this.sourcePosition);
      const right = Math.min(input.length - 1, left + 1);
      const mix = this.sourcePosition - left;
      const sample = input[left] + (input[right] - input[left]) * mix;
      this.pending.push(Math.max(-1, Math.min(1, sample)));
      this.sourcePosition += this.step;
    }
    this.sourcePosition -= input.length;

    while (this.pending.length >= this.frameSamples) {
      const pcm = new Int16Array(this.frameSamples);
      for (let index = 0; index < pcm.length; index += 1) {
        const sample = this.pending[index];
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.pending.splice(0, this.frameSamples);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("meeting-pcm-processor", MeetingPcmProcessor);
