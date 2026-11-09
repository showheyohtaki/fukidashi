import test from "node:test";
import assert from "node:assert/strict";
import { Speaker, int16ToB64 } from "../openai.js";
import { Session, blankState } from "../session.js";
import { configWith } from "../config.js";
import { playbackBufferPlan } from "../audio.js";
import { draftReuse, cleanPageEvent } from "../protocol.js";
import { assessRecording, compareContinuity } from "../dev/acceptance.mjs";
import { t5SeriesReport } from "../dev/t5-report.mjs";

class Socket {
  constructor() {
    this.sent = [];
    this.readyState = 0;
  }
  open() {
    this.readyState = 1;
    this.onopen();
    this.message({ type: "session.updated" });
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  message(m) {
    this.onmessage({ data: JSON.stringify(m) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const created = (ws, id) =>
  ws.message({ type: "response.created", response: { id } });
const done = (ws, id) =>
  ws.message({ type: "response.done", response: { id, status: "completed" } });
const pcm = (ws, id) =>
  ws.message({
    type: "response.output_audio.delta",
    response_id: id,
    delta: int16ToB64(new Int16Array(4800)),
  });
const creates = (ws) => ws.sent.filter((m) => m.type === "response.create");
const flush = () => new Promise(setImmediate);
const waitFor = async (predicate) => {
  for (let i = 0; i < 1000 && !predicate(); i++) await flush();
  assert(predicate(), "asynchronous setup did not settle");
};
function fixture(t) {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1000,
  });
  const pages = [];
  const s = new Session({
    page: (m) => pages.push(m),
    cache: {
      get: async () => null,
      put: async () => {},
      expire: async () => {},
    },
  });
  s.cfg = configWith({ autoFiller: false, prefetchCandidates: 0 });
  s.s = {
    ...blankState(),
    active: true,
    connectedOnce: true,
    sttState: "ready",
    voiceState: "ready",
    preState: "ready",
    page: { streams: 1, unmuted: 1, attachedEver: false, context: "running" },
  };
  for (const name of ["main", "pre"]) {
    s[name] = new Speaker(s.cfg, {}, Socket);
    s[name].connect();
    s[name].ws.open();
  }
  t.after(() => {
    s.s.ended = true;
    s.warmToken = null;
    s.releaseBackground();
    s.main.close();
    s.pre.close();
    s.suggestAbort?.abort();
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
  });
  return { s, pages };
}

test("R5: server ignores cancel and continues old deltas; queued next speech goes only to a replacement socket", async (t) => {
  const { s } = fixture(t),
    speaker = s.main,
    old = speaker.ws;
  const first = speaker.speak("止める文");
  created(old, "old");
  pcm(old, "old");
  speaker.cancelAll();
  t.mock.timers.tick(500);
  assert.equal((await first).status, "cancelled");
  let received = 0;
  const next = speaker.speak("次の文", { pcm: () => received++ });
  // This server never acknowledges cancellation and would ignore any new create.
  for (let i = 0; i < 3; i++) {
    pcm(old, "old");
    t.mock.timers.tick(250);
  }
  assert.equal(
    creates(old).length,
    1,
    "never ask the stuck server for a second response",
  );
  assert.equal(old.readyState, 3);
  assert.equal(received, 0);
  assert.equal(speaker.queue.length, 1);
  t.mock.timers.tick(500);
  speaker.ws.open();
  assert.notEqual(speaker.ws, old);
  assert.equal(creates(speaker.ws).length, 1);
  pcm(old, "old");
  done(old, "old");
  created(speaker.ws, "next");
  pcm(speaker.ws, "next");
  done(speaker.ws, "next");
  assert.equal((await next).status, "completed");
  assert.equal(received, 1);
});

test("R5: cancellation before response.created also drains, and a late created cannot bind to the next job", async (t) => {
  const { s } = fixture(t),
    speaker = s.main,
    ws = speaker.ws;
  const first = speaker.speak("前の文");
  speaker.cancelAll();
  t.mock.timers.tick(500);
  assert.equal((await first).status, "cancelled");
  const next = speaker.speak("次の文");
  created(ws, "old");
  assert.equal(ws.sent.at(-1).response_id, "old");
  done(ws, "old");
  created(ws, "old");
  assert.equal(speaker.current.responseId, null);
  created(ws, "next");
  done(ws, "next");
  assert.equal((await next).status, "completed");
});

test("R5: Esc then 0.5s later uses pre while main is draining; no acknowledgement needed for second speech", async (t) => {
  const { s, pages } = fixture(t);
  await s.say("一つ目の文");
  created(s.main.ws, "old");
  pcm(s.main.ws, "old");
  s.stopSpeaking();
  t.mock.timers.tick(500);
  await s.say("停止した後の別の文");
  const next = s.job;
  assert.equal(next.speaker, s.pre);
  assert.equal(creates(s.main.ws).length, 1);
  created(s.pre.ws, "next");
  pcm(s.pre.ws, "next");
  done(s.pre.ws, "next");
  assert.equal(
    pages.filter((m) => m.type === "pcm" && m.id === next.id).length,
    1,
  );
  s.pageEvent({ type: "play-start", id: next.id });
  s.pageEvent({ type: "play-end", id: next.id, elapsed: 0.2, underrunMs: 0 });
  assert.equal(s.s.speaking, null);
});

test("R5: failure before sending any PCM clears speaking and reports failure immediately, including a buffered partial chunk", async (t) => {
  const { s, pages } = fixture(t);
  for (const withChunk of [false, true]) {
    await s.say("長い文を準備していますが、サーバーが途中で失敗します。");
    const job = s.job;
    created(s.main.ws, "failure");
    if (withChunk) pcm(s.main.ws, "failure");
    s.main.finish("failed", "試験の失敗");
    assert.equal(job.sentChunks || 0, 0);
    assert.equal(s.job, null);
    assert.equal(s.s.speaking, null);
    assert.equal(s.s.lines.at(-1).failed, true);
    assert(s.s.bands.some((b) => b.text.includes("声を送れませんでした")));
    assert.equal(pages.filter((m) => m.type === "pcm").length, 0);
  }
});

test("R5: main and pre both ignore cancellation; foreground takes pre queue and survives its reconnect", async (t) => {
  const { s, pages } = fixture(t);
  const warm = s.synthesizeCached("作り置き", true);
  await waitFor(() => s.pre.current);
  const oldPre = s.pre.ws,
    oldMain = s.main.ws;
  created(oldPre, "warm");
  await s.say("前の文");
  created(oldMain, "old");
  s.stopSpeaking();
  t.mock.timers.tick(500);
  await s.say("直後の新しい文");
  const job = s.job;
  assert.equal(job.speaker, s.pre);
  assert.equal(s.pre.queue.at(-1).text, job.text);
  pcm(oldMain, "old");
  pcm(oldPre, "warm");
  t.mock.timers.tick(1250);
  t.mock.timers.tick(500);
  assert.equal(creates(oldPre).length, 1);
  assert.equal(creates(oldMain).length, 1);
  assert.notEqual(s.pre.ws, oldPre);
  s.pre.ws.open();
  created(s.pre.ws, "new");
  pcm(s.pre.ws, "new");
  done(s.pre.ws, "new");
  assert(pages.some((m) => m.type === "pcm" && m.id === job.id));
  s.pageEvent({ type: "play-start", id: job.id });
  s.pageEvent({ type: "play-end", id: job.id, elapsed: 0.2 });
  assert.equal(s.s.speaking, null);
  assert.equal(await warm, null);
});

test("R5: foreground cancels warmup, new background requests wait, then resume only after playback ends", async (t) => {
  const { s } = fixture(t);
  const warm = s.synthesizeCached("作り置き", true);
  await waitFor(() => s.pre.current);
  created(s.pre.ws, "warm");
  await s.say("打ち込んだ文");
  assert.equal(s.pre.draining.responseId, "warm");
  const later = s.synthesizeCached("後の先読み");
  await flush();
  assert.equal(creates(s.pre.ws).length, 1);
  done(s.pre.ws, "warm");
  assert.equal(await warm, null);
  const job = s.job;
  created(s.main.ws, "fresh");
  pcm(s.main.ws, "fresh");
  done(s.main.ws, "fresh");
  await flush();
  assert.equal(
    creates(s.pre.ws).length,
    1,
    "generation completion alone does not resume background",
  );
  s.pageEvent({ type: "play-start", id: job.id });
  s.pageEvent({ type: "play-end", id: job.id, elapsed: 0.2, underrunMs: 120 });
  await waitFor(() => creates(s.pre.ws).length === 2);
  assert.equal(creates(s.pre.ws).length, 2);
  created(s.pre.ws, "later");
  done(s.pre.ws, "later");
  await later;
  assert.equal(s.s.lines.at(-1).underrunMs, 120);
  assert.equal(s.s.metrics.playbacks.at(-1).underrunMs, 120);
});

test("R6: an unmeasured first chunk waits; generation completion releases any nonempty audio", () => {
  assert.equal(
    playbackBufferPlan("長い文章です", { seconds: 0.2 }).ready,
    false,
  );
  assert.equal(
    playbackBufferPlan("長い文章です", { seconds: 0.1, completed: true }).ready,
    true,
  );
  assert.equal(
    playbackBufferPlan("長い文章です", { seconds: 0, completed: true }).ready,
    false,
  );
  assert.equal(
    cleanPageEvent({ type: "play-end", id: "j", underrunMs: 123 }).underrunMs,
    123,
  );
});

test("R5: partial reuse needs prefix, <=20% suffix, and no added question or negation including split words", () => {
  for (const [draft, final] of [
    [
      "今のホームページはスマホで文字が見づらいん",
      "今のホームページはスマホで文字が見づらいんです。",
    ],
    [
      "お客様は近所の三十代から五十代の方が",
      "お客様は近所の三十代から五十代の方が多いです。",
    ],
    ["予算は五十万円です", "予算は50万円です。"],
  ])
    assert(draftReuse(draft, final).match, final);
  for (const [draft, final] of [
    ["来年の四月までに公開", "来年の四月までに公開したいです。"],
    [
      "写真は今のものをそのまま使っていいです",
      "写真は今のものをそのまま使っていいですか？",
    ],
    [
      "写真は今のものをそのまま使っていいです",
      "写真は今のものをそのまま使っていいです？",
    ],
    ["この形では対応できませ", "この形では対応できません。"],
    ["この形では対応できな", "この形では対応できない。"],
    ["予算は五万円です", "予算は五十万円です。"],
  ])
    assert.equal(draftReuse(draft, final).match, false, final);
  assert(draftReuse("あ".repeat(8), "あ".repeat(10)).match);
  assert.equal(draftReuse("あ".repeat(7), "あ".repeat(10)).match, false);
});

test("R5: relaxed draft remains hidden until final; reuse preserves request and records both transcripts/candidates", async (t) => {
  const { s } = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replies: [
                  "確認します。",
                  "詳しく伺います。",
                  "少しお待ちください。",
                ],
              }),
            },
          },
        ],
      }),
    };
  });
  const draft = "今のホームページはスマホで文字が見づらいん";
  s.s.otherSpeaking = true;
  s.s.lines = [
    { id: "d", who: "other", turn: s.turn, partial: true, text: draft },
  ];
  s.pauseDraftTurn = s.turn;
  s.prepareTentative();
  await flush();
  s.otherEnd();
  assert.equal(s.s.candidates.length, 0);
  s.caption("d", draft + "です。", false, { turn: s.turn });
  await flush();
  assert.equal(calls, 1);
  assert.equal(s.s.candidates.length, 3);
  assert.equal(s.s.metrics.candidateRequests[0].draftText, draft);
  assert.equal(s.s.metrics.candidateRequests[0].finalText, draft + "です。");
  assert.equal(s.s.metrics.candidateBatches[0].reusedDraft, true);
  assert.equal(s.s.metrics.candidateBatches[0].replies.length, 3);
});

