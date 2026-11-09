// v1.2: ヒアリング項目・定型文の作り置きと編集、職種からの質問づくり（API を呼ばないモック）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Session, blankState } from "../session.js";
import {
  configWith,
  warmTexts,
  WARM_LIST_LIMIT,
  DEFAULTS,
  FILLER,
} from "../config.js";
import {
  int16ToB64,
  suggestReplies,
  draftHearingQuestions,
  HEARING_DRAFT_PROMPT,
} from "../openai.js";
import { voiceKey } from "../cache.js";

const microtasks = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function harness(t, raw = {}) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const memory = new Map(),
    spoken = [],
    pruned = [];
  const s = new Session({
    page: () => {},
    cache: {
      get: async (k) => memory.get(k),
      put: async (k, v) => memory.set(k, v),
      prune: async (keep) => {
        pruned.push(keep);
        for (const k of [...memory.keys()]) if (!keep.has(k)) memory.delete(k);
      },
      expire: async () => {},
      clearLogs: async () => {},
      clearCandidates: () => {},
    },
  });
  s.cfg = s.savedCfg = configWith({
    apiKey: "dummy",
    autoFiller: false,
    prefetchCandidates: 0,
    ...raw,
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
    speak(text, sink = {}) {
      spoken.push(text);
      const audio = int16ToB64(new Int16Array(2400));
      sink.pcm?.(audio);
      const result = {
        status: "completed",
        chunks: [audio],
        transcript: text,
        seconds: 0.1,
      };
      sink.end?.(result);
      return Promise.resolve(result);
    },
    cancelAll() {},
    close() {},
  };
  t.after(() => {
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
  });
  return { s, memory, spoken, pruned };
}

test("v1.2 warmTexts: intro・相づち・つなぎに加え、ヒアリング→定型文の順で20件まで", () => {
  const hearing = Array.from({ length: 25 }, (_, i) => `質問${i + 1}でしょうか。`);
  const cfg = configWith({ hearing, phrases: ["定型A。", "定型B。"] });
  const texts = warmTexts(cfg);
  const base = [cfg.intro, ...cfg.quick.map((q) => q.text), FILLER];
  assert.deepEqual(texts.slice(0, base.length), base);
  assert.equal(texts.length, base.length + WARM_LIST_LIMIT);
  assert.equal(WARM_LIST_LIMIT, 20);
  assert.deepEqual(texts.slice(base.length), hearing.slice(0, 20));
  // 既定値（7問＋4文）は全部入る。
  const def = warmTexts(configWith({}));
  for (const text of [...DEFAULTS.hearing, ...DEFAULTS.phrases])
    assert(def.includes(text), text);
  // 重複は1回だけ。
  const dup = warmTexts(
    configWith({ hearing: ["同じ文。", "同じ文。"], phrases: ["同じ文。"] }),
  );
  assert.equal(dup.filter((x) => x === "同じ文。").length, 1);
});

test("v1.2 会話の開始時の作り置きにヒアリング項目が入り、押すと作り置きの声がそのまま鳴る（新しく作らない）", async (t) => {
  const { s, spoken } = harness(t);
  await s.prewarm();
  const texts = warmTexts(s.cfg);
  assert.equal(s.s.warm.total, texts.length);
  assert.equal(s.s.warm.done, texts.length);
  for (const q of s.cfg.hearing) assert(s.s.warm.ready.includes(q), q);
  for (const p of s.cfg.phrases) assert(s.s.warm.ready.includes(p), p);
  assert.equal(s.s.usage.warmVoices, texts.length);
  const before = spoken.length;
  assert.equal(await s.say(s.cfg.hearing[2], "hearing"), true);
  await microtasks();
  assert.equal(s.job.source, "cached");
  assert.equal(spoken.length, before, "押したときに声を作り直していない");
  assert.equal(await s.command({ command: "sheetSay", tab: "phrases", index: 1 }), true);
  await microtasks();
  assert.equal(s.job.source, "cached");
  assert.equal(spoken.length, before);
});

