import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import { canSend, cleanPageEvent, statusView } from "../protocol.js";
const source = await fs.readFile(
  new URL("../inject.js", import.meta.url),
  "utf8",
);
function fixture({ senderAPI = false, preempt = false } = {}) {
  const listeners = new Map(),
    emitted = [],
    sources = [],
    gains = [],
    contexts = [],
    destinations = [],
    inputs = [],
    timer = new Map();
  let tid = 0,
    nativeStreamClones = 0;
  class Track extends EventTarget {
    constructor(label = "real", kind = label === "video" ? "video" : "audio") {
      super();
      this._enabled = true;
      this.readyState = "live";
      this.label = label;
      this.nativeLabel = label;
      this.kind = kind;
      this.stopped = 0;
    }
    get enabled() {
      return this._enabled;
    }
    set enabled(v) {
      this._enabled = !!v;
    }
    stop() {
      this.stopped++;
      this.readyState = "ended";
    }
    clone() {
      const t = new Track(this.nativeLabel, this.kind);
      t.enabled = this.enabled;
      t.readyState = this.readyState;
      return t;
    }
    getSettings() {
      return { deviceId: this.nativeLabel + "-device" };
    }
    getCapabilities() {
      return { sampleRate: { min: 48000 } };
    }
    getConstraints() {
      return { echoCancellation: true };
    }
    applyConstraints(c) {
      this.applied = c;
      return Promise.resolve();
    }
  }
  class Stream {
    constructor(tracks = []) {
      this.tracks = tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === "audio");
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === "video");
    }
    getTracks() {
      return this.tracks;
    }
    removeTrack(t) {
      this.tracks = this.tracks.filter((x) => x !== t);
    }
    addTrack(t) {
      this.tracks.push(t);
    }
    clone() {
      nativeStreamClones++;
      // Native MediaStream cloning does not call a track's own JS clone.
      return new Stream(this.tracks.map((t) => Track.prototype.clone.call(t)));
    }
  }
  const real = new Track(),
    video = new Track("video");
  class Devices {
    getUserMedia() {
      return Promise.resolve(new Stream([real, video]));
    }
  }
  class Node {
    constructor() {
      this.connections = new Set();
    }
    connect(to) {
      this.dest = to;
      this.connections.add(to);
      return to;
    }
    disconnect(to) {
      this.disconnected = true;
      if (to) this.connections.delete(to);
      else this.connections.clear();
    }
  }
  class Context {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = new Node();
      contexts.push(this);
    }
    createGain() {
      const n = new Node();
      n.gain = { value: 1 };
      gains.push(n);
      return n;
    }
    createAnalyser() {
      const n = new Node();
      n.fftSize = 256;
      n.getFloatTimeDomainData = (b) => b.fill(0.1);
      return n;
    }
    createMediaStreamSource() {
      const n = new Node();
      inputs.push(n);
      return n;
    }
    createMediaStreamDestination() {
      const n = new Node();
      n.stream = new Stream([new Track("synthetic")]);
      destinations.push(n);
      return n;
    }
    createBuffer(channels, length, rate) {
      return {
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      };
    }
    createBufferSource() {
      const n = new Node();
      n.start = (when) => {
        n.when = when;
        n.started = true;
      };
      n.stop = () => {
        n.stopped = true;
      };
      sources.push(n);
      return n;
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
  }
  const window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    postMessage: (m, origin) => emitted.push({ m, origin }),
  };
  class Sender {
    constructor(track) {
      this.track = track;
    }
    async replaceTrack(track) {
      this.track = track;
    }
  }
  class Peer {
    constructor() {
      this.signalingState = "stable";
      this.transceivers = [];
    }
    addTrack(track) {
      const sender = new Sender(track);
      this.transceivers.push({
        sender,
        direction: "sendrecv",
        currentDirection: "sendrecv",
      });
      return sender;
    }
    addTransceiver(track) {
      this.addTrack(track);
      return this.transceivers.at(-1);
    }
    getTransceivers() {
      return this.transceivers;
    }
    removeTrack(sender) {
      sender.track = null;
    }
    close() {
      this.signalingState = "closed";
    }
  }
  const sandbox = {
    window,
    location: { origin: "https://meet.google.com" },
    MediaDevices: Devices,
    MediaStreamTrack: Track,
    MediaStream: Stream,
    AudioContext: Context,
    Float32Array,
    Uint8Array,
    Int16Array,
    Map,
    Set,
    atob,
    btoa,
    setTimeout: (fn) => {
      timer.set(++tid, fn);
      return tid;
    },
    clearTimeout: (id) => timer.delete(id),
    setInterval: (fn) => {
      timer.set(++tid, fn);
      return tid;
    },
    ...(senderAPI ? { RTCPeerConnection: Peer, RTCRtpSender: Sender } : {}),
  };
  vm.runInNewContext(source, sandbox);
  const secret = "12345678-1234-1234-1234-123456789012";
  const message = (m, overrides = {}) => {
    for (const fn of listeners.get("message") || [])
      fn({
        source: window,
        origin: "https://meet.google.com",
        data: { __koe: "extension", secret, ...m },
        ...overrides,
      });
  };
  if (preempt)
    message({ type: "hello", secret: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  message({ type: "hello" });
  return {
    real,
    video,
    devices: new Devices(),
    message,
    emitted,
    sources,
    gains,
    contexts,
    timer,
    secret,
    Peer,
    Track,
    Stream,
    destinations,
    inputs,
    nativeStreamClones: () => nativeStreamClones,
  };
}
test("inject: wraps microphone, preserves camera and metadata, real mic gain defaults zero", async () => {
  const f = fixture(),
    stream = await f.devices.getUserMedia({ audio: true, video: true }),
    track = stream.getAudioTracks()[0];
  assert.notEqual(track, f.real);
  assert.equal(stream.getVideoTracks()[0], f.video);
  assert.equal(track.label, "real");
  assert.deepEqual(track.getSettings(), { deviceId: "real-device" });
  await track.applyConstraints({ noiseSuppression: false });
  assert.equal(f.real.applied.noiseSuppression, false);
  assert.equal(f.gains[1].gain.value, 0);
  f.message({ type: "sendMic", value: true });
  assert.equal(f.gains[1].gain.value, 1);
});
test("R1 M6: replaceTrack(null), removeTrack and inactive transceiver stop local output and report detached", async () => {
  const f = fixture({ senderAPI: true });
  const stream = await f.devices.getUserMedia({ audio: true }),
    track = stream.getAudioTracks()[0],
    pc = new f.Peer();
  assert.equal(f.emitted.at(-1).m.attached, 0);
  const sender = pc.addTrack(track);
  assert.equal(f.emitted.at(-1).m.attached, 1);
  const audio = btoa("\0".repeat(5760));
  f.message({ type: "pcm", id: "attached", audio });
  assert.equal(f.sources.length, 1);
  await sender.replaceTrack(null);
  assert(f.sources[0].stopped);
  assert(
    f.emitted.some(
      (e) => e.m.type === "status" && e.m.attached === 0 && e.m.unmuted === 1,
    ),
  );
  await sender.replaceTrack(track);
  assert.equal(f.emitted.at(-1).m.attached, 1);
  f.message({ type: "pcm", id: "inactive", audio });
  pc.getTransceivers()[0].direction = "inactive";
  [...f.timer.values()][0]();
  assert(f.sources.at(-1).stopped);
  pc.getTransceivers()[0].direction = "sendrecv";
  pc.removeTrack(sender);
  assert.equal(f.emitted.at(-1).m.attached, 0);
});
test("R1 T14 limitation: a page can observe or preempt the handshake; secret is not page authentication", async () => {
  const f = fixture({ preempt: true });
  await f.devices.getUserMedia({ audio: true });
  const audio = btoa("\0".repeat(5760));
  f.message({ type: "pcm", id: "legitimate", audio });
  assert.equal(
    f.sources.length,
    0,
    "preempted hello prevents the legitimate bridge",
  );
  f.message({
    type: "pcm",
    id: "page-owned",
    audio,
    secret: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
  assert.equal(
    f.sources.length,
    1,
    "known page-visible secret cannot authenticate extension origin",
  );
});
test("inject: clone retains TTS graph and real source until last clone stops", async () => {
  const f = fixture(),
    stream = await f.devices.getUserMedia({ audio: true }),
    track = stream.getAudioTracks()[0],
    clone = track.clone();
  track.stop();
  assert.equal(f.real.stopped, 0);
  assert.equal(clone.label, "real");
  clone.stop();
  assert.equal(f.real.stopped, 1);
  clone.stop();
  assert.equal(f.real.stopped, 1);
});
test("R8: stream.clone -> repeated stream.clone -> track.clone -> replaceTrack retains ownership, metadata, video and audio after original stop", async () => {
  const f = fixture({ senderAPI: true });
  const original = await f.devices.getUserMedia({ audio: true, video: true });
  const first = original.clone(),
    second = first.clone();
  const sending = second.getAudioTracks()[0].clone();
  const pc = new f.Peer(),
    sender = pc.addTransceiver("audio").sender;
  await sender.replaceTrack(sending);
  const page = () => f.emitted.filter((e) => e.m.type === "status").at(-1).m;
  assert.equal(
    f.nativeStreamClones(),
    0,
    "wrapped streams must take the per-track path",
  );
  assert.equal(page().streams, 4);
  assert.equal(page().attached, 1);
  assert.equal(page().attachedEver, true);
  for (const t of [
    first.getAudioTracks()[0],
    second.getAudioTracks()[0],
    sending,
  ]) {
    assert.equal(t.label, "real");
    assert.deepEqual(t.getSettings(), { deviceId: "real-device" });
    assert.deepEqual(t.getCapabilities(), f.real.getCapabilities());
    assert.deepEqual(t.getConstraints(), f.real.getConstraints());
    assert(Object.hasOwn(t, "clone"));
    assert(Object.hasOwn(t, "label"));
  }
  await sending.applyConstraints({ noiseSuppression: false });
  assert.equal(f.real.applied.noiseSuppression, false);
  assert.equal(first.getVideoTracks().length, 1);
  assert.notEqual(first.getVideoTracks()[0], f.video);
  assert.equal(first.getVideoTracks()[0].label, "video");
  assert.equal(Object.hasOwn(first.getVideoTracks()[0], "stop"), false);
  original.getAudioTracks()[0].stop();
  assert.equal(f.real.stopped, 0);
  assert.equal(page().streams, 3);
  assert.equal(page().attached, 1);
  assert.equal(sending.readyState, "live");
  const audio = btoa("\0".repeat(5760));
  f.message({ type: "pcm", id: "after-original-stop", audio });
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].stopped, undefined);
  first.getAudioTracks()[0].stop();
  second.getAudioTracks()[0].stop();
  assert.equal(page().streams, 1);
  assert.equal(f.real.stopped, 0);
  assert.equal(f.inputs[0].disconnected, undefined);
  sending.stop();
  assert.equal(page().streams, 0);
  assert.equal(page().attached, 0);
  assert.equal(page().attachedEver, true);
  assert.equal(f.real.stopped, 1);
  assert(f.inputs[0].disconnected);
  assert(f.gains[1].disconnected);
  assert(f.sources[0].stopped);
  assert(
    f.gains[0].connections.has(f.destinations[0]),
    "TTS bus stays connected after release",
  );
  sending.stop();
  sending.dispatchEvent(new Event("ended"));
  assert.equal(f.real.stopped, 1, "release is idempotent");
});
test("R8: muting the actual stream-derived sender gates output even while unused clones are enabled; unmute restores it", async () => {
  const f = fixture({ senderAPI: true });
  const original = await f.devices.getUserMedia({ audio: true });
  const intermediate = original.clone();
  const sending = intermediate.getAudioTracks()[0].clone();
  const pc = new f.Peer();
  await pc.addTransceiver("audio").sender.replaceTrack(sending);
  const state = () => ({
    active: true,
    sttState: "ready",
    voiceState: "ready",
    page: cleanPageEvent(
      f.emitted.filter((e) => e.m.type === "status").at(-1).m,
    ),
  });
  const audio = btoa("\0".repeat(5760));
  f.message({ type: "pcm", id: "before-mute", audio });
  sending.enabled = false;
  assert.equal(state().page.unmuted, 2);
  assert.equal(state().page.attached, 0);
  assert.equal(state().page.attachedEver, true);
  assert.equal(canSend(state()), false);
  assert.equal(statusView(state()).text, "会議でミュート中");
  assert(f.sources[0].stopped);
  const disabledClone = new f.Stream([sending]).clone().getAudioTracks()[0];
  assert.equal(disabledClone.enabled, false);
  disabledClone.stop();
  f.message({ type: "pcm", id: "while-muted", audio });
  assert.equal(f.sources.length, 1);
  sending.enabled = true;
  assert.equal(canSend(state()), true);
  assert.equal(state().page.attached, 1);
  f.message({ type: "pcm", id: "after-unmute", audio });
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources.at(-1).stopped, undefined);
});
test("R8: unrelated and ended-only streams keep native clone behavior without entering outputs", async () => {
  const f = fixture();
  const unrelated = new f.Stream([
    new f.Track("other"),
    new f.Track("camera", "video"),
  ]);
  const cloned = unrelated.clone();
  assert.equal(f.nativeStreamClones(), 1);
  assert.equal(cloned.getTracks().length, 2);
  assert.notEqual(cloned.getTracks()[0], unrelated.getTracks()[0]);
  assert.equal(Object.hasOwn(cloned.getTracks()[0], "stop"), false);
  assert.equal(cloned.getAudioTracks()[0].label, "other");
  const wrapped = await f.devices.getUserMedia({ audio: true });
  wrapped.getAudioTracks()[0].stop();
  const ended = wrapped.clone();
  assert.equal(f.nativeStreamClones(), 2);
  assert.equal(ended.getAudioTracks()[0].readyState, "ended");
  assert.equal(
    f.emitted.filter((e) => e.m.type === "status").at(-1).m.streams,
    0,
  );
});
test("R8: releasing all known tracks retains destination input for an unknown native clone but releases the physical mic", async () => {
  const f = fixture();
  const stream = await f.devices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  // Simulate an untracked native cloning route, not the wrapped JS API.
  const unknown = f.Track.prototype.clone.call(track);
  track.stop();
  assert.equal(unknown.readyState, "live");
  assert.equal(f.real.stopped, 1);
  assert(f.inputs[0].disconnected);
  assert(f.gains[1].disconnected);
  assert(f.gains[0].connections.has(f.destinations[0]));
  assert(
    f.gains[0].connections.size >= 2,
    "analyser and destination remain fed",
  );
  f.message({ type: "sendMic", value: true });
  assert.equal(
    f.gains[1].gain.value,
    0,
    "released physical mic cannot be re-enabled",
  );
});
test("T7/T14 inject: origin, source, secret checks reject forged PCM; mute stops scheduled audio immediately", async () => {
  const f = fixture(),
    stream = await f.devices.getUserMedia({ audio: true });
  const audio = btoa("\0".repeat(5760));
  f.message({ type: "pcm", id: "forged", audio, secret: undefined });
  f.message(
    { type: "pcm", id: "foreign", audio },
    { origin: "https://evil.test" },
  );
  f.message({ type: "pcm", id: "other-window", audio }, { source: {} });
  assert.equal(f.sources.length, 0);
  f.message({ type: "pcm", id: "valid", audio });
  assert.equal(f.sources.length, 1);
  stream.getAudioTracks()[0].enabled = false;
  assert(f.sources[0].stopped);
  assert(f.emitted.some((e) => e.m.type === "play-end" && e.m.stopped));
  assert(f.emitted.some((e) => e.m.type === "status" && e.m.unmuted === 0));
});
test("T9 inject: stop removes all scheduled sources and tombstones late chunks", async () => {
  const f = fixture();
  await f.devices.getUserMedia({ audio: true });
  const audio = btoa("\0".repeat(5760));
  f.message({ type: "pcm", id: "one", audio });
  f.message({ type: "pcm", id: "one", audio });
  f.contexts[0].currentTime = 0.05;
  f.message({ type: "stop" });
  assert(f.sources.every((s) => s.stopped));
  assert.equal(f.emitted.filter((e) => e.m.type === "play-end").length, 1);
  f.message({ type: "pcm", id: "one", audio });
  assert.equal(f.sources.length, 2);
  f.message({ type: "pcm", id: "two", audio });
  assert.equal(f.sources.length, 3);
});

