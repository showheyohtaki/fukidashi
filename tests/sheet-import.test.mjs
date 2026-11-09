// v1.2: 完成済みのヒアリングシートの読み取り（API を呼ばない）。見本は tests/fixtures/make-sheets.py で作る架空の内容。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  readSheetFile,
  extractSheetItems,
  analyzeSheet,
  isBlankValue,
  parseDelimited,
  SHEET_MAX_BYTES,
  SHEET_MAX_CHARS,
} from "../sheet-import.js";
import { configWith } from "../config.js";
import { draftHearingQuestions, HEARING_DRAFT_PROMPT } from "../openai.js";

const fixture = async (name) =>
  new File([await readFile(new URL(`./fixtures/${name}`, import.meta.url))], name);
const view = (items) =>
  items.map((i) => `${i.filled ? "記入済" : "空欄"}:${i.sheet}:${i.label}`);

test("xlsx: 複数シート・共有文字列（ふりがな除く）・インライン文字列・数値・空欄セル・列の飛び・見出し行", async () => {
  const parsed = await readSheetFile(await fixture("hearing-sheet.xlsx"));
  assert.equal(parsed.kind, "xlsx");
  assert.deepEqual(
    parsed.sheets.map((s) => s.name),
    ["基本情報", "デザイン"],
  );
  assert.equal(parsed.truncated, false);
  const basic = parsed.sheets[0].rows;
  assert.deepEqual(basic[1], ["会社名", "株式会社サンプル商店"]);
  assert.deepEqual(basic[2], ["業種", "", "飲食（カフェ）"]);
  assert.deepEqual(basic[3], ["ご担当者名"]);
  const items = extractSheetItems(parsed);
  assert.deepEqual(view(items), [
    "記入済:基本情報:会社名",
    "記入済:基本情報:業種",
    "空欄:基本情報:ご担当者名",
    "空欄:基本情報:ご予算",
    "空欄:基本情報:納期",
    "空欄:基本情報:ターゲット",
    "記入済:基本情報:ページ数",
    "空欄:基本情報:公開後の更新",
    "空欄:デザイン:参考サイト",
    "記入済:デザイン:好きな色",
    "空欄:デザイン:NG 事項",
  ]);
  assert(!items.some((i) => i.label.includes("制作について")), "見出しだけの行は項目にしない");
  assert(!items.some((i) => i.label === "項目"), "列見出しの行は項目にしない");
  assert.equal(
    items.find((i) => i.label === "公開後の更新").hint,
    "☐ 自社で行う ☐ 依頼したい",
  );
  assert.equal(items.find((i) => i.label === "会社名").hint, "");
  // シートを選ぶと、そのシートの項目だけになる。
  assert.deepEqual(
    view(extractSheetItems(parsed, ["デザイン"])),
    ["空欄:デザイン:参考サイト", "記入済:デザイン:好きな色", "空欄:デザイン:NG 事項"],
  );
});

test("docx: 表の行と、表の外の「項目：値」の段落を読む。題名・見出し・説明文は項目にしない", async () => {
  const parsed = await readSheetFile(await fixture("hearing-sheet.docx"));
  assert.equal(parsed.kind, "docx");
  assert.deepEqual(view(extractSheetItems(parsed)), [
    "記入済:文書:会社名",
    "空欄:文書:ご予算",
    "空欄:文書:納期",
    "記入済:文書:ご担当者",
    "空欄:文書:ご希望の連絡方法",
    "記入済:文書:業種",
  ]);
});

test("csv・tsv・md・txt: 引用符の中のカンマ、Markdown の表と箇条書き、「項目：」を読む", async () => {
  const labels = async (name) =>
    view(extractSheetItems(await readSheetFile(await fixture(name)))).map((x) =>
      x.replace(":本文", ""),
    );
  assert.deepEqual(await labels("hearing-sheet.csv"), [
    "記入済:会社名",
    "空欄:ご予算",
    "空欄:納期, 公開日",
    "記入済:ターゲット",
  ]);
  assert.deepEqual(await labels("hearing-sheet.tsv"), [
    "記入済:会社名",
    "空欄:ご予算",
    "空欄:納期",
  ]);
  assert.deepEqual(await labels("hearing-sheet.md"), [
    "記入済:会社名",
    "空欄:ご予算",
    "空欄:納期",
    "記入済:ターゲット",
  ]);
  assert.deepEqual(await labels("hearing-sheet.txt"), [
    "記入済:会社名",
    "空欄:ご予算",
    "空欄:納期",
  ]);
  assert.deepEqual(parseDelimited('a,"b, c",\n"x ""y""",z', ","), [
    ["a", "b, c", ""],
    ['x "y"', "z"],
  ]);
});

test("空欄の判定: 空・記号だけ・「ご記入ください」・未チェックの選択肢は空欄、チェック済みや値は記入済み", () => {
  for (const v of ["", " ", "-", "ー", "―", "・", "ご記入ください", "記入欄", "☐ あり ☐ なし", "□ A □ B"])
    assert.equal(isBlankValue(v), true, v);
  for (const v of ["☑ あり ☐ なし", "50万円", "0", "未定", "青系"])
    assert.equal(isBlankValue(v), false, v);
});

