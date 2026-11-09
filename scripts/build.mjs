import { readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
const buildId = randomUUID();
const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "background.js",
  "offscreen.html",
  "offscreen.js",
  "session.js",
  "config.js",
  "protocol.js",
  "vad.js",
  "cache.js",
  "audio.js",
  "openai.js",
  "pcm-worklet.js",
  "inject.js",
  "bridge.js",
  "meet-speakers.js",
  "speakers.js",
  "sheet-import.js",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "permission.html",
  "permission.js",
  "pricing.json",
  "THIRD_PARTY_NOTICES.md",
  "ui/lucian.js",
  "ui/lucian.css",
  "ui/icons.js",
  "ui/presentation.js",
];
for (const mode of ["prod", "dev"]) {
  const dir = path.join(root, "dist", mode);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "ui"), { recursive: true });
  for (const file of files) {
    let text = await readFile(path.join(root, file), "utf8");
    if (mode === "prod")
      text = text.replace(/\/\* DEV_START \*\/[\s\S]*?\/\* DEV_END \*\//g, "");
    await writeFile(path.join(dir, file), text);
  }
  await cp(path.join(root, "icons"), path.join(dir, "icons"), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  if (mode === "dev") {
    manifest.name += "（開発）";
    manifest.host_permissions.push(
      "http://127.0.0.1:8787/*",
      "http://127.0.0.1:8790/*",
    );
    manifest.content_security_policy.extension_pages =
      "script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:8787 ws://127.0.0.1:8787;";
    for (const script of manifest.content_scripts)
      script.matches.push("http://127.0.0.1:8790/*");
    await cp(
      path.join(root, "dev/fixtures.js"),
      path.join(dir, "ui/fixtures.js"),
    );
  }
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    path.join(dir, "build-config.js"),
    `export const DEV = ${mode === "dev"};\nexport const API_BASE = '${mode === "dev" ? "http://127.0.0.1:8787" : "https://api.openai.com"}';\n` +
      (mode === "dev"
        ? `export const BUILD_ID = ${JSON.stringify(buildId)};\n`
        : ""),
  );
  console.log(`Built dist/${mode}`);
}
