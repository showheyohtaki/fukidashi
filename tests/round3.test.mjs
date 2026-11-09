import test from "node:test";
import assert from "node:assert/strict";
import { Session, blankState } from "../session.js";
import { Speaker } from "../openai.js";
import { voiceKey } from "../cache.js";
import { configWith } from "../config.js";
import { normalizeSpeech, speechMatches } from "../protocol.js";
import {
  checkBuildIdentity,
  recordingBytes,
  compareRecording,
} from "../dev/acceptance.mjs";

class Socket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  message(m) {
    this.onmessage({ data: JSON.stringify(m) });
  }
  open() {
    this.readyState = 1;
    this.onopen();
    this.message({ type: "session.updated" });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const settle = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise(setImmediate);
  }
  assert(fn(), "asynchronous work did not settle");
};
function fixture(t) {
  const pages = [],
    memory = new Map();
  const cache = {
    get: async (k) => memory.get(k),
    put: async (k, v) => memory.set(k, v),
    expire: async () => {},
    clearCandidates: () => memory.clear(),
  };
  const s = new Session({
    cache,
    page: (m) => pages.push(m),
    capture: { stop: async () => {} },
  });
  s.cfg = s.savedCfg = configWith({
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
    page: {
      streams: 1,
      unmuted: 1,
      attached: 0,
      attachedEver: false,
      context: "running",
    },
  };
  for (const name of ["main", "pre"]) {
    s[name] = new Speaker(s.cfg, {}, Socket);
    s[name].connect();
    s[name].ws.open();
  }
  t.after(() => {
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
    s.main.close();
    s.pre.close();
    for (const job of s.jobs.values()) {
      clearTimeout(job.watchdog);
      clearTimeout(job.bufferTimer);
      clearTimeout(job.ackTimer);
      clearTimeout(job.cancelFallback);
    }
  });
  return { s, pages, memory };
}
const pcm1 = btoa("\x00\x01".repeat(2880)),
  pcm2 = btoa("\x00\x02".repeat(2880));
const created = (speaker, id) =>
  speaker.ws.message({ type: "response.created", response: { id } });
const pcm = (speaker, id, audio) =>
  speaker.ws.message({
    type: "response.output_audio.delta",
    response_id: id,
    delta: audio,
  });
const transcript = (speaker, id, delta) =>
  speaker.ws.message({
    type: "response.output_audio_transcript.delta",
    response_id: id,
    delta,
  });
const done = (speaker, id, status = "completed") =>
  speaker.ws.message({ type: "response.done", response: { id, status } });
const creates = (speaker) =>
  speaker.ws.sent.filter((m) => m.type === "response.create").length;

test("R3 C: tap joins buffered and future prefetch PCM exactly once; no main synthesis or duplicate usage", async (t) => {
  let time = 1000;
  t.mock.method(Date, "now", () => time);
  const { s, pages, memory } = fixture(t);
  const text = "予算は五十万円です。";
  const prefetch = s.synthesizeCached(text);
  await settle(() => s.pre.current);
  const tag = s.pre.current.sink.tag;
  created(s.pre, "pre");
  pcm(s.pre, "pre", pcm1);
  transcript(s.pre, "pre", text);
  assert(await s.say(text, "candidate"));
  const job = s.job;
  assert.equal(job.source, "joined");
  assert.equal(job.tag, tag);
  assert.equal(job.speaker, s.pre);
  assert.equal(creates(s.main), 0);
  assert.equal(creates(s.pre), 1);
  assert.deepEqual(
    pages.filter((m) => m.type === "pcm").map((m) => m.audio),
    [], // R5: unmeasured first chunk stays buffered until cadence is known.
  );
  time += 100;
  pcm(s.pre, "pre", pcm2);
  assert.equal(pages.filter((m) => m.type === "pcm").length, 0);
  done(s.pre, "pre");
  assert.deepEqual(
    pages.filter((m) => m.type === "pcm").map((m) => m.audio),
    [pcm1, pcm2],
  );
  s.pageEvent({ type: "play-start", id: job.id });
  await prefetch;
  assert.equal(pages.filter((m) => m.type === "end").length, 1);
  s.pageEvent({ type: "play-end", id: job.id, elapsed: 0.24 });
  assert.equal(s.s.lines.at(-1).mismatch, false);
  assert.equal(s.s.metrics.taps[0].source, "joined");
  assert.equal(s.s.metrics.taps[0].bufferedAudioMs, 120);
  assert.equal(s.s.usage.inputCharacters, text.length);
  assert.equal(s.s.usage.voiceSeconds, 0.24);
  assert.equal(memory.size, 1);
  assert.equal(s.syntheses.size, 0);
  assert(await s.say(text));
  assert.equal(s.job.source, "cached");
  assert.equal(creates(s.main), 0);
  assert.equal(creates(s.pre), 1);
});

test("R3 C: concurrent callers deduplicate by voiceKey, including a tap before first PCM", async (t) => {
  const { s, pages } = fixture(t);
  const a = s.synthesizeCached("まだ音がない文"),
    b = s.synthesizeCached("まだ音がない文");
  await settle(() => s.pre.current);
  assert(await s.say("まだ音がない文"));
  assert.equal(s.job.source, "joined");
  assert.equal(s.job.bufferedChunks, 0);
  assert.equal(creates(s.pre), 1);
  assert.equal(creates(s.main), 0);
  assert.equal(pages.filter((m) => m.type === "pcm").length, 0);
  created(s.pre, "pre");
  pcm(s.pre, "pre", pcm1);
  transcript(s.pre, "pre", "まだ音がない文");
  done(s.pre, "pre");
  const values = await Promise.all([a, b]);
  assert.equal(values[0], values[1]);
  assert.equal(pages.filter((m) => m.type === "pcm").length, 1);
});

test("R3 C: candidate invalidation preserves adopted speech and warmup; Esc cancels adopted tag only", async (t) => {
  const { s, pages, memory } = fixture(t);
  const adopted = s.synthesizeCached("読む候補");
  await settle(() => s.pre.current);
  created(s.pre, "adopted");
  pcm(s.pre, "adopted", pcm1);
  await s.say("読む候補");
  const old = s.job;
  const discarded = s.synthesizeCached("捨てる候補"),
    warm = s.synthesizeCached("定型文", true);
  await new Promise(setImmediate);
  assert.equal(
    s.pre.queue.length,
    0,
    "R5: background generation waits while speaking",
  );
  s.invalidateSuggestion();
  assert.equal(s.pre.current.cancelled, false);
  assert.deepEqual(
    s.pre.queue.map((j) => j.text),
    [],
  );
  s.stopSpeaking();
  assert.equal(s.pre.current.cancelled, true);
  assert.equal(
    s.pre.ws.sent.filter((m) => m.type === "response.cancel").length,
    1,
  );
  assert.equal(s.pre.ws.sent.at(-1).response_id, "adopted");
  assert.equal(
    s.main.ws.sent.filter((m) => m.type === "response.cancel").length,
    0,
  );
  assert(!s.runningSynthesis(await voiceKey(s.cfg, "読む候補")));
  await s.say("読む候補");
  assert.equal(
    s.job.source,
    "fresh",
    "cancelled synthesis must not be rejoined",
  );
  const newer = s.job;
  const count = pages.length;
  pcm(s.pre, "adopted", pcm2);
  done(s.pre, "adopted", "cancelled");
  s.pageEvent({ type: "play-end", id: old.id, stopped: true, elapsed: 0 });
  assert.equal(await adopted, null);
  assert.equal(s.job, newer);
  assert.equal(
    pages.length,
    count,
    "late old chunks/end must not reach new playback",
  );
  assert.equal(memory.size, 0);
  assert.equal(
    s.pre.current,
    null,
    "warmup remains paused for the new utterance",
  );
  created(s.main, "fresh");
  pcm(s.main, "fresh", pcm1);
  transcript(s.main, "fresh", "読む候補");
  done(s.main, "fresh");
  s.pageEvent({ type: "play-start", id: newer.id });
  s.pageEvent({ type: "play-end", id: newer.id, elapsed: 0.12 });
  assert.equal(await discarded, null);
  await settle(() => s.pre.current?.text === "定型文");
  assert.equal(s.pre.current.text, "定型文");
  created(s.pre, "warm");
  pcm(s.pre, "warm", pcm1);
  transcript(s.pre, "warm", "定型文");
  done(s.pre, "warm");
  assert(await warm);
});

test("R3 C: completed synthesis remains joinable during cache write, then leaves no stale entry", async (t) => {
  const { s, pages } = fixture(t);
  let release;
  s.cache.put = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const task = s.synthesizeCached("保存中の文");
  await settle(() => s.pre.current);
  created(s.pre, "pre");
  pcm(s.pre, "pre", pcm1);
  transcript(s.pre, "pre", "保存中の文");
  done(s.pre, "pre");
  await settle(() => release);
  await s.say("保存中の文");
  assert.equal(creates(s.main), 0);
  assert.equal(pages.filter((m) => m.type === "pcm").length, 1);
  assert.equal(pages.filter((m) => m.type === "end").length, 1);
  release();
  await task;
  assert.equal(s.syntheses.size, 0);
});

test("R3 C: candidate generation reports LLM time, tentative readiness and turn-to-candidates delay", async (t) => {
  const { s } = fixture(t);
  let time = 1000,
    resolve;
  t.mock.method(Date, "now", () => time);
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  s.s.lines.push({ who: "other", text: "予算を教えて", partial: false });
  s.s.otherSpeaking = true;
  const complete = () =>
    resolve({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replies: ["はい", "確認します", "伺います"],
              }),
            },
          },
        ],
      }),
    });
  let task = s.suggest();
  time = 1200;
  complete();
  await task;
  time = 1500;
  s.otherEnd();
  assert.equal(s.s.metrics.candidateRequests[0].elapsedMs, 200);
  assert.equal(s.s.metrics.turns[0].tentativeReady, true);
  assert.equal(s.s.metrics.candidateBatches[0].turnToCandidatesMs, 0);
  s.otherStart();
  time = 2000;
  task = s.suggest();
  time = 2300;
  s.otherEnd();
  time = 2600;
  complete();
  await task;
  assert.equal(s.s.metrics.turns[1].tentativeReady, false);
  assert.equal(s.s.metrics.candidateBatches[1].turnToCandidatesMs, 300);
  assert.equal(s.s.metrics.candidateBatches[1].requestElapsedMs, 600);
});