test("文字数の上限: 2万字を超えたら先頭から切って知らせる", async () => {
  const long = Array.from({ length: 2000 }, (_, i) => `項目${i}：${"あ".repeat(20)}`).join("\n");
  const parsed = await readSheetFile(new File([long], "long.txt"));
  assert.equal(parsed.truncated, true);
  const total = parsed.sheets
    .flatMap((s) => s.rows)
    .flat()
    .join("").length;
  assert(total <= SHEET_MAX_CHARS, String(total));
  assert.equal(SHEET_MAX_CHARS, 20000);
  const short = await readSheetFile(await fixture("hearing-sheet.txt"));
  assert.equal(short.truncated, false);
});

test("読めない形式は分かるエラーにする（PDF・画像・旧形式・パスワード付き・5MB 超・壊れたファイル）", async () => {
  const cases = [
    [new File(["%PDF-1.7"], "sheet.pdf"), /PDF は読めません/],
    [new File(["x"], "photo.png"), /画像は読めません/],
    [new File(["x"], "old.xls"), /\.xls.*読めません/],
    [new File(["x"], "old.doc"), /\.doc.*読めません/],
    [new File(["x"], "sheet.numbers"), /読める形式は \.xlsx/],
    [await fixture("encrypted.xlsx"), /パスワード付き/],
    [new File(["これは zip ではない"], "broken.docx"), /開けませんでした/],
  ];
  for (const [file, message] of cases)
    await assert.rejects(readSheetFile(file), message, file.name);
  const big = { name: "big.xlsx", size: SHEET_MAX_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) };
  await assert.rejects(readSheetFile(big), /5MB まで/);
});

function mockFetch(t) {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                questions: [
                  "ご担当者様のお名前を教えていただけますでしょうか",
                  "ご予算の目安を教えていただけますでしょうか。",
                  "ご希望の納期をお聞かせいただけますでしょうか。",
                ],
              }),
            },
          },
        ],
      }),
    };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return bodies;
}

test("シートの項目を渡すと、空欄の項目名と選択肢だけを送る（記入済みの値・ファイル名は送らない）", async (t) => {
  const bodies = mockFetch(t);
  const parsed = await readSheetFile(await fixture("hearing-sheet.xlsx"));
  const sheetItems = extractSheetItems(parsed)
    .filter((i) => !i.filled)
    .map(({ label, hint }) => ({ label, hint }));
  const out = await draftHearingQuestions(configWith({ apiKey: "dummy" }), {
    job: "",
    sheetItems,
  });
  assert.equal(out[0], "ご担当者様のお名前を教えていただけますでしょうか。", "句点を足す");
  const user = bodies[0].messages[1].content;
  assert(user.includes("埋めたいシートの項目"));
  assert(user.includes("- ご担当者名"));
  assert(user.includes("- 公開後の更新（選択肢: ☐ 自社で行う ☐ 依頼したい）"));
  assert(!user.includes("株式会社サンプル商店"), "記入済みの値は送らない");
  assert(!user.includes("hearing-sheet.xlsx"));
  assert(!user.includes("初回ヒアリングの項目を作る"));
  assert.equal(
    bodies[0].response_format.json_schema.schema.properties.questions.maxItems,
    sheetItems.length,
    "シート由来は選んだ項目数まで",
  );
  for (const rule of ["最大20問", "似た項目は1問にまとめ", "見出しだけの行", "既に値が入っている項目も質問にしない", "タブ区切り"])
    assert(HEARING_DRAFT_PROMPT.includes(rule), rule);
});

test("スプレッドシートからコピーした表（TSV）の貼り付けは、空欄の項目だけを質問の対象にし、記入済みの値と見出しは送らない", async (t) => {
  const bodies = mockFetch(t);
  const tsv =
    "項目\tご記入欄\n■ 基本情報\t\n会社名\t株式会社サンプル商店\nご予算\t\n納期\t-\nターゲット\t30代の女性\n公開後の更新\t☐ 自社で ☐ 依頼";
  await draftHearingQuestions(configWith({ apiKey: "dummy" }), {
    job: "Web デザイナー",
    topic: "今日は残りの項目を埋めたい\n" + tsv,
  });
  const user = bodies[0].messages[1].content;
  assert(user.includes("今日は残りの項目を埋めたい"), "表以外のメモは残す");
  assert(user.includes("- ご予算"));
  assert(user.includes("- 納期"));
  assert(user.includes("- 公開後の更新（選択肢: ☐ 自社で ☐ 依頼）"));
  assert(!user.includes("株式会社サンプル商店"), "記入済みの値は送らない");
  assert(!user.includes("30代の女性"));
  assert(!user.includes("- ターゲット"), "記入済みの項目は質問にしない");
  assert(!user.includes("基本情報"), "見出しの行は質問にしない");
  // 2行以下のタブは表とみなさず、そのまま送る。
  const bodies2 = mockFetch(t);
  await draftHearingQuestions(configWith({ apiKey: "dummy" }), {
    job: "税理士",
    topic: "決算\t3月\n相談したいこと",
  });
  assert(bodies2[0].messages[1].content.includes("決算\t3月"));
});

