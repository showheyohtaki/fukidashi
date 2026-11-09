import { reconnectSttText } from "../protocol.js";
import { configWith, publicConfig, defaultIntro } from "../config.js";
export const fixtureNames = [
  "Main",
  "S0-1-key",
  "S0-1b-badkey",
  "S0-2-you",
  "S0-3-voice",
  "S1-idle",
  "S1b-not-meeting",
  "S2-connecting",
  "S3a-talking",
  "S3c-thinking",
  "S3d-overlap",
  "S4-speaking",
  "S5-filler",
  "S6-errors",
  "S7-summary",
  "S7b-summary-fixed",
  "S8-settings",
  "S9-voices",
  "S11-hearing",
  "Dark",
  "Dark-states",
  "W360",
  "H700",
  "E1-bands",
  "E2-inline",
  "E3-candfail",
  "E4-badkey",
  "F-focus",
  "M-menu",
  "S1c-prep-draft",
  "S1d-prep-sheet",
  "S12-lists",
];
// v1.2 で足した画面。正本のキャンバスはまだ無い（比較画像は作らず、撮影だけする）。
export const extraFixtureNames = [
  "S8b-draft-error",
  "S11b-hearing-edit",
  "S12c-sheet-map",
  "S12d-draft-full",
  "S12e-save-failed",
];
const at = (min) => new Date(`2026-10-31T10:${min}:00+09:00`).getTime();
const intro = defaultIntro("山田").replaceAll("AI の声", "AIの声");
const questions = [
  "今回ホームページを作ろうと思われたきっかけは何ですか。",
  "いまのサイトで困っていることはありますか。",
  "主にどんなお客さまに見てほしいですか。",
  "ご予算の目安を教えてください。",
  "公開したい時期はありますか。",
  "参考にしたいサイトはありますか。",
  "公開後の更新はどなたがされますか。",
];
const answers = [
  "10年前に作ったサイトで、お客さまから「スマホだと見づらい」と言われることが増えた。",
  "スマホだと文字が小さく、電話番号も押せない。更新は業者頼みで時間がかかる。",
  "近所に住む30〜50代の方。予約の前にスマホで調べてから来る人が多い。",
  "50万円前後。支払いを分けられるなら相談したい。",
  "来年の4月まで。4月には新しいサイトにしたい。",
  "未確認",
  "未確認",
];
export function makeFixture(name) {
  if (!fixtureNames.includes(name) && !extraFixtureNames.includes(name))
    throw new Error("Unknown fixture " + name);
  let count = 0;
  const line = (who, text, min = "03", extra = {}) => ({
    id: "fixture-" + ++count,
    who,
    text,
    at: at(min),
    ...extra,
  });
  const cfg = publicConfig(
    configWith({
      apiKey: "dummy-key-proxy-only",
      onboarded: true,
      name: "山田",
      job: "Web デザイナー（ホームページ制作）",
      about: "女性向けのやわらかいデザインが得意です。",
      intro: defaultIntro("山田"),
      hearing: questions,
      theme: name.startsWith("Dark") ? "dark" : "light",
    }),
  );
  const state = {
    active: true,
    connectedOnce: true,
    ended: false,
    startedAt: at("00"),
    lines: [
      line("other", "はじめまして。本日はよろしくお願いします。", "02"),
      line("me", intro, "02"),
      line(
        "other",
        "わかりました、ありがとうございます。実はいまのホームページが10年前に作ったもので、スマホで見るとすごく見づらいって言われるんですよね。",
      ),
    ],
    candidates: [
      "それは気になりますね。どのあたりが見づらいと言われますか？",
      "スマホでの見やすさを一番に直したい、ということですね。",
      "一度いまのサイトを拝見して、直す所を整理しますね。",
    ].map((text, i) => ({ text, ready: i < 2 })),
    candidateState: "ready",
    page: {
      streams: 1,
      unmuted: 1,
      attached: 1,
      attachedEver: true,
      context: "running",
    },
    sttState: "ready",
    voiceState: "ready",
    preState: "ready",
    otherSpeaking: false,
    waitSince: Date.now() - 3000,
    speaking: null,
    typingAt: 0,
    bands: [],
    hearingAsked: [0, 1, 2],
    summary: null,
    summaryState: "idle",
    warm: { done: 4, total: 12, ready: questions.slice(3) },
    usage: {
      sttSeconds: 2520,
      voiceSeconds: 240,
      spokenSentences: 128,
      candidateRequests: 61,
      inputCharacters: 1600,
      textInputTokens: 0,
      textOutputTokens: 0,
      requests: 61,
    },
    metrics: { roundTrips: [], taps: [] },
    keyError: false,
    platform: "Google Meet",
    cfg,
  };
  const out = { state, view: "meeting" };
  if (name.startsWith("S0-")) {
    out.view = "onboarding";
    out.step = name.startsWith("S0-2") ? 2 : name.startsWith("S0-3") ? 3 : 1;
    out.badKey = name === "S0-1b-badkey";
  }
  // v1.2.1: 今日の議題（文・添付・案）は開始前の画面に移した。その画面で撮る。
  const todayPrep = [
    "S1c-prep-draft",
    "S8b-draft-error",
    "S1d-prep-sheet",
    "S12c-sheet-map",
    "S12d-draft-full",
  ].includes(name);
  if (name === "S1-idle" || name === "S1b-not-meeting" || todayPrep) {
    state.active = false;
    state.hearingAsked = [];
    state.lines = [];
    state.candidates = [];
    state.page = { streams: 0, unmuted: 0, context: "suspended" };
    state.sttState = state.voiceState = "idle";
    state.notMeeting = name === "S1b-not-meeting";
    state.fixtureStatus = {
      tone: "neutral",
      icon: state.notMeeting ? "tabOff" : "pause",
      text: state.notMeeting ? "会議のタブではありません" : "待機中",
    };
  }
  if (name === "S2-connecting") {
    state.connectedOnce = false;
    state.hearingAsked = [];
    state.waitSince = 0;
    state.lines = [];
    state.candidates = [];
    state.voiceState = "connecting";
    state.page.streams = 0;
    state.fixtureStatus = {
      tone: "neutral",
      icon: "spinner",
      text: "つないでいます… 1 / 3",
    };
  }
  if (name === "S3a-talking") {
    state.otherSpeaking = true;
    state.waitSince = 0;
    state.lines.push(line("me", state.candidates[0].text));
    state.lines.push(
      line(
        "other",
        "文字が小さくて、メニューも押しにくいみたいです。あと、お問い合わせのフォームも",
        "04",
        { partial: true },
      ),
    );
  }
  if (name === "S3c-thinking") {
    state.lines.push(
      line("me", state.candidates[0].text),
      line(
        "other",
        "文字が小さくて、メニューも押しにくいみたいです。あと、お問い合わせのフォームも、スマホだと入力しづらいって。",
        "04",
      ),
    );
    state.candidateState = "thinking";
  }
  if (name === "S4-speaking" || name === "S3d-overlap") {
    state.speaking = {
      id: "speech",
      text: state.candidates[0].text,
      level: 0.7,
    };
    state.lines.push(
      line("me", "それは気になりますね。どのあたりが見づらいと言われますか？"),
    );
    if (name === "S3d-overlap") {
      state.otherSpeaking = true;
      state.lines.push(
        line("other", "あ、ページは全部で", "06", { partial: true }),
      );
    }
  }
  if (name === "S5-filler") {
    state.waitSince = Date.now() - 7000;
    state.typingAt = Date.now();
    state.fillerAt = Date.now();
    state.lines.push(
      line("me", "少々お待ちください。いま入力しています。", "05"),
    );
    out.draft = "ページ数と入れたい機能で";
  }
  if (name === "S6-errors") {
    state.page.unmuted = 0;
    state.sttState = "reconnecting";
    state.lines.push(
      line("system", "10:44:12〜10:44:13 の字幕はありません（再接続）", "44", {
        gap: true,
      }),
    );
    state.bands = [
      {
        id: "stt",
        tone: "warn",
        text: reconnectSttText(2),
      },
    ];
  }
  if (name.startsWith("S7")) {
    out.view = "summary";
    out.scroll = name === "S7b-summary-fixed";
    state.active = false;
    state.ended = true;
    state.endedAt = at("42");
    state.summaryState = "ready";
    state.summary = {
      items: questions.map((question, i) => ({ question, answer: answers[i] })),
      other: [
        "スタッフ紹介のページも作りたい",
        "いまのアドレス（ドメイン）はそのまま使いたい",
        "店内の写真は自分たちで撮ったものがある",
      ],
      todo: [
        "参考にしたいサイトを2〜3件送ってもらう",
        "いまのサイトの管理画面に入れるか確かめてもらう",
        "見積もりと進め方の案を送る（11月7日まで）",
      ],
    };
  }
  if (name === "S8-settings") {
    out.view = "settings";
    state.warm = { done: 9, total: 12 };
  }
  if (todayPrep) out.view = "meeting";
  if (name === "S9-voices") out.view = "voices";
  if (name === "S11-hearing") out.sheet = true;
  if (name === "S11b-hearing-edit") {
    out.sheet = true;
    out.sheetEdit = true;
  }
  if (name === "S12-lists") {
    out.view = "lists";
    out.listsTab = "hearing";
  }
  if (name === "S1c-prep-draft")
    out.hearingDraft = {
      status: "ready",
      label: "初回ヒアリング",
      questions: [
        "今回ホームページを作ろう、または新しくしようと思われたきっかけを、お聞かせいただけますでしょうか。",
        "今のホームページで困っていることを、教えていただけますでしょうか。",
        "主にどのようなお客様に見ていただきたいか、お聞かせいただけますでしょうか。",
        "必要なページの数や、入れたい機能を教えていただけますでしょうか。",
        "差し支えなければ、ご予算の目安を教えていただけますでしょうか。",
        "公開したい時期の目安を、お聞かせいただけますでしょうか。",
        "写真や文章など、ご用意いただける素材を教えていただけますでしょうか。",
      ],
      selected: [true, true, true, true, true, true, false],
    };
  if (name === "S1d-prep-sheet") {
    // tests/fixtures/hearing-sheet.xlsx を読んだときと同じ形（架空の内容）。
    const item = (label, sheet, filled, hint = "") => ({
      label,
      sheet,
      filled,
      hint,
      checked: !filled,
    });
    out.sheetImport = {
      status: "ready",
      fileName: "hearing-sheet.xlsx",
      sheets: ["基本情報", "デザイン"],
      chosen: ["基本情報", "デザイン"],
      truncated: false,
      items: [
        item("会社名", "基本情報", true),
        item("業種", "基本情報", true),
        item("ご担当者名", "基本情報", false),
        item("ご予算", "基本情報", false),
        item("納期", "基本情報", false),
        item("ターゲット", "基本情報", false),
        item("ページ数", "基本情報", true),
        item("公開後の更新", "基本情報", false, "☐ 自社で行う ☐ 依頼したい"),
        item("参考サイト", "デザイン", false),
        item("好きな色", "デザイン", true),
        item("NG 事項", "デザイン", false),
      ],
    };
  }
  if (name === "S12c-sheet-map") {
    // tests/fixtures/empty-middle.xlsx（見出しなし・B 列が空・C 列が説明）を読んだときの形。
    out.sheetImport = {
      status: "ready",
      fileName: "empty-middle.xlsx",
      sheets: ["シート1"],
      chosen: ["シート1"],
      truncated: false,
      mapping: {},
      items: [],
      tables: [
        {
          key: "シート1",
          sheet: "シート1",
          block: "",
          columns: [
            { index: 0, name: "A", samples: ["会社名", "ご予算", "納期"] },
            { index: 1, name: "B", samples: [] },
            { index: 2, name: "C", samples: ["法人名を記入", "税込の概算額", "公開希望日"] },
          ],
          roles: null,
          needsMapping: true,
          chosen: false,
          suggestion: { label: 0, answer: 1 },
        },
      ],
    };
  }
  if (name === "S12d-draft-full") {
    state.cfg.hearing = Array.from(
      { length: 30 },
      (_, i) => `確認したいこと ${i + 1} について、お聞かせいただけますでしょうか。`,
    );
    // 29 問に 3 問を足して 1 問だけ入り、入りきらない 2 問が案に残った状態。
    out.hearingDraft = {
      status: "ready",
      label: "今日の項目",
      questions: [
        "公開後の更新はどなたが担当されますでしょうか。",
        "請求書の宛名を教えていただけますでしょうか。",
      ],
      selected: [true, true],
    };
  }
  if (name === "S12e-save-failed") {
    out.view = "lists";
    out.listsTab = "hearing";
    out.editBuffer = {
      hearing: ["公開前にテストをお願いいたします。", ...questions.slice(1)],
    };
  }
  if (name === "S8b-draft-error") {
    out.hearingDraft = {
      status: "failed",
      label: "今日の項目",
      error: "接続できませんでした。もう一度お試しください",
    };
  }
  if (name === "E1-bands" || name === "H700") {
    state.page.streams = 0;
    state.bands = [
      {
        id: "meeting",
        tone: "bad",
        text: "会議に参加すると声を送れます。参加してもこの表示が消えないときは、会議のページを再読み込みしてください。",
        action: "reloadHelp",
      },
      {
        id: "recovered",
        tone: "waiting",
        text: "字幕が戻りました。10:44:12〜10:44:13 は字幕がありません",
      },
    ];
  }
  if (name === "H700")
    state.bands[1] = {
      id: "stt",
      tone: "warn",
      text: reconnectSttText(2),
    };
  if (name === "W360")
    state.candidates = [
      "スマホでの見やすさを大事にしながら、画面全体の配置も一緒に確認してよろしいですか。",
      "詳しく伺いたいです。今のお客さまが特に使いづらいと感じている所を教えてください。",
      "ありがとうございます。いまのお話を整理してから、進め方をいくつか提案いたします。",
    ].map((text) => ({ text: [...text].slice(0, 40).join(""), ready: true }));
  if (name === "E2-inline")
    state.lines = [
      line(
        "other",
        "画面の文字が小さくて、ボタンも押しにくいみたいです。",
        "04",
      ),
      line("me", "スマホの見やすさを一番に、ですね。", "04", {
        failed: true,
        requested: "スマホの見やすさを一番に、ですね。",
      }),
      line("me", "公開は3月でよろしいですか？", "05", {
        mismatch: true,
        requested: "公開は3月末でよろしいですか？",
      }),
      line("me", "それと、予算の目安も", "05", {
        interrupted: true,
        requested: "それと、予算の目安も伺ってよろしいですか",
      }),
      line("other", "はい、3月末で大丈夫です。", "06"),
    ];
  if (name === "E3-candfail") {
    state.candidateState = "failed";
    state.lines.push(
      line("me", "スマホでの見やすさを一番に直したい、ということですね。"),
      line(
        "other",
        "画面の文字が小さくて、ボタンも押しにくいみたいです。お店の地図も見つけにくいし、営業時間がどこに書いてあるのか分からないって言われます。",
        "04",
      ),
    );
    out.history = true;
    out.unread = 2;
  }
  if (name === "E4-badkey") {
    out.keyDialog = true;
    state.sttState = state.voiceState = "failed";
    state.fixtureStatus = {
      tone: "neutral",
      icon: "pause",
      text: "字幕と声が止まっています",
    };
  }
  if (name === "F-focus") out.focus = true;
  if (name === "M-menu") {
    out.menu = true;
    out.dialog = true;
  }
  if (name === "Dark-states")
    out.gallery = [
      ["waiting", "ear", "相手が待っています　3 秒"],
      [
        "warn",
        "earAlert",
        "相手が待っています　7 秒",
        "相づちで間をつなげます",
      ],
      ["talk", "talk", "相手が話しています"],
      ["send", "speaker", "送信中"],
      ["bad", "micOff", "会議でミュート中", "先に解除してください"],
      [
        "neutral",
        "spinner",
        "つないでいます… 1 / 3",
        "字幕 ✓　声 ○　会議のマイク ○",
      ],
    ].map(([tone, icon, text, detail]) => ({ tone, icon, text, detail }));
  return out;
}
