/**
 * The microphone side of a call. The browser hands audio to a worklet (a script that runs on the audio thread) at
 * whatever rate the sound card runs, 48 000 or 44 100 samples a second; the server wants 16 000. The worklet turns one
 * into the other with a windowed-sinc low-pass and resample, cuts the result into frames of 512 samples (32 ms) and
 * posts each with how loud it was. Kept as a string because that is how a worklet is loaded; the same string is run
 * under test, with a stand-in for the audio thread's globals, so what ships is what was tested.
 */

export const CAPTURE_FRAME_SAMPLES = 512;
export const CAPTURE_PROCESSOR = "ancilla-capture";

export const CAPTURE_WORKLET_SOURCE = `
class AncillaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.cut = Math.min(1, 1 / this.ratio) * 0.9;
    this.half = Math.max(4, Math.ceil(8 / this.cut));
    this.pos = 0;
    this.buf = new Float32Array(0);
    this.frame = new Int16Array(${CAPTURE_FRAME_SAMPLES});
    this.filled = 0;
    this.energy = 0;
    this.peak = 0;
  }
  kernel(x) {
    const a = this.cut;
    const h = this.half;
    if (x <= -h || x >= h) return 0;
    const s = x === 0 ? a : Math.sin(Math.PI * a * x) / (Math.PI * x);
    return s * (0.5 + 0.5 * Math.cos((Math.PI * x) / h));
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const merged = new Float32Array(this.buf.length + channel.length);
    merged.set(this.buf, 0);
    merged.set(channel, this.buf.length);
    this.buf = merged;
    const half = this.half;
    while (this.pos + half < this.buf.length) {
      const centre = this.pos;
      const from = Math.max(0, Math.ceil(centre - half));
      const to = Math.min(this.buf.length - 1, Math.floor(centre + half));
      let sum = 0;
      for (let i = from; i <= to; i++) sum += this.buf[i] * this.kernel(i - centre);
      const v = sum > 1 ? 1 : sum < -1 ? -1 : sum;
      this.frame[this.filled++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
      this.energy += v * v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.pos += this.ratio;
      if (this.filled === this.frame.length) {
        const out = this.frame;
        this.port.postMessage({ pcm: out.buffer, rms: Math.sqrt(this.energy / this.frame.length), peak: this.peak }, [out.buffer]);
        this.frame = new Int16Array(${CAPTURE_FRAME_SAMPLES});
        this.filled = 0;
        this.energy = 0;
        this.peak = 0;
      }
    }
    const keep = Math.max(0, Math.floor(this.pos - half));
    if (keep > 0) {
      this.buf = this.buf.slice(keep);
      this.pos -= keep;
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR)}, AncillaCapture);
`;