// ---- レビュー指摘（9d82ffa）の回帰: 番号列・補足列・見出しの無い表 ----
const read = async (name) => readSheetFile(await fixture(name));
test("回帰: No.,項目,回答 の表は、番号を項目にせず、回答が空の項目を空欄として読む（CSV・XLSX）", async () => {
  for (const name of ["numbered.csv", "numbered.xlsx"]) {
    const items = extractSheetItems(await read(name));
    assert.deepEqual(
      items.map((i) => [i.label, i.filled]),
      [
        ["会社名", false],
        ["予算", false],
        ["納期", false],
      ],
      name,
    );
  }
});
test("回帰: 項目,回答,補足 の表は、補足を回答とみなさず、見出しの行も項目にしない（CSV・XLSX）", async () => {
  for (const name of ["with-notes.csv", "with-notes.xlsx"]) {
    const { items, tables } = analyzeSheet(await read(name));
    assert.deepEqual(
      items.map((i) => [i.label, i.filled]),
      [
        ["ご予算", false],
        ["納期", false],
      ],
      name,
    );
    assert.deepEqual(tables[0].roles.note, [2], name);
    assert.deepEqual(tables[0].roles.answer, [1], name);
  }
});
test("回帰: Word の表にも同じ原則（No.・項目・回答・補足）を当てる", async () => {
  const items = extractSheetItems(await read("numbered.docx"));
  assert.deepEqual(
    items.map((i) => [i.label, i.filled]),
    [
      ["会社名", false],
      ["ご予算", false],
      ["納期", true],
    ],
  );
});
test("見出しの無い表: 数字だけの列は番号として外す。3列以上で記入欄を決められない表は通さず、列を選んでもらう", async () => {
  assert.deepEqual(
    extractSheetItems(await read("numbered-no-header.csv")).map((i) => [i.label, i.filled]),
    [
      ["会社名", true],
      ["ご予算", false],
      ["納期", false],
    ],
  );
  const parsed = await read("no-header-3cols.csv");
  const first = analyzeSheet(parsed);
  assert.equal(first.items.length, 0, "誤判定で通さない");
  assert.equal(first.tables.length, 1);
  assert.equal(first.tables[0].needsMapping, true);
  assert.deepEqual(
    first.tables[0].columns.map((c) => [c.name, c.samples[0]]),
    [
      ["A", "会社名"],
      ["B", "株式会社サンプル商店"],
      ["C", "正式名称で"],
    ],
  );
  // 利用者が「A が項目・B が記入欄」と選ぶと、C（補足）を使わずに読む。
  const key = first.tables[0].key;
  const picked = analyzeSheet(parsed, null, { [key]: { label: 0, answer: 1 } });
  assert.deepEqual(
    picked.items.map((i) => [i.label, i.filled]),
    [
      ["会社名", true],
      ["ご予算", false],
      ["納期", false],
    ],
  );
  assert.equal(picked.tables[0].chosen, true);
  // 「記入欄なし」を選ぶと、全部を空欄（聞く項目）として読む。
  const none = analyzeSheet(parsed, null, { [key]: { label: 0, answer: null } });
  assert(none.items.every((i) => !i.filled));
});
test("回帰: 見出しなしで途中の列が全部空（会社名,,法人名を記入）の表は曖昧として列を選ばせ、空の列を記入欄に選べる（CSV・XLSX）", async () => {
  for (const name of ["empty-middle.csv", "empty-middle.xlsx"]) {
    const parsed = await read(name);
    const first = analyzeSheet(parsed);
    assert.equal(first.items.length, 0, `${name}: 自動では読まない`);
    const table = first.tables[0];
    assert.equal(table.needsMapping, true, name);
    assert.deepEqual(
      table.columns.map((c) => [c.name, c.samples.length]),
      [
        ["A", 3],
        ["B", 0],
        ["C", 3],
      ],
      `${name}: 空の B 列も選べる`,
    );
    assert.deepEqual(table.suggestion, { label: 0, answer: 1 }, `${name}: 空の列を記入欄の候補に`);
    const picked = analyzeSheet(parsed, null, { [table.key]: table.suggestion });
    assert.deepEqual(
      picked.items.map((i) => [i.label, i.filled]),
      [
        ["会社名", false],
        ["ご予算", false],
        ["納期", false],
      ],
      name,
    );
  }
});
test("自動で読んだ表にも、列を選び直すための割り当て（suggestion）を返す", async () => {
  const { tables } = analyzeSheet(await read("with-notes.csv"));
  assert.deepEqual(tables[0].suggestion, { label: 0, answer: 1 });
  assert.equal(tables[0].needsMapping, false);
});