test("R5: punctuation-only question forces regeneration even though speech normalization removes punctuation", async (t) => {
  const { s } = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replies: ["確認します。", "伺います。", "お待ちください。"],
              }),
            },
          },
        ],
      }),
    };
  });
  s.s.otherSpeaking = true;
  s.s.lines = [
    {
      id: "d",
      who: "other",
      turn: s.turn,
      partial: true,
      text: "写真は今のものを使っていいです",
    },
  ];
  await s.suggest("pause-draft", "d");
  s.otherEnd();
  s.caption("d", "写真は今のものを使っていいです？", false, { turn: s.turn });
  await flush();
  assert.equal(calls, 2);
  assert.equal(
    s.s.metrics.candidateRequests[0].reuseCheck.reason,
    "question-added",
  );
});

const levels = (quiet) =>
  Array.from({ length: 100 }, (_, i) => ({
    at: i * 20,
    rms: quiet(i) ? 0 : 0.1,
  }));
test("R6: receiver continuity allows natural pauses up to 0.8s; product underrun is independently limited", () => {
  assert(
    compareContinuity(
      levels((i) => i < 5 || i > 94 || (i >= 40 && i < 50)),
      0,
    ).match,
  );
  assert.equal(
    compareContinuity(
      levels((i) => i >= 20 && i < 50),
      0,
    ).match,
    true,
  );
  assert.equal(
    compareContinuity(
      levels((i) => (i >= 10 && i < 25) || (i >= 50 && i < 65)),
      0,
    ).match,
    true,
  );
  assert.equal(compareContinuity([]).match, false);
});
test("R5: either ASR can match, but continuity cannot be excused; failed recordings retain both second attempts", async () => {
  const text = "来週の火曜日、午後二時はいかがですか。";
  const good = { levels: levels(() => false), underrunMs: 0 };
  const a = await assessRecording(text, good, async (model) =>
    model === "whisper-1" ? text : "ご都合はいかがですか",
  );
  assert(a.match);
  assert.equal(a.attempts.length, 2);
  const b = await assessRecording(
    text,
    { levels: levels((i) => i >= 10 && i < 62), underrunMs: 0 }, // 1.04 秒の無音は途切れ
    async () => text,
  );
  assert.equal(b.match, false);
  assert.equal(b.attempts.length, 4);
  const c = await assessRecording(text, good, async (_, round) =>
    round === 1 ? "違う内容" : text,
  );
  assert.equal(c.match, false);
  assert.equal(c.attempts.length, 4);
});

test("R5: three-run report retains failed/missing runs and full candidates, never fabricates their metrics", () => {
  const result = {
    tests: { T5: { status: "fail" } },
    metrics: {
      roundTripMedianMs: 5100,
      roundTripP90Ms: 6500,
      draftReuse: { reused: 6, total: 10 },
      rounds: [
        { round: 1, requestId: "r", roundTripMs: 4900, reusedDraft: true },
      ],
      candidateRequests: [
        {
          id: "r",
          draftText: "途中",
          finalText: "途中です",
          replies: ["候補一", "候補二", "候補三"],
        },
      ],
    },
  };
  const report = t5SeriesReport([result, null, null]);
  assert.equal(report.runs.length, 3);
  assert.equal(report.runs[0].status, "fail");
  assert.equal(report.runs[1].medianMs, null);
  assert.match(report.markdown, /候補一<br>候補二<br>候補三/);
  assert.match(report.markdown, /6\/10/);
  assert.match(report.markdown, /not-run/);
});
