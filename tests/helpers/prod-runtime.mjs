// Load the emitted production modules, including browser entry points. Browser
// primitives are stubs; command dispatch runs through the real worker/offscreen.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve("dist/prod");
const event = () => {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => [...listeners].map((fn) => fn(...args)),
  };
};
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (fn, ms) => {
  timers.set(++timerId, { fn, ms });
  return timerId;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.setInterval = setTimeout;
globalThis.clearInterval = clearTimeout;
const onConnect = event();
const clients = [];
function ports(name, sender) {
  const client = { name, onMessage: event(), onDisconnect: event() };
  const server = { name, sender, onMessage: event(), onDisconnect: event() };
  client.postMessage = (m) => queueMicrotask(() => server.onMessage.fire(m));
  server.postMessage = (m) => {
    if (name === "panel" && m.type === "snapshot") return;
    queueMicrotask(() => client.onMessage.fire(m));
  };
  client.disconnect = server.disconnect = () => {
    server.onDisconnect.fire();
    client.onDisconnect.fire();
  };
  clients.push(client);
  onConnect.fire(server);
  return client;
}
const base = "chrome-extension://test/";
globalThis.chrome = {
  storage: {
    local: {
      setAccessLevel: async () => {},
      get: async () => ({ cfg: { apiKey: "dummy", onboarded: true } }),
      set: async () => {},
    },
    session: {
      get: async () => ({ targetTabId: 42 }),
      set: async () => {},
      remove: async () => {},
    },
  },
  runtime: {
    id: "test",
    getURL: (p) => base + p,
    onConnect,
    getContexts: async () => [{}],
    connect: ({ name }) =>
      ports(name, {
        id: "test",
        url:
          base + (name === "offscreen" ? "offscreen.html" : "sidepanel.html"),
      }),
  },
  action: { onClicked: event() },
  sidePanel: { open: async () => {} },
  tabs: {
    onRemoved: event(),
    onUpdated: event(),
    get: async (id) => ({ id, url: "https://meet.google.com/abc-defg-hij" }),
    query: async () => [
      { id: 42, url: "https://meet.google.com/abc-defg-hij" },
    ],
    create: async () => {},
  },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  tabCapture: { getMediaStreamId: async () => "stream-id" },
};
const node = () => ({
  addEventListener() {},
  removeEventListener() {},
  dataset: {},
  style: { setProperty() {} },
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {},
  querySelectorAll: () => [],
  contains: () => false,
});
const nodes = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  },
  addEventListener() {},
  removeEventListener() {},
  documentElement: node(),
};
globalThis.window = { addEventListener() {}, postMessage() {} };
globalThis.location = { origin: "https://meet.google.com", search: "" };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
class Devices {
  async getUserMedia() {
    return { getTracks: () => [] };
  }
}
globalThis.MediaDevices = Devices;
globalThis.MediaStreamTrack = class {};
globalThis.MediaStream = class {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  clone() {
    return new this.constructor(this.tracks.map((t) => t.clone()));
  }
};
Object.defineProperty(globalThis, "navigator", {
  value: { platform: "Mac", mediaDevices: new Devices() },
  configurable: true,
});
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = () => {};
const fetches = [];
globalThis.fetch = async (url) => {
  fetches.push(url);
  return { ok: true };
};
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const { Session } = await load("session.js");
const { configWith } = await load("config.js");
const calls = [];
const speakerEvents = [];
const originalPageEvent = Session.prototype.pageEvent;
Session.prototype.pageEvent = function (event) {
  if (event.type === "speakers") speakerEvents.push(event);
  return originalPageEvent.call(this, event);
};
Session.prototype.init = async function (cfg) {
  this.cfg = configWith(cfg);
  this.savedCfg = this.cfg;
  this.cache.clearLogs = async () => {};
};
Session.prototype.say = async function (text) {
  calls.push(["say", text]);
  return true;
};
Session.prototype.stop = async function () {
  calls.push(["stop"]);
  this.s.active = false;
  this.publish();
};
Session.prototype.stopSpeaking = function () {
  calls.push(["stopSpeaking"]);
};
Session.prototype.start = async function (streamId) {
  calls.push(["start", streamId]);
  this.s.active = true;
  this.publish();
};
// Avoid DOM rendering when fixtures aren't present. UI modules still evaluate.
Session.prototype.publish = function () {
  this.emit({ type: "snapshot", state: this.snapshot() });
};
await load("background.js");
await load("offscreen.js");
async function walk(dir) {
  let files = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    files.push(
      ...(e.isDirectory() ? await walk(p) : p.endsWith(".js") ? [p] : []),
    );
  }
  return files;
}
const paths = await walk(root);
for (const p of paths) await import(pathToFileURL(p).href);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise(setImmediate);
};
await flush();
const panel = chrome.runtime.connect({ name: "panel" }),
  replies = [];
