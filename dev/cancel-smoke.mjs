// Uses the existing local proxy only. No browser, playback, or real receiver.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { Speaker } from "../dist/dev/openai.js";
import { configWith } from "../dist/dev/config.js";
import { API_BASE } from "../dist/dev/build-config.js";
import { wavBytes } from "../dist/dev/audio.js";
import { compareRecording } from "./acceptance.mjs";
import { Session } from "../dist/dev/session.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const out = path.resolve(root, arg("--out", "docs/test-log/2026-11-01/round5"));
const label = arg("--label", "fixed");
assert(out.startsWith(root) && /^[a-z-]+$/.test(label));
assert.equal(API_BASE, "http://127.0.0.1:8787");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const began = Date.now(),
  events = [];
const record = (type, detail = {}) =>
  events.push({ ms: Date.now() - began, type, ...detail });
class ObservedSpeaker extends Speaker {
  send(m) {
    if (m.type.startsWith("response."))
      record("send:" + m.type, {
        responseId: m.response_id,
        eventId: m.event_id,
        connection: this.generation,
        draining: !!this.draining,
      });
    return super.send(m);
  }
  onEvent(m) {
    if (["response.created", "response.done"].includes(m.type))
      record(m.type, {
        responseId: m.response?.id,
        status: m.response?.status,
      });
    return super.onEvent(m);
  }
  onError(m) {
    record("error", { error: m.error });
    return super.onError(m);
  }
  resetSocket() {
    record("resetSocket");
    return super.resetSocket();
  }
}
const cfg = configWith({ apiKey: "dummy-key-proxy-only" });
const speaker = new ObservedSpeaker(cfg, {
  onState: (state) => record("state", { state }),
});
const result = {
  at: new Date().toISOString(),
  kind: "API cancel then next speech; no browser receiver",
  label,
  status: "fail",
  events,
};
let cancelTimer, firstTimeout;
try {
  speaker.connect();
  let cancelled;
  const stopped = new Promise((r) => {
    cancelled = r;
  });
  const first = speaker.speak(
    "これから長い説明を読み上げます。まず、お店のホームページで困っていることを順番にお聞きします。次に予算と日程を確かめて、進め方を整理します。最後に見積もりをお送りします。",
    {
      tag: "first",
      pcm() {
        if (cancelTimer) return;
        record("first-pcm");
        cancelTimer = setTimeout(() => {
          record("stop");
          speaker.cancelAll("first");
          cancelled();
        }, 700);
      },
    },
  );
  await Promise.race([
    stopped,
    new Promise((_, reject) => {
      firstTimeout = setTimeout(() => reject(new Error("No first PCM")), 20000);
    }),
  ]);
  clearTimeout(firstTimeout);
  await pause(500);
  record("next-tap");
  const text = "停止した後も、声が届くことを確認します。";
  const second = await speaker.speak(text, {
    tag: "second",
    pcm() {
      if (!result.nextFirstPcmMs) result.nextFirstPcmMs = Date.now() - began;
    },
  });
  const firstResult = await first;
  result.first = {
    status: firstResult.status,
    transcript: firstResult.transcript,
    seconds: firstResult.seconds,
  };
  result.second = {
    status: second.status,
    transcript: second.transcript,
    seconds: second.seconds,
    chunks: second.chunks.length,
  };
  assert.equal(second.status, "completed");
  assert(second.chunks.length);
  const form = new FormData();
  form.append("model", "gpt-4o-transcribe");
  form.append("language", "ja");
  form.append(
    "file",
    new Blob([wavBytes(second.chunks)], { type: "audio/wav" }),
    "next.wav",
  );
  const r = await fetch(API_BASE + "/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.apiKey },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  assert(r.ok, "Next-speech transcription HTTP " + r.status);
  result.actual = (await r.json()).text;
  result.comparison = compareRecording(text, result.actual);
  assert(result.comparison.match);
  assert(
    !events.some((e) => e.type === "send:response.create" && e.draining),
    "A new response was sent before cancellation acknowledgement",
  );
  result.reconnects = events.filter((e) => e.type === "resetSocket").length;
  const prefixJob = { chunks: firstResult.chunks, result: firstResult };
  result.prefix = {
    text: await Session.prototype.transcribePrefix.call(
      { cfg },
      prefixJob,
      0.7,
    ),
    ...prefixJob.prefixVerification,
  };
  result.status = "pass";
} catch (e) {
  result.error = e.message;
} finally {
  clearTimeout(cancelTimer);
  clearTimeout(firstTimeout);
  speaker.close();
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, `cancel-${label}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}
if (result.status !== "pass") process.exitCode = 1;
