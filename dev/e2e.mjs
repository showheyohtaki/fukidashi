// Browser acceptance runner. Uses only the compiled dev build and an already-running
// 127.0.0.1:8787 proxy. Does NOT start/stop proxy or load any real API key.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { percentile, median } from "./metrics.mjs";
import {
  checkBuildIdentity,
  recordingBytes,
  compareRecording,
  assessRecording,
  assessContent,
  cleanupFailedTest,
} from "./acceptance.mjs";
import { fixtureNames, extraFixtureNames } from "./fixtures.js";
import { replyTurns } from "./reply-fixtures.mjs";
import { normalizeSpeech, speechMatches, canSend } from "../protocol.js";
import { speakerDomChecks } from "./speaker-dom-checks.mjs";
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(import.meta.url);
let chromium;
const live = process.argv.includes("--live"),
  t5Only = process.argv.includes("--t5-only"),
  date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const OUT = path.resolve(ROOT, arg("--out") || `docs/test-log/${date}`),
  TMP = path.join(ROOT, ".tmp/v1/e2e"),
  PROFILE = path.join(TMP, "profile");
if (!OUT.startsWith(ROOT + path.sep))
  throw new Error("Outputs must remain inside the authorized repository");
await mkdir(OUT, { recursive: true });
await mkdir(TMP, { recursive: true });
await mkdir(OUT + "/screens", { recursive: true });
process.env.TMPDIR = TMP;
const ids = [
  "T5",
  "T7",
  "T8",
  "T9",
  "T10",
  "T11",
  "T12",
  "T13",
  "T14",
  "T17",
  "T18-warm",
  "T7-transport-none",
  "T7-meet-clone",
];
const result = {
  startedAt: new Date().toISOString(),
  command: `node dev/e2e.mjs ${live ? "--live" : "--screens"}`,
  tabCapture: false,
  realMeeting: false,
  tests: Object.fromEntries(
    ids.map((id) => [
      id,
      { status: "not-run", reason: "Browser prerequisite not completed" },
    ]),
  ),
  screens: { status: "not-run", count: 0, geometry: {} },
  metrics: {
    roundTripMedianMs: null,
    roundTripP90Ms: null,
    cachedTapP90Ms: null,
    roundTrips: [],
    taps: [],
  },
  errors: [],
  timeline: [],
  waitingFor: null,
  lastState: null,
};
let context,
  site,
  stage = "dependencies",
  panel,
  meet,
  sw,
  extId,
  tabId;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = () =>
  chromium.launchPersistentContext(PROFILE, {
    headless: true,
    chromiumSandbox: true,
    deviceScaleFactor: 2,
    viewport: { width: 400, height: 860 },
    executablePath:
      arg("--chromium") ||
      process.env.KOE_CHROMIUM ||
      chromium.executablePath(),
    args: [
      `--disable-extensions-except=${path.join(ROOT, "dist/dev")}`,
      `--load-extension=${path.join(ROOT, "dist/dev")}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
const checkpoint = (next, waitingFor = null) => {
  stage = next;
  result.waitingFor = waitingFor;
  result.timeline.push({ at: new Date().toISOString(), stage, waitingFor });
};
const rpc = (command, data = {}) => {
  checkpoint(stage.split(":")[0] + ":rpc", command);
  return panel.evaluate(
    ([command, data]) => window.koeTest.rpc(command, data),
    [command, data],
  );
};
const state = () => panel.evaluate(() => window.koeTest.state());
async function waitState(fn, timeout = 30000) {
  const description = fn.toString();
  checkpoint(stage.split(":")[0] + ":waitState", description);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await state();
    if (s)
      result.lastState = {
        active: s.active,
        stt: s.sttState,
        voice: s.voiceState,
        pre: s.preState,
        page: s.page,
        candidateState: s.candidateState,
        captions: s.lines.length,
        speaking: !!s.speaking,
        keyError: s.keyError,
      };
    if (s && fn(s)) {
      result.waitingFor = null;
      return s;
    }
    await pause(100);
  }
  throw new Error(
    `Timed out after ${timeout}ms waiting for ${description}; last state: ${JSON.stringify(result.lastState)}`,
  );
}
async function run(id, fn) {
  if (t5Only && id !== "T5") {
    result.tests[id] = { status: "not-run", reason: "T5-only series" };
    return;
  }
  checkpoint(id);
  try {
    const data = await fn();
    result.tests[id] = { status: "pass", ...data };
  } catch (e) {
    result.tests[id] = {
      status: "fail",
      error: e.message,
      code: e.code,
      recording: e.recording,
      stage,
      waitingFor: result.waitingFor,
      lastState: result.lastState,
      stack: e.stack,
    };
    result.tests[id].cleanupErrors = await cleanupFailedTest(
      () => rpc("stopSpeaking"),
      () => meet.evaluate(() => window.receiver?.abort()),
    );
  }
  if (id === "T5") {
    try {
      const current = await state();
      result.metrics.candidateRequests = current.metrics.candidateRequests;
      result.metrics.turns = current.metrics.turns;
      result.metrics.candidateBatches = current.metrics.candidateBatches;
      result.metrics.captionCommits = current.metrics.captionCommits;
      result.metrics.captionFinals = current.metrics.captionFinals;
    } catch {}
  }
  try {
    const current = await state();
    result.metrics.taps = current.metrics.taps;
    result.metrics.playbacks = current.metrics.playbacks;
  } catch {}
  await writeResult();
}
async function writeResult() {
  await writeFile(OUT + "/result.json", JSON.stringify(result, null, 2) + "\n");
}
async function transcription(record, name, model = "gpt-4o-transcribe") {
  // Retain corrupt evidence too, but reject it before any ASR API call.
  await writeFile(
    OUT + "/" + name + ".webm",
    Buffer.from(record.audio || "", "base64"),
  );
  const bytes = recordingBytes(record);
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "audio/webm" }),
    name + ".webm",
  );
  form.append("model", model);
  form.append("language", "ja");
  const r = await fetch("http://127.0.0.1:8787/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer dummy-key-proxy-only" },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const error = new Error("recording transcription HTTP " + r.status);
    error.code = "transcription-http";
    error.httpStatus = r.status;
    throw error;
  }
  return (await r.json()).text || "";
}
async function recordSay(text, kind = "type", notBefore = 0) {
  await meet.evaluate(() => receiver.start());
  if (notBefore > Date.now()) await pause(notBefore - Date.now());
  const tapped = Date.now();
  const accepted = await rpc("say", { text, kind });
  assert(accepted, "send was rejected");
  await waitState((s) => s.speaking);
  await waitState((s) => !s.speaking, 45000);
  await pause(100);
  const record = await meet.evaluate(() => receiver.finish());
  assert(record.onset, "No audio reached receiving track");
  return { record, tapped };
}
async function feedPCM(pcm) {
  const frame = 480;
  let offset = 0;
  const begin = Date.now();
  while (offset < pcm.length) {
    const frames = [];
    for (let j = 0; j < 1 && offset < pcm.length; j++, offset += frame) {
      const part = new Int16Array(frame);
      part.set(pcm.subarray(offset, Math.min(offset + frame, pcm.length)));
      frames.push(Array.from(part));
    }
    await rpc("devFeed", { data: { frames } });
    const wait = begin + offset / 24 - Date.now();
    if (wait > 0) await pause(wait);
  }
  return Date.now();
}
function readWav(buffer) {
  const d = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  let channels, rate, format, bits, data;
  for (let p = 12; p + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", p, p + 4),
      len = d.getUint32(p + 4, true);
    if (id === "fmt ") {
      format = d.getUint16(p + 8, true);
      channels = d.getUint16(p + 10, true);
      rate = d.getUint32(p + 12, true);
      bits = d.getUint16(p + 22, true);
    }
    if (id === "data") data = buffer.subarray(p + 8, p + 8 + len);
    p += 8 + len + (len % 2);
  }
  assert(
    format === 1 && channels === 1 && rate === 24000 && bits === 16 && data,
    "WAV must be PCM16 mono 24kHz",
  );
  return Int16Array.from({ length: data.length / 2 }, (_, i) =>
    data.readInt16LE(i * 2),
  );
}
async function prepareAudio() {
  const source = arg("--wav-dir");
  if (source) {
    const folder = path.resolve(ROOT, source);
    const files = (await readdir(folder))
      .filter((n) => n.endsWith(".wav"))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    assert(files.length >= 10, "Need 10 WAV fixtures");
    return Promise.all(
      files
        .slice(0, 10)
        .map(async (f) => readWav(await readFile(path.join(folder, f)))),
    );
  }
  const { Speaker, b64ToInt16 } = await import("../dist/dev/openai.js");
  const { configWith } = await import("../dist/dev/config.js");
  const { wavBytes } = await import("../dist/dev/audio.js");
  const texts = replyTurns;
  const speaker = new Speaker(configWith({ apiKey: "dummy-key-proxy-only" }));
  speaker.connect();
  const audio = [];
  try {
    for (let i = 0; i < texts.length; i++) {
      const r = await speaker.speak(texts[i]);
      assert.equal(r.status, "completed");
      const bytes = wavBytes(r.chunks);
      await writeFile(OUT + `/input-${i + 1}.wav`, bytes);
      audio.push(readWav(Buffer.from(bytes)));
    }
  } finally {
    speaker.close();
  }
  return audio;
}
async function screens() {
  checkpoint("screens");
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  for (const name of [...fixtureNames, ...extraFixtureNames]) {
    checkpoint(
      "screens:" + name,
      "fixture render, caption follow, geometry and screenshot",
    );
    const height =
        name === "H700"
          ? 700
          : name === "S8-settings"
            ? 1500
            : ["S7-summary", "S9-voices", "S12-lists", "S1d-prep-sheet", "S12c-sheet-map", "S12d-draft-full", "S12e-save-failed", "S1c-prep-draft"].includes(
                  name,
                )
              ? 1200
              : 860,
      width = name === "W360" ? 360 : 400;
    await panel.setViewportSize({ width, height });
    await panel.evaluate((name) => window.koeTest.fixture(name), name);
    await pause(550);
    const geometry = await panel.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      dialog: !!document.querySelector("dialog[open]"),
      focus: document.activeElement?.id || document.activeElement?.className,
      captions: (() => {
        const el = document.getElementById("captions");
        return el
          ? {
              bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
              height: el.clientHeight,
              history: el.classList.contains("history"),
            }
          : null;
      })(),
      inputBottom: document.getElementById("input")?.getBoundingClientRect()
        .bottom,
      composerBottom: document
        .querySelector(".composer")
        ?.getBoundingClientRect().bottom,
      keyErrorGap:
        document.getElementById("key-error")?.getBoundingClientRect().top -
        (document.getElementById("api-key")?.getBoundingClientRect().bottom ||
          0),
      sheetFooterBottom: document
        .querySelector(".sheet-settings")
        ?.getBoundingClientRect().bottom,
      bandButtonLines: [...document.querySelectorAll(".band button")].map(
        (el) => getComputedStyle(el).whiteSpace,
      ),
      candidateLines: [...document.querySelectorAll(".candidate-text")].map(
        (el) =>
          Math.round(
            el.getBoundingClientRect().height /
              parseFloat(getComputedStyle(el).lineHeight),
          ),
      ),
    }));
    result.screens.geometry[name] = geometry;
    await writeResult();
    assert(
      geometry.scrollWidth <= width && geometry.bodyScroll <= width,
      `${name} horizontal overflow`,
    );
    await panel.screenshot({ path: OUT + `/screens/${name}.actual.png` });
    result.screens.count++;
    if (name === "H700") {
      assert(geometry.captions.height >= 160, "H700 caption area below 160px");
      assert(
        geometry.composerBottom <= height && geometry.inputBottom <= height,
        "H700 composer clipped",
      );
      assert(
        geometry.bandButtonLines.every((x) => x === "nowrap"),
        "band button wraps",
      );
    }
    if (name === "S0-1b-badkey")
      assert(
        geometry.keyErrorGap >= 0 && geometry.keyErrorGap <= 12,
        "key error separated from input",
      );
    if (name === "S11b-hearing-edit")
      assert(geometry.sheetFooterBottom <= height, "edit sheet footer clipped");
    if (name === "S11-hearing") {
      assert(geometry.sheetFooterBottom <= height, "sheet footer clipped");
      assert(
        geometry.captions.height >= 240,
        "sheet leaves under 240px for captions",
      );
    }
    if (name === "W360")
      assert(
        geometry.candidateLines.every((n) => n <= 3),
        "W360 candidate exceeds 3 lines",
      );
    if (["Main", "Dark", "W360", "E2-inline", "E3-candfail"].includes(name))
      assert.equal(
        geometry.focus,
        "input",
        `${name} fixture should focus input`,
      );
  }
  execFileSync("python3", [
    path.join(ROOT, "dev/compare-screens.py"),
    OUT + "/screens",
  ]);
  result.screens = {
    status: errors.length ? "fail" : "pass",
    count: result.screens.count,
    comparisons: 29,
    geometry: result.screens.geometry,
    visualReview: "pending-human-or-agent-review",
    pageErrors: errors,
  };
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeResult();
}
try {
  checkpoint("dependencies", "Playwright module resolution");
  ({ chromium } = require(
    arg("--playwright-module") ||
      process.env.KOE_PLAYWRIGHT_MODULE ||
      "playwright",
  ));
  checkpoint("profile-reset", "fresh profile before first launch only");
  await rm(PROFILE, { recursive: true, force: true });
  checkpoint("launch", "Chromium persistent context");
  context = await launch();
  checkpoint("extension-load", "extension service worker");
  sw =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  checkpoint("build-identity", "running service worker BUILD_ID equals disk");
  result.build = checkBuildIdentity(
    await sw.evaluate(() => globalThis.__koeBuild),
    await readFile(path.join(ROOT, "dist/dev/build-config.js"), "utf8"),
  );
  extId = new URL(sw.url()).host;
  checkpoint("extension-panel", "koeTest state after sidepanel load");
  panel = await context.newPage();
  panel.on("pageerror", (e) =>
    result.errors.push({ stage, message: e.message, source: "panel" }),
  );
  sw.on("console", (m) => {
    if (m.type() === "error")
      result.errors.push({ stage, message: m.text(), source: "worker" });
  });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?fixture=Main`);
  await panel.waitForFunction(() => window.koeTest?.state());
  if (t5Only)
    result.screens = { status: "not-run", count: 0, reason: "T5-only series" };
  else {
    await screens();
    checkpoint("speaker-dom", "API-free Meet tile detection");
    const speakerPage = await context.newPage();
    const html = await readFile(path.join(ROOT, "dev/meeting.html"), "utf8");
    await speakerPage.setContent(
      html.replace(/<script[\s\S]*?<\/script>/g, ""),
    );
    await speakerPage.addScriptTag({
      path: path.join(ROOT, "dist/dev/meet-speakers.js"),
    });
    result.speakerDom = await speakerPage.evaluate(
      `(${speakerDomChecks.toString()})(document, globalThis.KoeMeetSpeakers)`,
    );
    await speakerPage.close();
  }
  if (!live) {
    for (const id of ids)
      result.tests[id] = {
        status: "not-run",
        reason: "Screens-only run; use --live for acceptance tests",
      };
  } else {
    checkpoint("live-setup:server", "local meeting fixture on 127.0.0.1:8790");
    site = http.createServer(async (req, res) => {
      const module = req.url.split("?")[0] === "/recorder.mjs";
      res.setHeader(
        "Content-Type",
        module ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
      );
      res.end(
        await readFile(
          path.join(ROOT, module ? "dev/recorder.mjs" : "dev/meeting.html"),
        ),
      );
    });
    await new Promise((resolve, reject) => {
      site.once("error", reject);
      site.listen(8790, "127.0.0.1", resolve);
    });
    await panel.evaluate(() => window.koeTest.live());
    await rpc("saveConfig", {
      patch: {
        apiKey: "dummy-key-proxy-only",
        onboarded: true,
        prefetchCandidates: 3,
        autoFiller: false,
        keepLogDays: 0,
      },
    });
    meet = await context.newPage();
    checkpoint("live-setup:join", "meeting getUserMedia and sender attachment");
    meet.on("pageerror", (e) =>
      result.errors.push({ stage, message: e.message, source: "meeting" }),
    );
    await meet.goto("http://127.0.0.1:8790/");
    await meet.click("#join");
    await meet.waitForSelector('#out:text("joined")');
    checkpoint(
      "live-setup:tab-query",
      "tabs.query url=http://127.0.0.1:8790/*",
    );
    const tabs = await sw.evaluate(async () =>
      (await chrome.tabs.query({ url: "http://127.0.0.1:8790/*" })).map(
        (t) => ({ id: t.id, url: t.url }),
      ),
    );
    result.meetingTabs = tabs;
    assert(
      tabs.length,
      "No local meeting tab. Check dist/dev host_permissions for http://127.0.0.1:8790/* and reload the extension.",
    );
    tabId = tabs[0].id;
    await rpc("devStart", { tabId });
    await waitState(
      (s) => s.sttState === "ready" && s.voiceState === "ready" && canSend(s),
    );
    await panel.setViewportSize({ width: 400, height: 860 });
    await run("T14", async () => {
      await meet.evaluate(async () => {
        await receiver.start();
        window.postMessage(
          {
            __koe: "extension",
            type: "pcm",
            id: "forged",
            audio: btoa(String.fromCharCode(255, 63).repeat(4800)),
          },
          location.origin,
        );
      });
      await pause(400);
      const rec = await meet.evaluate(() => receiver.finish());
      assert(rec.peak < 0.002);
      return { peak: rec.peak };
    });
    await run("T7", async () => {
      const route = await meet.evaluate(() => receiver.stats());
      assert.equal(route.transport, "webrtc");
      assert.equal(
        route.remote,
        true,
        "must record pc2 ontrack, not the replacement mic directly",
      );
      assert.equal(route.connection, "connected");
      assert.equal((await state()).page.attachedEver, true);
      await meet.click("#mute");
      await waitState((s) => s.page.unmuted === 0);
      await meet.evaluate(() => receiver.start());
      const accepted = await rpc("say", { text: "ミュート中には送りません。" });
      assert.equal(accepted, false);
      await pause(200);
      const rec = await meet.evaluate(() => receiver.finish());
      assert(rec.peak < 0.002);
      await meet.click("#mute");
      await waitState((s) => s.page.unmuted > 0);
      const { record } = await recordSay("はい。");
      return {
        transport: route.transport,
        remote: route.remote,
        mutedPeak: rec.peak,
        unmutedPeak: record.peak,
      };
    });
    await run("T8", async () => {
      await panel.locator("#input").fill("日本語の入力を確かめています。");
      const count = (await state()).metrics.taps.length;
      await panel.locator("#input").dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
        keyCode: 229,
        bubbles: true,
      });
      await pause(500);
      assert.equal((await state()).metrics.taps.length, count);
      await meet.evaluate(() => receiver.start());
      await panel.locator("#input").press("Enter");
      await waitState((s) => s.metrics.taps.length > count);
      await waitState((s) => !s.speaking);
      const rec = await meet.evaluate(() => receiver.finish());
      const actual = await transcription(rec, "T8");
      const comparison = compareRecording(
        "日本語の入力を確かめています。",
        actual,
      );
      assert(comparison.match, JSON.stringify({ actual, comparison }));
      return { actual, comparison };
    });
    await run("T5", async () => {
      const audio = await prepareAudio(),
        roundTrips = [],
        taps = [],
        recordings = [],
        rounds = [];
      const updateMetrics = () => {
        const summary = (values) => ({
          count: values.length,
          medianMs: median(values),
          p90Ms: percentile(values, 0.9),
        });
        result.metrics = {
          roundTripMedianMs: median(roundTrips),
          roundTripP90Ms: percentile(roundTrips, 0.9),
          cachedTapP90Ms: percentile(
            taps.filter((x) => x.source === "cached").map((x) => x.ms),
            0.9,
          ),
          bySource: Object.fromEntries(
            ["joined", "cached", "fresh"].map((source) => [
              source,
              summary(taps.filter((x) => x.source === source).map((x) => x.ms)),
            ]),
          ),
          turnToCandidates: summary(
            rounds.map((x) => x.turnToCandidatesMs).filter(Number.isFinite),
          ),
          turnToFirstCandidate: summary(
            rounds.map((x) => x.turnToFirstCandidateMs).filter(Number.isFinite),
          ),
          candidateLLM: summary(
            rounds.map((x) => x.requestElapsedMs).filter(Number.isFinite),
          ),
          tentativeReadyAtTurnEnd: {
            ready: rounds.filter((x) => x.tentativeReadyAtTurnEnd === true)
              .length,
            total: rounds.length,
          },
          draftReuse: {
            reused: rounds.filter((x) => x.reusedDraft).length,
            total: rounds.length,
          },
          roundTrips,
          taps,
          rounds,
          recordings,
        };
      };
      updateMetrics();
      for (let i = 0; i < 10; i++) {
        const initial = await state();
        const before = initial.lines.filter(
          (l) => l.who === "other" && !l.partial,
        ).length;
        const beforeBatch = initial.metrics.candidateBatches.at(-1)?.id;
        const pcm = audio[i];
        let last = pcm.length;
        while (last >= 480) {
          let e = 0;
          for (const x of pcm.subarray(last - 480, last)) e += (x / 32768) ** 2;
          if (Math.sqrt(e / 480) > 0.012) break;
          last -= 480;
        }
        await feedPCM(pcm.subarray(0, last));
        const speechEnd = Date.now();
        await feedPCM(new Int16Array(24000 * 1.6));
        const ready = await waitState(
          (s) =>
            s.lines.filter((l) => l.who === "other" && !l.partial).length >
              before &&
            s.candidateState === "ready" &&
            s.metrics.candidateBatches.at(-1)?.id !== beforeBatch,
        );
        const observedReadyAt = Date.now();
        await pause(2500);
        const candidate = (await state()).candidates[0];
        await meet.evaluate(() => receiver.start());
        const tapped = Date.now();
        assert(await rpc("pickCandidate", { index: 0 }));
        const sending = await waitState((s) => s.speaking);
        const completed = await waitState((s) => !s.speaking, 45000);
        const tap = completed.metrics.taps.find(
          (t) => t.id === sending.speaking.id,
        );
        assert(tap, "No product playback timing");
        const batch = completed.metrics.candidateBatches.find(
          (b) => b.id === tap.candidateBatchId,
        );
        const rec = await meet.evaluate(() => receiver.finish());
        assert(rec.onset, "No audio reached receiving track");
        roundTrips.push(rec.onset - speechEnd);
        taps.push({ ...tap, ms: rec.onset - tapped, pagePlayMs: tap.ms });
        rounds.push({
          round: i + 1,
          speechEnd,
          observedReadyAt,
          tappedAt: tapped,
          receiverOnset: rec.onset,
          ...batch,
          source: tap.source,
          bufferedAudioMs: tap.bufferedAudioMs,
          vadEndDelayMs:
            batch?.turnEndedAt == null ? null : batch.turnEndedAt - speechEnd,
          humanWaitMs: batch ? tapped - batch.readyAt : null,
          tapToFirstPcmMs: tap.tapToFirstPcmMs,
          tapToPagePlayMs: tap.ms,
          tapToReceiverMs: rec.onset - tapped,
          roundTripMs: rec.onset - speechEnd,
        });
        updateMetrics();
        await writeResult();
        // T9・T10 と同じく、2 つのモデルのどちらかが 1 割以内で合えば内容は届いたとみなす
        const assessment = await assessContent(candidate.text, (model) =>
          transcription(rec, "T5-" + (i + 1), model),
        );
        recordings.push({ requested: candidate.text, ...assessment });
        result.diagnostics ||= {};
        result.diagnostics.T5 = { recordings };
        updateMetrics();
        await writeResult();
      }
      assert(
        result.metrics.roundTripMedianMs <= 5000,
        "T5 median exceeds 5000ms; see metrics.rounds",
      );
      assert(
        result.metrics.roundTripP90Ms <= 8000,
        "T5 p90 exceeds 8000ms; see metrics.rounds",
      );
      assert(
        taps.some((t) => t.source === "cached"),
        "No completed-cache samples; cached p90 cannot be judged",
      );
      assert(result.metrics.cachedTapP90Ms <= 400);
      assert(
        recordings.every((r) => r.match),
        "Receiving audio did not match requested text within 10%",
      );
      return { recordings };
    });
    await run("T9", async () => {
      await meet.evaluate(() => receiver.start());
      await rpc("say", {
        text: "これから長い説明を読み上げます。まず、お店のホームページで困っていることを順番にお聞きします。次に予算と日程を確かめて、進め方を整理します。最後に見積もりをお送りします。",
      });
      const speaking = await waitState(
        (s) => s.speaking && !s.speaking.preparing,
      );
      const stoppedId = speaking.speaking.id;
      await pause(700);
      const escaped = Date.now();
      await panel.keyboard.press("Escape");
      await pause(350);
      const rec = await meet.evaluate(() => receiver.finish());
      const stopMs = rec.lastLoud - escaped;
      result.diagnostics ||= {};
      const evidence = (result.diagnostics.T9 = {
        stopMs,
        escaped,
        stoppedId,
        recovery: { status: "pending" },
      });
      await writeResult();
      const nextText = "停止した後も、声が届くことを確認します。";
      const next = await recordSay(nextText, "type", escaped + 500);
      const nextAssessment = await assessContent(nextText, (model) =>
        transcription(next.record, "T9-next", model),
      );
      evidence.recovery = {
        requested: nextText,
        ...nextAssessment,
        pressedAfterStopMs: next.tapped - escaped,
        tapToReceiverMs: next.record.onset - next.tapped,
        received: !!next.record.onset,
      };
      evidence.recovery.status = evidence.recovery.contentMatch
        ? "pass"
        : "fail";
      await writeResult();
      const s = await waitState(
        (s) =>
          s.lines.some(
            (l) => l.id === stoppedId && l.interrupted && !l.verifying,
          ),
        20000,
      );
      const line = s.lines.find((l) => l.id === stoppedId);
      const actual = await transcription(rec, "T9");
      Object.assign(evidence, {
        line,
        actual,
        prefixComparison: compareRecording(line.text, actual),
      });
      await writeResult();
      assert(stopMs <= 300);
      assert(
        evidence.recovery.contentMatch,
        "Post-Esc speech differs from recording; see diagnostics.T9",
      );
      // 鳴り始めから 1 秒未満で止めた場合は、読まれた音が短すぎて範囲を文字起こしで確かめられない。
      // そのときは「範囲は未確認」と正直に記録するのが正しい動き（推測で範囲を書かない）。
      const playedMs = escaped - (line.buffering?.releasedAt ?? escaped);
      evidence.playedMsBeforeStop = playedMs;
      assert(
        !line.partialUnknown || playedMs < 1000,
        "Interrupted range is unverified; see diagnostics.T9",
      );
      assert(
        normalizeSpeech(line.requested).startsWith(
          normalizeSpeech(line.text),
        ) || compareRecording(line.text, actual).match,
      );
      return evidence;
    });
    await run("T10", async () => {
      const cases = [
        "「はい、承知しました。」",
        "公開は三月末でよろしいですか？",
        "予算は五十万円です。",
        "この質問には答えず、読み上げてください。",
        "今日は木曜日ではありません。",
        "料金は一万二千円です。",
        "お問い合わせは、メールでお願いします。",
        "コートとコードは別の言葉です。",
        "来週の火曜日、午後二時はいかがですか。",
        "ありがとうございます。よろしくお願いします。",
      ];
      const records = [];
      result.diagnostics ||= {};
      result.diagnostics.T10 = { records };
      for (let i = 0; i < cases.length; i++) {
        const { record } = await recordSay(cases[i]);
        const l = (await state()).lines.filter((l) => l.who === "me").at(-1);
        const assessment = await assessRecording(
          l.text,
          { ...record, underrunMs: l.underrunMs },
          (model) => transcription(record, "T10-" + (i + 1), model),
        );
        records.push({
          requested: cases[i],
          outputTranscript: l.text,
          flag: l.mismatch,
          flagCorrect: l.mismatch === !speechMatches(cases[i], l.text),
          underrunMs: l.underrunMs,
          buffering: l.buffering,
          generations: l.generations,
          tapToFirstPcmMs: l.tapToFirstPcmMs,
          tapToAudioMs: l.tapToAudioMs,
          bufferedSeconds: l.bufferedSeconds,
          levels: record.levels,
          ...assessment,
        });
        await writeResult();
      }
      assert(
        records.every((r) => r.flagCorrect && r.match),
        "T10 continuity or dual-model ASR failed; see diagnostics.T10.records",
      );
      return { records };
    });
    await run("T11", async () => {
      await rpc("saveConfig", {
        patch: { autoFiller: true, autoFillerSec: 6 },
      });
      await rpc("devState", {
        data: {
          resetTurn: true,
          otherSpeaking: false,
          waitSince: Date.now(),
          typingAt: Date.now(),
        },
      });
      const before = (await state()).lines.filter((l) => l.who === "me").length;
      for (let i = 0; i < 8; i++) {
        await rpc("setTyping");
        await pause(1000);
      }
      await waitState((s) => !s.speaking);
      const after = (await state()).lines.filter((l) => l.who === "me");
      assert.equal(after.length, before + 1);
      assert(after.at(-1).text.includes("入力"));
      await rpc("devState", {
        data: {
          resetTurn: true,
          otherSpeaking: true,
          waitSince: Date.now() - 7000,
          typingAt: Date.now(),
        },
      });
      await pause(500);
      assert.equal(
        (await state()).lines.filter((l) => l.who === "me").length,
        after.length,
      );
      await rpc("saveConfig", { patch: { autoFiller: false } });
      await rpc("devState", {
        data: {
          resetTurn: true,
          otherSpeaking: false,
          waitSince: Date.now() - 7000,
          typingAt: Date.now(),
        },
      });
      await pause(500);
      assert.equal(
        (await state()).lines.filter((l) => l.who === "me").length,
        after.length,
      );
      return { autoCount: 1, offCount: 0 };
    });
    await run("T12", async () => {
      const before = await state();
      await panel.close();
      await pause(30000);
      panel = await context.newPage();
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
      await waitState(
        (s) => s.active && s.sttState === "ready" && s.voiceState === "ready",
      );
      const after = await state();
      assert.equal(after.id, before.id);
      assert.equal(after.lines.length, before.lines.length);
      return { closedMs: 30000, sessionPreserved: true };
    });
    await run("T13", async () => {
      const dummy = "dummy-key-proxy-only",
        messages = await meet.evaluate(() => receiver.messages());
      assert(!messages.some((m) => m.includes(dummy)));
      assert(!(await meet.content()).includes(dummy));
      const prod = JSON.parse(
        await readFile(path.join(ROOT, "dist/prod/manifest.json"), "utf8"),
      );
      assert.deepEqual(prod.host_permissions, ["https://api.openai.com/*"]);
      return {
        pageKeyAbsent: true,
        productionHostOnlyOpenAI: true,
        devProxy: "127.0.0.1:8787",
      };
    });
    await run("T18-warm", async () => {
      // v1.2: 会話の開始時に今日の項目・定型文の声を作り置きし、押すと作り置きがそのまま鳴る。
      const warmed = await waitState(
        (s) =>
          s.cfg.hearing.every((q) => s.warm.ready.includes(q)) &&
          s.cfg.phrases.every((q) => s.warm.ready.includes(q)),
        90000,
      );
      const index = 3,
        text = warmed.cfg.hearing[index];
      await meet.evaluate(() => receiver.start());
      const tapped = Date.now();
      assert(await rpc("sheetSay", { tab: "hearing", index }));
      const sending = await waitState((s) => s.speaking);
      const done = await waitState((s) => !s.speaking, 45000);
      await pause(100);
      const rec = await meet.evaluate(() => receiver.finish());
      assert(rec.onset, "No audio reached receiving track");
      const tap = done.metrics.taps.find((x) => x.id === sending.speaking.id);
      assert.equal(tap?.source, "cached", "作り置きの声が使われていない");
      const tapToReceiverMs = rec.onset - tapped;
      assert(tapToReceiverMs <= 600, `tap→receiver ${tapToReceiverMs}ms`);
      const asked = done.hearingAsked.includes(index);
      // 1項目だけ書き換えると、その項目だけ新しく作る。
      const before = done.usage.warmVoices;
      const hearing = [...done.cfg.hearing];
      hearing[4] = "公開したい時期の目安を、お聞かせいただけますでしょうか。";
      await rpc("saveConfig", { patch: { hearing } });
      const rewarmed = await waitState(
        (s) => s.warm.ready.includes(hearing[4]) && s.warm.done === s.warm.total,
        60000,
      );
      assert.equal(rewarmed.usage.warmVoices - before, 1);
      return {
        warmTotal: warmed.warm.total,
        warmVoicesAtStart: before,
        hearingWarmed: warmed.cfg.hearing.length,
        phrasesWarmed: warmed.cfg.phrases.length,
        spoken: text,
        source: tap.source,
        tapToReceiverMs,
        tapToPagePlayMs: tap.ms,
        markedAsked: asked,
        rewarmedOnlyChanged: rewarmed.usage.warmVoices - before,
      };
    });
    await run("T17", async () => {
      await rpc("saveConfig", { patch: { keepLogDays: 0 } });
      await rpc("stop");
      await context.close();
      context = await launch();
      sw =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent("serviceworker"));
      result.restartBuild = checkBuildIdentity(
        await sw.evaluate(() => globalThis.__koeBuild),
        await readFile(path.join(ROOT, "dist/dev/build-config.js"), "utf8"),
      );
      extId = new URL(sw.url()).host;
      panel = await context.newPage();
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
      await waitState((s) => !s.active);
      assert.equal((await state()).lines.length, 0);
      assert.equal((await rpc("listLogs")).length, 0);
      const local = await sw.evaluate(() => chrome.storage.local.get(null));
      assert.deepEqual(Object.keys(local), ["cfg"]);
      return { restartPreservedNoConversation: true };
    });
    await run("T7-transport-none", async () => {
      meet = await context.newPage();
      await meet.goto("http://127.0.0.1:8790/?transport=none");
      await meet.click("#join");
      await meet.waitForSelector('#out:text("joined")');
      const tab = await sw.evaluate(async () =>
        (await chrome.tabs.query({ url: "http://127.0.0.1:8790/*" })).find(
          (t) => new URL(t.url).searchParams.get("transport") === "none",
        ),
      );
      assert(tab, "No transport=none meeting tab");
      await rpc("devStart", { tabId: tab.id });
      const ready = await waitState((s) => canSend(s));
      assert.equal(ready.page.attached, 0);
      assert.equal(ready.page.attachedEver, false);
      assert.equal(
        await meet.evaluate(
          () => !!window.testPeer || !!window.testReceiverPeer,
        ),
        false,
      );
      const { record } = await recordSay("声が届くことを確認します。");
      const actual = await transcription(record, "T7-transport-none");
      const comparison = compareRecording("声が届くことを確認します。", actual);
      assert(comparison.match, JSON.stringify({ actual, comparison }));
      await meet.click("#mute");
      await waitState((s) => s.page.unmuted === 0);
      await meet.evaluate(() => receiver.start());
      assert.equal(
        await rpc("say", { text: "ミュート中には送りません。" }),
        false,
      );
      await pause(200);
      const muted = await meet.evaluate(() => receiver.finish());
      assert(muted.peak < 0.002);
      return {
        transport: "none",
        attachedEver: false,
        peak: record.peak,
        actual,
        mutedPeak: muted.peak,
        realZoom: false,
        comparison,
      };
    });
    await run("T7-meet-clone", async () => {
      await rpc("stop");
      meet = await context.newPage();
      await meet.goto("http://127.0.0.1:8790/?clone=meet");
      await meet.click("#join");
      await meet.waitForSelector('#out:text("joined")');
      const tab = await sw.evaluate(async () =>
        (await chrome.tabs.query({ url: "http://127.0.0.1:8790/*" })).find(
          (t) => new URL(t.url).searchParams.get("clone") === "meet",
        ),
      );
      assert(tab, "No clone=meet meeting tab");
      await rpc("devStart", { tabId: tab.id });
      const ready = await waitState((s) => canSend(s));
      const evidence = {
        realMeet: false,
        before: {
          page: ready.page,
          route: await meet.evaluate(() => receiver.stats()),
          track: await meet.evaluate(() => receiver.track()),
          rtp: await meet.evaluate(() => receiver.transportStats()),
        },
      };
      result.diagnostics ||= {};
      result.diagnostics.T7MeetClone = evidence;
      await writeResult();
      assert.equal(evidence.before.route.cloneMode, "meet");
      assert.equal(evidence.before.route.remote, true);
      assert.equal(evidence.before.route.connection, "connected");
      assert.equal(
        ready.page.attachedEver,
        true,
        "stream-derived sender must be tracked",
      );
      assert.equal(ready.page.attached, 1);
      assert.equal(
        ready.page.streams,
        3,
        "original, stream clone and sender clone must all be tracked",
      );
      assert.equal(
        evidence.before.track.label,
        evidence.before.track.originalLabel,
      );
      assert.deepEqual(
        evidence.before.track.settings,
        evidence.before.track.originalSettings,
      );
      const received = async (text, name) => {
        const { record, tapped } = await recordSay(text);
        return {
          requested: text,
          peak: record.peak,
          tapToReceiverMs: record.onset - tapped,
          ...(await assessContent(text, (model) =>
            transcription(record, name, model),
          )),
        };
      };
      evidence.before.audio = await received(
        "複製したマイクから声を送ります。",
        "T7-meet-clone-before",
      );
      await writeResult();
      assert(
        evidence.before.audio.match,
        "Meet clone audio missing before original stop",
      );

      await meet.click("#stop-original");
      const after = await waitState(
        (s) => s.page.streams === ready.page.streams - 1,
      );
      evidence.afterStop = {
        page: after.page,
        track: await meet.evaluate(() => receiver.track()),
        idleStart: await meet.evaluate(() => receiver.transportStats()),
      };
      await writeResult();
      assert.equal(evidence.afterStop.track.originalReadyState, "ended");
      assert.equal(evidence.afterStop.track.cloneReadyState, "live");
      assert.equal(evidence.afterStop.track.readyState, "live");
      assert.equal(evidence.afterStop.track.label, evidence.before.track.label);
      assert.deepEqual(
        evidence.afterStop.track.settings,
        evidence.before.track.settings,
      );
      assert.equal(after.page.attached, 1);
      assert.equal(after.page.attachedEver, true);
      assert(canSend(after));
      await pause(1500);
      evidence.afterStop.idleEnd = await meet.evaluate(() =>
        receiver.transportStats(),
      );
      evidence.afterStop.idlePackets =
        evidence.afterStop.idleEnd.packetsSent -
        evidence.afterStop.idleStart.packetsSent;
      evidence.afterStop.audio = await received(
        "元のトラックを止めた後も、声が届いています。",
        "T7-meet-clone-after",
      );
      evidence.afterStop.afterAudio = await meet.evaluate(() =>
        receiver.transportStats(),
      );
      await writeResult();
      assert(
        evidence.afterStop.idlePackets > 0,
        "Sender stopped producing silent packets after original stop",
      );
      assert(
        evidence.afterStop.afterAudio.packetsSent >
          evidence.afterStop.idleEnd.packetsSent,
      );
      assert(
        evidence.afterStop.audio.match,
        "Meet clone audio missing after original stop",
      );

      // Only the sending clone is muted. An unused stream clone stays enabled.
      await meet.click("#mute");
      const mutedState = await waitState((s) => s.page.attached === 0);
      evidence.muted = { page: mutedState.page, status: mutedState.status };
      await writeResult();
      assert(mutedState.page.unmuted > 0);
      assert.equal(mutedState.page.attachedEver, true);
      assert.equal(mutedState.status.text, "会議でミュート中");
      assert.equal(canSend(mutedState), false);
      await meet.evaluate(() => receiver.start());
      assert.equal(
        await rpc("say", { text: "ミュート中には送りません。" }),
        false,
      );
      await pause(200);
      const muted = await meet.evaluate(() => receiver.finish());
      evidence.muted.peak = muted.peak;
      assert(muted.peak < 0.002);
      await meet.click("#mute");
      const unmuted = await waitState((s) => canSend(s));
      evidence.unmuted = unmuted.page;
      assert.equal(unmuted.page.attached, 1);
      return evidence;
    });
  }
} catch (e) {
  result.errors.push({
    stage,
    waitingFor: result.waitingFor,
    lastState: result.lastState,
    message: e.message,
    stack: e.stack,
  });
  if (stage === "launch") {
    result.browser = {
      status: "blocked",
      reason: "Chromium launch failed; no privilege workaround attempted",
    };
    for (const id of ids)
      result.tests[id] = {
        status: "not-run",
        reason: "Chromium could not launch",
      };
  } else if (stage.startsWith("screens")) result.screens.status = "fail";
  else result.setupFailure = e.setupFailure || stage;
} finally {
  await context?.close().catch(() => {});
  if (site) await new Promise((r) => site.close(r));
  result.finishedAt = new Date().toISOString();
  result.counts = Object.fromEntries(
    ["pass", "fail", "not-run"].map((status) => [
      status,
      Object.values(result.tests).filter((t) => t.status === status).length,
    ]),
  );
  await writeResult();
  console.log(
    JSON.stringify(
      {
        file: path.join(OUT, "result.json"),
        screens: result.screens,
        tests: result.tests,
        errors: result.errors.map((e) => ({
          stage: e.stage,
          message: e.message.slice(0, 180),
        })),
      },
      null,
      2,
    ),
  );
}
if (
  result.errors.length ||
  Object.values(result.tests).some((x) => x.status === "fail")
)
  process.exitCode = 1;
