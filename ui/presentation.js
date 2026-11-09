import { pageMuted } from "../protocol.js";
export function statusDetails(s, time = Date.now()) {
  if (s.speaking && !s.speaking.preparing && s.otherSpeaking)
    return [{ text: "Esc で止められます" }];
  if (pageMuted(s.page)) return [{ text: "先に解除してください" }];
  if (s.speaking) return [{ text: s.speaking.text }];
  const details = [];
  if (time - s.typingAt < 2000) details.push({ icon: "edit", text: "入力中" });
  if (s.fillerAt && time - s.fillerAt < 3000)
    details.push({ icon: "check", text: "つなぎを送りました" });
  if (!details.length && s.candidateState === "thinking")
    details.push({ icon: "dots", text: "候補を考えています" });
  if (
    !details.length &&
    s.waitSince &&
    time - s.waitSince >= 6000 &&
    !s.otherSpeaking
  )
    details.push({ text: "相づちで間をつなげます" });
  return details;
}
export function summaryPeriod(start, end) {
  if (!start || !end) return "終了時刻は未確認";
  const from = new Date(start).toLocaleString("ja-JP", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const to = new Date(end).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${from}〜${to}（${Math.max(0, Math.round((end - start) / 60000))} 分）`;
}
export function summaryHeading(question) {
  const titles = [
    [/きっかけ/, "今回のきっかけ"],
    [/困って|お困り/, "いま困っていること"],
    [/お客|見てほしい/, "見てほしいお客さま"],
    [/予算/, "予算の目安"],
    [/時期|公開したい/, "希望の時期"],
    [/参考.*サイト/, "参考にしたいサイト"],
    [/更新/, "公開後の更新"],
    [/実現/, "実現したいこと"],
    [/担当/, "担当する方"],
    [/進め方/, "次の進め方"],
  ];
  return titles.find(([re]) => re.test(question))?.[1] || question;
}
export function metricText(values) {
  if (!values.length) return "未計測";
  const a = [...values].sort((x, y) => x - y),
    n = a.length;
  const median = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  return `中央値 ${Math.round(median)} ms / p90 ${Math.round(a[Math.ceil(n * 0.9) - 1])} ms（${n} 件）`;
}
