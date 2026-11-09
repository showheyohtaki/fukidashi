import { speakerName } from "./speakers.js";
export function validPageCommand(m) {
  if (!m || typeof m !== "object") return false;
  if (m.type === "pcm")
    return (
      typeof m.id === "string" &&
      m.id.length < 100 &&
      typeof m.audio === "string" &&
      m.audio.length <= 262144 &&
      m.audio.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(m.audio)
    );
  if (m.type === "end") return typeof m.id === "string" && m.id.length < 100;
  return (
    m.type === "stop" ||
    m.type === "ping" ||
    (m.type === "sendMic" && typeof m.value === "boolean")
  );
}
export function cleanPageEvent(m) {
  if (!m || typeof m !== "object") return null;
  if (m.type === "ready") return { type: "ready" };
  if (m.type === "speakers") {
    if (
      !Number.isFinite(m.at) ||
      !Array.isArray(m.names) ||
      m.names.length > 10 ||
      m.names.some((n) => typeof n !== "string" || n.length > 100)
    )
      return null;
    return {
      type: "speakers",
      at: m.at,
      names: [...new Set(m.names.map(speakerName).filter(Boolean))],
    };
  }
  if (m.type === "status")
    return {
      type: "status",
      streams: Math.max(0, Math.min(100, Number(m.streams) || 0)),
      unmuted: Math.max(0, Math.min(100, Number(m.unmuted) || 0)),
      attached: Math.max(0, Math.min(100, Number(m.attached) || 0)),
      attachedEver: !!m.attachedEver,
      context: ["running", "suspended", "closed"].includes(m.context)
        ? m.context
        : "suspended",
    };
  if (
    ["play-start", "play-progress", "play-end"].includes(m.type) &&
    typeof m.id === "string" &&
    m.id.length < 100
  )
    return {
      type: m.type,
      id: m.id,
      elapsed: Math.max(0, Number(m.elapsed) || 0),
      level: Math.max(0, Math.min(1, Number(m.level) || 0)),
      stopped: !!m.stopped,
      preparing: !!m.preparing,
      underrunMs: Math.max(0, Math.min(180000, Number(m.underrunMs) || 0)),
    };
  return null;
}
const kanjiDigits = {
  〇: "0",
  零: "0",
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
};
function decimalNumber(text) {
  let total = 0n,
    section = 0n,
    digits = "",
    hasSection = false;
  const small = { 十: 10n, 百: 100n, 千: 1000n };
  const large = { 万: 10000n, 億: 100000000n, 兆: 1000000000000n };
  for (const char of text) {
    if (/\d/.test(char) || char in kanjiDigits) {
      digits += kanjiDigits[char] ?? char;
      hasSection = true;
    } else if (char in small) {
      section += BigInt(digits || "1") * small[char];
      digits = "";
      hasSection = true;
    } else {
      total +=
        (hasSection ? section + BigInt(digits || "0") : 1n) * large[char];
      section = 0n;
      digits = "";
      hasSection = false;
    }
  }
  return String(total + section + BigInt(digits || "0"));
}
export const normalizeSpeech = (text) =>
  String(text || "")
    .normalize("NFKC")
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(
      /[0-9〇零一二三四五六七八九十百千万億兆]+/g,
      (number, offset, source) => {
        if (!/[〇零一二三四五六七八九十百千万億兆]/.test(number)) return number;
        const after = source.slice(offset + number.length);
        // A following non-counter kanji marks a word (一緒, 一切, 八王子, ...).
        // Numeric amounts/dates/counters and standalone numbers can be canonicalized.
        if (
          /^\p{Script=Han}/u.test(after) &&
          !/^(?:円|年|月|日|時|分|秒|個|人|回|枚|件|本|台|歳|才|階|冊|社|度|番|名|週|割|倍|点|章|頁)/.test(
            after,
          )
        )
          return number;
        return decimalNumber(number);
      },
    )
    .replace(/[\p{P}\p{Z}\s]/gu, "")
    .toLowerCase();
export const speechMatches = (a, b) =>
  !!normalizeSpeech(a) && normalizeSpeech(a) === normalizeSpeech(b);
