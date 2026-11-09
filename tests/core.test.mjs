import test from "node:test";
import assert from "node:assert/strict";
import { VAD } from "../vad.js";
import {
  configWith,
  sanitizeConfig,
  publicConfig,
  DEFAULTS,
} from "../config.js";
import {
  statusView,
  speechMatches,
  validPageCommand,
  cleanPageEvent,
  shouldSendEnter,
  canSend,
} from "../protocol.js";
import { Speaker, Transcriber, int16ToB64, b64ToInt16 } from "../openai.js";
import { wavBytes } from "../audio.js";
import { Session, blankState } from "../session.js";
import { voiceKey } from "../cache.js";
const silence = () => new Int16Array(480),
  voice = (amp = 2000) => new Int16Array(480).fill(amp);
const feed = (vad, n, frame = voice()) => {
  for (let i = 0; i < n; i++) vad.feed(frame);
};
test("VAD: 60 ms onset, 500 ms preroll, 700 ms subtitle and 1500 ms turn", () => {
  const events = [],
    frames = [];
  const v = new VAD({
    onStart: () => events.push("start"),
    onFrame: (f) => frames.push(f),
    onCommit: (m) => events.push(m),
    onTurnEnd: () => events.push("end"),
  });
  feed(v, 30, silence());
  feed(v, 2);
  assert.equal(events.length, 0);
  feed(v, 1);
  assert.equal(events[0], "start");
  assert.equal(frames.length, 25);
  feed(v, 20);
  feed(v, 34, silence());
  assert.equal(events.length, 1);
  feed(v, 1, silence());
  assert.equal(events[1].reason, "pause");
  feed(v, 39, silence());
  assert.notEqual(events.at(-1), "end");
  feed(v, 1, silence());
  assert.equal(events.at(-1), "end");
  assert.equal(events.filter((x) => x.reason).length, 1);
});
test("VAD: continuation invalidates tentative replies, no spurious turn", () => {
  let resumed = 0,
    ends = 0;
  const v = new VAD({ onResume: () => resumed++, onTurnEnd: () => ends++ });
  feed(v, 40);
  feed(v, 36, silence());
  feed(v, 3);
  assert.equal(resumed, 1);
  assert.equal(ends, 0);
});
test("VAD: long speech splits at quietest point without duplicate/lost PCM frames", () => {
  const got = [],
    commits = [];
  const v = new VAD({
    onFrame: (f) => got.push(f[0]),
    onCommit: (m) => commits.push(m),
  });
  for (let i = 0; i < 1600; i++) v.feed(voice(1200 + i));
  v.flushTail();
  assert.equal(commits.filter((c) => c.reason === "continuous").length, 2);
  assert.deepEqual(
    got,
    Array.from({ length: 1600 }, (_, i) => 1200 + i),
  );
});
test("VAD: noise floor and sub-60ms bursts do not trigger", () => {
  let starts = 0;
  const v = new VAD({ onStart: () => starts++ });
  for (let i = 0; i < 30; i++) {
    feed(v, 2);
    feed(v, 20, voice(30));
  }
  assert.equal(starts, 0);
});
test("Config: whitelist, bounds, public key redaction and no endpoint overrides", () => {
  const c = configWith({
    apiKey: "dummy",
    baseUrl: "https://evil.test",
    dev: { baseUrl: "x" },
    voice: "unknown",
    captionFontPx: 99,
    keepLogDays: 365,
  });
  assert.equal(c.captionFontPx, 28);
  assert.equal(c.keepLogDays, 0);
  assert.equal(c.voice, "marin");
  assert.equal(c.baseUrl, undefined);
  assert.equal(publicConfig(c).apiKey, undefined);
  assert.equal(publicConfig(c).hasKey, true);
  assert.equal(sanitizeConfig({ apiKey: "no" }).apiKey, undefined);
  assert.equal(configWith().autoFiller, true);
  assert.equal(configWith().sendMic, false);
});
test("Protocol: keys and untrusted page fields never forwarded", () => {
  assert.equal(
    validPageCommand({ type: "pcm", id: "x", audio: "<script>" }),
    false,
  );
  assert.equal(validPageCommand({ type: "config", apiKey: "dummy" }), false);
  assert.deepEqual(
    cleanPageEvent({
      type: "status",
      streams: 1,
      unmuted: 1,
      attached: 1,
      attachedEver: true,
      context: "running",
      apiKey: "dummy",
    }),
    {
      type: "status",
      streams: 1,
      unmuted: 1,
      attached: 1,
      attachedEver: true,
      context: "running",
    },
  );
  assert.equal(cleanPageEvent({ type: "say", text: "forged" }), null);
});
test("T8 unit: IME Enter/229/Shift suppressed; committed Enter accepted", () => {
  assert.equal(shouldSendEnter({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSendEnter({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldSendEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSendEnter({ key: "Enter" }), true);
});
test("Status priority: mute > overlap > sending > talking > waiting", () => {
  const s = {
    ...blankState(),
    active: true,
    connectedOnce: true,
    page: {
      streams: 1,
      unmuted: 0,
      attached: 1,
      attachedEver: true,
      context: "running",
    },
    speaking: {},
    otherSpeaking: true,
    waitSince: 1,
  };
  assert.equal(statusView(s).tone, "bad");
  s.page.unmuted = 1;
  assert.equal(statusView(s).tone, "warn");
  s.otherSpeaking = false;
  assert.equal(statusView(s).tone, "send");
  s.speaking = null;
  s.otherSpeaking = true;
  assert.equal(statusView(s).tone, "talk");
  s.otherSpeaking = false;
  s.voiceState = s.sttState = "ready";
  assert.equal(statusView(s, 8000).seconds, 7);
});
test("Speech comparison preserves meaning: punctuation ignored, numbers and long vowels kept", () => {
  assert(speechMatches("「はい。」", "はい"));
  assert(!speechMatches("３月末です", "3月です"));
  assert(!speechMatches("コート", "コト"));
  assert(!speechMatches("", ""));
});
test("PCM helpers and WAV header round trip signed endpoints", () => {
  const pcm = Int16Array.of(-32768, -1, 0, 1, 32767),
    base = int16ToB64(pcm);
  assert.deepEqual(b64ToInt16(base), pcm);
  const wav = wavBytes([base]),
    d = new DataView(wav.buffer);
  assert.equal(d.getUint32(24, true), 24000);
  assert.equal(d.getUint32(40, true), 10);
  assert.equal(d.getInt16(44, true), -32768);
});
class Socket {
  static all = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    Socket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(m) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
function ready(client) {
  client.connect();
  const ws = client.ws;
  ws.open();
  ws.message({ type: "session.updated" });
  return ws;
}
test("Speaker waits for session.updated and filters stale response IDs", async () => {
  const chunks = [];
  const s = new Speaker(configWith({ apiKey: "dummy" }), {}, Socket);
  s.connect();
  const ws = s.ws;
  ws.open();
  const p = s.speak("読みます", { pcm: (b) => chunks.push(b) });
  assert(!ws.sent.some((x) => x.type === "response.create"));
  ws.message({ type: "session.updated" });
  assert.equal(ws.sent.at(-1).response.input[0].content[0].text, "読みます");
  ws.message({ type: "response.created", response: { id: "r1" } });
  ws.message({
    type: "response.output_audio.delta",
    response_id: "stale",
    delta: "AAA=",
  });
  assert.equal(chunks.length, 0);
  ws.message({
    type: "response.output_audio.delta",
    response_id: "r1",
    delta: "AAA=",
  });
  ws.message({
    type: "response.done",
    response: { id: "r1", status: "completed" },
  });
  assert.equal((await p).status, "completed");
  assert.equal(chunks.length, 1);
  s.close();
});
test("Speaker cancel quarantines old response until done, never routes it to next utterance", async () => {
  const s = new Speaker(configWith(), {}, Socket),
    ws = ready(s);
  let first = 0,
    second = 0;
  const p1 = s.speak("first", { pcm: () => first++ });
  ws.message({ type: "response.created", response: { id: "old" } });
  s.cancelAll();
  const p2 = s.speak("second", { pcm: () => second++ });
  ws.message({
    type: "response.output_audio.delta",
    response_id: "old",
    delta: "AAA=",
  });
  assert.equal(first, 0);
  assert.equal(ws.sent.filter((x) => x.type === "response.create").length, 1);
  ws.message({
    type: "response.done",
    response: { id: "old", status: "cancelled" },
  });
  assert.equal((await p1).status, "cancelled");
  assert.equal(ws.sent.filter((x) => x.type === "response.create").length, 2);
  ws.message({ type: "response.created", response: { id: "new" } });
  ws.message({
    type: "response.output_audio.delta",
    response_id: "old",
    delta: "AAA=",
  });
  assert.equal(second, 0);
  ws.message({
    type: "response.done",
    response: { id: "new", status: "completed" },
  });
  await p2;
  s.close();
});
test("Speaker cancel before response.created still cancels correct ID", async () => {
  const s = new Speaker(configWith(), {}, Socket),
    ws = ready(s);
  const p = s.speak("first");
  s.cancelAll();
  ws.message({ type: "response.created", response: { id: "late" } });
  assert.equal(ws.sent.at(-1).response_id, "late");
  ws.message({
    type: "response.done",
    response: { id: "late", status: "cancelled" },
  });
  assert.equal((await p).status, "cancelled");
  s.close();
});
test("Transcriber commit ledger: too-short commits refused, correlated failures removed", () => {
  const committed = [];
  const t = new Transcriber(
      configWith(),
      { onCommitted: (id, meta) => committed.push([id, meta]) },
      Socket,
    ),
    ws = ready(t);
  feed({ feed: (f) => t.append(f) }, 4);
  assert.equal(t.commit(), null);
  t.append(voice());
  const first = t.commit({ turn: 1 });
  feed({ feed: (f) => t.append(f) }, 5);
  const second = t.commit({ turn: 2 });
  ws.message({ type: "error", error: { event_id: first, message: "bad" } });
  ws.message({ type: "input_audio_buffer.committed", item_id: "item2" });
  assert.equal(committed[0][1].id, second);
  assert.equal(committed[0][1].turn, 2);
  assert.equal(ws.sent[0].session.audio.input.turn_detection, null);
  t.close();
});
function stubSession(t) {
  const map = new Map(),
    saved = [];
  const cache = {
    open: async () => {},
    expire: async () => {},
    get: async (k) => map.get(k),
    put: async (k, v, p) => {
      map.set(k, v);
      if (p) saved.push(k);
    },
    clearCandidates: () => map.clear(),
    clearVoices: async () => map.clear(),
    clearLogs: async () => {},
    saveLog: async (log) => saved.push(log),
  };
  const page = [];
  const s = new Session({
    cache,
    capture: { stop: async () => {} },
    page: (m) => page.push(m),
  });
  s.cfg = configWith({ apiKey: "dummy" });
  s.savedCfg = s.cfg;
  s.s = {
    ...blankState(),
    active: true,
    connectedOnce: true,
    page: {
      streams: 1,
      unmuted: 1,
      attached: 1,
      attachedEver: true,
      context: "running",
    },
    voiceState: "ready",
    sttState: "ready",
  };
  t.after(() => {
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
    for (const job of s.jobs.values()) {
      clearTimeout(job.watchdog);
      clearTimeout(job.bufferTimer);
      clearTimeout(job.ackTimer);
    }
  });
  return { s, map, saved, page };
}
test("T7 unit: all send entry points reject muted mic before cache/audio", async (t) => {
  const { s, page } = stubSession(t);
  s.s.page.unmuted = 0;
  assert.equal(await s.say("秘密"), false);
  assert.equal(page.length, 0);
  assert.equal(s.job, null);
});
test("T9 unit: interrupted record uses transcribed played prefix, never unplayed suffix", async (t) => {
  const { s, map, page } = stubSession(t);
  const text = "前半です。まだ読んでいない後半です。";
  map.set(await voiceKey(s.cfg, text), {
    chunks: [int16ToB64(new Int16Array(4800))],
    transcript: text,
    seconds: 0.2,
  });
  s.transcribePrefix = async () => "前半です。";
  await s.say(text);
  const id = s.job.id;
  s.pageEvent({ type: "play-start", id });
  s.stopSpeaking();
  s.pageEvent({ type: "play-end", id, stopped: true, elapsed: 0.1 });
  await Promise.all([...s.pendingFinalize]);
  assert.equal(s.s.lines[0].text, "前半です。");
  assert(s.s.lines[0].interrupted);
  assert(page.some((m) => m.type === "stop"));
});
test("A new utterance cannot swallow previous playback completion", async (t) => {
  const { s, map } = stubSession(t);
  for (const text of ["one", "two"])
    map.set(await voiceKey(s.cfg, text), {
      chunks: ["AAA="],
      transcript: text,
      seconds: 1,
    });
  s.transcribePrefix = async () => "one";
  await s.say("one");
  const old = s.job.id;
  s.pageEvent({ type: "play-start", id: old });
  await s.say("two");
  const current = s.job.id;
  s.pageEvent({ type: "play-end", id: old, stopped: true, elapsed: 0.3 });
  await Promise.all([...s.pendingFinalize]);
  assert.equal(s.job.id, current);
  assert.equal(s.s.lines[0].text, "one");
  s.pageEvent({ type: "play-start", id: current });
  s.pageEvent({ type: "play-end", id: current, elapsed: 1 });
  assert.equal(s.s.lines[1].text, "two");
});
test("T11 unit: filler exactly once, only recent typing, disabled and speech cancel it", (t) => {
  const { s } = stubSession(t);
  let calls = 0;
  s.say = () => {
    calls++;
    return Promise.resolve(true);
  };
  s.s.waitSince = Date.now() - 7000;
  s.s.typingAt = Date.now();
  s.tick();
  s.tick();
  assert.equal(calls, 1);
  s.filled = false;
  s.cfg.autoFiller = false;
  s.tick();
  assert.equal(calls, 1);
  s.cfg.autoFiller = true;
  s.s.otherSpeaking = true;
  s.tick();
  assert.equal(calls, 1);
  s.s.otherSpeaking = false;
  s.s.typingAt = Date.now() - 3000;
  s.tick();
  assert.equal(calls, 1);
});
test("Active key/voice/style changes are deferred until next start; public config shows selection", async (t) => {
  const { s } = stubSession(t);
  await s.updateConfig({
    ...s.cfg,
    apiKey: "changed",
    voice: "cedar",
    style: "new",
  });
  assert.equal(s.cfg.voice, "marin");
  assert.equal(s.cfg.apiKey, "dummy");
  assert.equal(s.snapshot().cfg.voice, "cedar");
  assert.equal(s.snapshot().cfg.apiKey, undefined);
});
test("T17 unit: session snapshots never saved to chrome.local; transient candidate cache stays memory-only", async (t) => {
  const { s, saved } = stubSession(t);
  s.pre = {
    close() {},
    speak: async () => ({
      status: "completed",
      chunks: ["AAA="],
      transcript: "はい",
      seconds: 0.1,
    }),
  };
  await s.synthesizeCached("はい", false);
  assert.equal(saved.length, 0);
  s.s.active = false;
  await s.command({ command: "forget" });
  assert.equal(s.s.lines.length, 0);
});

test("Summary accepts speaker-prefixed evidence, rejects unsupported notes and failed speech", async (t) => {
  const { summarizeHearing } = await import("../openai.js");
  let requestBody;
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    requestBody = JSON.parse(opts.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    question: "予算",
                    answer: "50万円",
                    evidence: "相手: 予算は50万円です。",
                  },
                ],
                other: [{ text: "推測の話", evidence: "存在しない発言" }],
                todo: [
                  { text: "写真を送る", evidence: "相手: 写真を送ります。" },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  });
  const lines = [
    { who: "other", text: "予算は50万円です。" },
    ...Array.from({ length: 410 }, (_, i) => ({
      who: "other",
      text: "内容" + i,
    })),
    { who: "other", text: "写真を送ります。" },
    { who: "me", text: "聞こえていない約束", failed: true },
  ];
  const summary = await summarizeHearing(configWith(), lines, [
    "予算",
    "公開日",
  ]);
  assert.equal(summary.items[0].answer, "50万円");
  assert.equal(summary.items[1].answer, "未確認");
  assert.deepEqual(summary.other, []);
  assert.deepEqual(summary.todo, ["写真を送る"]);
  assert(requestBody.messages[1].content.includes("予算は50万円です。"));
  assert(!requestBody.messages[1].content.includes("聞こえていない約束"));
});

test("Initial sends require all three connections; later STT reconnect does not disable speech", () => {
  const { s } = {
    s: {
      ...blankState(),
      active: true,
      page: {
        streams: 1,
        unmuted: 1,
        attached: 1,
        attachedEver: true,
        context: "running",
      },
      voiceState: "ready",
      sttState: "connecting",
    },
  };
  assert.equal(statusView(s).tone, "neutral");
  assert.equal(canSend(s), false);
  s.connectedOnce = true;
  assert.equal(canSend(s), true);
  s.speaking = { preparing: true };
  assert.equal(statusView(s).text, "声を準備しています");
});

test("Hearing completion follows actual playback end, not click or generation", async (t) => {
  const { s, map } = stubSession(t),
    text = s.cfg.hearing[0];
  map.set(await voiceKey(s.cfg, text), {
    chunks: ["AAA="],
    transcript: text,
    seconds: 1,
  });
  await s.say(text, "hearing");
  const id = s.job.id;
  assert.deepEqual(s.s.hearingAsked, []);
  s.pageEvent({ type: "play-start", id });
  assert.deepEqual(s.s.hearingAsked, []);
  s.pageEvent({ type: "play-end", id, elapsed: 1 });
  assert.deepEqual(s.s.hearingAsked, [0]);
});

test("Frame capture downmixes right-channel-only audio instead of losing it", async () => {
  const vm = await import("node:vm"),
    fs = await import("node:fs/promises");
  let Worklet;
  const frames = [];
  class Processor {
    constructor() {
      this.port = { postMessage: (frame) => frames.push(frame) };
    }
  }
  vm.runInNewContext(
    await fs.readFile(new URL("../pcm-worklet.js", import.meta.url), "utf8"),
    {
      AudioWorkletProcessor: Processor,
      sampleRate: 24000,
      Float32Array,
      registerProcessor: (name, cls) => (Worklet = cls),
    },
  );
  const node = new Worklet();
  for (let i = 0; i < 4; i++)
    node.process([[new Float32Array(128), new Float32Array(128).fill(0.5)]]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 480);
  assert(frames[0].every((x) => x === 0.25));
});

test("Voice cache keys cannot collide when style and text contain the separator", async () => {
  const a = await voiceKey({ ...DEFAULTS, style: "a|b" }, "c");
  const b = await voiceKey({ ...DEFAULTS, style: "a" }, "b|c");
  assert.notEqual(a, b);
});

test("Acceptance metrics use the mean of the middle pair for ten rounds and nearest-rank p90", async () => {
  const { median, percentile } = await import("../dev/metrics.mjs");
  const rounds = [1000, 2000, 3000, 4000, 4990, 5100, 6000, 7000, 8000, 9000];
  assert.equal(median(rounds), 5045);
  assert.equal(percentile(rounds, 0.9), 8000);
  assert.equal(median([]), null);
});
