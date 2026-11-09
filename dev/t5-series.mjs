// Chief-run browser verification; never starts/stops the API proxy.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { t5SeriesReport } from "./t5-report.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const OUT = path.resolve(
  ROOT,
  arg("--out") || "docs/test-log/2026-11-01/round5-t5-series",
);
const WAV = path.resolve(ROOT, arg("--wav-dir") || "docs/test-log/2026-11-01");
if (!OUT.startsWith(ROOT) || !WAV.startsWith(ROOT))
  throw new Error("Paths must remain inside koe-bridge");
// Do not overwrite the chief's existing evidence.
try {
  await access(OUT);
  throw new Error("Output already exists; choose a new --out directory");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await mkdir(OUT, { recursive: true });
const results = [null, null, null];
for (let i = 0; i < 3; i++) {
  const out = path.join(OUT, `run-${i + 1}`);
  const args = [
    "dev/e2e.mjs",
    "--live",
    "--t5-only",
    "--wav-dir",
    WAV,
    "--out",
    out,
  ];
  for (const name of ["--playwright-module", "--chromium"])
    if (arg(name)) args.push(name, arg(name));
  console.log(`T5 run ${i + 1}/3`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, TMPDIR: path.join(ROOT, ".tmp/v1/e2e") },
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  results[i] = JSON.parse(
    await readFile(path.join(out, "result.json"), "utf8"),
  );
  const summary = t5SeriesReport(results);
  await writeFile(
    path.join(OUT, "summary.json"),
    JSON.stringify(summary.runs, null, 2) + "\n",
  );
  await writeFile(path.join(OUT, "report.md"), summary.markdown);
  if (results[i].setupFailure) break;
}
process.exitCode = results.every((r) => r?.tests.T5.status === "pass") ? 0 : 1;
