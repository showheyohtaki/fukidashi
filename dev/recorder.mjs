// Test-page recorder ownership. Every MediaRecorder keeps its own chunks and
// stop promise, including late dataavailable events after abort/replacement.
export function createReceiverRecorder({
  getStream,
  resetStats,
  stats,
  Recorder = MediaRecorder,
}) {
  let current = null;
  let operations = Promise.resolve();
  const serial = (fn) => {
    const next = operations.then(fn);
    operations = next.catch(() => {});
    return next;
  };
  const stop = async (take) => {
    if (take.rec.state !== "inactive") take.rec.stop();
    await take.stopped;
  };
  const abort = async () => {
    const take = current;
    current = null;
    if (take) await stop(take);
  };
  return {
    isRecording: () => current?.rec.state === "recording",
    start: () =>
      serial(async () => {
        await abort();
        resetStats();
        const rec = new Recorder(getStream(), { mimeType: "audio/webm" });
        const mine = [];
        const take = { rec, mine, error: null };
        take.stopped = new Promise((resolve) => {
          rec.ondataavailable = (e) => mine.push(e.data);
          rec.onstop = resolve;
          rec.onerror = (e) => {
            take.error = e.error || new Error("録音機が失敗しました");
          };
        });
        current = take;
        try {
          rec.start(100);
        } catch (error) {
          current = null;
          throw error;
        }
      }),
    abort: () => serial(abort),
    finish: () =>
      serial(async () => {
        const take = current;
        current = null;
        if (!take) return null;
        const measured = stats();
        await stop(take);
        if (take.error) throw take.error;
        const bytes = new Uint8Array(
          await new Blob(take.mine, { type: "audio/webm" }).arrayBuffer(),
        );
        let text = "";
        for (let i = 0; i < bytes.length; i += 32768)
          text += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { audio: btoa(text), ...measured };
      }),
  };
}
