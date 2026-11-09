import test from "node:test";
import assert from "node:assert/strict";
import {
  Speaker,
  completedReplies,
  suggestReplies,
  int16ToB64,
} from "../openai.js";
import { Session } from "../session.js";
import { configWith } from "../config.js";

class Socket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.closes = 0;
  }
  open() {
    this.readyState = 1;
    this.onopen();
    this.message({ type: "session.updated" });
  }
  message(m) {
    this.onmessage({ data: JSON.stringify(m) });
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closes++;
    this.readyState = 3;
    this.onclose?.();
  }
}
function speaker(t) {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const s = new Speaker(configWith(), {}, Socket);
  s.connect();
  s.ws.open();
  t.after(() => s.close());
  return s;
}
const created = (ws, id) =>
  ws.message({ type: "response.created", response: { id } });
const done = (ws, id, status = "completed") =>
  ws.message({ type: "response.done", response: { id, status } });
const pcm = (ws, id) =>
  ws.message({
    type: "response.output_audio.delta",
    response_id: id,
    delta: "AAA=",
  });
const flush = () => new Promise(setImmediate);

test("R5: UI settles at 0.5s but socket waits for cancellation acknowledgement before sending next speech", async (t) => {
  const s = speaker(t),
    ws = s.ws;
  const first = s.speak("止める文", { tag: "old" });
  created(ws, "old");
  pcm(ws, "old");
  s.cancelAll("old");
  const cancel = ws.sent.at(-1);
  t.mock.timers.tick(500);
  assert.equal((await first).status, "cancelled");
  let received = 0;
  const next = s.speak("次の文", { pcm: () => received++ });
  assert.equal(ws.sent.filter((m) => m.type === "response.create").length, 1);
  assert.equal(s.draining.responseId, "old");
  created(ws, "old"); // Duplicate/late creation must not bind to the new job.
  pcm(ws, "old");
  ws.message({
    type: "error",
    error: {
      event_id: cancel.event_id,
      message: "Cancellation failed: response already finished",
    },
  });
  t.mock.timers.tick(600);
  done(ws, "old", "cancelled");
  assert.equal(s.ws, ws);
  assert.equal(ws.closes, 0);
  assert.equal(received, 0);
  created(ws, "next");
  pcm(ws, "next");
  done(ws, "next");
  assert.equal((await next).status, "completed");
  assert.equal(received, 1);
});

test("R4: a real reconnect preserves queued speech until session.updated", async (t) => {
  const s = speaker(t),
    old = s.ws;
  const first = s.speak("接続前に止める");
  s.cancelAll();
  t.mock.timers.tick(500);
  const next = s.speak("再接続を待つ文");
  s.resetSocket();
  assert.equal((await first).status, "cancelled");
  assert.equal(s.queue.length, 1);
  t.mock.timers.tick(500);
  assert.notEqual(s.ws, old);
  assert.equal(s.ws.sent.length, 0);
  s.ws.open();
  assert.equal(
    s.ws.sent.at(-1).response.input[0].content[0].text,
    "再接続を待つ文",
  );
  created(s.ws, "new");
  pcm(s.ws, "new");
  done(s.ws, "new");
  assert.equal((await next).status, "completed");
});

