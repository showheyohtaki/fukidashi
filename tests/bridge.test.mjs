import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
test("R1 L4: orphaned bridge stops audio and all reconnect/hello retries after extension update", async () => {
  let connectCount = 0,
    disconnect,
    interval,
    cleared = false;
  const timers = [],
    messages = [];
  const chrome = {
    runtime: {
      id: "extension",
      connect() {
        connectCount++;
        return {
          onMessage: { addListener() {} },
          onDisconnect: {
            addListener: (fn) => {
              disconnect = fn;
            },
          },
          postMessage() {},
        };
      },
    },
  };
  const window = {
    postMessage: (m) => messages.push(m),
    addEventListener() {},
  };
  vm.runInNewContext(await fs.readFile("bridge.js", "utf8"), {
    chrome,
    window,
    crypto,
    location: { origin: "https://meet.google.com" },
    setTimeout: (fn) => timers.push(fn),
    setInterval: (fn) => {
      interval = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  assert.equal(connectCount, 1);
  disconnect();
  chrome.runtime.id = undefined;
  timers.shift()();
  interval();
  assert.equal(connectCount, 1);
  assert(messages.some((m) => m.type === "stop"));
  assert(cleared);
  assert.equal(timers.length, 0);
});
