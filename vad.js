// 20 ms / 24 kHz frames. Pure state machine: testable without browser or API.
export class VAD {
  constructor(h = {}, sensitivity = 1) {
    this.h = h;
    this.sensitivity = sensitivity;
    this.reset();
  }
  reset() {
    this.noise = 0.002;
    this.pre = [];
    this.loud = 0;
    this.quiet = 0;
    this.active = false;
    this.frames = 0;
    this.pending = 0;
    this.tail = [];
    this.committed = false;
    this.pendingStart = null;
    this.pendingEnd = null;
  }
  feed(frame, at = Date.now()) {
    if (!(frame instanceof Int16Array) || frame.length !== 480)
      throw new Error("VAD expects 480 PCM16 samples");
    let energy = 0;
    for (const x of frame) energy += (x / 32768) ** 2;
    const rms = Math.sqrt(energy / frame.length),
      threshold = Math.max(this.noise * 3.5, 0.012) * this.sensitivity;
    const loud = rms >= threshold,
      quiet = rms < threshold * 0.7;
    if (!this.active) {
      this.pre.push({ frame: frame.slice(), at });
      if (this.pre.length > 25) this.pre.shift();
      this.loud = loud ? this.loud + 1 : 0;
      if (quiet) this.noise = this.noise * 0.98 + rms * 0.02;
      if (this.loud < 3) return;
      this.active = true;
      this.quiet = 0;
      this.committed = false;
      this.h.onStart?.();
      for (const f of this.pre) this.append(f.frame, f.at);
      this.pre = [];
      return;
    }
    if (loud && this.quiet >= 3) {
      this.h.onResume?.();
      this.committed = false;
    }
    this.quiet = quiet ? this.quiet + 1 : 0;
    // Hold only the last 300 ms of a 15-second segment, split at its quietest frame.
    if (this.frames >= 735 && !this.committed) {
      this.tail.push({ frame: frame.slice(), rms, at });
      if (this.tail.length === 15) {
        let cut = 0;
        this.tail.forEach((v, i) => {
          if (v.rms < this.tail[cut].rms) cut = i;
        });
        const held = this.tail;
        this.tail = [];
        for (const v of held.slice(0, cut + 1)) this.append(v.frame, v.at);
        this.commit("continuous");
        for (const v of held.slice(cut + 1)) this.append(v.frame, v.at);
        this.committed = false;
      }
    } else if (!this.committed || loud) {
      this.committed = false;
      this.append(frame, at);
    }
    if (this.quiet === 35) {
      this.flushTail();
      this.commit("pause");
      this.committed = true;
    }
    if (this.quiet >= 75) {
      this.flushTail();
      this.commit("turn");
      this.active = false;
      this.loud = 0;
      this.pre = [];
      this.h.onTurnEnd?.();
    }
  }
  append(frame, at) {
    this.pendingStart ??= at - 20;
    this.pendingEnd = at;
    this.frames++;
    this.pending++;
    this.h.onFrame?.(frame);
  }
  flushTail() {
    for (const v of this.tail) this.append(v.frame, v.at);
    this.tail = [];
  }
  commit(reason) {
    if (this.pending >= 5)
      this.h.onCommit?.({
        reason,
        seconds: this.pending * 0.02,
        audioStartedAt: this.pendingStart,
        audioEndedAt: this.pendingEnd,
      });
    this.frames = 0;
    this.pending = 0;
    this.pendingStart = null;
    this.pendingEnd = null;
  }
}
