// 完成済みのヒアリングシート（.xlsx / .docx / .csv / .tsv / .md / .txt）を拡張の中で読み、
// 「項目名」と「記入済みかどうか」を取り出す。外部へのアップロードはしない。
// .xlsx / .docx は zip＋XML。ブラウザ標準の DecompressionStream("deflate-raw") で展開する（外部ライブラリなし）。
export const SHEET_MAX_BYTES = 5 * 1024 * 1024;
export const SHEET_MAX_CHARS = 20000;
export const SHEET_MAX_ITEMS = 80;
export const SHEET_ACCEPT = ".xlsx,.docx,.csv,.tsv,.md,.txt";
const SUPPORTED = ["xlsx", "docx", "csv", "tsv", "md", "txt"];
const REJECT = {
  pdf: "PDF は読めません。表や文章をコピーして「今日話したいこと」の欄に貼り付けてください",
  xls: "古い Excel 形式（.xls）は読めません。.xlsx で保存し直してください",
  doc: "古い Word 形式（.doc）は読めません。.docx で保存し直してください",
  xlsm: "マクロ付きの Excel（.xlsm）は読めません。.xlsx で保存し直してください",
};
const IMAGE = /^(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/;
export class SheetError extends Error {}

const ext = (name) => (/\.([^.]+)$/.exec(String(name || "")) || [])[1]?.toLowerCase() || "";

// ---- zip ------------------------------------------------------------------
async function inflateRaw(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 中央ディレクトリの終端（EOCD）を後ろから探す。
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new SheetError("ファイルを開けませんでした（壊れているか、形式が違います）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const flags = view.getUint16(p + 8, true),
      method = view.getUint16(p + 10, true),
      size = view.getUint32(p + 20, true),
      nameLen = view.getUint16(p + 28, true),
      extraLen = view.getUint16(p + 30, true),
      commentLen = view.getUint16(p + 32, true),
      local = view.getUint32(p + 42, true),
      name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new SheetError("パスワード付きのファイルは読めません");
    files.set(name, { method, size, local });
  }
  return {
    names: [...files.keys()],
    async text(name) {
      const f = files.get(name);
      if (!f) return null;
      const start =
        f.local + 30 + view.getUint16(f.local + 26, true) + view.getUint16(f.local + 28, true);
      const data = bytes.subarray(start, start + f.size);
      const raw =
        f.method === 0
          ? data
          : f.method === 8
            ? await inflateRaw(data)
            : null;
      if (!raw) throw new SheetError("この圧縮形式のファイルは読めません");
      return decoder.decode(raw);
    },
  };
}

// ---- XML（正規表現で読む。DOMParser の無い試験環境でも同じ結果になるように） ----
export function xmlText(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}
const attr = (tag, name) =>
  (new RegExp(`\\s${name}="([^"]*)"`).exec(tag) || [])[1];
const runs = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((m) => xmlText(m[1]))
    .join("");
const colIndex = (ref) => {
  const letters = /^[A-Z]+/.exec(ref || "")?.[0] || "";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

async function readXlsx(zip) {
  const workbook = await zip.text("xl/workbook.xml");
  if (!workbook) throw new SheetError("Excel のシートを見つけられませんでした");
  const rels = (await zip.text("xl/_rels/workbook.xml.rels")) || "";
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attr(m[0], "Id"),
      attr(m[0], "Target"),
    ]),
  );
  const shared = [];
  const sst = await zip.text("xl/sharedStrings.xml");
  if (sst)
    for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g))
      // ふりがな（rPh）は読まない。
      shared.push(runs(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""), "t"));
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = xmlText(attr(m[0], "name") || `シート${sheets.length + 1}`),
      id = attr(m[0], "r:id");
    let target = targets.get(id) || `worksheets/sheet${sheets.length + 1}.xml`;
    target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = await zip.text("xl/" + target);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(" " + c[1], "t"),
          body = c[2] || "";
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        let text = "";
        if (type === "s") text = shared[Number(v)] ?? "";
        else if (type === "inlineStr") text = runs(body, "t");
        else if (type === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else if (v != null) text = xmlText(v);
        const i = colIndex(attr(" " + c[1], "r"));
        cells[i >= 0 ? i : cells.length] = text.trim();
      }
      rows.push(Array.from(cells, (x) => x ?? ""));
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new SheetError("Excel のシートを見つけられませんでした");
  return { kind: "xlsx", sheets };
}

