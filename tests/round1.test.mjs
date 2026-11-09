import test from "node:test";
import assert from "node:assert/strict";
import { Speaker, Transcriber, suggestReplies } from "../openai.js";
import { Session, blankState } from "../session.js";
import { configWith } from "../config.js";
import {
  statusDetails,
  summaryPeriod,
  summaryHeading,
} from "../ui/presentation.js";
import { statusView, canSend } from "../protocol.js";
class Socket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.message({ type: "session.updated" });
  }
  message(m) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  send(s) {
    const m = JSON.parse(s);
    this.sent.push(m);
    if (this.ack && m.type === "session.update")
      this.message({ type: "session.updated" });
  }
  close() {
    this.readyState = 3;
    if (!this.halfOpen) this.onclose?.();
  }
}
function clock(t) {
  let now = 1000,
    id = 0;
  const timers = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (fn, ms = 0) => {
    timers.set(++id, { fn, at: now + ms });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (i) => timers.delete(i));
  t.mock.method(globalThis, "setInterval", (fn, ms) => {
    timers.set(++id, { fn, at: now + ms, ms });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (i) => timers.delete(i));
  return {
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        if (next[1].ms)
          timers.set(next[0], { ...next[1], at: now + next[1].ms });
        next[1].fn();
      }
      now = until;
    },
  };
}
function session(t) {
  const events = [],
    messages = [],
    memory = new Map();
  const cache = {
    open: async () => {},
    expire: async () => {},
    clearLogs: async () => {},
    clearCandidates: () => {},
    clearVoices: async () => memory.clear(),
    get: async (k) => memory.get(k),
    put: async (k, v) => memory.set(k, v),
  };
  const s = new Session({
    cache,
    emit: (m) => events.push(m),
    page: (m) => messages.push(m),
    capture: { stop: async () => {} },
  });
  s.cfg = configWith({ apiKey: "old", autoFiller: false });
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
    s.stt?.close();
    s.main?.close();
    s.pre?.close();
    for (const j of s.jobs.values()) {
      clearTimeout(j.watchdog);
      clearTimeout(j.bufferTimer);
      clearTimeout(j.ackTimer);
    }
  });
  return { s, events, messages, memory };
}
test("R1 H3: three failures turn red but reconnects continue at 4s/8s and recover after 30s", (t) => {
  const c = clock(t),
    states = [];
  const stt = new Transcriber(
    configWith({ apiKey: "dummy" }),
    { onState: (s, d, i) => states.push([s, i]) },
    Socket,
  );
  stt.connect();
  for (const delay of [500, 1000, 2000, 4000, 8000, 8000, 8000]) {
    const old = stt.ws;
    old.close();
    c.advance(delay);
    assert.notEqual(stt.ws, old);
  }
  assert(states.some(([s]) => s === "failed"));
  assert(states.some(([, i]) => i?.attempt >= 4));
  stt.ws.open();
  assert.equal(stt.ready, true);
  assert.equal(stt.retry, 0);
  stt.close();
});
test("R1 H3: half-open commit resets without onclose; acknowledged long speech stays connected", (t) => {
  const c = clock(t);
  const stt = new Transcriber(configWith(), {}, Socket);
  stt.connect();
  stt.ws.open();
  let ws = stt.ws;
  ws.halfOpen = true;
  stt.append(new Int16Array(4800));
  stt.commit();
  c.advance(10000);
  assert.equal(stt.ready, false);
  c.advance(500);
  assert.notEqual(stt.ws, ws);
  ws = stt.ws;
  ws.ack = true;
  ws.open();
  stt.append(new Int16Array(4800));
  c.advance(20000);
  assert.equal(stt.ws, ws);
  assert.equal(stt.ready, true);
  assert(ws.sent.filter((x) => x.type === "session.update").length >= 3);
  stt.close();
});
test("R1 M1: observed page status never cancels the extension synthesis; navigation does", (t) => {
  clock(t);
  const { s, messages } = session(t);
  let cancel = 0;
  const job = {
    id: "job",
    speaker: { cancelAll: () => cancel++ },
    result: null,
  };
  s.job = job;
  s.jobs.set(job.id, job);
  s.pageEvent({
    type: "status",
    streams: 0,
    unmuted: 0,
    attached: 0,
    context: "suspended",
  });
  assert.equal(cancel, 0);
  assert(!messages.some((x) => x.type === "stop"));
  s.navigation(true);
  assert.equal(cancel, 1);
  assert(messages.some((x) => x.type === "stop"));
});
test("R1 M2/M3: replacing an invalid key reconnects with new key, deletes lost partials, keeps completed captions", async (t) => {
  clock(t);
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = originalSocket;
  });
  const { s } = session(t);
  s.makeTranscriber();
  s.stt.ws.open();
  s.stt.append(new Int16Array(4800));
  s.stt.commit();
  s.stt.ws.message({
    type: "input_audio_buffer.committed",
    item_id: "partial",
  });
  s.stt.ws.message({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "partial",
    delta: "途中",
  });
  s.s.lines.push({
    id: "complete",
    who: "other",
    text: "確定",
    partial: false,
  });
  s.connection("stt", "failed", "arbitrary localized text", {
    code: "invalid_api_key",
  });
  assert.equal(s.s.keyError, true);
  const old = s.stt;
  await s.updateConfig({ ...s.cfg, apiKey: "new", voice: "cedar" });
  assert.notEqual(s.stt, old);
  assert.equal(s.cfg.apiKey, "new");
  assert.equal(s.cfg.voice, "marin");
  for (const client of [s.stt, s.main, s.pre])
    assert.equal(client.cfg.apiKey, "new");
  assert.equal(s.s.keyError, false);
  assert(!s.s.lines.some((l) => l.id === "partial"));
  assert(s.s.lines.some((l) => l.id === "complete"));
});
test("R1 M5: invalidating candidate jobs preserves active fixed-phrase prewarm", async (t) => {
  clock(t);
  const speaker = new Speaker(configWith(), {}, Socket);
  speaker.connect();
  speaker.ws.open();
  const warm = speaker.speak("warm", { tag: "warm" }),
    candidate = speaker.speak("candidate", { tag: "candidate" });
  speaker.cancelAll("candidate");
  assert.equal((await candidate).status, "cancelled");
  assert.equal(speaker.current.text, "warm");
  assert(!speaker.current.cancelled);
  speaker.ws.message({ type: "response.created", response: { id: "warm-id" } });
  speaker.ws.message({
    type: "response.done",
    response: { id: "warm-id", status: "completed" },
  });
  assert.equal((await warm).status, "completed");
  speaker.close();
  const { s } = session(t);
  s.warmToken = "warm";
  s.pre = { cancelAll: (tag) => assert.equal(tag, "candidate"), close() {} };
  s.otherStart();
  assert.equal(s.warmToken, "warm");
});
test("R1 M7: progress and ticks send small patches, never clone 1000 caption rows", (t) => {
  const c = clock(t);
  const { s, events } = session(t);
  s.s.lines = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    text: "long meeting",
  }));
  s.job = { id: "job" };
  s.jobs.set("job", s.job);
  s.s.speaking = { id: "job", text: "read" };
  s.s.waitSince = Date.now();
  for (let i = 0; i < 20; i++) {
    s.pageEvent({
      type: "play-progress",
      id: "job",
      level: 0.3,
      elapsed: i / 10,
    });
    c.advance(100);
  }
  assert(events.length > 0);
  assert(events.every((e) => e.type === "progress" && !("lines" in e.patch)));
  assert(!events.some((e) => e.type === "snapshot"));
});
test("R1 M8: all public send routes reject muted and detached microphone before cache/synthesis", async (t) => {
  clock(t);
  const { s, messages } = session(t);
  s.s.candidates = [{ text: "candidate" }];
  for (const field of ["unmuted", "attached"]) {
    s.s.page[field] = 0;
    assert.equal(canSend(s.s), false);
    for (const command of [
      "say",
      "quick",
      "intro",
      "pickCandidate",
      "sheetSay",
    ]) {
      assert.equal(
        await s.command({ command, index: 0, text: "read", tab: "hearing" }),
        false,
        command,
      );
    }
    s.s.page[field] = 1;
  }
  assert.equal(messages.length, 0);
  assert.equal(s.job, null);
});
test("R1 L1: HTML 502 and malformed success JSON produce only safe localized error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 502,
    json: () => {
      throw new SyntaxError("secret HTML");
    },
  }));
  await assert.rejects(
    suggestReplies(configWith(), []),
    (e) => !e.message.includes("HTML") && e.message.includes("接続"),
  );
  globalThis.fetch = async () => ({
    ok: true,
    json: () => {
      throw new SyntaxError("secret HTML");
    },
  });
  await assert.rejects(
    suggestReplies(configWith(), []),
    (e) => !e.message.includes("HTML") && e.message.includes("回答"),
  );
});
test("R1 visual: overlap detail, simultaneous typing/filler, six-second alert and summary labels", () => {
  const s = {
    ...blankState(),
    page: { streams: 1, unmuted: 1, attached: 1 },
    active: true,
    connectedOnce: true,
    sttState: "ready",
    voiceState: "ready",
    waitSince: 1000,
    typingAt: 0,
  };
  assert.equal(statusView(s, 8000).icon, "earAlert");
  assert.equal(statusDetails(s, 8000)[0].text, "相づちで間をつなげます");
  s.typingAt = 7500;
  s.fillerAt = 7500;
  assert.equal(statusDetails(s, 8000).length, 2);
  s.speaking = { text: "message" };
  s.otherSpeaking = true;
  assert.deepEqual(statusDetails(s, 8000), [{ text: "Esc で止められます" }]);
  assert.match(summaryPeriod(1000, 2521000), /42 分/);
  assert.equal(summaryHeading("ご予算の目安を教えてください。"), "予算の目安");
});
test("R1 L2: main reconnecting uses an already-ready pre connection without queueing on main", async (t) => {
  clock(t);
  const { s } = session(t);
  let used = false;
  s.s.voiceState = "reconnecting";
  s.s.preState = "ready";
  s.main = {
    ready: false,
    close() {},
    speak() {
      assert.fail("must not wait on main");
    },
  };
  s.pre = {
    ready: true,
    close() {},
    cancelAll() {},
    speak: async () => {
      used = true;
      return { status: "failed", chunks: [], transcript: "" };
    },
  };
  assert.equal(await s.say("予備の接続"), true);
  assert(used);
});
test("R1 L6: inactive voice/style change clears obsolete persistent voices", async (t) => {
  clock(t);
  const { s, memory } = session(t);
  memory.set("old-voice", "audio");
  s.s.active = false;
  s.makeSpeakers = () => {};
  s.prewarm = () => Promise.resolve();
  await s.updateConfig({ ...s.cfg, voice: "cedar" });
  assert.equal(memory.size, 0);
});

