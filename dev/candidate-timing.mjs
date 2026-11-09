// Real STT + reply requests with existing fixture WAVs. No browser or TTS output.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { Session } from "../dist/dev/session.js";
import { configWith } from "../dist/dev/config.js";
import { API_BASE } from "../dist/dev/build-config.js";
import { median, percentile } from "./metrics.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? d : process.argv[i + 1];
};
const out = path.resolve(root, arg("--out", "docs/test-log/2026-11-01/round5"));
const label = arg("--label", "relaxed");
assert(out.startsWith(root) && /^[a-z-]+$/.test(label));
assert.equal(API_BASE, "http://127.0.0.1:8787");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (predicate) => {
  const until = Date.now() + 25000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("candidate timing timeout");
    await pause(10);
  }
};
const s = new Session({
  cache: { expire: async () => {}, clearCandidates() {} },
  capture: { stop: async () => {} },
});
s.cfg = s.savedCfg = configWith({
  apiKey: "dummy-key-proxy-only",
  prefetchCandidates: 0,
  autoFiller: false,
  useLocalMic: true,
});
s.speculateReplies = label !== "final-only";
s.makeSpeakers = () => {};
s.prewarm = () => {};
const result = {
  at: new Date().toISOString(),
  label,
  kind: "Real STT/replies; no browser playback, no T5 acceptance",
  rounds: [],
};
try {
  await s.start(null, { test: true });
  await wait(() => s.stt.ready);
  for (let i = 1; i <= 10; i++) {
    const wav = await readFile(
      path.join(root, `docs/test-log/2026-11-01/input-${i}.wav`),
    );
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    let offset = 12,
      pcm;
    while (offset + 8 <= wav.length) {
      const size = wav.readUInt32LE(offset + 4);
      if (wav.toString("ascii", offset, offset + 4) === "data") {
        const data = wav.subarray(offset + 8, offset + 8 + size);
        pcm = new Int16Array(data.length / 2);
        for (let j = 0; j < pcm.length; j++) pcm[j] = data.readInt16LE(j * 2);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    assert(pcm);
    const previous = s.s.metrics.candidateBatches.at(-1)?.id;
    const started = performance.now();
    for (let pos = 0; pos < pcm.length + 38400; pos += 480) {
      const frame = new Int16Array(480);
      if (pos < pcm.length) frame.set(pcm.subarray(pos, pos + 480));
      s.feed(frame);
      await pause(Math.max(0, started + (pos + 480) / 24 - performance.now()));
    }
    await wait(
      () =>
        s.s.metrics.candidateBatches.at(-1)?.id !== previous &&
        s.s.metrics.candidateBatches.at(-1)?.count === 3,
    );
    const batch = s.s.metrics.candidateBatches.at(-1);
    result.rounds.push({
      round: i,
      ...batch,
      caption: s.s.metrics.captionFinals.at(-1),
      replies: s.s.candidates.map((c) => c.text),
    });
    console.log(
      JSON.stringify({
        round: i,
        firstMs: batch.turnToFirstCandidateMs,
        threeMs: batch.turnToCandidatesMs,
        caption: result.rounds.at(-1).caption,
      }),
    );
  }
  result.summary = {
    firstMedianMs: median(result.rounds.map((r) => r.turnToFirstCandidateMs)),
    threeMedianMs: median(result.rounds.map((r) => r.turnToCandidatesMs)),
    firstP90Ms: percentile(
      result.rounds.map((r) => r.turnToFirstCandidateMs),
      0.9,
    ),
    tentativeReady: s.s.metrics.turns.filter((t) => t.tentativeReady).length,
    reusedDraft: s.s.metrics.candidateRequests.filter((r) => r.reusedDraft)
      .length,
    requests: s.s.metrics.candidateRequests.length,
  };
  result.status = "pass";
} catch (e) {
  result.status = "fail";
  result.error = e.message;
} finally {
  s.s.active = false;
  s.suggestAbort?.abort();
  s.stt?.close();
  clearInterval(s.interval);
  clearInterval(s.expiryTimer);
  clearTimeout(s.draftTimer);
  result.metrics = s.s.metrics;
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, `candidate-timing-${label}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      summary: result.summary,
      error: result.error,
    }),
  );
}
if (result.status !== "pass") process.exitCode = 1;