test("R4: interrupted duration excludes gaps between PCM buffers", async () => {
  const f = fixture();
  await f.devices.getUserMedia({ audio: true });
  const audio = btoa("\0".repeat(4800 * 2)); // 0.2 seconds
  f.message({ type: "pcm", id: "gaps", audio });
  f.contexts[0].currentTime = 0.3;
  f.sources[0].onended();
  f.contexts[0].currentTime = 1;
  f.message({ type: "pcm", id: "gaps", audio: btoa("\0".repeat(14400 * 2)) });
  f.contexts[0].currentTime = 1.105;
  f.message({ type: "stop" });
  const end = f.emitted.find((e) => e.m.type === "play-end").m;
  assert(
    Math.abs(end.elapsed - 0.3) < 0.00001,
    "0.2s played + 0.1s of next chunk, not 1.09s wall time",
  );
  assert(Math.abs(end.underrunMs - 790) < 0.001);
});

test("R7 inject: underrun announces preparing, waits for 0.4s, and completion releases a shorter tail", async () => {
  const f = fixture();
  await f.devices.getUserMedia({ audio: true });
  const short = btoa("\0".repeat(2400 * 2)),
    audio = btoa("\0".repeat(4800 * 2));
  f.message({ type: "pcm", id: "buffer", audio: short });
  f.contexts[0].currentTime = 0.2;
  f.sources[0].onended();
  assert(f.emitted.some((e) => e.m.type === "play-progress" && e.m.preparing));
  f.message({ type: "pcm", id: "buffer", audio });
  assert.equal(f.sources.length, 1);
  f.contexts[0].currentTime = 0.3;
  f.message({ type: "pcm", id: "buffer", audio });
  assert.equal(f.sources.length, 3, "0.4s resumes playback");
  assert.equal(
    f.emitted.filter((e) => e.m.type === "play-progress").at(-1).m.preparing,
    false,
  );
  f.contexts[0].currentTime = 0.8;
  for (const source of f.sources.slice(1)) source.onended();
  f.message({ type: "pcm", id: "buffer", audio: short });
  assert.equal(f.sources.length, 3);
  f.message({ type: "end", id: "buffer" });
  assert.equal(f.sources.length, 4);
  f.contexts[0].currentTime = 1;
  f.sources[3].onended();
  const end = f.emitted.find((e) => e.m.type === "play-end").m;
  assert(Math.abs(end.elapsed - 0.6) < 0.0001);
  assert(Math.abs(end.underrunMs - 290) < 0.001);
});