test("v1.2 会話中に1項目を書き換えると、その項目だけ作り直し、古い声は端末から消す", async (t) => {
  const { s, spoken, memory, pruned } = harness(t);
  await s.prewarm();
  const oldText = s.cfg.hearing[1];
  const oldKey = await voiceKey(s.cfg, oldText);
  assert(memory.has(oldKey));
  const before = spoken.length;
  const hearing = [...s.cfg.hearing];
  hearing[1] = "現在お使いのホームページで、お困りの点を教えていただけますでしょうか。";
  await s.updateConfig({ ...s.savedCfg, hearing });
  // updateConfig は prewarm を待たずに返るので、作り終わるまで回す。
  for (let i = 0; i < 200 && (s.warmToken || pruned.length < 2); i++)
    await new Promise((r) => setImmediate(r));
  assert.deepEqual(spoken.slice(before), [hearing[1]]);
  assert(s.s.warm.ready.includes(hearing[1]));
  assert(!memory.has(oldKey), "書き換える前の声は消した");
  assert(pruned.length >= 2);
  // 関係のない設定（文字サイズ）では作り直さない。
  const after = spoken.length;
  await s.updateConfig({ ...s.savedCfg, captionFontPx: 22 });
  await microtasks();
  assert.equal(spoken.length, after);
  assert.equal(s.warmToken, null);
});

test("v1.2 会話中に並べ替え・削除しても、済みの印は聞いた質問に残る", async (t) => {
  const { s } = harness(t);
  s.prewarm = async () => {};
  const [a, b, c, d] = s.cfg.hearing;
  s.s.hearingAsked = [0, 2]; // a と c を聞いた
  await s.updateConfig({ ...s.savedCfg, hearing: [c, b, a, d] });
  assert.deepEqual(s.s.hearingAsked.sort(), [0, 2]);
  assert.deepEqual(
    s.s.hearingAsked.map((i) => s.cfg.hearing[i]).sort(),
    [a, c].sort(),
  );
  await s.updateConfig({ ...s.savedCfg, hearing: [b, a, d] }); // c を削除
  assert.deepEqual(s.s.hearingAsked, [1]);
  assert.equal(s.cfg.hearing[1], a);
});

test("v1.2 会話していないときは、作り置きの途中だけ書き換えた項目を作り直す（ほかは次の開始時）", async (t) => {
  const { s } = harness(t);
  s.s.active = false;
  let calls = 0;
  s.prewarm = async () => {
    calls++;
  };
  await s.updateConfig({ ...s.savedCfg, phrases: ["先に変えた定型文です。"] });
  assert.equal(calls, 0, "作り置きしていなければ接続を開かない");
  s.warmToken = "warming";
  await s.updateConfig({ ...s.savedCfg, phrases: ["新しい定型文です。"] });
  assert.equal(calls, 1);
  await s.updateConfig({ ...s.savedCfg, theme: "dark" });
  assert.equal(calls, 1);
});

