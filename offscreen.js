import { Session } from "./session.js";
let port,
  initialized = false,
  initializing = Promise.resolve();
const session = new Session({
  emit: (m) => {
    try {
      port?.postMessage(m);
    } catch {}
  },
  page: (message) => {
    try {
      port?.postMessage({ type: "pageSend", message });
    } catch {}
  },
});
function connect() {
  port = chrome.runtime.connect({ name: "offscreen" });
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
  port.onMessage.addListener(async (m) => {
    try {
      let value;
      if (m.type === "init") {
        if (!initialized) {
          initialized = true;
          initializing = session.init(m.cfg, m.recover);
          await initializing;
        } else session.publish();
        return;
      }
      await initializing;
      if (m.type === "page") {
        session.pageEvent(m.event);
        return;
      }
      if (m.type === "navigation") {
        session.navigation(m.paused);
        return;
      }
      if (m.type === "platform") {
        session.s.platform = m.platform;
        session.s.notMeeting = m.supported === false;
        session.publish();
        return;
      }
      if (m.type === "config") value = await session.updateConfig(m.cfg);
      else if (m.type === "start") value = await session.start(m.streamId);
      else if (m.type === "command") value = await session.command(m);
      /* DEV_START */
      if (m.type === "devStart")
        value = await session.start(null, { test: true });
      else if (m.type === "devFeed") {
        for (const frame of m.data.frames) session.feed(Int16Array.from(frame));
        value = true;
      } else if (m.type === "devState") {
        if (m.data.resetTurn) {
          session.filled = false;
          session.sentTurn = false;
          delete m.data.resetTurn;
        }
        Object.assign(session.s, m.data);
        session.publish();
        value = true;
      }
      /* DEV_END */
      if (m.requestId)
        port.postMessage({
          type: "reply",
          requestId: m.requestId,
          value: value ?? true,
        });
    } catch (e) {
      if (m.requestId)
        port.postMessage({
          type: "reply",
          requestId: m.requestId,
          error: e.message,
        });
    }
  });
}
connect();
