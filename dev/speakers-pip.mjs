// meet-speakers.js が Meet の「別のウィンドウで開く」（Document Picture-in-Picture）に移ったタイルを読めるかの確認
// 実行: node dev/speakers-pip.mjs [--file 別の meet-speakers.js] [--playwright-module パス] [--chromium 実行ファイル]
// 期待: beforePip・observerStartedBefore・observerStartedAfter・afterClose が ["佐藤"]、afterStopSpeaking が []。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";
const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const require = createRequire(import.meta.url);
const { chromium } = require(arg("--playwright-module") || process.env.KOE_PLAYWRIGHT_MODULE || "playwright");
const SRC = readFileSync(arg("--file") || new URL("../meet-speakers.js", import.meta.url), "utf8");
const tiles = `
<div data-participant-id="spaces/x/devices/1"><span class="notranslate">佐藤</span><span aria-label="発話中">●</span><button aria-label="佐藤さんをメイン画面に固定します"></button><i class="google-symbols notranslate" style="display:none">frame_person</i></div>
<div data-participant-id="spaces/x/devices/2"><span class="notranslate">鈴木花子</span><span aria-label="発話中">●</span><button aria-label="自分をメイン画面に固定します"></button></div>`;
const html = `<!doctype html><meta charset=utf-8><button id=go>pip</button><div id=stage>${tiles}</div><script>${SRC}</script>`;
const srv = http.createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(html); }).listen(0, "127.0.0.1");
await new Promise((r) => srv.on("listening", r));
const b = await chromium.launch({ headless: true, executablePath: arg("--chromium") || process.env.KOE_CHROMIUM || chromium.executablePath() });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${srv.address().port}/`);
const out = {};
out.api = await p.evaluate(() => typeof documentPictureInPicture);
// 1) PiP の前から見張る（Meet で「開始」を押してから別ウィンドウにした場合）
await p.evaluate(() => { window.got1 = []; window.stop1 = KoeMeetSpeakers.observe(document, (m) => window.got1.push(m.names)); });
await p.waitForTimeout(700);
out.beforePip = await p.evaluate(() => window.got1.at(-1));
// ボタンを押して PiP を開き、Meet と同じくタイルを別ウィンドウへ移す
await p.evaluate(() => document.getElementById("go").onclick = async () => {
  const w = await documentPictureInPicture.requestWindow({ width: 300, height: 300 });
  w.document.body.append(...document.getElementById("stage").children); });
await p.click("#go");
await p.waitForTimeout(1200);
out.mainTilesDuringPip = await p.evaluate(() => document.querySelectorAll("[data-participant-id]").length);
out.observerStartedBefore = await p.evaluate(() => window.got1.at(-1));
// 2) PiP が開いた後から見張る（別ウィンドウにしてから「開始」を押した場合）
await p.evaluate(() => { window.got2 = []; window.stop2 = KoeMeetSpeakers.observe(document, (m) => window.got2.push(m.names)); });
await p.waitForTimeout(700);
out.observerStartedAfter = await p.evaluate(() => window.got2.at(-1));
// 3) PiP 内で発話が変わる
await p.evaluate(() => documentPictureInPicture.window.document.querySelector('[aria-label="発話中"]').setAttribute("aria-label", "発話していません"));
await p.waitForTimeout(700);
out.afterStopSpeaking = await p.evaluate(() => window.got1.at(-1));
// 4) PiP を閉じて元の画面に戻す
await p.evaluate(() => { const w = documentPictureInPicture.window; document.getElementById("stage").append(...w.document.body.children); w.close(); document.querySelector('[aria-label="発話していません"]').setAttribute("aria-label", "発話中"); });
await p.waitForTimeout(900);
out.afterClose = await p.evaluate(() => window.got1.at(-1));
await p.evaluate(() => { window.stop1(); window.stop2(); });
console.log(JSON.stringify(out, null, 1));
await b.close(); srv.close();
assert.equal(out.mainTilesDuringPip, 0);
for (const k of ["beforePip", "observerStartedBefore", "observerStartedAfter", "afterClose"]) assert.deepEqual(out[k], ["佐藤"], k);
assert.deepEqual(out.afterStopSpeaking, []);
console.log("PASS");