test("R2 M1: stopped playback cancels only its tagged generation once and clears speaking within 500ms without response.done", async (t) => {
  const c = clock(t);
  const { s } = session(t);
  const cancelled = [];
  s.main = {
    ready: true,
    speak: (text, sink) => {
      s.sink = sink;
      return new Promise(() => {});
    },
    cancelAll: (tag) => cancelled.push(tag),
    close() {},
  };
  await s.say("読み上げを途中で止めます");
  const id = s.job.id;
  assert.equal(s.sink.tag, id);
  s.pageEvent({
    type: "status",
    streams: 1,
    unmuted: 0,
    attached: 0,
    attachedEver: true,
    context: "running",
  });
  assert.deepEqual(cancelled, []);
  s.pageEvent({ type: "play-end", id, stopped: true, elapsed: 0 });
  s.pageEvent({ type: "play-end", id, stopped: true, elapsed: 0 });
  assert.deepEqual(cancelled, [id]);
  c.advance(499);
  assert(s.s.speaking);
  c.advance(1);
  assert.equal(s.s.speaking, null);
  assert.equal(s.jobs.size, 0);
  // A late server completion cannot resurrect the cancelled job.
  s.sink.end({
    status: "completed",
    transcript: "読み上げを途中で止めます",
    seconds: 1,
  });
  assert.equal(s.s.speaking, null);
});
test("R2 M1: late old playback stop and fallback do not cancel or clear the newer speech", async (t) => {
  const c = clock(t);
  const { s } = session(t);
  const cancelled = [];
  s.main = {
    ready: true,
    speak: () => new Promise(() => {}),
    cancelAll: (tag) => cancelled.push(tag),
    close() {},
  };
  await s.say("古い文");
  const old = s.job.id;
  await s.say("新しい文");
  const current = s.job.id;
  s.pageEvent({ type: "play-end", id: old, stopped: true, elapsed: 0 });
  c.advance(500);
  assert.deepEqual(cancelled, [old]);
  assert.equal(s.s.speaking.id, current);
  assert.equal(s.jobs.has(old), false);
});
test("R2 M2: local microphone keeps feeding and has no meeting band after streams=0 for over 3 seconds", (t) => {
  const c = clock(t);
  const { s } = session(t);
  let fed = 0;
  s.s.startedAt = Date.now();
  s.s.page.streams = 0;
  s.vad = { feed: () => fed++ };
  s.cfg.useLocalMic = true;
  s.feed(new Int16Array(480));
  c.advance(5000);
  s.feed(new Int16Array(480));
  assert.equal(fed, 2);
  assert(!s.s.bands.some((b) => b.id === "meeting"));
  s.cfg.useLocalMic = false;
  s.feed(new Int16Array(480));
  c.advance(3000);
  s.feed(new Int16Array(480));
  assert.equal(fed, 3, "meeting capture still stops when streams stay absent");
  assert(s.s.bands.some((b) => b.id === "meeting"));
});
test("R2 M3: stopping an inactive session does not end it or request a summary", async (t) => {
  clock(t);
  const { s } = session(t);
  let summaries = 0;
  s.s.active = false;
  s.summarize = async () => summaries++;
  await s.stop();
  assert.equal(summaries, 0);
  assert.equal(s.s.ended, false);
  s.s.active = true;
  await s.stop();
  assert.equal(summaries, 1);
  await s.stop();
  assert.equal(summaries, 1, "duplicate stop cannot summarize again");
});
test("R2 H1/L1: WASM reaches connectedOnce; navigation pause clears the ready indicator", (t) => {
  clock(t);
  const { s } = session(t);
  s.s.connectedOnce = false;
  s.s.page.attached = 0;
  s.s.page.attachedEver = false;
  s.publish();
  assert.equal(s.s.connectedOnce, true);
  assert.equal(canSend(s.s), true);
  s.navigation(true);
  assert.equal(s.s.sttState, "idle");
});
test("R2 L2: idle Speaker probes at 5s, replaces a half-open socket at 10s, and clears its timer on close", (t) => {
  const c = clock(t);
  const speaker = new Speaker(configWith(), {}, Socket);
  speaker.connect();
  let ws = speaker.ws;
  ws.open();
  ws.halfOpen = true;
  c.advance(5000);
  assert.equal(ws.sent.filter((m) => m.type === "session.update").length, 2);
  c.advance(5000);
  assert.equal(speaker.ready, false);
  c.advance(500);
  assert.notEqual(speaker.ws, ws);
  ws = speaker.ws;
  ws.ack = true;
  ws.open();
  c.advance(20000);
  assert.equal(speaker.ws, ws);
  assert.equal(speaker.ready, true);
  speaker.close();
  assert.equal(speaker.activityTimer, null);
});

test("R2 L2: idle heartbeat does not interrupt a normally streaming long response", async (t) => {
  const c = clock(t);
  const speaker = new Speaker(configWith(), {}, Socket);
  speaker.connect();
  const ws = speaker.ws;
  ws.open();
  const speaking = speaker.speak("長い文");
  ws.message({ type: "response.created", response: { id: "response" } });
  for (let i = 0; i < 4; i++) {
    c.advance(6000);
    ws.message({
      type: "response.output_audio.delta",
      response_id: "response",
      delta: btoa("\0".repeat(4800)),
    });
  }
  assert.equal(speaker.ws, ws);
  assert.equal(speaker.ready, true);
  assert.equal(ws.sent.filter((m) => m.type === "session.update").length, 1);
  ws.message({
    type: "response.done",
    response: { id: "response", status: "completed" },
  });
  assert.equal((await speaking).status, "completed");
  speaker.close();
});
