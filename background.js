/* DEV_START */
import { BUILD_ID } from "./build-config.js";
globalThis.__koeBuild = BUILD_ID;
/* DEV_END */
import {
  configWith,
  sanitizeConfig,
  publicConfig,
  ZOOM_PLATFORM,
} from "./config.js";
import { cleanPageEvent, validPageCommand } from "./protocol.js";
const panels = new Set(),
  pages = new Map(),
  pending = new Map();
let offscreen = null,
  creating = null,
  targetTabId = null,
  snapshot = null,
  cfg = configWith(),
  loaded = false,
  selectedPage = null;
let navigationTimer = null;
const departingDocuments = new Set();
function suspendForNavigation() {
  if (targetTabId == null || navigationTimer) return;
  if (!snapshot?.active) {
    releaseIdleAudio().catch(() => {});
    return;
  }
  for (const p of pages.values())
    if (p.tab === targetTabId) departingDocuments.add(p.key);
  updateSpeakerTracking();
  // Browser lifecycle events, not MAIN-world status messages, control this stop.
  send(offscreen, { type: "navigation", paused: true });
  pageSend({ type: "stop" });
  navigationTimer = setTimeout(() => {
    navigationTimer = null;
    departingDocuments.clear();
    (snapshot?.active
      ? request({ type: "command", command: "stop" })
      : Promise.resolve()
    )
      .then(releaseIdleAudio)
      .catch(() => {});
  }, 3000);
}
const send = (port, m) => {
  try {
    port?.postMessage(m);
    return !!port;
  } catch {
    return false;
  }
};
const broadcast = (m) => {
  for (const port of panels) send(port, m);
};
async function load() {
  if (loaded) return;
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = (await chrome.storage.local.get("cfg")).cfg;
  cfg = configWith(stored);
  if (stored && JSON.stringify(stored) !== JSON.stringify(cfg))
    await chrome.storage.local.set({ cfg });
  targetTabId =
    (await chrome.storage.session.get("targetTabId")).targetTabId ?? null;
  loaded = true;
}
async function ensureOffscreen() {
  await load();
  if (offscreen) return;
  if (!creating)
    creating = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL("offscreen.html")],
      });
      if (!contexts.length)
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification:
            "会議タブの音声を取得し、パネルを閉じても字幕と読み上げの接続を維持します。",
        });
      for (let i = 0; i < 100 && !offscreen; i++)
        await new Promise((r) => setTimeout(r, 50));
      if (!offscreen) throw new Error("音声処理に接続できませんでした");
    })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}