test("R3 D: kanji amounts and dates normalize without changing 一緒 or weakening product mismatch", () => {
  for (const [a, b] of [
    ["五十万円", "50万円"],
    ["一万二千円", "12000円"],
    ["三月", "3月"],
    ["午後二時", "午後2時"],
    ["二億五千万円", "250,000,000円"],
    ["〇万円", "0円"],
  ])
    assert(speechMatches(a, b), `${a} != ${b}`);
  assert.equal(normalizeSpeech("一緒に確認します"), "一緒に確認します");
  assert.equal(
    normalizeSpeech("八王子で一切変更しない"),
    "八王子で一切変更しない",
  );
  assert(!speechMatches("50万円", "51万円"));
  assert(
    !speechMatches("声が届くことを確認します", "これが届くことを確認します"),
  );
});

test("R3 D/E: recordings allow at most 10% character edit distance after number normalization", () => {
  assert(compareRecording("予算は五十万円です。", "予算は50万円です。").match);
  assert(
    compareRecording("あいうえおかきくけこ", "あいうえおかきくけさ").match,
  );
  assert(
    !compareRecording("あいうえおかきくけこ", "あいうえおかきくさし").match,
  );
  assert(!compareRecording("", "").match);
  assert(
    !compareRecording("声が届くことを確認します", "これが届くことを確認します")
      .match,
    "the reported two-character error exceeds 10%; do not silently broaden the limit",
  );
});

test("R3 A/B: stale or missing runtime ID fails setup; empty recording fails before transcription", () => {
  const disk = 'export const BUILD_ID = "current-build";';
  assert(checkBuildIdentity("current-build", disk).match);
  for (const id of [undefined, "old-build"])
    assert.throws(
      () => checkBuildIdentity(id, disk),
      (e) => e.setupFailure === "stale service worker",
    );
  assert.throws(() => recordingBytes({ audio: "" }), /録音が空/);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
  assert.deepEqual(recordingBytes({ audio: webm.toString("base64") }), webm);
});

test("R3 C: invalidation during async cache lookup cannot start obsolete prefetch", async (t) => {
  const { s } = fixture(t);
  let release;
  s.cache.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = s.synthesizeCached("もう使わない候補");
  await settle(() => release);
  s.invalidateSuggestion();
  release(undefined);
  assert.equal(await pending, null);
  assert.equal(creates(s.pre), 0);
  assert.equal(s.syntheses.size, 0);
});
