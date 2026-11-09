// Matched text-only trials through the existing proxy; never reads real keys.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { suggestReplies } from "../dist/dev/openai.js";
import { configWith } from "../dist/dev/config.js";
import { API_BASE } from "../dist/dev/build-config.js";
import { replyTurns } from "./reply-fixtures.mjs";
import { median, percentile } from "./metrics.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (n, fallback) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? fallback : process.argv[i + 1];
};
const out = path.resolve(root, arg("--out", "docs/test-log/2026-11-01/round4"));
assert(out.startsWith(root));
assert.equal(API_BASE, "http://127.0.0.1:8787");
const latest = process.argv.includes("--latest");
const older = process.argv.includes("--gpt41");
const concise = latest || process.argv.includes("--concise");
const variants = older
  ? [
      { name: "gpt41-mini-batch", model: "gpt-4.1-mini", stream: false },
      { name: "gpt41-mini-stream", model: "gpt-4.1-mini", stream: true },
    ]
  : latest
    ? [
        { name: "mini-latest-batch", model: "gpt-5.4-mini", stream: false },
        { name: "mini-latest-stream", model: "gpt-5.4-mini", stream: true },
      ]
    : concise
      ? [
          { name: "mini-concise-batch", model: "gpt-5.4-mini", stream: false },
          { name: "mini-concise-stream", model: "gpt-5.4-mini", stream: true },
        ]
      : [
          { name: "mini-batch", model: "gpt-5.4-mini", stream: false },
          { name: "mini-stream", model: "gpt-5.4-mini", stream: true },
          { name: "nano-stream", model: "gpt-5.4-nano", stream: true },
        ];
const cfg = configWith({
  apiKey: "dummy-key-proxy-only",
  name: "試験",
  job: "Web制作",
});
const result = {
  at: new Date().toISOString(),
  kind: "Matched 10-turn text API comparison; not end-to-end latency",
  context:
    "Same cumulative other-speaker turns, same profile and questions, rotated variant order; one sample per condition per turn",
  trials: [],
};
const filename = older
  ? "reply-benchmark-gpt41.json"
  : latest
    ? "reply-benchmark-latest.json"
    : concise
      ? "reply-benchmark-concise.json"
      : "reply-benchmark.json";
await mkdir(out, { recursive: true });
for (let i = 0; i < replyTurns.length; i++) {
  const lines = replyTurns
    .slice(0, i + 1)
    .map((text) => ({ who: "other", text }));
  for (let j = 0; j < variants.length; j++) {
    const v = variants[(i + j) % variants.length];
    const trial = {
      turn: i + 1,
      input: replyTurns[i],
      ...v,
      status: "fail",
      items: [],
    };
    const start = performance.now();
    try {
      trial.replies = await suggestReplies(
        { ...cfg, replyModel: v.model },
        lines,
        cfg.hearing.slice(0, 2),
        undefined,
        (usage) => {
          if (usage) trial.usage = usage;
        },
        v.stream
          ? (replies) => {
              while (trial.items.length < replies.length)
                trial.items.push(Math.round(performance.now() - start));
            }
          : undefined,
        { concise, latest },
      );
      trial.elapsedMs = Math.round(performance.now() - start);
      trial.firstMs = trial.items[0] ?? trial.elapsedMs;
      trial.threeMs = trial.items[2] ?? trial.elapsedMs;
      trial.status = "pass";
    } catch (e) {
      trial.error = e.message;
    }
    result.trials.push(trial);
    console.log(
      JSON.stringify({
        turn: trial.turn,
        variant: v.name,
        status: trial.status,
        firstMs: trial.firstMs,
        threeMs: trial.threeMs,
        error: trial.error,
      }),
    );
    await writeFile(
      path.join(out, filename),
      JSON.stringify(result, null, 2) + "\n",
    );
  }
}
result.summary = variants.map((v) => {
  const trials = result.trials.filter(
    (t) => t.name === v.name && t.status === "pass",
  );
  return {
    ...v,
    count: trials.length,
    firstMedianMs: median(trials.map((t) => t.firstMs)),
    firstP90Ms: percentile(
      trials.map((t) => t.firstMs),
      0.9,
    ),
    threeMedianMs: median(trials.map((t) => t.threeMs)),
    threeP90Ms: percentile(
      trials.map((t) => t.threeMs),
      0.9,
    ),
  };
});
await writeFile(
  path.join(out, filename),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result.summary, null, 2));
if (result.trials.some((t) => t.status !== "pass")) process.exitCode = 1;
