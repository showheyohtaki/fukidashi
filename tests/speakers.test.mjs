import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  SpeakerTimeline,
  speakerName,
  captionSpeaker,
  lineSpeaker,
} from "../speakers.js";
import { Session } from "../session.js";
import { configWith, DEFAULTS, defaultIntro } from "../config.js";
import { cleanPageEvent } from "../protocol.js";
import { VAD } from "../vad.js";
import { summaryHeading } from "../ui/presentation.js";
import { suggestReplies, summarizeHearing, transcript } from "../openai.js";

test("speaker duration: longest speaker wins, overlap ties/unknown/stale/brief flashes stay unnamed", () => {
  const timeline = new SpeakerTimeline();
  for (const [at, names] of [
    [1000, ["佐藤"]],
    [1500, ["佐藤"]],
    [2000, ["田中"]],
    [2500, []],
  ])
    timeline.add({ at, names }, at);
  assert.equal(timeline.dominant(1000, 2500), "佐藤");
  assert.equal(timeline.dominant(1500, 2500), "");
  assert.equal(timeline.dominant(2000, 2500), "田中");
  assert.equal(timeline.dominant(2500, 4000), "");
  assert.equal(timeline.dominant(2000, 2100), "");
  timeline.clear();
  timeline.add({ at: 1000, names: ["佐藤", "田中"] }, 1000);
  assert.equal(timeline.dominant(1000, 2000), "");
  assert.equal(timeline.dominant(2500, 4000), "");
  timeline.add({ at: 900, names: ["古い"] }, 1000);
  timeline.add({ at: 999999, names: ["未来"] }, 1000);
  assert.equal(timeline.samples.length, 1);
});

test("speaker event boundary: no IDs/config, self/bots rejected, invalid events ignored", () => {
  const event = cleanPageEvent({
    type: "speakers",
    at: 1000,
    names: ["佐藤", "佐藤", "Notta Bot", "あなた", "鈴木 (You)"],
    id: "private-id",
    apiKey: "never",
  });
  assert.deepEqual(event, { type: "speakers", at: 1000, names: ["佐藤"] });
  assert.equal(cleanPageEvent({ type: "speakers", at: NaN, names: [] }), null);
  assert.equal(
    cleanPageEvent({ type: "speakers", at: 1000, names: [{}] }),
    null,
  );
  assert.equal(
    cleanPageEvent({ type: "speakers", at: 1000, names: ["a".repeat(101)] }),
    null,
  );
  assert.equal(speakerName("田中\n営業"), "田中 営業");
  assert.equal(speakerName("田中’s Notetaker"), "");
});

test("VAD timestamps follow original captured frames through preroll, silence and continuous splits", () => {
  const chunks = [],
    vad = new VAD({ onCommit: (meta) => chunks.push(meta) });
  for (let i = 1; i <= 1650; i++)
    vad.feed(new Int16Array(480).fill(i <= 1550 ? 2000 : 0), 1000 + i * 20);
  assert(chunks.length >= 3);
  assert.equal(chunks[0].audioStartedAt, 1000);
  for (const chunk of chunks)
    assert(
      Math.abs(
        chunk.audioEndedAt - chunk.audioStartedAt - chunk.seconds * 1000,
      ) < 0.001,
    );
  for (let i = 1; i < chunks.length; i++)
    assert.equal(chunks[i].audioStartedAt, chunks[i - 1].audioEndedAt);
});

function session(t) {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1000,
  });
  const s = new Session({
    cache: { clearLogs: async () => {}, expire: async () => {} },
  });
  s.s.active = true;
  s.prepareTentative = () => {};
  s.suggest = () => {};
  return s;
}
test("Session freezes attribution per chunk before delayed/out-of-order STT, survives panel snapshots", (t) => {
  const s = session(t);
  s.pageEvent({ type: "speakers", at: 1000, names: ["佐藤"] });
  t.mock.timers.tick(500);
  s.pageEvent({ type: "speakers", at: 1500, names: ["田中"] });
  const first = s.captionMetadata({
    audioStartedAt: 1000,
    audioEndedAt: 1500,
    order: 1,
  });
  t.mock.timers.tick(500);
  const second = s.captionMetadata({
    audioStartedAt: 1500,
    audioEndedAt: 2000,
    order: 2,
  });
  s.speakerTimeline.clear();
  s.caption("second", "来月です。", false, second);
  s.caption("first", "予算は", true, first);
  s.caption("first", "予算は50万円です。", false, first);
  assert.deepEqual(
    s.snapshot().lines.map((l) => l.speaker),
    ["佐藤", "田中"],
  );
  assert.equal(
    transcript(s.s.lines),
    "佐藤: 予算は50万円です。\n田中: 来月です。",
  );
  assert.equal(captionSpeaker(s.s.lines[0], null), "佐藤");
  assert.equal(captionSpeaker(s.s.lines[0], s.s.lines[0]), "");
  assert.equal(lineSpeaker({ who: "me", speaker: "佐藤" }), "自分");
});
test("OFF stops attribution immediately and late STT cannot resurrect old names after re-enable", async (t) => {
  const s = session(t);
  s.pageEvent({ type: "speakers", at: 1000, names: ["佐藤"] });
  const old = s.captionMetadata({ audioStartedAt: 1000, audioEndedAt: 1500 });
  s.caption("old", "先ほどの話", false, old);
  await s.updateConfig({ showSpeakerNames: false });
  assert(!s.s.lines[0].speaker);
  s.pageEvent({ type: "speakers", at: 1001, names: ["佐藤"] });
  assert.equal(s.speakerTimeline.samples.length, 0);
  await s.updateConfig({ showSpeakerNames: true });
  s.caption("late", "遅れて届いた話", false, old);
  assert(!s.s.lines[1].speaker);
  s.navigation(true);
  s.pageEvent({ type: "speakers", at: 1000, names: ["佐藤"] });
  assert.equal(s.speakerTimeline.samples.length, 0);
});

