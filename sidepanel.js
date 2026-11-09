import {
  DEFAULTS,
  defaultIntro,
  NEEDS,
  VOICES,
  publicConfig,
  WARM_LIST_LIMIT,
} from "./config.js";
import { statusView, shouldSendEnter, pageMuted } from "./protocol.js";
import { icon } from "./ui/icons.js";
import {
  readSheetFile,
  analyzeSheet,
  SHEET_ACCEPT,
  SHEET_MAX_CHARS,
} from "./sheet-import.js";
import { lineSpeaker, captionSpeaker } from "./speakers.js";
import {
  statusDetails,
  summaryPeriod,
  summaryHeading,
  metricText,
} from "./ui/presentation.js";
import {
  bindSwitch,
  bindRange,
  menu,
  openDialog,
  showSheet,
  emptyAction,
  replaceAlerts,
  reduced,
} from "./ui/lucian.js";
const $ = (id) => document.getElementById(id),
  esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const app = $("app"),
  requests = new Map(),
  systemTheme = matchMedia("(prefers-color-scheme: dark)");
let lastSpeakingAt = 0,
  port,
  state = null,
  cfg = publicConfig(DEFAULTS),
  view = "",
  step = 1,
  sheetClose = null,
  sheetTab = "hearing",
  menuControl = null,
  logSignature = "",
  candidateSignature = "",
  nearBottom = true,
  lastAnnounced = new Set(),
  keyDialogShown = false,
  fixture = false,
  noticeTimer,
  draft = "",
  summarySignature = "";
const alt = /Mac/i.test(navigator.platform) ? "⌥" : "Alt+";
let archiveBase = null,
  captionResize = null,
  followingFrame = false,
  waitingBefore = false,
  unreadCaptions = new Set(),
  knownCaptions = new Set(),
  lastTypingSent = 0,
  typingTimer = null,
  reloadHelp = false,
  keyVerified = false,
  sheetEdit = false,
  sheetKey = "",
  listsTab = "hearing",
  listsBack = "settings",
  hearingDraft = null;
// ヒアリング項目・定型文の上限（config.js の sanitizeConfig と同じ）と、読み上げ10秒の目安の字数。
const LIST_MAX = 30,
  HEARING_SOFT_CHARS = 45;
const listName = (tab) => (tab === "hearing" ? "今日の項目" : "よく使う言葉");
// 「今日の項目を作る」の「今日話したいこと」は画面の欄にだけ置き、保存しない。
// 添付したシートの中身も、このパネルのメモリにだけ置く（保存しない）。
let sheetImport = null,
  sheetParsed = null,
  // 「今日話したいこと」の入力。再描画しても消さず、登録したときと「欄を空にする」でだけ消す（保存しない）。
  draftTopic = "",
  // 保存できなかった一覧の入力（タブごと）。画面を移っても消さず、保存できたら消す（永続保存はしない）。
  editBuffer = {};
