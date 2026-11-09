// Only display names cross the page boundary. No participant IDs or page text.
export function speakerName(value) {
  if (typeof value !== "string") return "";
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 100) return "";
  if (
    /^(?:あなた|自分|本人|you|me)$|[（(](?:あなた|自分|本人|you|me)[）)]$/i.test(
      name,
    )
  )
    return "";
  if (
    /notta|otter|fireflies|fathom|read\.ai|tl;dv|tactiq|ボット|議事録|文字起こし|(?:^|\W)(?:bot|notetaker)(?:\W|$)/i.test(
      name,
    )
  )
    return "";
  return name;
}

export class SpeakerTimeline {
  constructor() {
    this.clear();
  }
  clear() {
    this.samples = [];
  }
  add(event, time = Date.now()) {
    if (
      !Number.isFinite(event.at) ||
      event.at > time + 250 ||
      event.at < time - 2000 ||
      !Array.isArray(event.names)
    )
      return;
    if (event.at <= (this.samples.at(-1)?.at ?? -Infinity)) return;
    this.samples.push({
      at: event.at,
      names: [...new Set(event.names.map(speakerName).filter(Boolean))].slice(
        0,
        10,
      ),
    });
    this.samples = this.samples
      .filter((s) => s.at >= time - 600000)
      .slice(-2400);
  }
  dominant(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return "";
    const durations = new Map();
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i];
      const ms =
        Math.min(end, sample.at + 1500, this.samples[i + 1]?.at ?? Infinity) -
        Math.max(start, sample.at);
      if (ms <= 0) continue;
      for (const name of sample.names)
        durations.set(name, (durations.get(name) || 0) + ms);
    }
    const ranked = [...durations].sort((a, b) => b[1] - a[1]);
    // Ties and tiny flashes are not enough to attribute a sentence.
    return ranked[0]?.[1] >= 200 && ranked[0][1] > (ranked[1]?.[1] || 0)
      ? ranked[0][0]
      : "";
  }
}

export const lineSpeaker = (line, enabled = true) =>
  line.who === "me"
    ? "自分"
    : line.gap
      ? "案内"
      : (enabled && speakerName(line.speaker)) || "相手";

export const captionSpeaker = (line, previous, enabled = true) => {
  const name =
    enabled && line.who === "other" && !line.gap
      ? speakerName(line.speaker)
      : "";
  return name &&
    !(previous?.who === "other" && !previous.gap && previous.speaker === name)
    ? name
    : "";
};