function mockFetch(t, content, { ok = true, status = 200 } = {}) {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return {
      ok,
      status,
      headers: { get: () => "application/json" },
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return bodies;
}

test("v1.2 今日の項目を作る（空欄＝初回ヒアリング）: 送るのは仕事と補足だけ・候補と同じ軽いモデル・番号や重複を取り除く", async (t) => {
  const bodies = mockFetch(t, {
    questions: [
      "1. ご相談のきっかけを、お聞かせいただけますでしょうか。",
      "現在お困りの点を、教えていただけますでしょうか。",
      "現在お困りの点を、教えていただけますでしょうか。",
      "ご予算の目安を、教えていただけますでしょうか。",
      "  ",
      "ご希望の時期を、お聞かせいただけますでしょうか。",
    ],
  });
  const cfg = configWith({
    apiKey: "dummy",
    name: "秘密の名前",
    job: "保存済みの別の仕事",
  });
  const usage = [];
  const out = await draftHearingQuestions(
    cfg,
    { job: "税理士", about: "個人事業主の確定申告が中心" },
    undefined,
    (u) => usage.push(u),
  );
  assert.deepEqual(out, [
    "ご相談のきっかけを、お聞かせいただけますでしょうか。",
    "現在お困りの点を、教えていただけますでしょうか。",
    "ご予算の目安を、教えていただけますでしょうか。",
    "ご希望の時期を、お聞かせいただけますでしょうか。",
  ]);
  assert.equal(bodies.length, 1);
  const { url, body } = bodies[0];
  assert.match(url, /\/v1\/chat\/completions$/);
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.model, DEFAULTS.replyModel);
  assert.equal(body.store, false);
  const sent = JSON.stringify(body.messages);
  assert(sent.includes("税理士") && sent.includes("個人事業主の確定申告が中心"));
  assert(!sent.includes("秘密の名前"), "名前は送らない");
  assert(!sent.includes("保存済みの別の仕事"));
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].content, HEARING_DRAFT_PROMPT);
  assert(body.messages[1].content.includes("空。初回ヒアリングの項目を作る"));
  for (const rule of [
    "今日話したいこと",
    "内輪の言葉",
    "納品前の確認",
    "いただけますでしょうか",
    "45字以内",
    "10秒以内",
    "予算",
    "決裁",
    "業界用語",
    "7問",
  ])
    assert(HEARING_DRAFT_PROMPT.includes(rule), rule);
  assert.equal(usage.length, 1);
});

test("v1.2 今日の項目を作る（自由記述・壁打ちメモ）: 欄の内容をそのまま資料として送り、種類の選択は無い", async (t) => {
  const bodies = mockFetch(t, {
    questions: [
      "残っている修正はございませんでしょうか。",
      "公開日は11月20日でよろしいでしょうか。",
      "ログイン情報のお渡し方法をご相談できますでしょうか。",
    ],
  });
  const memo =
    "## 壁打ちメモ（Claude）\n- 納品前の確認\n- 公開日の確定\n- （内輪）追加費用は様子見";
  const cfg = configWith({ apiKey: "dummy", name: "山田" });
  const out = await draftHearingQuestions(cfg, { job: "", topic: memo });
  assert.equal(out.length, 3);
  const user = bodies[0].body.messages[1].content;
  assert(user.includes("<<<\n" + memo + "\n>>>"));
  assert(user.includes("仕事: （未入力）"));
  assert(!JSON.stringify(bodies[0].body).includes("山田"));
  assert(!/purpose|目的の種類|進み具合の確認\b/.test(user));
});

test("v1.2 今日の項目を作る: 失敗・空の欄・少なすぎる案はエラーにする", async (t) => {
  const cfg = configWith({ apiKey: "dummy" });
  await assert.rejects(
    draftHearingQuestions(cfg, { job: "  ", topic: " " }),
    /仕事か、今日話したいことを入力してください/,
  );
  mockFetch(t, {}, { ok: false, status: 401 });
  await assert.rejects(
    draftHearingQuestions(cfg, { job: "税理士" }),
    /API キーを確認してください/,
  );
  mockFetch(t, { questions: ["", "  "] });
  await assert.rejects(
    draftHearingQuestions(cfg, { job: "税理士" }),
    /項目を作れませんでした/,
  );
});

test("v1.2 Session の draftHearing は保存した質問を変えず、キー未設定ならエラー（背景の許可リストにもある）", async (t) => {
  const { s } = harness(t);
  const before = [...s.cfg.hearing];
  const bodies = mockFetch(t, {
    questions: [
      "質問一でしょうか。",
      "質問二でしょうか。",
      "質問三でしょうか。",
      "質問四でしょうか。",
      "質問五でしょうか。",
    ],
  });
  s.savedCfg = configWith({ ...s.savedCfg, name: "山田" });
  const out = await s.command({
    command: "draftHearing",
    job: "動画編集",
    about: "YouTube の切り抜き",
    topic: "初稿を見ていただく",
  });
  assert.equal(out.length, 5);
  assert.deepEqual(s.cfg.hearing, before);
  assert(!JSON.stringify(bodies[0].body).includes("山田"));
  assert(!JSON.stringify(bodies[0].body).includes("今回ホームページ"));
  await assert.rejects(
    s.command({ command: "draftHearing", job: "", topic: "" }),
    /仕事か、今日話したいことを入力してください/,
  );
  s.savedCfg = configWith({ apiKey: "" });
  await assert.rejects(
    s.command({ command: "draftHearing", job: "税理士" }),
    /API キーを設定してください/,
  );
  const background = await readFile(
    new URL("../background.js", import.meta.url),
    "utf8",
  );
  const allowed = background.slice(background.indexOf("const allowed = ["));
  assert(allowed.slice(0, allowed.indexOf("];")).includes('"draftHearing"'));
});

