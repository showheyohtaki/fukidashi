// After T4 confirms undetected Zoom mute, change to "Zoom ベータ: ミュート検出なし".
export const ZOOM_PLATFORM = "Zoom（ベータ）";
export const VOICES = [
  "marin",
  "cedar",
  "coral",
  "sage",
  "shimmer",
  "alloy",
  "ash",
  "ballad",
  "echo",
  "verse",
];
export const SAMPLE =
  "はじめまして。本日はお時間をいただき、ありがとうございます。";
export const FILLER = "少々お待ちください。いま入力しています。";
const legacyIntro = (name = "") =>
  `はじめまして${name ? `、${name}です` : ""}。耳が聞こえないため、お話しいただいた内容を文字起こしで読み、AI の声でお返事しています。お返事に少し間が空くことがありますが、よろしくお願いします。`;
// はじめの一言で相手に伝える理由。初回設定・設定の「会議での伝え方」で選ぶ。
export const NEEDS = [
  ["hearing", "耳が聞こえない・聞こえにくい"],
  ["speech", "声で話すことが難しい"],
  ["both", "どちらも"],
  ["none", "理由は伝えない"],
];
const NEED_REASON = {
  hearing:
    "耳が聞こえないため、お話しいただいた内容を文字起こしで読み、AI の声でお返事しております。",
  speech:
    "声で話すことが難しいため、入力した文を AI の声で読み上げてお返事しております。",
  both: "耳が聞こえず、声で話すことも難しいため、お話しいただいた内容を文字起こしで読み、入力した文を AI の声で読み上げてお返事しております。",
  none: "入力した文を AI の声で読み上げてお返事しております。",
};
export const defaultIntro = (name = "", need = "hearing") =>
  `はじめまして${name ? `、${name}と申します` : ""}。本日はお時間をいただき、ありがとうございます。${NEED_REASON[need] || NEED_REASON.hearing}お返事に少しお時間をいただくことがありますが、どうぞよろしくお願いいたします。`;
