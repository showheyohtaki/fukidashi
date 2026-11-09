// 入ってきた音を 20ms ごと（24kHz なら 480サンプル）にまとめて本体へ送る。
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = Math.round(sampleRate * 0.02);
    this.buf = new Float32Array(this.frame);
    this.n = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    const ch = channels && channels[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] || 0;
      this.buf[this.n++] = mono / channels.length;
      if (this.n === this.frame) {
        this.port.postMessage(this.buf.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
