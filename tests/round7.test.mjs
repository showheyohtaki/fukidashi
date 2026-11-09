import test from "node:test";
import assert from "node:assert/strict";
import {
  observeGeneration,
  generationRate,
  playbackBufferPlan,
  splitSpeech,
} from "../audio.js";
import { Session, blankState } from "../session.js";
import { configWith } from "../config.js";
import { int16ToB64 } from "../openai.js";
import { voiceKey } from "../cache.js";
import {
  recordingBytes,
  assessContent,
  cleanupFailedTest,
} from "../dev/acceptance.mjs";
import { createReceiverRecorder } from "../dev/recorder.mjs";

const text = "あ".repeat(22); // E = 4s
const chunk = (seconds) =>
  int16ToB64(new Int16Array(Math.round(seconds * 24000)));
const microtasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(t) {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1000,
  });
  const pages = [],
    memory = new Map(),
    calls = [];
  const s = new Session({
    page: (m) => pages.push(m),
    cache: {
      get: async (k) => memory.get(k),
      put: async (k, v) => memory.set(k, v),
      expire: async () => {},
    },
  });
  s.cfg = configWith({
    apiKey: "dummy",
    autoFiller: false,
    prefetchCandidates: 0,
  });
  s.s = {
    ...blankState(),
    active: true,
    connectedOnce: true,
    sttState: "ready",
    voiceState: "ready",
    preState: "ready",
    page: { streams: 1, unmuted: 1, context: "running" },
  };
  s.main = s.pre = {
    ready: true,
    speak(text, sink) {
      return new Promise((resolve) => {
        const pcm = [],
          call = { text, sink, resolve };
        call.pcm = (seconds) => {
          const audio = chunk(seconds);
          pcm.push(audio);
          sink.pcm(audio);
        };
        call.end = (status = "completed") => {
          const result = {
            status,
            chunks: pcm,
            transcript: text,
            seconds: pcm.reduce(
              (n, x) => n + Buffer.from(x, "base64").length / 48000,
              0,
            ),
          };
          sink.end(result);
          resolve(result);
        };
        calls.push(call);
      });
    },
    cancelAll(tag) {
      for (const call of calls)
        if (call.sink.tag === tag) call.end("cancelled");
    },
  };
  t.after(() => {
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
  });
  return { s, pages, calls, memory, tick: (ms) => t.mock.timers.tick(ms) };
}

