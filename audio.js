import { b64ToInt16 } from "./openai.js";
// Measure this utterance, excluding connection latency and the first chunk
// (which was already generated when the observation window began).
export function observeGeneration(source, seconds, at = Date.now()) {
  source.firstPcmAt ??= at;
  source.firstPcmSeconds ??= seconds;
  source.lastPcmAt = at;
  source.audioSeconds = (source.audioSeconds || 0) + seconds;
}
export function generationRate(source, at = Date.now(), minimumMs = 300) {
  if (
    source.firstPcmAt == null ||
    !Number.isFinite(source.firstPcmSeconds) ||
    at <= source.firstPcmAt ||
    at - source.firstPcmAt < minimumMs
  )
    return null;
  return (
    Math.max(0, (source.audioSeconds || 0) - source.firstPcmSeconds) /
    ((at - source.firstPcmAt) / 1000)
  );
}
export function splitSpeech(text) {
  if ([...text].length <= 40) return [text];
  // Preserve punctuation/closing quotes and exact order; do not split decimals
  // or invent a pause in a sentence that has no sentence terminator.
  return (
    text.match(
      /[^。！？!?]+[。！？!?]+[」』”’"]*|[^。！？!?]+$|[。！？!?]+/gu,
    ) || [text]
  );
}
export function playbackBufferPlan(
  text,
  { seconds, rate = null, completed = false, waitedMs = 0 },
) {
  const expectedSeconds = [...text.replace(/\s/g, "")].length / 5.5;
  if (!Number.isFinite(rate) || rate < 0) rate = null;
  const requiredSeconds =
    rate == null
      ? null
      : rate >= 1.2
        ? 0.12
        : Math.max(0.3, expectedSeconds * (1 - rate) + 0.2);
  const capped = waitedMs >= 2000;
  return {
    expectedSeconds,
    rate,
    requiredSeconds,
    waitedMs,
    capped,
    completed,
    ready:
      seconds > 0 &&
      (completed ||
        capped ||
        (requiredSeconds != null && seconds >= requiredSeconds)),
  };
}
export class AudioCapture {
  async start(
    streamId,
    onFrame,
    { localMonitor = false, useLocalMic = false } = {},
  ) {
    await this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: useLocalMic
        ? { echoCancellation: true, noiseSuppression: true }
        : {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId,
            },
          },
      video: false,
    });
    try {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      await this.ctx.audioWorklet.addModule("pcm-worklet.js");
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.ctx, "pcm-tap");
      this.worklet.port.onmessage = (e) =>
        onFrame(
          Int16Array.from(e.data, (x) =>
            Math.round(Math.max(-1, Math.min(1, x)) * 32767),
          ),
        );
      this.source.connect(this.worklet);
      this.silent = this.ctx.createGain();
      this.silent.gain.value = 0;
      this.worklet.connect(this.silent).connect(this.ctx.destination);
      if (localMonitor && !useLocalMic)
        this.source.connect(this.ctx.destination);
      await this.ctx.resume();
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.worklet) this.worklet.port.onmessage = null;
    try {
      this.source?.disconnect();
      this.worklet?.disconnect();
      await this.ctx?.close();
    } catch {}
    this.stream = null;
    this.ctx = null;
  }
}
export class LocalPlayer {
  constructor() {
    this.sources = new Set();
    this.finished = null;
  }
  async play(chunks) {
    this.stop();
    this.ctx ||= new AudioContext({ sampleRate: 24000 });
    await this.ctx.resume();
    let when = this.ctx.currentTime + 0.04;
    for (const b64 of chunks) {
      const pcm = b64ToInt16(b64),
        b = this.ctx.createBuffer(1, pcm.length, 24000);
      const out = b.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(when);
      when += b.duration;
      this.sources.add(s);
      s.onended = () => {
        this.sources.delete(s);
        s.disconnect();
        if (!this.sources.size) {
          this.finished?.();
          this.finished = null;
        }
      };
    }
    if (this.sources.size)
      await new Promise((resolve) => {
        this.finished = resolve;
      });
  }
  stop() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
        s.disconnect();
      } catch {}
    }
    this.sources.clear();
    this.finished?.();
    this.finished = null;
  }
}
export function wavBytes(chunks) {
  const arrays = chunks.map(b64ToInt16);
  const length = arrays.reduce((n, p) => n + p.byteLength, 0),
    buffer = new ArrayBuffer(44 + length),
    d = new DataView(buffer);
  const str = (offset, text) =>
    [...text].forEach((c, i) => d.setUint8(offset + i, c.charCodeAt(0)));
  str(0, "RIFF");
  d.setUint32(4, 36 + length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 1, true);
  d.setUint32(24, 24000, true);
  d.setUint32(28, 48000, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  str(36, "data");
  d.setUint32(40, length, true);
  let pos = 44;
  for (const pcm of arrays)
    for (const x of pcm) {
      d.setInt16(pos, x, true);
      pos += 2;
    }
  return new Uint8Array(buffer);
}
