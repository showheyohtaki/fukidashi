# -*- coding: utf-8 -*-
"""シート添付の試験用見本を作る（架空の内容。実在のお客様情報は入れない）。
python3 tests/fixtures/make-sheets.py で作り直せる。"""
import pathlib, zipfile
from xml.sax.saxutils import escape
here = pathlib.Path(__file__).resolve().parent

def write_zip(path, files, stored=()):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            info = zipfile.ZipInfo(name, (2026, 11, 8, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if name in stored else zipfile.ZIP_DEFLATED
            z.writestr(info, text.encode("utf-8"))

# ---- xlsx: 2 シート・共有文字列・インライン文字列・数値・空欄セル・列の飛び ----
shared = ["項目", "ご記入欄", "会社名", "株式会社サンプル商店", "ご担当者名", "ご予算",
          "納期", "-", "ターゲット", "■ 制作について", "ページ数", "公開後の更新",
          "☐ 自社で行う　☐ 依頼したい", "参考サイト", "好きな色", "NG 事項", "業種", "飲食（カフェ）"]
def si(i): return f'<c r="{{}}" t="s"><v>{i}</v></c>'
def s(ref, text): return f'<c r="{ref}" t="s"><v>{shared.index(text)}</v></c>'
def inline(ref, text): return f'<c r="{ref}" t="inlineStr"><is><t>{escape(text)}</t></is></c>'
def num(ref, v): return f'<c r="{ref}"><v>{v}</v></c>'
def row(n, *cells): return f'<row r="{n}">' + "".join(cells) + "</row>"
def sheet(rows): return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>'
  + "".join(rows) + "</sheetData></worksheet>")
sheet1 = sheet([
  row(1, s("A1", "項目"), s("B1", "ご記入欄")),
  row(2, s("A2", "会社名"), s("B2", "株式会社サンプル商店")),
  row(3, s("A3", "業種"), s("C3", "飲食（カフェ）")),          # B 列が空で C 列に値（列の飛び）
  row(4, s("A4", "ご担当者名")),                                # 値のセル自体が無い
  row(5, s("A5", "ご予算"), '<c r="B5" t="inlineStr"><is><t></t></is></c>'),  # 空文字
  row(6, s("A6", "納期"), s("B6", "-")),                        # 「-」は空欄扱い
  row(7, s("A7", "ターゲット")),
  row(9, s("A9", "■ 制作について")),                            # 見出しだけの行
  row(10, s("A10", "ページ数"), num("B10", 5)),
  row(11, s("A11", "公開後の更新"), s("B11", "☐ 自社で行う　☐ 依頼したい")),
])
sheet2 = sheet([
  row(1, s("A1", "参考サイト")),
  row(2, s("A2", "好きな色"), inline("B2", "青系")),
  row(3, s("A3", "NG 事項"), inline("B3", "")),
])
sst = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(shared)}" uniqueCount="{len(shared)}">'
  + "".join(f"<si><t>{escape(x)}</t></si>" if x != "株式会社サンプル商店" else
            f'<si><r><t>株式会社</t></r><r><t>サンプル商店</t></r><rPh sb="0" se="4"><t>カブシキガイシャ</t></rPh></si>'
            for x in shared) + "</sst>")
write_zip(here / "hearing-sheet.xlsx", {
  "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
  "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="基本情報" sheetId="1" r:id="rId1"/><sheet name="デザイン" sheetId="2" r:id="rId2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
  "xl/sharedStrings.xml": sst,
  "xl/worksheets/sheet1.xml": sheet1,
  "xl/worksheets/sheet2.xml": sheet2,
}, stored={"xl/worksheets/sheet2.xml"})  # 無圧縮の項目も混ぜる

# ---- docx: 段落・見出し・表・「項目：」の段落 ----
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def p(text): return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'
def tc(text): return f'<w:tc><w:tcPr/>{p(text) if text else "<w:p/>"}</w:tc>'
def tr(*cells): return "<w:tr>" + "".join(tc(c) for c in cells) + "</w:tr>"
doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>'
  + p("ヒアリングシート（見本）") + p("■ 基本情報") + p("以下の表にご記入ください。")
  + "<w:tbl><w:tblPr/>" + tr("項目", "記入欄") + tr("会社名", "株式会社サンプル商店")
  + tr("ご予算", "") + tr("納期", "") + tr("ご担当者", "山本（架空）") + "</w:tbl>"
  + '<w:p><w:r><w:t>ご希望の連絡方法：</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>業種：</w:t></w:r><w:r><w:t>飲食</w:t></w:r></w:p>'
  + "<w:sectPr/></w:body></w:document>")