function session(t) {
  const s = new Session({ cache: { expire: async () => {} } });
  s.cfg = configWith({ prefetchCandidates: 0 });
  s.s.active = true;
  s.s.otherSpeaking = true;
  s.s.lines = [
    {
      id: "caption",
      who: "other",
      text: "予算を教えてください",
      partial: false,
      turn: s.turn,
    },
  ];
  t.after(() => {
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
    s.suggestAbort?.abort();
  });
  return s;
}
function stream(t) {
  let controller,
    calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          controller = c;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const send = (data) => {
    const bytes = new TextEncoder().encode(
      "data: " + JSON.stringify(data) + "\r\n\r\n",
    );
    for (let i = 0; i < bytes.length; i += 7)
      controller.enqueue(bytes.slice(i, i + 7));
  };
  return {
    delta(content) {
      send({ choices: [{ delta: { content } }] });
    },
    finish() {
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
    get calls() {
      return calls;
    },
  };
}

test("R4: streaming publishes complete candidate 1 at turn end, retains same request, and appends 2/3 without replacing it", async (t) => {
  const s = session(t),
    wire = stream(t);
  const pending = s.suggest("caption-final");
  await flush();
  wire.delta('{"replies":["確認いたします。"');
  await flush();
  assert.equal(
    s.s.candidates.length,
    0,
    "tentative candidates wait for VAD turn end",
  );
  s.otherEnd();
  assert.equal(s.s.candidates.length, 1);
  assert.equal(s.s.candidateState, "ready");
  assert.equal(s.s.candidateStreaming, true);
  const first = s.s.candidates[0],
    id = s.s.metrics.candidateBatches[0].id;
  await s.suggest("caption-final");
  assert.equal(
    wire.calls,
    1,
    "unchanged transcript reuses in-flight generation",
  );
  wire.delta(',"時期を伺えますか。","少しお待ちください。"]}');
  wire.finish();
  await pending;
  assert.equal(s.s.candidates.length, 3);
  assert.equal(s.s.candidates[0], first);
  assert.equal(s.s.candidateStreaming, false);
  assert.equal(s.s.metrics.candidateBatches.length, 1);
  assert.equal(s.s.metrics.candidateBatches[0].id, id);
  assert.equal(s.s.metrics.turns[0].tentativeFirstReady, true);
  assert.equal(s.s.metrics.turns[0].tentativeReady, false);
  assert(
    s.s.metrics.candidateRequests[0].firstAt <=
      s.s.metrics.candidateRequests[0].threeAt,
  );
});

test("R4: resumed speech discards remaining old streamed candidates; late final does not revive them", async (t) => {
  const s = session(t),
    wire = stream(t);
  const pending = s.suggest();
  await flush();
  wire.delta('{"replies":["旧候補"');
  await flush();
  s.otherResume();
  wire.delta(',"二つ目","三つ目"]}');
  wire.finish();
  await pending;
  assert.equal(s.tentative, null);
  assert.equal(s.s.candidates.length, 0);
  assert.equal(s.s.metrics.candidateRequests[0].status, "aborted");
});

test("R4: turn end waits for current caption, never generates from previous-turn text", async (t) => {
  const s = session(t);
  let calls = 0;
  s.suggest = () => calls++;
  s.otherEnd();
  assert.equal(calls, 0);
  s.caption("current", "新しい質問です", false, {
    turn: s.turn,
    committedAt: 100,
  });
  assert.equal(calls, 1);
  assert.equal(s.s.metrics.captionFinals.at(-1).committedAt, 100);
});

test("R4: candidate parser emits only complete valid JSON strings, including escaped delimiters", () => {
  assert.deepEqual(completedReplies('{"replies":["未完'), []);
  assert.deepEqual(completedReplies('{"replies":["引用\\\"と、区切り","次'), [
    '引用"と、区切り',
  ]);
  assert.deepEqual(completedReplies('{"replies":["\\u3042"'), ["あ"]);
  assert.throws(() =>
    completedReplies('{"replies":["' + "長".repeat(41) + '"'),
  );
});

test("R4: interrupted ASR verifies only played PCM and rejects invented cutoff words", async (t) => {
  const s = session(t);
  let audio,
    answer = "これからな。";
  t.mock.method(globalThis, "fetch", async (_, opts) => {
    audio = opts.body.get("file");
    return { ok: true, json: async () => ({ text: answer }) };
  });
  const job = {
    text: "これから長い説明をします。",
    chunks: [int16ToB64(new Int16Array(48000))],
    transcript: "これから長い説明をします。",
  };
  assert.equal(await s.transcribePrefix(job, 0.7), "");
  assert.equal(job.prefixVerification.verified, false);
  assert.equal(audio.size, 44 + Math.floor((0.7 - 0.02) * 24000) * 2);
  answer = "これから";
  assert.equal(await s.transcribePrefix(job, 0.7), answer);
  assert.equal(job.prefixVerification.verified, true);
});

test("R4: pause draft stays hidden until final caption matches, then reuses the same completed generation", async (t) => {
  const s = session(t),
    wire = stream(t);
  s.s.lines = [
    {
      id: "draft",
      turn: s.turn,
      who: "other",
      partial: true,
      text: "予算は五十万円です",
    },
  ];
  const pending = s.suggest("pause-draft", "draft");
  await flush();
  wire.delta(
    '{"replies":["予算を承りました。","時期を伺えますか。","確認いたします。"]}',
  );
  wire.finish();
  await pending;
  s.otherEnd();
  assert.equal(
    s.s.candidates.length,
    0,
    "an unconfirmed transcript must not make selectable replies",
  );
  s.caption("draft", "予算は50万円です。", false, { turn: s.turn });
  await flush();
  assert.equal(wire.calls, 1);
  assert.equal(s.s.candidates.length, 3);
  assert.equal(s.s.metrics.candidateRequests[0].reusedDraft, true);
});

test("R4: changed final transcript cancels a pause draft and requests candidates for the corrected text", async (t) => {
  const s = session(t);
  const inputs = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    inputs.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replies: ["承りました。", "確認します。", "伺います。"],
              }),
            },
          },
        ],
      }),
    };
  });
  s.s.lines = [
    {
      id: "draft",
      turn: s.turn,
      who: "other",
      partial: true,
      text: "予算は五万円です",
    },
  ];
  await s.suggest("pause-draft", "draft");
  s.otherEnd();
  s.caption("draft", "予算は五十万円です。", false, { turn: s.turn });
  await flush();
  assert.equal(inputs.length, 2);
  assert(inputs[1].messages.at(-1).content.includes("五十万円"));
  assert.equal(
    s.s.metrics.candidateRequests[0].invalidatedBy,
    "caption-changed",
  );
  assert.equal(s.s.candidates.length, 3);
});

test("R4: prefetch starts with candidate 1 and stays sequential when later streamed candidates arrive", async (t) => {
  const s = session(t),
    wire = stream(t),
    calls = [],
    releases = [];
  s.cfg.prefetchCandidates = 3;
  s.synthesizeCached = (text) => {
    calls.push(text);
    return new Promise((resolve) =>
      releases.push(() => resolve({ chunks: [] })),
    );
  };
  const pending = s.suggest();
  await flush();
  wire.delta('{"replies":["一つ目"');
  await flush();
  assert.deepEqual(calls, ["一つ目"]);
  wire.delta(',"二つ目","三つ目"]}');
  wire.finish();
  await pending;
  assert.deepEqual(calls, ["一つ目"]);
  releases.shift()();
  await flush();
  assert.deepEqual(calls, ["一つ目", "二つ目"]);
  releases.shift()();
  await flush();
  releases.shift()();
  await flush();
  s.otherEnd();
  assert.deepEqual(calls, ["一つ目", "二つ目", "三つ目"]);
  assert(s.s.candidates.every((c) => c.ready));
});