const oldHearing = [
  "今回ご相談いただいたきっかけを教えてください。",
  "今、困っていることはありますか。",
  "どのようなことを実現したいですか。",
  "ご予算の目安を教えてください。",
  "ご希望の時期はありますか。",
  "ほかにご担当の方はいらっしゃいますか。",
  "次の進め方について、ご希望はありますか。",
];
test("B: migrate only an exact old default list; preserve edits, deletion, order and idempotence", () => {
  assert.deepEqual(
    configWith({ hearing: oldHearing }).hearing,
    DEFAULTS.hearing,
  );
  for (const hearing of [
    [...oldHearing, "追加"],
    oldHearing.slice(1),
    [...oldHearing].reverse(),
    [],
    oldHearing.map((q, i) => (i === 1 ? "業務の内容を教えてください。" : q)),
  ])
    assert.deepEqual(configWith({ hearing }).hearing, hearing);
  assert.deepEqual(
    configWith(configWith({ hearing: oldHearing })),
    configWith({ hearing: oldHearing }),
  );
  assert.equal(configWith().showSpeakerNames, true);
  assert.equal(configWith({ showSpeakerNames: false }).showSpeakerNames, false);
  assert.deepEqual(DEFAULTS.hearing.map(summaryHeading), [
    "今回のきっかけ",
    "いま困っていること",
    "実現したいこと",
    "予算の目安",
    "希望の時期",
    "担当する方",
    "次の進め方",
  ]);
  assert(
    DEFAULTS.hearing.every(
      (q) => q.endsWith("いただけますでしょうか。") && [...q].length <= 45,
    ),
  );
  assert.equal(
    configWith({ intro: "私の挨拶", introEdited: true }).intro,
    "私の挨拶",
  );
  assert.match(defaultIntro("佐藤"), /佐藤と申します/);
});

test("B/A: both reply prompts require customer-facing honorifics and include display names", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replies: [
                  "承知いたしました。",
                  "詳しく教えていただけますでしょうか。",
                  "確認のうえ、ご連絡いたします。",
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  for (const concise of [true, false])
    await suggestReplies(
      configWith(),
      [{ who: "other", speaker: "佐藤", text: "予算についてです。" }],
      [],
      undefined,
      undefined,
      undefined,
      { concise, latest: concise },
    );
  for (const body of bodies) {
    assert.match(body.messages[0].content, /初対面のお客様/);
    assert.match(body.messages[0].content, /いただけますでしょうか/);
    assert.match(body.messages[1].content, /佐藤: 予算についてです。/);
  }
});

test("A summary: speaker-prefixed evidence labels answers/notes/tasks; unsupported facts rejected", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      question: "予算",
                      answer: "50万円",
                      evidence: "佐藤: 予算は50万円です。",
                    },
                  ],
                  other: [
                    {
                      text: "予算の確認",
                      evidence: "佐藤: 予算は50万円です。",
                    },
                  ],
                  todo: [
                    { text: "写真を送る", evidence: "田中: 写真を送ります。" },
                    { text: "約束", evidence: "存在しない発言" },
                  ],
                }),
              },
            },
          ],
        }),
      ),
  );
  const result = await summarizeHearing(
    configWith(),
    [
      { who: "other", speaker: "佐藤", text: "予算は50万円です。" },
      { who: "other", speaker: "田中", text: "写真を送ります。" },
    ],
    ["予算"],
  );
  assert.equal(result.items[0].answer, "50万円（発言: 佐藤）");
  assert.deepEqual(result.other, ["予算の確認（発言: 佐藤）"]);
  assert.deepEqual(result.todo, ["写真を送る（発言: 田中）"]);
});

test("bridge: speaker events originate in ISOLATED DOM observer; never forwarded from window messages", async () => {
  let receive,
    windowMessage,
    stopCount = 0,
    observerSend;
  const sent = [],
    main = [],
    doc = {};
  const window = {
    postMessage: (m) => main.push(m),
    addEventListener: (type, fn) => {
      if (type === "message") windowMessage = fn;
    },
  };
  window.top = window;
  const context = {
    window,
    document: doc,
    crypto,
    location: {
      hostname: "meet.google.com",
      origin: "https://meet.google.com",
    },
    chrome: {
      runtime: {
        id: "ext",
        connect: () => ({
          onMessage: { addListener: (fn) => (receive = fn) },
          onDisconnect: { addListener() {} },
          postMessage: (m) => sent.push(m),
        }),
      },
    },
    KoeMeetSpeakers: {
      observe: (document, send) => {
        assert.equal(document, doc);
        observerSend = send;
        return () => stopCount++;
      },
    },
    setTimeout() {},
    setInterval() {},
    clearInterval() {},
  };
  vm.runInNewContext(await readFile("bridge.js", "utf8"), context);
  receive({ type: "speakerTracking", enabled: true });
  observerSend({ type: "speakers", at: 1000, names: ["佐藤"] });
  assert.equal(sent.at(-1).names[0], "佐藤");
  const count = sent.length;
  windowMessage({
    source: window,
    origin: context.location.origin,
    data: {
      __koe: "page",
      secret: main[0].secret,
      type: "speakers",
      at: 1000,
      names: ["偽装"],
    },
  });
  assert.equal(sent.length, count);
  receive({ type: "speakerTracking", enabled: false });
  assert.equal(stopCount, 1);
  assert(
    !main.some((m) => m.type === "speakerTracking" || m.type === "speakers"),
  );
});
