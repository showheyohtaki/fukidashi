import {
  configWith,
  publicConfig,
  FILLER,
  SAMPLE,
  warmTexts,
} from "./config.js";
import {
  canSend,
  pageCanSend,
  pageMuted,
  reconnectSttText,
  normalizeSpeech,
  draftReuse,
  speechMatches,
  statusView,
} from "./protocol.js";
import { VAD } from "./vad.js";
import {
  Transcriber,
  Speaker,
  suggestReplies,
  summarizeHearing,
  draftHearingQuestions,
  verifyKey,
  b64ToInt16,
  int16ToB64,
} from "./openai.js";
import {
  AudioCapture,
  LocalPlayer,
  wavBytes,
  playbackBufferPlan,
  observeGeneration,
  generationRate,
  splitSpeech,
} from "./audio.js";
import { VoiceCache, voiceKey } from "./cache.js";
import { API_BASE } from "./build-config.js";
import { SpeakerTimeline, speakerName } from "./speakers.js";
const now = () => Date.now(),
  uid = () => crypto.randomUUID();
export function blankState() {
  return {
    active: false,
    ended: false,
    lines: [],
    candidates: [],
    candidateState: "empty",
    candidateStreaming: false,
    page: {
      streams: 0,
      unmuted: 0,
      attached: 0,
      attachedEver: false,
      context: "suspended",
    },
    sttState: "idle",
    voiceState: "idle",
    preState: "idle",
    otherSpeaking: false,
    waitSince: 0,
    speaking: null,
    typingAt: 0,
    bands: [],
    hearingAsked: [],
    summary: null,
    summaryState: "idle",
    warm: { done: 0, total: 0, ready: [] },
    usage: {
      sttSeconds: 0,
      voiceSeconds: 0,
      spokenSentences: 0,
      candidateRequests: 0,
      inputCharacters: 0,
      textInputTokens: 0,
      textOutputTokens: 0,
      requests: 0,
      warmVoices: 0,
    },
    metrics: {
      roundTrips: [],
      taps: [],
      turns: [],
      candidateRequests: [],
      candidateBatches: [],
      captionCommits: [],
      captionFinals: [],
      playbacks: [],
    },
    keyError: false,
    platform: "Google Meet",
  };
}
export class Session {
  constructor({
    emit = () => {},
    page = () => {},
    cache = new VoiceCache(),
    capture = new AudioCapture(),
  } = {}) {
    this.emit = emit;
    this.sendPage = page;
    this.cache = cache;
    this.capture = capture;
    this.local = new LocalPlayer();
    this.s = blankState();
    this.cfg = configWith();
    this.savedCfg = this.cfg;
    this.job = null;
    this.jobs = new Map();
    this.syntheses = new Map();
    this.sequence = 0;
    this.turn = 0;
    this.summaryAbort = null;
    this.lineOrder = 0;
    this.speakerTimeline = new SpeakerTimeline();
    this.speakerEpoch = 0;
    this.speculateReplies = true;
    this.backgroundWaiters = new Set();
    this.backgroundPauseVersion = 0;
    this.pendingFinalize = new Set();
    this.interval = setInterval(() => this.tick(), 250);
    this.expiryTimer = setInterval(
      () => this.cache.expire().catch(() => {}),
      60000,
    );
  }
  async init(cfg, recover) {
    this.cfg = configWith(cfg);
    this.savedCfg = this.cfg;
    await this.cache.open();
    if (this.cfg.keepLogDays === 0) await this.cache.clearLogs();
    if (recover) {
      this.s = {
        ...blankState(),
        lines: recover.lines || [],
        hearingAsked: recover.hearingAsked || [],
        ended: true,
      };
      this.band(
        "offscreen",
        "bad",
        "音声の接続が止まりました。記録を残して再接続します。",
        "start",
      );
    }
    this.publish();
  }
  snapshot() {
    return {
      ...structuredClone(this.s),
      cfg: publicConfig(this.savedCfg),
      status: statusView(this.s),
    };
  }
  publish() {
    if (
      this.s.active &&
      this.s.sttState === "ready" &&
      this.s.voiceState === "ready" &&
      pageCanSend(this.s.page)
    )
      this.s.connectedOnce = true;
    this.emit({ type: "snapshot", state: this.snapshot() });
  }
  progress() {
    this.emit({
      type: "progress",
      patch: {
        speaking: this.s.speaking ? { ...this.s.speaking } : null,
        typingAt: this.s.typingAt,
        waitSince: this.s.waitSince,
        fillerAt: this.s.fillerAt,
      },
    });
  }
  band(id, tone, text, action, extra = {}) {
    const old = this.s.bands.find((b) => b.id === id);
    this.s.bands = this.s.bands.filter((b) => b.id !== id);
    this.s.bands.push({
      id,
      tone,
      text,
      action,
      since: old?.since || now(),
      ...extra,
    });
    this.publish();
  }
  clearBand(id, recovered = false) {
    const old = this.s.bands.find((b) => b.id === id);
    this.s.bands = this.s.bands.filter((b) => b.id !== id);
    if (old && recovered) {
      this.s.lines.push({
        id: uid(),
        who: "system",
        at: now(),
        order: ++this.lineOrder,
        text: `${new Date(old.since).toLocaleTimeString("ja-JP")}〜${new Date().toLocaleTimeString("ja-JP")} の字幕はありません（再接続）`,
        gap: true,
      });
      const text = `字幕が復帰しました（${new Date(old.since).toLocaleTimeString("ja-JP")}〜${new Date().toLocaleTimeString("ja-JP")}）`;
      this.s.bands.push({
        id: id + "-recovered",
        tone: "waiting",
        text,
        expires: now() + 3000,
      });
    }
    this.publish();
  }
  connection(which, state, detail, info = {}) {
    this.s[which + "State"] = state;
    if (/auth|api_key|invalid_key/.test(info.code || "")) {
      this.s.keyError = true;
      this.stopSpeaking();
      this.stt?.close();
      this.main?.close();
      this.pre?.close();
      this.s.sttState = this.s.voiceState = this.s.preState = "failed";
      this.clearBandQuiet("stt");
      this.clearBandQuiet("voice");
      this.publish();
      return;
    }
    if (
      which === "stt" &&
      ["reconnecting", "failed", "error"].includes(state)
    ) {
      this.band(
        "stt",
        state === "failed" ? "bad" : "warn",
        state === "failed"
          ? info.attempt >= 3
            ? "字幕が止まっています。自動で再試行しています"
            : detail || "字幕が止まっています。やり直してください"
          : reconnectSttText(info.attempt),
        state === "failed" ? "reconnect" : null,
      );
    } else if (which === "stt" && state === "ready")
      this.clearBand("stt", true);
    if (which === "voice" && state === "failed")
      this.band(
        "voice",
        this.s.preState === "ready" ? "warn" : "bad",
        this.s.preState === "ready"
          ? "声の接続が切れました。予備の接続で送ります"
          : detail || "声を送れません。再接続してください",
        "reconnect",
      );
    else if (which === "voice" && state === "ready") this.clearBand("voice");
    this.publish();
  }
  makeSpeakers() {
    this.main?.close();
    this.pre?.close();
    this.main = new Speaker(this.cfg, {
      onState: (s, d, info) => this.connection("voice", s, d, info),
      onUsage: (u) => this.usage(u, "voice"),
    });
    this.pre = new Speaker(this.cfg, {
      onState: (s, d, info) => this.connection("pre", s, d, info),
      onUsage: (u) => this.usage(u, "voice"),
    });
    this.main.connect();
    this.pre.connect();
  }
  usage(u, kind = "text") {
    if (!u) return;
    if (kind === "text") {
      this.s.usage.textInputTokens += u.prompt_tokens || u.input_tokens || 0;
      this.s.usage.textOutputTokens +=
        u.completion_tokens || u.output_tokens || 0;
    }
    this.publish();
  }
  async start(streamId, { test = false } = {}) {
    if (this.s.active) return;
    if (
      this.cfg.voice !== this.savedCfg.voice ||
      this.cfg.style !== this.savedCfg.style
    )
      await this.cache.clearVoices();
    this.cfg = this.savedCfg;
    if (!this.cfg.apiKey) throw new Error("API キーを設定してください");
    this.summaryAbort?.abort();
    const previousLines = this.s.ended ? this.s.lines : [];
    this.s = {
      ...blankState(),
      page: this.s.page,
      platform: this.s.platform,
      lines: previousLines,
    };
    this.s.active = true;
    this.s.id = uid();
    this.s.startedAt = now();
    this.speakerTimeline.clear();
    this.turn++;
    this.filled = false;
    this.sentTurn = false;
    this.s.keyError = false;
    this.makeTranscriber();
    this.vad = new VAD(
      {
        onStart: () => this.otherStart(),
        onResume: () => this.otherResume(),
        onFrame: (pcm) => this.stt.append(pcm),
        onCommit: (meta) => {
          const committedAt = now();
          const id = this.stt.commit({
            ...this.captionMetadata(meta),
            turn: this.turn,
            order: ++this.lineOrder,
            committedAt,
          });
          this.s.metrics.captionCommits.push({
            id,
            turn: this.turn,
            reason: meta.reason,
            committedAt,
          });
          if (meta.reason === "pause") {
            this.pauseDraftTurn = this.turn;
            this.prepareTentative();
          }
        },
        onTurnEnd: () => this.otherEnd(),
      },
      this.cfg.sensitivity,
    );
    this.makeSpeakers();
    this.sendPage({ type: "sendMic", value: this.cfg.sendMic });
    try {
      if (!test)
        await this.capture.start(
          streamId,
          (frame) => this.feed(frame),
          this.cfg,
        );
    } catch {
      await this.stop(false);
      this.band(
        "capture",
        "bad",
        this.cfg.useLocalMic
          ? "マイクの許可が必要です。設定から許可してください"
          : "会議タブの音を取得できません。会議タブで拡張アイコンを押し直してください",
        "start",
      );
      throw new Error("音の取得を開始できませんでした");
    }
    this.clearBand("capture");
    this.clearBand("offscreen");
    this.prewarm();
    this.publish();
  }
  feed(frame) {
    if (!this.cfg.useLocalMic && !this.s.page.streams)
      this.noStreamsSince ||= now();
    else this.noStreamsSince = 0;
    if (
      this.s.active &&
      !this.navigationPaused &&
      (!this.noStreamsSince || now() - this.noStreamsSince < 3000)
    )
      this.vad.feed(frame);
  }
  navigation(paused) {
    this.navigationPaused = paused;
    if (paused) {
      this.speakerTimeline.clear();
      this.stopSpeaking();
      this.stt?.close();
      this.s.sttState = "idle";
      this.vad?.reset?.();
    } else if (this.s.active && this.stt?.closed) this.stt.reconnect();
    this.publish();
  }
  makeTranscriber() {
    this.stt?.close();
    this.stt = new Transcriber(this.cfg, {
      onState: (s, d, info) => this.connection("stt", s, d, info),
      onCommitted: (id, meta) => {
        this.s.usage.sttSeconds += meta.seconds;
      },
      onDelta: (id, text, meta) => this.caption(id, text, true, meta),
      onFinal: (id, text, meta) => this.caption(id, text, false, meta),
      onLost: (ids) => {
        this.s.lines = this.s.lines.filter(
          (l) => !l.partial || !ids.includes(l.id),
        );
        this.publish();
      },
    });
    this.stt.connect();
  }
  otherStart() {
    this.turn++;
    this.filled = false;
    this.sentTurn = false;
    this.s.otherSpeaking = true;
    this.s.waitSince = 0;
    this.pauseDraftTurn = null;
    this.invalidateSuggestion("speech-started");
    if (this.job && this.cfg.autoStopOnBargeIn) this.stopSpeaking();
    this.publish();
  }
  otherResume() {
    this.pauseDraftTurn = null;
    this.invalidateSuggestion("speech-resumed");
    this.s.otherSpeaking = true;
    this.publish();
  }
  otherEnd() {
    this.s.otherSpeaking = false;
    this.s.waitSince = now();
    this.lastSpeechEnd = now() - 1500;
    this.turnTiming = {
      turn: this.turn,
      endedAt: now(),
      tentativeReady:
        this.tentative?.length === 3 && this.replySet?.confirmed === true,
      tentativeFirstReady:
        !!this.tentative?.length && this.replySet?.confirmed === true,
      draftReady: this.tentative?.length === 3,
      requestId: this.tentativeRequest?.id ?? this.replySet?.timing.id ?? null,
    };
    this.s.metrics.turns.push(this.turnTiming);
    if (!this.tentative) this.s.candidateState = "thinking";
    this.publish();
    if (this.tentative && this.replySet?.confirmed)
      this.showCandidates(this.tentative);
    // A final transcript may arrive after VAD ends. Do not generate from the
    // previous turn only to abort and replace it when that transcript arrives.
    else if (!this.suggestAbort && this.lastFinalTurn === this.turn)
      this.suggest("turn-end");
  }
  caption(id, text, partial, meta) {
    if (!this.s.active) return;
    let line = this.s.lines.find((l) => l.id === id);
    if (!line) {
      line = {
        id,
        who: "other",
        at: now(),
        order: meta?.order || ++this.lineOrder,
        text: "",
        partial,
        turn: meta?.turn ?? this.turn,
        firstDeltaAt: partial ? now() : null,
        audioStartedAt: meta?.audioStartedAt,
        audioEndedAt: meta?.audioEndedAt,
        speaker:
          this.cfg.showSpeakerNames &&
          !this.cfg.useLocalMic &&
          meta?.speakerEpoch === this.speakerEpoch
            ? speakerName(meta?.speaker)
            : "",
      };
      this.s.lines.push(line);
    }
    line.text = text;
    line.partial = partial;
    if (partial) line.lastDeltaAt = now();
    this.s.lines.sort((a, b) => a.order - b.order);
    if (partial) this.prepareTentative();
    else {
      if (!text.trim()) this.s.lines = this.s.lines.filter((l) => l !== line);
      else {
        this.s.metrics.captionFinals.push({
          id,
          turn: line.turn,
          committedAt: meta?.committedAt ?? meta?.sentAt ?? null,
          firstDeltaAt: line.firstDeltaAt,
          finalAt: now(),
        });
        this.lastFinalTurn = line.turn;
        if (line.turn === this.turn) this.suggest("caption-final");
      }
    }
    this.publish();
  }
  captionMetadata(meta) {
    return {
      ...meta,
      speakerEpoch: this.speakerEpoch,
      speaker:
        this.cfg.showSpeakerNames && !this.cfg.useLocalMic
          ? this.speakerTimeline.dominant(
              meta.audioStartedAt,
              meta.audioEndedAt,
            )
          : "",
    };
  }
  prepareTentative() {
    if (
      !this.speculateReplies ||
      this.pauseDraftTurn !== this.turn ||
      this.replySet
    )
      return;
    const draft = this.s.lines.findLast(
      (l) =>
        l.who === "other" &&
        l.partial &&
        l.turn === this.turn &&
        l.text.trim().length >= 6,
    );
    if (draft) this.suggest("pause-draft", draft.id);
  }
  invalidateSuggestion(reason = "invalidated") {
    if (this.replySet) this.replySet.timing.invalidatedBy = reason;
    this.suggestAbort?.abort();
    this.suggestAbort = null;
    this.tentative = null;
    this.tentativeRequest = null;
    this.replySet = null;
    this.s.candidateStreaming = false;
    if (this.s.candidateState === "thinking")
      this.s.candidateState = this.s.candidates.length ? "ready" : "empty";
    this.sequence++;
    for (const entry of this.syntheses.values())
      if (entry.kind === "candidate" && !entry.adopted)
        this.cancelSynthesis(entry);
  }
  async suggest(trigger = "manual", draftId = null) {
    const lines = draftId
      ? this.s.lines.map((l) =>
          l.id === draftId ? { ...l, partial: false } : l,
        )
      : this.s.lines;
    if (!this.s.active || !lines.some((l) => l.who === "other" && !l.partial))
      return;
    const keyFor = (context) =>
      JSON.stringify(
        context
          .filter((l) => l.text && !l.partial && !l.failed && !l.gap)
          .slice(-24)
          .map((l) => [
            l.who,
            l.speaker || "",
            normalizeSpeech(l.text),
            !!l.interrupted,
          ]),
      );
    const contextKey = keyFor(lines);
    let reusableDraft = false;
    const previous = this.replySet;
    if (
      trigger === "caption-final" &&
      previous?.draftId &&
      !previous.confirmed
    ) {
      const final = lines.find((l) => l.id === previous.draftId && !l.partial);
      if (final) {
        const check = draftReuse(previous.draftText, final.text);
        previous.timing.reuseCheck = check;
        previous.timing.finalText = final.text;
        reusableDraft =
          check.match &&
          keyFor(
            lines.map((l) =>
              l.id === previous.draftId
                ? { ...l, text: previous.draftText }
                : l,
            ),
          ) === previous.key;
      }
    }
    if (
      trigger !== "manual" &&
      ((this.replySet?.key === contextKey && !this.replySet?.draftId) ||
        reusableDraft ||
        (this.replySet?.key === contextKey && this.replySet?.confirmed)) &&
      this.replySet.seq === this.sequence
    ) {
      if (!draftId && !this.replySet.confirmed) {
        this.replySet.confirmed = true;
        this.replySet.key = contextKey;
        Object.assign(this.replySet.timing, {
          confirmedAt: now(),
          reusedDraft: true,
        });
        if (this.replySet.replies.length && !this.s.otherSpeaking)
          this.showCandidates(this.replySet.replies);
      }
      return;
    }
    this.invalidateSuggestion(
      trigger === "caption-final" ? "caption-changed" : trigger,
    );
    const seq = this.sequence,
      abort = (this.suggestAbort = new AbortController());
    const timing = {
      id: uid(),
      turn: this.turn,
      startedAt: now(),
      status: "pending",
      trigger,
      provisional: !!draftId,
      draftText: draftId ? lines.find((l) => l.id === draftId)?.text : null,
      captionFinalAt: this.s.metrics.captionFinals.at(-1)?.finalAt ?? null,
      captionCommittedAt:
        this.s.metrics.captionFinals.at(-1)?.committedAt ?? null,
    };
    this.s.metrics.candidateRequests.push(timing);
    const set = (this.replySet = {
      seq,
      key: contextKey,
      replies: [],
      timing,
      confirmed: !draftId,
      draftId,
      draftText: timing.draftText,
      nextPrefetch: 0,
      ready: new Set(),
      prefetching: false,
    });
    const receive = (replies) => {
      if (seq !== this.sequence || !this.s.active) return;
      timing.firstAt ??= now();
      if (replies.length === 3) timing.threeAt ??= now();
      set.replies = replies;
      timing.replies = [...replies];
      this.tentativeRequest = timing;
      this.tentative = replies;
      if (!this.s.otherSpeaking && set.confirmed) this.showCandidates(replies);
      else this.prefetch(seq);
    };
    this.s.candidateState =
      this.s.otherSpeaking && this.s.candidates.length ? "ready" : "thinking";
    this.publish();
    try {
      this.s.usage.requests++;
      this.s.usage.candidateRequests++;
      const questions = this.cfg.hearing.filter(
        (_, i) => !this.s.hearingAsked.includes(i),
      );
      const replies = await suggestReplies(
        this.cfg,
        lines,
        questions,
        abort.signal,
        (u) => this.usage(u),
        receive,
      );
      timing.completedAt = now();
      timing.elapsedMs = timing.completedAt - timing.startedAt;
      if (seq !== this.sequence || !this.s.active) {
        timing.status = "discarded";
        return;
      }
      timing.status = "ready";
      receive(replies);
    } catch (e) {
      timing.status = abort.signal.aborted ? "aborted" : "failed";
      timing.completedAt = now();
      timing.elapsedMs = timing.completedAt - timing.startedAt;
      if (abort.signal.aborted) return;
      if (seq !== this.sequence) return;
      this.invalidateSuggestion();
      this.s.candidateState = "failed";
      this.publish();
    } finally {
      timing.completedAt ??= now();
      timing.elapsedMs = timing.completedAt - timing.startedAt;
      if (this.suggestAbort === abort) this.suggestAbort = null;
    }
  }
  showCandidates(replies) {
    const turn = this.turnTiming?.turn === this.turn ? this.turnTiming : null;
    const request = this.tentativeRequest;
    let batch = this.s.metrics.candidateBatches.at(-1);
    const existing = request && batch?.requestId === request.id;
    if (!existing) {
      batch = {
        id: uid(),
        turn: this.turn,
        readyAt: now(),
        turnEndedAt: turn?.endedAt ?? null,
        turnToFirstCandidateMs: turn ? now() - turn.endedAt : null,
        turnToCandidatesMs: null,
        tentativeReadyAtTurnEnd: turn?.tentativeReady ?? null,
        tentativeFirstReadyAtTurnEnd: turn?.tentativeFirstReady ?? null,
        requestId: request?.id ?? null,
      };
      this.s.metrics.candidateBatches.push(batch);
      this.s.candidates = [];
      this.s.candidatesRead = false;
    }
    if (replies.length === 3) {
      batch.allReadyAt ??= now();
      batch.turnToCandidatesMs = turn ? batch.allReadyAt - turn.endedAt : null;
    }
    Object.assign(batch, {
      count: replies.length,
      requestStartedAt: request?.startedAt ?? null,
      requestFirstAt: request?.firstAt ?? null,
      requestThreeAt: request?.threeAt ?? null,
      requestCompletedAt: request?.completedAt ?? null,
      requestElapsedMs: request?.elapsedMs ?? null,
      reusedDraft: !!request?.reusedDraft,
      replies: [...replies],
    });
    this.tentative = null;
    this.s.candidates = replies.map((text, i) =>
      this.s.candidates[i]?.text === text
        ? this.s.candidates[i]
        : { text, ready: this.replySet?.ready.has(text) || false },
    );
    this.s.candidateState = "ready";
    this.s.candidateStreaming = replies.length < 3;
    this.publish();
    this.prefetch(this.sequence);
  }
  async prefetch(seq) {
    const set = this.replySet;
    if (!set || set.seq !== seq || set.prefetching) return;
    set.prefetching = true;
    try {
      while (
        set.nextPrefetch <
        Math.min(this.cfg.prefetchCandidates, set.replies.length)
      ) {
        await this.waitForBackground();
        if (seq !== this.sequence || !this.s.active) return;
        const pauseVersion = this.backgroundPauseVersion;
        const text = set.replies[set.nextPrefetch];
        const result = await this.synthesizeCached(text, false, seq);
        if (seq !== this.sequence || !this.s.active) return;
        if (!result && pauseVersion !== this.backgroundPauseVersion) continue;
        set.nextPrefetch++;
        if (result) set.ready.add(text);
        const candidate = this.s.candidates.find((c) => c.text === text);
        if (candidate) candidate.ready = !!result;
        this.publish();
      }
    } catch {
    } finally {
      set.prefetching = false;
    }
  }
  async waitForBackground() {
    while (this.job && !this.s.ended)
      await new Promise((resolve) => this.backgroundWaiters.add(resolve));
  }
  releaseBackground() {
    for (const resolve of this.backgroundWaiters) resolve();
    this.backgroundWaiters.clear();
  }
  pauseBackground(keep) {
    this.backgroundPauseVersion++;
    for (const entry of [...this.syntheses.values()])
      if (entry !== keep && !entry.adopted) this.cancelSynthesis(entry);
  }
  runningSynthesis(key) {
    const entry = this.syntheses.get(key);
    return entry &&
      !entry.cancelled &&
      !entry.speaker.closed &&
      entry.generation === this.voiceGeneration
      ? entry
      : null;
  }
  cancelSynthesis(entry) {
    if (entry.cancelled) return;
    entry.cancelled = true;
    if (this.syntheses.get(entry.key) === entry)
      this.syntheses.delete(entry.key);
    entry.speaker.cancelAll(entry.tag);
  }
  async generateSpeech(source, sink) {
    const texts = splitSpeech(source.text),
      chunks = [];
    source.segments = [];
    let transcript = "",
      seconds = 0,
      final;
    const finish = (status, error) => {
      if (!final) {
        final = { status, error, transcript, seconds, chunks };
        sink.end(final);
      }
      return final;
    };
    for (let i = 0; i < texts.length; i++) {
      if (source.cancelled) return finish("cancelled");
      const part = { text: texts[i], startedAt: now(), audioSeconds: 0 };
      source.segments.push(part);
      let ended = false;
      const end = (result) => {
        if (ended) return;
        ended = true;
        part.finishedAt = now();
        part.status = result.status;
        transcript += result.transcript || "";
        seconds += result.seconds || 0;
        sink.transcript(transcript);
        sink.segmentEnd?.(part);
        if (result.status !== "completed" || i === texts.length - 1)
          finish(source.cancelled ? "cancelled" : result.status, result.error);
      };
      try {
        const result = await source.speaker.speak(texts[i], {
          tag: source.tag,
          pcm: (audio) => {
            if (source.cancelled || ended) return;
            observeGeneration(part, b64ToInt16(audio).length / 24000);
            chunks.push(audio);
            sink.pcm(audio);
          },
          transcript: (text) => sink.transcript(transcript + text),
          end,
        });
        end(result); // Queue cancellation / connection failure may omit end.
      } catch {
        end({ status: "failed", error: "声を生成できませんでした" });
      }
      if (final) return final;
    }
  }
  generationMetrics(job) {
    const source = job.synthesis || job;
    const segments = source.segments || job.cachedGenerations || [];
    return segments.map((part) => ({
      text: part.text,
      startedAt: part.startedAt,
      firstPcmAt: part.firstPcmAt ?? null,
      firstPcmMs:
        part.firstPcmAt == null ? null : part.firstPcmAt - part.startedAt,
      lastPcmAt: part.lastPcmAt ?? null,
      finishedAt: part.finishedAt ?? null,
      audioSeconds: part.audioSeconds,
      observedMs:
        part.firstPcmAt == null ? 0 : part.lastPcmAt - part.firstPcmAt,
      rate:
        part.rate ??
        generationRate(
          part,
          part.finishedAt ? part.lastPcmAt : now(),
          part.finishedAt ? 0 : 300,
        ),
      status: part.status || "generating",
    }));
  }
  armPlaybackWatchdog(job) {
    clearTimeout(job.watchdog);
    if (job.played || job.cancelled || job.finalized) return;
    job.watchdog = setTimeout(() => this.playbackFailed(job), 20000);
  }
  playbackFailed(job) {
    if (this.job !== job || job.cancelled || job.finalized) return;
    this.stopSpeaking();
    this.band(
      "playback",
      "bad",
      "会議へ声を送れませんでした。会議のマイクを確認してください",
      "reconnect",
    );
  }
  async synthesizeCached(text, persistent = false, sequence = this.sequence) {
    const generation = this.voiceGeneration;
    const valid = () =>
      generation === this.voiceGeneration &&
      (persistent || (sequence === this.sequence && this.s.active));
    const key = await voiceKey(this.cfg, text);
    await this.waitForBackground();
    if (!valid()) return null;
    let entry = this.runningSynthesis(key);
    if (entry) {
      if (persistent) {
        entry.persistent = true;
        entry.kind = "warm";
      }
      return entry.promise;
    }
    const cached = await this.cache.get(key);
    await this.waitForBackground();
    if (!valid()) return null;
    if (cached) return cached;
    // Another caller may have started synthesis while the cache read awaited IDB.
    entry = this.runningSynthesis(key);
    if (entry) {
      if (persistent) {
        entry.persistent = true;
        entry.kind = "warm";
      }
      return entry.promise;
    }
    entry = {
      key,
      text,
      speaker: this.pre,
      tag: "synthesis:" + uid(),
      kind: persistent ? "warm" : "candidate",
      persistent,
      generation,
      chunks: [],
      audioSeconds: 0,
      transcript: "",
      subscribers: new Set(),
      result: null,
      adopted: false,
      cancelled: false,
    };
    this.syntheses.set(key, entry);
    const finish = (result) => {
      if (entry.result) return;
      entry.result = result;
      entry.transcript = result.transcript || "";
      this.s.usage.voiceSeconds += result.seconds || 0;
      for (const sink of entry.subscribers) sink.end(result);
      entry.subscribers.clear();
    };
    this.s.usage.inputCharacters += text.length;
    entry.promise = this.generateSpeech(entry, {
      pcm: (audio) => {
        if (entry.cancelled) return;
        const seconds = b64ToInt16(audio).length / 24000;
        observeGeneration(entry, seconds);
        entry.chunks.push(audio);
        for (const sink of entry.subscribers) sink.pcm(audio);
      },
      transcript: (text) => {
        entry.transcript = text;
        for (const sink of entry.subscribers) sink.transcript(text);
      },
      segmentEnd: () => {
        for (const sink of entry.subscribers) sink.segmentEnd();
      },
      end: finish,
    })
      .then(async (result) => {
        // Queued cancellation and connection failure can resolve without sink.end.
        finish(result);
        if (
          entry.cancelled ||
          entry.generation !== this.voiceGeneration ||
          result.status !== "completed" ||
          !speechMatches(text, result.transcript) ||
          !result.chunks.length
        )
          return null;
        const value = {
          chunks: result.chunks,
          transcript: result.transcript,
          seconds: result.seconds,
          generations: this.generationMetrics({ synthesis: entry }),
          created: now(),
        };
        await this.cache.put(key, value, entry.persistent);
        if (entry.persistent) {
          this.s.usage.warmVoices = (this.s.usage.warmVoices || 0) + 1;
          this.publish();
        }
        return value;
      })
      .finally(() => {
        if (this.syntheses.get(key) === entry) this.syntheses.delete(key);
      });
    return entry.promise;
  }
  speechSink(job, countUsage = true) {
    return {
      pcm: (audio) => {
        if (this.job !== job || job.cancelled) return;
        observeGeneration(job, b64ToInt16(audio).length / 24000);
        job.chunks.push(audio);
        this.armPlaybackWatchdog(job);
        if (!job.replaying) this.flushSpeech(job);
      },
      transcript: (text) => {
        if (!job.finalized) job.transcript = text;
      },
      segmentEnd: () => this.flushSpeech(job),
      end: (result) => {
        if (job.result) return;
        job.result = result;
        job.transcript = result.transcript;
        if (countUsage) this.s.usage.voiceSeconds += result.seconds || 0;
        if (this.job === job && !job.cancelled) {
          if (result.status === "completed" && job.chunks.length) {
            this.flushSpeech(job, true);
            this.sendPage({ type: "end", id: job.id });
          } else {
            this.sendPage({ type: "stop" });
            if (result.status === "completed")
              job.result = { ...result, status: "failed" };
          }
        }
        // No PCM sent means there is no page job that could emit play-end.
        if (!job.sentChunks)
          job.playEnd ||= { stopped: true, elapsed: 0, underrunMs: 0 };
        this.tryFinalize(job);
      },
    };
  }
  flushSpeech(job, completed = false) {
    if (this.job !== job || job.cancelled || !job.chunks.length) return;
    if (!job.bufferStarted) {
      const source = job.synthesis || job;
      const part = source.segments?.[0] || source;
      const plan = playbackBufferPlan(part.text || job.text, {
        seconds: job.audioSeconds || 0,
        rate: generationRate(
          part,
          part.status === "completed" ? part.lastPcmAt : now(),
        ),
        completed: completed || part.status === "completed",
        waitedMs: now() - job.tapped,
      });
      clearTimeout(job.bufferTimer);
      if (!plan.ready) {
        const observationAt = (part.firstPcmAt ?? now()) + 300;
        const next =
          observationAt > now()
            ? Math.min(observationAt, job.tapped + 2000)
            : job.tapped + 2000;
        job.bufferTimer = setTimeout(
          () => this.flushSpeech(job),
          Math.max(1, next - now()),
        );
        return;
      }
      job.bufferStarted = true;
      job.buffering = {
        ...plan,
        initialBufferMs: job.audioSeconds * 1000,
        releasedAt: now(),
      };
      // PCM is available and handed off; a missing page acknowledgement is a
      // different failure from a slow, but still progressing, generator.
      job.ackTimer = setTimeout(() => {
        if (!job.played) this.playbackFailed(job);
      }, 5000);
    }
    while ((job.sentChunks || 0) < job.chunks.length) {
      const audio = job.chunks[job.sentChunks || 0];
      job.sentChunks = (job.sentChunks || 0) + 1;
      this.sendPage({ type: "pcm", id: job.id, audio });
    }
  }
  joinSynthesis(job, entry) {
    entry.adopted = true;
    job.source = "joined";
    job.synthesis = entry;
    job.speaker = entry.speaker;
    job.tag = entry.tag;
    job.bufferedChunks = entry.chunks.length;
    job.bufferedAudioMs = entry.chunks.reduce(
      (n, audio) => n + b64ToInt16(audio).length / 24,
      0,
    );
    const sink = this.speechSink(job, false);
    // Registration and replay are synchronous: a chunk cannot be lost or repeated.
    entry.subscribers.add(sink);
    job.unsubscribe = () => entry.subscribers.delete(sink);
    job.replaying = true;
    for (const audio of entry.chunks) sink.pcm(audio);
    job.replaying = false;
    this.flushSpeech(job, entry.result?.status === "completed");
    sink.transcript(entry.transcript);
    if (entry.result) {
      sink.end(entry.result);
      job.unsubscribe();
    }
  }
  async prewarm() {
    if (!this.cfg.apiKey) return;
    if (!this.pre || this.pre.closed) this.makeSpeakers();
    const token = (this.warmToken = uid());
    const texts = warmTexts(this.cfg);
    this.s.warm = { done: 0, total: texts.length, ready: [] };
    this.publish();
    for (const text of texts) {
      let retry;
      do {
        await this.waitForBackground();
        if (token !== this.warmToken) return;
        const pauseVersion = this.backgroundPauseVersion;
        retry = false;
        try {
          const result = await this.synthesizeCached(text, true);
          if (token !== this.warmToken) return;
          if (result) {
            this.s.warm.done++;
            this.s.warm.ready = [...this.s.warm.ready, text];
          } else retry = pauseVersion !== this.backgroundPauseVersion;
        } catch {}
      } while (retry);
      this.publish();
    }
    if (token !== this.warmToken) return;
    this.warmToken = null;
    try {
      const keep = new Set(
        await Promise.all(texts.map((text) => voiceKey(this.cfg, text))),
      );
      await this.cache.prune?.(keep);
    } catch {}
  }
  async say(text, kind = "type") {
    text = String(text || "")
      .trim()
      .slice(0, 4000);
    if (!text) return false;
    if (!canSend(this.s)) {
      this.emit({
        type: "notice",
        tone: "bad",
        text: pageMuted(this.s.page)
          ? "会議でミュート中です。会議側で解除してください"
          : "会議のマイクに接続してから話してください",
      });
      return false;
    }
    this.stopSpeaking();
    const job = (this.job = {
      id: uid(),
      text,
      kind,
      tapped: now(),
      chunks: [],
      transcript: "",
      result: null,
      playEnd: null,
      played: false,
      elapsed: 0,
      cancelled: false,
      source: "fresh",
      candidateBatchId:
        kind === "candidate"
          ? this.s.metrics.candidateBatches.at(-1)?.id
          : null,
    });
    this.jobs.set(job.id, job);
    this.s.speaking = { id: job.id, text, preparing: true, level: 0 };
    this.armPlaybackWatchdog(job);
    job.bufferTimer = setTimeout(() => this.flushSpeech(job), 2000);
    this.publish();
    const key = await voiceKey(this.cfg, text);
    let cached,
      entry = this.runningSynthesis(key);
    if (!entry) {
      try {
        cached = await this.cache.get(key);
      } catch {}
      entry = this.runningSynthesis(key);
    }
    if (this.job !== job || job.cancelled) return false;
    this.pauseBackground(entry);
    if (entry) this.joinSynthesis(job, entry);
    else if (cached) {
      job.cached = true;
      job.source = "cached";
      job.cachedGenerations = cached.generations;
      const sink = this.speechSink(job, false);
      job.replaying = true;
      for (const audio of cached.chunks) sink.pcm(audio);
      job.replaying = false;
      sink.end({ ...cached, status: "completed" });
    } else {
      this.s.usage.inputCharacters += text.length;
      let speaker = this.main;
      if (
        (!this.main.ready || this.main.draining) &&
        this.s.preState === "ready"
      ) {
        this.pre.cancelAll();
        speaker = this.pre;
      }
      job.speaker = speaker;
      job.tag = job.id;
      const sink = this.speechSink(job);
      this.generateSpeech(job, sink).then(sink.end);
    }
    return true;
  }
  pageEvent(m) {
    if (m.type === "speakers") {
      if (
        this.s.active &&
        !this.navigationPaused &&
        this.cfg.showSpeakerNames &&
        !this.cfg.useLocalMic
      )
        this.speakerTimeline.add(m);
      return;
    }
    if (m.type === "status") {
      const signature = JSON.stringify(m);
      if (this.lastPageStatus === signature) return;
      this.s.page = m;
      // MAIN-world reports are observable/spoofable. They gate new sends and
      // inform the UI, but never cancel an extension-owned synthesis job.
      if (m.streams && m.context === "suspended")
        this.band(
          "suspended",
          "warn",
          "会議の画面を一度クリックすると声を送れます",
        );
      else this.clearBandQuiet("suspended");
      if (m.streams) this.clearBandQuiet("meeting");
      this.lastPageStatus = signature;
      this.publish();
    }
    if (m.type === "ready") {
      this.sendPage({ type: "sendMic", value: this.cfg.sendMic });
    }
    const job = this.jobs.get(m.id);
    if (!job) return;
    if (m.type === "play-start") {
      if (job.played || job.cancelled || job.finalized) return;
      job.played = true;
      job.playStartedAt = now();
      this.sentTurn = true;
      this.s.candidatesRead = true;
      if (job.kind === "filler") this.s.fillerAt = now();
      clearTimeout(job.watchdog);
      clearTimeout(job.ackTimer);
      const ms = now() - job.tapped;
      this.s.metrics.taps.push({
        id: job.id,
        ms,
        cached: !!job.cached,
        source: job.source,
        kind: job.kind,
        tappedAt: job.tapped,
        playStartedAt: now(),
        tapToFirstPcmMs:
          job.firstPcmAt == null ? null : job.firstPcmAt - job.tapped,
        bufferedChunks: job.bufferedChunks || 0,
        bufferedAudioMs: job.bufferedAudioMs || 0,
        buffering: job.buffering,
        generations: this.generationMetrics(job),
        candidateBatchId: job.candidateBatchId,
      });
      if (job.kind === "candidate" && this.lastSpeechEnd)
        this.s.metrics.roundTrips.push(now() - this.lastSpeechEnd);
      if (this.job === job && this.s.speaking)
        this.s.speaking.preparing = false;
      this.publish();
    } else if (m.type === "play-progress") {
      job.elapsed = m.elapsed;
      if (this.job === job && this.s.speaking && !job.cancelled) {
        this.s.speaking.level = m.level;
        if (job.played) this.s.speaking.preparing = !!m.preparing;
      }
      this.progress();
    } else if (m.type === "play-end") {
      job.playEnd = m;
      if (m.stopped) this.cancelJob(job);
      this.tryFinalize(job);
    }
  }
  clearBandQuiet(id) {
    this.s.bands = this.s.bands.filter((b) => b.id !== id);
  }
  stopSpeaking() {
    const job = this.job;
    if (!job) return;
    this.sendPage({ type: "stop" });
    this.cancelJob(job);
  }
  cancelJob(job) {
    if (job.finalized || job.cancelled) return;
    job.cancelled = true;
    clearTimeout(job.bufferTimer);
    clearTimeout(job.watchdog);
    clearTimeout(job.ackTimer);
    // A late report for an older playback must not cancel the next response.
    job.unsubscribe?.();
    if (job.synthesis) this.cancelSynthesis(job.synthesis);
    else job.speaker?.cancelAll(job.tag || job.id);
    job.cancelFallback = setTimeout(() => {
      if (this.jobs.has(job.id)) {
        job.playEnd ||= { stopped: true, elapsed: job.elapsed };
        job.result ||= { status: "cancelled", transcript: job.transcript };
        this.tryFinalize(job);
      }
    }, 500);
    this.tryFinalize(job);
  }
  tryFinalize(job) {
    if (job.finalized || !job.result || !job.playEnd) return;
    job.finalized = true;
    job.unsubscribe?.();
    this.jobs.delete(job.id);
    clearTimeout(job.watchdog);
    clearTimeout(job.bufferTimer);
    clearTimeout(job.ackTimer);
    clearTimeout(job.cancelFallback);
    if (this.job === job) {
      this.job = null;
      this.s.speaking = null;
      this.releaseBackground();
    }
    const underrunMs = job.playEnd.underrunMs || 0;
    this.s.metrics.playbacks.push({
      id: job.id,
      source: job.source,
      requested: job.text,
      status: job.result.status,
      played: job.played,
      underrunMs,
      buffering: job.buffering,
      generations: this.generationMetrics(job),
      tapToFirstPcmMs:
        job.firstPcmAt == null ? null : job.firstPcmAt - job.tapped,
      tapToAudioMs:
        job.playStartedAt == null ? null : job.playStartedAt - job.tapped,
      bufferedSeconds: job.buffering
        ? job.buffering.initialBufferMs / 1000
        : null,
      endedAt: now(),
    });
    const interrupted =
      job.cancelled || job.playEnd.stopped || job.result.status !== "completed";
    if (job.played && !interrupted && job.kind === "hearing") {
      const index = this.cfg.hearing.indexOf(job.text);
      if (index >= 0)
        this.s.hearingAsked = [...new Set([...this.s.hearingAsked, index])];
    }
    if (job.played) {
      this.s.usage.spokenSentences++;
      const line = {
        id: job.id,
        who: "me",
        at: now(),
        order: ++this.lineOrder,
        text: interrupted ? "" : job.result.transcript,
        requested: job.text,
        interrupted,
        mismatch:
          !interrupted && !speechMatches(job.text, job.result.transcript),
        partialUnknown: interrupted,
        verifying: interrupted,
        failed: false,
        underrunMs,
        buffering: job.buffering,
        generations: this.generationMetrics(job),
        tapToFirstPcmMs:
          job.firstPcmAt == null ? null : job.firstPcmAt - job.tapped,
        tapToAudioMs:
          job.playStartedAt == null ? null : job.playStartedAt - job.tapped,
        bufferedSeconds: job.buffering
          ? job.buffering.initialBufferMs / 1000
          : null,
      };
      this.s.lines.push(line);
      if (interrupted) {
        const task = this.transcribePrefix(job, job.playEnd.elapsed || 0)
          .then((text) => {
            line.text = text;
            line.partialUnknown = !text;
            line.verifying = false;
            line.prefixVerification = job.prefixVerification;
            this.publish();
          })
          .catch(() => {
            line.verifying = false;
            this.publish();
          })
          .finally(() => this.pendingFinalize.delete(task));
        this.pendingFinalize.add(task);
      }
    } else if (job.result.status !== "cancelled") {
      this.s.lines.push({
        id: job.id,
        who: "me",
        at: now(),
        order: ++this.lineOrder,
        text: job.text,
        requested: job.text,
        failed: true,
        error: job.result.error || "接続が切れました",
      });
      this.band(
        "voice-output",
        "bad",
        "声を送れませんでした。本文は入力欄からもう一度送れます",
        "reconnect",
      );
    }
    this.publish();
  }
  async transcribePrefix(job, seconds) {
    if (seconds < 0.1) return "";
    let left = Math.max(0, Math.floor((seconds - 0.02) * 24000));
    const chunks = [];
    for (const b of job.chunks) {
      if (!left) break;
      const pcm = b64ToInt16(b),
        part = pcm.subarray(0, Math.min(left, pcm.length));
      chunks.push(int16ToB64(part));
      left -= part.length;
    }
    const data = new FormData();
    data.append("model", "gpt-4o-transcribe");
    data.append("language", "ja");
    data.append(
      "file",
      new Blob([wavBytes(chunks)], { type: "audio/wav" }),
      "interrupted.wav",
    );
    const r = await fetch(API_BASE + "/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + this.cfg.apiKey },
      body: data,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return "";
    const j = await r.json();
    const text = j.text || "";
    const spoken = job.result?.transcript || job.transcript || job.text;
    // A cut-off syllable can make ASR invent a word. Do not record an unsupported
    // phrase as something the user said; leave the existing unknown-range label.
    const verified =
      !!normalizeSpeech(text) &&
      normalizeSpeech(spoken).startsWith(normalizeSpeech(text));
    job.prefixVerification = {
      playedSeconds: seconds,
      samples: chunks.reduce((n, b) => n + b64ToInt16(b).length, 0),
      transcript: text,
      verified,
    };
    return verified ? text : "";
  }
  tick() {
    const count = this.s.bands.length;
    this.s.bands = this.s.bands.filter((b) => !b.expires || b.expires > now());
    if (this.s.active) {
      if (
        !this.cfg.useLocalMic &&
        !this.s.page.streams &&
        !this.navigationPaused &&
        now() - this.s.startedAt >= 3000 &&
        !this.s.bands.some((b) => b.id === "meeting")
      )
        this.band(
          "meeting",
          "bad",
          "会議に参加すると声を送れます。参加してもこの表示が消えないときは、会議のページを再読み込みしてください。",
          "reloadHelp",
        );
      if (
        this.cfg.autoFiller &&
        !this.filled &&
        !this.sentTurn &&
        !this.s.speaking &&
        !this.s.otherSpeaking &&
        this.s.waitSince &&
        now() - this.s.waitSince >= this.cfg.autoFillerSec * 1000 &&
        now() - this.s.typingAt < 2000 &&
        canSend(this.s)
      ) {
        this.filled = true;
        this.say(FILLER, "filler");
      }
      const progressKey = [
        Math.floor((now() - this.s.waitSince) / 1000),
        now() - this.s.typingAt < 2000,
        now() - (this.s.fillerAt || 0) < 3000,
      ].join(":");
      if (progressKey !== this.lastProgressKey) {
        this.lastProgressKey = progressKey;
        this.progress();
      }
    }
    if (count !== this.s.bands.length) this.publish();
  }
  async stop(summary = true) {
    if (!this.s.active) return;
    this.s.active = false;
    this.s.ended = true;
    this.s.endedAt = now();
    this.speakerTimeline.clear();
    this.s.otherSpeaking = false;
    this.s.waitSince = 0;
    this.invalidateSuggestion();
    this.warmToken = null;
    this.releaseBackground();
    this.stopSpeaking();
    await this.capture.stop();
    this.stt?.close();
    this.main?.close();
    this.pre?.close();
    this.previewSpeaker?.close();
    this.local.stop();
    this.s.sttState = "idle";
    this.s.voiceState = "idle";
    this.cache.clearCandidates();
    this.publish();
    if (this.jobs.size) await new Promise((r) => setTimeout(r, 550));
    await Promise.allSettled([...this.pendingFinalize]);
    if (summary) await this.summarize();
  }
  async summarize() {
    this.summaryAbort?.abort();
    const abort = (this.summaryAbort = new AbortController());
    this.s.summaryState = "loading";
    this.s.summaryStarted = now();
    this.publish();
    try {
      this.s.usage.requests++;
      const result = await summarizeHearing(
        this.cfg,
        this.s.lines,
        this.cfg.hearing,
        abort.signal,
        (u) => this.usage(u),
      );
      if (abort.signal.aborted) return;
      this.s.summary = result;
      this.s.summaryState = "ready";
      if (this.cfg.keepLogDays === 7)
        await this.cache.saveLog({
          id: this.s.id || uid(),
          at: now(),
          lines: this.s.lines.filter((l) => !l.failed && !l.partial),
          summary: result,
          usage: this.s.usage,
          startedAt: this.s.startedAt,
          endedAt: this.s.endedAt,
        });
    } catch (e) {
      if (!abort.signal.aborted) this.s.summaryState = "failed";
    }
    this.publish();
  }
  async updateConfig(cfg) {
    const warmingBefore = !!this.warmToken;
    const next = configWith(cfg),
      warmChanged =
        JSON.stringify(warmTexts(next)) !== JSON.stringify(warmTexts(this.cfg)),
      speakerModeChanged =
        next.showSpeakerNames !== this.cfg.showSpeakerNames ||
        next.useLocalMic !== this.cfg.useLocalMic,
      repairKey =
        this.s.active && this.s.keyError && next.apiKey !== this.cfg.apiKey,
      voiceChanged =
        next.voice !== this.cfg.voice || next.style !== this.cfg.style,
      changed =
        next.voice !== this.cfg.voice ||
        next.style !== this.cfg.style ||
        next.apiKey !== this.cfg.apiKey;
    if (
      this.s.hearingAsked.length &&
      JSON.stringify(next.hearing) !== JSON.stringify(this.cfg.hearing)
    ) {
      // 済みの印は文で引き継ぐ（並べ替え・削除で番号がずれても、聞いた質問に付ける）。
      const asked = new Set(this.s.hearingAsked.map((i) => this.cfg.hearing[i]));
      this.s.hearingAsked = next.hearing.flatMap((text, i) =>
        asked.has(text) ? [i] : [],
      );
    }
    this.savedCfg = next;
    this.cfg = this.s.active
      ? {
          ...next,
          ...Object.fromEntries(
            ["apiKey", "voice", "style", "sttModel", "voiceModel"].map((k) => [
              k,
              this.cfg[k],
            ]),
          ),
        }
      : next;
    if (speakerModeChanged) {
      this.speakerEpoch++;
      this.speakerTimeline.clear();
      if (!next.showSpeakerNames || next.useLocalMic)
        for (const line of this.s.lines) delete line.speaker;
      this.invalidateSuggestion("speaker-names-disabled");
    }
    if (repairKey) {
      this.cfg.apiKey = next.apiKey;
      this.s.keyError = false;
      this.makeTranscriber();
      this.makeSpeakers();
    }
    if (changed) {
      this.voiceGeneration = (this.voiceGeneration || 0) + 1;
      this.cache.clearCandidates();
      if (!this.s.active) {
        this.warmToken = null;
        if (voiceChanged) await this.cache.clearVoices();
        this.makeSpeakers();
        this.prewarm();
      } else if (!repairKey)
        this.emit({
          type: "notice",
          text: "声・API キーの変更は次の開始から反映します",
        });
    }
    // 書き換えた項目だけ作り直す（声は文ごとに保存しているので、同じ文は作り直さない）。
    // 会話していないときは、作り置きの途中（初回設定の3歩目など）だけ。ほかは次の開始時に作る。
    const warming = this.s.active || warmingBefore;
    if (warmChanged && warming && !(changed && !this.s.active) && this.cfg.apiKey)
      this.prewarm().catch(() => {});
    if (next.keepLogDays === 0) await this.cache.clearLogs();
    this.sendPage({ type: "sendMic", value: next.sendMic });
    if (this.vad) this.vad.sensitivity = next.sensitivity;
    this.publish();
  }
  async command(m) {
    switch (m.command) {
      case "say":
        return this.say(m.text, m.kind);
      case "sheetSay":
        return this.say(
          (m.tab === "phrases" ? this.cfg.phrases : this.cfg.hearing)[m.index],
          m.tab === "phrases" ? "phrases" : "hearing",
        );
      case "pickCandidate":
        return this.say(this.s.candidates[m.index]?.text, "candidate");
      case "quick":
        return this.say(this.cfg.quick[m.index]?.text, "quick");
      case "intro":
        return this.say(this.cfg.intro, "intro");
      case "stopSpeaking":
        this.stopSpeaking();
        return true;
      case "stop":
        await this.stop();
        return true;
      case "regenerate":
        await this.suggest();
        return true;
      case "setTyping":
        this.s.typingAt = now();
        return true;
      case "hearing": {
        const i = Number(m.index);
        if (i >= 0 && i < this.cfg.hearing.length) {
          this.s.hearingAsked = m.value
            ? [...new Set([...this.s.hearingAsked, i])]
            : this.s.hearingAsked.filter((x) => x !== i);
          this.publish();
        }
        return true;
      }
      case "verifyKey":
        return verifyKey(m.apiKey);
      case "draftHearing": {
        const cfg = this.savedCfg;
        if (!cfg.apiKey) throw new Error("API キーを設定してください");
        if (
          !String(m.job || "").trim() &&
          !String(m.topic || "").trim() &&
          !(Array.isArray(m.sheetItems) && m.sheetItems.length)
        )
          throw new Error("仕事か、今日話したいことを入力してください");
        this.s.usage.requests++;
        // 今日話したいこと（貼り付けたメモ）と添付したシートの項目は、生成に使うだけで保存しない。
        return draftHearingQuestions(
          cfg,
          { job: m.job, about: m.about, topic: m.topic, sheetItems: m.sheetItems },
          undefined,
          (u) => this.usage(u),
        );
      }
      case "prewarm":
        this.prewarm().catch(() => {});
        return true;
      case "preview": {
        const voice = m.voice || this.cfg.voice;
        const cfg = { ...this.savedCfg, voice };
        this.previewSpeaker?.close();
        this.local.stop();
        const speaker = (this.previewSpeaker = new Speaker(cfg));
        speaker.connect();
        try {
          const result = await speaker.speak(SAMPLE);
          if (result.status !== "completed")
            throw new Error("声を試せませんでした");
          if (m.download) return Array.from(wavBytes(result.chunks));
          await this.local.play(result.chunks);
          return true;
        } finally {
          speaker.close();
        }
      }
      case "previewStop":
        this.previewSpeaker?.close();
        this.local.stop();
        return true;
      case "reconnect":
        this.s.keyError = false;
        this.stt?.reconnect();
        this.main?.reconnect();
        this.pre?.reconnect();
        return true;
      case "summary":
        return this.summarize();
      case "listLogs":
        return this.cache.listLogs();
      case "clearLogs":
        return this.cache.clearLogs();
      case "forget":
        if (!this.s.active) {
          this.summaryAbort?.abort();
          this.warmToken = null;
          this.main?.close();
          this.pre?.close();
          this.previewSpeaker?.close();
          this.local.stop();
          this.cache.clearCandidates();
          this.s = blankState();
          this.cfg = this.savedCfg;
          this.publish();
        }
        return true;
      default:
        throw new Error("この操作は利用できません");
    }
  }
}