test("v1.2 名前の変更: 利用者に見える名前は「フキダシ」、保存キーと配布フォルダ名は据え置き", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root)));
  const pkg = JSON.parse(await readFile(new URL("package.json", root)));
  assert.equal(manifest.name, "フキダシ");
  assert.equal(manifest.action.default_title, "フキダシを開く");
  assert.equal(manifest.version, "1.2.4");
  assert.equal(pkg.name, "fukidashi");
  assert.equal(pkg.version, "1.2.4");
  for (const file of ["sidepanel.html", "sidepanel.js", "offscreen.html", "permission.html"]) {
    const text = await readFile(new URL(file, root), "utf8");
    assert(!text.includes("こえブリッジ"), file);
  }
  const panel = await readFile(new URL("sidepanel.js", root), "utf8");
  assert(panel.includes("`fukidashi-${voice}.wav`"));
  assert(panel.includes('"フキダシ-" + new Date()'));
  // 保存済みの声・記録を失わないよう、IndexedDB と chrome.storage のキーは変えない。
  const cache = await readFile(new URL("cache.js", root), "utf8");
  assert(cache.includes('indexedDB.open("koe-bridge-v1", 1)'));
  const background = await readFile(new URL("background.js", root), "utf8");
  assert(background.includes('chrome.storage.local.get("cfg")'));
});

test("回帰: 空欄が1項目（ご予算）だけでも1問を受け入れ、水増しを求めない", async (t) => {
  const bodies = mockFetch(t, {
    questions: ["ご予算の目安を教えていただけますでしょうか。"],
  });
  const out = await draftHearingQuestions(configWith({ apiKey: "dummy" }), {
    job: "Web デザイナー",
    sheetItems: [{ label: "ご予算", hint: "" }],
  });
  assert.deepEqual(out, ["ご予算の目安を教えていただけますでしょうか。"]);
  const schema = bodies[0].body.response_format.json_schema.schema.properties.questions;
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 1, "選んだ項目数が上限");
  assert(HEARING_DRAFT_PROMPT.includes("水増ししない"));
  // 自由記述だけなら1〜10問。
  const free = mockFetch(t, { questions: ["公開日は11月20日でよろしいでしょうか。"] });
  assert.equal(
    (await draftHearingQuestions(configWith({ apiKey: "dummy" }), { topic: "公開日だけ確かめたい" })).length,
    1,
  );
  assert.equal(free[0].body.response_format.json_schema.schema.properties.questions.maxItems, 10);
});

test("回帰: 返事の候補に「承りました」が出たら「承知いたしました」にし、プロンプトでも使わせない", async (t) => {
  const bodies = mockFetch(t, {
    replies: ["お困りの点、よく承りました。", "ご要望を承りました。", "確認いたします。"],
  });
  const replies = await suggestReplies(configWith({ apiKey: "dummy" }), [
    { id: "a", who: "other", text: "予算は50万円です。" },
  ]);
  assert.deepEqual(replies, [
    "お困りの点、よく承知いたしました。",
    "ご要望を承知いたしました。",
    "確認いたします。",
  ]);
  const system = bodies[0].body.messages[0].content;
  assert(system.includes("「承りました」は使わない"));
  assert(HEARING_DRAFT_PROMPT.includes("「承りました」は使わない"));
  for (const text of [
    ...DEFAULTS.phrases,
    ...DEFAULTS.hearing,
    ...DEFAULTS.quick.map((q) => q.text),
    FILLER,
    DEFAULTS.intro,
  ])
    assert(!text.includes("承り"), text);
});