test("R6 inject: waiting for terminal done after all audio is played is not an internal underrun", async () => {
  const f = fixture();
  await f.devices.getUserMedia({ audio: true });
  f.message({ type: "pcm", id: "tail", audio: btoa("\0".repeat(4800)) });
  f.contexts[0].currentTime = 0.2;
  f.sources[0].onended();
  f.contexts[0].currentTime = 1.2;
  f.message({ type: "end", id: "tail" });
  const end = f.emitted.find((e) => e.m.type === "play-end").m;
  assert.equal(end.underrunMs, 0);
});

test("R2 H1: defined RTCPeerConnection without media sender still plays WebAudio/WASM audio", async () => {
  const f = fixture({ senderAPI: true });
  const stream = await f.devices.getUserMedia({ audio: true });
  const page = cleanPageEvent(f.emitted.at(-1).m);
  assert.equal(page.attached, 0);
  assert.equal(page.attachedEver, false);
  assert(
    canSend({ active: true, voiceState: "ready", sttState: "ready", page }),
  );
  f.message({ type: "pcm", id: "wasm", audio: btoa("\0".repeat(5760)) });
  [...f.timer.values()][0]();
  assert.equal(f.sources.length, 1);
  assert.equal(
    f.sources[0].stopped,
    undefined,
    "periodic sender check must not stop WASM playback",
  );
  stream.getAudioTracks()[0].enabled = false;
  assert.equal(
    f.sources[0].stopped,
    true,
    "enabled mute still stops WASM playback",
  );
});
test("R2 H1: before first sender attachment is not meeting-muted; detach after attachment still is", async () => {
  const f = fixture({ senderAPI: true });
  const stream = await f.devices.getUserMedia({ audio: true });
  const state = () => ({
    active: true,
    sttState: "ready",
    voiceState: "ready",
    page: cleanPageEvent(f.emitted.at(-1).m),
  });
  assert.equal(statusView(state()).text, "相手の声を待っています");
  const pc = new f.Peer();
  const sender = pc.addTrack(stream.getAudioTracks()[0]);
  assert.equal(state().page.attachedEver, true);
  await sender.replaceTrack(null);
  assert.equal(state().page.attachedEver, true);
  assert.equal(statusView(state()).text, "会議でミュート中");
  assert.equal(canSend(state()), false);
});
