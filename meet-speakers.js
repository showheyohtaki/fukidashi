// ISOLATED helper loaded before bridge.js. No page mutation or network.
(() => {
  const TILE = "[data-participant-id], [data-requested-participant-id]";
  const NAME =
    "[data-participant-name], [data-self-name], [translate='no'], .notranslate";
  // Best-effort legacy fallback, scoped to a named tile. aria/data takes priority.
  const LEGACY_ACTIVE = ".Oaajhc, .HX2H7, .wEsLMd, .OgVli";
  const ownNodes = (tile, selector) =>
    [tile, ...tile.querySelectorAll(selector)].filter(
      (node) => node.matches(selector) && node.closest(TILE) === tile,
    );
  const visible = (node) =>
    !node.closest('[hidden], [aria-hidden="true"]') &&
    node.getClientRects().length > 0;
  const selfName = (name) =>
    /^(?:あなた|自分|本人|you|me)$|[（(](?:あなた|自分|本人|you|me)[）)]$/i.test(
      name.trim(),
    );
  const botName = (name) =>
    /notta|otter|fireflies|fathom|read\.ai|tl;dv|tactiq|ボット|議事録|文字起こし|(?:^|\W)(?:bot|notetaker)(?:\W|$)/i.test(
      name,
    );
  function active(tile) {
    const states = ownNodes(tile, "[data-is-speaking], [data-speaking]");
    if (states.length)
      return states.some(
        (n) =>
          visible(n) &&
          /^(true|1)$/.test(
            n.getAttribute("data-is-speaking") ??
              n.getAttribute("data-speaking"),
          ),
      );
    const labels = ownNodes(tile, "[aria-label]").filter(visible);
    if (
      labels.some((n) =>
        /^(?:発話中|話しています|Speaking|Active speaker)$/i.test(
          n.getAttribute("aria-label"),
        ),
      )
    )
      return true;
    if (
      labels.some((n) =>
        /^(?:発話していません|話していません|Not speaking|Inactive speaker)$/i.test(
          n.getAttribute("aria-label"),
        ),
      )
    )
      return false;
    return ownNodes(tile, LEGACY_ACTIVE).some(visible);
  }
  // Meet's own tile carries the pin control labelled for "yourself"; other tiles name the person.
  const selfTile = (tile) =>
    tile.getAttribute("data-is-self") === "true" ||
    tile.getAttribute("data-is-local") === "true" ||
    ownNodes(tile, "[aria-label]").some((n) =>
      /^自分を|yourself/i.test(n.getAttribute("aria-label")),
    );
  function scan(doc) {
    const names = new Set();
    for (const tile of doc.querySelectorAll(TILE)) {
      if (!visible(tile) || selfTile(tile)) continue;
      const nodes = ownNodes(tile, NAME).filter(visible);
      const labels = nodes
        .map((n) =>
          (n.getAttribute("data-participant-name") || n.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean);
      if (
        labels.some(selfName) ||
        /(?:^|[（(\s])(?:あなた|you)[）)\s]*$/i.test(
          tile.getAttribute("aria-label") || "",
        )
      )
        continue;
      // Never guess from the tile's full text or a participant ID.
      const unique = [...new Set(labels)];
      if (unique.length !== 1) continue;
      const name = unique[0];
      if (name.length > 100 || botName(name) || !active(tile)) continue;
      names.add(name);
    }
    return [...names].sort().slice(0, 10);
  }
  // Meet's "open in a separate window" (Document Picture-in-Picture) moves the tiles out of the
  // page into the pop-out window's document, so watch that document too while it is open.
  function observe(doc, send) {
    let timer,
      stopped = false,
      last = "",
      lastAt = 0,
      pipDoc = null,
      pipObserver = null;
    const docs = () =>
      pipDoc && !pipDoc.defaultView?.closed ? [doc, pipDoc] : [doc];
    const sample = () => {
      if (stopped) return;
      clearTimeout(timer);
      timer = null;
      const found = new Set();
      for (const d of docs()) {
        try {
          for (const name of scan(d)) found.add(name);
        } catch {
          /* Changed DOM: captions still work. */
        }
      }
      const names = [...found].sort().slice(0, 10);
      const at = Date.now(),
        key = JSON.stringify(names);
      if (key !== last || at - lastAt >= 500) {
        last = key;
        lastAt = at;
        send({ type: "speakers", at, names });
      }
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(sample, 100);
    };
    const observer = new MutationObserver(schedule);
    const watch = {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "aria-label",
        "data-is-speaking",
        "data-speaking",
        "data-participant-name",
        "data-self-name",
        "data-is-self",
        "data-is-local",
        "data-participant-id",
        "data-requested-participant-id",
      ],
    };
    observer.observe(doc, watch);
    const detachPip = () => {
      pipObserver?.disconnect();
      pipObserver = null;
      pipDoc = null;
    };
    const attachPip = (win) => {
      detachPip();
      if (!win || stopped) return;
      try {
        pipDoc = win.document;
        pipObserver = new MutationObserver(schedule);
        pipObserver.observe(pipDoc, watch);
        win.addEventListener(
          "pagehide",
          () => {
            if (pipDoc === win.document) detachPip();
            schedule();
          },
          { once: true },
        );
      } catch {
        detachPip();
      }
      schedule();
    };
    let pipApi = null;
    try {
      pipApi = doc.defaultView?.documentPictureInPicture || null;
    } catch {
      pipApi = null;
    }
    const onEnter = (e) => attachPip(e.window);
    pipApi?.addEventListener?.("enter", onEnter);
    if (pipApi?.window) attachPip(pipApi.window);
    const heartbeat = setInterval(() => {
      // Catch a pop-out that opened before the observer started, or one whose events were missed.
      const win = pipApi?.window || null;
      if (win && win.document !== pipDoc) attachPip(win);
      else if (!win && pipDoc) detachPip();
      sample();
    }, 500);
    sample();
    return () => {
      stopped = true;
      observer.disconnect();
      detachPip();
      pipApi?.removeEventListener?.("enter", onEnter);
      clearTimeout(timer);
      clearInterval(heartbeat);
    };
  }
  globalThis.KoeMeetSpeakers = { scan, observe };
})();