write_zip(here / "hearing-sheet.docx", {
  "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml": doc,
})

(here / "hearing-sheet.csv").write_text('項目,記入欄\n会社名,株式会社サンプル商店\nご予算,\n"納期, 公開日",\nターゲット,"30代の女性、近所の方"\n', encoding="utf-8")
(here / "hearing-sheet.tsv").write_text("項目\t記入欄\n会社名\t株式会社サンプル商店\nご予算\t\n納期\t\n", encoding="utf-8")
(here / "hearing-sheet.md").write_text("# ヒアリングシート\n\n| 項目 | 記入欄 |\n|---|---|\n| 会社名 | 株式会社サンプル商店 |\n| ご予算 |  |\n\n- 納期:\n- ターゲット：30代の女性\n", encoding="utf-8")
(here / "hearing-sheet.txt").write_text("会社名：株式会社サンプル商店\nご予算：\n納期：\n", encoding="utf-8")
# パスワード付きの Office ファイルは zip でなく CFB（先頭 D0 CF 11 E0）になる。
(here / "encrypted.xlsx").write_bytes(bytes.fromhex("D0CF11E0A1B11AE1") + b"\0" * 504)

# ---- 列の役割の回帰（No. 列・補足列・Word の表）。インライン文字列だけの最小の xlsx ----
def simple_xlsx(path, rows, sheet_name="シート1"):
    body = "".join(
        f'<row r="{r + 1}">' + "".join(
            inline(f"{chr(65 + c)}{r + 1}", v) if not isinstance(v, int) else num(f"{chr(65 + c)}{r + 1}", v)
            for c, v in enumerate(cells) if v != ""
        ) + "</row>"
        for r, cells in enumerate(rows))
    write_zip(path, {
      "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml": sheet([body]),
    })
NUMBERED = [["No.", "項目", "回答"], [1, "会社名", ""], [2, "予算", ""], [3, "納期", ""]]
NOTES = [["項目", "回答", "補足"], ["ご予算", "", "税込の概算額"], ["納期", "", "公開希望日"]]
simple_xlsx(here / "numbered.xlsx", NUMBERED)
simple_xlsx(here / "with-notes.xlsx", NOTES)
(here / "numbered.csv").write_text("No.,項目,回答\n1,会社名,\n2,予算,\n3,納期,\n", encoding="utf-8")
(here / "with-notes.csv").write_text("項目,回答,補足\nご予算,,税込の概算額\n納期,,公開希望日\n", encoding="utf-8")
# 見出しが無く、3列のどれが記入欄か決められない表（利用者に列を選んでもらう）。
(here / "no-header-3cols.csv").write_text("会社名,株式会社サンプル商店,正式名称で\nご予算,,税込で\n納期,,公開希望日\n", encoding="utf-8")
# 見出しの無い番号付きの表（番号列は数字だけなので項目にしない）。
(here / "numbered-no-header.csv").write_text("1,会社名,株式会社サンプル商店\n2,ご予算,\n3,納期,\n", encoding="utf-8")
doc2 = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>'
  + p("ヒアリングシート（見本2）")
  + "<w:tbl><w:tblPr/>" + tr("No.", "項目", "回答", "補足") + tr("1", "会社名", "", "正式名称")
  + tr("2", "ご予算", "", "税込の概算額") + tr("3", "納期", "11月末", "公開希望日") + "</w:tbl>"
  + "<w:sectPr/></w:body></w:document>")
write_zip(here / "numbered.docx", {
  "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml": doc2,
})
# 見出しが無く、途中の列（B）が全部空で、右の列（C）が説明の表。B が未記入の記入欄。
EMPTY_MIDDLE = [["会社名", "", "法人名を記入"], ["ご予算", "", "税込の概算額"], ["納期", "", "公開希望日"]]
(here / "empty-middle.csv").write_text("".join(",".join(r) + "\n" for r in EMPTY_MIDDLE), encoding="utf-8")
simple_xlsx(here / "empty-middle.xlsx", EMPTY_MIDDLE)
print("ok")