function request(m) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("操作が時間内に終わりませんでした"));
    }, 65000);
    pending.set(requestId, { resolve, reject, timer });
    if (!send(offscreen, { ...m, requestId })) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error("音声処理に接続できませんでした"));
    }
  });
}
function pageSend(m) {
  if (!validPageCommand(m)) return;
  const candidates = [...pages.values()].filter((p) => p.tab === targetTabId);
  if (m.type === "stop" || m.type === "sendMic" || m.type === "ping") {
    for (const p of candidates) send(p.port, m);
    return;
  }
  const target =
    candidates.find((p) => p.key === selectedPage) ||
    candidates.find((p) => p.status?.unmuted > 0) ||
    candidates.find((p) => p.status?.streams > 0);
  if (target) send(target.port, m);
}
function aggregatePage() {
  const eligible = [...pages.values()].filter((p) => p.tab === targetTabId);
  const best =
    eligible.find((p) => p.status?.unmuted > 0) ||
    eligible.find((p) => p.status?.streams > 0);
  selectedPage = best?.key || null;
  send(offscreen, {
    type: "page",
    event: best?.status || {
      type: "status",
      streams: 0,
      unmuted: 0,
      context: "suspended",
    },
  });
}
function updateSpeakerTracking() {
  for (const record of pages.values()) {
    const enabled = !!(
      record.tab === targetTabId &&
      record.frame === 0 &&
      record.isMeet &&
      snapshot?.active &&
      cfg.showSpeakerNames &&
      !cfg.useLocalMic &&
      !departingDocuments.has(record.key)
    );
    if (record.tracking !== enabled) {
      record.tracking = enabled;
      send(record.port, { type: "speakerTracking", enabled });
    }
  }
}
function supported(url = "") {
  if (/^https:\/\/meet\.google\.com\//.test(url)) return true;
  if (/^https:\/\/(?:[\w-]+\.)*zoom\.us\/wc\//.test(url)) return true;
  /* DEV_START */
  if (/^http:\/\/127\.0\.0\.1:8790\//.test(url)) return true;
  /* DEV_END */
  return false;
}
async function chooseTab(tab) {
  await load();
  if (tab?.id == null) return;
  if (snapshot?.active && targetTabId !== tab.id)
    throw new Error("先に現在の会話を停止してください");
  if (targetTabId !== tab.id) {
    clearTimeout(navigationTimer);
    navigationTimer = null;
    departingDocuments.clear();
    send(offscreen, { type: "navigation", paused: false });
  }
  targetTabId = tab.id;
  await chrome.storage.session.set({ targetTabId });
  aggregatePage();
  send(offscreen, {
    type: "platform",
    supported: supported(tab.url),
    platform: tab.url?.includes("zoom.us") ? ZOOM_PLATFORM : "Google Meet",
  });
}
async function releaseIdleAudio() {
  if (panels.size || snapshot?.active || !offscreen) return;
  await request({ type: "command", command: "forget" });
  if (!panels.size && !snapshot?.active) {
    snapshot = null;
    await chrome.offscreen.closeDocument();
  }
}
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chooseTab(tab)
    .then(ensureOffscreen)
    .then(() => {
      aggregatePage();
      send(offscreen, {
        type: "platform",
        supported: supported(tab.url),
        platform: tab.url?.includes("zoom.us") ? ZOOM_PLATFORM : "Google Meet",
      });
    })
    .catch((e) => broadcast({ type: "notice", tone: "bad", text: e.message }));
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === targetTabId) {
    clearTimeout(navigationTimer);
    navigationTimer = null;
    departingDocuments.clear();
    pageSend({ type: "stop" });
    (snapshot?.active
      ? request({ type: "command", command: "stop" })
      : Promise.resolve()
    )
      .then(releaseIdleAudio)
      .catch(() => {});
    targetTabId = null;
    chrome.storage.session.remove("targetTabId");
  }
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === targetTabId && info.status === "loading") suspendForNavigation();
});
chrome.runtime.onConnect.addListener((port) => {
  const own = port.sender?.id === chrome.runtime.id,
    extensionPage =
      own && port.sender?.url?.startsWith(chrome.runtime.getURL(""));
  if (
    port.name === "offscreen" &&
    extensionPage &&
    port.sender.url === chrome.runtime.getURL("offscreen.html")
  ) {
    offscreen = port;
    load().then(() => {
      send(port, {
        type: "init",
        cfg,
        recover: snapshot?.lines?.length ? snapshot : null,
      });
      aggregatePage();
    });
    port.onMessage.addListener((m) => {
      if (m.type === "snapshot") {
        snapshot = m.state;
        updateSpeakerTracking();
        broadcast(m);
      } else if (m.type === "progress") {
        if (snapshot) Object.assign(snapshot, m.patch);
        broadcast(m);
      } else if (m.type === "pageSend") pageSend(m.message);
      else if (m.type === "reply") {
        const p = pending.get(m.requestId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(m.requestId);
          m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
        }
      } else if (m.type === "notice") broadcast(m);
    });
    port.onDisconnect.addListener(() => {
      if (offscreen !== port) return;
      offscreen = null;
      pageSend({ type: "stop" });
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("音声の接続が切れました"));
      }
      pending.clear();
      if (snapshot?.active) {
        snapshot.active = false;
        snapshot.ended = true;
        snapshot.speaking = null;
        snapshot.bands = [
          {
            id: "offscreen",
            tone: "bad",
            text: "音声の接続が止まりました。再接続してください",
            action: "start",
          },
        ];
        broadcast({ type: "snapshot", state: snapshot });
      }
      if (panels.size) ensureOffscreen().catch(() => {});
    });
    return;
  }
  if (port.name === "panel" && extensionPage) {
    panels.add(port);
    if (snapshot) send(port, { type: "snapshot", state: snapshot });
    ensureOffscreen()
      .then(() => {
        if (snapshot) send(port, { type: "snapshot", state: snapshot });
      })
      .catch((e) =>
        send(port, { type: "notice", text: e.message, tone: "bad" }),
      );
    port.onMessage.addListener(async (m) => {
      if (typeof m?.requestId !== "string") return;
      try {
        await ensureOffscreen();
        let value;
        if (m.command === "saveConfig") {
          const patch = sanitizeConfig(m.patch, true);
          cfg = configWith({ ...cfg, ...patch });
          await chrome.storage.local.set({ cfg });
          value = await request({ type: "config", cfg });
          value = publicConfig(cfg);
        } else if (m.command === "start") {
          if (targetTabId == null) {
            const [tab] = await chrome.tabs.query({
              active: true,
              lastFocusedWindow: true,
            });
            await chooseTab(tab);
          }
          if (targetTabId == null)
            throw new Error("会議タブで拡張アイコンを押してください");
          if (
            !cfg.useLocalMic &&
            !supported((await chrome.tabs.get(targetTabId)).url)
          ) {
            send(offscreen, {
              type: "platform",
              supported: false,
              platform: "Google Meet",
            });
            throw new Error(
              "Google Meet / Zoom の会議タブで拡張アイコンを押してください",
            );
          }
          const streamId = cfg.useLocalMic
            ? null
            : await chrome.tabCapture.getMediaStreamId({ targetTabId });
          value = await request({ type: "start", streamId });
          aggregatePage();
        } else if (m.command === "permission") {
          await chrome.tabs.create({
            url: chrome.runtime.getURL("permission.html"),
          });
          value = true;
        } else {
          /* DEV_START */
          if (m.command === "devStart") {
            if (m.tabId != null)
              await chooseTab(await chrome.tabs.get(m.tabId));
            value = await request({ type: "devStart" });
            aggregatePage();
            send(port, { type: "reply", requestId: m.requestId, value });
            return;
          }
          if (m.command === "devFeed" || m.command === "devState") {
            value = await request({ type: m.command, data: m.data });
            send(port, { type: "reply", requestId: m.requestId, value });
            return;
          }
          /* DEV_END */
          const allowed = [
            "say",
            "sheetSay",
            "pickCandidate",
            "quick",
            "intro",
            "stopSpeaking",
            "stop",
            "regenerate",
            "setTyping",
            "hearing",
            "verifyKey",
            "draftHearing",
            "prewarm",
            "preview",
            "previewStop",
            "reconnect",
            "summary",
            "listLogs",
            "clearLogs",
            "forget",
          ];
          if (!allowed.includes(m.command))
            throw new Error("この操作は利用できません");
          value = await request({ ...m, type: "command" });
        }
        send(port, { type: "reply", requestId: m.requestId, value });
      } catch (e) {
        send(port, {
          type: "reply",
          requestId: m.requestId,
          error: e.message.includes("getMediaStreamId")
            ? "会議タブで拡張アイコンを押し直してください"
            : e.message,
        });
      }
    });
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      releaseIdleAudio().catch(() => {});
    });
    return;
  }
  if (port.name === "page" && own && port.sender?.tab) {
    const url = port.sender.url || "";
    if (!supported(url)) {
      port.disconnect();
      return;
    }
    const key = `${port.sender.tab.id}:${port.sender.frameId}:${port.sender.documentId}`;
    const record = {
      key,
      port,
      tab: port.sender.tab.id,
      frame: port.sender.frameId,
      isMeet: /^https:\/\/meet\.google\.com\//.test(port.sender.url),
      status: null,
    };
    /* DEV_START */
    record.isMeet ||= /^http:\/\/127\.0\.0\.1:8790\//.test(port.sender.url);
    /* DEV_END */
    pages.set(key, record);
    port.onMessage.addListener((m) => {
      if (pages.get(key) !== record) return;
      const event = cleanPageEvent(m);
      if (!event) return;
      if (event.type === "speakers") {
        if (record.tracking && !departingDocuments.has(key))
          send(offscreen, { type: "page", event });
        return;
      }
      if (event.type === "status") {
        record.status = event;
        aggregatePage();
      } else if (record.tab === targetTabId) {
        if (event.type === "ready") {
          if (record.frame === 0 && !departingDocuments.has(key)) {
            for (const old of pages.values())
              if (
                old !== record &&
                old.tab === record.tab &&
                (old.frame === 0 || departingDocuments.has(old.key))
              )
                pages.delete(old.key);
            clearTimeout(navigationTimer);
            navigationTimer = null;
            departingDocuments.clear();
            send(offscreen, { type: "navigation", paused: false });
            aggregatePage();
          }
          send(port, { type: "sendMic", value: cfg.sendMic });
          record.tracking = undefined;
          updateSpeakerTracking();
        } else if (record.key === selectedPage)
          send(offscreen, { type: "page", event });
      }
    });
    port.onDisconnect.addListener(() => {
      if (pages.get(key) !== record) return;
      if (record.tab === targetTabId && record.frame === 0)
        suspendForNavigation();
      pages.delete(key);
      aggregatePage();
    });
    return;
  }
  port.disconnect();
});
load().catch(() => {});