const LEGACY_HEARING = [
  "今回ご相談いただいたきっかけを教えてください。",
  "今、困っていることはありますか。",
  "どのようなことを実現したいですか。",
  "ご予算の目安を教えてください。",
  "ご希望の時期はありますか。",
  "ほかにご担当の方はいらっしゃいますか。",
  "次の進め方について、ご希望はありますか。",
];
const LEGACY_PHRASES = [
  "もう一度お話しいただけますか？",
  "少しゆっくりお話しいただけますか？",
  "確認して、あとでご連絡します。",
  "本日はありがとうございました。",
];
export const DEFAULTS = {
  apiKey: "",
  onboarded: false,
  voice: "marin",
  style: "落ち着いて、自然な速さで、丁寧に。",
  voiceModel: "gpt-realtime-2.1",
  sttModel: "gpt-live-transcribe",
  replyModel: "gpt-5.4-mini",
  name: "",
  job: "",
  about: "",
  need: "hearing",
  intro: defaultIntro(),
  introEdited: false,
  quick: [
    { label: "はい", text: "はい。" },
    { label: "承知しました", text: "承知いたしました。" },
    { label: "ありがとう", text: "ありがとうございます。" },
    { label: "お待ちください", text: "少々お待ちください。" },
  ],
  phrases: [
    "恐れ入りますが、もう一度お話しいただけますでしょうか。",
    "恐れ入りますが、少しゆっくりお話しいただけますでしょうか。",
    "確認のうえ、改めてご連絡いたします。",
    "本日はお時間をいただき、ありがとうございました。",
  ],
  hearing: [
    "今回ご相談いただいたきっかけを、お聞かせいただけますでしょうか。",
    "現在の業務や取り組みでお困りの点を、教えていただけますでしょうか。",
    "今回のご相談で実現したいことを、お聞かせいただけますでしょうか。",
    "差し支えなければ、ご予算の目安を教えていただけますでしょうか。",
    "ご希望の完了時期を、お聞かせいただけますでしょうか。",
    "今回のご相談に関わるご担当者様を、教えていただけますでしょうか。",
    "今後の進め方について、ご希望をお聞かせいただけますでしょうか。",
  ],
  prefetchCandidates: 3,
  autoFiller: true,
  autoFillerSec: 6,
  autoStopOnBargeIn: false,
  sendMic: false,
  localMonitor: false,
  useLocalMic: false,
  captionFontPx: 19,
  showSpeakerNames: true,
  keepLogDays: 0,
  theme: "auto",
  reduceMotion: false,
  enterToSpeak: true,
  sensitivity: 1,
};
// 会話の開始時に声を作り置きする、ヒアリング項目と定型文の上限（費用の上限）。
export const WARM_LIST_LIMIT = 20;
// 作り置きする文の一覧。はじめの一言・相づち・つなぎは常に、
// ヒアリング項目→定型文の順に合わせて WARM_LIST_LIMIT 件まで。
export function warmTexts(cfg) {
  const base = [
    ...new Set([cfg.intro, ...cfg.quick.map((q) => q.text), FILLER]),
  ].filter(Boolean);
  const seen = new Set(base),
    lists = [];
  for (const text of [...(cfg.hearing || []), ...(cfg.phrases || [])]) {
    if (lists.length >= WARM_LIST_LIMIT) break;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lists.push(text);
  }
  return [...base, ...lists];
}
export function configWith(raw = {}) {
  const migrated = { ...raw };
  const same = (a, b) =>
    Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  if (same(raw.hearing, LEGACY_HEARING)) migrated.hearing = DEFAULTS.hearing;
  if (same(raw.phrases, LEGACY_PHRASES)) migrated.phrases = DEFAULTS.phrases;
  if (!raw.introEdited && raw.intro === legacyIntro(raw.name || ""))
    migrated.intro = defaultIntro(raw.name || "");
  const legacyQuick = DEFAULTS.quick.map((q, i) =>
    i === 1 ? { label: "なるほど", text: "なるほど。" } : q,
  );
  if (
    Array.isArray(raw.quick) &&
    raw.quick.length === 4 &&
    raw.quick.every(
      (q, i) =>
        q?.label === legacyQuick[i].label && q?.text === legacyQuick[i].text,
    )
  )
    migrated.quick = DEFAULTS.quick;
  return { ...structuredClone(DEFAULTS), ...sanitizeConfig(migrated, true) };
}
export function sanitizeConfig(raw, allowKey = false) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (
      !(key in DEFAULTS) ||
      (!allowKey && key === "apiKey") ||
      (key.endsWith("Model") && key !== "sttModel")
    )
      continue;
    if (typeof DEFAULTS[key] === "boolean" && typeof value === "boolean")
      out[key] = value;
    else if (typeof DEFAULTS[key] === "string" && typeof value === "string")
      out[key] = value.slice(0, key === "apiKey" ? 512 : 4000);
  }
  const bounds = {
    prefetchCandidates: [0, 3],
    autoFillerSec: [4, 10],
    captionFontPx: [16, 28],
    sensitivity: [0.5, 2],
  };
  for (const [key, [min, max]] of Object.entries(bounds))
    if (Number.isFinite(raw[key]))
      out[key] = Math.min(max, Math.max(min, raw[key]));
  if (raw.keepLogDays === 0 || raw.keepLogDays === 7)
    out.keepLogDays = raw.keepLogDays;
  if (out.voice && !VOICES.includes(out.voice)) delete out.voice;
  if (out.theme && !["auto", "light", "dark"].includes(out.theme))
    delete out.theme;
  if (out.need && !NEEDS.some(([v]) => v === out.need)) delete out.need;
  if (
    out.sttModel &&
    !["gpt-live-transcribe", "gpt-4o-transcribe"].includes(out.sttModel)
  )
    delete out.sttModel;
  for (const key of ["phrases", "hearing"])
    if (Array.isArray(raw[key]))
      out[key] = raw[key]
        .filter((x) => typeof x === "string" && x.trim())
        .slice(0, 30)
        .map((x) => x.slice(0, 500));
  if (Array.isArray(raw.quick) && raw.quick.length === 4)
    out.quick = raw.quick.map((q, i) => ({
      label: String(q.label || DEFAULTS.quick[i].label).slice(0, 20),
      text: String(q.text || DEFAULTS.quick[i].text).slice(0, 500),
    }));
  return out;
}
export function publicConfig(cfg) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, hasKey: !!apiKey };
}
