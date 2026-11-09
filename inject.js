// MAIN world: no keys, settings storage, network calls or conversation text.
(() => {
  if (window.__koeBridgeInstalled) return;
  Object.defineProperty(window, "__koeBridgeInstalled", { value: true });
  const nativeGUM = MediaDevices.prototype.getUserMedia,
    outputs = new Map(),
    groups = new Set(),
    jobs = new Map(),
    dead = new Set(),
    senders = new Map();
  const hasSenderAPI = typeof RTCPeerConnection !== "undefined";
  // Sticky for this document: a WebAudio/WASM app may never use a sender.
  let attachedEver = false;
  function pageState() {
    const live = [...outputs.keys()].filter(
      (t) => t.enabled && t.readyState === "live",
    );
    const attached = new Set();
    // Read each peer's transceivers once, including negotiated direction.
    for (const pc of new Set(senders.values())) {
      if (pc.signalingState === "closed") continue;
      for (const t of pc.getTransceivers())
        if (
          !t.stopped &&
          ["sendrecv", "sendonly"].includes(t.direction) &&
          (!t.currentDirection ||
            ["sendrecv", "sendonly"].includes(t.currentDirection)) &&
          live.includes(t.sender.track)
        )
          attached.add(t.sender.track);
    }
    if (attached.size) attachedEver = true;
    return {
      streams: outputs.size,
      unmuted: live.length,
      attached: attached.size,
      attachedEver,
      context: ctx?.state || "suspended",
    };
  }
  const sendable = (s) => s.unmuted > 0 && (!s.attachedEver || s.attached > 0);
  let ctx,
    bus,
    analyser,
    secret = null,
    sendMic = false,
    activeId = null,
    level = 0;
  const emit = (type, data = {}) => {
    if (secret)
      window.postMessage(
        { __koe: "page", secret, type, ...data },
        location.origin,
      );
  };
  const status = () => {
    const state = pageState();
    emit("status", state);
    return state;
  };
  function senderChanged() {
    if (!sendable(status())) stopAll();
  }
  if (hasSenderAPI) {
    const pc = RTCPeerConnection.prototype;
    for (const name of ["addTrack", "addTransceiver"]) {
      const native = pc[name];
      pc[name] = function (...args) {
        const result = native.apply(this, args);
        senders.set(name === "addTrack" ? result : result.sender, this);
        senderChanged();
        return result;
      };
    }
    for (const name of ["removeTrack", "close"]) {
      const native = pc[name];
      pc[name] = function (...args) {
        const result = native.apply(this, args);
        if (name === "close")
          for (const [s, owner] of senders)
            if (owner === this) senders.delete(s);
        senderChanged();
        return result;
      };
    }
    const replace = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = async function (track) {
      const result = await replace.call(this, track);
      senderChanged();
      return result;
    };
  }
  function ensure() {
    if (ctx) return;
    ctx = new AudioContext({ sampleRate: 48000 });
    bus = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    bus.connect(analyser);
    ctx.onstatechange = status;
  }
  const enabled = Object.getOwnPropertyDescriptor(
    MediaStreamTrack.prototype,
    "enabled",
  );
  function wrap(track, group) {
    outputs.set(track, group);
    group.tracks.add(track);
    const stop = track.stop.bind(track),
      clone = track.clone.bind(track);
    Object.defineProperty(track, "label", {
      configurable: true,
      get: () => group.real.label,
    });
    for (const method of [
      "getSettings",
      "getCapabilities",
      "getConstraints",
      "applyConstraints",
    ])
      if (group.real[method])
        Object.defineProperty(track, method, {
          configurable: true,
          value: group.real[method].bind(group.real),
        });
    if (enabled?.set)
      Object.defineProperty(track, "enabled", {
        configurable: true,
        get: () => enabled.get.call(track),
        set: (value) => {
          enabled.set.call(track, value);
          senderChanged();
        },
      });
    const release = () => {
      if (!outputs.has(track)) return;
      outputs.delete(track);
      group.tracks.delete(track);
      if (!group.tracks.size) {
        group.real.stop();
        group.source.disconnect();
        group.gain.disconnect();
        // Keep destination fed by the TTS bus. A native/unknown clone may still
        // be sending it; disconnecting its last input can stop audio frames.
        // The physical mic and its gain are still fully released above.
        groups.delete(group);
      }
      senderChanged();
    };
    Object.defineProperty(track, "stop", {
      configurable: true,
      value: () => {
        if (!outputs.has(track)) return;
        stop();
        release();
      },
    });
    Object.defineProperty(track, "clone", {
      configurable: true,
      value: () => {
        const child = clone();
        if (track.readyState === "live") wrap(child, group);
        return child;
      },
    });
    track.addEventListener("ended", release, { once: true });
    status();
    return track;
  }
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    const stream = await nativeGUM.call(this, constraints);
    if (!constraints?.audio) return stream;
    ensure();
    const tracks = stream.getAudioTracks();
    for (const real of tracks) {
      const source = ctx.createMediaStreamSource(new MediaStream([real])),
        gain = ctx.createGain(),
        destination = ctx.createMediaStreamDestination();
      gain.gain.value = sendMic ? 1 : 0;
      source.connect(gain).connect(destination);
      bus.connect(destination);
      const group = { real, source, gain, destination, tracks: new Set() };
      groups.add(group);
      const replacement = wrap(destination.stream.getAudioTracks()[0], group);
      real.addEventListener(
        "ended",
        () => {
          for (const t of [...group.tracks]) t.stop();
        },
        { once: true },
      );
      stream.removeTrack(real);
      stream.addTrack(replacement);
    }
    status();
    return stream;
  };
  // Meet clones whole streams before cloning/replacing the sender's track.
  // Native stream.clone() bypasses the per-track clone wrappers, so explicitly
  // clone tracks here only when this stream contains one of our outputs.
  const streamClone = MediaStream.prototype.clone;
  MediaStream.prototype.clone = function () {
    const tracks = this.getTracks();
    if (!tracks.some((track) => outputs.has(track)))
      return streamClone.call(this);
    return new MediaStream(tracks.map((track) => track.clone()));
  };
  function remember(id) {
    dead.add(id);
    if (dead.size > 256) dead.delete(dead.values().next().value);
  }
  function playedSeconds(job) {
    // Network gaps are not audio. Count only the portion of scheduled buffers
    // actually played, so interrupted transcript verification cannot include them.
    let seconds = job.playedSeconds;
    for (const { when, duration } of job.scheduled.values())
      seconds += Math.max(0, Math.min(ctx.currentTime - when, duration));
    return seconds;
  }
  function end(job, stopped = false) {
    if (!jobs.has(job.id)) return;
    clearTimeout(job.startTimer);
    jobs.delete(job.id);
    remember(job.id);
    if (activeId === job.id) activeId = null;
    emit("play-end", {
      id: job.id,
      elapsed: playedSeconds(job),
      stopped,
      underrunMs:
        job.underrunMs +
        (stopped && job.rebuffering
          ? Math.max(0, ctx.currentTime - job.next) * 1000
          : 0),
    });
  }
  function stopAll() {
    for (const job of [...jobs.values()]) {
      for (const s of job.sources) {
        s.onended = null;
        try {
          s.stop();
          s.disconnect();
        } catch {}
      }
      end(job, true);
    }
  }
  function schedule(job) {
    if (!job.pending.length) return;
    if (job.rebuffering && !job.ended && job.pendingSamples < 9600) return;
    if (!sendable(pageState()) || ctx.state !== "running") {
      end(job, true);
      return;
    }
    if (!job.started) {
      // Session has already accumulated the adaptive initial buffer.
      job.started = true;
      job.start = ctx.currentTime + 0.015;
      job.next = job.start;
      activeId = job.id;
      job.startTimer = setTimeout(() => {
        if (jobs.has(job.id)) emit("play-start", { id: job.id });
      }, 15);
    } else if (job.rebuffering) {
      job.underrunMs += Math.max(0, ctx.currentTime + 0.005 - job.next) * 1000;
      job.next = ctx.currentTime + 0.005;
      job.rebuffering = false;
      emit("play-progress", {
        id: job.id,
        elapsed: playedSeconds(job),
        level: 0,
        preparing: false,
      });
    }
    for (const pcm of job.pending) append(job, pcm);
    job.pending = [];
    job.pendingSamples = 0;
    if (job.ended && !job.sources.size) end(job);
  }
  function append(job, pcm) {
    const b = ctx.createBuffer(1, pcm.length, 24000),
      data = b.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(bus);
    const when = Math.max(ctx.currentTime + 0.005, job.next);
    job.next = when + b.duration;
    job.duration += b.duration;
    job.sources.add(s);
    job.scheduled.set(s, { when, duration: b.duration });
    s.onended = () => {
      s.disconnect();
      job.sources.delete(s);
      job.scheduled.delete(s);
      job.playedSeconds += b.duration;
      if (job.ended && !job.sources.size && !job.pending.length) end(job);
      else if (!job.sources.size) beginBuffering(job);
    };
    s.start(when);
  }
  function beginBuffering(job) {
    if (
      !job.started ||
      job.ended ||
      job.rebuffering ||
      ctx.currentTime < job.next
    )
      return;
    job.rebuffering = true;
    emit("play-progress", {
      id: job.id,
      elapsed: playedSeconds(job),
      level: 0,
      preparing: true,
    });
  }
  function valid(m) {
    // MAIN scripts cannot import modules. Keep these checks aligned with
    // protocol.validPageCommand; decoded byte parity is checked below too.
    if (m.type === "pcm")
      return (
        typeof m.id === "string" &&
        m.id.length < 100 &&
        typeof m.audio === "string" &&
        m.audio.length <= 262144 &&
        m.audio.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(m.audio)
      );
    return (
      (m.type === "end" && typeof m.id === "string" && m.id.length < 100) ||
      ["stop", "ping"].includes(m.type) ||
      (m.type === "sendMic" && typeof m.value === "boolean")
    );
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (
      e.source !== window ||
      e.origin !== location.origin ||
      m?.__koe !== "extension"
    )
      return;
    if (
      m.type === "hello" &&
      !secret &&
      typeof m.secret === "string" &&
      m.secret.length === 36
    ) {
      secret = m.secret;
      emit("ready");
      status();
      return;
    }
    if (!secret || m.secret !== secret || !valid(m)) return;
    if (m.type === "ping") {
      emit("ready");
      status();
      return;
    }
    if (m.type === "stop") {
      stopAll();
      return;
    }
    if (m.type === "sendMic") {
      sendMic = m.value === true;
      for (const g of groups) g.gain.gain.value = sendMic ? 1 : 0;
      return;
    }
    if (dead.has(m.id)) return;
    if (m.type === "end") {
      const job = jobs.get(m.id);
      if (job) {
        job.ended = true;
        schedule(job);
        if (job.started && !job.sources.size) end(job);
      }
      return;
    }
    if (m.type === "pcm") {
      ensure();
      let pcm;
      try {
        const bytes = Uint8Array.from(atob(m.audio), (c) => c.charCodeAt(0));
        if (bytes.length % 2) return;
        pcm = new Int16Array(bytes.buffer);
      } catch {
        return;
      }
      if (!pcm.length) return;
      let job = jobs.get(m.id);
      if (!job) {
        if (jobs.size) stopAll();
        job = {
          id: m.id,
          pending: [],
          pendingSamples: 0,
          rebuffering: false,
          underrunMs: 0,
          sources: new Set(),
          scheduled: new Map(),
          playedSeconds: 0,
          samples: 0,
          duration: 0,
          start: null,
          started: false,
          ended: false,
        };
        jobs.set(m.id, job);
      }
      job.samples += pcm.length;
      if (job.samples > 24000 * 180) {
        stopAll();
        return;
      }
      beginBuffering(job);
      if (job.started && !job.rebuffering) append(job, pcm);
      else {
        job.pending.push(pcm);
        job.pendingSamples += pcm.length;
        schedule(job);
      }
    }
  });
  for (const event of ["pointerdown", "keydown"])
    window.addEventListener(
      event,
      () => {
        if (ctx?.state === "suspended")
          ctx
            .resume()
            .then(status)
            .catch(() => {});
      },
      { capture: true },
    );
  setInterval(() => {
    senderChanged();
    if (!activeId || !ctx) return;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    level = Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length);
    const job = jobs.get(activeId);
    if (job?.started) {
      beginBuffering(job);
      emit("play-progress", {
        id: job.id,
        elapsed: playedSeconds(job),
        level: Math.min(1, level * 5),
        preparing: job.rebuffering,
      });
    }
  }, 100);
})();
