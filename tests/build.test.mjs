import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve(new URL("..", import.meta.url).pathname);
// Unicode paths are decoded with fileURLToPath in the build and E2E entry points.
execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: process.cwd() });
async function files(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}
test("T13 build: production has only OpenAI network destinations; no fixtures, proxy, arbitrary endpoints or keys", async () => {
  const paths = await files("dist/prod"),
    text = (await Promise.all(paths.map((p) => fs.readFile(p, "utf8")))).join(
      "\n",
    );
  assert(
    !/127\.0\.0\.1|localhost|koeTest|devFeed|devState|dummy-key|fixtures\.js|__koeBuild|BUILD_ID|openai-insecure-api-key\.sk-/.test(
      text,
    ),
  );
  const manifest = JSON.parse(
    await fs.readFile("dist/prod/manifest.json", "utf8"),
  );
  assert.deepEqual(manifest.host_permissions, ["https://api.openai.com/*"]);
  assert.equal(manifest.background.type, "module");
  assert(manifest.permissions.includes("offscreen"));
  assert.match(
    manifest.content_security_policy.extension_pages,
    /connect-src https:\/\/api\.openai\.com wss:\/\/api\.openai\.com;/,
  );
  assert(!manifest.permissions.includes("tabs"));
});
test("Every bundled module import resolves, and production scripts parse", async () => {
  for (const file of await files("dist/prod")) {
    if (!file.endsWith(".js")) continue;
    execFileSync(process.execPath, ["--check", file]);
    const src = await fs.readFile(file, "utf8");
    for (const m of src.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      await fs.access(path.resolve(path.dirname(file), m[1]));
    }
  }
});
test("Production entry points import and route real panel commands through worker/offscreen; navigation stops capture", () => {
  const result = JSON.parse(
    execFileSync(process.execPath, ["tests/helpers/prod-runtime.mjs"], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  assert(result.imported >= 18);
  assert(result.navigationStop && result.reloadGrace && result.removedStop);
  assert(result.idleNavigationNoStop && result.idleRemovalNoStop);
});
test("Only the dev build grants the local meeting URL host permission for tabs.query", async () => {
  const dev = JSON.parse(await fs.readFile("dist/dev/manifest.json", "utf8"));
  assert(dev.host_permissions.includes("http://127.0.0.1:8790/*"));
});
test("fixtures correspond one-to-one to the approved canvases in docs/design; fixtures are dev-only", async () => {
  const { fixtureNames, makeFixture } = await import("../dev/fixtures.js");
  const names = (await fs.readdir("docs/design"))
    .filter((n) => n.endsWith(".dc.html"))
    .map((n) => n.replace(".dc.html", ""));
  assert.deepEqual([...fixtureNames].sort(), names.sort());
  for (const name of fixtureNames) {
    const f = makeFixture(name);
    assert(f.state.cfg);
    assert(!f.state.cfg.apiKey);
  }
  await assert.rejects(fs.access("dist/prod/ui/fixtures.js"));
  await fs.access("dist/dev/ui/fixtures.js");
});
test("v1.2 extra fixtures (no canvas yet) render without a key and do not shadow canvas names", async () => {
  const { fixtureNames, extraFixtureNames, makeFixture } = await import(
    "../dev/fixtures.js"
  );
  assert.equal(
    extraFixtureNames.filter((n) => fixtureNames.includes(n)).length,
    0,
  );
  for (const name of extraFixtureNames) {
    const f = makeFixture(name);
    assert(f.state.cfg);
    assert(!f.state.cfg.apiKey);
  }
  await fs.access("dist/dev/ui/fixtures.js");
});
