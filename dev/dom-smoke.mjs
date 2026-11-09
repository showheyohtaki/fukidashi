// DOM/control smoke only. LinkeDOM has no layout, CSS painting or Chrome APIs.
// Install the optional test dependency inside the repo; see README.
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? null : process.argv[i + 1];
};
const { parseHTML } = createRequire(import.meta.url)(
  arg("--dom-module") || "linkedom",
);
const { window } = parseHTML(
  await readFile(path.join(root, "dist/dev/sidepanel.html"), "utf8"),
);
const { document, HTMLElement, Event } = window;
const result = {
  kind: "DOM/control smoke; no layout, painting or browser acceptance",
  checks: [],
  errors: [],
};
const out = path.resolve(
  root,
  arg("--out") || "docs/test-log/2026-10-31/round1",
);
if (!out.startsWith(root + path.sep))
  throw new Error("Output must remain inside koe-bridge");
Object.assign(globalThis, {
  window,
  document,
  location: { search: "", origin: "chrome-extension://test" },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
});
let copied = "",
  downloaded;
Object.defineProperty(globalThis, "navigator", {
  value: {
    platform: "Mac",
    clipboard: {
      writeText: async (text) => {
        copied = text;
      },
    },
  },
  configurable: true,
});
let active = document.body;
Object.defineProperty(document, "activeElement", { get: () => active });
HTMLElement.prototype.focus = function () {
  active = this;
};
HTMLElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLElement.prototype.close = function () {
  this.removeAttribute("open");
};
const timers = new Map();
URL.createObjectURL = (blob) => {
  downloaded = blob;
  return "blob:test";
};
URL.revokeObjectURL = () => {};
let tid = 0;
globalThis.setTimeout = (fn, ms) => {
  timers.set(++tid, { fn, ms });
  return tid;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.setInterval = () => 0;
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 0;
};
const observers = [];
globalThis.ResizeObserver = class {
  constructor(fn) {
    this.fn = fn;
    observers.push(this);
  }
  observe(el) {
    this.el = el;
  }
  disconnect() {
    this.el = null;
  }
};
const stored = new Map();
globalThis.sessionStorage = {
  getItem: (k) => stored.get(k),
  setItem: (k, v) => stored.set(k, v),
};
const handlers = [],
  calls = [];