async function readDocx(zip) {
  const xml = await zip.text("word/document.xml");
  if (!xml) throw new SheetError("Word の本文を見つけられませんでした");
  const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [])[1] || xml;
  const para = (p) =>
    xmlText(
      p
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|\t|\n/g)
        ?.map((t) => t.replace(/<[^>]+>/g, ""))
        .join("") || "",
    ).trim();
  const rows = [];
  let tables = 0;
  const tag = (row, block) => Object.assign(row, { block });
  // 表（入れ子の表は外側の行として読む）と、表の外の段落を本文の順に読む。
  // 列の役割は表ごとに決めるので、行に表の番号（block）を付ける。
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith("<w:tbl>")) {
      const block = "表" + ++tables;
      for (const tr of m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g))
        rows.push(tag(
          [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) =>
            [...tc[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
              .map((p) => para(p[0]))
              .filter(Boolean)
              .join("\n"),
          ),
          block,
        ));
    } else {
      const text = para(m[0]);
      // 表の外の段落は「項目：値」「項目<TAB>値」として読む。
      if (text) rows.push(...parseTextRows(text).map((r) => tag(r, "本文")));
    }
  }
  return { kind: "docx", sheets: [{ name: "文書", rows }] };
}

export function parseDelimited(text, sep) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}
// テキスト・Markdown: 「項目: 値」「| 項目 | 値 |」「項目<TAB>値」、見出し（#）、箇条書き（- ）を行として読む。
export function parseTextRows(text) {
  const rows = [];
  for (let line of String(text).split(/\r?\n/)) {
    if (!line.trim() || /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    if (line.includes("\t")) {
      rows.push(line.split("\t").map((c) => c.trim()));
      continue;
    }
    line = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?!\[)/, "").replace(/^\s*[-*+]\s+(?=\[)/, "");
    const m = /^(.{1,60}?)\s*[:：]\s*(.*)$/.exec(line.trim());
    rows.push(m ? [m[1], m[2]] : [line.trim()]);
  }
  return rows;
}

export async function readSheetFile(file) {
  const name = String(file?.name || ""),
    kind = ext(name);
  if (REJECT[kind]) throw new SheetError(REJECT[kind]);
  if (IMAGE.test(kind)) throw new SheetError("画像は読めません。表や文章をコピーして「今日話したいこと」の欄に貼り付けてください");
  if (!SUPPORTED.includes(kind))
    throw new SheetError("読める形式は .xlsx・.docx・.csv・.tsv・.md・.txt です");
  if (file.size > SHEET_MAX_BYTES)
    throw new SheetError("ファイルが大きすぎます（5MB まで）");
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 4));
  let parsed;
  if (kind === "xlsx" || kind === "docx") {
    if (head[0] === 0xd0 && head[1] === 0xcf)
      throw new SheetError("パスワード付き、または古い形式のファイルは読めません");
    if (head[0] !== 0x50 || head[1] !== 0x4b)
      throw new SheetError("ファイルを開けませんでした（壊れているか、形式が違います）");
    const zip = await unzip(buffer);
    if (zip.names.includes("EncryptionInfo"))
      throw new SheetError("パスワード付きのファイルは読めません");
    parsed = kind === "xlsx" ? await readXlsx(zip) : await readDocx(zip);
  } else {
    let text = new TextDecoder().decode(buffer).replace(/^﻿/, "");
    if (text.includes("�"))
      try {
        text = new TextDecoder("shift_jis").decode(buffer);
      } catch {}
    const rows =
      kind === "csv"
        ? parseDelimited(text, ",")
        : kind === "tsv"
          ? parseDelimited(text, "\t")
          : parseTextRows(text);
    parsed = { kind, sheets: [{ name: "本文", rows }] };
  }
  return { fileName: name, ...limitChars(parsed) };
}
// 読み取る文字を SHEET_MAX_CHARS までに切る（先頭から）。
function limitChars(parsed) {
  let left = SHEET_MAX_CHARS,
    truncated = false;
  const sheets = [];
  for (const sheet of parsed.sheets) {
    const rows = [];
    for (const row of sheet.rows) {
      if (left <= 0) {
        truncated = true;
        break;
      }
      const cells = row.map((c) => {
        const text = String(c ?? "").slice(0, Math.max(0, left));
        if (text.length < String(c ?? "").length) truncated = true;
        left -= text.length;
        return text;
      });
      if (row.block) cells.block = row.block;
      rows.push(cells);
    }
    sheets.push({ name: sheet.name, rows });
    if (left <= 0 && truncated) break;
  }
  return { kind: parsed.kind, sheets, truncated };
}

