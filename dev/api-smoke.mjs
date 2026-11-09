// Uses the compiled DEVELOPMENT modules and the already-running chief's proxy.
// Never loads environment key files and never starts/stops the proxy.
import { mkdir, writeFile, cp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const prod = process.argv.includes("--prod");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const dir = path.resolve(
  root,
  arg("--out") || "docs/test-log/2026-10-31/round1",
);
if (!dir.startsWith(root + path.sep))
  throw new Error("Output must remain inside koe-bridge");
let moduleDir = path.join(root, "dist/dev");
if (prod) {
  // Production sources and branch stripping are preserved; only the fixed
  // endpoint is replaced in this disposable DEVELOPMENT test copy.
  moduleDir = path.join(root, ".tmp/round1/prod-smoke");
  await mkdir(moduleDir, { recursive: true });
  await cp(path.join(root, "dist/prod"), moduleDir, { recursive: true });
  await writeFile(
    path.join(moduleDir, "build-config.js"),
    "export const DEV = false;\nexport const API_BASE = 'http://127.0.0.1:8787';\n",
  );
}
const fromBuild = (name) =>
  import(pathToFileURL(path.join(moduleDir, name)).href);
const {
  Speaker,
  Transcriber,
  verifyKey,
  suggestReplies,
  summarizeHearing,
  b64ToInt16,
} = await fromBuild("openai.js");
const { configWith } = await fromBuild("config.js");
const { API_BASE } = await fromBuild("build-config.js");
const { speechMatches } = await fromBuild("protocol.js");
const result = {
  at: new Date().toISOString(),
  kind: "API smoke; not browser acceptance",
  build: prod
    ? "production code; endpoint-only development override"
    : "development",
  base: API_BASE,
  checks: [],
};
const cfg = configWith({
  apiKey: "dummy-key-proxy-only",
  prefetchCandidates: 0,
});
let speaker, transcriber;
const check = async (name, fn) => {
  try {
    const value = await fn();
    result.checks.push({ name, status: "pass", ...value });
  } catch (e) {
    result.checks.push({
      name,
      status: "fail",
      error: e.message,
      cause: e.cause?.code || e.cause?.message,
    });
  }
};
await mkdir(dir, { recursive: true });
try {
  if (API_BASE !== "http://127.0.0.1:8787")
    throw new Error("Refusing non-development endpoint");
  await check("key verification via existing proxy", async () => {
    await verifyKey(cfg.apiKey);
  });
  if (result.checks[0].status === "pass") {
    let voice;
    await check("realtime voice session + unquoted text", async () => {
      const started = Date.now();
      speaker = new Speaker(cfg);
      speaker.connect();
      voice = await speaker.speak(
        "本日はお時間をいただき、ありがとうございます。",
      );
      if (voice.status !== "completed" || !voice.chunks.length)
        throw new Error(voice.error || voice.status);
      if (
        !speechMatches(
          "本日はお時間をいただき、ありがとうございます。",
          voice.transcript,
        )
      )
        throw new Error("Generated speech did not match requested text");
      return {
        elapsedMs: Date.now() - started,
        transcript: voice.transcript,
        exact: speechMatches(
          "本日はお時間をいただき、ありがとうございます。",
          voice.transcript,
        ),
        seconds: voice.seconds,
      };
    });
    if (voice?.chunks?.length)
      await check("gpt-live-transcribe session + manual commit", async () => {
        const finals = [];
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("transcription timeout")),
            25000,
          );
          transcriber = new Transcriber(cfg, {
            onState: (state) => {
              if (state === "ready") {
                for (const chunk of voice.chunks)
                  transcriber.append(b64ToInt16(chunk));
                transcriber.commit();
              }
              if (state === "failed") {
                clearTimeout(timer);
                reject(new Error("transcription failed"));
              }
            },
            onFinal: (id, text) => {
              finals.push(text);
              clearTimeout(timer);
              resolve();
            },
          });
          transcriber.connect();
        });
        if (!speechMatches(voice.transcript, finals.join("")))
          throw new Error("Transcription did not match generated speech");
        return {
          transcript: finals.join(""),
          exact: speechMatches(voice.transcript, finals.join("")),
        };
      });
    const lines = [
      {
        who: "other",
        text: "いまのホームページがスマホでは見づらいんです。予算は50万円です。",
      },
    ];
    await check("strict three-reply schema", async () => {
      const replies = await suggestReplies(cfg, lines, ["公開したい時期"]);
      return { replies };
    });
    await check("summary evidence and unconfirmed item", async () => {
      const summary = await summarizeHearing(cfg, lines, [
        "予算",
        "公開したい時期",
      ]);
      if (summary.items[1].answer !== "未確認")
        throw new Error("Missing answer was invented");
      if (!summary.items[0].answer.includes("50万円"))
        throw new Error("Known budget was not preserved");
      return { summary };
    });
  }
} catch (e) {
  result.error = e.message;
} finally {
  speaker?.close();
  transcriber?.close();
  for (const name of [
    "key verification via existing proxy",
    "realtime voice session + unquoted text",
    "gpt-live-transcribe session + manual commit",
    "strict three-reply schema",
    "summary evidence and unconfirmed item",
  ])
    if (!result.checks.some((c) => c.name === name))
      result.checks.push({
        name,
        status: "not-run",
        reason: "Prerequisite failed",
      });
  await writeFile(
    path.join(dir, prod ? "prod-api-smoke.json" : "api-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}
if (result.error || result.checks.some((c) => c.status === "fail"))
  process.exitCode = 1;
