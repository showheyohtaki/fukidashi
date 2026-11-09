import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
test("R8 E2E diagnostics: setup failure records stage/wait condition and 13 not-run cases (v1.2: T18-warm 追加) without launching a browser", async () => {
  const out = ".tmp/round1/logging-regression";
  await fs.rm(out, { recursive: true, force: true });
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "dev/e2e.mjs",
          "--screens",
          "--playwright-module",
          "./__koe_missing_playwright_module__",
          "--out",
          out,
        ],
        { stdio: "pipe", timeout: 15000 },
      ),
    (e) => e.status === 1,
  );
  const result = JSON.parse(await fs.readFile(out + "/result.json", "utf8"));
  assert.equal(result.setupFailure, "dependencies");
  assert.equal(result.errors[0].stage, "dependencies");
  assert.match(result.errors[0].waitingFor, /Playwright/);
  assert.match(result.errors[0].message, /Cannot find module/);
  assert.equal(result.counts["not-run"], 13);
  assert.equal(result.tests["T7-meet-clone"].status, "not-run");
  assert.equal(result.screens.status, "not-run");
  assert.equal(result.counts.pass, 0);
  assert.equal(result.metrics.roundTripMedianMs, null);
});

test("R5 T5 series: missing browser dependency records three unrun rows and stops without starting a browser", async () => {
  const out = ".tmp/round5/series-logging-regression";
  await fs.rm(out, { recursive: true, force: true });
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "dev/t5-series.mjs",
          "--playwright-module",
          "./__koe_missing_playwright_module__",
          "--out",
          out,
        ],
        { stdio: "pipe", timeout: 15000 },
      ),
    (e) => e.status === 1,
  );
  const rows = JSON.parse(await fs.readFile(out + "/summary.json", "utf8"));
  assert.equal(rows.length, 3);
  assert(rows.every((r) => r.status === "not-run" && r.medianMs === null));
  await assert.rejects(fs.access(out + "/run-2"));
  assert.match(await fs.readFile(out + "/report.md", "utf8"), /not-run/);
});
