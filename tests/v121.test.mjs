import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = (f) => readFile(new URL(`../${f}`, import.meta.url), "utf8");
const body = (code, name) => {
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = code.indexOf("\nfunction ", start + 1);
  return code.slice(start, next < 0 ? undefined : next);
};

test("v1.2.1: 今日の議題は開始前の画面だけに置き、設定・初回設定・一覧の画面には置かない", async () => {
  const code = await src("sidepanel.js");
  assert.match(body(code, "prepMarkup"), /today-prep[\s\S]*draftControls\(\)/);
  // 会議のタブでない画面（会議の前）と、開始前の画面の両方に出す
  assert.equal((body(code, "emptyMarkup").match(/prepMarkup\(/g) || []).length, 2);
  for (const name of ["renderSettings", "renderWizard", "renderLists"])
    assert.doesNotMatch(body(code, name), /draftControls\(\)/, name);
  assert.match(code, /今日の議題を添付/);
  assert.doesNotMatch(code, /シートを添付/);
  // 確認の一覧が変わっても、入力中の欄は作り直さない
  assert.match(body(code, "renderCaptions"), /idleCheckMarkup\(\)/);
});

test("v1.2.1: 話者名は Meet の別ウィンドウ（Document PiP）も見て、本人のタイルを除く", async () => {
  const code = await src("meet-speakers.js");
  assert.match(code, /documentPictureInPicture/);
  assert.match(code, /"enter"/);
  assert.match(code, /自分を\|yourself/);
});

test("v1.2.2: 項目案の文はその場で直せ、自分で質問を足せ、今の項目へ行って開始前の画面に戻れる", async () => {
  const code = await src("sidepanel.js");
  assert.match(body(code, "draftMarkup"), /data-draft-text=/);
  assert.match(body(code, "draftControls"), /id="draft-own"/);
  assert.match(code, /case "draftOwn"/);
  assert.match(code, /case "draftRemove"/);
  assert.match(code, /listsBack === "meeting"/);
  // 空にした文は追加の対象にしない
  assert.match(body(code, "draftPlan"), /trim\(\)/);
});