const draftQuestions = [
  "残っている修正はございませんでしょうか。",
  "公開日は11月20日でよろしいでしょうか。",
  "ログイン情報のお渡し方法をご相談できますでしょうか。",
  "公開後の保守をご希望かどうか、お聞かせいただけますでしょうか。",
  "請求書の宛名を教えていただけますでしょうか。",
];
const { configWith, publicConfig } = await import("../config.js");
let cfg = configWith({ apiKey: "dummy", onboarded: true });
globalThis.chrome = {
  runtime: {
    connect: () => ({
      onMessage: { addListener: (fn) => handlers.push(fn) },
      onDisconnect: { addListener() {} },
      postMessage(m) {
        calls.push(m);
        const saveError =
          m.command === "saveConfig" ? globalThis.__saveError : null;
        if (m.command === "saveConfig" && !saveError)
          cfg = configWith({ ...cfg, ...m.patch });
        const draftError =
          m.command === "draftHearing" ? globalThis.__draftError : saveError;
        queueMicrotask(() =>
          handlers.forEach((fn) =>
            fn({
              type: "reply",
              requestId: m.requestId,
              ...(draftError ? { error: draftError } : {}),
              value:
                m.command === "draftHearing"
                  ? draftQuestions
                  : 
                m.command === "saveConfig"
                  ? publicConfig(cfg)
                  : m.command === "listLogs"
                    ? []
                    : true,
            }),
          ),
        );
      },
    }),
  },
};
const $ = (id) => document.getElementById(id);
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const click = async (el) => {
  assert(el);
  el.dispatchEvent(new Event("click", { bubbles: true }));
  await flush();
};
const event = (el, name, properties = {}) => {
  const e = new Event(name, { bubbles: true, cancelable: true });
  Object.assign(e, properties);
  el.dispatchEvent(e);
};
async function check(name, fn) {
  try {
    await fn();
    result.checks.push({ name, status: "pass" });
  } catch (e) {
    result.checks.push({ name, status: "fail", error: e.stack });
  }
}
try {
  await import(pathToFileURL(path.join(root, "dist/dev/sidepanel.js")).href);
  const { fixtureNames, extraFixtureNames } = await import("./fixtures.js");
  await check(
    "speaker headings, escaping, OFF, full text, Markdown copy and file share the same names",
    async () => {
      await window.koeTest.fixture("Main");
      const state = window.koeTest.state();
      state.cfg.showSpeakerNames = true;
      state.lines = [
        {
          id: "a",
          who: "other",
          speaker: "佐藤<script>",
          text: "最初の話",
          at: 1000,
        },
        {
          id: "b",
          who: "other",
          speaker: "佐藤<script>",
          text: "続きの話",
          at: 2000,
        },
        { id: "c", who: "other", text: "不明の話", at: 3000 },
        { id: "d", who: "other", speaker: "田中", text: "次の話", at: 4000 },
      ];
      window.koeTest.live();
      for (const fn of handlers) fn({ type: "snapshot", state });
      assert.deepEqual(
        [...document.querySelectorAll(".caption-speaker")].map(
          (n) => n.textContent,
        ),
        ["佐藤<script>", "田中"],
      );
      assert.equal($("captions").querySelector("script"), null);
      state.cfg.showSpeakerNames = false;
      for (const fn of handlers) fn({ type: "snapshot", state });
      assert.equal(document.querySelectorAll(".caption-speaker").length, 0);
      state.cfg.showSpeakerNames = true;
      state.active = false;
      state.ended = true;
      state.summaryState = "ready";
      state.summary = {
        items: [{ question: "予算", answer: "50万円（発言: 佐藤）" }],
        other: [],
        todo: [],
      };
      for (const fn of handlers) fn({ type: "snapshot", state });
      await click(document.querySelector('[data-action="copySummary"]'));
      assert(copied.includes("佐藤<script>: 最初の話"));
      assert(copied.includes("佐藤<script>: 続きの話"));
      assert(copied.includes("相手: 不明の話"));
      assert(copied.includes("田中: 次の話"));
      assert(copied.includes("50万円（発言: 佐藤）"));
      await click(document.querySelector('[data-action="saveSummary"]'));
      assert.equal(await downloaded.text(), copied);
      await click(document.querySelector('[data-action="fullText"]'));
      assert(
        document
          .querySelector(".transcript-full")
          .textContent.includes("田中: 次の話"),
      );
      await window.koeTest.fixture("S8-settings");
      assert(document.querySelector('[data-switch="showSpeakerNames"]'));
    },
  );
  for (const name of [...fixtureNames, ...extraFixtureNames])
    await check("render " + name, async () => {
      active = document.body;
      await window.koeTest.fixture(name);
      assert(document.getElementById("app").textContent.trim());
      if (["S4-speaking", "S3d-overlap"].includes(name))
        assert.equal($("stop-voice").textContent, "止める（Esc）");
      if (name === "E1-bands")
        assert(document.querySelector('[data-action="reloadHelp"]'));
      if (name === "E2-inline") {
        assert(document.querySelector('[data-action="fixLine"]'));
        assert(
          document
            .querySelector(".failed-note")
            .textContent.includes("接続が切れました"),
        );
      }
      if (name === "S1b-not-meeting")
        assert($("meeting").classList.contains("not-meeting"));
      if (name === "S5-filler")
        assert(
          $("status-detail").textContent.includes("入力中｜つなぎを送りました"),
        );
      if (name === "E3-candfail")
        assert.equal($("latest").textContent, "↓ 新しい字幕 2 件");
      if (name === "M-menu") assert(document.querySelector("dialog[open]"));
      if (name === "S2-connecting") {
        assert.equal($("connections").querySelectorAll(".err").length, 0);
        assert.equal($("candidate-heading").textContent, "返事の候補");
        assert.equal(
          document
            .querySelector('.connection-progress [role="progressbar"]')
            .getAttribute("aria-valuenow"),
          "1",
        );
      }
      if (name === "S0-1b-badkey") {
        assert.equal(
          $("api-key").getAttribute("aria-describedby"),
          "key-error",
        );
        assert.equal(
          $("api-key").parentElement.nextElementSibling,
          $("key-error"),
        );
        assert($("key-error").closest(".key-group"));
      }
      if (name === "S11-hearing")
        assert.equal(
          document.querySelector(".sheet-settings").parentElement.id,
          "sheet",
        );
      if (["Main", "Dark", "W360", "E2-inline", "E3-candfail"].includes(name))
        assert.equal(document.activeElement.id, "input");
    });
  await check(
    "typing events only, throttled; arrow key does not report typing",
    async () => {
      active = document.body;
      await window.koeTest.fixture("Main");
      const base = calls.filter((m) => m.command === "setTyping").length;
      event($("input"), "keydown", { key: "ArrowLeft", code: "ArrowLeft" });
      await flush();
      assert.equal(calls.filter((m) => m.command === "setTyping").length, base);
      $("input").value = "入力";
      event($("input"), "input");
      event($("input"), "compositionupdate");
      event($("input"), "input");
      await flush();
      assert.equal(
        calls.filter((m) => m.command === "setTyping").length,
        base + 1,
      );
    },
  );
  await check(
    "resize follows captions only while near bottom, panel reopen resets following",
    async () => {
      active = document.body;
      await window.koeTest.fixture("Main");
      const el = $("captions");
      Object.defineProperty(el, "scrollHeight", {
        value: 1000,
        configurable: true,
      });
      Object.defineProperty(el, "clientHeight", {
        value: 200,
        configurable: true,
      });
      el.scrollTop = 800;
      event(el, "scroll");
      observers.at(-1).fn();
      assert.equal(el.scrollTop, 1000);
      el.scrollTop = 10;
      event(el, "scroll");
      observers.at(-1).fn();
      assert.equal(el.scrollTop, 10);
      await window.koeTest.fixture("Main");
      assert.equal(observers.filter((o) => o.el).length, 1);
    },
  );
  await check(
    "late scroll from removed captions does nothing after view change",
    async () => {
      await window.koeTest.fixture("Main");
      const old = $("captions");
      await window.koeTest.fixture("S7-summary");
      assert.equal($("captions"), null);
      event(old, "scroll");
      await window.koeTest.fixture("Main");
      event(old, "scroll");
      assert.equal($("captions").classList.contains("history"), false);
    },
  );
  await check(
    "streamed candidate 1 is usable while the other slots remain disabled",
    async () => {
      await window.koeTest.fixture("Main");
      const state = window.koeTest.state();
      state.candidates = [{ text: "先に完成した候補", ready: false }];
      state.candidateState = "ready";
      state.candidateStreaming = true;
      window.koeTest.live();
      for (const fn of handlers) fn({ type: "snapshot", state });
      const buttons = [...document.querySelectorAll(".candidate")];
      assert.equal(buttons.length, 3);
      assert(!buttons[0].disabled);
      assert(buttons[1].disabled && buttons[2].disabled);
      assert.equal($("candidates").getAttribute("aria-busy"), "true");
      assert.equal(buttons[0].querySelector(".pill"), null);
      buttons[0].focus();
      state.candidates.push({ text: "二つ目の候補", ready: false });
      for (const fn of handlers) fn({ type: "snapshot", state });
      assert.equal(document.activeElement.dataset.index, "0");
      assert(document.activeElement.isConnected);
      await click(document.querySelector(".candidate"));
      assert(calls.some((c) => c.command === "pickCandidate" && c.index === 0));
    },
  );
  await check(
    "voice preparation and rebuffering show the preparation status; resume returns to sending",
    async () => {
      await window.koeTest.fixture("Main");
      const state = window.koeTest.state();
      state.otherSpeaking = false;
      state.speaking = {
        id: "buffer",
        text: "読み上げる文",
        preparing: true,
        level: 0,
      };
      window.koeTest.live();
      for (const fn of handlers) fn({ type: "snapshot", state });
      assert.equal($("status-text").textContent, "声を準備しています");
      for (const preparing of [false, true, false]) {
        for (const fn of handlers)
          fn({
            type: "progress",
            patch: { speaking: { ...state.speaking, preparing } },
          });
        assert.equal(
          $("status-text").textContent,
          preparing ? "声を準備しています" : "送信中",
        );
      }
    },
  );
  await check(
    "Meet sender clone mute displays meeting-muted even with unused live clones, then clears on unmute",
    async () => {
      await window.koeTest.fixture("Main");
      const state = window.koeTest.state();
      state.page = {
        ...state.page,
        streams: 3,
        unmuted: 2,
        attached: 0,
        attachedEver: true,
        context: "running",
      };
      window.koeTest.live();
      for (const fn of handlers) fn({ type: "snapshot", state });
      assert.equal($("status-text").textContent, "会議でミュート中");
      assert.equal($("status").dataset.tone, "bad");
      state.page = { ...state.page, unmuted: 3, attached: 1 };
      for (const fn of handlers) fn({ type: "snapshot", state });
      assert.notEqual($("status-text").textContent, "会議でミュート中");
    },
  );
  await check(
    "reload help toggles explanation without calling start",
    async () => {
      await window.koeTest.fixture("E1-bands");
      const count = calls.length;
      await click(document.querySelector('[data-action="reloadHelp"]'));
      assert($("bands").textContent.includes("Ctrl+R"));
      assert.equal(calls.length, count);
    },
  );
  await check(
    "mismatch fix restores requested text; key reveal toggles password",
    async () => {
      await window.koeTest.fixture("E2-inline");
      await click(document.querySelector('[data-action="fixLine"]'));
      assert.equal($("input").value, "公開は3月末でよろしいですか？");
      await window.koeTest.fixture("S0-1b-badkey");
      assert($("api-key").value);
      await click(document.querySelector('[data-action="toggleKey"]'));
      assert.equal($("api-key").type, "text");
    },
  );
  await check(
    "settings select values are saved as numbers/booleans; Numpad shortcuts work",
    async () => {
      await window.koeTest.fixture("S8-settings");
      const el = document.querySelector('[data-field="prefetchCandidates"]');
      Object.defineProperty(el, "value", { value: "2", configurable: true });
      event(el, "change");
      await flush();
      assert.equal(calls.at(-1).patch.prefetchCandidates, 2);
      await window.koeTest.fixture("Main");
      event($("input"), "keydown", { key: "1", code: "Numpad1", altKey: true });
      await flush();
      assert(calls.some((m) => m.command === "pickCandidate" && m.index === 0));
    },
  );
  const saves = () => calls.filter((m) => m.command === "saveConfig");
  const typeInto = (el, value, name = "input") => {
    el.value = value;
    event(el, name);
  };
  await check(
    "v1.2 sheet editor: rewrite, reorder, delete and add save cfg.hearing; tab says 今日の項目",
    async () => {
      active = document.body;
      await window.koeTest.fixture("S11-hearing");
      assert.equal($("tab-hearing").textContent, "今日の項目");
      const original = [...window.koeTest.state().cfg.hearing];
      await click(document.querySelector('[data-action="sheetEdit"]'));
      assert.equal(document.querySelectorAll("[data-edit-index]").length, 7);
      typeInto(
        document.querySelector('[data-edit-index="0"]'),
        "新しい質問でしょうか。",
        "change",
      );
      await flush();
      assert.equal(saves().at(-1).patch.hearing[0], "新しい質問でしょうか。");
      await click(
        document.querySelector(
          '[data-action="listMove"][data-index="0"][data-dir="1"]',
        ),
      );
      assert.deepEqual(saves().at(-1).patch.hearing.slice(0, 2), [
        original[1],
        "新しい質問でしょうか。",
      ]);
      await click(
        document.querySelector('[data-action="listDelete"][data-index="6"]'),
      );
      assert.equal(saves().at(-1).patch.hearing.length, 6);
      assert(!saves().at(-1).patch.hearing.includes(original[6]));
      typeInto($("list-add"), "追加の質問でしょうか。");
      await click(document.querySelector('[data-action="listAdd"]'));
      assert.equal(saves().at(-1).patch.hearing.at(-1), "追加の質問でしょうか。");
      assert.equal(saves().at(-1).patch.hearing.length, 7);
      await click(document.querySelector('[data-action="sheetEdit"]'));
      assert.equal(document.querySelectorAll("[data-edit-index]").length, 0);
      const items = [...document.querySelectorAll(".sheet-item")].map(
        (n) => n.textContent,
      );
      assert.equal(items.length, 7);
      assert(items[1].includes("新しい質問でしょうか。"));
      assert(items[6].includes("追加の質問でしょうか。"));
    },
  );
  await check(
    "v1.2 settings: 一覧で編集する opens the editor screen; back shows the same list in the textarea",
    async () => {
      await window.koeTest.fixture("S8-settings");
      assert(
        document
          .querySelector('[data-field="hearing"]')
          .closest("label")
          .textContent.includes("シートの「今日の項目」と同じ一覧"),
      );
      await click(
        document.querySelector('[data-action="openLists"][data-tab="hearing"]'),
      );
      assert($("lists-tab-hearing"));
      assert($("lists-tab-phrases"));
      typeInto($("list-add"), "事前登録の質問でしょうか。");
      await click(document.querySelector('[data-action="listAdd"]'));
      await click(document.querySelector('[data-action="listsTab"][data-tab="phrases"]'));
      assert.equal(
        document.querySelector(".list-editor").dataset.list,
        "phrases",
      );
      await click(document.querySelector('[data-action="listsBack"]'));
      assert(
        document
          .querySelector('[data-field="hearing"]')
          .value.includes("事前登録の質問でしょうか。"),
      );
    },
  );
  await check(
    "v1.2 today's items: empty fields disable; sends only job/about/topic; partial append opens editor; topic is not saved",
    async () => {
      globalThis.__draftError = null;
      await window.koeTest.fixture("S0-2-you");
      const job = document.querySelector('[data-field="job"]');
      typeInto(job, "");
      assert.equal($("draft-hearing").disabled, true);
      const topic =
        "納品前の確認をしたい。公開日とログイン情報の渡し方。（内輪：追加費用は様子見）";
      typeInto($("draft-topic"), topic);
      assert.equal($("draft-hearing").disabled, false, "メモだけでも作れる");
      typeInto(job, "Web デザイナー");
      await click($("draft-hearing"));
      const sent = calls.filter((m) => m.command === "draftHearing").at(-1);
      assert.deepEqual(Object.keys(sent).sort(), [
        "about",
        "command",
        "job",
        "requestId",
        "topic",
      ]);
      assert.equal(sent.job, "Web デザイナー");
      assert.equal(sent.topic, topic);
      const boxes = document.querySelectorAll("[data-draft-index]");
      assert.equal(boxes.length, draftQuestions.length);
      boxes[1].checked = false;
      event(boxes[1], "change");
      assert.equal($("draft-count").textContent, String(draftQuestions.length - 1));
      const savesBefore = saves().length;
      const before = [...cfg.hearing]; // 送信前に保存されている一覧（モックの保存先）
      await click(
        document.querySelector('[data-action="draftApply"][data-mode="append"]'),
      );
      const hearing = saves().at(-1).patch.hearing;
      assert.deepEqual(hearing, [
        ...before,
        ...draftQuestions.filter((_, i) => i !== 1),
      ]);
      assert($("lists-tab-hearing"), "そのまま編集画面へ");
      assert(
        !JSON.stringify(saves().slice(savesBefore)).includes("内輪"),
        "今日話したいことの欄は保存しない",
      );
      assert(
        !JSON.stringify(saves()).includes("追加費用は様子見"),
        "今日話したいことの欄は保存しない",
      );
      await click(document.querySelector('[data-action="listsBack"]'));
      assert.equal(document.querySelector('[data-field="job"]').value, "Web デザイナー");
    },
  );
  await check(
    "v1.2 today's items: failure keeps the current list and shows an error; replace swaps the list",
    async () => {
      globalThis.__draftError = "接続できませんでした。もう一度お試しください";
      await window.koeTest.fixture("S8-settings");
      const count = saves().length;
      await click($("draft-hearing"));
      assert(document.querySelector(".draft-error").textContent.includes("接続できませんでした"));
      assert.equal(saves().length, count, "失敗時は保存しない");
      globalThis.__draftError = null;
      await click($("draft-hearing"));
      await click(
        document.querySelector('[data-action="draftApply"][data-mode="replace"]'),
      );
      assert.deepEqual(saves().at(-1).patch.hearing, draftQuestions);
    },
  );
  const settle = async (done) => {
    for (let i = 0; i < 400 && !done(); i++)
      await new Promise((r) => setImmediate(r));
    assert(done(), "async read did not finish");
  };
  const attach = async (file) => {
    const input = $("sheet-file");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    event(input, "change");
  };
  await check(
    "v1.2 sheet attach: xlsx items, blank-only default, sheet filter, only blank labels sent, nothing of the file saved",
    async () => {
      globalThis.__draftError = null;
      await window.koeTest.fixture("S8-settings");
      const bytes = await readFile(path.join(root, "tests/fixtures/hearing-sheet.xlsx"));
      await attach(new File([bytes], "hearing-sheet.xlsx"));
      await settle(() => $("sheet-title"));
      assert($("sheet-title").textContent.includes("読み取れた項目 11（空欄 7）"));
      assert.equal(document.querySelectorAll("[data-sheet-name]").length, 2);
      const checked = () =>
        [...document.querySelectorAll("[data-sheet-item]")].filter((b) =>
          b.hasAttribute("checked"),
        ).length; // LinkeDOM は checked 属性をプロパティに映さない
      assert.equal(checked(), 7);
      const design = document.querySelector('[data-sheet-name="デザイン"]');
      design.checked = false;
      event(design, "change");
      assert.equal(document.querySelectorAll("[data-sheet-item]").length, 8);
      assert.equal(checked(), 5);
      const ng = [...document.querySelectorAll("[data-sheet-item]")].find((b) =>
        b.parentElement.textContent.includes("ターゲット"),
      );
      ng.checked = false;
      event(ng, "change");
      await click($("draft-hearing"));
      const sent = calls.filter((m) => m.command === "draftHearing").at(-1);
      assert.deepEqual(
        sent.sheetItems.map((i) => i.label),
        ["ご担当者名", "ご予算", "納期", "公開後の更新"],
      );
      assert(!JSON.stringify(sent).includes("株式会社サンプル商店"));
      assert(!JSON.stringify(sent).includes("hearing-sheet.xlsx"));
      const before = saves().length;
      await click(
        document.querySelector('[data-action="draftApply"][data-mode="append"]'),
      );
      const after = JSON.stringify(saves().slice(before));
      assert(!after.includes("株式会社サンプル商店") && !after.includes("ターゲット"));
      assert($("lists-tab-hearing"));
      assert.equal($("sheet-title"), null, "添付の中身は入れたあと消す");
    },
  );
  await check("v1.2 sheet attach: unsupported files show a clear error", async () => {
    await window.koeTest.fixture("S8-settings");
    await attach(new File(["%PDF-1.7"], "sheet.pdf"));
    await settle(() => document.querySelector(".sheet-error"));
    assert(document.querySelector(".sheet-error").textContent.includes("PDF は読めません"));
    assert.equal($("draft-hearing").disabled, false, "仕事があれば作れる");
  });
  const sheetFile = async (name) =>
    new File([await readFile(path.join(root, "tests/fixtures", name))], name);
  const sheetBoxes = () => [...document.querySelectorAll("[data-sheet-item]")];
  const isChecked = (b) => b.hasAttribute("checked");
  await check(
    "回帰: 一覧の並べ替え・追加・削除で再描画しても「今日話したいこと」と添付の選択は消えない",
    async () => {
      await window.koeTest.fixture("S12-lists");
      const memo = "納品前の確認をしたい。公開日とログイン情報の渡し方。";
      typeInto($("draft-topic"), memo);
      await attach(await sheetFile("hearing-sheet.xlsx"));
      await settle(() => $("sheet-title"));
      const target = sheetBoxes().find((b) => b.parentElement.textContent.includes("ご予算"));
      target.checked = false;
      event(target, "change");
      await click(
        document.querySelector('[data-action="listMove"][data-index="0"][data-dir="1"]'),
      );
      assert.equal($("draft-topic").value, memo, "並べ替えで消えない");
      typeInto($("list-add"), "追加の質問でしょうか。");
      await click(document.querySelector('[data-action="listAdd"]'));
      await click(document.querySelector('[data-action="listDelete"][data-index="0"]'));
      assert.equal($("draft-topic").value, memo, "追加・削除で消えない");
      assert($("sheet-title"), "添付も残る");
      const again = sheetBoxes().find((b) => b.parentElement.textContent.includes("ご予算"));
      assert.equal(isChecked(again), false, "外した選択も残る");
      assert.equal(sheetBoxes().filter(isChecked).length, 6);
      // 明示的に消したときだけ空になる。
      await click(document.querySelector('[data-action="draftTopicClear"]'));
      assert.equal($("draft-topic").value, "");
      await click(document.querySelector('[data-action="listMove"][data-index="0"][data-dir="1"]'));
      assert.equal($("draft-topic").value, "");
    },
  );
  await check(
    "回帰: 添付中に項目を全部外すと、自由記述が無ければ作れず案内を出す。自由記述があれば添付を使わずに作る",
    async () => {
      globalThis.__draftError = null;
      await window.koeTest.fixture("S8-settings");
      await attach(await sheetFile("hearing-sheet.xlsx"));
      await settle(() => $("sheet-title"));
      for (const box of sheetBoxes().filter(isChecked)) {
        const b = document.querySelector(`[data-sheet-item="${box.dataset.sheetItem}"]`);
        b.checked = false;
        event(b, "change");
      }
      assert.equal(sheetBoxes().filter(isChecked).length, 0);
      assert(document.querySelector('[data-field="job"]').value, "仕事は入っている");
      assert.equal($("draft-hearing").disabled, true, "初回ヒアリングを勝手に作らない");
      assert($("draft-note").textContent.includes("1つ以上選んでください"));
      const count = calls.filter((m) => m.command === "draftHearing").length;
      typeInto($("draft-topic"), "公開日だけ確かめたい");
      assert.equal($("draft-hearing").disabled, false);
      assert($("draft-note").textContent.includes("添付は使わず"));
      await click($("draft-hearing"));
      const sent = calls.filter((m) => m.command === "draftHearing");
      assert.equal(sent.length, count + 1);
      assert.equal(sent.at(-1).topic, "公開日だけ確かめたい");
      assert.equal(sent.at(-1).sheetItems, undefined, "添付は送らない");
    },
  );
  await check(
    "回帰: 見出しが無く列の役割を決められない表は通さず、列を選ぶと読む",
    async () => {
      await window.koeTest.fixture("S8-settings");
      await attach(await sheetFile("no-header-3cols.csv"));
      await settle(() => $("sheet-title"));
      assert(document.querySelector(".sheet-map"), "列を選ぶ欄を出す");
      assert.equal(sheetBoxes().length, 0, "誤判定で項目を作らない");
      const labelSel = document.querySelector('[data-map-role="label"]');
      const answerSel = document.querySelector('[data-map-role="answer"]');
      Object.defineProperty(labelSel, "value", { value: "0", configurable: true });
      Object.defineProperty(answerSel, "value", { value: "1", configurable: true });
      await click(document.querySelector('[data-action="sheetMap"]'));
      const labels = sheetBoxes().map((b) => [
        b.parentElement.textContent.split(" ")[0].replace("記入済み", "").trim(),
        isChecked(b),
      ]);
      assert.deepEqual(labels, [
        ["会社名", false],
        ["ご予算", true],
        ["納期", true],
      ]);
    },
  );
  // 設定画面の「今日の項目」欄から保存して、パネルの一覧を差し替える。
  const showWith = async (hearing) => {
    await window.koeTest.fixture("S8-settings");
    const field = document.querySelector('[data-field="hearing"]');
    field.value = hearing.join("\n");
    event(field, "change");
    await flush();
    assert.equal(cfg.hearing.length, hearing.length);
  };
  await check(
    "回帰: 30問で満杯なら追加を押せず案内し、29問なら1問だけ足して残りの案を残す（表示の数と実際の追加数が一致）",
    async () => {
      const draftApplyButton = () =>
        document.querySelector('[data-action="draftApply"][data-mode="append"]');
      const full = Array.from({ length: 30 }, (_, i) => `既存の質問${i + 1}でしょうか。`);
      await showWith(full);
      globalThis.__draftError = null;
      await click($("draft-hearing"));
      assert.equal(draftApplyButton().disabled, true, "満杯なら追加を押せない");
      assert($("draft-capacity").textContent.includes("満杯"));
      assert($("draft-capacity").textContent.includes("置き換え"));
      // 29問: あと1問。2問選ぶと1問足して1問は案に残す。
      await showWith(full.slice(0, 29));
      await click($("draft-hearing"));
      const boxes = [...document.querySelectorAll("[data-draft-index]")];
      for (const b of boxes.slice(2)) {
        const box = document.querySelector(`[data-draft-index="${b.dataset.draftIndex}"]`);
        box.checked = false;
        event(box, "change");
      }
      assert($("draft-capacity").textContent.includes("あと 1 問追加できます"));
      assert.equal($("draft-count").textContent, "1");
      const savesBefore = saves().length;
      await click(draftApplyButton());
      const saved = saves().at(-1).patch.hearing;
      assert.equal(saves().length, savesBefore + 1);
      assert.equal(saved.length, 30);
      assert.equal(saved.at(-1), draftQuestions[0]);
      const left = [...document.querySelectorAll("[data-draft-index]")];
      assert.equal(left.length, 1, "入りきらない案は残す");
      assert(left[0].parentElement.textContent.includes(draftQuestions[1]));
      assert($("notice").textContent.includes("1 問追加しました"));
      assert($("notice").textContent.includes("案に残しています"));
      // 重複は足さない（表示も実際も 0）。
      await showWith([...full.slice(0, 5), draftQuestions[1]]);
      await click($("draft-hearing"));
      assert.equal($("draft-count").textContent, String(draftQuestions.length - 1));
      assert($("draft-capacity").textContent.includes("同じ 1 問は足しません"));
    },
  );
  await check(
    "回帰: 一覧の画面のタブを左右・Home・End で切り替え、フォーカスも移る（シートも同じ）",
    async () => {
      await window.koeTest.fixture("S12-lists");
      $("lists-tab-hearing").focus();
      event($("lists-tab-hearing"), "keydown", { key: "ArrowRight" });
      await flush();
      await flush();
      assert.equal(document.activeElement.id, "lists-tab-phrases");
      assert.equal($("lists-tab-phrases").getAttribute("aria-selected"), "true");
      assert.equal($("lists-tab-phrases").getAttribute("tabindex"), "0");
      assert.equal(document.querySelector(".list-editor").dataset.list, "phrases");
      event($("lists-tab-phrases"), "keydown", { key: "Home" });
      await flush();
      await flush();
      assert.equal(document.activeElement.id, "lists-tab-hearing");
      event($("lists-tab-hearing"), "keydown", { key: "End" });
      await flush();
      await flush();
      assert.equal(document.activeElement.id, "lists-tab-phrases");
      event($("lists-tab-phrases"), "keydown", { key: "ArrowLeft" });
      await flush();
      await flush();
      assert.equal(document.activeElement.id, "lists-tab-hearing");
      await window.koeTest.fixture("S11-hearing");
      $("tab-hearing").focus();
      event($("tab-hearing"), "keydown", { key: "End" });
      await flush();
      assert.equal(document.activeElement.id, "tab-phrases");
    },
  );
  await check(
    "回帰: 途中の列が空の表は列を選ぶ欄を出し、空の B 列が記入欄の初期値。自動で読んだ表も選び直せる",
    async () => {
      await window.koeTest.fixture("S8-settings");
      await attach(await sheetFile("empty-middle.xlsx"));
      await settle(() => $("sheet-title"));
      assert.equal(sheetBoxes().length, 0);
      const answer = document.querySelector('.sheet-map:not(.sheet-remap) [data-map-role="answer"]');
      const selected = [...answer.querySelectorAll("option")].find((o) => o.hasAttribute("selected"));
      assert.equal(selected.getAttribute("value"), "1");
      assert(selected.textContent.includes("空の列"));
      await click(document.querySelector('[data-action="sheetMap"]'));
      assert.equal(sheetBoxes().length, 3);
      assert.equal(sheetBoxes().filter(isChecked).length, 3, "全部未記入として選ぶ");
      // 自動で読んだ表（補足列あり）にも「列を選び直す」を出す。
      await window.koeTest.fixture("S8-settings");
      await attach(await sheetFile("with-notes.csv"));
      await settle(() => $("sheet-title"));
      assert(document.querySelector(".sheet-remap"), "選び直す導線");
      const remap = document.querySelector(".sheet-remap");
      const ans = remap.querySelector('[data-map-role="answer"]');
      Object.defineProperty(ans, "value", { value: "2", configurable: true });
      await click(remap.querySelector('[data-action="sheetMap"]'));
      assert.equal(sheetBoxes().filter(isChecked).length, 0, "C 列を記入欄にすると記入済みになる");
    },
  );
  await check(
    "回帰: 保存に失敗したら入力を残し、タブ・戻る・編集を終えるで画面を移らない。閉じても入力が戻り、もう一度保存できる",
    async () => {
      const typed = "公開前にテストをお願いいたします。";
      const first = () => document.querySelector('[data-edit-index="0"]');
      await window.koeTest.fixture("S12-lists");
      globalThis.__saveError = "接続し直しています";
      typeInto(first(), typed, "change");
      await flush();
      assert($("edit-status").textContent.includes("保存できませんでした"));
      await click($("lists-tab-phrases"));
      assert.equal(document.querySelector(".list-editor").dataset.list, "hearing", "タブを移らない");
      assert.equal(first().value, typed);
      event($("lists-tab-hearing"), "keydown", { key: "ArrowRight" });
      await flush();
      await flush();
      assert.equal(document.querySelector(".list-editor").dataset.list, "hearing");
      await click(document.querySelector('[data-action="listsBack"]'));
      assert($("lists-tab-hearing"), "戻らない");
      assert.equal(first().value, typed);
      // シートの編集でも同じ。
      await window.koeTest.fixture("S11-hearing");
      await click(document.querySelector('[data-action="sheetEdit"]'));
      typeInto(first(), typed, "change");
      await flush();
      const current = document.querySelector(".list-editor").dataset.list,
        other = current === "hearing" ? "phrases" : "hearing";
      await click($("tab-" + other));
      assert.equal(document.querySelector(".list-editor").dataset.list, current, "タブを移らない");
      await click(document.querySelector('[data-action="sheetEdit"]'));
      assert(first(), "編集を終えない");
      // 閉じても入力は残り、開き直すと「保存できていない変更」として戻る。
      await click(document.querySelector('[data-action="closeSheet"]'));
      await flush();
      await click($("hearing"));
      await click(document.querySelector('[data-action="sheetEdit"]'));
      assert.equal(first().value, typed);
      assert(document.querySelector(".edit-unsaved"));
      globalThis.__saveError = null;
      await click(document.querySelector('[data-action="listRetry"]'));
      assert.equal(saves().at(-1).patch[current][0], typed);
      assert.equal(document.querySelector(".edit-unsaved"), null);
      await click($("tab-" + other));
      assert.equal(document.querySelector(".list-editor").dataset.list, other, "保存できたら移る");
    },
  );
  await check("利用料の説明を生成ボタンと作り置きの説明の近くに出す", async () => {
    await window.koeTest.fixture("S12-lists");
    assert(document.querySelector(".draft-hearing").textContent.includes("利用料がかかります"));
    assert(document.querySelector(".lists-note").textContent.includes("利用料がかかります"));
    await window.koeTest.fixture("S8-settings");
    assert(
      document
        .querySelector('[data-field="hearing"]')
        .closest("section")
        .textContent.includes("利用料がかかります"),
    );
  });
} catch (e) {
  result.errors.push(e.stack);
}
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "dom-smoke.json"),
  JSON.stringify(result, null, 2) + "\n",
);
const fails = result.checks.filter((c) => c.status === "fail");
console.log(
  JSON.stringify(
    {
      pass: result.checks.length - fails.length,
      fail: fails.length,
      errors: result.errors,
      failures: fails,
    },
    null,
    2,
  ),
);
if (fails.length || result.errors.length) process.exitCode = 1;