function followCaptions() {
  if (!nearBottom || !$("captions")) return;
  // 開始前の画面（今日の議題）は下へ送らず、上から読めるままにする。
  if ($("idle-check")) return;
  followingFrame = true;
  $("captions").scrollTop = $("captions").scrollHeight;
  unreadCaptions.clear();
  updateLatest();
  requestAnimationFrame(() => {
    followingFrame = false;
  });
}
function updateLatest() {
  if (!$("latest")) return;
  $("latest").textContent = `↓ 新しい字幕 ${unreadCaptions.size} 件`;
  $("latest").hidden = nearBottom || !unreadCaptions.size;
}
function markTyping() {
  const send = () => {
    lastTypingSent = Date.now();
    typingTimer = null;
    rpc("setTyping").catch(() => {});
  };
  if (Date.now() - lastTypingSent >= 300) {
    clearTimeout(typingTimer);
    send();
  } else if (!typingTimer)
    typingTimer = setTimeout(send, 300 - (Date.now() - lastTypingSent));
}
function connect() {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener((m) => {
    if (m.type === "reply") {
      const r = requests.get(m.requestId);
      if (!r) return;
      clearTimeout(r.timer);
      requests.delete(m.requestId);
      m.error ? r.reject(new Error(m.error)) : r.resolve(m.value);
    } else if (m.type === "snapshot" && !fixture) receive(m.state);
    else if (m.type === "progress" && !fixture && state) {
      Object.assign(archiveBase || state, m.patch);
      if (view === "meeting") updateStatus();
    } else if (m.type === "notice") notice(m.text);
  });
  port.onDisconnect.addListener(() => {
    for (const r of requests.values()) {
      clearTimeout(r.timer);
      r.reject(new Error("接続し直しています"));
    }
    requests.clear();
    notice("接続し直しています…");
    setTimeout(connect, 1000);
  });
}
function rpc(command, data = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID(),
      timer = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error("操作が時間内に終わりませんでした"));
      }, 70000);
    requests.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ requestId, command, ...data });
    } catch {
      clearTimeout(timer);
      requests.delete(requestId);
      reject(new Error("接続し直しています"));
    }
  });
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("notice").hidden = true), 4000);
}
function theme() {
  document.documentElement.dataset.theme =
    cfg.theme === "auto" ? (systemTheme.matches ? "dark" : "light") : cfg.theme;
  document.documentElement.dataset.motion = cfg.reduceMotion
    ? "reduce"
    : "auto";
  document.documentElement.style.setProperty(
    "--caption-size",
    cfg.captionFontPx + "px",
  );
}
systemTheme.addEventListener("change", theme);
async function save(patch) {
  const result = await rpc("saveConfig", { patch });
  cfg = { ...cfg, ...result };
  theme();
  return result;
}
function receive(next) {
  if (archiveBase) {
    archiveBase = next;
    return;
  }
  state = next;
  cfg = { ...cfg, ...next.cfg };
  theme();
  if (!view) {
    view = cfg.onboarded ? "meeting" : "onboarding";
    if (view === "onboarding" && cfg.hasKey) step = 2;
    if (view === "meeting") renderMeeting();
    else renderWizard();
  }
  if (state.ended && state.summaryState !== "idle" && view === "meeting") {
    view = "summary";
    renderSummary();
  }
  if (view === "meeting") updateMeeting();
  else if (view === "summary") updateSummary();
  else if ((view === "onboarding" && step === 3) || view === "settings")
    updateWarm();
  if (state.keyError && !keyDialogShown) {
    keyDialogShown = true;
    showKeyDialog();
  }
  if (!state.keyError) keyDialogShown = false;
}
function mainMarkup() {
  return `<div class="meeting" id="meeting"><header id="status" class="status" data-tone="neutral" role="status"><span class="status-mark" id="status-mark"></span><div class="status-copy"><div class="status-line"><strong id="status-text"></strong><span class="seconds" id="seconds"></span></div>
<small id="status-detail"></small></div>
<div class="meter" id="meter" aria-hidden="true" hidden>${"<i></i>".repeat(8)}</div>
<button id="stop-voice" class="stop-voice" data-action="stopSpeaking" hidden>止める<span class="shortcut">（Esc）</span></button><button id="end-session" class="end-session" data-action="confirmStop" hidden>${icon("stop", 14)}会話を停止</button><button class="icon quiet" id="menu-trigger" aria-label="メニュー（設定・会話を停止）" title="設定・会話を停止" aria-expanded="false" aria-controls="menu">${icon("gear")}</button></header>
<div class="bands" id="bands"></div>
<div class="connection" id="connections"></div>
<div class="captions-wrap"><div class="captions" id="captions" aria-label="会話の字幕" tabindex="0"></div>
<button id="latest" class="latest" data-action="latest" hidden>最新へ ${icon("arrow", 14)}</button></div>
<div class="lower" id="lower"><div class="shortcut-tip" id="shortcut-tip" hidden><kbd>Tab</kbd> 移動 <kbd>Enter/Space</kbd> 押す<br><kbd>${alt}1〜3</kbd> 候補 <kbd>${alt}4〜7</kbd> 相づち <kbd>Esc</kbd> 止める <kbd>/</kbd> 入力へ</div>
<section class="candidates" aria-label="返事の候補"><div class="candidate-heading"><span id="candidate-heading">返事の候補</span><button class="link" data-action="regenerate" title="返事の候補を出し直す（${alt}R）">${icon("spinner", 13)} 出し直す <span class="shortcut">${alt}R</span></button></div>
<div id="candidates" class="candidate-list"></div>
</section>
<div class="quick-row" id="quick"></div>
<div class="composer"><label><span class="sr">読み上げる文</span><textarea id="input" rows="1" placeholder="打って Enter で読み上げ" title="Enter で読み上げ／Shift+Enter で改行"></textarea></label><button class="primary" id="say" data-action="say">話す</button><button class="icon" id="intro" data-action="intro" aria-label="はじめの一言を読み上げる" title="はじめの一言（${alt}0）">${icon("intro")}</button><button class="icon hearing-trigger" id="hearing" data-action="sheet" aria-label="今日の項目（聞くこと・確認すること）" aria-expanded="false" aria-controls="sheet" title="今日の項目（${alt}H）">${icon("list")}<span id="remaining" class="badge"></span></button></div>
</div><div id="menu" class="menu u037" role="menu" hidden><button role="menuitem" data-action="settings">${icon("gear")}設定</button><button role="menuitem" data-action="confirmStop" class="danger">${icon("stop")}会話を停止</button></div>
<section id="sheet" class="sheet u305" role="dialog" aria-label="今日の項目とよく使う言葉" hidden></section>
<div class="intro-tip" id="intro-tip" hidden>はじめの一言はここ（${alt}0）</div>
</div>`;
}
function disposeMenu() {
  captionResize?.disconnect();
  captionResize = null;
  clearTimeout(typingTimer);
  typingTimer = null;
  menuControl?.destroy();
  menuControl = null;
}
function renderMeeting() {
  disposeMenu();
  view = "meeting";
  app.innerHTML = mainMarkup();
  menuControl = menu($("menu-trigger"), $("menu"));
  $("input").value = draft;
  logSignature = "";
  candidateSignature = "";
  nearBottom = true;
  waitingBefore = false;
  unreadCaptions.clear();
  knownCaptions = new Set(state?.lines.map((l) => l.id));
  captionResize = new ResizeObserver(() => {
    if (nearBottom) followCaptions();
  });
  captionResize.observe($("captions"));
  $("captions").addEventListener("scroll", (e) => {
    const el = e.currentTarget;
    if (!el.isConnected || el !== $("captions")) return;
    if (!followingFrame)
      nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) unreadCaptions.clear();
    updateLatest();
    el.classList.toggle("history", !nearBottom);
  });
  $("captions").addEventListener("pointerdown", () => {
    if (sheetClose) closeSheet();
  });
  $("input").addEventListener("input", () => {
    draft = $("input").value;
    markTyping();
    $("input").style.height = "44px";
    $("input").style.height = Math.min(86, $("input").scrollHeight) + "px";
  });
  $("input").addEventListener("compositionupdate", markTyping);
  $("input").addEventListener("keydown", (e) => {
    if (
      shouldSendEnter(e, cfg.enterToSpeak) ||
      (!cfg.enterToSpeak && shouldSendEnter(e) && (e.ctrlKey || e.metaKey))
    ) {
      e.preventDefault();
      speakInput();
    }
  });
  updateMeeting();
}
function connection(label, value, mic = false) {
  const muted = mic && pageMuted(state.page);
  const ok = value === "ready",
    failed = value === "failed" || muted;
  const glyph = muted
    ? "micOff"
    : ok
      ? "check"
      : failed
        ? "cross"
        : value === "idle"
          ? "circle"
          : "spinner";
  return `<span class="${failed ? "err" : ""}"><span class="${ok ? "ok" : glyph === "spinner" ? "u079-spin" : ""}">${icon(glyph, 12)}</span>${label}</span>`;
}
function updateStatus() {
  if (!state || !$("meeting")) return;
  const status = state.fixtureStatus || statusView(state);
  $("status").dataset.tone = status.tone;
  $("status").classList.toggle(
    "overlap",
    !!state.speaking && state.otherSpeaking,
  );
  $("status-mark").innerHTML =
    `<span class="${status.icon === "spinner" ? "u079-spin" : ""}">${icon(status.icon, 17)}</span>`;
  $("status-text").textContent = status.text;
  $("seconds").innerHTML =
    status.seconds != null ? `${status.seconds}<small>秒</small>` : "";
  if (state.speaking) lastSpeakingAt = Date.now();
  $("stop-voice").hidden = !state.speaking && Date.now() - lastSpeakingAt > 500;
  // 会議に参加して会話を始めたら、「会話を停止」を歯車の外に出す。
  // 読み上げ中は「止める（Esc）」と並ばないよう隠す（押し間違いを防ぐ）。
  $("end-session").hidden =
    !state.active || !!state.ended || !$("stop-voice").hidden;
  $("status-detail").innerHTML = statusDetails(state)
    .map((d) => `<span>${d.icon ? icon(d.icon, 12) : ""}${esc(d.text)}</span>`)
    .join('<span class="detail-divider">｜</span>');
  $("meter").hidden = !state.speaking;
  [...$("meter").children].forEach((bar, i) => {
    bar.style.height =
      4 +
      Math.min(
        1,
        (reduced() ? 0.35 : state.speaking?.level || 0) *
          [0.35, 0.7, 1, 0.5, 0.8, 0.4, 1, 0.65][i],
      ) *
        16 +
      "px";
  });
}
function updateMeeting() {
  if (!state || !$("meeting")) return;
  updateStatus();
  $("meeting").classList.toggle("not-meeting", !!state.notMeeting);
  $("meeting").classList.toggle("idle", !state.active);
  $("connections").innerHTML =
    connection("字幕", state.sttState) +
    connection("声", state.voiceState) +
    connection(
      "会議のマイク",
      state.page.streams > 0
        ? "ready"
        : state.bands.some((b) => b.id === "meeting")
          ? "failed"
          : "idle",
      true,
    ) +
    `<span class="platform">${!state.active ? "未接続・" : ""}${esc(state.platform || "Google Meet")}</span>`;

  const bandSignature = JSON.stringify(state.bands);
  if ($("bands").dataset.signature !== bandSignature) {
    $("bands").dataset.signature = bandSignature;
    const bandMarkup =
      state.bands
        .slice(0, 2)
        .map((b) => renderBand(b))
        .join("") +
      (state.bands.length > 2
        ? `<button class="more-bands" data-action="moreBands">ほか ${state.bands.length - 2} 件の案内</button>`
        : "");
    replaceAlerts($("bands"), bandMarkup, $("menu-trigger"));
  }
  const logKey = JSON.stringify([
    state.lines,
    cfg.showSpeakerNames,
    state.active,
    state.sttState,
    state.voiceState,
    state.page.streams,
    state.notMeeting,
  ]);
  if (logKey !== logSignature) {
    logSignature = logKey;
    renderCaptions();
  }
  const candKey = JSON.stringify([
    state.candidates,
    state.candidateState,
    state.candidateStreaming,
    state.active,
  ]);
  if (candKey !== candidateSignature) {
    candidateSignature = candKey;
    renderCandidates();
  }
  const quickKey = JSON.stringify(cfg.quick);
  if ($("quick").dataset.key !== quickKey) {
    $("quick").dataset.key = quickKey;
    $("quick").innerHTML = cfg.quick
      .map(
        (q, i) =>
          `<button class="quick" data-action="quick" data-index="${i}" title="「${esc(q.text)}」を読み上げ（${alt}${i + 4}）"><span class="digit">${i + 4}</span>${esc(q.label)}</button>`,
      )
      .join("");
  }
  const connected =
    state.active &&
    (state.voiceState === "ready" ||
      (state.connectedOnce && state.preState === "ready")) &&
    (state.sttState === "ready" || state.connectedOnce) &&
    state.page.streams > 0;
  document
    .querySelectorAll(".candidate,.candidate-edit,.quick,#intro,#say")
    .forEach(
      (b) =>
        (b.disabled =
          !connected ||
          b.dataset.pending === "true" ||
          (state.candidateState === "thinking" &&
            b.matches(".candidate,.candidate-edit"))),
    );
  $("input").disabled = !state.active;
  $("meeting").classList.toggle(
    "dim-sends",
    state.active && pageMuted(state.page),
  );
  const remaining = Math.max(0, cfg.hearing.length - state.hearingAsked.length);
  const muted = pageMuted(state.page);
  const sent =
    !!state.speaking ||
    state.candidatesRead ||
    (state.otherSpeaking && state.candidates.length);
  $("meeting").classList.toggle("previous-candidates", !!sent);
  $("candidate-heading").classList.toggle("mute-heading", !!muted);
  if (muted)
    $("candidate-heading").innerHTML =
      icon("micOff", 14) + " ミュートを解除すると送れます";
  else if (sent)
    $("candidate-heading").innerHTML = icon("check", 13) + " 読み上げました";
  else
    $("candidate-heading").textContent =
      state.candidateState === "thinking"
        ? "候補を考えています…"
        : state.candidateStreaming
          ? "返事の候補（残りを作成中）"
          : "返事の候補";
  const connecting = state.active && !state.connectedOnce;
  document.querySelector(
    '.candidate-heading [data-action="regenerate"]',
  ).hidden = connecting || !state.active;
  const waiting = state.active && !!state.waitSince && !state.otherSpeaking;
  if (
    waiting &&
    !waitingBefore &&
    nearBottom &&
    !sheetClose &&
    document.activeElement !== $("captions") &&
    $("menu").hidden &&
    !document.querySelector("dialog[open]")
  )
    $("input").focus();
  waitingBefore = waiting;
  followCaptions();
  /* DEV_START */
  if (!fixture) {
    let metrics = $("dev-metrics");
    if (!metrics) {
      metrics = document.createElement("small");
      metrics.id = "dev-metrics";
      $("lower").append(metrics);
    }
    metrics.textContent = `開発計測：押下→声 ${metricText(state.metrics.taps.map((x) => x.ms))} ／ 往復 ${metricText(state.metrics.roundTrips)}`;
  }
  /* DEV_END */
  if (sheetClose && !sheetEdit && sheetSignature() !== sheetKey)
    renderSheet(true);
  $("remaining").textContent = "残" + remaining;
  $("hearing").setAttribute(
    "aria-label",
    `今日の項目（残り${remaining}項目）`,
  );
  if (state.active && !sessionStorage.getItem("introTip")) {
    sessionStorage.setItem("introTip", "1");
    $("intro-tip").hidden = false;
    setTimeout(() => {
      if ($("intro-tip")) $("intro-tip").hidden = true;
    }, 3000);
  }
}
function renderBand(b) {
  const action = b.id === "meeting" ? "reloadHelp" : b.action;
  const glyph =
    b.tone === "bad" ? "cross" : b.tone === "waiting" ? "check" : "spinner";
  const split = b.text.indexOf("。");
  const text =
    split < 0
      ? `<strong>${esc(b.text)}</strong>`
      : `<strong>${esc(b.text.slice(0, split + 1))}</strong>${esc(b.text.slice(split + 1))}`;
  return `<div class="band u072" data-tone="${b.tone}" role="${b.tone === "bad" ? "alert" : "status"}"><i class="band-mark ${glyph === "spinner" ? "u079-spin" : ""}">${icon(glyph, 17)}</i><div class="band-copy">${text}${action === "reloadHelp" && reloadHelp ? "<p>会議のタブに戻り、ブラウザの再読み込み（⌘R / Ctrl+R）を押して、会議に参加し直してください。</p>" : ""}</div>${action ? `<button class="inline" data-action="${esc(action)}" ${action === "reloadHelp" ? `aria-expanded="${reloadHelp}"` : ""}>${action === "reloadHelp" ? "再読み込みの方法" : action === "start" ? "開始" : action === "settings" ? "設定を開く" : "やり直す"}</button>` : ""}</div>`;
}
function renderCaptions() {
  const el = $("captions"),
    top = el.scrollTop;
  if (!state.lines.length) {
    // 開始前の画面では「今日の議題」の欄（入力中の文・添付・案）を作り直さず、確認の一覧だけ更新する。
    const check = el.querySelector("#idle-check"),
      mode = prepMode();
    if (check && mode && check.dataset.mode === mode) {
      // 同じ画面のままなら、確認・案内の部分だけを差し替える。
      if (mode === "idle") check.innerHTML = idleCheckMarkup();
    } else {
      el.innerHTML = emptyMarkup();
      // 開始前の画面は上の「今日の議題」から読めるようにする。
      if (el.querySelector("#idle-check")) el.scrollTop = 0;
    }
    const start = el.querySelector("[data-empty-start]");
    if (start)
      emptyAction(
        start,
        () => rpc("start").catch((e) => notice(e.message)),
        $("input"),
      );
    return;
  }
  el.replaceChildren();
  let previousLine;
  for (const line of state.lines) {
    if (!nearBottom && !knownCaptions.has(line.id) && !line.gap)
      unreadCaptions.add(line.id);
    knownCaptions.add(line.id);
    const div = document.createElement("article");
    div.className = `caption ${line.who === "me" ? "me" : ""} ${line.partial ? "partial" : ""} ${line.gap ? "gap" : ""} ${line.failed ? "failed" : ""} ${line.mismatch ? "mismatch" : ""}`;
    div.dataset.id = line.id;
    const time = new Date(line.at).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const speaker = captionSpeaker(line, previousLine, cfg.showSpeakerNames);
    previousLine = line;
    div.innerHTML = `<div class="bubble">${speaker ? `<h3 class="caption-speaker">${esc(speaker)}</h3>` : ""}<div class="time">${line.who === "me" ? icon("speaker", 12) : ""}${time}</div>
<div class="text${!line.text && line.partialUnknown ? " unverified" : ""}">${esc((line.mismatch ? line.requested : line.text) || (line.verifying ? "読み上げ範囲を確認しています…" : line.partialUnknown ? line.requested || "" : ""))}</div>${line.interrupted ? `<div class="annotation">（途中で止めました）${line.partialUnknown ? " 読み上げ範囲は未確認" : ""}</div>` : ""}</div>
      ${line.failed ? `<div class="annotation failed-note">${icon("warn", 14)}<span>読み上げに失敗しました（${esc(line.error || "接続が切れました")}）</span><button data-action="retryLine" data-id="${esc(line.id)}">もう一度</button></div>` : ""}      ${line.mismatch ? `<div class="annotation mismatch-note">${icon("warn", 14)}<span>実際に読まれた文: ${esc(line.text)}</span><button data-action="fixLine" data-id="${esc(line.id)}">直す</button></div>` : ""}`;
    el.append(div);
    if (line.who === "other" && !line.partial && !lastAnnounced.has(line.id)) {
      lastAnnounced.add(line.id);
      $("live-caption").textContent =
        (cfg.showSpeakerNames && line.speaker ? `${line.speaker}: ` : "") +
        line.text;
    }
  }
  if (nearBottom) followCaptions();
  else el.scrollTop = top;
  updateLatest();
}
function emptyMarkup() {
  const connectedCount = [
    state.sttState === "ready",
    state.voiceState === "ready",
    state.page.streams > 0,
  ].filter(Boolean).length;
  if (state.notMeeting)
    return `<div class="empty u092 idle-start">${prepMarkup("会議の前に準備できます。入れた項目は、会議のタブでそのまま使えます。書きかけの欄と案も、Chrome を終了するまで残ります。")}<div id="idle-check" class="idle-check empty-notmeeting" data-mode="notmeeting"><div class="browser-diagram" aria-hidden="true"><div class="browser-tab"></div>
<div class="toolbar"><span>‹ ›</span><i class="address"></i>${icon("puzzle", 14)}<b>${icon("intro")}</b></div>
<div class="browser-lines"><i></i><i></i></div>
<small>ここを押す：フキダシ</small></div>
<p>このタブは会議ではないようです。Google Meet または Zoom（ブラウザで参加）のタブで、ツールバーの「フキダシ」アイコンを押してください。</p><small>Zoom は招待画面の「ブラウザから参加」を選びます</small><span class="beta-note"><span class="pill beta">ベータ</span> Zoom ブラウザ版はベータです</span><button data-action="settings">設定を開く</button></div></div>`;
  if (!state.active)
    return `<div class="empty u092 idle-start">${prepMarkup()}<div id="idle-check" class="idle-check" data-mode="idle">${idleCheckMarkup()}</div></div>`;
  if (
    state.sttState !== "ready" ||
    state.voiceState !== "ready" ||
    !state.page.streams
  )
    return connectMarkup(connectedCount);
  return `<div class="empty u092">${icon("ear", 48)}<p>相手の声を待っています。話し始めると、ここに字幕が出ます。</p></div>`;
}
// 「今日の議題」を出す画面（会議のタブでない画面・開始前の画面）。それ以外は null。
function prepMode() {
  if (state.lines.length) return null;
  if (state.notMeeting) return "notmeeting";
  return state.active ? null : "idle";
}
function prepMarkup(lead = "") {
  return `<section class="today-prep" aria-labelledby="today-prep-title"><h2 id="today-prep-title">今日の議題（任意）</h2>${lead ? `<p class="small prep-lead">${lead}</p>` : ""}${draftControls()}</section>`;
}
function idleCheckMarkup() {
  return `<p>会議に参加したら「開始」を押してください。相手の声がここに文字で出ます。</p><div class="checklist">${[
      ["会議のページに参加している", state.page.streams > 0],
      ["会議側のマイクがミュートになっていない", state.page.unmuted > 0],
      ["API キーが設定されている", cfg.hasKey],
    ]
      .map(
        ([text, ok]) =>
          `<div class="row"><span class="check-circle ${ok ? "checked" : ""}">${ok ? icon("check", 12) : ""}</span><div>${text}<small>${ok ? "確認済み（自動で確かめました）" : "未確認・開始すると確認します"}</small></div>
</div>`,
      )
      .join("")}</div>
<button class="primary start-button" data-empty-start>${icon("play", 16)} 開始</button>`;
}
function connectMarkup(connectedCount) {
  return `<div class="empty u092"><h2>接続の確認</h2><div class="checklist">${[
      ["字幕（相手の声を文字にする）", state.sttState === "ready"],
      ["声（AI の声）", state.voiceState === "ready"],
      ["会議のマイク（会議に声を送る）", state.page.streams > 0],
    ]
      .map(([label, ok], i, list) => {
        const current = !ok && list.findIndex((x) => !x[1]) === i;
        return `<div class="row between"><span>${label}</span><span class="check-state ${ok ? "ok" : ""}"><i class="${current ? "u079-spin" : ""}">${icon(ok ? "check" : current ? "spinner" : "circle", 16)}</i>${ok ? "完了" : current ? "確認中" : "このあと"}</span></div>`;
      })
      .join("")}</div>
<div class="connection-progress"><div class="progress" role="progressbar" aria-label="接続の確認" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${connectedCount}"><i style="width:${(connectedCount / 3) * 100}%"></i></div><span>${connectedCount} / 3</span></div>
<small>3 つともつながると、この一覧は消え、いちばん上の「字幕・声・会議のマイク」の行にまとまります。</small></div>`;
}
function renderCandidates() {
  const focused = document.activeElement;
  const restore =
    focused?.matches?.(".candidate,.candidate-edit") &&
    $("candidates").contains(focused)
      ? { action: focused.dataset.action, index: focused.dataset.index }
      : null;
  const thinking = state.candidateState === "thinking";
  $("candidate-heading").textContent = thinking
    ? "候補を考えています…"
    : "返事の候補";
  $("candidates").setAttribute(
    "aria-busy",
    String(thinking || !!state.candidateStreaming),
  );
  if (state.candidateState === "failed") {
    $("candidates").innerHTML =
      `<div class="candidate-failed">${icon("warn", 18)}<span>候補を作れませんでした（接続が不安定です）。打って答えるか、<button class="link" data-action="regenerate" aria-label="候補を出し直す">↻</button> で出し直せます</span></div>`;
    return;
  }
  if (!state.candidates.length && !thinking) {
    $("candidates").innerHTML =
      `<div class="candidate-placeholder">${state.active ? (state.connectedOnce ? "相手が話すと候補が出ます" : '<span>つながると出ます</span><div class="pending-cards"><i></i><i></i><i></i></div>') : "会議が始まると、ここから返事できます"}</div>`;
    return;
  }
  $("candidates").innerHTML = (
    thinking || state.candidateStreaming
      ? Array.from({ length: 3 }, (_, i) => state.candidates[i])
      : state.candidates
  )
    .map((c, i) => {
      const pending = thinking || !c;
      return `<div class="candidate-row"><button class="candidate" data-action="candidate" data-index="${i}" data-pending="${pending}" ${pending ? "disabled" : ""}><span class="number"><b>${i + 1}</b><span class="shortcut">${alt}${i + 1}</span></span>${pending ? '<span class="u079-lines"><i class="u079"></i><i class="u079"></i></span>' : `<span class="candidate-text">${esc(c.text)}</span>${c.ready ? '<span class="pill" title="押すとすぐ声が出ます">即</span>' : '<span style="width:26px"></span>'}`}</button><button class="candidate-edit" data-action="editCandidate" data-index="${i}" aria-label="候補${i + 1}を直す" data-pending="${pending}" ${pending ? "disabled" : ""}>${pending ? '<span class="u079" style="display:block;width:22px;height:8px;margin:auto"></span>' : "直す"}</button></div>`;
    })
    .join("");
  if (restore) {
    const next = $("candidates").querySelector(
      `[data-action="${restore.action}"][data-index="${restore.index}"]`,
    );
    if (next && !next.disabled) next.focus({ preventScroll: true });
  }
}
async function speakInput() {
  const text = $("input")?.value.trim();
  if (!text) return;
  try {
    const accepted = await rpc("say", { text, kind: "type" });
    if (accepted && $("input")?.value.trim() === text) {
      draft = "";
      $("input").value = "";
      $("input").style.height = "44px";
    }
  } catch (e) {
    notice(e.message);
  }
}
function closeSheet() {
  // 閉じる操作は止められないので、保存に失敗しても入力は editBuffer に残り、次に開くと戻る。
  if (sheetEdit) flushEditor();
  sheetEdit = false;
  $("meeting")?.classList.remove("sheet-open");
  sheetClose?.();
  sheetClose = null;
}
function sheetSignature() {
  return JSON.stringify([
    sheetTab,
    sheetEdit,
    cfg.hearing,
    cfg.phrases,
    state?.hearingAsked,
    state?.warm?.ready,
  ]);
}
function renderSheet(keepFocus = false) {
  if (!$("sheet")) return;
  const sheet = $("sheet");
  const focused = document.activeElement,
    restore =
      keepFocus && sheet.contains(focused)
        ? focused.dataset.hearing != null
          ? `[data-hearing="${focused.dataset.hearing}"]`
          : focused.dataset.action
            ? `[data-action="${focused.dataset.action}"]${focused.dataset.index != null ? `[data-index="${focused.dataset.index}"]` : ""}${focused.dataset.tab ? `[data-tab="${focused.dataset.tab}"]` : ""}`
            : null
        : null;
  sheetKey = sheetSignature();
  const list = sheetTab === "hearing" ? cfg.hearing : cfg.phrases,
    ready = new Set(state?.warm?.ready || []);
  const read = `${sheetTab === "hearing" ? `<div class="row between"><strong>残り ${Math.max(0, cfg.hearing.length - state.hearingAsked.length)} 項目</strong><small>読み上げると自動で済みになります</small></div>` : ""}${list.length ? "" : `<p class="edit-empty">まだありません。下の「この一覧を編集する」から追加できます。</p>`}${list.map((text, i) => `<div class="sheet-item ${sheetTab === "hearing" && state.hearingAsked.includes(i) ? "done" : ""}">${sheetTab === "hearing" ? `<label><input type="checkbox" data-hearing="${i}" ${state.hearingAsked.includes(i) ? "checked" : ""}>${esc(text)}</label>` : `<span style="flex:1">${esc(text)}</span>`}${ready.has(text) ? '<span class="pill ready-pill" title="声を作り置き済みです。押すとすぐ声が出ます">即</span>' : ""}<button class="outline" data-action="sheetSay" data-index="${i}">${icon("speaker", 12)} 読み上げ</button></div>`).join("")}`;
  sheet.innerHTML = `<div class="sheet-handle"></div>
<small class="sheet-esc">Esc で閉じる</small><div class="sheet-head" role="tablist" aria-label="話す内容"><button role="tab" id="tab-hearing" data-action="sheetTab" data-tab="hearing" aria-selected="${sheetTab === "hearing"}" tabindex="${sheetTab === "hearing" ? 0 : -1}">今日の項目</button><button role="tab" id="tab-phrases" data-action="sheetTab" data-tab="phrases" aria-selected="${sheetTab === "phrases"}" tabindex="${sheetTab === "phrases" ? 0 : -1}">よく使う</button><button class="icon quiet close" data-action="closeSheet" aria-label="閉じる（Esc）">${icon("cross")}</button></div>
<div class="sheet-body" role="tabpanel" aria-labelledby="tab-${sheetTab}">${sheetEdit ? listEditorMarkup(sheetTab) : read}</div><button class="link sheet-settings" data-action="sheetEdit" aria-pressed="${sheetEdit}">${sheetEdit ? `${icon("check", 12)} 編集を終える` : `${icon("edit", 12)} この一覧を編集する（追加・書き換え・並べ替え・削除）`}</button>`;
  sheet.querySelector("[role=tablist]").onkeydown = (e) => {
    if (TAB_KEYS.includes(e.key)) {
      e.preventDefault();
      const tab = nextTab(sheetTab, e.key, ["hearing", "phrases"]);
      (sheetEdit ? flushEditor() : Promise.resolve(true)).then((ok) => {
        if (!ok) return;
        sheetTab = tab;
        renderSheet();
        $("tab-" + sheetTab).focus();
      });
    }
  };
  if (restore) sheet.querySelector(restore)?.focus({ preventScroll: true });
}
function countMarkup(tab, text) {
  const n = [...text].length,
    long = tab === "hearing" && n > HEARING_SOFT_CHARS;
  return `<small class="edit-count${long ? " long" : ""}">${n} 字${long ? "・長め（読み上げが10秒を超えるかもしれません）" : ""}</small>`;
}
function listEditorMarkup(tab) {
  const unsaved = !!editBuffer[tab],
    list = editBuffer[tab] || cfg[tab] || [],
    full = list.length >= LIST_MAX,
    noun = tab === "hearing" ? "項目" : "文";
  return `<div class="list-editor" data-list="${tab}"><p class="editor-note">${tab === "hearing" ? `今日の会議で、読み上げてお客様に聞く・確認する文です。1 問は ${HEARING_SOFT_CHARS} 字（読み上げ 10 秒）以内が目安です。` : "シートの「よく使う」に出る文です。"}変更はすぐに保存し、会話中なら変えた${noun}の声だけを作り直します。<small class="edit-status" id="edit-status" aria-live="polite"></small></p>${unsaved ? `<p class="error-text edit-unsaved" role="alert">保存できていない変更があります（入力は残しています）。<button class="link" data-action="listRetry">もう一度保存する</button></p>` : ""}${list.length ? "" : `<p class="edit-empty">まだありません。下の欄から追加してください。</p>`}<ol class="edit-list">${list
    .map(
      (text, i) =>
        `<li class="edit-item"><span class="edit-num" aria-hidden="true">${i + 1}</span><div class="edit-main"><textarea class="edit-text" data-edit-index="${i}" rows="2" aria-label="${listName(tab)}の ${i + 1} 番目">${esc(text)}</textarea>${countMarkup(tab, text)}</div><div class="edit-tools"><button class="icon quiet edit-up" data-action="listMove" data-index="${i}" data-dir="-1" aria-label="${i + 1} 番目を上へ" title="上へ" ${i === 0 ? "disabled" : ""}>${icon("arrow", 16)}</button><button class="icon quiet" data-action="listMove" data-index="${i}" data-dir="1" aria-label="${i + 1} 番目を下へ" title="下へ" ${i === list.length - 1 ? "disabled" : ""}>${icon("arrow", 16)}</button><button class="icon quiet edit-delete" data-action="listDelete" data-index="${i}" aria-label="${i + 1} 番目を削除" title="削除">${icon("cross", 16)}</button></div></li>`,
    )
    .join(
      "",
    )}</ol><div class="edit-add"><label class="field" for="list-add">${noun}を追加${full ? `（${LIST_MAX} 件までです）` : ""}</label><textarea id="list-add" rows="2" placeholder="${tab === "hearing" ? "例：ご希望の公開時期を、お聞かせいただけますでしょうか。" : "例：少し考えるお時間をいただけますでしょうか。"}" ${full ? "disabled" : ""}></textarea><button data-action="listAdd" ${full ? "disabled" : ""}>＋ 追加</button></div></div>`;
}
function editorValues(root) {
  return [...root.querySelectorAll("[data-edit-index]")].map((el) =>
    el.value.trim(),
  );
}
function setEditStatus(text) {
  if ($("autosave")) $("autosave").textContent = text;
  if ($("edit-status")) $("edit-status").textContent = text;
}
async function saveList(tab, values) {
  const list = values.filter(Boolean).slice(0, LIST_MAX);
  if (JSON.stringify(list) === JSON.stringify(cfg[tab])) {
    delete editBuffer[tab];
    return false;
  }
  editBuffer[tab] = list; // 保存できるまで入力を持っておく
  setEditStatus("保存中…");
  try {
    await save({ [tab]: list });
    delete editBuffer[tab];
    setEditStatus("保存しました");
  } catch (e) {
    setEditStatus("保存できませんでした。入力は残しています");
    throw e;
  }
  return true;
}
// 編集中の一覧を保存する。保存できたか（変更が無かったか）を true / false で返す。
// false のときは画面を移らずに入力を残し、もう一度保存できるようにする。
async function flushEditor() {
  const root = app.querySelector(".list-editor[data-list]");
  if (!root) return true;
  try {
    await saveList(root.dataset.list, editorValues(root));
    return true;
  } catch (e) {
    notice(`保存できませんでした（${e.message}）。入力は残しています。もう一度お試しください`);
    return false;
  }
}
function rerenderEditor(selector) {
  if (view === "lists") renderLists();
  else if (sheetClose) renderSheet();
  const el = selector && app.querySelector(selector);
  if (el && !el.disabled) el.focus();
  else app.querySelector("#list-add")?.focus();
}
function renderLists(tab = listsTab) {
  disposeMenu();
  view = "lists";
  listsTab = tab;
  app.innerHTML = `<div class="fullscreen settings lists-screen"><header class="screen-head"><button class="icon quiet" data-action="listsBack" aria-label="戻る">${icon("back")}</button><strong>質問・定型文の編集</strong><span class="autosave" id="autosave">変更はすぐに保存されます</span></header><div class="screen-body"><div class="sheet-head lists-tabs" role="tablist" aria-label="編集する一覧">${[
    ["hearing", "今日の項目"],
    ["phrases", "よく使う"],
  ]
    .map(
      ([key, label]) =>
        `<button role="tab" id="lists-tab-${key}" data-action="listsTab" data-tab="${key}" aria-selected="${listsTab === key}" tabindex="${listsTab === key ? 0 : -1}">${label} <small>${cfg[key].length}</small></button>`,
    )
    .join(
      "",
    )}</div><p class="small lists-note">会話中は「今日の項目」のシート（${alt}H）からも同じ一覧を直せます。声がつながると、項目と定型文の声を上から ${WARM_LIST_LIMIT} 件まで先に作り、押すとすぐ声が出ます（声を作る分の OpenAI の利用料がかかります。同じ文は作り直しません）。</p>${listsTab === "hearing" ? '<p class="small lists-note">今日の議題から項目を作るときは、会議の開始前の画面（「開始」ボタンの上）を使います。</p>' : ""}${listEditorMarkup(listsTab)}</div></div>`;
}
function draftControls() {
  const job = String(cfg.job || "").trim();
  return `<div class="draft-hearing"><label class="field" for="draft-topic">話したいこと・聞きたいこと<textarea id="draft-topic" rows="4" placeholder="例：納品前の最終確認。修正が残っていないか、公開日、ログイン情報の渡し方、保守を続けるかを確かめたい。&#10;AI と壁打ちしたメモ（ChatGPT・Claude など）や、スプレッドシート・Word からコピーしたヒアリングシートをそのまま貼り付けても使えます。">${esc(draftTopic)}</textarea></label><button class="link draft-topic-clear" data-action="draftTopicClear" ${draftTopic ? "" : "hidden"}>欄を空にする</button><div class="row draft-row"><button data-action="sheetPick" id="sheet-pick">${icon("download", 14)} 今日の議題を添付</button><input type="file" id="sheet-file" accept="${SHEET_ACCEPT}" hidden><button class="draft-make" data-action="draftHearing" id="draft-hearing" ${draftBlocked(job) ? "disabled" : ""}>${icon("list", 14)} 今日の項目を作る</button></div><small>添付は議題やヒアリングシートのファイル（Excel・Word・CSV・md・txt、5MB まで）。何も書かずに作ると、設定の「仕事」に合う初回ヒアリングの項目になります。</small><div id="sheet-area" aria-live="polite">${sheetMarkup()}</div><small class="draft-note" id="draft-note" aria-live="polite">${esc(draftNote())}</small><div id="draft-area" aria-live="polite">${draftMarkup()}</div><div class="row draft-own"><label class="sr" for="draft-own">自分で質問を足す</label><input id="draft-own" type="text" placeholder="自分で質問を足す"><button data-action="draftOwn">案に入れる</button></div><button class="link lists-link" data-action="openLists" data-tab="hearing">${icon("list", 14)} 今の項目（${cfg.hearing.length} 問）を見る・直す ›</button><details class="prep-privacy"><summary>OpenAI に送るもの・残るもの</summary><small>項目を作るときに送るのは、仕事・補足・この欄・添付から選んだ項目の名前だけです。会議の字幕は送りません。作るたびに OpenAI の利用料がかかります。書きかけの欄と案は Chrome を終了するまでこの端末のメモリに残り、ディスクには書きません。添付したファイルは保存しません。</small></details></div>`;
}
function sheetMarkup() {
  const s = sheetImport;
  if (!s) return "";
  if (s.status === "reading")
    return `<div class="draft-box" role="status"><span class="u079-spin">${icon("spinner", 16)}</span> 「${esc(s.fileName)}」を読み取っています…</div>`;
  if (s.status === "failed")
    return `<p class="error-text sheet-error" role="alert">${esc(s.fileName)}: ${esc(s.error)}</p>`;
  const empty = s.items.filter((i) => !i.filled).length,
    picked = s.items.filter((i) => i.checked).length,
    pending = (s.tables || []).filter((t) => t.needsMapping || t.chosen),
    // 自動で読んだ表も、あとから列を選び直せるようにする（2列以上ある表だけ）。
    auto = (s.tables || []).filter(
      (t) => !t.needsMapping && !t.chosen && t.columns.length >= 2,
    );
  const option = (c, selected) =>
    `<option value="${c.index}" ${c.index === selected ? "selected" : ""}>${c.name} 列（${c.samples.length ? esc(c.samples.join("・")) : "空の列"}）</option>`;
  const pick = (tb, role) => {
    const m = s.mapping?.[tb.key];
    if (m) return m[role];
    if (tb.suggestion && tb.suggestion[role] !== undefined)
      return tb.suggestion[role];
    return role === "label" ? tb.columns[0]?.index : tb.columns[1]?.index;
  };
  const chooser = (tb) =>
    `<label>項目の列<select data-map-role="label">${tb.columns.map((c) => option(c, pick(tb, "label"))).join("")}</select></label><label>記入欄の列<select data-map-role="answer"><option value="" ${pick(tb, "answer") == null ? "selected" : ""}>（記入欄なし・全部聞く）</option>${tb.columns.map((c) => option(c, pick(tb, "answer"))).join("")}</select></label><button data-action="sheetMap" data-key="${esc(tb.key)}">この列で読む</button>`;
  const mapMarkup = pending
    .map(
      (tb) =>
        `<div class="sheet-map" data-map-key="${esc(tb.key)}"><p class="small">${tb.needsMapping ? `「${esc(tb.key)}」の表は、どの列が項目で、どの列が記入欄か分かりませんでした。列を選んでください（選ぶまでこの表は使いません）。` : `「${esc(tb.key)}」は選んだ列で読んでいます。`}</p>${chooser(tb)}</div>`,
    )
    .join("") +
    auto
      .map(
        (tb) =>
          `<details class="sheet-map sheet-remap" data-map-key="${esc(tb.key)}"><summary>「${esc(tb.key)}」の列を選び直す</summary>${chooser(tb)}</details>`,
      )
      .join("");
  return `<div class="draft-box sheet-box" role="group" aria-labelledby="sheet-title"><div class="row between draft-head"><strong id="sheet-title">「${esc(s.fileName)}」から読み取れた項目 ${s.items.length}（空欄 ${empty}）</strong><button class="link" data-action="sheetClear">添付をやめる</button></div>${
    s.sheets.length > 1
      ? `<fieldset class="sheet-names"><legend>読むシート</legend>${s.sheets.map((name) => `<label><input type="checkbox" data-sheet-name="${esc(name)}" ${s.chosen.includes(name) ? "checked" : ""}>${esc(name)}</label>`).join("")}</fieldset>`
      : ""
  }${s.truncated ? `<p class="small warn-note">${SHEET_MAX_CHARS.toLocaleString()} 字を超えたため、先頭から ${SHEET_MAX_CHARS.toLocaleString()} 字までを読みました。</p>` : ""}${mapMarkup}<div class="draft-list">${
    s.items.length
      ? s.items
          .map(
            (item, i) =>
              `<label class="draft-item${item.filled ? " filled" : ""}"><input type="checkbox" data-sheet-item="${i}" ${item.checked ? "checked" : ""}><span>${esc(item.label)}${item.filled ? ' <small>記入済み</small>' : ""}${item.hint ? ` <small>（${esc(item.hint)}）</small>` : ""}${s.sheets.length > 1 ? ` <small class="sheet-of">${esc(item.sheet)}</small>` : ""}</span></label>`,
          )
          .join("")
      : pending.some((tb) => tb.needsMapping)
        ? ""
        : '<p class="small">項目を読み取れませんでした。表や文章をコピーして、上の欄に貼り付けてください。</p>'
  }</div><small>チェックした ${picked} 項目を質問にします（空欄の項目を最初から選んでいます。記入済みの値は送りません）。結合セル・チェックボックス・画像・図形の中の文字は読めないことがあります。</small></div>`;
}
function renderSheetImport() {
  if ($("sheet-area")) $("sheet-area").innerHTML = sheetMarkup();
  updateDraftButton();
}
// 添付の読み直し（シートの選択・列の割り当てを変えたとき）。チェックの状態は項目ごとに引き継ぐ。
function analyzeImport() {
  if (!sheetParsed || !sheetImport) return;
  const before = new Map(
    (sheetImport.items || []).map((i) => [i.sheet + "\u0000" + i.label, i]),
  );
  const { items, tables } = analyzeSheet(
    sheetParsed,
    sheetImport.chosen,
    sheetImport.mapping || {},
  );
  sheetImport.tables = tables;
  sheetImport.items = items.map((item) => ({
    ...item,
    // 利用者の選択は引き継ぐ。ただし列を選び直して空欄かどうかが変わった項目は、空欄だけを選び直す。
    checked: (() => {
      const prev = before.get(item.sheet + "\u0000" + item.label);
      return prev && prev.filled === item.filled ? prev.checked : !item.filled;
    })(),
  }));
}
// 添付があって項目を1つも選んでいないとき: 自由記述が無ければ作れない、あれば自由記述だけで作る。
function attachedButNonePicked() {
  return sheetImport?.status === "ready" && !pickedSheetItems().length;
}
function draftBlocked(job = draftJob()) {
  const topic = draftTopic.trim();
  if (hearingDraft?.status === "loading") return true;
  if (attachedButNonePicked() && !topic) return true;
  return !job && !topic && !pickedSheetItems().length;
}
function draftNote() {
  if (!attachedButNonePicked()) return "";
  return draftTopic.trim()
    ? "添付したファイルの項目を1つも選んでいないので、添付は使わず「話したいこと・聞きたいこと」の欄だけから作ります。"
    : "添付したファイルの項目を1つ以上選んでください（または「話したいこと・聞きたいこと」の欄に書いてください）。";
}
function pickedSheetItems() {
  return sheetImport?.status === "ready"
    ? sheetImport.items
        .filter((i) => i.checked)
        .map((i) => ({ label: i.label, hint: i.hint }))
    : [];
}
async function attachSheet(file) {
  if (!file) return;
  sheetParsed = null;
  sheetImport = { status: "reading", fileName: file.name };
  renderSheetImport();
  try {
    const parsed = await readSheetFile(file);
    sheetParsed = parsed;
    const names = parsed.sheets.map((s) => s.name);
    sheetImport = {
      status: "ready",
      fileName: file.name,
      sheets: names,
      chosen: names,
      truncated: parsed.truncated,
      mapping: {},
      items: [],
    };
    analyzeImport();
  } catch (e) {
    sheetImport = {
      status: "failed",
      fileName: file.name,
      error: e.message || "読み取れませんでした",
    };
  }
  renderSheetImport();
}
function draftMarkup() {
  const d = hearingDraft;
  if (!d) return "";
  if (d.status === "loading")
    return `<div class="draft-box" role="status"><span class="u079-spin">${icon("spinner", 16)}</span> 「${esc(d.label)}」の項目を作っています…</div>`;
  if (d.status === "failed")
    return `<p class="error-text draft-error" role="alert">項目を作れませんでした（${esc(d.error)}）。今の項目（${cfg.hearing.length} 問）はそのままです。</p>`;
  const picked = d.selected.filter(Boolean).length;
  return `<div class="draft-box" role="group" aria-labelledby="draft-title"><div class="row between draft-head"><strong id="draft-title">「${esc(d.label)}」の項目案 ${d.questions.length} 問</strong><button class="link" data-action="draftAll">${picked === d.questions.length ? "全部外す" : "全部選ぶ"}</button></div><div class="draft-list">${d.questions.map((q, i) => `<div class="draft-item draft-edit"><input type="checkbox" data-draft-index="${i}" aria-label="${i + 1} 問目を入れる" ${d.selected[i] ? "checked" : ""}><div class="draft-edit-body"><textarea class="draft-text" rows="2" data-draft-text="${i}" aria-label="${i + 1} 問目の文（直せます）">${esc(q)}</textarea><small class="edit-count draft-len" data-draft-len="${i}">${draftLen(q)}</small></div><button class="icon quiet draft-remove" data-action="draftRemove" data-index="${i}" aria-label="${i + 1} 問目を消す" title="消す">${icon("cross", 14)}</button></div>`).join("")}</div><div id="draft-meta">${draftMetaMarkup(d)}</div></div>`;
}
function draftLen(q) {
  const n = [...String(q).trim()].length;
  return n > HEARING_SOFT_CHARS ? `<span class="long">${n} 字・長め</span>` : "";
}
// 案の下の「追加できる数」とボタン。文を直している間はここだけ差し替え、入力欄は作り直さない。
function draftMetaMarkup(d = hearingDraft) {
  const picked = draftPlan(d).picked.length,
    plan = draftPlan(d);
  const capacity = !picked
    ? ""
    : plan.room === 0
      ? `今日の項目は ${LIST_MAX} 問で満杯のため追加できません。一覧で整理するか、置き換えてください。`
      : !plan.fresh.length
        ? "選んだ問はすべて今の項目にあります。"
        : `あと ${plan.room} 問追加できます。${plan.left.length ? `選んだうち ${plan.left.length} 問は入りきらないので、案に残します。` : ""}${plan.duplicate ? `今の項目と同じ ${plan.duplicate} 問は足しません。` : ""}`;
  return `${capacity ? `<p class="small draft-capacity" id="draft-capacity" role="status">${esc(capacity)}</p>` : ""}<div class="row draft-actions"><button class="primary" data-action="draftApply" data-mode="append" ${plan.add.length ? "" : "disabled"}>${plan.add.length ? `<span id="draft-count">${plan.add.length}</span> 問を追加` : "追加できません"}</button><button data-action="draftApply" data-mode="replace" ${picked ? "" : "disabled"}>選んだ ${Math.min(picked, LIST_MAX)} 問で置き換える</button><button class="link" data-action="draftCancel">やめる</button></div><small>文はその場で直せます。追加は今の ${cfg.hearing.length} 問の後ろに足します。置き換えると今の項目は消えます。</small>`;
}
// 「追加」で実際に入る数（重複を除き、上限 LIST_MAX までの空き）を出す。表示と登録で同じ計算を使う。
function draftPlan(d = hearingDraft) {
  const picked = d.questions
    .map((q) => String(q).trim())
    .filter((q, i) => d.selected[i] && q);
  const fresh = [...new Set(picked)].filter((q) => !cfg.hearing.includes(q));
  const room = Math.max(0, LIST_MAX - cfg.hearing.length);
  return {
    picked,
    fresh,
    room,
    add: fresh.slice(0, room),
    left: fresh.slice(room),
    duplicate: picked.length - fresh.length,
  };
}
function draftJob() {
  return (
    app.querySelector('[data-field="job"]')?.value ?? (cfg.job || "")
  ).trim();
}
function updateDraftButton() {
  savePrep();
  if ($("draft-hearing")) $("draft-hearing").disabled = draftBlocked();
  if ($("draft-note")) $("draft-note").textContent = draftNote();
  const clear = app.querySelector(".draft-topic-clear");
  if (clear) clear.hidden = !draftTopic;
}
function renderDraft() {
  if ($("draft-area")) $("draft-area").innerHTML = draftMarkup();
  updateDraftButton();
}
// 書きかけの「話したいこと」と、まだ入れていない案は、パネルを閉じても Chrome を終了するまで残す
// （chrome.storage.session はメモリだけでディスクに書かない）。添付の中身は残さない。
let prepTimer = null;
function savePrep() {
  if (fixture) return;
  clearTimeout(prepTimer);
  prepTimer = setTimeout(() => {
    const d = hearingDraft?.status === "ready" ? hearingDraft : null;
    chrome.storage?.session
      ?.set({
        prep: {
          topic: draftTopic,
          draft: d
            ? { label: d.label, questions: d.questions, selected: d.selected }
            : null,
        },
      })
      .catch(() => {});
  }, 300);
}
async function restorePrep() {
  try {
    const { prep } = (await chrome.storage?.session?.get("prep")) || {};
    if (!prep) return;
    draftTopic = typeof prep.topic === "string" ? prep.topic : "";
    const d = prep.draft;
    if (
      d &&
      Array.isArray(d.questions) &&
      Array.isArray(d.selected) &&
      d.questions.length === d.selected.length &&
      d.questions.length <= LIST_MAX * 2
    )
      hearingDraft = {
        status: "ready",
        label: String(d.label || "項目案"),
        questions: d.questions.map(String),
        selected: d.selected.map(Boolean),
      };
  } catch {
    /* 残せなくても準備はできる */
  }
}
async function saveWizardProfile() {
  const patch = {};
  app
    .querySelectorAll("[data-field]")
    .forEach((el) => (patch[el.dataset.field] = el.value));
  if ($("intro-editor")) {
    patch.intro = $("intro-editor").value;
    patch.introEdited = true;
  } else if (!cfg.introEdited)
    patch.intro = defaultIntro(patch.name, patch.need);
  await save(patch);
}
function openSheet() {
  if (sheetClose) return closeSheet();
  renderSheet();
  sheetClose = showSheet($("sheet"), $("hearing"), $("lower"));
  $("meeting").classList.add("sheet-open");
  $("captions").scrollTop = $("captions").scrollHeight;
}
function dialog(title, body, buttons, locked = false) {
  document.querySelector("dialog")?.remove();
  const el = document.createElement("dialog");
  el.className = "u269 ux";
  el.setAttribute("aria-labelledby", "dialog-title");
  el.setAttribute("aria-describedby", "dialog-description");
  el.setAttribute("role", "alertdialog");
  el.innerHTML = `<h2 id="dialog-title">${title}</h2><p id="dialog-description">${body}</p><div class="row">${buttons}</div>`;
  app.append(el);
  openDialog(el, document.activeElement, locked);
  return el;
}
function showKeyDialog() {
  dialog(
    `<span class="error-circle">${icon("cross", 16)}</span> API キーが無効です（401）。`,
    "設定で確かめてください。",
    '<button class="primary" data-action="keySettings" autofocus>設定を開く</button>',
    true,
  );
}
function renderWizard() {
  disposeMenu();
  view = "onboarding";
  const head = `<header class="screen-head wizard-head"><strong>フキダシの初回設定</strong><span class="steps">${[1, 2, 3].map((n) => `<i class="${n <= step ? "on" : ""}"></i>`).join("")}<span>${step} / 3</span></span></header>`;
  let body = "";
  if (step === 1)
    body = `<h1>フキダシへようこそ</h1><div class="flow"><span><i class="flow-icon sound">${icon("talk", 18)}</i>相手の声</span><span>→</span><strong><i class="flow-icon">${icon("caption", 16)}</i>字幕で読む</strong><span><i class="flow-icon">${icon("keyboard", 16)}</i>あなたの文</span><span>→</span><strong><i class="flow-icon voice">${icon("speaker", 18)}</i>AI の声で届く</strong></div><p>相手の声を文字にし、あなたの文を AI の声で相手に届けます。動かすには OpenAI の API キーが必要です。</p><div class="key-group"><div class="row between key-heading"><strong>OpenAI の API キー</strong><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">キーの取り方（3 分）</a></div>${keyField("api-key", "sk-…")}<p id="key-error" class="error-text" role="alert" hidden></p></div><p class="privacy icon-note">${icon("lock", 15)}<span>キーはこのパソコンの Chrome の中にだけ保存し、OpenAI への通信にだけ使います。会議のページには渡しません。</span></p><p class="privacy icon-note">${icon("info", 15)}<span>相手の声は文字にするために OpenAI に送られます。OpenAI は API 経由の音声・文章を、利用者が明示的に共有しない限り学習に使わないと公表しています。<a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">くわしく</a></span></p>`;
  if (step === 2)
    body = `<h1>あなたのこと</h1>${field("name", "名前（相手に伝える呼び方）", cfg.name, "例：山田")}${field("job", "仕事", cfg.job, "例：Web デザイナー")}${field("about", "補足（任意・1〜2 行）", cfg.about, "例）女性向けのやわらかいデザインが得意", true)}<small>返事の候補づくりに使います。会議ごとの議題は、会議の開始前の画面で入れます。</small><button class="link lists-link" data-action="openLists" data-tab="hearing">${icon("list", 14)} 今日の項目（聞くこと）を見る・直す（今 ${cfg.hearing.length} 問）›</button>${needField()}<div class="intro-box"><div class="row between"><strong>はじめの一言</strong><button class="link" data-action="editIntro">${icon("edit", 14)} 編集</button></div>
<small>名前と伝え方から自動で組んでいます</small><div class="intro-preview" id="intro-preview">${esc(cfg.intro)}</div>
</div>`;
  if (step === 3)
    body = `<h1>あなたの代わりに話す声</h1><div class="voice-card"><div class="row between"><strong id="chosen-voice"><span class="voice-avatar">${icon("speaker", 20)}</span>${esc(cfg.voice)} <small>（既定）</small></strong><button class="selected-voice" data-action="chooseCurrent" aria-pressed="true">${icon("check", 14)} この声にする</button></div><p>落ち着いた、やわらかい声。デイトラが聞いて選びました</p><button data-action="preview">${icon("speaker", 16)} サンプルをこのパソコンで鳴らす</button><button data-action="downloadVoice">${icon("download", 16)} サンプルを音声ファイルで保存 <small>.wav</small></button></div><p class="privacy voice-note">${icon("info", 15)} あなた自身は聞けなくても大丈夫です。そのまま使えます。別の声にしたいときは、身近な人にサンプルを聞いてもらって選んでください。</p><button class="link voice-link" data-action="voices">ほかの声を見る ›</button><div id="voices" class="voice-options" hidden></div>
<div class="stack warm-bottom"><div class="row between"><small>よく使う言葉の声を準備しています…</small><small id="warm-count"></small></div>
<div class="progress" role="progressbar" aria-label="よく使う言葉の準備" id="warm-progress"><i></i></div>
<small>終わらなくても次へ進めます。</small></div>`;
  app.innerHTML = `<div class="fullscreen wizard">${head}<div class="screen-body">${body}</div>
<footer class="screen-footer">${step > 1 ? '<button data-action="wizardSkip">あとで</button>' : ""}<button class="primary" data-action="wizardNext" id="wizard-next">${step === 1 ? "確認して次へ" : step === 2 ? "次へ" : "はじめる"}</button></footer>
</div>`;
  if (step === 1) $("api-key").focus();
  if (step === 2) {
    app.querySelectorAll("[data-field]").forEach((el) =>
      el.addEventListener("input", () => {
        if (
          ["name", "need"].includes(el.dataset.field) &&
          !cfg.introEdited &&
          !$("intro-editor")
        )
          $("intro-preview").textContent = defaultIntro(
            app.querySelector('[data-field="name"]').value,
            app.querySelector('[data-field="need"]').value,
          );
      }),
    );
  }
  if (step === 3) updateWarm();
}
function keyField(id, placeholder) {
  return `<div class="key-input"><input id="${id}" type="password" autocomplete="off" spellcheck="false" placeholder="${placeholder}" aria-label="OpenAI の API キー" ${id === "api-key" ? 'aria-describedby="key-error"' : ""}><button class="icon quiet" data-action="toggleKey" data-target="${id}" aria-label="キーを表示" aria-pressed="false">${icon("eye", 17)}</button></div>`;
}
// はじめの一言で相手に伝える理由（耳・声・どちらも・伝えない）
function needField() {
  return `<label class="field">会議での伝え方<select data-field="need">${NEEDS.map(([value, text]) => `<option value="${value}" ${cfg.need === value ? "selected" : ""}>${text}</option>`).join("")}</select></label><small>はじめの一言で、相手にどう伝えるかを選びます。${cfg.introEdited ? "はじめの一言を自分で直している間は、文は変わりません。" : ""}</small>`;
}
function field(key, label, value, placeholder = "", multi = false) {
  return `<label class="field">${esc(label)}${multi ? `<textarea data-field="${key}" rows="2" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input data-field="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}">`}</label>`;
}
let voiceBack = "settings";
function renderVoices() {
  disposeMenu();
  view = "voices";
  const options = (v) =>
    VOICES.map(
      (x) => `<option ${x === v ? "selected" : ""}>${x}</option>`,
    ).join("");
  app.innerHTML = `<div class="fullscreen settings voice-screen">
    <header class="screen-head"><button class="icon quiet" id="voice-back" aria-label="戻る">${icon("back")}</button><strong>声の選択</strong></header>    <div class="screen-body"><p>声はあなたの代わりに相手に届きます。あなた自身が聞けなくても、既定の声でそのまま使えます。選び直したいときは、身近な人に 2〜3 本聞いてもらうのがおすすめです。</p>      <section class="voice-compare"><small>聞き比べ用の文（どの声も同じ）</small><p>はじめまして。本日はお時間をいただき、ありがとうございます。</p>        <div class="row"><select id="voice-first" aria-label="1 本目の声">${options("marin")}</select> → <select id="voice-second" aria-label="2 本目の声">${options("cedar")}</select><button class="primary" id="compare-two">${icon("speaker", 14)} 2 本を続けて鳴らす</button></div>        <button id="preview-stop" class="link">サンプルを止める</button>      </section>      <div class="voice-list">${VOICES.map((v) => voiceChoice(v)).join("")}</div>
      <p class="privacy">声を変えると、よく使う言葉の声を作り直します。会議中に変えたときは、次の開始から反映します。</p>
    </div>
</div>`;

  $("voice-back").onclick = () =>
    voiceBack === "onboarding" ? renderWizard() : renderSettings();
  let stopCompare = false;
  $("preview-stop").onclick = () => {
    stopCompare = true;
    rpc("previewStop").catch((e) => notice(e.message));
  };
  $("compare-two").onclick = async () => {
    const first = $("voice-first").value,
      second = $("voice-second").value;
    stopCompare = false;
    $("compare-two").disabled = true;
    try {
      await rpc("preview", { voice: first });
      if (!stopCompare) await rpc("preview", { voice: second });
    } catch (e) {
      notice(e.message);
    } finally {
      if ($("compare-two")) $("compare-two").disabled = false;
    }
  };
  app.querySelectorAll("[data-select-voice]").forEach(
    (button) =>
      (button.onclick = async () => {
        try {
          await save({ voice: button.dataset.selectVoice });
          renderVoices();
        } catch (e) {
          notice(e.message);
        }
      }),
  );
}
function voiceChoice(v) {
  const selected = v === cfg.voice;
  return `<article class="voice-choice ${selected ? "selected" : ""}"><div class="voice-description"><strong>${v}${v === "marin" ? " <small>既定</small>" : ""}</strong><small>${v === "marin" ? "落ち着いた、やわらかい声。デイトラが聞いて選びました" : "（説明準備中）"}</small></div>    ${selected ? `<span class="voice-selected">${icon("check", 14)} 選択中</span>` : ""}    <div class="voice-actions"><button data-action="preview" data-voice="${v}">${icon("speaker", 12)} 鳴らす</button>${selected ? `<button data-action="downloadVoice" data-voice="${v}">${icon("download", 12)} ファイルで保存 <small>.wav</small></button>` : `<button class="outline" data-select-voice="${v}">この声にする</button>`}</div>
</article>`;
}
function updateWarm() {
  const w = state?.warm || { done: 0, total: 0 };
  if ($("settings-warm"))
    $("settings-warm").textContent =
      `声を作り置きしています ${w.done} / ${w.total}`;
  if (!$("warm-count")) return;
  $("warm-count").textContent = `${w.done} / ${w.total}`;
  const p = $("warm-progress");
  p.setAttribute("aria-valuemin", "0");
  p.setAttribute("aria-valuemax", String(w.total));
  p.setAttribute("aria-valuenow", String(w.done));
  p.firstElementChild.style.width =
    (w.total ? (w.done / w.total) * 100 : 0) + "%";
}
async function wizardNext(skip = false) {
  const button = $("wizard-next");
  if (button) button.disabled = true;
  try {
    if (step === 1) {
      const apiKey = $("api-key").value.trim();
      if (!apiKey) throw new Error("API キーを入力してください");
      await rpc("verifyKey", { apiKey });
      keyVerified = true;
      await save({ apiKey });
      $("api-key").value = "";
      step = 2;
      renderWizard();
    } else if (step === 2) {
      if (!skip) await saveWizardProfile();
      step = 3;
      renderWizard();
      rpc("prewarm").catch((e) => notice(e.message));
    } else {
      await save({ onboarded: true });
      renderMeeting();
    }
  } catch (e) {
    if (step === 1) {
      $("key-error").hidden = false;
      $("key-error").textContent = e.message;
      $("api-key").setAttribute("aria-invalid", "true");
      button.textContent = "もう一度確かめる";
      $("api-key").focus();
    } else notice(e.message);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}
function switchRow(key, label, note = "") {
  return `<div class="setting-row"><div><label id="label-${key}">${label}</label>${note ? `<small>${note}</small>` : ""}</div>
<button class="u013" role="switch" aria-checked="${cfg[key]}" aria-labelledby="label-${key}" data-switch="${key}"></button></div>`;
}
function rangeRow(key, label, min, max, unit = "") {
  return `<label class="field">${label}<div class="row"><input class="u017" type="range" min="${min}" max="${max}" step="1" value="${cfg[key]}" data-range="${key}" data-unit="${unit}"><output style="min-width:32px"></output>${unit}</div>
</label>`;
}
function selectRow(key, label, options) {
  return `<label class="setting-row"><span>${label}</span><select data-field="${key}">${options.map(([value, text]) => `<option value="${value}" ${cfg[key] === value ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
}
function renderSettings() {
  disposeMenu();
  view = "settings";
  closeSheet();
  menuControl?.hide();
  app.innerHTML = `<div class="fullscreen settings"><header class="screen-head"><button class="icon quiet" data-action="back" aria-label="会話に戻る">${icon("back")}</button><strong>設定</strong><span class="autosave" id="autosave">変更はすぐに保存されます</span></header>    <div class="screen-body">      <section><h2>API キー</h2><div class="row">${keyField("settings-key", cfg.hasKey ? "••••••••（変更時のみ入力）" : "sk-…")}<button data-action="replaceKey">接続を確かめる</button></div><small id="key-result">${keyVerified || state.sttState === "ready" ? "✓ 接続できました" : cfg.hasKey ? "設定済み・この接続は未確認" : "未設定"} ・キーの変更は次の開始から反映（無効なキーの修正はすぐ反映）</small></section>      <section><h2>あなたのこと</h2><div class="profile-row">${field("name", "名前", cfg.name)}${field("job", "仕事", cfg.job)}</div>${field("about", "補足", cfg.about, "例）女性向けのやわらかいデザインが得意")}${needField()}${field("intro", "はじめの一言（読み上げ）", cfg.intro, "", true)}</section>      <section><div class="row between"><h2>声</h2><small>声の変更は次の開始から反映</small></div><div class="row between"><strong>${esc(cfg.voice)}</strong><button data-action="preview">${icon("speaker", 14)} サンプルを鳴らす</button><button class="link" data-action="voices">ほかの声を見る ›</button></div>${field("style", "話し方", cfg.style)}</section>      <section><h2>返事</h2>${selectRow(
    "prefetchCandidates",
    "候補の先読み（すぐ声が出る候補の数）",
    [0, 1, 2, 3].map((n) => [n, n]),
  )}<small>多いほどすぐ声が出ますが、利用量も増えます。</small><div class="filler-setting">${selectRow(
    "autoFillerSec",
    "つなぎを自動で送るまで",
    [4, 5, 6, 7, 8, 9, 10].map((n) => [n, n + " 秒"]),
  )}${switchRow("autoFiller", "つなぎを自動で送る")}</div>${switchRow("autoStopOnBargeIn", "相手が話し始めたら自動で止める")}${selectRow(
    "enterToSpeak",
    "Enter の扱い",
    [
      [true, "Enter で送る"],
      [false, "Ctrl / ⌘+Enter で送る"],
    ],
  )}<small>Shift+Enter で改行</small></section>      <section><div class="row between"><h2>よく使う言葉</h2><small id="settings-warm"></small></div><div class="quick-settings"><span></span><small>相づちのラベル</small><small>読み上げる文</small>${cfg.quick.map((q, i) => `<span class="digit">${i + 4}</span><input aria-label="相づち ${i + 4} のラベル" data-field="quickLabel${i}" value="${esc(q.label)}"><input aria-label="相づち ${i + 4} の読み上げる文" data-field="quickText${i}" value="${esc(q.text)}">`).join("")}</div>${field("phrases", "定型文（1 行に 1 つ・シートの「よく使う」と同じ一覧）", cfg.phrases.join("\n"), "", true)}<button class="link lists-link" data-action="openLists" data-tab="phrases">${icon("list", 14)} 定型文を一覧で編集する ›</button></section>      <section><div class="row between"><h2>今日の項目（聞くこと・確認すること）</h2><button data-action="openLists" data-tab="hearing">${icon("list", 14)} 一覧で編集する</button></div>${field("hearing", "1 行に 1 つ（シートの「今日の項目」と同じ一覧です。ここを直すとシートも変わります）", cfg.hearing.join("\n"), "", true)}<small>会話を始めて声がつながると、今日の項目と定型文の声を合わせて ${WARM_LIST_LIMIT} 件まで（上から順に）先に作っておきます。声を作る分の OpenAI の利用料がかかります（同じ文は作り直しません）。</small></section>      <section><h2>見え方</h2>${switchRow("showSpeakerNames", "話した人の名前を出す", "Google Meet の表示から取得します。分からないときは名前を出しません。名前はまとめ・返事候補にも使います。")}${rangeRow("captionFontPx", "字幕の文字サイズ", 16, 28, "px")}<div class="caption-preview">相手の声がここに文字で出ます。</div><fieldset class="theme-choices"><legend>ダークモード</legend>${[
    ["auto", "自動"],
    ["light", "明"],
    ["dark", "暗"],
  ]
    .map(
      ([v, t]) =>
        `<label><input type="radio" name="theme" data-field="theme" value="${v}" ${cfg.theme === v ? "checked" : ""}>${t}</label>`,
    )
    .join(
      "",
    )}</fieldset>${switchRow("reduceMotion", "画面の動きを止める", "読み込み中の回転や、画面が滑って出る動きを止めます。動きで目が疲れる・酔いやすい方向けです。")}</section>      <section><h2>記録・保存</h2>${selectRow(
    "keepLogDays",
    "このパソコンへの会話の保存",
    [
      [0, "保存しない（既定）"],
      [7, "7 日間だけ保存する"],
    ],
  )}<small>「保存しない」に戻すと、保存済みの記録も削除します。</small><div class="row"><button data-action="savedLogs">保存した記録を見る</button><button data-action="clearLogs">記録を削除</button></div><div id="saved-logs"></div></section>      <details><summary>詳細設定</summary><div>${rangeRow("sensitivity", "声の検出のしきい値（高いほど大きい声のみ）", 0.5, 2)}${selectRow(
    "sttModel",
    "文字起こし",
    [
      ["gpt-live-transcribe", "gpt-live-transcribe（既定）"],
      ["gpt-4o-transcribe", "gpt-4o-transcribe（代替）"],
    ],
  )}${switchRow("sendMic", "本人の実マイクも会議に送る", "既定では送りません")}${switchRow("localMonitor", "会議の音をこのパソコンでも鳴らす", "次の開始から反映")}${switchRow("useLocalMic", "字幕の入力にこのパソコンのマイクを使う", "会議タブの音を取れない場合だけ。次の開始から反映")}<button data-action="permission">マイクの許可画面を開く</button></div>
</details>
      <p class="privacy">フキダシ v1.2・Zoom ブラウザ版はベータ<br>動作部品: Lucian UX/UI Prompt（MIT © 2026 Seokwoooo）</p>
    </div>
</div>`;
  updateWarm();

  app
    .querySelectorAll("[data-switch]")
    .forEach((el) =>
      bindSwitch(el, (value) => changeSetting(el.dataset.switch, value)),
    );
  app.querySelectorAll("[data-range]").forEach((el) => {
    if (el.dataset.range === "sensitivity") el.step = ".1";
    bindRange(el, el.nextElementSibling, (value) =>
      changeSetting(el.dataset.range, value),
    );
  });
  app
    .querySelectorAll("[data-field]")
    .forEach((el) =>
      el.addEventListener("change", () =>
        changeSetting(el.dataset.field, el.value),
      ),
    );
}
async function changeSetting(key, value) {
  let patch = {};
  if (key.startsWith("quick")) {
    const list = structuredClone(cfg.quick),
      i = Number(key.slice(-1));
    list[i][key.startsWith("quickLabel") ? "label" : "text"] = value;
    patch.quick = list;
  } else if (["phrases", "hearing"].includes(key))
    patch[key] = value
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  else
    patch[key] = [
      "keepLogDays",
      "prefetchCandidates",
      "autoFillerSec",
    ].includes(key)
      ? Number(value)
      : key === "enterToSpeak"
        ? value === "true"
        : value;
  if (key === "intro") patch.introEdited = true;
  if (key === "name" && !cfg.introEdited)
    patch.intro = defaultIntro(value, cfg.need);
  if (key === "need" && !cfg.introEdited)
    patch.intro = defaultIntro(cfg.name, value);
  try {
    if ($("autosave")) $("autosave").textContent = "保存中…";
    await save(patch);
    const introField = app.querySelector('[data-field="intro"]');
    if (key !== "intro" && patch.intro && introField)
      introField.value = patch.intro;
    if ($("autosave")) $("autosave").textContent = "保存しました";
  } catch (e) {
    if ($("autosave")) $("autosave").textContent = "保存できませんでした";
    notice(e.message);
  }
}
function fullText() {
  return (state.lines || [])
    .filter((l) => !l.failed && !l.partial)
    .map(
      (l) =>
        `${new Date(l.at).toLocaleTimeString("ja-JP")} ${lineSpeaker(l, cfg.showSpeakerNames)}: ${l.text || "（読み上げ範囲は未確認）"}${l.interrupted ? "（途中で止めました）" : ""}${l.mismatch ? "\n※入力と異なる読み上げ。入力: " + l.requested : ""}`,
    )
    .join("\n\n");
}
function markdown() {
  const s = state.summary;
  return `# ヒアリングまとめ\n\n${new Date(state.startedAt || Date.now()).toLocaleString("ja-JP")}\n\n${s ? s.items.map((i) => `## ${i.question}\n\n${i.answer}`).join("\n\n") + "\n\n## そのほかに出た話\n\n" + s.other.map((t) => "- " + t).join("\n") + "\n\n## 次にやること\n\n" + s.todo.map((t) => "- [ ] " + t).join("\n") : "まとめは未作成"}\n\n## 会話の全文\n\n${fullText()}\n`;
}
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function renderSummary() {
  disposeMenu();
  view = "summary";
  closeSheet();
  summarySignature = "";
  app.innerHTML = `<div class="fullscreen summary"><header class="screen-head"><div><h1>ヒアリングまとめ</h1><small>${esc(summaryPeriod(state.startedAt, state.endedAt))}</small></div>
<button data-action="closeSummary">閉じる</button></header>
<div class="screen-body" id="summary-body"></div>
<footer class="screen-footer"><button class="primary" data-action="copySummary" id="copy-summary">${icon("copy", 16)} Markdown をコピー</button><div class="row"><button data-action="saveSummary">${icon("download", 16)} ファイルに保存</button><button data-action="fullText">${icon("chevron", 16)} 会話の全文を見る</button></div>
<p class="privacy">${cfg.keepLogDays === 0 ? "会話の記録はこのパソコンに保存していません。閉じると消えます。" : "会話の記録はこのパソコンに 7 日間保存します。"}</p><small id="usage"></small></footer>
</div>`;
  updateSummary();
}
function updateSummary() {
  if (!$("summary-body") || summarySignature === "fulltext") return;
  const key = JSON.stringify([
    state.summary,
    state.summaryState,
    Date.now() - state.summaryStarted > 5000,
  ]);
  if (key !== summarySignature) {
    summarySignature = key;
    const body = $("summary-body");
    if (state.summaryState === "loading")
      body.innerHTML = `<div class="loading stack" role="status"><span class="u079-spin">${icon("spinner", 30)}</span><strong>会話をまとめています…</strong><small>${Date.now() - state.summaryStarted > 5000 ? "少し時間がかかっています。会話の全文は保存できます。" : "会話に出てきた内容を整理しています"}</small></div>`;
    else if (state.summaryState === "failed")
      body.innerHTML = `<div class="empty u092">${icon("warn", 36)}<p>まとめを作れませんでした。会話の全文は保存できます。</p><button data-action="summary">もう一度まとめる</button></div>`;
    else if (state.summary) {
      body.innerHTML =
        state.summary.items
          .map(
            (i, n) =>
              `<article class="summary-card"><h3 title="${esc(i.question)}">${esc(summaryHeading(i.question))}</h3><div class="row between"><p class="${i.answer === "未確認" ? "muted" : ""}">${esc(i.answer)}</p>${i.answer === "未確認" ? `<button class="ask-next" data-action="askNext" data-index="${n}">＋ 次回聞く</button>` : ""}</div>
</article>`,
          )
          .join("") +
        `<article class="summary-section"><h3>そのほかに出た話</h3><ul>${state.summary.other.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></article><article class="summary-section todo"><h3>次にやること</h3>${state.summary.todo.map((t) => `<label><input type="checkbox">${esc(t)}</label>`).join("")}</article>`;
    }
  }
  $("copy-summary").disabled = state.summaryState !== "ready";
  const u = state.usage;
  $("usage").textContent =
    `利用量: 文字起こし ${Math.round(u.sttSeconds / 60)} 分・読み上げ ${u.spokenSentences ?? "未確認"} 文・候補 ${u.candidateRequests ?? "未確認"} 回・声の作り置き ${u.warmVoices ?? 0} 件`;
}
async function handle(action, button) {
  try {
    switch (action) {
      case "say":
        return speakInput();
      case "retryLine": {
        const l = state.lines.find((x) => x.id === button.dataset.id);
        if (l) await rpc("say", { text: l.requested, kind: "retry" });
        break;
      }
      case "fixLine": {
        const line = state.lines.find((x) => x.id === button.dataset.id);
        draft = line?.requested || "";
        $("input").value = draft;
        $("input").focus();
        break;
      }
      case "reloadHelp":
        reloadHelp = !reloadHelp;
        $("bands").dataset.signature = "";
        updateMeeting();
        break;
      case "toggleKey": {
        const input = $(button.dataset.target);
        const reveal = input.type === "password";
        input.type = reveal ? "text" : "password";
        button.setAttribute("aria-label", reveal ? "キーを隠す" : "キーを表示");
        button.setAttribute("aria-pressed", String(reveal));
        break;
      }
      case "askNext": {
        const question =
          state.summary.items[Number(button.dataset.index)].question;
        if (!cfg.hearing.includes(question))
          await save({ hearing: [...cfg.hearing, question] });
        await rpc("hearing", {
          index: cfg.hearing.indexOf(question),
          value: false,
        });
        button.textContent = "✓ 次回聞きます";
        notice("ヒアリングに残しました");
        break;
      }
      case "candidate":
        if (await rpc("pickCandidate", { index: Number(button.dataset.index) }))
          $("input").focus();
        break;
      case "editCandidate": {
        draft = state.candidates[Number(button.dataset.index)]?.text || "";
        $("input").value = draft;
        $("input").focus();
        break;
      }
      case "quick":
        if (await rpc("quick", { index: Number(button.dataset.index) }))
          $("input").focus();
        break;
      case "intro":
        if (await rpc("intro")) $("input").focus();
        break;
      case "settings":
        renderSettings();
        break;
      case "keySettings":
        document.querySelector("dialog")?.close();
        renderSettings();
        $("settings-key").focus();
        break;
      case "back":
        state.ended && state.summaryState !== "idle"
          ? renderSummary()
          : renderMeeting();
        break;
      case "confirmStop":
        menuControl?.hide();
        dialog(
          "会話を停止しますか？",
          "字幕と声の接続を切ります。",
          '<button data-action="cancelDialog" autofocus>続ける</button><button class="danger fill" data-action="stop">停止</button>',
        );
        break;
      case "cancelDialog":
        document.querySelector("dialog")?.close();
        break;
      case "stop":
        document.querySelector("dialog")?.close();
        view = "summary";
        renderSummary();
        rpc("stop").catch((e) => notice(e.message));
        break;
      case "stopSpeaking":
        await rpc("stopSpeaking");
        break;
      case "regenerate":
        await rpc("regenerate");
        break;
      case "start":
        await rpc("start");
        break;
      case "reconnect":
        await rpc("reconnect");
        break;
      case "latest":
        nearBottom = true;
        followCaptions();
        break;
      case "sheet":
        openSheet();
        break;
      case "closeSheet":
        closeSheet();
        break;
      case "sheetTab":
        if (sheetEdit && !(await flushEditor())) break;
        sheetTab = button.dataset.tab;
        renderSheet();
        $("tab-" + sheetTab).focus();
        break;
      case "sheetEdit":
        if (sheetEdit && !(await flushEditor())) break;
        sheetEdit = !sheetEdit;
        renderSheet();
        (sheetEdit
          ? app.querySelector("[data-edit-index]") || $("list-add")
          : app.querySelector(".sheet-settings")
        )?.focus();
        break;
      case "openLists":
        if (view === "onboarding") {
          await saveWizardProfile();
          listsBack = "onboarding";
        } else if (view === "meeting") listsBack = "meeting";
        else if (view !== "lists") listsBack = "settings";
        renderLists(button.dataset.tab || "hearing");
        app.querySelector("[data-edit-index]")?.focus();
        break;
      case "listsTab":
        if (!(await flushEditor())) break;
        renderLists(button.dataset.tab);
        $("lists-tab-" + listsTab).focus();
        break;
      case "listsBack":
        if (!(await flushEditor())) break;
        listsBack === "onboarding"
          ? renderWizard()
          : listsBack === "meeting"
            ? renderMeeting()
            : renderSettings();
        break;
      case "listRetry": {
        const root = button.closest("[data-list]");
        if (await flushEditor()) {
          rerenderEditor(null);
          notice(`${listName(root.dataset.list)}を保存しました`);
        }
        break;
      }
      case "listMove":
      case "listDelete":
      case "listAdd": {
        const root = button.closest("[data-list]"),
          tab = root.dataset.list,
          values = editorValues(root),
          i = Number(button.dataset.index);
        let focus;
        if (action === "listMove") {
          const j = i + Number(button.dataset.dir);
          if (j < 0 || j >= values.length) break;
          [values[i], values[j]] = [values[j], values[i]];
          focus = `[data-action="listMove"][data-index="${j}"][data-dir="${button.dataset.dir}"]`;
        } else if (action === "listDelete") {
          values.splice(i, 1);
          focus = values.length
            ? `[data-edit-index="${Math.min(i, values.length - 1)}"]`
            : "#list-add";
        } else {
          const text = $("list-add").value.trim();
          if (!text) {
            $("list-add").focus();
            break;
          }
          if (values.filter(Boolean).length >= LIST_MAX)
            throw new Error(`${LIST_MAX} 件までです`);
          values.push(text);
          focus = "#list-add";
        }
        await saveList(tab, values);
        rerenderEditor(focus);
        if (action === "listDelete") notice("1 件削除しました");
        if (action === "listAdd") notice(`${listName(tab)}に追加しました`);
        break;
      }
      case "draftHearing": {
        const job = draftJob(),
          about = (
            app.querySelector('[data-field="about"]')?.value ??
            (cfg.about || "")
          ).trim(),
          topic = draftTopic.trim(),
          sheetItems = pickedSheetItems();
        if (attachedButNonePicked() && !topic)
          throw new Error("添付したファイルの項目を1つ以上選んでください");
        if (!job && !topic && !sheetItems.length)
          throw new Error("設定の「仕事」か、話したいこと・聞きたいことを入力してください");
        const label = sheetItems.length
          ? `添付「${sheetImport.fileName}」`
          : topic
            ? "今日の項目"
            : "初回ヒアリング";
        hearingDraft = { status: "loading", label };
        renderDraft();
        try {
          const questions = await rpc("draftHearing", {
            job,
            about,
            topic,
            ...(sheetItems.length ? { sheetItems } : {}),
          });
          hearingDraft = {
            status: "ready",
            label,
            questions,
            selected: questions.map(() => true),
          };
        } catch (e) {
          hearingDraft = { status: "failed", label, error: e.message };
          notice("項目を作れませんでした。今の項目はそのままです");
        }
        renderDraft();
        break;
      }
      case "draftAll": {
        const all = hearingDraft.selected.every(Boolean);
        hearingDraft.selected = hearingDraft.selected.map(() => !all);
        renderDraft();
        break;
      }
      case "sheetPick":
        $("sheet-file")?.click();
        break;
      case "draftTopicClear":
        draftTopic = "";
        if ($("draft-topic")) $("draft-topic").value = "";
        updateDraftButton();
        $("draft-topic")?.focus();
        break;
      case "sheetMap": {
        const box = button.closest("[data-map-key]");
        const answer = box.querySelector('[data-map-role="answer"]').value;
        sheetImport.mapping = {
          ...(sheetImport.mapping || {}),
          [button.dataset.key]: {
            label: Number(box.querySelector('[data-map-role="label"]').value),
            answer: answer === "" ? null : Number(answer),
          },
        };
        analyzeImport();
        renderSheetImport();
        break;
      }
      case "sheetClear":
        sheetImport = sheetParsed = null;
        if ($("sheet-file")) $("sheet-file").value = "";
        renderSheetImport();
        $("sheet-pick")?.focus();
        break;
      case "draftOwn": {
        const input = $("draft-own"),
          text = (input?.value || "").trim();
        if (!text) {
          input?.focus();
          break;
        }
        if (hearingDraft?.status === "loading") {
          notice("項目を作り終わってから足してください");
          break;
        }
        if (hearingDraft?.status === "ready") {
          hearingDraft.questions.push(text);
          hearingDraft.selected.push(true);
        } else
          hearingDraft = {
            status: "ready",
            label: "自分で書いた質問",
            questions: [text],
            selected: [true],
          };
        input.value = "";
        renderDraft();
        $("draft-own")?.focus();
        break;
      }
      case "draftRemove": {
        const i = Number(button.dataset.index);
        if (hearingDraft?.status !== "ready") break;
        hearingDraft.questions.splice(i, 1);
        hearingDraft.selected.splice(i, 1);
        if (!hearingDraft.questions.length) hearingDraft = null;
        renderDraft();
        (app.querySelector(`[data-draft-text="${Math.max(0, i - 1)}"]`) || $("draft-own"))?.focus();
        break;
      }
      case "draftCancel":
        hearingDraft = null;
        renderDraft();
        $("draft-hearing")?.focus();
        break;
      case "draftApply": {
        const d = hearingDraft;
        const replace = button.dataset.mode === "replace";
        const plan = draftPlan(d);
        const adding = replace ? [...new Set(plan.picked)].slice(0, LIST_MAX) : plan.add;
        if (!adding.length) break;
        if (view === "onboarding") {
          await saveWizardProfile();
          listsBack = "onboarding";
        } else if (view !== "lists" && view !== "meeting") listsBack = "settings";
        const before = cfg.hearing.length;
        await save({ hearing: replace ? adding : [...cfg.hearing, ...adding] });
        const left = replace ? [] : plan.left;
        if (left.length) {
          // 入りきらなかった案は消さずに残す（今日話したいこと・添付もそのまま）。
          hearingDraft = { ...d, questions: left, selected: left.map(() => true) };
        } else {
          hearingDraft = null;
          draftTopic = "";
          if ($("draft-topic")) $("draft-topic").value = "";
          sheetImport = sheetParsed = null; // 添付の中身は保存しない
        }
        if (view === "meeting") {
          // 開始前の画面から入れたときは画面を移らず、欄と案だけ片づける。
          renderDraft();
          renderSheetImport();
          $("draft-topic")?.focus();
          notice(
            (replace
              ? `今日の項目を ${cfg.hearing.length} 問に置き換えました。`
              : `今日の項目に ${cfg.hearing.length - before} 問追加しました。`) +
              (left.length
                ? `入りきらない ${left.length} 問は案に残しています（${LIST_MAX} 問まで）。`
                : "下の一覧ボタンから見られます"),
          );
          break;
        }
        renderLists("hearing");
        app.querySelector("[data-edit-index]")?.focus();
        notice(
          (replace
            ? `今日の項目を ${cfg.hearing.length} 問に置き換えました。`
            : `今日の項目に ${cfg.hearing.length - before} 問追加しました。`) +
            (left.length
              ? `入りきらない ${left.length} 問は案に残しています（${LIST_MAX} 問まで）。`
              : "ここで直せます"),
        );
        break;
      }
      case "sheetSay": {
        const i = Number(button.dataset.index),
          text = (sheetTab === "hearing" ? cfg.hearing : cfg.phrases)[i];
        const accepted = await rpc("sheetSay", { index: i, tab: sheetTab });
        if (accepted) {
          closeSheet();
          $("input").focus();
        }
        break;
      }
      case "chooseCurrent":
        notice("この声で準備しています");
        break;
      case "wizardNext":
        await wizardNext();
        break;
      case "wizardSkip":
        await wizardNext(true);
        break;
      case "editIntro": {
        const node = $("intro-preview");
        node.innerHTML = `<textarea id="intro-editor" rows="6">${esc(cfg.intro)}</textarea>`;
        $("intro-editor").focus();
        $("intro-editor").onchange = () =>
          save({ intro: $("intro-editor").value, introEdited: true }).catch(
            (e) => notice(e.message),
          );
        break;
      }
      case "preview":
      case "compareVoice":
      case "downloadVoice": {
        button.disabled = true;
        const voice =
          action === "compareVoice"
            ? $("compare-" + button.dataset.index).value
            : button.dataset.voice || cfg.voice;
        notice(
          action === "downloadVoice"
            ? "音声ファイルを準備しています…"
            : "このパソコンでサンプルを鳴らします",
        );
        const data = await rpc("preview", {
          voice,
          download: action === "downloadVoice",
        });
        if (action === "downloadVoice")
          download(
            new Uint8Array(data),
            `fukidashi-${voice}.wav`,
            "audio/wav",
          );
        button.disabled = false;
        break;
      }
      case "voices":
        voiceBack = view;
        renderVoices();
        break;
      case "replaceKey": {
        const key = $("settings-key").value.trim();
        if (!key) throw new Error("新しいキーを入力してください");
        await rpc("verifyKey", { apiKey: key });
        await save({ apiKey: key });
        $("settings-key").value = "";
        keyVerified = true;
        $("key-result").textContent =
          "✓ 接続できました ・キー無効からの変更はすぐに反映";
        notice("API キーを変更しました");
        break;
      }
      case "permission":
        await rpc("permission");
        break;
      case "savedLogs": {
        const logs = await rpc("listLogs");
        $("saved-logs").replaceChildren();
        if (!logs.length)
          $("saved-logs").textContent = "保存した記録はありません";
        for (const log of logs) {
          const b = document.createElement("button");
          b.textContent = new Date(log.at).toLocaleString("ja-JP");
          b.onclick = () => {
            archiveBase = state;
            state = {
              ...state,
              lines: log.lines,
              summary: log.summary,
              summaryState: "ready",
              startedAt: log.startedAt,
              endedAt: log.endedAt,
              usage: log.usage || state.usage,
            };
            renderSummary();
          };
          $("saved-logs").append(b);
        }
        break;
      }
      case "clearLogs":
        await rpc("clearLogs");
        notice("保存した記録を削除しました");
        if ($("saved-logs"))
          $("saved-logs").textContent = "保存した記録はありません";
        break;
      case "copySummary":
        await navigator.clipboard.writeText(markdown());
        notice("Markdown をコピーしました");
        break;
      case "saveSummary":
        download(
          markdown(),
          "フキダシ-" + new Date().toISOString().slice(0, 10) + ".md",
          "text/markdown;charset=utf-8",
        );
        break;
      case "fullText":
        $("summary-body").innerHTML =
          `<pre class="transcript-full">${esc(fullText())}</pre>`;
        summarySignature = "fulltext";
        break;
      case "closeSummary":
        if (archiveBase) {
          state = archiveBase;
          archiveBase = null;
          renderSettings();
          break;
        }
        await rpc("forget");
        lastAnnounced.clear();
        renderMeeting();
        break;
      case "summary":
        await rpc("summary");
        break;
      case "moreBands":
        dialog(
          "ほかの案内",
          state.bands
            .slice(2)
            .map((b) => esc(b.text))
            .join("<br><br>"),
          '<button data-action="cancelDialog" autofocus>閉じる</button>',
        );
        break;
    }
  } catch (e) {
    notice(e.message);
    if (button) button.disabled = false;
  }
}
app.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (b && !b.disabled) handle(b.dataset.action, b);
});
app.addEventListener("input", (e) => {
  if (e.target.matches("[data-edit-index]")) {
    const count = e.target.parentElement.querySelector(".edit-count");
    const root = e.target.closest("[data-list]");
    if (count && root)
      count.outerHTML = countMarkup(root.dataset.list, e.target.value.trim());
  }
  if (e.target.id === "draft-topic") draftTopic = e.target.value;
  if (e.target.matches("[data-draft-text]") && hearingDraft?.status === "ready") {
    const i = Number(e.target.dataset.draftText);
    hearingDraft.questions[i] = e.target.value;
    const len = app.querySelector(`[data-draft-len="${i}"]`);
    if (len) len.innerHTML = draftLen(e.target.value);
    if ($("draft-meta")) $("draft-meta").innerHTML = draftMetaMarkup();
    savePrep();
  }
  if (e.target.matches('[data-field="job"], #draft-topic')) updateDraftButton();
});
// タブ（role=tab）の左右・Home・End での移動。一覧の画面とシートで同じ動きにする。
const TAB_KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"];
function nextTab(current, key, tabs) {
  const i = tabs.indexOf(current);
  return key === "Home"
    ? tabs[0]
    : key === "End"
      ? tabs.at(-1)
      : tabs[(i + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
}
app.addEventListener("keydown", (e) => {
  if (e.target.closest?.(".lists-tabs") && TAB_KEYS.includes(e.key)) {
    e.preventDefault();
    const tab = nextTab(listsTab, e.key, ["hearing", "phrases"]);
    flushEditor().then((ok) => {
      if (!ok) return;
      renderLists(tab);
      $("lists-tab-" + tab)?.focus();
    });
    return;
  }
  if (e.target.id === "draft-own" && shouldSendEnter(e)) {
    e.preventDefault();
    handle("draftOwn", app.querySelector('[data-action="draftOwn"]'));
    return;
  }
  if (e.target.id === "list-add" && shouldSendEnter(e)) {
    e.preventDefault();
    const add = app.querySelector('[data-action="listAdd"]');
    if (add && !add.disabled) handle("listAdd", add);
  }
});
app.addEventListener("change", (e) => {
  if (e.target.matches("[data-edit-index]")) {
    const root = e.target.closest("[data-list]");
    if (root)
      saveList(root.dataset.list, editorValues(root)).catch((err) =>
        notice(err.message),
      );
    return;
  }
  if (e.target.id === "sheet-file") {
    attachSheet(e.target.files?.[0]).catch((err) => notice(err.message));
    return;
  }
  if (e.target.matches("[data-sheet-name]") && sheetImport?.sheets) {
    const name = e.target.dataset.sheetName;
    sheetImport.chosen = e.target.checked
      ? [...new Set([...sheetImport.chosen, name])]
      : sheetImport.chosen.filter((n) => n !== name);
    analyzeImport();
    renderSheetImport();
    return;
  }
  if (e.target.matches("[data-sheet-item]") && sheetImport?.items) {
    sheetImport.items[Number(e.target.dataset.sheetItem)].checked =
      e.target.checked;
    renderSheetImport();
    app.querySelector(`[data-sheet-item="${e.target.dataset.sheetItem}"]`)?.focus();
    return;
  }
  if (e.target.matches("[data-draft-index]") && hearingDraft?.selected) {
    const index = e.target.dataset.draftIndex;
    hearingDraft.selected[Number(index)] = e.target.checked;
    renderDraft();
    app.querySelector(`[data-draft-index="${index}"]`)?.focus();
    return;
  }
  if (e.target.matches("[data-hearing]"))
    rpc("hearing", {
      index: Number(e.target.dataset.hearing),
      value: e.target.checked,
    }).catch((err) => notice(err.message));
});
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") {
    if (sheetClose) {
      e.preventDefault();
      closeSheet();
      return;
    }
    if ($("menu") && !$("menu").hidden) {
      menuControl.close();
      return;
    }
    if (view === "meeting") {
      e.preventDefault();
      rpc("stopSpeaking").catch((err) => notice(err.message));
    }
    return;
  }
  if (view !== "meeting") return;
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const digit = /^(?:Digit|Numpad)([0-7])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      if (sheetClose) closeSheet();
      const n = Number(digit[1]);
      rpc(n === 0 ? "intro" : n <= 3 ? "pickCandidate" : "quick", {
        index: n <= 3 ? n - 1 : n - 4,
      }).catch((err) => notice(err.message));
      return;
    }
    if (e.code === "KeyH") {
      e.preventDefault();
      openSheet();
      return;
    }
    if (e.code === "KeyR") {
      e.preventDefault();
      rpc("regenerate").catch((err) => notice(err.message));
      return;
    }
  }
  const editing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if (e.key === "/" && !editing) {
    e.preventDefault();
    $("input").focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
    e.preventDefault();
    nearBottom = true;
    followCaptions();
  } else if (
    e.target === $("input") &&
    !$("input").value &&
    ["ArrowUp", "ArrowDown"].includes(e.key)
  ) {
    e.preventDefault();
    $("captions").scrollBy({ top: (e.key === "ArrowUp" ? -1 : 1) * 100 });
  }
  if (e.key === "Tab" && !sessionStorage.getItem("shortcutTip")) {
    sessionStorage.setItem("shortcutTip", "1");
    $("shortcut-tip").hidden = false;
    setTimeout(() => {
      if ($("shortcut-tip")) $("shortcut-tip").hidden = true;
    }, 5000);
  }
});
/* DEV_START */
const params = new URLSearchParams(location.search);
window.koeTest = {
  rpc,
  state: () => structuredClone(state),
  async fixture(name) {
    fixture = true;
    closeSheet();
    document.querySelector("dialog")?.remove();
    document.activeElement?.blur?.();
    waitingBefore = false;
    lastSpeakingAt = 0;
    draft = "";
    const { makeFixture } = await import("./ui/fixtures.js");
    const f = makeFixture(name);
    hearingDraft = f.hearingDraft ? structuredClone(f.hearingDraft) : null;
    sheetImport = f.sheetImport ? structuredClone(f.sheetImport) : null;
    sheetParsed = null;
    draftTopic = "";
    editBuffer = f.editBuffer ? structuredClone(f.editBuffer) : {};
    cfg = { ...cfg, ...f.state.cfg };
    state = f.state;
    theme();
    view = "";
    step = f.step || 1;
    if (f.view === "onboarding") {
      renderWizard();
      if (f.badKey) {
        $("api-key").value = "dummy-key-proxy-only";
        $("key-error").hidden = false;
        $("key-error").textContent =
          "このキーでは接続できませんでした（401）。キーを確かめてください";
        $("api-key").setAttribute("aria-invalid", "true");
        $("wizard-next").textContent = "もう一度確かめる";
      }
    } else if (f.view === "settings") renderSettings();
    else if (f.view === "lists") {
      listsBack = "settings";
      renderLists(f.listsTab || "hearing");
    }
    else if (f.view === "voices") renderVoices();
    else if (f.view === "summary") {
      renderSummary();
      if (f.scroll) $("summary-body").scrollTop = 280;
    } else {
      renderMeeting();
      if (f.sheet) {
        sheetEdit = !!f.sheetEdit;
        openSheet();
      }
      if (f.menu) {
        $("menu").hidden = false;
        $("menu-trigger").setAttribute("aria-expanded", "true");
      }
      if (f.dialog) handle("confirmStop");
      if (f.dialog && f.menu) {
        $("menu").hidden = false;
        $("menu-trigger").setAttribute("aria-expanded", "true");
      }
      if (f.keyDialog) showKeyDialog();
      if (f.history) {
        nearBottom = false;
        $("captions").scrollTop = 0;
        unreadCaptions = new Set(
          state.lines.slice(-(f.unread || 2)).map((l) => l.id),
        );
        updateLatest();
      }
      if (f.focus) {
        document.querySelectorAll(".candidate")[1]?.focus();
        document.querySelectorAll(".quick")[1]?.classList.add("fixture-focus");
        $("shortcut-tip").hidden = false;
      }
      if (f.draft) {
        $("input").value = f.draft;
        $("input").focus();
      }
      if (f.gallery) {
        $("lower").hidden = true;
        $("connections").hidden = true;
        $("captions").innerHTML =
          `<div class="dark-gallery">${f.gallery.map((x) => `<div class="status" data-tone="${x.tone}"><span class="status-mark">${icon(x.icon, 17)}</span><div class="status-copy"><strong>${x.text}</strong><small>${x.detail || ""}</small></div>${x.tone === "send" ? '<button class="stop-voice">止める（Esc）</button>' : ""}</div>`).join("")}</div>`;
      }
    }
    return true;
  },
  live() {
    fixture = false;
    view = "";
  },
};
if (params.has("fixture")) await window.koeTest.fixture(params.get("fixture"));
/* DEV_END */
if (!fixture) await restorePrep();
connect();
setInterval(() => {
  if (view === "summary" && state?.summaryState === "loading") updateSummary();
  if (view === "meeting" && !fixture) updateStatus();
}, 1000);
