// Product Session + Speaker through the existing proxy. No browser, receiver,
// microphone, or real playback: play-start is simulated only to acknowledge PCM.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Session } from "../dist/dev/session.js";
import { Speaker } from "../dist/dev/openai.js";
import { configWith } from "../dist/dev/config.js";
import { speechMatches } from "../dist/dev/protocol.js";
import { API_BASE } from "../dist/dev/build-config.js";
assert.equal(API_BASE, "http://127.0.0.1:8787");
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.resolve(
  root,
  process.argv[2] || "docs/test-log/2026-11-02/round7",
);
assert(out.startsWith(root), "Output must remain in koe-bridge");
const text =
  "これから長い説明を読み上げます。まず、お店のホームページで困っていることを順番にお聞きします。次に予算と日程を確かめて、進め方を整理します。最後に見積もりをお送りします。";
const result = {
  at: new Date().toISOString(),
  kind: "API synthesis and PCM dispatch only; simulated play-start, no receiver",
  status: "fail",
  input: text,
  events: [],
};
const pageChunks = [];
let job, firstDispatch;
const s = new Session({
  cache: { get: async () => null, expire: async () => {} },
  page: (m) => {
    if (m.type === "pcm") {
      pageChunks.push(m.audio);
      if (!firstDispatch) {
        firstDispatch = Date.now();
        queueMicrotask(() => s.pageEvent({ type: "play-start", id: m.id }));
      }
    } else result.events.push({ type: m.type, at: Date.now() });
  },
});
const wait = async (fn) => {
  const end = Date.now() + 60000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("API smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
try {
  s.cfg = configWith({
    apiKey: "dummy-key-proxy-only",
    autoFiller: false,
    prefetchCandidates: 0,
  });
  Object.assign(s.s, {
    active: true,
    connectedOnce: true,
    sttState: "ready",
    voiceState: "ready",
    preState: "idle",
    page: { streams: 1, unmuted: 1, context: "running" },
  });
  s.main = new Speaker(s.cfg);
  s.main.connect();
  await wait(() => s.main.ready);
  assert(await s.say(text));
  job = s.job;
  await wait(() => job.result);
  Object.assign(result, {
    source: job.source,
    responseStatus: job.result.status,
    transcript: job.result.transcript,
    tapToDispatchMs: firstDispatch == null ? null : firstDispatch - job.tapped,
    totalSynthesisMs: Date.now() - job.tapped,
    buffering: job.buffering,
    generations: s.generationMetrics(job),
    chunks: pageChunks.length,
    audioSeconds: job.audioSeconds,
  });
  assert.equal(job.result.status, "completed");
  assert(
    speechMatches(text, job.result.transcript),
    "Combined transcript mismatch",
  );
  assert.deepEqual(
    pageChunks,
    job.result.chunks,
    "PCM order / completeness mismatch",
  );
  assert.equal(job.segments.length, 4);
  assert(
    firstDispatch <= job.segments[0].finishedAt,
    "First sentence waited beyond its completion",
  );
  assert.equal(result.events.filter((e) => e.type === "end").length, 1);
  result.status = "pass";
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (job) job.cancelled = true;
  s.main?.close();
  clearInterval(s.interval);
  clearInterval(s.expiryTimer);
  for (const j of s.jobs.values()) {
    clearTimeout(j.watchdog);
    clearTimeout(j.bufferTimer);
    clearTimeout(j.ackTimer);
    clearTimeout(j.cancelFallback);
  }
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, "buffer-api-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      error: result.error,
      tapToDispatchMs: result.tapToDispatchMs,
      totalSynthesisMs: result.totalSynthesisMs,
      rates: result.generations?.map((g) => g.rate),
    }),
  );
}
