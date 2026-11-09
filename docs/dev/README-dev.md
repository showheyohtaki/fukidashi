# フキダシ 開発者向けメモ

拡張を直す人・試験する人向けの資料です。使い方は [利用者向けマニュアル](../MANUAL.md)、入れ方は [README](../../README.md) にあります。

このページの内容は、以前は README に書いていたものです。公開向けに README を整理したときに、こちらへ移しました。

## 開発用ビルドと試験用の中継

`npm run build` は `dist/prod`（配布用）と `dist/dev`（開発用）の2つを作ります。

- `dist/dev` は拡張の名前が「フキダシ（開発）」になり、試験データでの画面の切り替え（`sidepanel.html?fixture=<名前>` と `window.koeTest`）と、開発用の PCM 入口が入ります。
- `dist/dev` の通信先は `http://127.0.0.1:8787` 固定です。開発試験では `dist/dev` を読み込み、初回設定のキー欄には `dummy-key-proxy-only` と入力します。中継が実キーを持ちます。
- 本番ビルド（`dist/prod`）には状態注入、開発用 PCM 入口、ローカル接続先を含めません。ソースを変えた後はビルドし直し、拡張の再読み込みと会議ページの再読み込みを行います。

## 主な構成

`background.js` が拡張内の Port と保存設定を仲介し、`offscreen.js` / `session.js` が音声・接続・記録を保持します。`inject.js` が会議の getUserMedia を包み、`bridge.js` が許可した種類のメッセージだけを渡します。`sidepanel.js` は表示と操作だけを担当します。

UI の値は [DESIGN.md](../../DESIGN.md) とキャンバスが基準です。動作部品の出典は [第三者ライセンス](../../THIRD_PARTY_NOTICES.md)、移植箇所は [実装報告](../IMPLEMENTATION_REPORT.md) にあります。

会議ページとの合言葉は postMessage から観測可能で、偶発的混入を防ぐ識別子です。会議ページ自体への認証ではなく、先取りや観測後の偽装は拒否できません。ページの status だけでは Session の読み上げを取り消しません。

## 変更の記録

利用者向けの変更点は [CHANGELOG.md](../../CHANGELOG.md) にあります。

## 開発・試験

```sh
npm run build
npm test
node dev/api-smoke.mjs --prod
node dev/e2e.mjs --screens
node dev/e2e.mjs --live
```

- `npm test`: VAD、応答の中断・古い音声の破棄、マイクの複製・ミュート、IME、記録、ビルド分離などの Node テストです。
- `dev/api-smoke.mjs`: ビルド後の `dist/dev` を使用。`--prod` は prod 出力を `.tmp/round1/prod-smoke/` にコピーし、API_BASE だけ既存中継に固定した開発試験用コピーで5項目を実行します。配布用 dist/prod は変更しません。実キーを扱わずダミーキーを使い、ブラウザの合格判定と分けます。
- `--screens`: 開発専用の状態注入で29画面を撮影し、正本 PNG を左・実装を右に並べた比較画像を作ります。Python 3 と Pillow が必要です。比較画像の目視確認が別途必要です。
- `--live`: 撮影後、T5・T7〜T14・T17・T18-warm（今日の項目の作り置きが押してすぐ鳴るか）と `T7-transport-none` を実行します。相手役の音声10本を API で生成し、2つの PeerConnection の受信側 pc2 の録音を追加で文字起こしして照合します。最後に `?transport=none` で sender を使わない経路も確かめます。API 利用量が発生します。`--wav-dir .tmp/fixtures` で PCM16 / mono / 24 kHz の WAV 10本を指定すれば入力音声の生成を省けます。
- 結果は `docs/test-log/YYYY-MM-DD/`。`--out docs/test-log/任意の名前` でも指定できます。日時は日本時間です。ブラウザ起動に失敗すると `not-run` とエラーを保存し、権限の回避は行いません。
- Playwright はローカルの `playwright`、Chromium はその標準実行ファイルを使います。既存インストールを使う場合は `--playwright-module /path/to/node_modules/playwright` と `--chromium /path/to/chrome`、または `KOE_PLAYWRIGHT_MODULE` / `KOE_CHROMIUM` を指定します。
- result.json には段階、待機条件、最後の接続状態、スタック、pass/fail/not-run 件数、画面ごとの字幕末尾位置・候補行数を残します。キー本文は記録しません。

**自動試験の入力は offscreen の開発専用 PCM 入口です。`tabCapture`、本物の Meet / Zoom の送受信網、ノイズキャンセルは通りません。** それらと60分の連続稼働は [手動試験手順](../../dev/manual-test.md) で確認してください。

## マニュアル用のスクリーンショット

`docs/images/` の画像は次の方法で撮っています。

- 拡張の画面（`04`〜`19`）: `dist/dev` を Playwright の `launchPersistentContext`（headless・幅 400・`deviceScaleFactor: 2`）で読み込み、`chrome-extension://<id>/sidepanel.html?fixture=Main` を開いて `window.koeTest.fixture("<名前>")` で切り替えて撮影。和文が明朝体で写る環境があるため、撮影時だけ `page.addStyleTag` で Hiragino Sans を当てています。試験データの人物（山田・佐藤）は架空です。
- `12-meeting.png` だけは、話した人の名前の表示を見せるため、撮影用の一時コピーの `ui/fixtures.js` で相手の行に `speaker: "佐藤"` を足して撮りました（リポジトリの試験データは変えていません）。
- Chrome の拡張機能の画面（`01`〜`03`）: 日本語表示の Chrome で `chrome://extensions` を裏のウィンドウに開き、CDP の `Page.captureScreenshot` で必要な部分だけを切り抜きました。拡張のオン・オフやデベロッパー モードの設定は変えていません。ボタンの色はブラウザのテーマで変わります。

| 画像 | 試験データ（fixture） |
|---|---|
| 04-open-panel | S1b-not-meeting |
| 05〜07 setup | S0-1-key / S0-2-you / S0-3-voice |
| 08・09 prep | S1c-prep-draft（09 は下端の切り抜き） |
| 10-prep-attach-sheet | S1d-prep-sheet |
| 11-start | S1-idle |
| 12-meeting | Main（話者名つき） |
| 13-speaking | S4-speaking |
| 14-today-items | S11-hearing |
| 15-edit-lists | S12-lists |
| 16-menu-stop | M-menu |
| 17-summary | S7-summary |
| 18-settings | S8-settings |
| 19-reconnecting | S6-errors |