test("R7 fast: measure 300ms of this sentence, exclude first-token delay, then release at r >= 1.2", () => {
  const source = {};
  observeGeneration(source, 0.12, 9000);
  assert.equal(generationRate(source, 9299), null);
  observeGeneration(source, 1.8, 9300);
  assert.equal(generationRate(source, 9300), 6);
  const plan = playbackBufferPlan(text, {
    seconds: source.audioSeconds,
    rate: generationRate(source, 9300),
  });
  assert(plan.ready);
  assert.equal(plan.requiredSeconds, 0.12);
  const short = {};
  observeGeneration(short, 0.12, 0);
  observeGeneration(short, 0.6, 100);
  assert.equal(generationRate(short, 100), null);
  assert(
    Math.abs(generationRate(short, 100, 0) - 6) < 1e-9,
    "completed short sentences retain the measured final rate",
  );
  assert(playbackBufferPlan(text, { seconds: 0.12, rate: 1.2 }).ready);
  assert.equal(
    playbackBufferPlan(text, { seconds: 0.119, rate: 7 }).ready,
    false,
  );
});
test("R7 slow: E=chars/5.5, deficit+.2 with .3 floor; unknown and slow rates cap at 2000ms", () => {
  const p = playbackBufferPlan(text, { seconds: 2, rate: 0.4, waitedMs: 1999 });
  assert.equal(p.expectedSeconds, 4);
  assert.equal(p.requiredSeconds, 2.6);
  assert.equal(p.ready, false);
  assert(playbackBufferPlan(text, { seconds: 2.6, rate: 0.4 }).ready);
  assert.equal(
    playbackBufferPlan(text, { seconds: 0.29, rate: 1.19 }).ready,
    false,
  );
  for (const rate of [0, 0.4, null]) {
    assert(
      playbackBufferPlan(text, { seconds: 0.1, rate, waitedMs: 2000 }).ready,
    );
    assert.equal(
      playbackBufferPlan(text, { seconds: 0, rate, waitedMs: 9000 }).ready,
      false,
    );
  }
  assert(playbackBufferPlan(text, { seconds: 0.05, completed: true }).ready);
});
test("R7 slowdown: cumulative rate updates after bursts and while no more PCM arrives", () => {
  const source = {};
  observeGeneration(source, 0.12, 0);
  observeGeneration(source, 0.6, 300);
  assert.equal(generationRate(source, 300), 2);
  observeGeneration(source, 0.12, 1200);
  assert.equal(generationRate(source, 1200), 0.6);
  const plan = playbackBufferPlan(text, {
    seconds: source.audioSeconds,
    rate: generationRate(source, 1200),
  });
  assert.equal(plan.ready, false);
  assert(Math.abs(plan.requiredSeconds - 1.8) < 1e-9);
  assert(Math.abs(generationRate(source, 1800) - 0.4) < 1e-9);
});
test("R7 fresh: 300ms timer releases a fast burst, records live rate/buffer/latency/underrun once", async (t) => {
  const { s, calls, pages, tick } = fixture(t);
  await s.say(text);
  const job = s.job;
  tick(700);
  calls[0].pcm(0.12);
  tick(100);
  calls[0].pcm(1.8);
  tick(199);
  assert.equal(pages.length, 0);
  tick(1);
  assert.equal(pages.filter((m) => m.type === "pcm").length, 2);
  assert.equal(job.buffering.rate, 6);
  tick(15);
  s.pageEvent({ type: "play-start", id: job.id });
  tick(100);
  calls[0].pcm(1.2);
  calls[0].end();
  s.pageEvent({ type: "play-end", id: job.id, elapsed: 3.12, underrunMs: 50 });
  const m = s.s.metrics.playbacks[0],
    line = s.s.lines[0];
  assert.equal(m.tapToFirstPcmMs, 700);
  assert.equal(m.tapToAudioMs, 1015);
  assert.equal(m.bufferedSeconds, 1.92);
  assert.equal(m.underrunMs, 50);
  assert.equal(m.generations[0].firstPcmMs, 700);
  assert.equal(m.generations[0].status, "completed");
  assert.deepEqual(line.generations, m.generations);
  assert.equal(s.s.metrics.taps.length, 1);
});
test("R7 joined: cap starts at tap, not prefetch; no synthetic speed from replay; cached audio releases immediately", async (t) => {
  const { s, calls, pages, tick, memory } = fixture(t);
  const synthesis = s.synthesizeCached(text);
  await microtasks();
  // voiceKey uses WebCrypto, let its real promise settle without moving the fake clock.
  while (!calls.length) await new Promise(setImmediate);
  calls[0].pcm(0.12);
  tick(3000);
  calls[0].pcm(0.12);
  await s.say(text, "candidate");
  const job = s.job;
  assert.equal(job.source, "joined");
  assert.equal(pages.length, 0);
  tick(1999);
  assert.equal(pages.length, 0);
  tick(1);
  assert.equal(pages.filter((m) => m.type === "pcm").length, 2);
  assert.equal(job.buffering.capped, true);
  assert(Math.abs(job.buffering.rate - 0.024) < 1e-9);
  s.pageEvent({ type: "play-start", id: job.id });
  calls[0].end();
  await synthesis;
  s.pageEvent({ type: "play-end", id: job.id, elapsed: 0.24, underrunMs: 0 });
  assert(memory.has(await voiceKey(s.cfg, text)));
  const before = pages.length;
  await s.say(text);
  assert.equal(s.job.source, "cached");
  assert(pages.slice(before).some((m) => m.type === "pcm"));
  assert.equal(s.job.buffering.waitedMs, 0);
  assert.equal(calls.length, 1);
});
test("R7 cap: no PCM at 2s is not invented audio; a late first chunk plays immediately and Esc prevents timer output", async (t) => {
  const { s, calls, pages, tick } = fixture(t);
  await s.say(text);
  tick(2000);
  assert.equal(pages.length, 0);
  tick(1000);
  calls[0].pcm(0.1);
  assert(pages.some((m) => m.type === "pcm"));
  s.stopSpeaking();
  await microtasks();
  const afterStop = pages.length;
  tick(10000);
  assert.equal(pages.length, afterStop);
});
test("R7 long text: 85 characters at .4x starts within 2s, sequences sentences during playback, preserves one line and PCM order", async (t) => {
  const { s, calls, pages, tick } = fixture(t);
  const long =
    "あ".repeat(20) +
    "。" +
    "い".repeat(20) +
    "。" +
    "う".repeat(20) +
    "。" +
    "え".repeat(20) +
    "。終";
  assert.equal([...long].length, 85);
  await s.say(long);
  const job = s.job;
  calls[0].pcm(0.1);
  for (let i = 0; i < 4; i++) {
    tick(500);
    calls[0].pcm(0.2);
  }
  assert(pages.some((m) => m.type === "pcm"));
  s.pageEvent({ type: "play-start", id: job.id });
  assert.equal(s.s.metrics.taps[0].ms, 2000);
  assert.equal(s.s.speaking.preparing, false);
  calls[0].end();
  await microtasks();
  assert.equal(calls.length, 2);
  assert.equal(pages.filter((m) => m.type === "end").length, 0);
  for (let i = 1; i < 5; i++) {
    assert.equal(calls.length, i + 1, "sequential synthesis, never concurrent");
    // Continuously progressing synthesis can exceed 20s overall.
    for (let j = 0; j < 12; j++) {
      tick(500);
      calls[i].pcm(0.2);
    }
    calls[i].end();
    await microtasks();
  }
  assert.equal(calls.map((c) => c.text).join(""), long);
  assert.equal(pages.filter((m) => m.type === "end").length, 1);
  assert.equal(job.cancelled, false);
  assert.deepEqual(
    pages.filter((m) => m.type === "pcm").map((m) => m.audio),
    job.chunks,
  );
  s.pageEvent({
    type: "play-end",
    id: job.id,
    elapsed: job.audioSeconds,
    underrunMs: 0,
  });
  assert.equal(s.s.lines.length, 1);
  assert.equal(s.s.lines[0].text, long);
  assert.equal(s.s.lines[0].generations.length, 5);
  assert.equal(s.s.lines[0].mismatch, false);
});
test("R7 watchdog: before release, last PCM resets idle deadline; a page ignoring released audio fails separately", async (t) => {
  const { s, calls, pages, tick } = fixture(t);
  await s.say(text);
  const job = s.job;
  // Simulate a buffer that is still holding data; isolate the idle watchdog
  // from the independently tested release cap and page acknowledgement.
  s.flushSpeech = () => {};
  tick(19000);
  calls[0].pcm(0.1);
  tick(19000);
  calls[0].pcm(0.1);
  assert.equal(job.cancelled, false);
  assert.equal(pages.length, 0);
  tick(20000);
  assert.equal(job.cancelled, true);
  await microtasks();
  s.flushSpeech = Session.prototype.flushSpeech;
  await s.say("次の文");
  calls.at(-1).pcm(0.2);
  calls.at(-1).end();
  const next = s.job;
  tick(4999);
  assert.equal(next.cancelled, false);
  tick(1);
  assert.equal(next.cancelled, true);
});
test("R7 split: short multi-sentence stays intact; >40 splits on Japanese sentence punctuation, retains closers/decimals/no-punctuation", () => {
  assert.deepEqual(splitSpeech("はい。承知しました。"), [
    "はい。承知しました。",
  ]);
  const long = "「" + "あ".repeat(45) + "。」次は1.25万円です。最後です";
  assert.deepEqual(splitSpeech(long), [
    "「" + "あ".repeat(45) + "。」",
    "次は1.25万円です。",
    "最後です",
  ]);
  assert.deepEqual(splitSpeech("あ".repeat(85)), ["あ".repeat(85)]);
});
test("R7 long cancellation/failure: does not generate later sentences or credit a complete line", async (t) => {
  const { s, calls, tick } = fixture(t);
  const long = "長".repeat(42) + "。次の文。";
  await s.say(long);
  const job = s.job;
  calls[0].pcm(0.1);
  tick(2000);
  s.pageEvent({ type: "play-start", id: job.id });
  s.transcribePrefix = async () => "";
  s.stopSpeaking();
  s.pageEvent({ type: "play-end", id: job.id, stopped: true, elapsed: 0.1 });
  await microtasks();
  assert.equal(calls.length, 1);
  assert.equal(s.s.lines[0].interrupted, true);
  await s.say(long);
  calls[1].end("failed");
  await microtasks();
  assert.equal(calls.length, 2);
  assert.equal(s.s.speaking, null);
  assert.equal(s.s.lines.at(-1).failed, true);
});

