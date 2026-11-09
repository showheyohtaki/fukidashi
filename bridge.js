// ISOLATED world. A narrow message allowlist; never forwards config or keys.
(() => {
  const secret = crypto.randomUUID();
  let port = null,
    hello = false,
    closed = false,
    lastStatus = "",
    lastStatusAt = 0;
  let stopSpeakers = null;
  let isMeet = location.hostname === "meet.google.com";
  /* DEV_START */
  isMeet ||= location.origin === "http://127.0.0.1:8790";
  /* DEV_END */
  function trackSpeakers(enabled) {
    stopSpeakers?.();
    stopSpeakers = null;
    if (!enabled || closed || !isMeet || window.top !== window) return;
    try {
      stopSpeakers = globalThis.KoeMeetSpeakers?.observe(document, (m) => {
        try {
          port?.postMessage(m);
        } catch {}
      });
    } catch {
      /* Unsupported DOM must not interrupt audio. */
    }
  }
  const send = (m) =>
    window.postMessage({ __koe: "extension", secret, ...m }, location.origin);
  function connect() {
    if (closed) return;
    if (!chrome.runtime.id) {
      closed = true;
      trackSpeakers(false);
      send({ type: "stop" });
      return;
    }
    try {
      port = chrome.runtime.connect({ name: "page" });
      port.onMessage.addListener((m) => {
        if (m.type === "speakerTracking") {
          trackSpeakers(m.enabled === true);
          return;
        }
        if (["pcm", "end", "stop", "sendMic", "ping"].includes(m.type)) send(m);
      });
      port.onDisconnect.addListener(() => {
        trackSpeakers(false);
        port = null;
        setTimeout(connect, 2000);
      });
      port.postMessage({ type: "ready" });
      send({ type: hello ? "ping" : "hello" });
    } catch {
      setTimeout(connect, 2000);
    }
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (
      e.source !== window ||
      e.origin !== location.origin ||
      m?.__koe !== "page" ||
      m.secret !== secret ||
      !["status", "ready", "play-start", "play-progress", "play-end"].includes(
        m.type,
      )
    )
      return;
    hello = true;
    const { secret: _, __koe: __, ...clean } = m;
    if (m.type === "status") {
      const key = JSON.stringify(clean);
      if (key === lastStatus && Date.now() - lastStatusAt < 500) return;
      lastStatus = key;
      lastStatusAt = Date.now();
    }
    try {
      port?.postMessage(clean);
    } catch {}
  });
  window.addEventListener("pagehide", () => {
    closed = true;
    trackSpeakers(false);
    port?.disconnect();
    send({ type: "stop" });
  });
  connect();
  // MAIN and ISOLATED document_start ordering is not guaranteed.
  let tries = 0;
  const handshake = setInterval(() => {
    if (closed || hello || ++tries > 20) {
      clearInterval(handshake);
      return;
    }
    send({ type: "hello" });
  }, 100);
})();
