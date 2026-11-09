// 「今日の項目を作る」を開発用中継（127.0.0.1:8787）経由で実際に生成して記録する。
// 中継は with-env-keys.sh で起動済みのものを使う。ここではキーを読まず、ダミーのキーを送る。
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? null : process.argv[i + 1];
};
const out = path.resolve(root, arg("--out") || ".tmp/hearing-gen");
if (!out.startsWith(root + path.sep))
  throw new Error("Output must remain inside the repository");
const { draftHearingQuestions } = await import(
  path.join(root, "dist/dev/openai.js")
);
const { configWith } = await import(path.join(root, "dist/dev/config.js"));
const cfg = configWith({ apiKey: "dummy-key-proxy-only" });
const { readSheetFile, extractSheetItems } = await import(
  path.join(root, "dist/dev/sheet-import.js")
);
const { readFile } = await import("node:fs/promises");
const sheet = await readSheetFile(
  new File(
    [await readFile(path.join(root, "tests/fixtures/hearing-sheet.xlsx"))],
    "hearing-sheet.xlsx",
  ),
);
// 画面と同じく、空欄の項目だけを送る。
const sheetItems = extractSheetItems(sheet)
  .filter((i) => !i.filled)
  .map(({ label, hint }) => ({ label, hint }));
const numberedItems = extractSheetItems(
  await readSheetFile(
    new File(
      [await readFile(path.join(root, "tests/fixtures/with-notes.csv"))],
      "with-notes.csv",
    ),
  ),
)
  .filter((i) => !i.filled)
  .map(({ label, hint }) => ({ label, hint }));
const cases = [
  {
    id: "web-designer-first",
    input: { job: "Web デザイナー", about: "", topic: "" },
  },
  { id: "tax-accountant-first", input: { job: "税理士", about: "", topic: "" } },
  {
    id: "web-designer-before-delivery",
    input: {
      job: "Web デザイナー",
      about: "小さなお店のホームページ制作",
      topic:
        "納品前の最終確認をしたい。修正の残りがないか、公開日はいつにするか、サーバーやドメインのログイン情報をどう渡すか、公開後の更新や保守を続けて頼みたいか、請求書の宛名と支払い時期を確かめたい。",
    },
  },
  {
    id: "pasted-ai-memo",
    input: {
      job: "動画編集",
      about: "YouTube の編集を請け負っている",
      topic: `## Claude との壁打ちメモ（2026-11-08）
- 今日は初稿（第1話）のフィードバックをもらう回
- テロップの色・フォントの好みを確認
- BGM の雰囲気（明るめ？落ち着き？）
- 尺は10分前後で OK か
- 修正は2回までの契約 → 3回目以降は追加料金になることをやんわり伝えたい
- （内輪）前回の返信が遅かった。急かしすぎない
- （内輪）単価交渉は今日はしない。様子見
- サムネも頼みたいか聞く
- 次回の素材の受け渡し日`,
    },
  },
];
cases.push(
  {
    id: "attached-xlsx-sheet",
    input: { job: "Web デザイナー", about: "", topic: "", sheetItems },
  },
  {
    id: "single-blank-item",
    input: { job: "Web デザイナー", about: "", topic: "", sheetItems: [{ label: "ご予算", hint: "" }] },
  },
  {
    id: "attached-numbered-notes-csv",
    input: { job: "Web デザイナー", about: "", topic: "", sheetItems: numberedItems },
  },
  {
    id: "pasted-tsv-sheet",
    input: {
      job: "税理士",
      about: "",
      topic:
        "項目\tご記入欄\n■ 基本情報\t\n会社名・屋号\t架空商店\n業種\t小売\n従業員数\t\n年間の売上の規模\t\n■ ご相談内容\t\nご相談したいこと\t\n今の記帳の方法\t☐ 自分で ☐ 外注 ☐ まだ\n決算月\t3月\n希望の連絡方法\t\nご予算（月額）\t",
    },
  },
);
const results = [];
for (const c of cases) {
  const started = Date.now();
  try {
    const questions = await draftHearingQuestions(cfg, c.input);
    results.push({
      ...c,
      ms: Date.now() - started,
      questions: questions.map((q) => ({ text: q, chars: [...q].length })),
    });
  } catch (e) {
    results.push({ ...c, ms: Date.now() - started, error: e.message });
  }
}
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "hearing-gen.json"),
  JSON.stringify(
    { at: new Date().toISOString(), model: cfg.replyModel, results },
    null,
    2,
  ) + "\n",
);
for (const r of results) {
  console.log(`\n## ${r.id}（${r.ms}ms）`);
  if (r.error) console.log("ERROR: " + r.error);
  else r.questions.forEach((q, i) => console.log(`${i + 1}. ${q.text}（${q.chars}字）`));
}
if (results.some((r) => r.error)) process.exitCode = 1;