const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
test("R7 recording: replacing/aborting a recorder waits for stop and late fragments stay in its private array", async () => {
  const instances = [];
  class Recorder {
    constructor() {
      this.state = "inactive";
      instances.push(this);
    }
    start() {
      this.state = "recording";
      this.ondataavailable({ data: new Blob([ebml]) });
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob(["tail"]) });
        this.onstop();
      });
    }
  }
  const recorder = createReceiverRecorder({
    getStream: () => ({}),
    resetStats: () => {},
    stats: () => ({ onset: 1 }),
    Recorder,
  });
  await recorder.start();
  const old = instances[0];
  await recorder.start();
  assert.equal(old.state, "inactive");
  old.ondataavailable({ data: new Blob(["stale fragment"]) });
  const record = await recorder.finish();
  assert.deepEqual(
    recordingBytes(record),
    Buffer.concat([Buffer.from(ebml), Buffer.from("tail")]),
  );
  assert.equal(recorder.isRecording(), false);
  assert.equal(await recorder.finish(), null);
  await recorder.abort();
  await recorder.start();
  await recorder.abort();
  assert.equal(instances.at(-1).state, "inactive");
});
test("R7 failed-test cleanup: abort still runs if stop fails; the next recording starts cleanly", async () => {
  const actions = [];
  const errors = await cleanupFailedTest(
    async () => {
      actions.push("stop");
      throw new Error("lost page");
    },
    async () => {
      actions.push("abort");
    },
  );
  assert.deepEqual(actions, ["stop", "abort"]);
  assert.deepEqual(errors, [{ step: "stop-playback", error: "lost page" }]);
});
test("R7 corrupt recording: reject missing/misplaced EBML before ASR, retain diagnostic code distinct from HTTP400", async () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.concat([Buffer.alloc(1948), ebml]),
  ]) {
    let apiCalls = 0;
    const record = { audio: bytes.toString("base64") };
    const result = await assessContent("本文", async () => {
      recordingBytes(record);
      apiCalls++;
      return "本文";
    });
    assert.equal(result.match, false);
    assert.equal(result.failure, "recording-corrupt");
    assert.equal(result.attempts.length, 1);
    assert.equal(
      result.attempts[0].recording.ebmlOffset,
      bytes.length ? 1948 : -1,
    );
    assert.equal(apiCalls, 0);
  }
  const result = await assessContent("本文", async () => {
    const e = new Error("recording transcription HTTP 400");
    e.code = "transcription-http";
    e.httpStatus = 400;
    throw e;
  });
  assert.equal(result.attempts.length, 4);
  assert.equal(result.attempts[0].code, "transcription-http");
  assert.equal(result.attempts[0].httpStatus, 400);
});
