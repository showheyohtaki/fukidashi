// One real synthesis via the already-running proxy. No browser or receiver audio.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? null : process.argv[i + 1];
};
const out = path.resolve(
  root,
  arg("--out") || "docs/test-log/2026-11-01/round3",
);
if (!out.startsWith(root))
  throw new Error("Output must remain inside koe-bridge");
const built = (n) => import(pathToFileURL(path.join(root, "dist/dev", n)).href);
const { API_BASE } = await built("build-config.js");
assert.equal(API_BASE, "http://127.0.0.1:8787");
const { Session } = await built("session.js"),
  { Speaker } = await built("openai.js");
const { configWith } = await built("config.js"),
  { speechMatches } = await built("protocol.js");
const result = {
  at: new Date().toISOString(),
  kind: "development API prefetch handoff; no browser, no receiving audio",
  status: "fail",
};
const memory = new Map(),
  pageChunks = [];
let firstDispatch = null,
  mainCalls = 0,
  preCalls = 0,
  task;
const s = new Session({
  cache: {
    get: async (k) => memory.get(k),
    put: async (k, v) => memory.set(k, v),
    expire: async () => {},
  },
  page: (m) => {
    if (m.type === "pcm") {
      firstDispatch ??= Date.now();
      pageChunks.push(m.audio);
    }
  },
});
const text = "予算は五十万円です。";
const wait = async (fn) => {
  const deadline = Date.now() + 30000;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error("API prefetch timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
try {
  s.cfg = s.savedCfg = configWith({
    apiKey: "dummy-key-proxy-only",
    autoFiller: false,
    prefetchCandidates: 0,
  });
  Object.assign(s.s, {
    active: true,
    connectedOnce: true,
    sttState: "ready",
    voiceState: "ready",
    preState: "ready",
    page: {
      streams: 1,
      unmuted: 1,
      attached: 0,
      attachedEver: false,
      context: "running",
    },
  });
  s.main = {
    ready: true,
    speak() {
      mainCalls++;
      throw new Error("Duplicate main synthesis");
    },
    close() {},
  };
  s.pre = new Speaker(s.cfg);
  const speak = s.pre.speak.bind(s.pre);
  s.pre.speak = (...args) => {
    preCalls++;
    return speak(...args);
  };
  s.pre.connect();
  const began = Date.now();
  task = s.synthesizeCached(text);
  // Observe early failures without losing finally cleanup.
  let failure;
  task.catch((e) => {
    failure = e;
  });
  await wait(
    () =>
      failure ||
      [...s.syntheses.values()].some((e) => e.chunks.length && !e.result),
  );
  if (failure) throw failure;
  const entry = [...s.syntheses.values()][0];
  assert(!entry.result, "Must join before synthesis completes");
  const tapped = Date.now();
  assert(await s.say(text, "candidate"));
  const job = s.job;
  assert.equal(job.source, "joined");
  assert(firstDispatch != null, "Buffered PCM was not dispatched on tap");
  const value = await task;
  assert(value && speechMatches(text, value.transcript));
  assert.deepEqual(
    pageChunks,
    value.chunks,
    "Buffered and later PCM must arrive exactly once",
  );
  assert.equal(mainCalls, 0);
  assert.equal(preCalls, 1);
  Object.assign(result, {
    status: "pass",
    source: job.source,
    input: text,
    transcript: value.transcript,
    synthesisRequests: preCalls + mainCalls,
    bufferedChunks: job.bufferedChunks,
    bufferedAudioMs: job.bufferedAudioMs,
    prefetchBeforeTapMs: tapped - began,
    tapToDispatchMs: firstDispatch - tapped,
    totalSynthesisMs: Date.now() - began,
    chunks: value.chunks.length,
    inputCharacters: s.s.usage.inputCharacters,
    voiceSeconds: s.s.usage.voiceSeconds,
  });
} catch (error) {
  result.error = error.message;
} finally {
  s.pre?.close();
  s.main?.close();
  clearInterval(s.interval);
  clearInterval(s.expiryTimer);
  for (const job of s.jobs.values()) {
    clearTimeout(job.watchdog);
    clearTimeout(job.cancelFallback);
  }
  await task?.catch(() => {});
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, "prefetch-api-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}
if (result.status !== "pass") process.exitCode = 1;