panel.onMessage.addListener((m) => {
  if (m.type === "reply") replies.push(m);
});
await flush();
async function command(command, extra = {}) {
  const requestId = "request-" + replies.length;
  panel.postMessage({ requestId, command, ...extra });
  await flush();
  const reply = replies.find((m) => m.requestId === requestId);
  assert(reply, `prod panel ${command} never received reply`);
  assert(!reply.error, reply?.error);
  return reply.value;
}
assert.equal(await command("say", { text: "production route" }), true);
assert(
  calls.some(([c, text]) => c === "say" && text === "production route"),
  "prod panel say must reach Session.say",
);
await command("stopSpeaking");
assert(calls.some(([c]) => c === "stopSpeaking"));
assert.equal(await command("verifyKey", { apiKey: "dummy" }), true);
assert.deepEqual(fetches, ["https://api.openai.com/v1/models"]);
await command("start");
assert(calls.some(([c, id]) => c === "start" && id === "stream-id"));
await command("stop");
assert(calls.some(([c]) => c === "stop"));
const page = (documentId, url = "https://meet.google.com/abc-defg-hij") =>
  ports("page", { id: "test", url, tab: { id: 42 }, frameId: 0, documentId });
const first = page("old");
first.postMessage({ type: "ready" });
await flush();
const stopCount = () => calls.filter(([c]) => c === "stop").length;
let count = stopCount();
chrome.tabs.onUpdated.fire(42, { status: "loading" });
await flush();
assert(
  ![...timers.values()].some((t) => t.ms === 3000),
  "idle navigation must not schedule stop/summary",
);
assert.equal(stopCount(), count);
await command("start");
first.postMessage({
  type: "speakers",
  at: Date.now(),
  names: ["佐藤"],
  apiKey: "not-forwarded",
});
await flush();
assert.equal(speakerEvents.at(-1)?.names[0], "佐藤");
assert.equal(speakerEvents.at(-1)?.apiKey, undefined);
const speakerCount = speakerEvents.length;
const otherTab = ports("page", {
  id: "test",
  url: "https://meet.google.com/other",
  tab: { id: 99 },
  frameId: 0,
  documentId: "other",
});
const childFrame = ports("page", {
  id: "test",
  url: "https://meet.google.com/frame",
  tab: { id: 42 },
  frameId: 1,
  documentId: "frame",
});
for (const p of [otherTab, childFrame])
  p.postMessage({ type: "speakers", at: Date.now(), names: ["別ページ"] });
await flush();
assert.equal(speakerEvents.length, speakerCount);
await command("saveConfig", { patch: { showSpeakerNames: false } });
first.postMessage({ type: "speakers", at: Date.now(), names: ["停止後"] });
await flush();
assert.equal(speakerEvents.length, speakerCount);
await command("saveConfig", { patch: { showSpeakerNames: true } });
chrome.tabs.onUpdated.fire(42, { status: "loading" });
await flush();
const navTimer = [...timers].find(([, v]) => v.ms === 3000);
assert(navTimer);
first.postMessage({ type: "ready" });
await flush();
assert(
  timers.has(navTimer[0]),
  "old document ping cannot cancel navigation stop",
);
await navTimer[1].fn();
timers.delete(navTimer[0]);
await flush();
assert.equal(stopCount(), count + 1);
await command("start");
chrome.tabs.onUpdated.fire(42, { status: "loading" });
await flush();
const reloadTimer = [...timers].find(([, v]) => v.ms === 3000);
assert(reloadTimer);
const reloaded = page("new");
reloaded.postMessage({ type: "ready" });
await flush();
assert(
  !timers.has(reloadTimer[0]),
  "new ready after reload must cancel pending stop",
);
first.disconnect();
await flush();
assert(
  ![...timers.values()].some((t) => t.ms === 3000),
  "late disconnect of retired page must not stop the reloaded meeting",
);
let disconnected = false;
const zoom = page("zoom", "https://a.b.zoom.us/wc/123");
zoom.onDisconnect.addListener(() => {
  disconnected = true;
});
zoom.postMessage({ type: "ready" });
await flush();
assert(!disconnected);
count = stopCount();
chrome.tabs.onRemoved.fire(42);
await flush();
assert.equal(stopCount(), count + 1);
// Choose the same meeting while idle; closing it must not invoke stop/summary.
chrome.action.onClicked.fire({
  id: 42,
  windowId: 1,
  url: "https://meet.google.com/abc-defg-hij",
});
await flush();
count = stopCount();
chrome.tabs.onRemoved.fire(42);
await flush();
assert.equal(stopCount(), count);
console.log(
  JSON.stringify({
    imported: paths.length,
    commands: ["say", "stopSpeaking", "verifyKey", "start", "stop"],
    idleNavigationNoStop: true,
    idleRemovalNoStop: true,
    navigationStop: true,
    reloadGrace: true,
    removedStop: true,
  }),
);
