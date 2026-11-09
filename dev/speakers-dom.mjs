import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";
import { speakerDomChecks } from "./speaker-dom-checks.mjs";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const { parseHTML } = createRequire(import.meta.url)(
  arg("--dom-module") || "linkedom",
);
const { document, HTMLElement } = parseHTML(
  await readFile(new URL("./meeting.html", import.meta.url), "utf8"),
);
// No layout engine: geometry is stubbed; hidden/aria-hidden tested by the scanner.
HTMLElement.prototype.getClientRects = () => [1];
let mutation,
  interval,
  timeout,
  disconnected = false,
  now = 1000;
const context = {
  MutationObserver: class {
    constructor(fn) {
      mutation = fn;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  },
  setInterval: (fn) => {
    interval = fn;
    return 1;
  },
  clearInterval() {},
  setTimeout: (fn) => {
    timeout = fn;
    return 2;
  },
  clearTimeout() {},
  Date: { now: () => now },
};
vm.runInNewContext(
  await readFile(new URL("../meet-speakers.js", import.meta.url), "utf8"),
  context,
);
console.log(
  JSON.stringify(speakerDomChecks(document, context.KoeMeetSpeakers)),
);
const messages = [],
  stop = context.KoeMeetSpeakers.observe(document, (m) => messages.push(m));
assert.equal(messages.length, 1);
now += 500;
interval();
assert.equal(messages.length, 2);
mutation();
now += 500;
timeout();
assert.equal(messages.length, 3);
stop();
interval();
assert.equal(messages.length, 3);
assert(disconnected);
const broken = {
  querySelectorAll() {
    throw new Error("DOM no longer supported");
  },
};
const stopBroken = context.KoeMeetSpeakers.observe(broken, (m) =>
  assert.equal(m.names.length, 0),
);
stopBroken();
console.log(
  "observer lifecycle and unsupported DOM: pass (no layout or real Meet verification)",
);
