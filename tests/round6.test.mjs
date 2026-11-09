import test from "node:test";
import assert from "node:assert/strict";
import { observeGeneration, playbackBufferPlan } from "../audio.js";
import { Session, blankState } from "../session.js";
import { int16ToB64 } from "../openai.js";
import { statusView, cleanPageEvent } from "../protocol.js";
import { compareContinuity, assessContent } from "../dev/acceptance.mjs";

const text = "あ".repeat(22); // expected length: 4s at 5.5 characters/sec
// The R6 conservative buffer rules are superseded by R7's measured average
// and two-second cap. Policy coverage lives in round7.test.mjs.
function fixture(t) {
  const pages = [],
    s = new Session({
      page: (m) => pages.push(m),
      cache: { expire: async () => {} },
    });
  s.s = {
    ...blankState(),
    active: true,
    connectedOnce: true,
    voiceState: "ready",
    sttState: "ready",
    page: { streams: 1, unmuted: 1, attachedEver: false, context: "running" },
  };
  const job = (s.job = {
    id: "voice",
    text,
    chunks: [],
    played: false,
    tapped: Date.now(),
    cancelled: false,
  });
  s.jobs.set(job.id, job);
  s.s.speaking = { id: job.id, text, preparing: true };
  t.after(() => {
    clearInterval(s.interval);
    clearInterval(s.expiryTimer);
    clearTimeout(job.bufferTimer);
    clearTimeout(job.ackTimer);
    clearTimeout(job.watchdog);
  });
  return { s, job, pages };
}
test("R6: joined speech uses original prefetch speed observations, not instantaneous buffer replay", (t) => {
  const { s, job, pages } = fixture(t);
  const chunk = int16ToB64(new Int16Array(9600));
  const entry = {
    chunks: [chunk, chunk, chunk, chunk],
    firstPcmAt: Date.now() - 2400,
    firstPcmSeconds: 0.4,
    audioSeconds: 1.6,
    subscribers: new Set(),
    tag: "pre",
    transcript: "",
  };
  s.joinSynthesis(job, entry);
  assert.equal(pages.length, 0);
  assert.equal(statusView(s.s).text, "声を準備しています");
  const sink = [...entry.subscribers][0];
  sink.end({ status: "completed", transcript: text });
  assert.equal(pages.filter((p) => p.type === "pcm").length, 4);
  assert(Math.abs(job.buffering.rate - 0.5) < 0.01);
  assert.equal(job.buffering.completed, true);
});
test("R6: buffering status toggles through progress without adding a second tap or letting old jobs change current state", (t) => {
  const { s, job } = fixture(t);
  assert.equal(statusView(s.s).text, "声を準備しています");
  s.pageEvent({ type: "play-start", id: job.id });
  assert.equal(statusView(s.s).text, "送信中");
  s.pageEvent(
    cleanPageEvent({
      type: "play-progress",
      id: job.id,
      preparing: true,
      elapsed: 0.5,
    }),
  );
  assert.equal(statusView(s.s).text, "声を準備しています");
  s.pageEvent(
    cleanPageEvent({ type: "play-progress", id: "old", preparing: false }),
  );
  assert.equal(s.s.speaking.preparing, true);
  s.pageEvent(
    cleanPageEvent({
      type: "play-progress",
      id: job.id,
      preparing: false,
      elapsed: 0.5,
    }),
  );
  assert.equal(statusView(s.s).text, "送信中");
  assert.equal(s.s.metrics.taps.length, 1);
});

const levels = (quietMs) => [
  { at: 0, rms: 0.1 },
  { at: 20, rms: 0 },
  { at: 20 + quietMs, rms: 0.1 },
];
test("R6 acceptance: 1.0s natural silence and 300ms underrun pass at boundary; excess or missing product measurement fails", () => {
  assert(compareContinuity(levels(1000), 300).match);
  assert(
    compareContinuity(levels(558), 0).match,
    "natural comma pause, even if >25% of the whole utterance",
  );
  assert.equal(compareContinuity(levels(1001), 0).match, false);
  assert.equal(compareContinuity(levels(100), 300.01).match, false);
  assert.equal(compareContinuity(levels(100)).match, false);
  assert.equal(compareContinuity(levels(100), NaN).match, false);
});
test("R6 T9 recovery: either first ASR model can match at 10%; preserve both and diagnostic retries without changing cutoff", async () => {
  const text = "停止した後も、声が届くことを確認します。";
  const a = await assessContent(text, async (model) =>
    model === "whisper-1" ? text : "掲示した後も、声が届くことを確認します。",
  );
  assert(a.match);
  assert.equal(a.attempts.length, 2);
  assert.equal(a.attempts[0].comparison.match, false);
  assert(a.attempts[0].comparison.differenceRatio > 0.1);
  const b = await assessContent(text, async (_, round) =>
    round === 2 ? text : "掲示した後も、声が届くことを確認します。",
  );
  assert.equal(b.match, false);
  assert.equal(b.attempts.length, 4);
});
