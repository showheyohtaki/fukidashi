import { normalizeSpeech } from "../protocol.js";

export function checkBuildIdentity(actual, buildConfig) {
  const expected = buildConfig.match(
    /export const BUILD_ID = ["']([^"']+)["']/,
  )?.[1];
  if (!expected || actual !== expected) {
    const error = new Error(
      `stale service worker: runtime=${actual ?? "missing"}, disk=${expected ?? "missing"}`,
    );
    error.setupFailure = "stale service worker";
    throw error;
  }
  return { expected, actual, match: true };
}

export function recordingBytes(record) {
  const bytes = Buffer.from(record.audio || "", "base64");
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const error = new Error(
      "録音が壊れている（試験の不具合）: " +
        (bytes.length ? "先頭にEBMLヘッダがありません" : "録音が空"),
    );
    error.code = "recording-corrupt";
    error.recording = {
      bytes: bytes.length,
      ebmlOffset: bytes.indexOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    };
    throw error;
  }
  return bytes;
}

// Keep cleanup testable without starting Chromium. Cleanup failure is reported
// alongside the original failure, and never replaces its cause.
export async function cleanupFailedTest(stopPlayback, abortRecording) {
  const errors = [];
  for (const [step, action] of [
    ["stop-playback", stopPlayback],
    ["abort-recording", abortRecording],
  ]) {
    try {
      await action();
    } catch (error) {
      errors.push({ step, error: error.message });
    }
  }
  return errors;
}

// Test-only ASR tolerance. Product speechMatches remains exact after normalization.
export function compareRecording(expected, actual) {
  const a = [...normalizeSpeech(expected)],
    b = [...normalizeSpeech(actual)];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  const distance = previous[b.length],
    length = Math.max(a.length, b.length);
  const differenceRatio = length ? distance / length : 1;
  return {
    match: a.length > 0 && b.length > 0 && differenceRatio <= 0.1,
    distance,
    length,
    differenceRatio,
  };
}

// Internal silence only: ignore leading/trailing silence, but retain every
// measured pause between the first and last loud samples (20ms sampling).
export function compareContinuity(samples = [], underrunMs) {
  const first = samples.findIndex((s) => s.rms > 0.002);
  const last = samples.findLastIndex((s) => s.rms > 0.002);
  const gaps = [];
  let start = null;
  for (let i = first; i >= 0 && i <= last; i++) {
    if (samples[i].rms <= 0.002) start ??= samples[i].at;
    else if (start != null) {
      gaps.push({ start, ms: samples[i].at - start });
      start = null;
    }
  }
  const spanMs = first >= 0 ? samples[last].at - samples[first].at + 20 : 0;
  const silenceMs = gaps.reduce((n, g) => n + g.ms, 0);
  const maxSilenceMs = Math.max(0, ...gaps.map((g) => g.ms));
  const silenceRatio = spanMs ? silenceMs / spanMs : 1;
  const measured = Number.isFinite(underrunMs) && underrunMs >= 0;
  return {
    // 声そのものの間（読点など）は 1.0 秒まで許す。生成が追いつかない途切れは製品側の underrunMs で見る
    match: spanMs > 0 && maxSilenceMs <= 1000 && measured && underrunMs <= 300,
    underrunMs: measured ? underrunMs : null,
    underrunMeasured: measured,
    spanMs,
    silenceMs,
    maxSilenceMs,
    silenceRatio,
    gaps,
  };
}

export async function assessContent(
  expected,
  transcribe,
  retryForDiagnostics = false,
) {
  const attempts = [];
  const models = ["gpt-4o-transcribe", "whisper-1"];
  const attempt = async (round) => {
    for (const model of models) {
      try {
        const actual = await transcribe(model, round);
        attempts.push({
          round,
          model,
          actual,
          comparison: compareRecording(expected, actual),
        });
      } catch (error) {
        attempts.push({
          round,
          model,
          error: error.message,
          code: error.code || "transcription-error",
          httpStatus: error.httpStatus ?? null,
          recording: error.recording,
        });
        if (error.code === "recording-corrupt") return;
      }
    }
  };
  await attempt(1);
  if (attempts.some((a) => a.code === "recording-corrupt"))
    return {
      match: false,
      contentMatch: false,
      failure: "recording-corrupt",
      attempts,
    };
  const contentMatch = attempts.some((a) => a.comparison?.match);
  // The second transcription is diagnostic; it never turns a failed first
  // assessment into a pass, nor excuses a continuity failure.
  if (!contentMatch || retryForDiagnostics) await attempt(2);
  return { match: contentMatch, contentMatch, attempts };
}

export async function assessRecording(expected, record, transcribe) {
  const continuity = compareContinuity(record.levels, record.underrunMs);
  const content = await assessContent(expected, transcribe, !continuity.match);
  return {
    ...content,
    continuity,
    match: continuity.match && content.contentMatch,
  };
}
