/* The mic, sample for sample, on the AudioContext's own clock.
 *
 * `currentFrame` is the context-timeline frame of the quantum being processed, and the input handed to
 * process() is delivered on that same timeline. So "this recorded sample" and "the click scheduled at time
 * T" live on ONE clock, and everything between them - output latency, the air, input latency - is a
 * single number that calibration measures. Nothing here is timed by the main thread's clock.
 *
 * Batched: one message per ~43 ms, carrying the frame of its first sample, so a dropped quantum shows up
 * as a gap in the frames rather than as silently shifted audio. */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.buf = new Float32Array(2048); this.n = 0; this.first = 0;
    this.port.onmessage = (e) => { if (e.data === "start") { this.on = true; this.n = 0; } else if (e.data === "stop") { this.flush(); this.on = false; this.port.postMessage({ stopped: true }); } };
  }
  flush() {
    if (!this.n) return;
    this.port.postMessage({ frame: this.first, data: this.buf.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      if (this.n === 0) this.first = currentFrame;
      if (this.n + ch.length > this.buf.length) { this.flush(); this.first = currentFrame; }
      this.buf.set(ch, this.n); this.n += ch.length;
      if (this.n >= 2048) this.flush();
    }
    return true;
  }
}
registerProcessor("rdm-recorder", RecorderProcessor);
