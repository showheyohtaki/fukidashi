# AGENTS.md — このリポジトリを読む AI へ

このリポジトリは Chrome 拡張「フキダシ」（Google Meet の相手の声を字幕にし、打った文・選んだ文を AI の声で会議に送る）です。依頼の種類で、読む文書を選んでください。

## 利用者に入れ方・設定を案内するとき

「この Chrome 拡張の入れ方を教えて」「設定を手伝って」などの依頼では、[docs/setup-guide.md](docs/setup-guide.md) を読み、その冒頭の「この手順書を読む AI へ」に従って案内します。

- 最初に利用者の環境（Mac / Windows、Chrome の版、Node.js の有無）を確かめます。
- 1手順ずつ、画像を見せてから説明します。画像は `docs/images/` にあります。
- OpenAI の API キーは利用者が自分でパネルに入れます。キーをチャットに貼らせず、値を聞きません。

## 使い方の質問に答えるとき

[docs/MANUAL.md](docs/MANUAL.md)（利用者向けマニュアル）を元に答えます。会議の前の準備・会議中の操作・まとめ・設定・困ったとき・プライバシーと利用料が載っています。マニュアルに無いことは推測で答えず、「書いていない」と伝えます。

## コードを読む・直すとき

- 開発の入口は [docs/dev/README-dev.md](docs/dev/README-dev.md) です（構成・ビルド・試験）。
- 組み立て: `npm run build`（`dist/prod` と `dist/dev` を作る）。試験: `npm test`。
- 版ごとの変更は [CHANGELOG.md](CHANGELOG.md) にあります。
- API キーの値をファイル・ログ・コマンドに書きません。

## ファイルの一覧（AI 向けの短い索引）

[llms.txt](llms.txt) にあります。