// ---- 項目を取り出す ------------------------------------------------------
const HEADING = /^[■□◆◇●○★☆▼▽▶►【〔\[#＜<]/;
const UNCHECKED = /[☐□◻⬜]/,
  CHECKED = /[☑☒✓✔■◼⬛]/;
const PLACEHOLDER = /^(?:[\s\-－ー—―_・。．.／/]*|(?:ご?記入(?:欄|して)?(?:ください)?|未記入|空欄|tbd|todo|\?+|？+))$/i;
export function isBlankValue(value) {
  const v = String(value ?? "").trim();
  if (PLACEHOLDER.test(v)) return true;
  // 「☐ あり ☐ なし」のような未チェックの選択肢だけなら空欄とみなす。
  return UNCHECKED.test(v) && !CHECKED.test(v);
}
// 列見出しの辞書。見出しの行では、括弧の中と空白を除いて照合する。
const ROLE = {
  number: /^(no\.?|ｎｏ\.?|№|#|＃|番号|項番|通番|連番)$/i,
  label: /^(項目|項目名|質問|質問項目|質問事項|確認項目|確認事項|ヒアリング項目|聞くこと|カテゴリ|区分|分類)$/,
  answer: /^(ご?回答|回答欄|ご?記入|ご?記入欄|記入内容|回答内容|入力欄|入力|値|答え|お答え|ご記入ください)$/,
  note: /^(備考|補足|メモ|説明|注記|注意|注意事項|記入例|例|回答例|ポイント|聞き方|目的|意図|ねらい|コメント)$/,
};
const norm = (c) =>
  String(c ?? "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .trim();
function headerRoles(cells) {
  const filled = cells.map((c, i) => [norm(c), i]).filter(([c]) => c);
  if (filled.length < 2) return null;
  const roles = { number: [], label: null, answer: [], note: [], loose: [] };
  for (const [c, i] of filled) {
    if (ROLE.number.test(c)) roles.number.push(i);
    else if (ROLE.label.test(c) && roles.label == null) roles.label = i;
    // 「内容」は、項目の列が先にあれば記入欄、なければ項目。
    else if (c === "内容") roles.label == null ? (roles.label = i) : roles.answer.push(i);
    else if (ROLE.answer.test(c)) roles.answer.push(i);
    else if (ROLE.note.test(c)) roles.note.push(i);
    else return null; // 辞書に無い語がある行は見出しの行とみなさない
  }
  if (roles.label == null && !roles.answer.length) return null;
  if (roles.label == null) {
    // 記入欄はあるが項目の列名が無い: 記入欄より左で、番号・備考でない最初の列を項目にする。
    const left = filled.map(([, i]) => i).filter((i) => i < roles.answer[0] && !roles.number.includes(i) && !roles.note.includes(i));
    if (!left.length) return null;
    roles.label = left[0];
  }
  return roles;
}
const isNumberCell = (c) => /^\s*(?:\d+|[①-⑳])\s*[.．)）]?\s*$/.test(String(c ?? ""));
// 見出しの無い表の列の役割を、列の中身の傾向から推す。決められないときは null（利用者に選んでもらう）。
function inferRoles(rows) {
  const wide = rows.filter((r) => r.filter((c) => String(c ?? "").trim()).length >= 2);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cols = [];
  for (let i = 0; i < width; i++) {
    const values = rows.map((r) => String(r[i] ?? "").trim()).filter(Boolean);
    if (values.length) cols.push({ i, values });
  }
  const number = cols.filter(
    (c) => c.values.length >= 2 && c.values.every(isNumberCell),
  );
  const rest = cols.filter((c) => !number.includes(c));
  // 文字のある列のあいだに全部空の列がある表（例: 会社名,,法人名を記入）は、空の列が未記入の記入欄で、
  // 右の列は説明かもしれない。自動では決めず、空の列を記入欄の候補として利用者に選んでもらう。
  if (rest.length >= 2) {
    const gap = [];
    for (let i = rest[0].i + 1; i < rest.at(-1).i; i++)
      if (!cols.some((c) => c.i === i)) gap.push(i);
    if (gap.length)
      return { ambiguous: true, suggestion: { label: rest[0].i, answer: gap[0] } };
  }
  if (!wide.length || rest.length <= 1)
    return { number: number.map((c) => c.i), label: rest[0]?.i ?? cols[0]?.i ?? 0, answer: [], note: [], confident: true };
  if (rest.length === 2)
    return { number: number.map((c) => c.i), label: rest[0].i, answer: [rest[1].i], note: [], confident: true };
  return { ambiguous: true, suggestion: { label: rest[0].i, answer: rest[1].i } };
}
// 列の一覧（選ぶ画面用）。文字のある最初の列から最後の列までは、全部空の列も出す（未記入の記入欄のため）。
function columnSummary(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const has = (i) => rows.some((r) => String(r[i] ?? "").trim());
  let first = 0,
    last = width - 1;
  while (first < width && !has(first)) first++;
  while (last > first && !has(last)) last--;
  const columns = [];
  for (let i = first; i <= last; i++) {
    const values = rows.map((r) => String(r[i] ?? "").trim()).filter(Boolean);
    columns.push({
        index: i,
        name: colName(i),
        samples: [...new Set(values)].slice(0, 3).map((v) => v.slice(0, 20)),
      });
  }
  return columns;
}
const colName = (i) => {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26))
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
// 項目を取り出す。表（シート・Word の表ごと）の列の役割（番号／項目／記入欄／備考）を、
// 見出しの行の語か列の中身から決める。決められない表は items に入れず tables に
// needsMapping として返し、画面で「どの列が項目か・記入欄か」を選んでもらう（mapping で渡す）。
export function analyzeSheet(parsed, sheetNames = null, mapping = {}) {
  const items = [],
    tables = [],
    seen = new Set();
  for (const sheet of parsed.sheets) {
    if (sheetNames && !sheetNames.includes(sheet.name)) continue;
    const blocks = new Map();
    for (const row of sheet.rows) {
      const b = row.block || "";
      if (!blocks.has(b)) blocks.set(b, []);
      blocks.get(b).push(row);
    }
    const rolesOf = new Map();
    for (const [block, rows] of blocks) {
      const key = sheet.name + (block ? "／" + block : "");
      const chosen = mapping?.[key];
      let roles = null;
      if (chosen && Number.isInteger(chosen.label)) {
        roles = {
          number: [],
          label: chosen.label,
          answer: Number.isInteger(chosen.answer) ? [chosen.answer] : [],
          note: [],
          chosen: true,
        };
      } else {
        const h = rows.findIndex((r) => headerRoles(r));
        roles = h >= 0 ? headerRoles(rows[h]) : inferRoles(rows);
      }
      const suggestion = roles?.ambiguous ? roles.suggestion : null;
      if (roles?.ambiguous) roles = null;
      const table = {
        key,
        sheet: sheet.name,
        block,
        columns: columnSummary(rows),
        roles: roles && { label: roles.label, answer: roles.answer, number: roles.number, note: roles.note },
        needsMapping: !roles,
        // 列を選ぶ画面の初期値（自動で読んだ表は、その割り当て）。
        suggestion: suggestion || (roles && { label: roles.label, answer: roles.answer[0] ?? null }),
        chosen: !!roles?.chosen,
      };
      tables.push(table);
      rolesOf.set(block, roles && { ...roles, key });
    }
    // 行は元の順に読む（Word の表と段落が混ざっても、本文の順を保つ）。
    for (const row of sheet.rows) {
      const roles = rolesOf.get(row.block || "");
      if (!roles) continue;
      const key = roles.key;
      const answerCols = (row) => {
        if (roles.answer.length) {
          // 見出しの無い列（記入欄の右の空き列）は記入欄の続きとして読む。
          const last = Math.max(...roles.answer);
          const extra = [];
          for (let i = last + 1; i < row.length; i++)
            if (![roles.label, ...roles.number, ...roles.note].includes(i)) extra.push(i);
          return [...roles.answer, ...(roles.chosen ? [] : extra)];
        }
        return [];
      };
      {
        const cells = row.map((c) => String(c ?? "").trim()),
          filled = cells.filter(Boolean);
        if (!filled.length) continue;
        if (headerRoles(cells)) continue; // 列見出しの行
        let raw = cells[roles.label] ?? "";
        // 1 セルだけの行（見出し・題名・説明文・「会社名」だけの行）は、項目の列以外にあっても拾う。
        if (!raw && filled.length === 1 && !roles.chosen) raw = filled[0];
        let label = raw
          .replace(/^(?:\d+[.．、)）]|[・\-*])\s*/, "")
          .replace(/[:：]\s*$/, "")
          .trim();
        if (!label || [...label].length > 80) continue;
        if (isNumberCell(label)) continue;
        if (filled.length === 1 && HEADING.test(raw)) continue; // 見出しだけの行
        if (filled.length === 1 && /シート|ヒアリング(?:票|項目)?$/.test(label)) continue; // 題名
        if (filled.length === 1 && /[。．.]$/.test(label) && [...label].length > 12) continue; // 説明文
        const value = answerCols(cells)
          .map((i) => cells[i])
          .filter(Boolean)
          .join(" / ");
        const id = sheet.name + "\u0000" + label;
        if (seen.has(id)) continue;
        seen.add(id);
        const blank = isBlankValue(value);
        items.push({
          label,
          sheet: sheet.name,
          table: key,
          filled: !blank,
          // 選択肢（☐ A ☐ B）は聞き方の手がかりとして残す。記入済みの値は送らない。
          hint: blank && UNCHECKED.test(value) ? value.replace(/\s+/g, " ").slice(0, 120) : "",
        });
        if (items.length >= SHEET_MAX_ITEMS) return { items, tables };
      }
    }
  }
  return { items, tables };
}
export function extractSheetItems(parsed, sheetNames = null, mapping = {}) {
  return analyzeSheet(parsed, sheetNames, mapping).items;
}