// Keep question marks through normalization: "いいです" -> "いいです？"
// must not become an exact match. Check negations across the suffix boundary too.
export function draftReuse(draft, final) {
  const comparable = (s) =>
    normalizeSpeech(String(s).replace(/[?？]/g, "\uE000")).replace(
      /\uE000/g,
      "?",
    );
  const a = comparable(draft),
    b = comparable(final);
  const suffix = b.startsWith(a) ? b.slice(a.length) : "";
  const ratio = b.length ? [...suffix].length / [...b].length : 1;
  let reason =
    !a || !b.startsWith(a)
      ? "prefix-changed"
      : /[か?]/.test(suffix)
        ? "question-added"
        : [
              ...b.matchAll(
                /ない|なかっ|なく|ません|ませぬ|ぬ|ず|無い|無く|違う|違い|不要|不可|無理/g,
              ),
            ].some((m) => m.index + m[0].length > a.length)
          ? "negation-added"
          : ratio > 0.2
            ? "suffix-too-long"
            : "accepted";
  return { match: reason === "accepted", reason, suffix, ratio };
}
export const pageMuted = (page) =>
  page.streams > 0 && (!page.unmuted || (page.attachedEver && !page.attached));
export const pageCanSend = (page) =>
  page.streams > 0 && !pageMuted(page) && page.context === "running";
export const reconnectSttText = (attempt) =>
  `字幕が止まっています（再接続中 ${attempt || 1} 回目）`;
export function canSend(s) {
  return Boolean(
    s.active &&
    !s.keyError &&
    pageCanSend(s.page) &&
    (s.voiceState === "ready" || (s.connectedOnce && s.preState === "ready")) &&
    (s.sttState === "ready" || s.connectedOnce),
  );
}
export function shouldSendEnter(e, enabled = true) {
  return (
    enabled &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    e.keyCode !== 229
  );
}
export function statusView(s, now = Date.now()) {
  if (s.keyError)
    return { tone: "neutral", icon: "pause", text: "字幕と声が止まっています" };
  if (s.notMeeting)
    return {
      tone: "neutral",
      icon: "tabOff",
      text: "会議のタブではありません",
    };
  if (s.active && pageMuted(s.page))
    return { tone: "bad", icon: "micOff", text: "会議でミュート中" };
  if (!s.active)
    return {
      tone: "neutral",
      icon: "pause",
      text: s.ended ? "会話を停止しました" : "会議に参加していません",
    };
  if (
    !s.connectedOnce &&
    (s.sttState !== "ready" || s.voiceState !== "ready" || !s.page.streams)
  ) {
    const count = [
      s.sttState === "ready",
      s.voiceState === "ready",
      s.page.streams > 0,
    ].filter(Boolean).length;
    return {
      tone: "neutral",
      icon: "spinner",
      text: `つないでいます… ${count} / 3`,
    };
  }
  if (!s.page.streams)
    return { tone: "neutral", icon: "pause", text: "会議に参加していません" };
  if (s.voiceState === "failed" && s.preState !== "ready")
    return { tone: "neutral", icon: "pause", text: "声を送れません" };
  if (s.speaking && !s.speaking.preparing && s.otherSpeaking)
    return { tone: "warn", icon: "talk", text: "相手も話しています" };
  if (s.speaking?.preparing)
    return { tone: "neutral", icon: "spinner", text: "声を準備しています" };
  if (s.speaking) return { tone: "send", icon: "speaker", text: "送信中" };
  if (s.otherSpeaking)
    return { tone: "talk", icon: "talk", text: "相手が話しています" };
  if (s.sttState !== "ready" && s.voiceState !== "ready")
    return { tone: "neutral", icon: "spinner", text: "接続しています" };
  if (s.waitSince) {
    const seconds = Math.max(0, Math.floor((now - s.waitSince) / 1000));
    return {
      tone: seconds >= 6 ? "warn" : "waiting",
      icon: seconds >= 6 ? "earAlert" : "ear",
      text: "相手が待っています",
      seconds,
    };
  }
  return { tone: "neutral", icon: "pause", text: "相手の声を待っています" };
}
