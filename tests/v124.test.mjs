import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { configWith, DEFAULTS, defaultIntro, NEEDS, sanitizeConfig } from "../config.js";
import { HEARING_DRAFT_PROMPT } from "../openai.js";

const src = (f) => readFile(new URL(`../${f}`, import.meta.url), "utf8");

test("v1.2.4: 既定は「耳が聞こえない」で、今までのはじめの一言と同じ文", () => {
  assert.equal(DEFAULTS.need, "hearing");
  assert.equal(defaultIntro("山田"), defaultIntro("山田", "hearing"));
  assert.match(defaultIntro("山田"), /山田と申します。.*耳が聞こえないため、お話しいただいた内容を文字起こしで読み、AI の声でお返事しております。/);
});

test("v1.2.4: 伝え方ごとに、はじめの一言の理由が変わる", () => {
  assert.deepEqual(NEEDS.map(([v]) => v), ["hearing", "speech", "both", "none"]);
  const speech = defaultIntro("山田", "speech");
  assert.match(speech, /声で話すことが難しいため、入力した文を AI の声で読み上げて/);
  assert.doesNotMatch(speech, /耳が聞こえ|文字起こし/);
  assert.match(defaultIntro("", "both"), /耳が聞こえず、声で話すことも難しいため/);
  const none = defaultIntro("山田", "none");
  assert.doesNotMatch(none, /耳|難しい|障害/);
  // どれも、名前・挨拶・締めは共通
  for (const [v] of NEEDS) {
    const t = defaultIntro("山田", v);
    assert.match(t, /^はじめまして、山田と申します。本日はお時間をいただき、ありがとうございます。/);
    assert.match(t, /どうぞよろしくお願いいたします。$/);
  }
});

test("v1.2.4: 知らない伝え方は保存しない", () => {
  assert.equal(sanitizeConfig({ need: "speech" }).need, "speech");
  assert.equal("need" in sanitizeConfig({ need: "x" }), false);
  assert.equal(configWith({ need: "x" }).need, "hearing");
});

test("v1.2.4: 初回設定と設定に「会議での伝え方」があり、変えると自動の一言が変わる", async () => {
  const code = await src("sidepanel.js");
  assert.equal((code.match(/\$\{needField\(\)\}/g) || []).length, 2);
  assert.match(code, /key === "need" && !cfg\.introEdited\)\s*patch\.intro = defaultIntro\(cfg\.name, value\)/);
  assert.match(code, /defaultIntro\(patch\.name, patch\.need\)/);
});

test("v1.2.4: AI への指示は、本人を「耳が聞こえない」と決めつけない", async () => {
  const code = await src("openai.js");
  assert.doesNotMatch(code, /耳が聞こえない本人/);
  assert.match(HEARING_DRAFT_PROMPT, /^本人が、お客様との会議で、AI の声で読み上げて/);
});

test("v1.2.4: 会話中は「会話を停止」を歯車の外に出し、読み上げ中は隠す", async () => {
  const code = await src("sidepanel.js");
  assert.match(code, /<button id="end-session" class="end-session" data-action="confirmStop" hidden>/);
  assert.match(code, /\$\("end-session"\)\.hidden =\s*!state\.active \|\| !!state\.ended \|\| !\$\("stop-voice"\)\.hidden/);
  // 歯車のメニューにも残す（今までの場所で探す人のため）
  assert.match(code, /role="menuitem" data-action="confirmStop"/);
});
